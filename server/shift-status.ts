// server/shift-status.ts — status do turno DERIVADO das alocações ativas.
//
// Antes, cada fluxo (assumir vaga, aprovar, alocar direto, trocar) setava
// shift_instances.status à mão, cada um com sua regra. Aqui há uma única
// regra: sem alocação ativa → VAGO; alguma OCUPADO → OCUPADO; senão →
// PENDENTE. Chamar sempre dentro da mesma transação que mexeu nas
// alocações, para o turno nunca ficar inconsistente com elas.

import { and, eq } from "drizzle-orm";
import { shiftAssignmentsV2, shiftInstances } from "../drizzle/schema";
import type { getDb } from "./db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
/** db ou transação (mesma interface estrutural para select/update). */
export type ShiftStatusTx = Pick<Db, "select" | "update">;

export type ShiftStatus = "VAGO" | "PENDENTE" | "OCUPADO";

export function deriveShiftStatus(activeAssignmentStatuses: string[]): ShiftStatus {
  if (activeAssignmentStatuses.length === 0) return "VAGO";
  if (activeAssignmentStatuses.some((s) => s === "OCUPADO")) return "OCUPADO";
  return "PENDENTE";
}

export async function recomputeShiftStatus(
  tx: ShiftStatusTx,
  shiftInstanceId: number,
): Promise<ShiftStatus> {
  const rows = await tx
    .select({ status: shiftAssignmentsV2.status })
    .from(shiftAssignmentsV2)
    .where(
      and(
        eq(shiftAssignmentsV2.shiftInstanceId, shiftInstanceId),
        eq(shiftAssignmentsV2.isActive, true),
      ),
    );
  const status = deriveShiftStatus(rows.map((r) => r.status));
  await tx.update(shiftInstances).set({ status }).where(eq(shiftInstances.id, shiftInstanceId));
  return status;
}
