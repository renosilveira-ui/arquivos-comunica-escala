import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { users, whatsappInboundMessages } from "../drizzle/schema";
import { getDb } from "../server/db";
import * as dbMod from "../server/db";
import * as consumer from "../server/integrations/whatsapp/ready-for-nl-consumer";
import { runWhatsAppNlDriverTick } from "../server/integrations/whatsapp/ready-for-nl-driver";
import {
  WHATSAPP_NL_DRIVER_PARK_PREFIX,
  WHATSAPP_NL_DRIVER_RETRY_PREFIX,
  whatsAppNlDriverRetryDelayMs,
} from "../server/integrations/whatsapp/ready-for-nl-driver-occupancy";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

describe("WhatsApp B2-D — retry e backoff", () => {
  let db: Db;
  const stamp = Date.now();
  const userIds: number[] = [];
  const inboundIds: number[] = [];
  let ownerId: number;

  async function insertInbound(suffix: string, expiresAt?: Date): Promise<number> {
    const [row] = await db
      .insert(whatsappInboundMessages)
      .values({
        provider: "TWILIO",
        providerMessageId: `SMb2dr${stamp}${suffix}`.slice(0, 64),
        userId: ownerId,
        contentKind: "TEXT",
        forwarded: false,
        processingStatus: "READY_FOR_NL",
        operationalText: "texto",
        payloadExpiresAt:
          expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
        receivedAt: new Date(),
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
    const name = `wa-b2d-r-${stamp}`;
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
    ownerId = user.id;
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

  it("23-24. DB unavailable no tick e INTERNAL_FAILURE do B2-C não terminalizam", async () => {
    const spy = vi.spyOn(consumer, "processWhatsAppReadyForNlInbound");
    const getDbSpy = vi.spyOn(dbMod, "getDb").mockResolvedValueOnce(null);
    const summary = await runWhatsAppNlDriverTick({ batchSize: 5 });
    expect(summary.claimed).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    getDbSpy.mockRestore();

    const id = await insertInbound("int");
    spy.mockResolvedValue({
      ok: false,
      kind: "RETRYABLE_INFRA",
      code: "INTERNAL_FAILURE",
    });
    const now = new Date();
    const retried = await runWhatsAppNlDriverTick({ now, batchSize: 5 });
    expect(
      retried.items.find((item) => item.sourceInboundMessageId === id),
    ).toMatchObject({ action: "retry", b2cCode: "INTERNAL_FAILURE" });
    const row = await loadInbound(id);
    expect(row?.errorCode).toBe(`${WHATSAPP_NL_DRIVER_RETRY_PREFIX}:2`);
    expect(row?.payloadClearedAt).toBeNull();
    expect(row?.processingStatus).toBe("READY_FOR_NL");
  });

  it("25-26. infra repetida respeita backoff e não hammers", async () => {
    const id = await insertInbound("bk");
    const spy = vi.spyOn(consumer, "processWhatsAppReadyForNlInbound");
    spy.mockResolvedValue({
      ok: false,
      kind: "RETRYABLE_INFRA",
      code: "PERSISTENCE_FAILED",
    });
    const now = new Date();
    await runWhatsAppNlDriverTick({ now, batchSize: 5 });
    spy.mockClear();
    await runWhatsAppNlDriverTick({
      now: new Date(now.getTime() + 1_000),
      batchSize: 5,
    });
    expect(
      spy.mock.calls.some((call) => call[0]?.sourceInboundMessageId === id),
    ).toBe(false);
    spy.mockClear();
    const due = new Date(now.getTime() + whatsAppNlDriverRetryDelayMs(2) + 2_000);
    await runWhatsAppNlDriverTick({ now: due, batchSize: 5 });
    expect(
      spy.mock.calls.some((call) => call[0]?.sourceInboundMessageId === id),
    ).toBe(true);
    const row = await loadInbound(id);
    expect(row?.errorCode).toBe(`${WHATSAPP_NL_DRIVER_RETRY_PREFIX}:3`);
  });

  it("27. TTL expirado sem pending reconciliável estaciona em vez de retry infinito", async () => {
    const expired = new Date(Date.now() - 1_000);
    const id = await insertInbound("ttl", expired);
    const spy = vi.spyOn(consumer, "processWhatsAppReadyForNlInbound");
    spy.mockResolvedValue({
      ok: false,
      kind: "RETRYABLE_INFRA",
      code: "DB_UNAVAILABLE",
    });
    const summary = await runWhatsAppNlDriverTick({ batchSize: 5 });
    expect(
      summary.items.some((item) => item.sourceInboundMessageId === id),
    ).toBe(false);
    expect(spy.mock.calls.map((call) => call[0]?.sourceInboundMessageId)).not.toContain(
      id,
    );
    expect((await loadInbound(id))?.errorCode).toBeNull();
  });

  it("28. recuperação depois da infra voltar", async () => {
    const id = await insertInbound("rec");
    const spy = vi.spyOn(consumer, "processWhatsAppReadyForNlInbound");
    spy.mockResolvedValueOnce({
      ok: false,
      kind: "RETRYABLE_INFRA",
      code: "DB_UNAVAILABLE",
    });
    const now = new Date();
    await runWhatsAppNlDriverTick({ now, batchSize: 5 });
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
    await runWhatsAppNlDriverTick({
      now: new Date(now.getTime() + whatsAppNlDriverRetryDelayMs(2) + 2_000),
      batchSize: 5,
    });
    const row = await loadInbound(id);
    expect(row?.payloadClearedAt).toBeTruthy();
    expect(row?.errorCode).toBeNull();
    expect(WHATSAPP_NL_DRIVER_PARK_PREFIX).toContain("WA_NL_DRV_PARK");
  });
});
