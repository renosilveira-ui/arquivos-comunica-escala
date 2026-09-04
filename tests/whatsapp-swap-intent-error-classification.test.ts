import { describe, expect, it } from "vitest";
import type { SwapIntentErrorCode } from "../server/natural-language/swap-intent-types";
import {
  SWAP_INTENT_CONVERSATION_CLASS_BY_CODE,
  SWAP_INTENT_ERROR_CODES,
  classifySwapIntentErrorForConversation,
} from "../server/integrations/whatsapp/swap-intent-error-classification";

describe("classifySwapIntentErrorForConversation", () => {
  it("cobre 100% de SwapIntentErrorCode", () => {
    const codes: SwapIntentErrorCode[] = [
      "UNSUPPORTED_INTENT",
      "AMBIGUOUS_INTENT",
      "INVALID_DATE",
      "SECTOR_NOT_FOUND",
      "AMBIGUOUS_SECTOR",
      "OWN_SHIFT_NOT_FOUND",
      "AMBIGUOUS_OWN_SHIFT",
      "TARGET_PROFESSIONAL_NOT_FOUND",
      "AMBIGUOUS_TARGET_PROFESSIONAL",
      "SWAP_TARGET_SHIFT_REQUIRED",
      "TARGET_SHIFT_NOT_FOUND",
      "AMBIGUOUS_TARGET_SHIFT",
      "NOT_ELIGIBLE",
      "CONFLICT",
    ];
    expect([...SWAP_INTENT_ERROR_CODES].sort()).toEqual([...codes].sort());
    expect(
      Object.keys(SWAP_INTENT_CONVERSATION_CLASS_BY_CODE).sort(),
    ).toEqual([...codes].sort());
    for (const code of codes) {
      const result = classifySwapIntentErrorForConversation(code);
      expect(result.class).toMatch(
        /NEEDS_CLARIFICATION|NEEDS_REFORMULATION|TERMINAL_DOMAIN_CONFLICT|INTERNAL_FAILURE/,
      );
    }
  });

  it("novo code não classificado faz o teste falhar", () => {
    expect(() =>
      classifySwapIntentErrorForConversation(
        "BRAND_NEW_CODE" as SwapIntentErrorCode,
      ),
    ).toThrow(/UNCLASSIFIED_SWAP_INTENT_ERROR:BRAND_NEW_CODE/);
  });

  it("AMBIGUOUS_INTENT não espera candidates e não inventa kind", () => {
    const result = classifySwapIntentErrorForConversation("AMBIGUOUS_INTENT");
    expect(result).toEqual({
      class: "NEEDS_CLARIFICATION",
      candidatesExpected: false,
    });
  });

  it("*_NOT_FOUND não vira clarification mesmo com candidates no erro", () => {
    const notFound = [
      "SECTOR_NOT_FOUND",
      "OWN_SHIFT_NOT_FOUND",
      "TARGET_SHIFT_NOT_FOUND",
      "TARGET_PROFESSIONAL_NOT_FOUND",
    ] as const;
    for (const code of notFound) {
      const result = classifySwapIntentErrorForConversation(code, {
        shiftCandidates: [
          {
            shiftInstanceId: 1,
            assignmentId: 1,
            institutionId: 1,
            institutionName: "X",
            sectorId: 1,
            sectorName: "SR",
            label: "n",
            dayKey: "2026-09-04",
            timeRange: "19:00–07:00",
          },
        ],
      });
      expect(result.class).not.toBe("NEEDS_CLARIFICATION");
      expect(result.candidatesExpected).toBe(false);
    }
  });

  it("SWAP_TARGET_SHIFT_REQUIRED é clarification com candidates", () => {
    expect(
      classifySwapIntentErrorForConversation("SWAP_TARGET_SHIFT_REQUIRED"),
    ).toEqual({ class: "NEEDS_CLARIFICATION", candidatesExpected: true });
  });

  it("CONFLICT é INTERNAL_FAILURE e não persiste como semântica do usuário", () => {
    expect(classifySwapIntentErrorForConversation("CONFLICT")).toEqual({
      class: "INTERNAL_FAILURE",
      candidatesExpected: false,
    });
  });
});
