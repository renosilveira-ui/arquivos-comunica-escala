import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  users,
  whatsappInboundMessages,
  whatsappPendingIntents,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { logger } from "../server/_core/logger";
import {
  cancelWhatsAppPendingIntent,
  clearExpiredWhatsAppPendingIntents,
  createWhatsAppPendingIntent,
  expireWhatsAppPendingIntent,
  getOpenWhatsAppPendingIntentForUser,
  getWhatsAppPendingIntentByIdForUser,
  getWhatsAppPendingIntentBySourceForUser,
} from "../server/integrations/whatsapp/pending-intent-store";
import { WHATSAPP_PENDING_INTENT_TTL_MS } from "../server/integrations/whatsapp/pending-intent-types";
import type { WhatsAppPendingIntentRecord } from "../server/integrations/whatsapp/pending-intent-types";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

function expectFoundationBirth(
  row: WhatsAppPendingIntentRecord,
  userId: number,
  sourceId: number,
) {
  expect(row.userId).toBe(userId);
  expect(row.sourceInboundMessageId).toBe(sourceId);
  expect(row.status).toBe("OPEN");
  expect(row.stage).toBe("PARSE");
  expect(row.intentKind).toBeNull();
  expect(row.parsedPayload).toBeNull();
  expect(row.resolvedPayload).toBeNull();
  expect(row.clarificationPayload).toBeNull();
  expect(row.institutionId).toBeNull();
}

