import { describe, expect, it } from "vitest";
import {
  interpretWhatsAppContinuation,
  matchClarificationChoice,
} from "../server/integrations/whatsapp/continuation-interpreter";
import type { WhatsAppClarificationV1 } from "../server/integrations/whatsapp/pending-intent-payloads";

const ownShiftClarification: WhatsAppClarificationV1 = {
  version: 1,
  code: "AMBIGUOUS_OWN_SHIFT",
  candidates: [
    {
      shiftInstanceId: 501,
      label: "Noite SR",
      dayKey: "2026-09-07",
      timeRange: "19:00–07:00",
      sectorName: "Sala de Recuperação",
      institutionName: "Hospital A",
    },
    {
      shiftInstanceId: 777,
      label: "Manhã CC",
      dayKey: "2026-09-07",
      timeRange: "07:00–13:00",
      sectorName: "Centro Cirúrgico",
      institutionName: "Hospital A",
    },
  ],
};

describe("WhatsApp continuation interpreter", () => {
  it("CHOICE por posição 1-based usa o candidate persistido", () => {
    const result = interpretWhatsAppContinuation({
      text: "2",
      stage: "CLARIFICATION",
      clarification: ownShiftClarification,
    });
    expect(result).toMatchObject({
      category: "CHOICE",
      position: 2,
      choice: { kind: "OWN_SHIFT", shiftInstanceId: 777 },
    });
  });

  it("CHOICE por label normalizado não usa ID interno", () => {
    const result = interpretWhatsAppContinuation({
      text: "manha cc",
      stage: "CLARIFICATION",
      clarification: ownShiftClarification,
    });
    expect(result).toMatchObject({
      category: "CHOICE",
      choice: { shiftInstanceId: 777 },
    });
  });

  it("CONTINUATION_CHOICE_NEVER_INTERNAL_ID: número fora da posição não vira shiftInstanceId", () => {
    expect(
      matchClarificationChoice("777", [
        {
          kind: "OWN_SHIFT",
          shiftInstanceId: 777,
          label: "Manhã CC",
        },
        {
          kind: "OWN_SHIFT",
          shiftInstanceId: 501,
          label: "Noite SR",
        },
      ]),
    ).toBeNull();
    expect(
      interpretWhatsAppContinuation({
        text: "777",
        stage: "CLARIFICATION",
        clarification: ownShiftClarification,
      }).category,
    ).toBe("UNRESOLVED");
    expect(
      interpretWhatsAppContinuation({
        text: "123",
        stage: "CLARIFICATION",
        clarification: ownShiftClarification,
      }).category,
    ).toBe("UNRESOLVED");
  });

  it("CANCEL, AFFIRM e DENY respeitam o stage", () => {
    expect(
      interpretWhatsAppContinuation({
        text: "cancela",
        stage: "CLARIFICATION",
        clarification: ownShiftClarification,
      }).category,
    ).toBe("CANCEL");
    expect(
      interpretWhatsAppContinuation({
        text: "sim",
        stage: "CONFIRMATION",
        clarification: null,
      }).category,
    ).toBe("AFFIRM");
    expect(
      interpretWhatsAppContinuation({
        text: "nao",
        stage: "CONFIRMATION",
        clarification: null,
      }).category,
    ).toBe("DENY");
    expect(
      interpretWhatsAppContinuation({
        text: "sim",
        stage: "CLARIFICATION",
        clarification: ownShiftClarification,
      }).category,
    ).toBe("UNRESOLVED");
  });

  it("FRESH_INTENT não cancela o pending", () => {
    expect(
      interpretWhatsAppContinuation({
        text: "passar meu plantão de amanhã à noite na SR para o Joao",
        stage: "CLARIFICATION",
        clarification: ownShiftClarification,
      }).category,
    ).toBe("FRESH_INTENT");
  });
});
