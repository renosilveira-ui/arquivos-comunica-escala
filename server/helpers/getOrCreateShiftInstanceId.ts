import { and, eq, sql } from "drizzle-orm";
import { shiftInstances } from "../../drizzle/schema";
import { capacityForNewShift } from "../shift-capacity";
import { shiftCapacitySummary } from "../../lib/shift-capacity";
import type { AssignmentWriteTx } from "../shift-validations-v2";

export const GET_OR_CREATE_SHIFT_VERSION = "2026-09-09-capacity-slot";
type GetOrCreateShiftParams = {
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  scheduleContextId: number;
  startAt: Date;
  endAt: Date;
  label: string;
  createdBy: number;
  requiredCapacity?: number;
};

/** Importers call once per real time block, then allocate all its professionals. */
export async function getOrCreateShiftInstanceId(
  tx: AssignmentWriteTx,
  p: GetOrCreateShiftParams,
): Promise<number> {
  if (
    !Number.isSafeInteger(p.scheduleContextId) ||
    p.scheduleContextId <= 0 ||
    !Number.isFinite(p.startAt.getTime()) ||
    !Number.isFinite(p.endAt.getTime()) ||
    p.endAt <= p.startAt
  )
    throw new Error("Escala ou intervalo de turno inválido.");
  const configured = await capacityForNewShift(tx, p);
  const requiredCapacity = p.requiredCapacity ?? configured;
  shiftCapacitySummary(requiredCapacity, 0);
  const find = (currentRead = false) => {
    const query = tx
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.institutionId, p.institutionId),
          eq(shiftInstances.hospitalId, p.hospitalId),
          eq(shiftInstances.sectorId, p.sectorId),
          eq(shiftInstances.scheduleContextId, p.scheduleContextId),
          eq(shiftInstances.startAt, p.startAt),
          eq(shiftInstances.endAt, p.endAt),
        ),
      )
      .limit(2);
    return currentRead ? query.for("share") : query;
  };
  const existing = await find();
  if (existing.length > 1)
    throw new Error("Turnos legados duplicados: importação cancelada.");
  if (existing.length) return existing[0].id;
  await tx
    .insert(shiftInstances)
    .values({ ...p, requiredCapacity, status: "VAGO" })
    .onDuplicateKeyUpdate({ set: { id: sql`id` } });
  const rows = await find(true);
  if (rows.length !== 1)
    throw new Error("Não foi possível identificar um único turno.");
  return rows[0].id;
}
