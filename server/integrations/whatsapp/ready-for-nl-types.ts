/**
 * Resultado discriminado do consumer B2-C (READY_FOR_NL → conversa).
 *
 * Não é contrato HTTP. Caller futuro decide transporte (worker/cron/fila).
 * Não devolve 200/503.
 */
import type { SwapIntentErrorCode } from "../../natural-language/swap-intent-types";
import type { CanonicalOperationalActorFailureCode } from "../../_core/canonical-operational-actor";
import type { WhatsAppPendingStage } from "./pending-intent-types";

export type ReadyForNlDurableStage = Extract<
  WhatsAppPendingStage,
  "CLARIFICATION" | "CONFIRMATION"
>;

export type ReadyForNlInfraCode =
  | "DB_UNAVAILABLE"
  | "PERSISTENCE_FAILED"
  | "CLEANUP_FAILED"
  | "INTERNAL_FAILURE";

export type ReadyForNlBlockedCode =
  | "SOURCE_NOT_FOUND"
  | "SOURCE_NOT_READY"
  | "SOURCE_NOT_TEXT"
  | "SOURCE_TERMINAL"
  | "SOURCE_IDENTITY_MISSING"
  | "SOURCE_OPERATIONAL_PAYLOAD_UNAVAILABLE"
  | "ALREADY_OPEN"
  | "PENDING_EXPIRED"
  | "PENDING_TERMINAL"
  | "STATE_CHANGED"
  | "OWNERSHIP_MISMATCH"
  | "INVALID_PAYLOAD"
  | "NEEDS_REFORMULATION"
  | "TERMINAL_DOMAIN_CONFLICT"
  | Extract<
      CanonicalOperationalActorFailureCode,
      | "ACTOR_NOT_FOUND"
      | "ACTOR_PROFESSIONAL_NOT_FOUND"
      | "ACTOR_PROFESSIONAL_AMBIGUOUS"
      | "ACTOR_INSTITUTION_MEMBERSHIP_NOT_FOUND"
    >;

export type ProcessWhatsAppReadyForNlInboundInput = {
  sourceInboundMessageId: number;
};

export type ProcessWhatsAppReadyForNlInboundResult =
  | {
      ok: true;
      kind: "ADVANCED" | "REPLAY";
      stage: ReadyForNlDurableStage;
      pendingId: number;
    }
  | {
      ok: false;
      kind: "RETRYABLE_INFRA";
      code: ReadyForNlInfraCode;
    }
  | {
      ok: false;
      kind: "BLOCKED";
      code: ReadyForNlBlockedCode;
      nlCode?: SwapIntentErrorCode;
    };

export function isReadyForNlRetryableInfra(
  result: ProcessWhatsAppReadyForNlInboundResult,
): result is Extract<
  ProcessWhatsAppReadyForNlInboundResult,
  { ok: false; kind: "RETRYABLE_INFRA" }
> {
  return result.ok === false && result.kind === "RETRYABLE_INFRA";
}
