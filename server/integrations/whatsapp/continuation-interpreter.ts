/**
 * Interpretação de resposta humana a um pending OPEN em
 * CLARIFICATION | CONFIRMATION.
 *
 * Não é o parser NL genérico. Não autoriza ID interno a partir do texto.
 * "2" só mapeia para candidate[1] do conjunto persistido, se existir.
 * "123" com n<123 é UNRESOLVED — nunca shiftInstanceId=123.
 *
 * Categorias: CHOICE | CANCEL | AFFIRM | DENY | FRESH_INTENT | UNRESOLVED.
 * Só categorias válidas para o stage atual produzem mutation no apply.
 */
import { parseSwapIntent } from "../../natural-language/swap-intent-parser";
import type { SwapIntentDraft } from "../../natural-language/swap-intent-types";
import {
  normalizeWhatsAppChoiceLabel,
  type WhatsAppClarificationV1,
} from "./pending-intent-payloads";
import { WhatsAppPendingStages } from "./pending-intent-types";

export const WhatsAppContinuationCategories = {
  CHOICE: "CHOICE",
  CANCEL: "CANCEL",
  AFFIRM: "AFFIRM",
  DENY: "DENY",
  FRESH_INTENT: "FRESH_INTENT",
  UNRESOLVED: "UNRESOLVED",
} as const;
export type WhatsAppContinuationCategory =
  (typeof WhatsAppContinuationCategories)[keyof typeof WhatsAppContinuationCategories];

export type WhatsAppContinuationChoiceCandidate =
  | { kind: "OWN_SHIFT"; shiftInstanceId: number; label: string }
  | { kind: "TARGET_SHIFT"; shiftInstanceId: number; label: string }
  | { kind: "TARGET_PROFESSIONAL"; professionalId: number; label: string }
  | { kind: "SECTOR"; sectorId: number; label: string };

export type WhatsAppContinuationInterpretation =
  | {
      category: "CHOICE";
      choice: WhatsAppContinuationChoiceCandidate;
      position: number;
    }
  | { category: "CANCEL" }
  | { category: "AFFIRM" }
  | { category: "DENY" }
  | { category: "FRESH_INTENT" }
  | { category: "UNRESOLVED" };

const CANCEL_UTTERANCE =
  /^(cancela|cancelar|cancel|desisto|desistir|esquece|esquecer)$/;
const AFFIRM_UTTERANCE = /^(sim|confirmo|confirma|confirmar|ok|pode|isso)$/;
const DENY_UTTERANCE = /^(nao|nunca|recuso|recusar|nego|negar)$/;

function isSwapIntentDraft(
  value: SwapIntentDraft | { ok: false },
): value is SwapIntentDraft {
  return !("ok" in value && value.ok === false);
}

function foldUtterance(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function listClarificationChoiceCandidates(
  clarification: WhatsAppClarificationV1 | null,
): WhatsAppContinuationChoiceCandidate[] {
  if (!clarification) return [];
  if (clarification.code === "AMBIGUOUS_INTENT") return [];
  if (clarification.code === "AMBIGUOUS_OWN_SHIFT") {
    return clarification.candidates.map((candidate) => ({
      kind: "OWN_SHIFT" as const,
      shiftInstanceId: candidate.shiftInstanceId,
      label: candidate.label,
    }));
  }
  if (
    clarification.code === "AMBIGUOUS_TARGET_SHIFT" ||
    clarification.code === "SWAP_TARGET_SHIFT_REQUIRED"
  ) {
    return clarification.candidates.map((candidate) => ({
      kind: "TARGET_SHIFT" as const,
      shiftInstanceId: candidate.shiftInstanceId,
      label: candidate.label,
    }));
  }
  if (clarification.code === "AMBIGUOUS_TARGET_PROFESSIONAL") {
    return clarification.candidates.map((candidate) => ({
      kind: "TARGET_PROFESSIONAL" as const,
      professionalId: candidate.professionalId,
      label: candidate.label,
    }));
  }
  return clarification.candidates.map((candidate) => ({
    kind: "SECTOR" as const,
    sectorId: candidate.sectorId,
    label: candidate.label,
  }));
}

/**
 * CONTINUATION_CHOICE_NEVER_INTERNAL_ID
 * Posição 1-based ou label normalizado do candidate set persistido.
 * Número digitado nunca é ID interno.
 */
export function matchClarificationChoice(
  text: string,
  candidates: readonly WhatsAppContinuationChoiceCandidate[],
): { choice: WhatsAppContinuationChoiceCandidate; position: number } | null {
  if (candidates.length === 0) return null;
  const folded = foldUtterance(text);
  if (!folded) return null;

  if (/^\d+$/.test(folded)) {
    const position = Number(folded);
    if (!Number.isSafeInteger(position) || position < 1) return null;
    const choice = candidates[position - 1];
    if (!choice) return null;
    return { choice, position };
  }

  const wanted = normalizeWhatsAppChoiceLabel(text);
  if (!wanted) return null;
  const matches = candidates.filter(
    (candidate) => normalizeWhatsAppChoiceLabel(candidate.label) === wanted,
  );
  if (matches.length !== 1) return null;
  const choice = matches[0]!;
  return { choice, position: candidates.indexOf(choice) + 1 };
}

function isFreshIntent(text: string): boolean {
  try {
    const parsed = parseSwapIntent(text);
    return isSwapIntentDraft(parsed);
  } catch {
    return false;
  }
}

export function interpretWhatsAppContinuation(input: {
  text: string;
  stage: "CLARIFICATION" | "CONFIRMATION";
  clarification: WhatsAppClarificationV1 | null;
}): WhatsAppContinuationInterpretation {
  const folded = foldUtterance(input.text);
  if (!folded) return { category: "UNRESOLVED" };

  if (CANCEL_UTTERANCE.test(folded)) return { category: "CANCEL" };

  if (input.stage === WhatsAppPendingStages.CONFIRMATION) {
    if (AFFIRM_UTTERANCE.test(folded)) return { category: "AFFIRM" };
    if (DENY_UTTERANCE.test(folded)) return { category: "DENY" };
    if (isFreshIntent(input.text)) return { category: "FRESH_INTENT" };
    return { category: "UNRESOLVED" };
  }

  const matched = matchClarificationChoice(
    input.text,
    listClarificationChoiceCandidates(input.clarification),
  );
  if (matched) {
    return {
      category: "CHOICE",
      choice: matched.choice,
      position: matched.position,
    };
  }
  if (isFreshIntent(input.text)) return { category: "FRESH_INTENT" };
  return { category: "UNRESOLVED" };
}
