import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { users, whatsappInboundMessages } from "../drizzle/schema";
import { getDb } from "../server/db";
import * as consumer from "../server/integrations/whatsapp/ready-for-nl-consumer";
import {
  claimWhatsAppReadyForNlWork,
  applyWhatsAppNlDriverDecision,
  runWhatsAppNlDriverTick,
} from "../server/integrations/whatsapp/ready-for-nl-driver";
import {
  classifyWhatsAppNlDriverOutcome,
  WHATSAPP_NL_DRIVER_CLAIMED_PREFIX,
  WHATSAPP_NL_DRIVER_RETRY_PREFIX,
} from "../server/integrations/whatsapp/ready-for-nl-driver-occupancy";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

describe("WhatsApp B2-D — concorrência e crash", () => {
  let db: Db;
  const stamp = Date.now();
  const userIds: number[] = [];
  const inboundIds: number[] = [];
  let ownerId: number;

  async function insertUser(label: string): Promise<number> {
    const name = `wa-b2d-c-${label}-${stamp}`;
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

  async function insertInbound(suffix: string, receivedAt?: Date): Promise<number> {
    const [row] = await db
      .insert(whatsappInboundMessages)
      .values({
        provider: "TWILIO",
        providerMessageId: `SMb2dc${stamp}${suffix}`.slice(0, 64),
        userId: ownerId,
        contentKind: "TEXT",
        forwarded: false,
        processingStatus: "READY_FOR_NL",
        operationalText: "texto",
        payloadExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        receivedAt: receivedAt ?? new Date(),
        processedAt: new Date(),
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

  it("13-15. dois ticks simultâneos pegam rows distintas e não divergem o mesmo inbound", async () => {
    const a = await insertInbound("a", new Date(Date.now() - 2_000));
    const b = await insertInbound("b", new Date(Date.now() - 1_000));
    const spy = vi.spyOn(consumer, "processWhatsAppReadyForNlInbound");
    const seen: number[] = [];
    spy.mockImplementation(async ({ sourceInboundMessageId }) => {
      seen.push(sourceInboundMessageId);
      await new Promise((resolve) => {
        setTimeout(resolve, 80);
      });
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
    const [left, right] = await Promise.all([
      runWhatsAppNlDriverTick({ batchSize: 1 }),
      runWhatsAppNlDriverTick({ batchSize: 1 }),
    ]);
    const processed = [...left.items, ...right.items].map(
      (item) => item.sourceInboundMessageId,
    );
    expect(new Set(processed).size).toBe(2);
    expect(processed.sort()).toEqual([a, b].sort());
    expect(seen.sort()).toEqual([a, b].sort());
    expect((await loadInbound(a))?.payloadClearedAt).toBeTruthy();
    expect((await loadInbound(b))?.payloadClearedAt).toBeTruthy();
  });

  it("14. o mesmo inbound em ticks paralelos não produz estado divergente", async () => {
    const id = await insertInbound("one");
    const spy = vi.spyOn(consumer, "processWhatsAppReadyForNlInbound");
    spy.mockImplementation(async ({ sourceInboundMessageId }) => {
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
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
    await Promise.all([
      runWhatsAppNlDriverTick({ batchSize: 5 }),
      runWhatsAppNlDriverTick({ batchSize: 5 }),
    ]);
    const row = await loadInbound(id);
    expect(row?.processingStatus).toBe("READY_FOR_NL");
    expect(row?.payloadClearedAt).toBeTruthy();
    expect(row?.operationalText).toBeNull();
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("16-18. crash após claim / duplicate tick / restart recovery", async () => {
    const crashed = await insertInbound("crsh");
    const now = new Date();
    const claimed = await claimWhatsAppReadyForNlWork({
      now,
      batchSize: 5,
      leaseMs: 1_000,
    });
    expect(claimed.some((item) => item.id === crashed)).toBe(true);
    const held = await loadInbound(crashed);
    expect(held?.errorCode?.startsWith(`${WHATSAPP_NL_DRIVER_CLAIMED_PREFIX}:`)).toBe(
      true,
    );
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
        stage: "CONFIRMATION",
        pendingId: sourceInboundMessageId,
      };
    });
    await runWhatsAppNlDriverTick({ now, batchSize: 5, leaseMs: 1_000 });
    expect(
      spy.mock.calls.some((call) => call[0]?.sourceInboundMessageId === crashed),
    ).toBe(false);

    spy.mockClear();
    await runWhatsAppNlDriverTick({
      now: new Date(now.getTime() + 2_500),
      batchSize: 5,
      leaseMs: 1_000,
    });
    expect(
      spy.mock.calls.some((call) => call[0]?.sourceInboundMessageId === crashed),
    ).toBe(true);
    expect((await loadInbound(crashed))?.payloadClearedAt).toBeTruthy();

    spy.mockClear();
    await runWhatsAppNlDriverTick({
      now: new Date(now.getTime() + 4_000),
      batchSize: 5,
      leaseMs: 1_000,
    });
    expect(
      spy.mock.calls.some((call) => call[0]?.sourceInboundMessageId === crashed),
    ).toBe(false);
  });

  it("shutdown não pré-claima o resto do batch", async () => {
    const first = await insertInbound("sd1", new Date(Date.now() - 3_000));
    const second = await insertInbound("sd2", new Date(Date.now() - 2_000));
    const third = await insertInbound("sd3", new Date(Date.now() - 1_000));
    const spy = vi.spyOn(consumer, "processWhatsAppReadyForNlInbound");
    let processed = 0;
    spy.mockImplementation(async ({ sourceInboundMessageId }) => {
      processed += 1;
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
    const summary = await runWhatsAppNlDriverTick({
      batchSize: 3,
      shuttingDown: () => processed >= 1,
    });
    expect(summary.claimed).toBe(1);
    expect(summary.completed).toBe(1);
    expect((await loadInbound(first))?.payloadClearedAt).toBeTruthy();
    expect((await loadInbound(second))?.errorCode).toBeNull();
    expect((await loadInbound(third))?.errorCode).toBeNull();
    expect((await loadInbound(second))?.payloadClearedAt).toBeNull();
  });

  it("19. crash antes de B2-C: outro tick recupera pelo lease", async () => {
    const id = await insertInbound("pre");
    const now = new Date();
    await claimWhatsAppReadyForNlWork({ now, batchSize: 1, leaseMs: 1_000 });
    const spy = vi.spyOn(consumer, "processWhatsAppReadyForNlInbound");
    spy.mockResolvedValue({
      ok: false,
      kind: "RETRYABLE_INFRA",
      code: "INTERNAL_FAILURE",
    });
    await runWhatsAppNlDriverTick({
      now: new Date(now.getTime() + 2_500),
      batchSize: 5,
      leaseMs: 1_000,
    });
    expect(spy).toHaveBeenCalledWith({ sourceInboundMessageId: id });
    const row = await loadInbound(id);
    expect(row?.errorCode?.startsWith(`${WHATSAPP_NL_DRIVER_RETRY_PREFIX}:`)).toBe(
      true,
    );
    expect(row?.payloadClearedAt).toBeNull();
  });

  it("20-22. crash após advance/cleanup/sucesso: reconcilia sem perder a row", async () => {
    const afterAdvance = await insertInbound("advn");
    const afterCleanup = await insertInbound("cln");
    const afterSuccess = await insertInbound("suc");

    await db
      .update(whatsappInboundMessages)
      .set({
        operationalText: null,
        payloadClearedAt: new Date(),
        errorCode: `${WHATSAPP_NL_DRIVER_CLAIMED_PREFIX}:1:deadbeef`,
      })
      .where(eq(whatsappInboundMessages.id, afterCleanup));

    const spy = vi.spyOn(consumer, "processWhatsAppReadyForNlInbound");
    spy.mockImplementation(async ({ sourceInboundMessageId }) => {
      if (sourceInboundMessageId === afterAdvance) {
        await db
          .update(whatsappInboundMessages)
          .set({
            operationalText: null,
            payloadClearedAt: new Date(),
          })
          .where(eq(whatsappInboundMessages.id, sourceInboundMessageId));
        return {
          ok: true,
          kind: "REPLAY",
          stage: "CONFIRMATION",
          pendingId: sourceInboundMessageId,
        };
      }
      if (sourceInboundMessageId === afterSuccess) {
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
      }
      throw new Error("should not process cleaned row");
    });

    const summary = await runWhatsAppNlDriverTick({ batchSize: 10 });
    const processed = summary.items.map((item) => item.sourceInboundMessageId);
    expect(processed).toContain(afterAdvance);
    expect(processed).toContain(afterSuccess);
    expect(processed).not.toContain(afterCleanup);
    expect((await loadInbound(afterAdvance))?.payloadClearedAt).toBeTruthy();
    expect((await loadInbound(afterSuccess))?.payloadClearedAt).toBeTruthy();
    expect((await loadInbound(afterCleanup))?.payloadClearedAt).toBeTruthy();
  });

  it("stale worker A não escreve bookkeeping depois que B rouba o lease", async () => {
    const id = await insertInbound("fence");
    const now = new Date();
    const claimedA = await claimWhatsAppReadyForNlWork({
      now,
      batchSize: 1,
      leaseMs: 500,
    });
    const workA = claimedA.find((item) => item.id === id);
    expect(workA?.claimCode).toBeTruthy();
    await db.execute(sql`
      UPDATE whatsapp_inbound_messages
      SET updated_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 60 SECOND)
      WHERE id = ${id}
    `);
    const claimedB = await claimWhatsAppReadyForNlWork({
      now: new Date(now.getTime() + 5_000),
      batchSize: 5,
      leaseMs: 500,
    });
    const workB = claimedB.find((item) => item.id === id);
    expect(workB?.claimCode).toBeTruthy();
    expect(workB!.claimCode).not.toBe(workA!.claimCode);

    const staleAffected = await applyWhatsAppNlDriverDecision(
      db,
      workA!,
      classifyWhatsAppNlDriverOutcome({
        result: {
          ok: false,
          kind: "RETRYABLE_INFRA",
          code: "INTERNAL_FAILURE",
        },
        attempt: workA!.attempt,
        now,
        payloadExpiresAt: workA!.payloadExpiresAt,
      }),
      now,
    );
    expect(staleAffected).toBe(0);
    const afterStale = await loadInbound(id);
    expect(afterStale?.errorCode).toBe(workB!.claimCode);

    const ownerAffected = await applyWhatsAppNlDriverDecision(
      db,
      workB!,
      classifyWhatsAppNlDriverOutcome({
        result: {
          ok: false,
          kind: "RETRYABLE_INFRA",
          code: "INTERNAL_FAILURE",
        },
        attempt: workB!.attempt,
        now,
        payloadExpiresAt: workB!.payloadExpiresAt,
      }),
      now,
    );
    expect(ownerAffected).toBe(1);
    const afterOwner = await loadInbound(id);
    expect(afterOwner?.errorCode?.startsWith(`${WHATSAPP_NL_DRIVER_RETRY_PREFIX}:`)).toBe(
      true,
    );
  });
});
