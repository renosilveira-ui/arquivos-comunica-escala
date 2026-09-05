import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  users,
  whatsappInboundMessages,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import * as dbMod from "../server/db";
import { logger } from "../server/_core/logger";
import * as sourceMod from "../server/integrations/whatsapp/ready-for-nl-source";
import { clearWhatsAppInboundOperationalPayloadForReadyNl } from "../server/integrations/whatsapp/ready-for-nl-cleanup";
import { clearWhatsAppInboundOperationalPayload } from "../server/integrations/whatsapp/operational-payload";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

describe("WhatsApp B2-C — compare-and-clear atômico", () => {
  let db: Db;
  let userA: number;
  let userB: number;
  const stamp = Date.now();
  const inboundIds: number[] = [];
  const userIds: number[] = [];

  async function insertUser(label: string): Promise<number> {
    const name = `wa-clr-${label}-${stamp}`;
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

  async function insertInbound(input: {
    ownerId: number | null;
    suffix: string;
    status?: string;
    kind?: "TEXT" | "AUDIO" | "UNSUPPORTED_MEDIA";
    text?: string | null;
  }): Promise<number> {
    const [row] = await db
      .insert(whatsappInboundMessages)
      .values({
        provider: "TWILIO",
        providerMessageId: `SMclr${stamp}${input.suffix}`.slice(0, 64),
        userId: input.ownerId,
        contentKind: input.kind ?? "TEXT",
        forwarded: false,
        processingStatus: input.status ?? "READY_FOR_NL",
        operationalText: input.text === undefined ? "texto operacional" : input.text,
        payloadExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
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
    userA = await insertUser("a");
    userB = await insertUser("b");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (inboundIds.length > 0) {
      await db
        .delete(whatsappInboundMessages)
        .where(inArray(whatsappInboundMessages.id, inboundIds));
    }
    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
  });

  it("owner correto + READY_FOR_NL + TEXT → limpa", async () => {
    const id = await insertInbound({ ownerId: userA, suffix: "ok" });
    const result = await clearWhatsAppInboundOperationalPayloadForReadyNl({
      sourceInboundMessageId: id,
      expectedUserId: userA,
    });
    expect(result).toEqual({ ok: true, outcome: "cleared" });
    const row = await loadInbound(id);
    expect(row?.operationalText).toBeNull();
    expect(row?.payloadClearedAt).toBeTruthy();
    expect(row?.userId).toBe(userA);
    expect(row?.processingStatus).toBe("READY_FOR_NL");
    expect(row?.contentKind).toBe("TEXT");
  });

  it("userId divergente → não limpa", async () => {
    const lines: string[] = [];
    const logSpy = vi.spyOn(logger, "info").mockImplementation((obj: unknown) => {
      lines.push(typeof obj === "string" ? obj : JSON.stringify(obj));
      return logger;
    });
    const id = await insertInbound({ ownerId: userA, suffix: "own" });
    const result = await clearWhatsAppInboundOperationalPayloadForReadyNl({
      sourceInboundMessageId: id,
      expectedUserId: userB,
    });
    expect(result).toEqual({ ok: false, code: "STATE_CHANGED" });
    const row = await loadInbound(id);
    expect(row?.operationalText).toBe("texto operacional");
    expect(row?.payloadClearedAt).toBeNull();
    const blob = lines.join("\n");
    expect(blob).toContain("whatsapp_inbound_ready_nl_clear_miss");
    expect(blob).not.toContain("whatsapp_inbound_ready_nl_clear_failed");
    expect(blob).toContain('"sameOwner":false');
    expect(blob).not.toContain("texto operacional");
    logSpy.mockRestore();
  });

  it("status mudou antes do clear → não limpa", async () => {
    const id = await insertInbound({ ownerId: userA, suffix: "st" });
    await db
      .update(whatsappInboundMessages)
      .set({ processingStatus: "READY_FOR_TRANSCRIPTION" })
      .where(eq(whatsappInboundMessages.id, id));
    const result = await clearWhatsAppInboundOperationalPayloadForReadyNl({
      sourceInboundMessageId: id,
      expectedUserId: userA,
    });
    expect(result).toEqual({ ok: false, code: "STATE_CHANGED" });
    const row = await loadInbound(id);
    expect(row?.operationalText).toBe("texto operacional");
    expect(row?.payloadClearedAt).toBeNull();
    expect(row?.processingStatus).toBe("READY_FOR_TRANSCRIPTION");
  });

  it("kind mudou antes do clear → não limpa", async () => {
    const id = await insertInbound({ ownerId: userA, suffix: "kd" });
    await db
      .update(whatsappInboundMessages)
      .set({ contentKind: "AUDIO" })
      .where(eq(whatsappInboundMessages.id, id));
    const result = await clearWhatsAppInboundOperationalPayloadForReadyNl({
      sourceInboundMessageId: id,
      expectedUserId: userA,
    });
    expect(result).toEqual({ ok: false, code: "STATE_CHANGED" });
    const row = await loadInbound(id);
    expect(row?.operationalText).toBe("texto operacional");
    expect(row?.payloadClearedAt).toBeNull();
    expect(row?.contentKind).toBe("AUDIO");
  });

  it("já limpo + mesmos guards → ALREADY_CLEARED", async () => {
    const id = await insertInbound({ ownerId: userA, suffix: "rep" });
    const first = await clearWhatsAppInboundOperationalPayloadForReadyNl({
      sourceInboundMessageId: id,
      expectedUserId: userA,
    });
    expect(first).toEqual({ ok: true, outcome: "cleared" });
    const second = await clearWhatsAppInboundOperationalPayloadForReadyNl({
      sourceInboundMessageId: id,
      expectedUserId: userA,
    });
    expect(second).toEqual({ ok: true, outcome: "already_cleared" });
    const row = await loadInbound(id);
    expect(row?.operationalText).toBeNull();
    expect(row?.payloadClearedAt).toBeTruthy();
  });

  it("já limpo + userId divergente → STATE_CHANGED, não ALREADY_CLEARED", async () => {
    const id = await insertInbound({ ownerId: userA, suffix: "dep" });
    expect(
      await clearWhatsAppInboundOperationalPayloadForReadyNl({
        sourceInboundMessageId: id,
        expectedUserId: userA,
      }),
    ).toEqual({ ok: true, outcome: "cleared" });
    const result = await clearWhatsAppInboundOperationalPayloadForReadyNl({
      sourceInboundMessageId: id,
      expectedUserId: userB,
    });
    expect(result).toEqual({ ok: false, code: "STATE_CHANGED" });
  });

  it("DB outage → não limpa / retry", async () => {
    const id = await insertInbound({ ownerId: userA, suffix: "db" });
    const spy = vi.spyOn(dbMod, "getDb").mockResolvedValue(null);
    const result = await clearWhatsAppInboundOperationalPayloadForReadyNl({
      sourceInboundMessageId: id,
      expectedUserId: userA,
    });
    expect(result).toEqual({ ok: false, code: "DB_UNAVAILABLE" });
    spy.mockRestore();
    const row = await loadInbound(id);
    expect(row?.operationalText).toBe("texto operacional");
    expect(row?.payloadClearedAt).toBeNull();
  });

  it("UPDATE 0 rows + reload DB_UNAVAILABLE não vira ALREADY_CLEARED nem STATE_CHANGED", async () => {
    const id = await insertInbound({ ownerId: userA, suffix: "rl" });
    await db
      .update(whatsappInboundMessages)
      .set({ processingStatus: "RECEIVED" })
      .where(eq(whatsappInboundMessages.id, id));
    const loadSpy = vi
      .spyOn(sourceMod, "loadWhatsAppInboundSourceForReadyNl")
      .mockResolvedValue({ ok: false, code: "DB_UNAVAILABLE" });
    const result = await clearWhatsAppInboundOperationalPayloadForReadyNl({
      sourceInboundMessageId: id,
      expectedUserId: userA,
    });
    expect(result).toEqual({ ok: false, code: "DB_UNAVAILABLE" });
    expect(result).not.toMatchObject({ outcome: "already_cleared" });
    expect(result).not.toMatchObject({ code: "STATE_CHANGED" });
    loadSpy.mockRestore();
    const row = await loadInbound(id);
    expect(row?.operationalText).toBe("texto operacional");
  });

  it("dois clears concorrentes → um CLEARED, outro ALREADY_CLEARED; ambos convergem", async () => {
    const id = await insertInbound({ ownerId: userA, suffix: "cc" });
    const [a, b] = await Promise.all([
      clearWhatsAppInboundOperationalPayloadForReadyNl({
        sourceInboundMessageId: id,
        expectedUserId: userA,
      }),
      clearWhatsAppInboundOperationalPayloadForReadyNl({
        sourceInboundMessageId: id,
        expectedUserId: userA,
      }),
    ]);
    const outcomes = [a, b].map((item) =>
      item.ok ? item.outcome : item.code,
    );
    expect(outcomes.sort()).toEqual(["already_cleared", "cleared"]);
    expect(a.ok && b.ok).toBe(true);
    const row = await loadInbound(id);
    expect(row?.operationalText).toBeNull();
    expect(row?.payloadClearedAt).toBeTruthy();
  });

  it("helper legado por id ainda existe e B2-C não o substitui no módulo A", async () => {
    const id = await insertInbound({
      ownerId: userA,
      suffix: "lg",
      status: "READY_FOR_TRANSCRIPTION",
    });
    const legacy = await clearWhatsAppInboundOperationalPayload(id);
    expect(legacy).toBe(true);
    const row = await loadInbound(id);
    expect(row?.operationalText).toBeNull();
  });
});
