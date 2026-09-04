import { describe, expect, it } from "vitest";
import { WHATSAPP_PENDING_INTENT_TTL_MS } from "../server/integrations/whatsapp/pending-intent-types";
import {
  assertSemanticParsedPayload,
  pendingExpiresAtFrom,
} from "../server/integrations/whatsapp/pending-payload";

describe("WhatsApp pending parsed_payload", () => {
  it("aceita null e slots semânticos sem IDs", () => {
    expect(() => assertSemanticParsedPayload(null)).not.toThrow();
    expect(() =>
      assertSemanticParsedPayload({
        ownShiftDate: "2026-09-05",
        targetName: "Ana",
        sectorName: "UTI",
      }),
    ).not.toThrow();
  });

  it("rejeita qualquer chave que termine em Id ou _id", () => {
    for (const payload of [
      { userId: 1 },
      { institutionId: 9 },
      { shift_id: 3 },
      { nested: { assignmentId: 4 } },
      { candidates: [{ professionalId: 2 }] },
    ]) {
      expect(() => assertSemanticParsedPayload(payload)).toThrow(
        "PARSED_PAYLOAD_INVALID",
      );
    }
  });

  it("rejeita telefone, Body, signature, token e mídia", () => {
    for (const payload of [
      { phone: "+5585999100001" },
      { e164: "+5585999100001" },
      { body: "SM123" },
      { signature: "abc" },
      { authToken: "secret" },
      { token: "public" },
      { mediaUrl: "https://example.test/a.ogg" },
    ]) {
      expect(() => assertSemanticParsedPayload(payload)).toThrow(
        "PARSED_PAYLOAD_INVALID",
      );
    }
  });

  it("TTL conversacional é 15 minutos, distinto do inbound de 24h", () => {
    expect(WHATSAPP_PENDING_INTENT_TTL_MS).toBe(15 * 60 * 1000);
    const now = new Date("2026-09-04T12:00:00.000Z");
    expect(pendingExpiresAtFrom(now).toISOString()).toBe(
      "2026-09-04T12:15:00.000Z",
    );
  });
});