describe("WhatsApp pending intent store", () => {
  let db: Db;
  let userA: number;
  let userB: number;
  const stamp = Date.now();
  const inboundIds: number[] = [];
  const userIds: number[] = [];

  async function insertUser(label: string): Promise<number> {
    const name = `wa-pend-${label}-${stamp}`;
    const [user] = await db
      .insert(users)
      .values({
        name,
        email: `${name}@example.test`,
        passwordHash: "not-used",
        role: "doctor",
        approvalStatus: "APPROVED",
        sessionVersion: 1,
      })
      .$returningId();
    userIds.push(user.id);
    return user.id;
  }

  async function insertInbound(
    ownerId: number | null,
    suffix: string,
    status = "READY_FOR_NL",
  ): Promise<number> {
    const [row] = await db
      .insert(whatsappInboundMessages)
      .values({
        provider: "TWILIO",
        providerMessageId: `SMpend${stamp}${suffix}`,
        userId: ownerId,
        contentKind: "TEXT",
        forwarded: false,
        processingStatus: status,
        operationalText: "slots semânticos futuros",
        receivedAt: new Date(),
        processedAt: new Date(),
      })
      .$returningId();
    inboundIds.push(row.id);
    return row.id;
  }

  beforeAll(async () => {
    const maybe = await getDb();
    if (!maybe) throw new Error("DB unavailable");
    db = maybe;
    userA = await insertUser("a");
    userB = await insertUser("b");
  });

  afterEach(async () => {
    if (userIds.length === 0) return;
    await db
      .delete(whatsappPendingIntents)
      .where(inArray(whatsappPendingIntents.userId, userIds));
  });

  afterAll(async () => {
    if (userIds.length > 0) {
      await db
        .delete(whatsappPendingIntents)
        .where(inArray(whatsappPendingIntents.userId, userIds));
    }
    if (inboundIds.length > 0) {
      await db
        .delete(whatsappInboundMessages)
        .where(inArray(whatsappInboundMessages.id, inboundIds));
    }
    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
  });

  it("create recebe só sourceInboundMessageId e deriva userId do inbound", async () => {
    const sourceId = await insertInbound(userA, "create");
    const now = new Date("2026-09-04T15:00:00.000Z");
    const result = await createWhatsAppPendingIntent(
      { sourceInboundMessageId: sourceId },
      now,
    );
    expect(result).toMatchObject({ ok: true, outcome: "created" });
    if (!result.ok) throw new Error(result.code);
    expectFoundationBirth(result.row, userA, sourceId);
    expect(result.row.expiresAt.getTime() - now.getTime()).toBe(
      WHATSAPP_PENDING_INTENT_TTL_MS,
    );

    const [raw] = await db
      .select()
      .from(whatsappPendingIntents)
      .where(eq(whatsappPendingIntents.id, result.row.id));
    expect(raw?.openSlot).toBe(1);
    expect(raw?.userId).toBe(userA);
    const serialized = JSON.stringify(raw);
    expect(serialized).not.toContain("+55");
    expect(serialized).not.toMatch(/X-Twilio-Signature|TWILIO_AUTH_TOKEN/i);
    expect(serialized).not.toContain("MessageSid");
  });

  it("caller não substitui userId, intentKind, parsedPayload nem institutionId", async () => {
    const sourceId = await insertInbound(userA, "spoof");
    const result = await createWhatsAppPendingIntent({
      sourceInboundMessageId: sourceId,
      userId: userB,
      institutionId: 99_999,
      intentKind: "SWAP",
      parsedPayload: { shiftId: 1, phone: "+5585999100001" },
    } as never);
    expect(result).toMatchObject({ ok: true, outcome: "created" });
    if (!result.ok) throw new Error(result.code);
    expectFoundationBirth(result.row, userA, sourceId);
    expect(result.row.userId).not.toBe(userB);
  });

  it("mesmo source duas vezes não duplica; replay preserva a row", async () => {
    const sourceId = await insertInbound(userA, "srcuniq");
    const first = await createWhatsAppPendingIntent({
      sourceInboundMessageId: sourceId,
    });
    const second = await createWhatsAppPendingIntent({
      sourceInboundMessageId: sourceId,
    });
    expect(first).toMatchObject({ ok: true, outcome: "created" });
    expect(second).toMatchObject({ ok: true, outcome: "replay" });
    if (!first.ok || !second.ok) throw new Error("create failed");
    expectFoundationBirth(first.row, userA, sourceId);
    expect(second.row.id).toBe(first.row.id);
    const rows = await db
      .select()
      .from(whatsappPendingIntents)
      .where(eq(whatsappPendingIntents.sourceInboundMessageId, sourceId));
    expect(rows).toHaveLength(1);
  });

  it("um OPEN por user; segundo source distinto não abre outra conversa", async () => {
    const firstSource = await insertInbound(userA, "open1");
    const secondSource = await insertInbound(userA, "open2");
    await createWhatsAppPendingIntent({
      sourceInboundMessageId: firstSource,
    });
    const blocked = await createWhatsAppPendingIntent({
      sourceInboundMessageId: secondSource,
    });
    expect(blocked).toMatchObject({ ok: true, outcome: "already_open" });
    if (!blocked.ok) throw new Error(blocked.code);
    expect(blocked.row.sourceInboundMessageId).toBe(firstSource);
    const openRows = await db
      .select()
      .from(whatsappPendingIntents)
      .where(eq(whatsappPendingIntents.userId, userA));
    expect(
      openRows.filter((row) => row.status === "OPEN"),
    ).toHaveLength(1);
  });

  it("dois users mantêm OPEN independentes", async () => {
    const sourceA = await insertInbound(userA, "indepa");
    const sourceB = await insertInbound(userB, "indepb");
    const a = await createWhatsAppPendingIntent({
      sourceInboundMessageId: sourceA,
    });
    const b = await createWhatsAppPendingIntent({
      sourceInboundMessageId: sourceB,
    });
    expect(a).toMatchObject({ ok: true, outcome: "created" });
    expect(b).toMatchObject({ ok: true, outcome: "created" });
    if (!a.ok || !b.ok) throw new Error("independent create failed");
    expect(a.row.id).not.toBe(b.row.id);
    expect(a.row.userId).toBe(userA);
    expect(b.row.userId).toBe(userB);
    expect(await getOpenWhatsAppPendingIntentForUser(userA)).toMatchObject({
      id: a.row.id,
    });
    expect(await getOpenWhatsAppPendingIntentForUser(userB)).toMatchObject({
      id: b.row.id,
    });
  });

  it("user A nunca carrega, cancela ou expira pending de B", async () => {
    const sourceB = await insertInbound(userB, "iso");
    const created = await createWhatsAppPendingIntent({
      sourceInboundMessageId: sourceB,
    });
    if (!created.ok) throw new Error(created.code);
    expect(
      await getWhatsAppPendingIntentByIdForUser(created.row.id, userA),
    ).toBeNull();
    expect(
      await getWhatsAppPendingIntentBySourceForUser(sourceB, userA),
    ).toBeNull();
    expect(await getOpenWhatsAppPendingIntentForUser(userA)).toBeNull();
    expect(
      await cancelWhatsAppPendingIntent(created.row.id, userA),
    ).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(
      await expireWhatsAppPendingIntent(created.row.id, userA, new Date(0)),
    ).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(
      await getOpenWhatsAppPendingIntentForUser(userB),
    ).toMatchObject({ id: created.row.id, status: "OPEN" });
  });

  it("cancela OPEN, é idempotente e terminal não volta a OPEN", async () => {
    const sourceId = await insertInbound(userA, "cancel");
    const created = await createWhatsAppPendingIntent({
      sourceInboundMessageId: sourceId,
    });
    if (!created.ok) throw new Error(created.code);
    const first = await cancelWhatsAppPendingIntent(created.row.id, userA);
    const second = await cancelWhatsAppPendingIntent(created.row.id, userA);
    expect(first).toMatchObject({ ok: true, outcome: "updated" });
    expect(second).toMatchObject({ ok: true, outcome: "already_terminal" });
    if (!first.ok || !second.ok) throw new Error("cancel failed");
    expect(first.row.status).toBe("CANCELLED");
    expect(second.row.status).toBe("CANCELLED");
    expect(first.row.parsedPayload).toBeNull();
    expect(first.row.payloadClearedAt).toBeTruthy();

    const replay = await createWhatsAppPendingIntent({
      sourceInboundMessageId: sourceId,
    });
    expect(replay).toMatchObject({ ok: true, outcome: "already_terminal" });
    if (!replay.ok) throw new Error(replay.code);
    expect(replay.row.status).toBe("CANCELLED");
    expect(replay.row.id).toBe(created.row.id);
  });

  it("não expira antes do TTL; expira depois e limpa payload", async () => {
    const sourceId = await insertInbound(userA, "ttl");
    const now = new Date("2026-09-04T18:00:00.000Z");
    const created = await createWhatsAppPendingIntent(
      { sourceInboundMessageId: sourceId },
      now,
    );
    if (!created.ok) throw new Error(created.code);
    const early = await expireWhatsAppPendingIntent(
      created.row.id,
      userA,
      now,
    );
    expect(early).toMatchObject({ ok: true, outcome: "not_due" });
    if (!early.ok) throw new Error(early.code);
    expect(early.row.status).toBe("OPEN");

    const dueAt = new Date(now.getTime() + WHATSAPP_PENDING_INTENT_TTL_MS);
    const expired = await expireWhatsAppPendingIntent(
      created.row.id,
      userA,
      dueAt,
    );
    expect(expired).toMatchObject({ ok: true, outcome: "updated" });
    if (!expired.ok) throw new Error(expired.code);
    expect(expired.row.status).toBe("EXPIRED");
    expect(expired.row.parsedPayload).toBeNull();
    expect(await getOpenWhatsAppPendingIntentForUser(userA, dueAt)).toBeNull();
  });

  it("OPEN expirado não bloqueia novo source do mesmo user", async () => {
    const oldSource = await insertInbound(userA, "stale");
    const newSource = await insertInbound(userA, "fresh");
    const createdAt = new Date("2026-09-04T08:00:00.000Z");
    const stale = await createWhatsAppPendingIntent(
      { sourceInboundMessageId: oldSource },
      createdAt,
    );
    const later = new Date(createdAt.getTime() + WHATSAPP_PENDING_INTENT_TTL_MS);
    const fresh = await createWhatsAppPendingIntent(
      { sourceInboundMessageId: newSource },
      later,
    );
    expect(stale).toMatchObject({ ok: true, outcome: "created" });
    expect(fresh).toMatchObject({ ok: true, outcome: "created" });
    if (!stale.ok || !fresh.ok) throw new Error("stale/fresh create failed");
    expect(fresh.row.id).not.toBe(stale.row.id);
    expect(fresh.row.status).toBe("OPEN");
    expect(
      await getWhatsAppPendingIntentByIdForUser(stale.row.id, userA, later),
    ).toMatchObject({ status: "EXPIRED" });
  });

  it("sweep limpa OPEN expirado sem cron", async () => {
    const sourceId = await insertInbound(userA, "sweep");
    const createdAt = new Date("2026-09-04T10:00:00.000Z");
    const created = await createWhatsAppPendingIntent(
      { sourceInboundMessageId: sourceId },
      createdAt,
    );
    if (!created.ok) throw new Error(created.code);
    const swept = await clearExpiredWhatsAppPendingIntents(
      new Date(createdAt.getTime() + WHATSAPP_PENDING_INTENT_TTL_MS),
    );
    expect(swept.expired).toBeGreaterThanOrEqual(1);
    const [row] = await db
      .select()
      .from(whatsappPendingIntents)
      .where(eq(whatsappPendingIntents.id, created.row.id));
    expect(row?.status).toBe("EXPIRED");
    expect(row?.payloadClearedAt).toBeTruthy();
  });

  it("corrida de dois creates no mesmo source gera uma row", async () => {
    const sourceId = await insertInbound(userA, "race");
    const results = await Promise.all([
      createWhatsAppPendingIntent({ sourceInboundMessageId: sourceId }),
      createWhatsAppPendingIntent({ sourceInboundMessageId: sourceId }),
    ]);
    expect(results.every((item) => item.ok)).toBe(true);
    const okResults = results.filter(
      (item): item is Extract<typeof item, { ok: true }> => item.ok,
    );
    const outcomes = okResults.map((item) => item.outcome);
    expect(outcomes.some((item) => item === "created")).toBe(true);
    expect(
      outcomes.every((item) => item === "created" || item === "replay"),
    ).toBe(true);
    expect(new Set(okResults.map((item) => item.row.id)).size).toBe(1);
    expect(
      okResults.every((item) => item.row.sourceInboundMessageId === sourceId),
    ).toBe(true);
    expect(okResults.every((item) => item.row.userId === userA)).toBe(true);
    const rows = await db
      .select()
      .from(whatsappPendingIntents)
      .where(eq(whatsappPendingIntents.sourceInboundMessageId, sourceId));
    expect(rows).toHaveLength(1);
  });

  it("corrida de dois sources do mesmo user gera um OPEN", async () => {
    const firstSource = await insertInbound(userA, "raceu1");
    const secondSource = await insertInbound(userA, "raceu2");
    const results = await Promise.all([
      createWhatsAppPendingIntent({ sourceInboundMessageId: firstSource }),
      createWhatsAppPendingIntent({ sourceInboundMessageId: secondSource }),
    ]);
    expect(results.every((item) => item.ok)).toBe(true);
    const openRows = await db
      .select()
      .from(whatsappPendingIntents)
      .where(eq(whatsappPendingIntents.userId, userA));
    expect(openRows.filter((row) => row.status === "OPEN")).toHaveLength(1);
  });

  it("exige inbound READY_FOR_NL com userId canônico", async () => {
    const missing = await createWhatsAppPendingIntent({
      sourceInboundMessageId: 2_147_000_000,
    });
    expect(missing).toEqual({ ok: false, code: "SOURCE_INBOUND_NOT_FOUND" });

    const receivedId = await insertInbound(userA, "recv", "RECEIVED");
    const notReady = await createWhatsAppPendingIntent({
      sourceInboundMessageId: receivedId,
    });
    expect(notReady).toEqual({ ok: false, code: "SOURCE_INBOUND_NOT_READY" });

    const anonymousId = await insertInbound(null, "noid");
    const noIdentity = await createWhatsAppPendingIntent({
      sourceInboundMessageId: anonymousId,
    });
    expect(noIdentity).toEqual({
      ok: false,
      code: "SOURCE_INBOUND_IDENTITY_MISSING",
    });
  });

  it("DELETE inbound é RESTRICT enquanto o pending existir", async () => {
    const sourceId = await insertInbound(userA, "restrict");
    const created = await createWhatsAppPendingIntent({
      sourceInboundMessageId: sourceId,
    });
    if (!created.ok) throw new Error(created.code);
    await expect(
      db
        .delete(whatsappInboundMessages)
        .where(eq(whatsappInboundMessages.id, sourceId)),
    ).rejects.toThrow();
    const [still] = await db
      .select({ id: whatsappInboundMessages.id })
      .from(whatsappInboundMessages)
      .where(eq(whatsappInboundMessages.id, sourceId));
    expect(still?.id).toBe(sourceId);
  });

  it("logs técnicos não levam telefone, Body nem signature", async () => {
    const sourceId = await insertInbound(userA, "logs");
    const lines: string[] = [];
    const spy = vi
      .spyOn(logger, "info")
      .mockImplementation((...args: unknown[]) => {
        lines.push(args.map((item) => String(item)).join(" "));
        return logger;
      });
    await createWhatsAppPendingIntent({ sourceInboundMessageId: sourceId });
    spy.mockRestore();
    const joined = lines.join("\n");
    expect(joined).toContain("whatsapp_pending_created");
    expect(joined).not.toContain("+55");
    expect(joined).not.toContain("slots semânticos futuros");
    expect(joined).not.toMatch(/X-Twilio-Signature|TWILIO_AUTH_TOKEN|Body/i);
  });
});
