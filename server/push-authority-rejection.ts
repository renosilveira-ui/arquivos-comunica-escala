import { TRPCError } from "@trpc/server";
import { isCanonicalDutyConfirmationRejection } from "./confirmation-integrity";

/** Incoerência persistida que não pode se tornar válida em um retry. */
export class PersistedPushAuthorityBindingError extends TRPCError {
  constructor(message: string) {
    super({ code: "BAD_REQUEST", message });
    this.name = "PersistedPushAuthorityBindingError";
  }
}

/**
 * Somente rejeições determinísticas encerram uma entrega. Falhas de banco,
 * rede ou driver continuam retryable e nunca simulam revogação de autoridade.
 */
export function isCanonicalPushAuthorityRejection(error: unknown): boolean {
  return (
    error instanceof PersistedPushAuthorityBindingError ||
    isCanonicalDutyConfirmationRejection(error)
  );
}
