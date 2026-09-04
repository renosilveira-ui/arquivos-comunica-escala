/**
 * Matriz pura: código de erro do núcleo NL → classe conversacional B2-A.
 *
 * Uma função só. Nenhum consumer, parser ou resolver em runtime.
 * INTERNAL_FAILURE nunca deve ser persistido como erro semântico do usuário.
 *
 * CONFLICT no núcleo NL está sobrecarregado (DB indisponível e teto de
 * varredura de profissionais, ambos sem candidates). B2-A trata CONFLICT
 * como INTERNAL_FAILURE para não persistir outage nem inventar UX de lista.
 */
import type { SwapIntentError, SwapIntentErrorCode } from "../../natural-language/swap-intent-types";

export const SwapIntentConversationClasses = {
  NEEDS_CLARIFICATION: "NEEDS_CLARIFICATION",
  NEEDS_REFORMULATION: "NEEDS_REFORMULATION",
  TERMINAL_DOMAIN_CONFLICT: "TERMINAL_DOMAIN_CONFLICT",
  INTERNAL_FAILURE: "INTERNAL_FAILURE",
} as const;

export type SwapIntentConversationClass =
  (typeof SwapIntentConversationClasses)[keyof typeof SwapIntentConversationClasses];

export type SwapIntentConversationClassification = {
  class: SwapIntentConversationClass;
  candidatesExpected: boolean;
};

/**
 * Inventário fechado dos códigos atuais. `satisfies Record<SwapIntentErrorCode, _>`
 * faz typecheck falhar se o núcleo NL adicionar um código sem classificação.
 */
export const SWAP_INTENT_CONVERSATION_CLASS_BY_CODE = {
  UNSUPPORTED_INTENT: {
    class: "NEEDS_REFORMULATION",
    candidatesExpected: false,
  },
  AMBIGUOUS_INTENT: {
    class: "NEEDS_CLARIFICATION",
    candidatesExpected: false,
  },
  INVALID_DATE: {
    class: "NEEDS_REFORMULATION",
    candidatesExpected: false,
  },
  SECTOR_NOT_FOUND: {
    class: "NEEDS_REFORMULATION",
    candidatesExpected: false,
  },
  AMBIGUOUS_SECTOR: {
    class: "NEEDS_CLARIFICATION",
    candidatesExpected: true,
  },
  OWN_SHIFT_NOT_FOUND: {
    class: "NEEDS_REFORMULATION",
    candidatesExpected: false,
  },
  AMBIGUOUS_OWN_SHIFT: {
    class: "NEEDS_CLARIFICATION",
    candidatesExpected: true,
  },
  TARGET_PROFESSIONAL_NOT_FOUND: {
    class: "NEEDS_REFORMULATION",
    candidatesExpected: false,
  },
  AMBIGUOUS_TARGET_PROFESSIONAL: {
    class: "NEEDS_CLARIFICATION",
    candidatesExpected: true,
  },
  SWAP_TARGET_SHIFT_REQUIRED: {
    class: "NEEDS_CLARIFICATION",
    candidatesExpected: true,
  },
  TARGET_SHIFT_NOT_FOUND: {
    class: "NEEDS_REFORMULATION",
    candidatesExpected: false,
  },
  AMBIGUOUS_TARGET_SHIFT: {
    class: "NEEDS_CLARIFICATION",
    candidatesExpected: true,
  },
  NOT_ELIGIBLE: {
    class: "TERMINAL_DOMAIN_CONFLICT",
    candidatesExpected: false,
  },
  CONFLICT: {
    class: "INTERNAL_FAILURE",
    candidatesExpected: false,
  },
} as const satisfies Record<
  SwapIntentErrorCode,
  SwapIntentConversationClassification
>;

export const SWAP_INTENT_ERROR_CODES = Object.freeze(
  Object.keys(SWAP_INTENT_CONVERSATION_CLASS_BY_CODE) as SwapIntentErrorCode[],
);

export type SwapIntentErrorCandidateFields = Pick<
  SwapIntentError,
  "shiftCandidates" | "professionalCandidates" | "sectorCandidates"
>;

/**
 * Classifica um código NL para a conversa. `error` é opcional e não muda a
 * classe: *_NOT_FOUND não vira clarification só porque veio candidate.
 */
export function classifySwapIntentErrorForConversation(
  code: SwapIntentErrorCode,
  _error?: SwapIntentErrorCandidateFields,
): SwapIntentConversationClassification {
  const row = SWAP_INTENT_CONVERSATION_CLASS_BY_CODE[code];
  if (!row) {
    throw new Error(`UNCLASSIFIED_SWAP_INTENT_ERROR:${String(code)}`);
  }
  return {
    class: row.class,
    candidatesExpected: row.candidatesExpected,
  };
}
