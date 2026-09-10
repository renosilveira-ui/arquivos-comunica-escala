import { TRPCError } from "@trpc/server";

export const MATERIAL_SHIFT_EDIT_PAST_MESSAGE =
  "Horário ou modalidade só podem ser alterados antes do início do turno, mantendo o novo início no futuro.";

export type MaterialShiftEditTemporalInput = {
  materialChanged: boolean;
  originalStartAt: Date;
  effectiveStartAt: Date;
  now: Date;
};

/**
 * Impede que uma edição material reescreva um turno que já iniciou ou
 * produza um novo ciclo operacional cujo início já venceu. Instantes
 * inválidos também são recusados para que novos callers falhem fechado.
 */
export function assertMaterialShiftEditIsFuture(
  input: MaterialShiftEditTemporalInput,
): void {
  if (!input.materialChanged) return;

  const originalStartMs = input.originalStartAt.getTime();
  const effectiveStartMs = input.effectiveStartAt.getTime();
  const nowMs = input.now.getTime();
  if (
    !Number.isFinite(originalStartMs) ||
    !Number.isFinite(effectiveStartMs) ||
    !Number.isFinite(nowMs) ||
    originalStartMs <= nowMs ||
    effectiveStartMs <= nowMs
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: MATERIAL_SHIFT_EDIT_PAST_MESSAGE,
    });
  }
}
