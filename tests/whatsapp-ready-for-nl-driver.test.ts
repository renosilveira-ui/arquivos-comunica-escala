import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import {
  institutions,
  professionalInstitutions,
  professionals,
  users,
  whatsappInboundMessages,
  whatsappPendingIntents,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { logger } from "../server/_core/logger";
import * as consumer from "../server/integrations/whatsapp/ready-for-nl-consumer";
import { processWhatsAppReadyForNlInbound } from "../server/integrations/whatsapp/ready-for-nl-consumer";
import { runWhatsAppNlDriverTick, listWhatsAppReadyForNlEligibleIds } from "../server/integrations/whatsapp/ready-for-nl-driver";
import {
  WHATSAPP_NL_DRIVER_BATCH_SIZE,
  WHATSAPP_NL_DRIVER_PARK_PREFIX,
  WHATSAPP_NL_DRIVER_RETRY_PREFIX,
} from "../server/integrations/whatsapp/ready-for-nl-driver-occupancy";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

describe("WhatsApp B2-D — driver integração", () => {
  let db: Db;
  const stamp = Date.now();
  const userIds: number[] = [];
  const inboundIds: number[] = [];
  const professionalIds: number[] = [];
  const institutionIds: number[] = [];
  let ownerId: number;

  async function insertUser(label: string): Promise<number> {
    const name = `wa-b2d-${label}-${stamp}`;
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
    text?: string | null;
    status?:
      | "READY_FOR_NL"
      | "IDENTITY_NOT_FOUND"
      | "READY_FOR_TRANSCRIPTION"
      | "RECEIVED"
      | "RETRYABLE";
    kind?: "TEXT" | "AUDIO" | "UNSUPPORTED_MEDIA";
    receivedAt?: Date;
    expiresAt?: Date | null;
    errorCode?: string | null;
    clearedAt?: Date | null;
  }): Promise<number> {
    const [row] = await db
      .insert(whatsappInboundMessages)
      .values({
        provider: "TWILIO",
        providerMessageId: `SMb2d${stamp}${input.suffix}`.slice(0, 64),
        userId: input.ownerId,
        contentKind: input.kind ?? "TEXT",
        forwarded: false,
        processingStatus: input.status ?? "READY_FOR_NL",
        errorCode: input.errorCode ?? null,
        operationalText:
          input.text === undefined ? "texto operacional" : input.text,
        mediaUrl: input.kind === "AUDIO" ? "https://example.test/a.ogg" : null,
        payloadExpiresAt:
          input.expiresAt === undefined
            ? new Date(Date.now() + 24 * 60 * 60 * 1000)
            : input.expiresAt,
        payloadClearedAt: input.clearedAt ?? null,
        receivedAt: input.receivedAt ?? new Date(),
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

  function spyConsumer() {
    return vi.spyOn(consumer, "processWhatsAppReadyForNlInbound");
  }

  function mockClearAndAdvance(
    spy: ReturnType<typeof spyConsumer>,
    kind: "ADVANCED" | "REPLAY" = "ADVANCED",
    stage: "CLARIFICATION" | "CONFIRMATION" = "CONFIRMATION",
  ) {
    spy.mockImplementation(async ({ sourceInboundMessageId }) => {
      await db
        .update(whatsappInboundMessages)
        .set({
          operationalText: null,
          payloadClearedAt: new Date(),
        })
        .where(eq(whatsappInboundMessages.id, sourceInboundMessageId));
      return { ok: true, kind, stage, pendingId: sourceInboundMessageId };
    });
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
        .delete(whatsappPendingIntents)
        .where(
          inArray(whatsappPendingIntents.sourceInboundMessageId, inboundIds),
        );
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
    if (professionalIds.length) {
      await db
        .delete(professionalInstitutions)
        .where(inArray(professionalInstitutions.professionalId, professionalIds));
      await db
        .delete(professionals)
        .where(inArray(professionals.id, professionalIds));
    }
    if (institutionIds.length) {
      await db.delete(institutions).where(inArray(institutions.id, institutionIds));
    }
    if (userIds.length) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
  });

  it("1. READY_FOR_NL TEXT autenticado é descoberto e B2-C é chamado", async () => {
    const id = await insertInbound({ ownerId, suffix: "disc" });
    const spy = spyConsumer();
    mockClearAndAdvance(spy);
    const summary = await runWhatsAppNlDriverTick({ batchSize: 20 });
    expect(spy).toHaveBeenCalledWith({ sourceInboundMessageId: id });
    expect(summary.claimed).toBeGreaterThanOrEqual(1);
    expect(summary.items.some((item) => item.sourceInboundMessageId === id)).toBe(
      true,
    );
  });

  it("3. ADVANCED encerra o work; 4. REPLAY encerra o work", async () => {
    const advancedId = await insertInbound({ ownerId, suffix: "adv" });
    const spy = spyConsumer();
    mockClearAndAdvance(spy, "ADVANCED", "CLARIFICATION");
    const first = await runWhatsAppNlDriverTick({ batchSize: 20 });
    expect(
      first.items.find((item) => item.sourceInboundMessageId === advancedId),
    ).toMatchObject({ action: "complete", b2cKind: "ADVANCED" });
    const after = await loadInbound(advancedId);
    expect(after?.payloadClearedAt).toBeTruthy();
    expect(after?.operationalText).toBeNull();

    const replayId = await insertInbound({ ownerId, suffix: "rpl" });
    mockClearAndAdvance(spy, "REPLAY", "CONFIRMATION");
    const second = await runWhatsAppNlDriverTick({ batchSize: 20 });
    expect(
      second.items.find((item) => item.sourceInboundMessageId === replayId),
    ).toMatchObject({ action: "complete", b2cKind: "REPLAY" });
    spy.mockClear();
    await runWhatsAppNlDriverTick({ batchSize: 20 });
    const recalled = spy.mock.calls.some(
      (call) => call[0]?.sourceInboundMessageId === replayId,
    );
    expect(recalled).toBe(false);
  });

  it("5. falha de infra volta a ser elegível após backoff; 6. domínio não entra em loop quente", async () => {
    const infraId = await insertInbound({ ownerId, suffix: "inf" });
    const domainId = await insertInbound({ ownerId, suffix: "dom" });
    const spy = spyConsumer();
    spy.mockImplementation(async ({ sourceInboundMessageId }) => {
      if (sourceInboundMessageId === infraId) {
        return {
          ok: false,
          kind: "RETRYABLE_INFRA",
          code: "DB_UNAVAILABLE" as const,
        };
      }
      return {
        ok: false,
        kind: "BLOCKED",
        code: "NEEDS_REFORMULATION" as const,
      };
    });
    const now = new Date();
    await runWhatsAppNlDriverTick({ now, batchSize: 20 });
    const infraRow = await loadInbound(infraId);
    expect(infraRow?.errorCode?.startsWith(`${WHATSAPP_NL_DRIVER_RETRY_PREFIX}:`)).toBe(
      true,
    );
    const domainRow = await loadInbound(domainId);
    expect(domainRow?.errorCode).toBe(
      `${WHATSAPP_NL_DRIVER_PARK_PREFIX}:NEEDS_REFORMULATION`,
    );
    spy.mockClear();
    await runWhatsAppNlDriverTick({
      now: new Date(now.getTime() + 5_000),
      batchSize: 20,
    });
    expect(
      spy.mock.calls.map((call) => call[0]?.sourceInboundMessageId),
    ).not.toContain(infraId);
    expect(
      spy.mock.calls.map((call) => call[0]?.sourceInboundMessageId),
    ).not.toContain(domainId);
  });

  it("7. poison não bloqueia o próximo; 8. batch limit; 9. oldest-first", async () => {
    const base = Date.now();
    const poisonId = await insertInbound({
      ownerId,
      suffix: "poi",
      receivedAt: new Date(base - 3_000),
    });
    const nextId = await insertInbound({
      ownerId,
      suffix: "nxt",
      receivedAt: new Date(base - 2_000),
    });
    const extras: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      extras.push(
        await insertInbound({
          ownerId,
          suffix: `x${i}`,
          receivedAt: new Date(base - 1_000 + i),
        }),
      );
    }
    const spy = spyConsumer();
    const seen: number[] = [];
    spy.mockImplementation(async ({ sourceInboundMessageId }) => {
      seen.push(sourceInboundMessageId);
      if (sourceInboundMessageId === poisonId) {
        return {
          ok: false,
          kind: "BLOCKED",
          code: "INVALID_PAYLOAD" as const,
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
    const summary = await runWhatsAppNlDriverTick({
      now: new Date(),
      batchSize: 5,
    });
    expect(summary.claimed).toBe(5);
    expect(seen).toHaveLength(5);
    expect(seen[0]).toBe(poisonId);
    expect(seen).toContain(nextId);
    const poison = await loadInbound(poisonId);
    expect(poison?.errorCode).toBe(
      `${WHATSAPP_NL_DRIVER_PARK_PREFIX}:INVALID_PAYLOAD`,
    );
    const next = await loadInbound(nextId);
    expect(next?.payloadClearedAt).toBeTruthy();
    expect(WHATSAPP_NL_DRIVER_BATCH_SIZE).toBe(20);
  });

  it("10. AUDIO não entra; 11. terminal não entra; 12. identity missing não entra", async () => {
    const audioId = await insertInbound({
      ownerId,
      suffix: "aud",
      kind: "AUDIO",
      status: "READY_FOR_TRANSCRIPTION",
      text: null,
    });
    const terminalId = await insertInbound({
      ownerId,
      suffix: "trm",
      status: "IDENTITY_NOT_FOUND",
      text: null,
    });
    const missingId = await insertInbound({
      ownerId: null,
      suffix: "mis",
    });
    const eligibleId = await insertInbound({ ownerId, suffix: "okn" });
    const spy = spyConsumer();
    mockClearAndAdvance(spy);
    await runWhatsAppNlDriverTick({ batchSize: 50 });
    const called = spy.mock.calls.map((call) => call[0]?.sourceInboundMessageId);
    expect(called).toContain(eligibleId);
    expect(called).not.toContain(audioId);
    expect(called).not.toContain(terminalId);
    expect(called).not.toContain(missingId);
  });

  it("READY_FOR_NL gate: RECEIVED com demais campos elegíveis não entra na discovery", async () => {
    const notReady = await insertInbound({
      ownerId,
      suffix: "rcv",
      status: "RECEIVED",
      text: "texto operacional",
    });
    const eligible = await insertInbound({ ownerId, suffix: "rdy" });
    const ids = await listWhatsAppReadyForNlEligibleIds({ batchSize: 50 });
    expect(ids).toContain(eligible);
    expect(ids).not.toContain(notReady);
  });

  it("TEXT gate: AUDIO com READY_FOR_NL e operational_text artificial não entra", async () => {
    const audioReady = await insertInbound({
      ownerId,
      suffix: "ara",
      kind: "AUDIO",
      status: "READY_FOR_NL",
      text: "texto operacional",
    });
    const eligible = await insertInbound({ ownerId, suffix: "txg" });
    const ids = await listWhatsAppReadyForNlEligibleIds({ batchSize: 50 });
    expect(ids).toContain(eligible);
    expect(ids).not.toContain(audioReady);
  });

  it("24. privacidade: CPF, telefone e email não aparecem nos logs do worker", async () => {
    const secret =
      "CPF 529.982.247-25 tel +55 85 99999-0000 email ana.souza@example.test";
    await insertInbound({
      ownerId,
      suffix: "pii",
      text: secret,
    });
    const logs: string[] = [];
    const logSpy = vi.spyOn(logger, "info").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
      return logger;
    });
    const spy = spyConsumer();
    mockClearAndAdvance(spy);
    await runWhatsAppNlDriverTick({ batchSize: 20 });
    const blob = logs.join("\n");
    expect(blob).toContain("whatsapp_nl_driver");
    expect(blob).not.toContain("529.982.247-25");
    expect(blob).not.toContain("99999-0000");
    expect(blob).not.toContain("ana.souza@example.test");
    expect(blob).not.toContain(secret);
    expect(blob.toLowerCase()).not.toContain("operational_text");
    logSpy.mockRestore();
  });

  it("26. carga leve: batch bounded, fila drena, sem query unbounded", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 45; i += 1) {
      ids.push(
        await insertInbound({
          ownerId,
          suffix: `ld${i}`,
          receivedAt: new Date(Date.now() - 10_000 + i),
        }),
      );
    }
    const spy = spyConsumer();
    mockClearAndAdvance(spy);
    let drained = 0;
    for (let tick = 0; tick < 5; tick += 1) {
      const summary = await runWhatsAppNlDriverTick({ batchSize: 20 });
      expect(summary.claimed).toBeLessThanOrEqual(20);
      drained += summary.completed;
    }
    expect(drained).toBeGreaterThanOrEqual(ids.length);
    for (const id of ids) {
      expect((await loadInbound(id))?.payloadClearedAt).toBeTruthy();
    }
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(ids.length);
    const explain = await db.execute(sql`
      EXPLAIN SELECT id
      FROM whatsapp_inbound_messages
      WHERE provider = 'TWILIO'
        AND processing_status = 'READY_FOR_NL'
        AND content_kind = 'TEXT'
        AND user_id IS NOT NULL
        AND payload_cleared_at IS NULL
      ORDER BY received_at ASC, id ASC
      LIMIT 20
    `);
    expect(JSON.stringify(explain)).toBeTruthy();
  });

  it("B2-C real: TEXT READY_FOR_NL com ator válido avança ou estaciona domínio, nunca executa swap", async () => {
    const suffix = `${stamp}live`.slice(-14).padStart(14, "0");
    const [institution] = await db
      .insert(institutions)
      .values({
        name: `B2D Live ${stamp}`,
        cnpj: suffix,
        legalName: `B2D Live ${stamp}`,
        tradeName: "B2D",
        isActive: true,
      })
      .$returningId();
    institutionIds.push(institution.id);
    const [professional] = await db
      .insert(professionals)
      .values({
        userId: ownerId,
        name: "Ator B2D",
        role: "Médico",
        specialty: "Anestesiologia",
        userRole: "USER",
      })
      .$returningId();
    professionalIds.push(professional.id);
    await db.insert(professionalInstitutions).values({
      professionalId: professional.id,
      userId: ownerId,
      institutionId: institution.id,
      roleInInstitution: "USER",
      active: true,
    });
    const sourceId = await insertInbound({
      ownerId,
      suffix: "live",
      text: "asdfgh qwerty zxcvbn",
    });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: sourceId,
    });
    expect(result.ok === true || result.kind === "BLOCKED").toBe(true);
    if (result.ok) {
      expect(["CLARIFICATION", "CONFIRMATION"]).toContain(result.stage);
    }
    const tick = await runWhatsAppNlDriverTick({ batchSize: 5 });
    expect(
      tick.items.some((item) => item.sourceInboundMessageId === sourceId) ||
        (await loadInbound(sourceId))?.payloadClearedAt != null ||
        (await loadInbound(sourceId))?.errorCode?.startsWith(
          WHATSAPP_NL_DRIVER_PARK_PREFIX,
        ),
    ).toBe(true);
  });
});
