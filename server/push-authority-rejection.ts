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
 * Fecha a cerca de escala inativa sem matar o turno legado.
 *
 * `shift_instances.schedule_context_id` é opcional: turno anterior à
 * classificação de escalas não tem contexto e segue a política legado, como
 * `findCanonicalConfirmationAccessId` já faz. Exigir o vínculo com um join
 * obrigatório transformaria esse turno em autoridade revogada — terminal — e
 * mataria em definitivo uma notificação legítima. Quando o vínculo existe,
 * porém, ele precisa apontar para um contexto exato e ativo: contexto inativo
 * é escala aposentada (`active_sector_slot` garante um ativo por setor), e
 * notificar sobre ela é vazar rascunho.
 */
export function assertCanonicalScheduleContextBinding(
  row: {
    scheduleContextId: number | null;
    canonicalScheduleContextId: number | null;
  },
  message = "Escala do plantão não está mais ativa nesta topologia",
): void {
  if (
    row.scheduleContextId != null &&
    row.canonicalScheduleContextId == null
  ) {
    throw new PersistedPushAuthorityBindingError(message);
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
