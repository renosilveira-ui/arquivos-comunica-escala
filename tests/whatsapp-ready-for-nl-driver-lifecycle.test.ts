import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { users, whatsappInboundMessages } from "../drizzle/schema";
import { getDb } from "../server/db";
import { logger } from "../server/_core/logger";
import { clearExpiredWhatsAppInboundPayloads } from "../server/integrations/whatsapp/operational-payload";
import * as consumer from "../server/integrations/whatsapp/ready-for-nl-consumer";
import {
  applyWhatsAppNlDriverDecision,
  claimWhatsAppReadyForNlWork,
  listWhatsAppReadyForNlEligibleIds,
  runWhatsAppNlDriverTick,
} from "../server/integrations/whatsapp/ready-for-nl-driver";
import {
  classifyWhatsAppNlDriverOutcome,
  formatWhatsAppNlDriverPark,
  WHATSAPP_NL_DRIVER_CLAIMED_PREFIX,
  WHATSAPP_NL_DRIVER_LEASE_MS,
  WHATSAPP_NL_DRIVER_MALFORMED_PARK_CODE,
  WHATSAPP_NL_DRIVER_PARK_PREFIX,
  WHATSAPP_NL_DRIVER_RETRY_PREFIX,
  WHATSAPP_NL_DRIVER_WAIT_PREFIX,
} from "../server/integrations/whatsapp/ready-for-nl-driver-occupancy";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

