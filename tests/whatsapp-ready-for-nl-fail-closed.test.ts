import { afterEach, describe, expect, it, vi } from "vitest";
import { processWhatsAppReadyForNlInbound } from "../server/integrations/whatsapp/ready-for-nl-consumer";
import * as sourceMod from "../server/integrations/whatsapp/ready-for-nl-source";
import * as pendingStore from "../server/integrations/whatsapp/pending-intent-store";
import * as actorMod from "../server/_core/canonical-operational-actor";
import * as parserMod from "../server/natural-language/swap-intent-parser";
import * as resolverMod from "../server/natural-language/swap-intent-resolver";
import * as payloadMod from "../server/integrations/whatsapp/operational-payload";
import * as cleanupMod from "../server/integrations/whatsapp/ready-for-nl-cleanup";
import type { WhatsAppPendingIntentRecord } from "../server/integrations/whatsapp/pending-intent-types";
import type { WhatsAppInboundSourceForNl } from "../server/integrations/whatsapp/ready-for-nl-source";
import type { SwapIntentDraft } from "../server/natural-language/swap-intent-types";

const SOURCE_ID = 10;
const USER_ID = 4;

function readySource(
  overrides: Partial<WhatsAppInboundSourceForNl> = {},
): WhatsAppInboundSourceForNl {
  return {
    id: SOURCE_ID,
    userId: USER_ID,
    processingStatus: "READY_FOR_NL",
    contentKind: "TEXT",
    operationalText: "passo meu plantão de amanhã à noite na SR pro Joao",
    mediaUrl: null,
    mediaMime: null,
    payloadExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    payloadClearedAt: null,
    ...overrides,
  };
}

function parseRow(
  overrides: Partial<WhatsAppPendingIntentRecord> = {},
): WhatsAppPendingIntentRecord {
  return {
    id: 7,
    userId: USER_ID,
    sourceInboundMessageId: SOURCE_ID,
    institutionId: null,
    status: "OPEN",
    stage: "PARSE",
    intentKind: null,
    parsedPayload: null,
    resolvedPayload: null,
    clarificationPayload: null,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    consumedAt: null,
    payloadClearedAt: null,
    ...overrides,
  };
}

const draft: SwapIntentDraft = {
  kind: "CESSAO",
  ownShift: {
    date: { kind: "OFFSET", days: 1, said: "amanhã" },
    period: "NIGHT",
    sectorText: "sr",
  },
  targetProfessional: { name: "Joao" },
};

function spies() {
  const load = vi.spyOn(sourceMod, "loadWhatsAppInboundSourceForReadyNl");
  const create = vi.spyOn(pendingStore, "createWhatsAppPendingIntent");
  const bySource = vi.spyOn(
    pendingStore,
    "getWhatsAppPendingIntentBySourceForUser",
  );
  const actor = vi.spyOn(actorMod, "resolveCanonicalOperationalActorForUser");
  const parse = vi.spyOn(parserMod, "parseSwapIntent");
  const resolve = vi.spyOn(resolverMod, "resolveSwapIntent");
  const advance = vi.spyOn(pendingStore, "advanceWhatsAppPendingFromParse");
  const cancelParse = vi.spyOn(pendingStore, "cancelWhatsAppPendingOpenParse");
  const clear = vi.spyOn(
    cleanupMod,
    "clearWhatsAppInboundOperationalPayloadForReadyNl",
  );
  const legacyClear = vi.spyOn(
    payloadMod,
    "clearWhatsAppInboundOperationalPayload",
  );
  return {
    load,
    create,
    bySource,
    actor,
    parse,
    resolve,
    advance,
    cancelParse,
    clear,
    legacyClear,
  };
}

