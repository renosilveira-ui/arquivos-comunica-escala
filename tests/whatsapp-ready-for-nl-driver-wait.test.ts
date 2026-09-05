import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import {
  users,
  whatsappInboundMessages,
  whatsappPendingIntents,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import * as consumer from "../server/integrations/whatsapp/ready-for-nl-consumer";
import {
  listWhatsAppReadyForNlEligibleIds,
  runWhatsAppNlDriverTick,
} from "../server/integrations/whatsapp/ready-for-nl-driver";
import {
  WHATSAPP_NL_DRIVER_PARK_PREFIX,
  WHATSAPP_NL_DRIVER_WAIT_PREFIX,
  whatsAppNlDriverWaitDelayMs,
} from "../server/integrations/whatsapp/ready-for-nl-driver-occupancy";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

describe("WhatsApp B2-D — WAIT liveness (ALREADY_OPEN)", () => {
  let db: Db;
  const stamp = Date.now();
  const userIds: number[] = [];
  const inboundIds: number[] = [];
  const pendingIds: number[] = [];
  let ownerId: number;

  async function insertUser(label: string): Promise<number> {
    const name = `wa-b2d-w-${label}-${stamp}`;
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

  async function insertInbound(suffix: string, extra: Record<string, unknown> = {}) {
    const [row] = await db
      .insert(whatsappInboundMessages)
      .values({
        provider: "TWILIO",
        providerMessageId: `SMb2dw${stamp}${suffix}`.slice(0, 64),
        userId: ownerId,
        contentKind: "TEXT",
        forwarded: false,
        processingStatus: "READY_FOR_NL",
        operationalText: "texto operacional",
        payloadExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        receivedAt: new Date(),
        processedAt: new Date(),
        ...extra,
      })
      .$returningId();
    inboundIds.push(row.id);
    return row.id;
  }

  async function insertOpenPending(
    sourceId: number,
    expiresAt: Date,
    stage: "PARSE" | "CLARIFICATION" | "CONFIRMATION" = "PARSE",
  ) {
    const [row] = await db
      .insert(whatsappPendingIntents)
      .values({
        userId: ownerId,
        sourceInboundMessageId: sourceId,
        status: "OPEN",
        stage,
        expiresAt,
      })
      .$returningId();
    pendingIds.push(row.id);
    return row.id;
  }

  async function loadInbound(id: number) {
    const [row] = await db
      .select()
      .from(whatsappInboundMessages)
      .where(eq(whatsappInboundMessages.id, id))
      .limit(1);
    return row;
  }

  beforeAll(async () => {
    const maybe = await getDb();
    if (!maybe) throw new Error("DB unavailable");
    db = maybe;
    ownerId = await insertUser("owner");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (pendingIds.length) {
      await db
        .delete(whatsappPendingIntents)
        .where(inArray(whatsappPendingIntents.id, pendingIds));
      pendingIds.length = 0;
    }
    if (inboundIds.length) {
      await db
        .delete(whatsappInboundMessages)
        .where(inArray(whatsappInboundMessages.id, inboundIds));
      inboundIds.length = 0;
    }
  });

  afterAll(async () => {
    if (pendingIds.length) {
      await db
        .delete(whatsappPendingIntents)
        .where(inArray(whatsappPendingIntents.id, pendingIds));
    }
    if (inboundIds.length) {
      await db
        .delete(whatsappInboundMessages)
        .where(inArray(whatsappInboundMessages.id, inboundIds));
    }
    if (userIds.length) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
  });

  it("W1–W6: ALREADY_OPEN espera; pending termina; B processa sem terceira mensagem; sem hot loop", async () => {
    const inboundA = await insertInbound("a", {
      operationalText: null,
      payloadClearedAt: new Date(),
      receivedAt: new Date(Date.now() - 2_000),
    });
    const inboundB = await insertInbound("b", {
      receivedAt: new Date(Date.now() - 1_000),
    });
    const pendingId = await insertOpenPending(
      inboundA,
      new Date(Date.now() + 15 * 60 * 1000),
      "CLARIFICATION",
    );

    const spy = vi.spyOn(consumer, "processWhatsAppReadyForNlInbound");
    spy.mockImplementation(async ({ sourceInboundMessageId }) => {
      if (sourceInboundMessageId === inboundB) {
        return { ok: false, kind: "BLOCKED", code: "ALREADY_OPEN" };
      }
      throw new Error("unexpected source");
    });

    const now = new Date();
    const first = await runWhatsAppNlDriverTick({ now, batchSize: 5 });
    expect(first.waited).toBe(1);
    expect(first.items[0]).toMatchObject({
      sourceInboundMessageId: inboundB,
      action: "wait",
      disposition: "WAITING_FOR_OTHER_CONVERSATION",
    });
    expect((await loadInbound(inboundB))?.errorCode).toBe(
      `${WHATSAPP_NL_DRIVER_WAIT_PREFIX}:1`,
    );

    spy.mockClear();
    await runWhatsAppNlDriverTick({
      now: new Date(now.getTime() + 5_000),
      batchSize: 5,
    });
    expect(spy).not.toHaveBeenCalled();

    await db
      .update(whatsappPendingIntents)
      .set({ status: "EXPIRED", expiresAt: new Date(now.getTime() - 1_000) })
      .where(eq(whatsappPendingIntents.id, pendingId));

    spy.mockImplementation(async ({ sourceInboundMessageId }) => {
      await db
        .update(whatsappInboundMessages)
        .set({
          operationalText: null,
          payloadClearedAt: new Date(),
        })
        .where(eq(whatsappInboundMessages.id, sourceInboundMessageId));
      return {
        ok: true,
        kind: "ADVANCED",
        stage: "CONFIRMATION",
        pendingId: sourceInboundMessageId,
      };
    });

    const due = new Date(now.getTime() + whatsAppNlDriverWaitDelayMs(1) + 2_000);
    expect(
      (await listWhatsAppReadyForNlEligibleIds({ now: due, batchSize: 20 })),
    ).toContain(inboundB);

    const recovered = await runWhatsAppNlDriverTick({ now: due, batchSize: 5 });
    expect(
      recovered.items.some((item) => item.sourceInboundMessageId === inboundB),
    ).toBe(true);
    expect((await loadInbound(inboundB))?.payloadClearedAt).toBeTruthy();
    expect((await loadInbound(inboundB))?.errorCode).toBeNull();
    expect(spy.mock.calls.some((call) => call[0]?.sourceInboundMessageId === inboundB)).toBe(
      true,
    );
  });

  it("W5: pending A já expirado — B processa sem WAIT e sem terceira mensagem", async () => {
    const inboundA = await insertInbound("expa", {
      operationalText: null,
      payloadClearedAt: new Date(),
    });
    const inboundB = await insertInbound("expb");
    await insertOpenPending(inboundA, new Date(Date.now() - 1_000));
    await db
      .update(whatsappPendingIntents)
      .set({ status: "EXPIRED" })
      .where(eq(whatsappPendingIntents.sourceInboundMessageId, inboundA));

    const spy = vi.spyOn(consumer, "processWhatsAppReadyForNlInbound");
    spy.mockImplementation(async ({ sourceInboundMessageId }) => {
      await db
        .update(whatsappInboundMessages)
        .set({
          operationalText: null,
          payloadClearedAt: new Date(),
        })
        .where(eq(whatsappInboundMessages.id, sourceInboundMessageId));
      return {
        ok: true,
        kind: "ADVANCED",
        stage: "CLARIFICATION",
        pendingId: sourceInboundMessageId,
      };
    });
    const afterExpiry = await runWhatsAppNlDriverTick({ batchSize: 5 });
    expect(
      afterExpiry.items.some((item) => item.sourceInboundMessageId === inboundB),
    ).toBe(true);
    expect((await loadInbound(inboundB))?.payloadClearedAt).toBeTruthy();
  });

  it("W7: WAIT respeita TTL do payload — WAIT:n com material expirado não reentra", async () => {
    const waiting = await insertInbound("wttl", {
      payloadExpiresAt: new Date(Date.now() - 1_000),
      errorCode: `${WHATSAPP_NL_DRIVER_WAIT_PREFIX}:1`,
    });
    const due = new Date(Date.now() + 20 * 60 * 1000);
    expect(
      await listWhatsAppReadyForNlEligibleIds({ now: due, batchSize: 50 }),
    ).not.toContain(waiting);
    const spy = vi.spyOn(consumer, "processWhatsAppReadyForNlInbound");
    spy.mockResolvedValue({
      ok: false,
      kind: "BLOCKED",
      code: "ALREADY_OPEN",
    });
    const ttlTick = await runWhatsAppNlDriverTick({ now: due, batchSize: 5 });
    expect(
      ttlTick.items.some((item) => item.sourceInboundMessageId === waiting),
    ).toBe(false);
    expect((await loadInbound(waiting))?.errorCode).toBe(
      `${WHATSAPP_NL_DRIVER_WAIT_PREFIX}:1`,
    );
    expect(
      spy.mock.calls.some((call) => call[0]?.sourceInboundMessageId === waiting),
    ).toBe(false);
  });

  it("WAIT occupancy vencido reentra na eligibility SQL sem PARK prefix", async () => {
    const id = await insertInbound("wdue", {
      errorCode: `${WHATSAPP_NL_DRIVER_WAIT_PREFIX}:1`,
    });
    await db.execute(sql`
      UPDATE whatsapp_inbound_messages
      SET updated_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)
      WHERE id = ${id}
    `);
    expect(
      await listWhatsAppReadyForNlEligibleIds({ now: new Date(), batchSize: 50 }),
    ).toContain(id);
    await db.execute(sql`
      UPDATE whatsapp_inbound_messages
      SET error_code = ${`${WHATSAPP_NL_DRIVER_PARK_PREFIX}:ALREADY_OPEN`}
      WHERE id = ${id}
    `);
    expect(
      await listWhatsAppReadyForNlEligibleIds({ now: new Date(), batchSize: 50 }),
    ).not.toContain(id);
  });

  it("reformulation: inbound insuficiente PARK; mensagem nova cria progresso sem WAIT", async () => {
    const insufficient = await insertInbound("refa", {
      receivedAt: new Date(Date.now() - 3_000),
    });
    const followUp = await insertInbound("refb", {
      receivedAt: new Date(Date.now() - 1_000),
    });
    const pendingId = await insertOpenPending(
      insufficient,
      new Date(Date.now() + 15 * 60 * 1000),
    );

    const spy = vi.spyOn(consumer, "processWhatsAppReadyForNlInbound");
    spy.mockImplementation(async ({ sourceInboundMessageId }) => {
      if (sourceInboundMessageId === insufficient) {
        await db
          .update(whatsappPendingIntents)
          .set({ status: "CANCELLED" })
          .where(eq(whatsappPendingIntents.id, pendingId));
        return {
          ok: false,
          kind: "BLOCKED",
          code: "NEEDS_REFORMULATION",
        };
      }
      await db
        .update(whatsappInboundMessages)
        .set({
          operationalText: null,
          payloadClearedAt: new Date(),
        })
        .where(eq(whatsappInboundMessages.id, sourceInboundMessageId));
      return {
        ok: true,
        kind: "ADVANCED",
        stage: "CONFIRMATION",
        pendingId: sourceInboundMessageId,
      };
    });

    await runWhatsAppNlDriverTick({ now: new Date(), batchSize: 10 });
    expect((await loadInbound(insufficient))?.errorCode).toBe(
      `${WHATSAPP_NL_DRIVER_PARK_PREFIX}:NEEDS_REFORMULATION`,
    );
    expect((await loadInbound(followUp))?.errorCode).toBeNull();
    expect((await loadInbound(followUp))?.payloadClearedAt).toBeTruthy();
    expect((await loadInbound(insufficient))?.payloadClearedAt).toBeNull();
    expect((await loadInbound(insufficient))?.operationalText).toBeTruthy();
    expect(
      spy.mock.calls.map((call) => call[0]?.sourceInboundMessageId),
    ).toEqual([insufficient, followUp]);
  });

  it("WAIT due oldest-first; inbound novo em backoff pula a fila do driver, não a conversa", async () => {
    const olderWait = await insertInbound("wold", {
      receivedAt: new Date(Date.now() - 8_000),
      errorCode: `${WHATSAPP_NL_DRIVER_WAIT_PREFIX}:1`,
    });
    const newerWait = await insertInbound("wnew", {
      receivedAt: new Date(Date.now() - 6_000),
      errorCode: `${WHATSAPP_NL_DRIVER_WAIT_PREFIX}:1`,
    });
    await db.execute(sql`
      UPDATE whatsapp_inbound_messages
      SET updated_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)
      WHERE id = ${olderWait} OR id = ${newerWait}
    `);
    const due = new Date();
    const ordered = await listWhatsAppReadyForNlEligibleIds({
      now: due,
      batchSize: 50,
    });
    const waitOrder = ordered.filter((id) => id === olderWait || id === newerWait);
    expect(waitOrder).toEqual([olderWait, newerWait]);

    const jumping = await insertInbound("wjmp", {
      receivedAt: new Date(),
    });
    const olderStillWaiting = await insertInbound("whot", {
      receivedAt: new Date(Date.now() - 4_000),
      errorCode: `${WHATSAPP_NL_DRIVER_WAIT_PREFIX}:1`,
    });
    await db.execute(sql`
      UPDATE whatsapp_inbound_messages
      SET updated_at = UTC_TIMESTAMP()
      WHERE id = ${olderStillWaiting}
    `);
    const eligibleNow = await listWhatsAppReadyForNlEligibleIds({
      now: new Date(),
      batchSize: 50,
    });
    expect(eligibleNow).toContain(jumping);
    expect(eligibleNow).not.toContain(olderStillWaiting);
  });
});