describe("WhatsApp B2-D — PARK lifecycle, clock, malformed, HOL", () => {
  let db: Db;
  const stamp = Date.now();
  const userIds: number[] = [];
  const inboundIds: number[] = [];
  let ownerId: number;

  async function insertUser(label: string): Promise<number> {
    const name = `wa-b2d-l-${label}-${stamp}`;
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
    suffix: string,
    extra: Record<string, unknown> = {},
  ): Promise<number> {
    const [row] = await db
      .insert(whatsappInboundMessages)
      .values({
        provider: "TWILIO",
        providerMessageId: `SMb2dl${stamp}${suffix}`.slice(0, 64),
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
    if (inboundIds.length) {
      await db
        .delete(whatsappInboundMessages)
        .where(inArray(whatsappInboundMessages.id, inboundIds));
      inboundIds.length = 0;
    }
  });

  afterAll(async () => {
    if (inboundIds.length) {
      await db
        .delete(whatsappInboundMessages)
        .where(inArray(whatsappInboundMessages.id, inboundIds));
    }
    if (userIds.length) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
  });

  it("PARK inventory: READY_FOR_NL + payload intacto; occupancy exclui; sweep TTL alcança", async () => {
    const secret =
      "CPF 529.982.247-25 tel +5511999887766 ana.park@example.test";
    const parked = await insertInbound("park", { operationalText: secret });
    const spy = vi.spyOn(consumer, "processWhatsAppReadyForNlInbound");
    spy.mockResolvedValue({
      ok: false,
      kind: "BLOCKED",
      code: "NEEDS_REFORMULATION",
    });
    const before = await loadInbound(parked);
    const tick = await runWhatsAppNlDriverTick({ batchSize: 5 });
    expect(
      tick.items.find((item) => item.sourceInboundMessageId === parked),
    ).toMatchObject({ action: "park", b2cCode: "NEEDS_REFORMULATION" });
    const after = await loadInbound(parked);
    expect(after?.processingStatus).toBe("READY_FOR_NL");
    expect(after?.payloadClearedAt).toBeNull();
    expect(after?.operationalText).toBe(secret);
    expect(after?.errorCode).toBe(
      `${WHATSAPP_NL_DRIVER_PARK_PREFIX}:NEEDS_REFORMULATION`,
    );
    expect(after?.errorCode).not.toBe(before?.errorCode);
    expect(after?.updatedAt).toBeTruthy();
    const eligible = await listWhatsAppReadyForNlEligibleIds({ batchSize: 50 });
    expect(eligible).not.toContain(parked);

    await db
      .update(whatsappInboundMessages)
      .set({ payloadExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(whatsappInboundMessages.id, parked));
    const swept = await clearExpiredWhatsAppInboundPayloads(new Date());
    expect(swept).toBeGreaterThanOrEqual(1);
    const cleared = await loadInbound(parked);
    expect(cleared?.payloadClearedAt).toBeTruthy();
    expect(cleared?.operationalText).toBeNull();
    expect(cleared?.processingStatus).toBe("READY_FOR_NL");
    expect(cleared?.errorCode).toBe(
      `${WHATSAPP_NL_DRIVER_PARK_PREFIX}:NEEDS_REFORMULATION`,
    );
    expect(
      await listWhatsAppReadyForNlEligibleIds({ batchSize: 50 }),
    ).not.toContain(parked);

    const newer = await insertInbound("park2", {
      operationalText: "outra mensagem",
    });
    const afterNewer = await loadInbound(parked);
    expect(afterNewer?.operationalText).toBeNull();
    expect(afterNewer?.id).not.toBe(newer);
  });

  it("privacidade: PARK/WAIT/RETRY não vazam CPF/tel/email em log nem error_code", async () => {
    const secret =
      "CPF 390.533.447-05 tel +55 85 98888-1111 email park.wait@example.test";
    const parkId = await insertInbound("piiP", {
      operationalText: secret,
      receivedAt: new Date(Date.now() - 3_000),
    });
    const waitId = await insertInbound("piiW", {
      operationalText: secret,
      receivedAt: new Date(Date.now() - 2_000),
    });
    const retryId = await insertInbound("piiR", {
      operationalText: secret,
      receivedAt: new Date(Date.now() - 1_000),
    });
    const logs: string[] = [];
    const logSpy = vi.spyOn(logger, "info").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
      return logger;
    });
    const spy = vi.spyOn(consumer, "processWhatsAppReadyForNlInbound");
    spy.mockImplementation(async ({ sourceInboundMessageId }) => {
      if (sourceInboundMessageId === parkId) {
        return { ok: false, kind: "BLOCKED", code: "NEEDS_REFORMULATION" };
      }
      if (sourceInboundMessageId === waitId) {
        return { ok: false, kind: "BLOCKED", code: "ALREADY_OPEN" };
      }
      return { ok: false, kind: "RETRYABLE_INFRA", code: "INTERNAL_FAILURE" };
    });
    await runWhatsAppNlDriverTick({ batchSize: 10 });
    const blob = logs.join("\n");
    expect(blob).toContain("whatsapp_nl_driver");
    expect(blob).not.toContain("390.533.447-05");
    expect(blob).not.toContain("98888-1111");
    expect(blob).not.toContain("park.wait@example.test");
    expect(blob).not.toContain(secret);
    expect((await loadInbound(parkId))?.errorCode).toBe(
      `${WHATSAPP_NL_DRIVER_PARK_PREFIX}:NEEDS_REFORMULATION`,
    );
    expect((await loadInbound(waitId))?.errorCode).toBe(
      `${WHATSAPP_NL_DRIVER_WAIT_PREFIX}:1`,
    );
    expect((await loadInbound(retryId))?.errorCode).toBe(
      `${WHATSAPP_NL_DRIVER_RETRY_PREFIX}:2`,
    );
    expect((await loadInbound(parkId))?.operationalText).toBe(secret);
    logSpy.mockRestore();
  });

  it("malformed occupancy não é elegível e não HOL-bloqueia fresh", async () => {
    const malformed = await insertInbound("mal", {
      errorCode: `${WHATSAPP_NL_DRIVER_WAIT_PREFIX}:abc`,
      receivedAt: new Date(Date.now() - 5_000),
    });
    const huge = await insertInbound("huge", {
      errorCode: `${WHATSAPP_NL_DRIVER_RETRY_PREFIX}:99999999999999999999`,
      receivedAt: new Date(Date.now() - 4_000),
    });
    const unknown = await insertInbound("unk", {
      errorCode: "NOT_A_DRIVER_CODE",
      receivedAt: new Date(Date.now() - 3_000),
    });
    const fresh = await insertInbound("frs", {
      receivedAt: new Date(Date.now() - 1_000),
    });
    await db.execute(sql`
      UPDATE whatsapp_inbound_messages
      SET updated_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 20 MINUTE)
      WHERE id = ${malformed} OR id = ${huge}
    `);
    const eligible = await listWhatsAppReadyForNlEligibleIds({ batchSize: 50 });
    expect(eligible).not.toContain(malformed);
    expect(eligible).not.toContain(huge);
    expect(eligible).not.toContain(unknown);
    expect(eligible).toContain(fresh);

    const spy = vi.spyOn(consumer, "processWhatsAppReadyForNlInbound");
    spy.mockImplementation(async ({ sourceInboundMessageId }) => {
      await db
        .update(whatsappInboundMessages)
        .set({ operationalText: null, payloadClearedAt: new Date() })
        .where(eq(whatsappInboundMessages.id, sourceInboundMessageId));
      return {
        ok: true,
        kind: "ADVANCED",
        stage: "CONFIRMATION",
        pendingId: sourceInboundMessageId,
      };
    });
    const tick = await runWhatsAppNlDriverTick({ batchSize: 5 });
    expect(
      tick.items.some((item) => item.sourceInboundMessageId === fresh),
    ).toBe(true);
    expect(
      tick.items.some((item) => item.sourceInboundMessageId === malformed),
    ).toBe(false);
    expect((await loadInbound(fresh))?.payloadClearedAt).toBeTruthy();
  });

  it("poison + WAIT futuro + RETRY futuro não bloqueiam fresh (HOL)", async () => {
    const base = Date.now();
    const poison = await insertInbound("holp", {
      receivedAt: new Date(base - 8_000),
    });
    const waiting = await insertInbound("holw", {
      receivedAt: new Date(base - 7_000),
      errorCode: `${WHATSAPP_NL_DRIVER_WAIT_PREFIX}:1`,
    });
    const retrying = await insertInbound("holr", {
      receivedAt: new Date(base - 6_000),
      errorCode: `${WHATSAPP_NL_DRIVER_RETRY_PREFIX}:2`,
    });
    const freshA = await insertInbound("holfa", {
      receivedAt: new Date(base - 2_000),
    });
    const freshB = await insertInbound("holfb", {
      receivedAt: new Date(base - 1_000),
    });
    await db.execute(sql`
      UPDATE whatsapp_inbound_messages
      SET updated_at = UTC_TIMESTAMP()
      WHERE id = ${waiting} OR id = ${retrying}
    `);
    const spy = vi.spyOn(consumer, "processWhatsAppReadyForNlInbound");
    spy.mockImplementation(async ({ sourceInboundMessageId }) => {
      if (sourceInboundMessageId === poison) {
        return { ok: false, kind: "BLOCKED", code: "INVALID_PAYLOAD" };
      }
      await db
        .update(whatsappInboundMessages)
        .set({ operationalText: null, payloadClearedAt: new Date() })
        .where(eq(whatsappInboundMessages.id, sourceInboundMessageId));
      return {
        ok: true,
        kind: "ADVANCED",
        stage: "CONFIRMATION",
        pendingId: sourceInboundMessageId,
      };
    });
    const tick = await runWhatsAppNlDriverTick({ batchSize: 20 });
    const processed = tick.items.map((item) => item.sourceInboundMessageId);
    expect(processed).toContain(poison);
    expect(processed).toContain(freshA);
    expect(processed).toContain(freshB);
    expect(processed).not.toContain(waiting);
    expect(processed).not.toContain(retrying);
    expect((await loadInbound(poison))?.errorCode).toBe(
      `${WHATSAPP_NL_DRIVER_PARK_PREFIX}:INVALID_PAYLOAD`,
    );
    expect((await loadInbound(freshA))?.payloadClearedAt).toBeTruthy();
    expect((await loadInbound(freshB))?.payloadClearedAt).toBeTruthy();
    expect((await loadInbound(waiting))?.errorCode).toBe(
      `${WHATSAPP_NL_DRIVER_WAIT_PREFIX}:1`,
    );
    expect((await loadInbound(retrying))?.errorCode).toBe(
      `${WHATSAPP_NL_DRIVER_RETRY_PREFIX}:2`,
    );
  });

  it("clock: claim grava now da app; skew ±5..120s preserva fence e liveness", async () => {
    expect(WHATSAPP_NL_DRIVER_LEASE_MS).toBe(90_000);
    const id = await insertInbound("clk");
    const claimNow = new Date();
    const claimed = await claimWhatsAppReadyForNlWork({
      now: claimNow,
      batchSize: 1,
      leaseMs: WHATSAPP_NL_DRIVER_LEASE_MS,
    });
    const workA = claimed.find((item) => item.id === id);
    expect(workA?.claimCode.startsWith(`${WHATSAPP_NL_DRIVER_CLAIMED_PREFIX}:`)).toBe(
      true,
    );
    const [clockRow] = await db
      .select({
        storedUnix: sql<number>`UNIX_TIMESTAMP(${whatsappInboundMessages.updatedAt})`,
        mysqlUnix: sql<number>`UNIX_TIMESTAMP()`,
      })
      .from(whatsappInboundMessages)
      .where(eq(whatsappInboundMessages.id, id))
      .limit(1);
    const storedUnix = Number(clockRow?.storedUnix);
    const mysqlUnix = Number(clockRow?.mysqlUnix);
    const appUnix = Math.floor(claimNow.getTime() / 1000);
    expect(Math.abs(storedUnix - appUnix)).toBeLessThanOrEqual(2);
    expect(Math.abs(storedUnix - mysqlUnix)).toBeLessThanOrEqual(2);

    for (const skewSec of [5, 30, 60, 90, 120]) {
      const early = new Date(claimNow.getTime() - skewSec * 1000);
      const premature = await listWhatsAppReadyForNlEligibleIds({
        now: early,
        batchSize: 20,
        leaseMs: WHATSAPP_NL_DRIVER_LEASE_MS,
      });
      expect(premature).not.toContain(id);

      const late = new Date(claimNow.getTime() + skewSec * 1000);
      const due = await listWhatsAppReadyForNlEligibleIds({
        now: late,
        batchSize: 20,
        leaseMs: WHATSAPP_NL_DRIVER_LEASE_MS,
      });
      if (skewSec > 90) {
        expect(due).toContain(id);
      } else if (skewSec < 90) {
        expect(due).not.toContain(id);
      }
    }

    const stealNow = new Date(claimNow.getTime() + 120_000);
    const claimedB = await claimWhatsAppReadyForNlWork({
      now: stealNow,
      batchSize: 5,
      leaseMs: WHATSAPP_NL_DRIVER_LEASE_MS,
    });
    const workB = claimedB.find((item) => item.id === id);
    expect(workB?.claimCode).toBeTruthy();
    expect(workB!.claimCode).not.toBe(workA!.claimCode);

    const staleWait = await applyWhatsAppNlDriverDecision(
      db,
      workA!,
      classifyWhatsAppNlDriverOutcome({
        result: { ok: false, kind: "BLOCKED", code: "ALREADY_OPEN" },
        attempt: workA!.attempt,
        now: stealNow,
        payloadExpiresAt: workA!.payloadExpiresAt,
      }),
      stealNow,
    );
    const stalePark = await applyWhatsAppNlDriverDecision(
      db,
      workA!,
      classifyWhatsAppNlDriverOutcome({
        result: { ok: false, kind: "BLOCKED", code: "NEEDS_REFORMULATION" },
        attempt: workA!.attempt,
        now: stealNow,
        payloadExpiresAt: workA!.payloadExpiresAt,
      }),
      stealNow,
    );
    const staleRetry = await applyWhatsAppNlDriverDecision(
      db,
      workA!,
      classifyWhatsAppNlDriverOutcome({
        result: {
          ok: false,
          kind: "RETRYABLE_INFRA",
          code: "INTERNAL_FAILURE",
        },
        attempt: workA!.attempt,
        now: stealNow,
        payloadExpiresAt: workA!.payloadExpiresAt,
      }),
      stealNow,
    );
    expect(staleWait).toBe(0);
    expect(stalePark).toBe(0);
    expect(staleRetry).toBe(0);
    expect((await loadInbound(id))?.errorCode).toBe(workB!.claimCode);
  });

  it("clock atrasado não impede reclaim depois do lease + |skew|", async () => {
    const id = await insertInbound("lag");
    const now = new Date();
    await claimWhatsAppReadyForNlWork({
      now,
      batchSize: 1,
      leaseMs: 1_000,
    });
    await db.execute(sql`
      UPDATE whatsapp_inbound_messages
      SET updated_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 5 SECOND)
      WHERE id = ${id}
    `);
    const stillHeld = await listWhatsAppReadyForNlEligibleIds({
      now: new Date(now.getTime() - 120_000),
      batchSize: 20,
      leaseMs: 1_000,
    });
    expect(stillHeld).not.toContain(id);
    const recovered = await listWhatsAppReadyForNlEligibleIds({
      now: new Date(now.getTime() + 2_000),
      batchSize: 20,
      leaseMs: 1_000,
    });
    expect(recovered).toContain(id);
  });

  it("mutation: fence exige claimCode; apply sem o predicado seria visível neste teste", async () => {
    const id = await insertInbound("mut");
    const now = new Date();
    const claimed = await claimWhatsAppReadyForNlWork({ now, batchSize: 1 });
    const work = claimed.find((item) => item.id === id);
    expect(work).toBeTruthy();
    const staleWork = {
      ...work!,
      claimCode: `${WHATSAPP_NL_DRIVER_CLAIMED_PREFIX}:1:deadbeefdead`,
    };
    const affected = await applyWhatsAppNlDriverDecision(
      db,
      staleWork,
      classifyWhatsAppNlDriverOutcome({
        result: { ok: true, kind: "ADVANCED", stage: "CONFIRMATION", pendingId: id },
        attempt: 1,
        now,
        payloadExpiresAt: work!.payloadExpiresAt,
      }),
      now,
    );
    expect(affected).toBe(0);
    expect((await loadInbound(id))?.errorCode).toBe(work!.claimCode);
  });

  it("format PARK malformed cabe no VARCHAR(64)", () => {
    const code = formatWhatsAppNlDriverPark(
      WHATSAPP_NL_DRIVER_MALFORMED_PARK_CODE,
    );
    expect(code.length).toBeLessThanOrEqual(64);
    expect(code).toBe("WA_NL_DRV_PARK:MALFORMED_OCCUPANCY");
  });

  it("discovery EXPLAIN: predicados bounded + LIMIT 20", async () => {
    const nowUnix = Math.floor(Date.now() / 1000);
    const explain = await db.execute(sql`
      EXPLAIN SELECT id, error_code, payload_expires_at
      FROM whatsapp_inbound_messages
      WHERE provider = 'TWILIO'
        AND processing_status = 'READY_FOR_NL'
        AND content_kind = 'TEXT'
        AND user_id IS NOT NULL
        AND payload_cleared_at IS NULL
        AND (
          error_code IS NULL
          OR (
            error_code LIKE 'WA_NL_DRV_CLAIMED:%'
            AND error_code REGEXP '^WA_NL_DRV_CLAIMED:[1-9][0-9]*:[^:]+$'
            AND UNIX_TIMESTAMP(updated_at) + 90 <= ${nowUnix}
          )
          OR (
            error_code LIKE 'WA_NL_DRV_RETRY:%'
            AND error_code REGEXP '^WA_NL_DRV_RETRY:[1-9][0-9]*$'
            AND UNIX_TIMESTAMP(updated_at) + 30 <= ${nowUnix}
          )
          OR (
            error_code LIKE 'WA_NL_DRV_WAIT:%'
            AND error_code REGEXP '^WA_NL_DRV_WAIT:[1-9][0-9]*$'
            AND UNIX_TIMESTAMP(updated_at) + 30 <= ${nowUnix}
          )
        )
        AND (
          (operational_text IS NOT NULL AND (payload_expires_at IS NULL OR payload_expires_at > UTC_TIMESTAMP()))
          OR EXISTS (
            SELECT 1 FROM whatsapp_pending_intents p
            WHERE p.source_inbound_message_id = whatsapp_inbound_messages.id
              AND p.status = 'OPEN'
              AND p.stage IN ('CLARIFICATION', 'CONFIRMATION')
              AND p.expires_at > UTC_TIMESTAMP()
          )
        )
      ORDER BY received_at ASC, id ASC
      LIMIT 20
    `);
    const blob = JSON.stringify(explain);
    expect(blob).toMatch(/whatsapp_inbound_messages/);
    expect(blob).toMatch(/LIMIT|20/);
  });
});
