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
  cancelWhatsAppPendingOpenParse,
  clearExpiredWhatsAppPendingIntents,
  createWhatsAppPendingIntent,
  expireWhatsAppPendingIntent,
  getOpenWhatsAppPendingIntentForUser,
  getWhatsAppPendingIntentByIdForUser,
  getWhatsAppPendingIntentBySourceForUser,
} from "../server/integrations/whatsapp/pending-intent-store";
import {
  WHATSAPP_PENDING_INTENT_TTL_MS,
  isWhatsAppPendingReadFailure,
  type WhatsAppPendingIntentRecord,
  type WhatsAppPendingReadResult,
} from "../server/integrations/whatsapp/pending-intent-types";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

function expectHealthyAbsent(result: WhatsAppPendingReadResult) {
  expect(isWhatsAppPendingReadFailure(result)).toBe(false);
  expect(result).toEqual({ ok: true, row: null });
}

async function expectHealthyOpenReads(
  userId: number,
  sourceId: number,
  pendingId: number,
) {
  const byId = await getWhatsAppPendingIntentByIdForUser(pendingId, userId);
  const bySource = await getWhatsAppPendingIntentBySourceForUser(
    sourceId,
    userId,
  );
  const open = await getOpenWhatsAppPendingIntentForUser(userId);
  for (const result of [byId, bySource, open]) {
    expect(isWhatsAppPendingReadFailure(result)).toBe(false);
    expect(result).toMatchObject({
      ok: true,
      row: {
        id: pendingId,
        userId,
        sourceInboundMessageId: sourceId,
        status: "OPEN",
      },
    });
  }
}

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

  it("DB saudável sem pending: os três reads devolvem ok + row null", async () => {
    expectHealthyAbsent(
      await getWhatsAppPendingIntentByIdForUser(2_147_000_001, userA),
    );
    expectHealthyAbsent(
      await getWhatsAppPendingIntentBySourceForUser(2_147_000_002, userA),
    );
    expectHealthyAbsent(await getOpenWhatsAppPendingIntentForUser(userA));
  });

  it("DB saudável com OPEN: os três reads devolvem o mesmo row", async () => {
    const sourceId = await insertInbound(userA, "reads");
    const created = await createWhatsAppPendingIntent({
      sourceInboundMessageId: sourceId,
    });
    if (!created.ok) throw new Error(created.code);
    await expectHealthyOpenReads(userA, sourceId, created.row.id);
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
      ok: true,
      row: { id: a.row.id },
    });
    expect(await getOpenWhatsAppPendingIntentForUser(userB)).toMatchObject({
      ok: true,
      row: { id: b.row.id },
    });
  });

  it("user A nunca carrega, cancela ou expira pending de B", async () => {
    const sourceB = await insertInbound(userB, "iso");
    const created = await createWhatsAppPendingIntent({
      sourceInboundMessageId: sourceB,
    });
    if (!created.ok) throw new Error(created.code);
    expectHealthyAbsent(
      await getWhatsAppPendingIntentByIdForUser(created.row.id, userA),
    );
    expectHealthyAbsent(
      await getWhatsAppPendingIntentBySourceForUser(sourceB, userA),
    );
    expectHealthyAbsent(await getOpenWhatsAppPendingIntentForUser(userA));
    expect(
      await cancelWhatsAppPendingIntent(created.row.id, userA),
    ).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(
      await expireWhatsAppPendingIntent(created.row.id, userA, new Date(0)),
    ).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(
      await getOpenWhatsAppPendingIntentForUser(userB),
    ).toMatchObject({ ok: true, row: { id: created.row.id, status: "OPEN" } });
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
    expectHealthyAbsent(
      await getOpenWhatsAppPendingIntentForUser(userA, dueAt),
    );
  });

  it("getOpen expira lazy e getById/getBySource devolvem EXPIRED", async () => {
    const sourceId = await insertInbound(userA, "lazy");
    const createdAt = new Date("2026-09-04T07:00:00.000Z");
    const created = await createWhatsAppPendingIntent(
      { sourceInboundMessageId: sourceId },
      createdAt,
    );
    if (!created.ok) throw new Error(created.code);
    const dueAt = new Date(createdAt.getTime() + WHATSAPP_PENDING_INTENT_TTL_MS);
    expectHealthyAbsent(
      await getOpenWhatsAppPendingIntentForUser(userA, dueAt),
    );
    expect(
      await getWhatsAppPendingIntentByIdForUser(created.row.id, userA, dueAt),
    ).toMatchObject({
      ok: true,
      row: { id: created.row.id, status: "EXPIRED" },
    });
    expect(
      await getWhatsAppPendingIntentBySourceForUser(sourceId, userA, dueAt),
    ).toMatchObject({ ok: true, row: { status: "EXPIRED" } });
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
    ).toMatchObject({ ok: true, row: { status: "EXPIRED" } });
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
    expect(swept).toMatchObject({ ok: true });
    if (!swept.ok) throw new Error(swept.code);
    expect(swept.expired).toBeGreaterThanOrEqual(1);
    expect(swept.payloadsCleared).toBeGreaterThanOrEqual(swept.expired);
    const [row] = await db
      .select()
      .from(whatsappPendingIntents)
      .where(eq(whatsappPendingIntents.id, created.row.id));
    expect(row?.status).toBe("EXPIRED");
    expect(row?.payloadClearedAt).toBeTruthy();
  });

  it("cleanup saudável sem trabalho devolve ok e zeros", async () => {
    await db.delete(whatsappPendingIntents);
    const swept = await clearExpiredWhatsAppPendingIntents(new Date());
    expect(swept).toEqual({ ok: true, expired: 0, payloadsCleared: 0 });
  });

  it("payloadsCleared = expired + leftovers sem contar duas vezes a mesma row", async () => {
    await db.delete(whatsappPendingIntents);
    const dueSource = await insertInbound(userA, "cnt-due");
    const leftoverSource = await insertInbound(userA, "cnt-left");
    const createdAt = new Date("2026-09-04T06:00:00.000Z");
    const created = await createWhatsAppPendingIntent(
      { sourceInboundMessageId: dueSource },
      createdAt,
    );
    if (!created.ok) throw new Error(created.code);
    await db.insert(whatsappPendingIntents).values({
      userId: userA,
      sourceInboundMessageId: leftoverSource,
      institutionId: null,
      status: "CANCELLED",
      stage: "PARSE",
      intentKind: null,
      parsedPayload: { slot: "stale" },
      resolvedPayload: null,
      clarificationPayload: null,
      expiresAt: createdAt,
      consumedAt: null,
      payloadClearedAt: null,
    });
    const dueAt = new Date(createdAt.getTime() + WHATSAPP_PENDING_INTENT_TTL_MS);
    const swept = await clearExpiredWhatsAppPendingIntents(dueAt);
    expect(swept).toEqual({ ok: true, expired: 1, payloadsCleared: 2 });
    const rows = await db
      .select()
      .from(whatsappPendingIntents)
      .where(inArray(whatsappPendingIntents.userId, [userA]));
    expect(rows.every((row) => row.payloadClearedAt != null)).toBe(true);
    expect(rows.find((row) => row.id === created.row.id)?.status).toBe(
      "EXPIRED",
    );
  });

  it("retry de cleanup é idempotente e completa leftover", async () => {
    await db.delete(whatsappPendingIntents);
    const sourceId = await insertInbound(userA, "retry-clean");
    const createdAt = new Date("2026-09-04T05:00:00.000Z");
    const created = await createWhatsAppPendingIntent(
      { sourceInboundMessageId: sourceId },
      createdAt,
    );
    if (!created.ok) throw new Error(created.code);
    const dueAt = new Date(createdAt.getTime() + WHATSAPP_PENDING_INTENT_TTL_MS);
    const first = await clearExpiredWhatsAppPendingIntents(dueAt);
    const second = await clearExpiredWhatsAppPendingIntents(dueAt);
    expect(first).toMatchObject({ ok: true, expired: 1, payloadsCleared: 1 });
    expect(second).toEqual({ ok: true, expired: 0, payloadsCleared: 0 });
  });

  it("cleanup não expira OPEN com TTL futuro", async () => {
    await db.delete(whatsappPendingIntents);
    const sourceId = await insertInbound(userA, "future-open");
    const now = new Date("2026-09-04T16:00:00.000Z");
    const created = await createWhatsAppPendingIntent(
      { sourceInboundMessageId: sourceId },
      now,
    );
    if (!created.ok) throw new Error(created.code);
    const swept = await clearExpiredWhatsAppPendingIntents(now);
    expect(swept).toEqual({ ok: true, expired: 0, payloadsCleared: 0 });
    expect(
      await getOpenWhatsAppPendingIntentForUser(userA, now),
    ).toMatchObject({ ok: true, row: { id: created.row.id, status: "OPEN" } });
  });

  it("cancel e expire concorrentes não ressuscitam OPEN", async () => {
    const sourceId = await insertInbound(userA, "race-ce");
    const createdAt = new Date("2026-09-04T04:00:00.000Z");
    const created = await createWhatsAppPendingIntent(
      { sourceInboundMessageId: sourceId },
      createdAt,
    );
    if (!created.ok) throw new Error(created.code);
    const dueAt = new Date(createdAt.getTime() + WHATSAPP_PENDING_INTENT_TTL_MS);
    const [cancelled, expired] = await Promise.all([
      cancelWhatsAppPendingIntent(created.row.id, userA, dueAt),
      expireWhatsAppPendingIntent(created.row.id, userA, dueAt),
    ]);
    expect(cancelled.ok).toBe(true);
    expect(expired.ok).toBe(true);
    if (!cancelled.ok || !expired.ok) throw new Error("race ce failed");
    const statuses = [cancelled.row.status, expired.row.status];
    expect(statuses.every((status) => status !== "OPEN")).toBe(true);
    const outcomes = [cancelled.outcome, expired.outcome];
    expect(outcomes).toContain("updated");
    expect(
      outcomes.every(
        (outcome) => outcome === "updated" || outcome === "already_terminal",
      ),
    ).toBe(true);
    const [row] = await db
      .select()
      .from(whatsappPendingIntents)
      .where(eq(whatsappPendingIntents.id, created.row.id));
    expect(row?.status === "CANCELLED" || row?.status === "EXPIRED").toBe(true);
    expect(row?.payloadClearedAt).toBeTruthy();
    expect(row?.parsedPayload).toBeNull();
  });

  it("cleanup após cancel mantém terminal e payload limpo", async () => {
    const sourceId = await insertInbound(userA, "clean-term");
    const created = await createWhatsAppPendingIntent({
      sourceInboundMessageId: sourceId,
    });
    if (!created.ok) throw new Error(created.code);
    const cancelled = await cancelWhatsAppPendingIntent(created.row.id, userA);
    expect(cancelled).toMatchObject({ ok: true, outcome: "updated" });
    const swept = await clearExpiredWhatsAppPendingIntents(new Date());
    expect(swept.ok).toBe(true);
    const [row] = await db
      .select()
      .from(whatsappPendingIntents)
      .where(eq(whatsappPendingIntents.id, created.row.id));
    expect(row?.status).toBe("CANCELLED");
    expect(row?.payloadClearedAt).toBeTruthy();
    expect(row?.parsedPayload).toBeNull();
    expect(row?.consumedAt).toBeNull();
  });

  it("nascimento OPEN B1 e terminais têm invariantes de payload", async () => {
    const sourceId = await insertInbound(userA, "invariants");
    const created = await createWhatsAppPendingIntent({
      sourceInboundMessageId: sourceId,
    });
    if (!created.ok) throw new Error(created.code);
    expectFoundationBirth(created.row, userA, sourceId);
    expect(created.row.stage).toBe("PARSE");
    expect(created.row.consumedAt).toBeNull();
    expect(created.row.expiresAt).toBeInstanceOf(Date);
    const cancelled = await cancelWhatsAppPendingIntent(created.row.id, userA);
    if (!cancelled.ok) throw new Error(cancelled.code);
    expect(cancelled.row.status).toBe("CANCELLED");
    expect(cancelled.row.parsedPayload).toBeNull();
    expect(cancelled.row.resolvedPayload).toBeNull();
    expect(cancelled.row.clarificationPayload).toBeNull();
    expect(cancelled.row.payloadClearedAt).toBeTruthy();
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

  it("cancel OPEN/PARSE terminaliza o slot e limpa payload conversacional", async () => {
    const sourceId = await insertInbound(userA, "parse-c1");
    const created = await createWhatsAppPendingIntent({
      sourceInboundMessageId: sourceId,
    });
    if (!created.ok) throw new Error(created.code);
    const cancelled = await cancelWhatsAppPendingOpenParse({
      pendingId: created.row.id,
      userId: userA,
      expectedSourceInboundMessageId: sourceId,
    });
    expect(cancelled).toMatchObject({ ok: true, outcome: "cancelled" });
    if (!cancelled.ok) throw new Error(cancelled.code);
    expect(cancelled.row.status).toBe("CANCELLED");
    expect(cancelled.row.stage).toBe("PARSE");
    expect(cancelled.row.parsedPayload).toBeNull();
    expect(cancelled.row.resolvedPayload).toBeNull();
    expect(cancelled.row.clarificationPayload).toBeNull();
    expect(cancelled.row.payloadClearedAt).toBeTruthy();
    expectHealthyAbsent(await getOpenWhatsAppPendingIntentForUser(userA));

    const replay = await createWhatsAppPendingIntent({
      sourceInboundMessageId: sourceId,
    });
    expect(replay).toMatchObject({ ok: true, outcome: "already_terminal" });
    if (!replay.ok) throw new Error(replay.code);
    expect(replay.row.id).toBe(created.row.id);
    expect(replay.row.status).toBe("CANCELLED");

    const nextSource = await insertInbound(userA, "parse-c1b");
    const next = await createWhatsAppPendingIntent({
      sourceInboundMessageId: nextSource,
    });
    expect(next).toMatchObject({ ok: true, outcome: "created" });
    if (!next.ok) throw new Error(next.code);
    expect(next.row.status).toBe("OPEN");
    expect(next.row.stage).toBe("PARSE");
    expect(next.row.id).not.toBe(created.row.id);
  });

  it("dois cancel PARSE no mesmo source convergem sem recriar OPEN", async () => {
    const sourceId = await insertInbound(userA, "parse-c4");
    const created = await createWhatsAppPendingIntent({
      sourceInboundMessageId: sourceId,
    });
    if (!created.ok) throw new Error(created.code);
    const [first, second] = await Promise.all([
      cancelWhatsAppPendingOpenParse({
        pendingId: created.row.id,
        userId: userA,
        expectedSourceInboundMessageId: sourceId,
      }),
      cancelWhatsAppPendingOpenParse({
        pendingId: created.row.id,
        userId: userA,
        expectedSourceInboundMessageId: sourceId,
      }),
    ]);
    const outcomes = [first, second].map((item) =>
      item.ok ? item.outcome : item.code,
    );
    expect(outcomes.sort()).toEqual(["already_terminal", "cancelled"].sort());
    const [row] = await db
      .select()
      .from(whatsappPendingIntents)
      .where(eq(whatsappPendingIntents.id, created.row.id));
    expect(row?.status).toBe("CANCELLED");
    expectHealthyAbsent(await getOpenWhatsAppPendingIntentForUser(userA));
    const replay = await createWhatsAppPendingIntent({
      sourceInboundMessageId: sourceId,
    });
    expect(replay).toMatchObject({ ok: true, outcome: "already_terminal" });
  });

  it("expire vs cancel PARSE convergem em terminal", async () => {
    const sourceId = await insertInbound(userA, "parse-c2");
    const createdAt = new Date("2026-09-04T08:00:00.000Z");
    const created = await createWhatsAppPendingIntent(
      { sourceInboundMessageId: sourceId },
      createdAt,
    );
    if (!created.ok) throw new Error(created.code);
    const dueAt = new Date(createdAt.getTime() + WHATSAPP_PENDING_INTENT_TTL_MS);
    const [expired, cancelled] = await Promise.all([
      expireWhatsAppPendingIntent(created.row.id, userA, dueAt),
      cancelWhatsAppPendingOpenParse({
        pendingId: created.row.id,
        userId: userA,
        expectedSourceInboundMessageId: sourceId,
      }),
    ]);
    for (const result of [expired, cancelled]) {
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(["updated", "cancelled", "already_terminal"]).toContain(
          result.outcome,
        );
      }
    }
    const [row] = await db
      .select()
      .from(whatsappPendingIntents)
      .where(eq(whatsappPendingIntents.id, created.row.id));
    expect(["CANCELLED", "EXPIRED"]).toContain(row?.status);
    expectHealthyAbsent(await getOpenWhatsAppPendingIntentForUser(userA, dueAt));
  });

  it("user cancel vs cancel PARSE convergem em CANCELLED", async () => {
    const sourceId = await insertInbound(userA, "parse-c3");
    const created = await createWhatsAppPendingIntent({
      sourceInboundMessageId: sourceId,
    });
    if (!created.ok) throw new Error(created.code);
    const [userCancel, parseCancel] = await Promise.all([
      cancelWhatsAppPendingIntent(created.row.id, userA),
      cancelWhatsAppPendingOpenParse({
        pendingId: created.row.id,
        userId: userA,
        expectedSourceInboundMessageId: sourceId,
      }),
    ]);
    const outcomes = [userCancel, parseCancel].map((item) =>
      item.ok ? item.outcome : item.code,
    );
    expect(outcomes).toContain("already_terminal");
    expect(
      outcomes.some((item) => item === "updated" || item === "cancelled"),
    ).toBe(true);
    const [row] = await db
      .select()
      .from(whatsappPendingIntents)
      .where(eq(whatsappPendingIntents.id, created.row.id));
    expect(row?.status).toBe("CANCELLED");
    expectHealthyAbsent(await getOpenWhatsAppPendingIntentForUser(userA));
  });

  it("cancel PARSE de outro user ou source não destrói o OPEN", async () => {
    const sourceId = await insertInbound(userA, "parse-own");
    const otherSource = await insertInbound(userA, "parse-own-b");
    const created = await createWhatsAppPendingIntent({
      sourceInboundMessageId: sourceId,
    });
    if (!created.ok) throw new Error(created.code);
    expect(
      await cancelWhatsAppPendingOpenParse({
        pendingId: created.row.id,
        userId: userB,
        expectedSourceInboundMessageId: sourceId,
      }),
    ).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(
      await cancelWhatsAppPendingOpenParse({
        pendingId: created.row.id,
        userId: userA,
        expectedSourceInboundMessageId: otherSource,
      }),
    ).toMatchObject({ ok: false, code: "STATE_CHANGED" });
    expect(
      await getWhatsAppPendingIntentByIdForUser(created.row.id, userA),
    ).toMatchObject({
      ok: true,
      row: { id: created.row.id, status: "OPEN", stage: "PARSE" },
    });
  });
});
