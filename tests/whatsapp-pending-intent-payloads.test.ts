import { describe, expect, it } from "vitest";
import type { SwapIntentDraft } from "../server/natural-language/swap-intent-types";
import {
  assertWhatsAppParsedPayloadHasNoInternalIds,
  parseStoredClarification,
  parseStoredParsedIntent,
  parseStoredResolvedIntent,
  serializeParsedSwapIntentV1,
  serializeResolvedSwapIntentV1,
} from "../server/integrations/whatsapp/pending-intent-payloads";

const ownDate = { kind: "OFFSET" as const, days: 0, said: "hoje" };

const swapDraft: SwapIntentDraft = {
  kind: "SWAP",
  ownShift: { date: ownDate, period: "NIGHT", sectorText: "sr" },
  targetProfessional: { name: "Joao" },
  targetShift: {
    date: { kind: "WEEKDAY", weekday: 5, forceNext: false, said: "sexta" },
    period: null,
    sectorText: null,
  },
};

const cessaoDraft: SwapIntentDraft = {
  kind: "CESSAO",
  ownShift: { date: ownDate, period: "MORNING", sectorText: null },
  targetProfessional: { name: "Maria" },
};

const parsedSwap = {
  version: 1 as const,
  kind: "SWAP" as const,
  ownShift: {
    date: ownDate,
    period: "NIGHT" as const,
    sectorText: "sr",
  },
  targetProfessional: { name: "Joao" },
  targetShift: {
    date: { kind: "WEEKDAY" as const, weekday: 5, forceNext: false, said: "sexta" },
    period: null,
    sectorText: null,
  },
};

const resolvedSwap = {
  version: 1 as const,
  kind: "SWAP" as const,
  institutionId: 2,
  fromShiftInstanceId: 10,
  fromAssignmentId: 11,
  toProfessionalId: 20,
  toShiftInstanceId: 30,
  targetProfessionalName: "Joao Silva",
  ownShift: {
    label: "Plantao 1",
    sectorName: "SR",
    dayKey: "2026-09-04",
    timeRange: "19:00–07:00",
  },
  targetShift: {
    label: "Plantao 2",
    sectorName: "CC",
    dayKey: "2026-09-05",
    timeRange: "07:00–19:00",
  },
};

const resolvedCessao = {
  ...resolvedSwap,
  kind: "CESSAO" as const,
  toShiftInstanceId: null,
  targetShift: null,
};

const shiftCandidate = {
  shiftInstanceId: 44,
  label: "Noite",
  dayKey: "2026-09-06",
  timeRange: "19:00–07:00",
  sectorName: "SR",
  institutionName: "Unimed",
};

describe("WhatsApp parsed payload V1", () => {
  it("round-trip do draft SWAP e CESSAO", () => {
    const swap = serializeParsedSwapIntentV1(swapDraft);
    const cessao = serializeParsedSwapIntentV1(cessaoDraft);
    expect(swap).toEqual({ ok: true, value: parsedSwap });
    expect(cessao.ok).toBe(true);
    if (!cessao.ok) throw new Error("cessao");
    expect(cessao.value.kind).toBe("CESSAO");
    expect(cessao.value).not.toHaveProperty("targetShift");
    expect(parseStoredParsedIntent(swap.ok ? swap.value : null)).toEqual(swap);
  });

  it("parsed não aceita IDs internos", () => {
    expect(() =>
      assertWhatsAppParsedPayloadHasNoInternalIds(parsedSwap),
    ).not.toThrow();
    expect(parseStoredParsedIntent({ ...parsedSwap, userId: 1 }).ok).toBe(
      false,
    );
    expect(
      parseStoredParsedIntent({ ...parsedSwap, institutionId: 9 }).ok,
    ).toBe(false);
  });

  it("nested Id é rejeitado", () => {
    expect(
      parseStoredParsedIntent({
        ...parsedSwap,
        ownShift: { ...parsedSwap.ownShift, fooId: 1 },
      }).ok,
    ).toBe(false);
    expect(() =>
      assertWhatsAppParsedPayloadHasNoInternalIds({
        nested: { shiftInstanceId: 3 },
      }),
    ).toThrow(/PARSED_PAYLOAD_FORBIDDEN_KEY/);
  });

  it("_id é rejeitado", () => {
    expect(() =>
      assertWhatsAppParsedPayloadHasNoInternalIds({ slot: { sector_id: 1 } }),
    ).toThrow(/PARSED_PAYLOAD_FORBIDDEN_KEY/);
    expect(
      parseStoredParsedIntent({
        ...parsedSwap,
        targetProfessional: { name: "Joao", _id: "x" },
      }).ok,
    ).toBe(false);
  });

  it("campos extras são rejeitados", () => {
    expect(parseStoredParsedIntent({ ...parsedSwap, extra: true }).ok).toBe(
      false,
    );
  });

  it("version ausente é rejeitada", () => {
    const { version: _version, ...rest } = parsedSwap;
    expect(parseStoredParsedIntent(rest).ok).toBe(false);
  });

  it("version desconhecida é rejeitada", () => {
    expect(parseStoredParsedIntent({ ...parsedSwap, version: 2 }).ok).toBe(
      false,
    );
  });
});