describe("WhatsApp B2-C — fail-closed e estados de source/pending", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("load inbound getDb/outage → RETRYABLE_INFRA e não limpa", async () => {
    const { load, create, parse, clear } = spies();
    load.mockResolvedValue({ ok: false, code: "DB_UNAVAILABLE" });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: SOURCE_ID,
    });
    expect(result).toEqual({
      ok: false,
      kind: "RETRYABLE_INFRA",
      code: "DB_UNAVAILABLE",
    });
    expect(create).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("source inexistente não cria pending", async () => {
    const { load, create, clear } = spies();
    load.mockResolvedValue({ ok: false, code: "SOURCE_NOT_FOUND" });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: SOURCE_ID,
    });
    expect(result).toEqual({
      ok: false,
      kind: "BLOCKED",
      code: "SOURCE_NOT_FOUND",
    });
    expect(create).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("source não READY_FOR_NL não processa", async () => {
    const { load, create, clear } = spies();
    load.mockResolvedValue({
      ok: true,
      source: readySource({ processingStatus: "RECEIVED" }),
    });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: SOURCE_ID,
    });
    expect(result).toEqual({
      ok: false,
      kind: "BLOCKED",
      code: "SOURCE_NOT_READY",
    });
    expect(create).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("TEXT com media_url/media_mime não entra no consumer NL", async () => {
    const { load, create, parse, clear } = spies();
    load.mockResolvedValue({
      ok: true,
      source: readySource({
        mediaUrl: "https://api.twilio.com/audio",
      }),
    });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: SOURCE_ID,
    });
    expect(result).toEqual({
      ok: false,
      kind: "BLOCKED",
      code: "SOURCE_NOT_TEXT",
    });
    expect(create).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("AUDIO / READY_FOR_TRANSCRIPTION não entra", async () => {
    const { load, create, parse, clear } = spies();
    load.mockResolvedValue({
      ok: true,
      source: readySource({
        processingStatus: "READY_FOR_TRANSCRIPTION",
        contentKind: "AUDIO",
        operationalText: null,
        mediaUrl: "https://api.twilio.com/audio",
      }),
    });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: SOURCE_ID,
    });
    expect(result).toEqual({
      ok: false,
      kind: "BLOCKED",
      code: "SOURCE_NOT_TEXT",
    });
    expect(create).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("source terminal não cria pending", async () => {
    const { load, create, clear } = spies();
    for (const status of [
      "IDENTITY_NOT_FOUND",
      "IDENTITY_CONFLICT",
      "UNSUPPORTED",
    ] as const) {
      load.mockResolvedValueOnce({
        ok: true,
        source: readySource({ processingStatus: status, userId: null }),
      });
      const result = await processWhatsAppReadyForNlInbound({
        sourceInboundMessageId: SOURCE_ID,
      });
      expect(result).toEqual({
        ok: false,
        kind: "BLOCKED",
        code: "SOURCE_TERMINAL",
      });
    }
    expect(create).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("READY_FOR_NL sem userId não processa", async () => {
    const { load, create, clear } = spies();
    load.mockResolvedValue({
      ok: true,
      source: readySource({ userId: null }),
    });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: SOURCE_ID,
    });
    expect(result).toEqual({
      ok: false,
      kind: "BLOCKED",
      code: "SOURCE_IDENTITY_MISSING",
    });
    expect(create).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("operational_text null em READY_FOR_NL é inconsistência, não mensagem vazia", async () => {
    const { load, create, bySource, parse, clear } = spies();
    load.mockResolvedValue({
      ok: true,
      source: readySource({ operationalText: null }),
    });
    bySource.mockResolvedValue({ ok: true, row: null });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: SOURCE_ID,
    });
    expect(result).toEqual({
      ok: false,
      kind: "BLOCKED",
      code: "SOURCE_OPERATIONAL_PAYLOAD_UNAVAILABLE",
    });
    expect(create).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("payload inbound expirado não inventa texto vazio", async () => {
    const { load, create, bySource, parse, clear } = spies();
    load.mockResolvedValue({
      ok: true,
      source: readySource({
        payloadExpiresAt: new Date(Date.now() - 1000),
      }),
    });
    bySource.mockResolvedValue({ ok: true, row: null });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: SOURCE_ID,
    });
    expect(result).toEqual({
      ok: false,
      kind: "BLOCKED",
      code: "SOURCE_OPERATIONAL_PAYLOAD_UNAVAILABLE",
    });
    expect(create).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("create B1 DB_UNAVAILABLE não limpa inbound", async () => {
    const { load, create, parse, clear } = spies();
    load.mockResolvedValue({ ok: true, source: readySource() });
    create.mockResolvedValue({ ok: false, code: "DB_UNAVAILABLE" });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: SOURCE_ID,
    });
    expect(result).toEqual({
      ok: false,
      kind: "RETRYABLE_INFRA",
      code: "DB_UNAVAILABLE",
    });
    expect(parse).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("actor DB_UNAVAILABLE e PERSISTENCE_FAILED são retry, sem parser nem clear", async () => {
    const { load, create, actor, parse, clear } = spies();
    load.mockResolvedValue({ ok: true, source: readySource() });
    create.mockResolvedValue({
      ok: true,
      outcome: "created",
      row: parseRow(),
    });
    actor.mockResolvedValue({ ok: false, code: "DB_UNAVAILABLE" });
    expect(
      await processWhatsAppReadyForNlInbound({
        sourceInboundMessageId: SOURCE_ID,
      }),
    ).toEqual({
      ok: false,
      kind: "RETRYABLE_INFRA",
      code: "DB_UNAVAILABLE",
    });
    actor.mockResolvedValue({ ok: false, code: "PERSISTENCE_FAILED" });
    expect(
      await processWhatsAppReadyForNlInbound({
        sourceInboundMessageId: SOURCE_ID,
      }),
    ).toEqual({
      ok: false,
      kind: "RETRYABLE_INFRA",
      code: "PERSISTENCE_FAILED",
    });
    expect(parse).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("actor de domínio bloqueia sem inventar clarification nem limpar", async () => {
    const { load, create, actor, parse, advance, clear } = spies();
    load.mockResolvedValue({ ok: true, source: readySource() });
    create.mockResolvedValue({
      ok: true,
      outcome: "created",
      row: parseRow(),
    });
    actor.mockResolvedValue({
      ok: false,
      code: "ACTOR_PROFESSIONAL_NOT_FOUND",
    });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: SOURCE_ID,
    });
    expect(result).toEqual({
      ok: false,
      kind: "BLOCKED",
      code: "ACTOR_PROFESSIONAL_NOT_FOUND",
    });
    expect(parse).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("parser throw e resolver CONFLICT são INTERNAL_FAILURE retryable", async () => {
    const { load, create, actor, parse, resolve, advance, clear } = spies();
    load.mockResolvedValue({ ok: true, source: readySource() });
    create.mockResolvedValue({
      ok: true,
      outcome: "created",
      row: parseRow(),
    });
    actor.mockResolvedValue({
      ok: true,
      actor: { userId: USER_ID, professionalId: 8, institutionIds: [1, 2] },
    });
    parse.mockImplementation(() => {
      throw new Error("parser boom");
    });
    expect(
      await processWhatsAppReadyForNlInbound({
        sourceInboundMessageId: SOURCE_ID,
      }),
    ).toEqual({
      ok: false,
      kind: "RETRYABLE_INFRA",
      code: "INTERNAL_FAILURE",
    });

    parse.mockImplementation(() => draft);
    resolve.mockResolvedValue({
      ok: false,
      code: "CONFLICT",
      message: "Banco de dados indisponível.",
    });
    expect(
      await processWhatsAppReadyForNlInbound({
        sourceInboundMessageId: SOURCE_ID,
      }),
    ).toEqual({
      ok: false,
      kind: "RETRYABLE_INFRA",
      code: "INTERNAL_FAILURE",
    });
    expect(advance).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("advance DB_UNAVAILABLE não limpa material", async () => {
    const { load, create, actor, parse, resolve, advance, clear } = spies();
    load.mockResolvedValue({ ok: true, source: readySource() });
    create.mockResolvedValue({
      ok: true,
      outcome: "created",
      row: parseRow(),
    });
    actor.mockResolvedValue({
      ok: true,
      actor: { userId: USER_ID, professionalId: 8, institutionIds: [1] },
    });
    parse.mockReturnValue(draft);
    resolve.mockResolvedValue({
      ok: true,
      kind: "CESSAO",
      actorUserId: USER_ID,
      actorProfessionalId: 8,
      institutionId: 1,
      institutionName: "Unimed",
      ownShift: {
        shiftInstanceId: 10,
        assignmentId: 11,
        sectorId: 3,
        sectorName: "SR",
        label: "Noite",
        dayKey: "2026-09-10",
        timeRange: "19:00–07:00",
        startAt: new Date("2026-09-10T22:00:00Z"),
      },
      targetProfessional: {
        professionalId: 20,
        userId: 21,
        name: "Joao",
      },
      targetShift: null,
    });
    advance.mockResolvedValue({ ok: false, code: "DB_UNAVAILABLE" });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: SOURCE_ID,
    });
    expect(result).toEqual({
      ok: false,
      kind: "RETRYABLE_INFRA",
      code: "DB_UNAVAILABLE",
    });
    expect(clear).not.toHaveBeenCalled();
  });

  it("clear falha após advance → PERSISTENCE_FAILED retryable, pending preservado", async () => {
    const { load, create, actor, parse, resolve, advance, clear, legacyClear } =
      spies();
    const confirmation = parseRow({
      stage: "CONFIRMATION",
      intentKind: "CESSAO",
      institutionId: 1,
      parsedPayload: {
        version: 1,
        kind: "CESSAO",
        ownShift: {
          date: { kind: "OFFSET", days: 1, said: "amanhã" },
          period: "NIGHT",
          sectorText: "sr",
        },
        targetProfessional: { name: "Joao" },
      },
      resolvedPayload: {
        version: 1,
        kind: "CESSAO",
        institutionId: 1,
        fromShiftInstanceId: 10,
        fromAssignmentId: 11,
        toProfessionalId: 20,
        toShiftInstanceId: null,
        targetProfessionalName: "Joao",
        ownShift: {
          label: "Noite",
          sectorName: "SR",
          dayKey: "2026-09-10",
          timeRange: "19:00–07:00",
        },
        targetShift: null,
      },
      clarificationPayload: null,
    });
    load.mockResolvedValue({ ok: true, source: readySource() });
    create.mockResolvedValue({
      ok: true,
      outcome: "created",
      row: parseRow(),
    });
    actor.mockResolvedValue({
      ok: true,
      actor: { userId: USER_ID, professionalId: 8, institutionIds: [1] },
    });
    parse.mockReturnValue(draft);
    resolve.mockResolvedValue({
      ok: true,
      kind: "CESSAO",
      actorUserId: USER_ID,
      actorProfessionalId: 8,
      institutionId: 1,
      institutionName: "Unimed",
      ownShift: {
        shiftInstanceId: 10,
        assignmentId: 11,
        sectorId: 3,
        sectorName: "SR",
        label: "Noite",
        dayKey: "2026-09-10",
        timeRange: "19:00–07:00",
        startAt: new Date("2026-09-10T22:00:00Z"),
      },
      targetProfessional: {
        professionalId: 20,
        userId: 21,
        name: "Joao",
      },
      targetShift: null,
    });
    advance.mockResolvedValue({
      ok: true,
      outcome: "advanced",
      row: confirmation,
    });
    clear.mockResolvedValue({ ok: false, code: "PERSISTENCE_FAILED" });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: SOURCE_ID,
    });
    expect(result).toEqual({
      ok: false,
      kind: "RETRYABLE_INFRA",
      code: "PERSISTENCE_FAILED",
    });
    expect(advance).toHaveBeenCalledTimes(1);
    expect(legacyClear).not.toHaveBeenCalled();
  });

  it("already_open de outro source não apaga o texto do novo inbound", async () => {
    const { load, create, parse, clear } = spies();
    load.mockResolvedValue({ ok: true, source: readySource() });
    create.mockResolvedValue({
      ok: true,
      outcome: "already_open",
      row: parseRow({ sourceInboundMessageId: 99 }),
    });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: SOURCE_ID,
    });
    expect(result).toEqual({
      ok: false,
      kind: "BLOCKED",
      code: "ALREADY_OPEN",
    });
    expect(parse).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("pending expirado/cancelado/consumido não ressuscita", async () => {
    const { load, create, parse, advance, clear } = spies();
    load.mockResolvedValue({ ok: true, source: readySource() });
    create.mockResolvedValueOnce({
      ok: true,
      outcome: "already_terminal",
      row: parseRow({ status: "EXPIRED" }),
    });
    expect(
      await processWhatsAppReadyForNlInbound({
        sourceInboundMessageId: SOURCE_ID,
      }),
    ).toEqual({ ok: false, kind: "BLOCKED", code: "PENDING_EXPIRED" });

    create.mockResolvedValueOnce({
      ok: true,
      outcome: "already_terminal",
      row: parseRow({ status: "CANCELLED" }),
    });
    expect(
      await processWhatsAppReadyForNlInbound({
        sourceInboundMessageId: SOURCE_ID,
      }),
    ).toEqual({ ok: false, kind: "BLOCKED", code: "PENDING_TERMINAL" });

    create.mockResolvedValueOnce({
      ok: true,
      outcome: "already_terminal",
      row: parseRow({ status: "CONSUMED" }),
    });
    expect(
      await processWhatsAppReadyForNlInbound({
        sourceInboundMessageId: SOURCE_ID,
      }),
    ).toEqual({ ok: false, kind: "BLOCKED", code: "PENDING_TERMINAL" });
    expect(parse).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("pending já CONFIRMATION com payload ainda presente só faz cleanup", async () => {
    const { load, create, parse, resolve, advance, clear, legacyClear } =
      spies();
    const confirmation = parseRow({
      stage: "CONFIRMATION",
      intentKind: "CESSAO",
      institutionId: 1,
      parsedPayload: {
        version: 1,
        kind: "CESSAO",
        ownShift: {
          date: { kind: "OFFSET", days: 1, said: "amanhã" },
          period: "NIGHT",
          sectorText: "sr",
        },
        targetProfessional: { name: "Joao" },
      },
      resolvedPayload: {
        version: 1,
        kind: "CESSAO",
        institutionId: 1,
        fromShiftInstanceId: 10,
        fromAssignmentId: 11,
        toProfessionalId: 20,
        toShiftInstanceId: null,
        targetProfessionalName: "Joao",
        ownShift: {
          label: "Noite",
          sectorName: "SR",
          dayKey: "2026-09-10",
          timeRange: "19:00–07:00",
        },
        targetShift: null,
      },
    });
    load.mockResolvedValue({ ok: true, source: readySource() });
    create.mockResolvedValue({
      ok: true,
      outcome: "replay",
      row: confirmation,
    });
    clear.mockResolvedValue({ ok: true, outcome: "cleared" });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: SOURCE_ID,
    });
    expect(result).toEqual({
      ok: true,
      kind: "REPLAY",
      stage: "CONFIRMATION",
      pendingId: 7,
    });
    expect(parse).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(advance).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledWith({
      sourceInboundMessageId: SOURCE_ID,
      expectedUserId: USER_ID,
    });
    expect(legacyClear).not.toHaveBeenCalled();
  });

  it("ALREADY_CLEARED do compare-and-clear é replay de sucesso", async () => {
    const { load, create, parse, clear, legacyClear } = spies();
    load.mockResolvedValue({ ok: true, source: readySource() });
    create.mockResolvedValue({
      ok: true,
      outcome: "replay",
      row: parseRow({
        stage: "CONFIRMATION",
        intentKind: "CESSAO",
        institutionId: 1,
        parsedPayload: {
          version: 1,
          kind: "CESSAO",
          ownShift: {
            date: { kind: "OFFSET", days: 1, said: "amanhã" },
            period: "NIGHT",
            sectorText: "sr",
          },
          targetProfessional: { name: "Joao" },
        },
        resolvedPayload: {
          version: 1,
          kind: "CESSAO",
          institutionId: 1,
          fromShiftInstanceId: 10,
          fromAssignmentId: 11,
          toProfessionalId: 20,
          toShiftInstanceId: null,
          targetProfessionalName: "Joao",
          ownShift: {
            label: "Noite",
            sectorName: "SR",
            dayKey: "2026-09-10",
            timeRange: "19:00–07:00",
          },
          targetShift: null,
        },
      }),
    });
    clear.mockResolvedValue({ ok: true, outcome: "already_cleared" });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: SOURCE_ID,
    });
    expect(result).toEqual({
      ok: true,
      kind: "REPLAY",
      stage: "CONFIRMATION",
      pendingId: 7,
    });
    expect(parse).not.toHaveBeenCalled();
    expect(legacyClear).not.toHaveBeenCalled();
  });

  it("STATE_CHANGED do compare-and-clear bloqueia sem retry opaco", async () => {
    const { load, create, parse, clear, legacyClear } = spies();
    load.mockResolvedValue({ ok: true, source: readySource() });
    create.mockResolvedValue({
      ok: true,
      outcome: "replay",
      row: parseRow({
        stage: "CLARIFICATION",
        clarificationPayload: { version: 1, code: "AMBIGUOUS_INTENT" },
      }),
    });
    clear.mockResolvedValue({ ok: false, code: "STATE_CHANGED" });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: SOURCE_ID,
    });
    expect(result).toEqual({
      ok: false,
      kind: "BLOCKED",
      code: "STATE_CHANGED",
    });
    expect(parse).not.toHaveBeenCalled();
    expect(legacyClear).not.toHaveBeenCalled();
  });

  it("DB_UNAVAILABLE do compare-and-clear é RETRYABLE_INFRA", async () => {
    const { load, create, parse, clear, legacyClear } = spies();
    load.mockResolvedValue({ ok: true, source: readySource() });
    create.mockResolvedValue({
      ok: true,
      outcome: "replay",
      row: parseRow({
        stage: "CLARIFICATION",
        clarificationPayload: { version: 1, code: "AMBIGUOUS_INTENT" },
      }),
    });
    clear.mockResolvedValue({ ok: false, code: "DB_UNAVAILABLE" });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: SOURCE_ID,
    });
    expect(result).toEqual({
      ok: false,
      kind: "RETRYABLE_INFRA",
      code: "DB_UNAVAILABLE",
    });
    expect(parse).not.toHaveBeenCalled();
    expect(legacyClear).not.toHaveBeenCalled();
  });

  it("NL reformulation/not found/domain conflict usam o classificador B2-A e não persistem", async () => {
    const { load, create, actor, parse, resolve, advance, cancelParse, clear } =
      spies();
    load.mockResolvedValue({ ok: true, source: readySource() });
    create.mockResolvedValue({
      ok: true,
      outcome: "created",
      row: parseRow(),
    });
    actor.mockResolvedValue({
      ok: true,
      actor: { userId: USER_ID, professionalId: 8, institutionIds: [1] },
    });
    parse.mockReturnValue(draft);
    resolve.mockResolvedValue({
      ok: false,
      code: "OWN_SHIFT_NOT_FOUND",
      message: "Não encontrei seu plantão.",
    });
    cancelParse.mockResolvedValue({
      ok: true,
      outcome: "cancelled",
      row: parseRow({ status: "CANCELLED", payloadClearedAt: new Date() }),
    });
    expect(
      await processWhatsAppReadyForNlInbound({
        sourceInboundMessageId: SOURCE_ID,
      }),
    ).toEqual({
      ok: false,
      kind: "BLOCKED",
      code: "NEEDS_REFORMULATION",
      nlCode: "OWN_SHIFT_NOT_FOUND",
    });
    expect(cancelParse).toHaveBeenCalledWith({
      pendingId: 7,
      userId: USER_ID,
      expectedSourceInboundMessageId: SOURCE_ID,
    });

    resolve.mockResolvedValue({
      ok: false,
      code: "NOT_ELIGIBLE",
      message: "Sem vínculo.",
    });
    cancelParse.mockClear();
    expect(
      await processWhatsAppReadyForNlInbound({
        sourceInboundMessageId: SOURCE_ID,
      }),
    ).toEqual({
      ok: false,
      kind: "BLOCKED",
      code: "TERMINAL_DOMAIN_CONFLICT",
      nlCode: "NOT_ELIGIBLE",
    });
    expect(advance).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(cancelParse).not.toHaveBeenCalled();
  });

  it("texto em branco não chama parser", async () => {
    const { load, create, actor, parse, cancelParse, clear } = spies();
    load.mockResolvedValue({
      ok: true,
      source: readySource({ operationalText: "   " }),
    });
    create.mockResolvedValue({
      ok: true,
      outcome: "created",
      row: parseRow(),
    });
    cancelParse.mockResolvedValue({
      ok: true,
      outcome: "cancelled",
      row: parseRow({ status: "CANCELLED", payloadClearedAt: new Date() }),
    });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: SOURCE_ID,
    });
    expect(result).toEqual({
      ok: false,
      kind: "BLOCKED",
      code: "NEEDS_REFORMULATION",
      nlCode: "UNSUPPORTED_INTENT",
    });
    expect(actor).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(cancelParse).toHaveBeenCalledWith({
      pendingId: 7,
      userId: USER_ID,
      expectedSourceInboundMessageId: SOURCE_ID,
    });
  });

  it("cancel PARSE indisponível não finge slot liberado nem limpa inbound", async () => {
    const { load, create, actor, parse, resolve, cancelParse, clear } = spies();
    load.mockResolvedValue({ ok: true, source: readySource() });
    create.mockResolvedValue({
      ok: true,
      outcome: "created",
      row: parseRow(),
    });
    actor.mockResolvedValue({
      ok: true,
      actor: { userId: USER_ID, professionalId: 8, institutionIds: [1] },
    });
    parse.mockReturnValue(draft);
    resolve.mockResolvedValue({
      ok: false,
      code: "OWN_SHIFT_NOT_FOUND",
      message: "Não encontrei seu plantão.",
    });
    cancelParse.mockResolvedValue({ ok: false, code: "DB_UNAVAILABLE" });
    expect(
      await processWhatsAppReadyForNlInbound({
        sourceInboundMessageId: SOURCE_ID,
      }),
    ).toEqual({
      ok: false,
      kind: "RETRYABLE_INFRA",
      code: "DB_UNAVAILABLE",
    });
    expect(clear).not.toHaveBeenCalled();

    cancelParse.mockResolvedValue({
      ok: false,
      code: "STATE_CHANGED",
      row: parseRow({ stage: "CONFIRMATION" }),
    });
    expect(
      await processWhatsAppReadyForNlInbound({
        sourceInboundMessageId: SOURCE_ID,
      }),
    ).toEqual({
      ok: false,
      kind: "BLOCKED",
      code: "STATE_CHANGED",
    });
    expect(clear).not.toHaveBeenCalled();
  });

  it("NEEDS_CLARIFICATION avança e não cancela PARSE", async () => {
    const { load, create, parse, advance, cancelParse, clear } = spies();
    load.mockResolvedValue({ ok: true, source: readySource() });
    create.mockResolvedValue({
      ok: true,
      outcome: "created",
      row: parseRow(),
    });
    parse.mockReturnValue({
      ok: false,
      code: "AMBIGUOUS_INTENT",
      message: "Não entendi se é troca ou cessão.",
    });
    advance.mockResolvedValue({
      ok: true,
      outcome: "advanced",
      row: parseRow({
        stage: "CLARIFICATION",
        clarificationPayload: { version: 1, code: "AMBIGUOUS_INTENT" },
      }),
    });
    clear.mockResolvedValue({ ok: true, outcome: "cleared" });
    const result = await processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: SOURCE_ID,
    });
    expect(result).toMatchObject({
      ok: true,
      kind: "ADVANCED",
      stage: "CLARIFICATION",
    });
    expect(advance).toHaveBeenCalledTimes(1);
    expect(cancelParse).not.toHaveBeenCalled();
  });

  it("cancel PARSE already_terminal ainda devolve NEEDS_REFORMULATION", async () => {
    const { load, create, actor, parse, resolve, cancelParse, clear } = spies();
    load.mockResolvedValue({ ok: true, source: readySource() });
    create.mockResolvedValue({
      ok: true,
      outcome: "created",
      row: parseRow(),
    });
    actor.mockResolvedValue({
      ok: true,
      actor: { userId: USER_ID, professionalId: 8, institutionIds: [1] },
    });
    parse.mockReturnValue(draft);
    resolve.mockResolvedValue({
      ok: false,
      code: "OWN_SHIFT_NOT_FOUND",
      message: "Não encontrei seu plantão.",
    });
    cancelParse.mockResolvedValue({
      ok: true,
      outcome: "already_terminal",
      row: parseRow({ status: "EXPIRED", payloadClearedAt: new Date() }),
    });
    expect(
      await processWhatsAppReadyForNlInbound({
        sourceInboundMessageId: SOURCE_ID,
      }),
    ).toEqual({
      ok: false,
      kind: "BLOCKED",
      code: "NEEDS_REFORMULATION",
      nlCode: "OWN_SHIFT_NOT_FOUND",
    });
    expect(clear).not.toHaveBeenCalled();
  });

  it("cancel PARSE NOT_FOUND não finge slot liberado nem limpa inbound", async () => {
    const { load, create, actor, parse, resolve, cancelParse, clear } = spies();
    load.mockResolvedValue({ ok: true, source: readySource() });
    create.mockResolvedValue({
      ok: true,
      outcome: "created",
      row: parseRow(),
    });
    actor.mockResolvedValue({
      ok: true,
      actor: { userId: USER_ID, professionalId: 8, institutionIds: [1] },
    });
    parse.mockReturnValue(draft);
    resolve.mockResolvedValue({
      ok: false,
      code: "OWN_SHIFT_NOT_FOUND",
      message: "Não encontrei seu plantão.",
    });
    cancelParse.mockResolvedValue({ ok: false, code: "NOT_FOUND" });
    expect(
      await processWhatsAppReadyForNlInbound({
        sourceInboundMessageId: SOURCE_ID,
      }),
    ).toEqual({
      ok: false,
      kind: "RETRYABLE_INFRA",
      code: "PERSISTENCE_FAILED",
    });
    expect(clear).not.toHaveBeenCalled();
  });
});
