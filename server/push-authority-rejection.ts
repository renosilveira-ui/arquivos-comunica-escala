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
 * A autoridade existe, mas o dado operacional ainda não foi publicado.
 * Diferente de uma revogação, esta condição pode se tornar válida sem que o
 * produtor duplique o evento: o outbox deve permanecer pendente e sem envio.
 */
export class DeferredPushAuthorityError extends Error {
  constructor(message = "Entrega aguardando publicação da escala") {
    super(message);
    this.name = "DeferredPushAuthorityError";
  }
}

export function isDeferredPushAuthorityError(
  error: unknown,
): error is DeferredPushAuthorityError {
  return error instanceof DeferredPushAuthorityError;
}

/**
 * A intenção perdeu a janela operacional antes de alcançar o provedor.
 * É terminal: publicação tardia não pode ressuscitar uma notificação de um
 * plantão que já começou, e a supressão não consome retry de transporte.
 */
export class ExpiredPushAuthorityError extends Error {
  constructor(
    readonly operationalDeadline: Date,
    readonly decisionAt: Date,
    message = "Janela operacional encerrada no início do plantão",
  ) {
    super(message);
    this.name = "ExpiredPushAuthorityError";
  }
}

export function isExpiredPushAuthorityError(
  error: unknown,
): error is ExpiredPushAuthorityError {
  return error instanceof ExpiredPushAuthorityError;
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