describe("WhatsApp resolved payload V1", () => {
  it("resolved V1 válido (SWAP e CESSAO)", () => {
    expect(parseStoredResolvedIntent(resolvedSwap)).toEqual({
      ok: true,
      value: resolvedSwap,
    });
    expect(parseStoredResolvedIntent(resolvedCessao).ok).toBe(true);
    const fromResolved = serializeResolvedSwapIntentV1({
      ok: true,
      actorUserId: 1,
      actorProfessionalId: 2,
      institutionId: 2,
      institutionName: "Unimed",
      kind: "SWAP",
      ownShift: {
        shiftInstanceId: 10,
        assignmentId: 11,
        sectorId: 8,
        sectorName: "SR",
        label: "Plantao 1",
        dayKey: "2026-09-04",
        timeRange: "19:00–07:00",
        startAt: new Date("2026-09-04T22:00:00.000Z"),
      },
      targetProfessional: {
        professionalId: 20,
        userId: 9,
        name: "Joao Silva",
      },
      targetShift: {
        shiftInstanceId: 30,
        assignmentId: 31,
        sectorId: 7,
        sectorName: "CC",
        label: "Plantao 2",
        dayKey: "2026-09-05",
        timeRange: "07:00–19:00",
        startAt: new Date("2026-09-05T10:00:00.000Z"),
      },
    });
    expect(fromResolved).toEqual({ ok: true, value: resolvedSwap });
  });

  it("resolved com shape incompatível com kind é rejeitado", () => {
    expect(
      parseStoredResolvedIntent({
        ...resolvedSwap,
        kind: "CESSAO",
      }).ok,
    ).toBe(false);
    expect(
      parseStoredResolvedIntent({
        ...resolvedCessao,
        kind: "SWAP",
      }).ok,
    ).toBe(false);
    expect(
      parseStoredResolvedIntent({
        ...resolvedSwap,
        toShiftInstanceId: null,
      }).ok,
    ).toBe(false);
  });
});

describe("WhatsApp clarification payload V1", () => {
  it("clarification de cada família é válida", () => {
    const families = [
      { version: 1, code: "AMBIGUOUS_INTENT" },
      {
        version: 1,
        code: "AMBIGUOUS_SECTOR",
        candidates: [{ sectorId: 3, name: "SR" }],
      },
      {
        version: 1,
        code: "AMBIGUOUS_OWN_SHIFT",
        candidates: [shiftCandidate],
      },
      {
        version: 1,
        code: "AMBIGUOUS_TARGET_SHIFT",
        candidates: [shiftCandidate],
      },
      {
        version: 1,
        code: "SWAP_TARGET_SHIFT_REQUIRED",
        candidates: [shiftCandidate],
      },
      {
        version: 1,
        code: "AMBIGUOUS_TARGET_PROFESSIONAL",
        candidates: [{ professionalId: 5, name: "Joao" }],
      },
    ];
    for (const payload of families) {
      const parsed = parseStoredClarification(payload);
      expect(parsed.ok).toBe(true);
    }
  });

  it("clarification candidate com PII é rejeitado", () => {
    expect(
      parseStoredClarification({
        version: 1,
        code: "AMBIGUOUS_TARGET_PROFESSIONAL",
        candidates: [
          {
            professionalId: 5,
            name: "Joao",
            email: "joao@example.test",
          },
        ],
      }).ok,
    ).toBe(false);
    expect(
      parseStoredClarification({
        version: 1,
        code: "AMBIGUOUS_TARGET_PROFESSIONAL",
        candidates: [
          {
            professionalId: 5,
            name: "Joao",
            phone: "+5511999999999",
          },
        ],
      }).ok,
    ).toBe(false);
    expect(
      parseStoredClarification({
        version: 1,
        code: "AMBIGUOUS_TARGET_PROFESSIONAL",
        candidates: [
          {
            professionalId: 5,
            name: "Joao",
            cpf: "00000000000",
          },
        ],
      }).ok,
    ).toBe(false);
  });
});
