import { and, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  scheduleCapacityRules,
  scheduleContexts,
  shiftAssignmentsV2,
  shiftInstances,
} from "../drizzle/schema";
import { shiftCapacitySummary } from "../lib/shift-capacity";
import type { getDb } from "./db";
import { dayKeyBrt, weekdayOfKey } from "./local-time";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Conn = Pick<Db, "select">;
type Slot = {
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  scheduleContextId: number | null;
  startAt: Date;
  endAt: Date;
};

export function shiftSlotKey(slot: Slot): string {
  return JSON.stringify([
    slot.institutionId,
    slot.hospitalId,
    slot.sectorId,
    slot.scheduleContextId,
    slot.startAt.getTime(),
    slot.endAt.getTime(),
  ]);
}

/** Reject an ambiguous source before copying it; never discard its assignees. */
export function assertDistinctShiftSlots(
  slots: readonly (Slot & { requiredCapacity?: number | null })[],
): void {
  const seen = new Set<string>();
  const starts = new Map<string, { end: number; legacy: boolean }>();
  for (const slot of slots) {
    const key = shiftSlotKey(slot);
    if (seen.has(key))
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "A origem contém turnos duplicados no mesmo horário. Revise os turnos antes de copiar a escala.",
      });
    seen.add(key);
    const startKey = JSON.stringify([
      slot.institutionId,
      slot.hospitalId,
      slot.sectorId,
      slot.scheduleContextId,
      slot.startAt.getTime(),
    ]);
    const previous = starts.get(startKey);
    if (
      previous &&
      previous.end !== slot.endAt.getTime() &&
      (previous.legacy || slot.requiredCapacity === null)
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "A origem legada tem turnos simultâneos com durações diferentes. Use os modelos de horário para abrir o novo mês ou revise a origem.",
      });
    }
    starts.set(startKey, {
      end: slot.endAt.getTime(),
      legacy: previous?.legacy === true || slot.requiredCapacity === null,
    });
  }
}

export function hospitalClock(date: Date): string {
  return new Date(date.getTime() - 3 * 3600000).toISOString().slice(11, 19);
}

/** Context share lock serializes generation against weekly rule changes. */
export async function capacityForNewShift(
  db: Conn,
  slot: Slot,
  fallback = 1,
): Promise<number> {
  if (slot.scheduleContextId == null)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Selecione a escala para criar o turno.",
    });
  const [context] = await db
    .select({ id: scheduleContexts.id })
    .from(scheduleContexts)
    .where(
      and(
        eq(scheduleContexts.id, slot.scheduleContextId),
        eq(scheduleContexts.institutionId, slot.institutionId),
        eq(scheduleContexts.hospitalId, slot.hospitalId),
        eq(scheduleContexts.sectorId, slot.sectorId),
        eq(scheduleContexts.active, true),
      ),
    )
    .limit(1)
    .for("share");
  if (!context)
    throw new TRPCError({
      code: "CONFLICT",
      message: "A escala não está mais disponível.",
    });
  const [rule] = await db
    .select()
    .from(scheduleCapacityRules)
    .where(
      and(
        eq(scheduleCapacityRules.scheduleContextId, context.id),
        eq(scheduleCapacityRules.startTime, hospitalClock(slot.startAt)),
        eq(scheduleCapacityRules.endTime, hospitalClock(slot.endAt)),
        eq(
          scheduleCapacityRules.weekday,
          weekdayOfKey(dayKeyBrt(slot.startAt)),
        ),
      ),
    )
    .limit(1)
    .for("share");
  const capacity = rule?.requiredCapacity ?? fallback;
  shiftCapacitySummary(capacity, 0);
  return capacity;
}

/** Count every active row, including pending and hidden/ineligible assignees. */
export async function activeShiftCounts(
  db: Conn,
  ids: readonly number[],
): Promise<Map<number, number>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({
      id: shiftAssignmentsV2.shiftInstanceId,
      count: sql<number>`count(*)`,
    })
    .from(shiftAssignmentsV2)
    .where(
      and(
        inArray(shiftAssignmentsV2.shiftInstanceId, [...new Set(ids)]),
        eq(shiftAssignmentsV2.isActive, true),
      ),
    )
    .groupBy(shiftAssignmentsV2.shiftInstanceId);
  return new Map(rows.map((row) => [row.id, Number(row.count)]));
}

export async function hasShiftVacancy(
  db: Conn,
  shift: { id: number; requiredCapacity: number | null; status: string },
): Promise<boolean> {
  if (shift.requiredCapacity == null && shift.status !== "VAGO") return false;
  const counts = await activeShiftCounts(db, [shift.id]);
  return (
    shiftCapacitySummary(shift.requiredCapacity, counts.get(shift.id) ?? 0)
      .remainingCapacity > 0
  );
}

export type ShiftCapacityState = {
  requiredCapacity: number | null;
  status: string;
};

/**
 * Legacy rows predate explicit capacity. They represent exactly one place, but
 * only while the persisted shift is still VAGO. Existing inconsistent rows
 * may be reduced or otherwise repaired; no writer may use that history to add
 * another active assignment.
 */
export function assertProjectedShiftCapacity(
  shift: ShiftCapacityState,
  currentActiveCount: number,
  activeDelta = 0,
): number {
  const projected = currentActiveCount + activeDelta;
  if (projected < 0) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "O total de profissionais do turno ficou inválido.",
    });
  }

  if (shift.requiredCapacity == null) {
    if (
      activeDelta > 0 &&
      (shift.status !== "VAGO" || currentActiveCount !== 0 || projected > 1)
    ) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "Este plantão legado não está mais vago.",
      });
    }
    return projected;
  }

  if (projected > shift.requiredCapacity) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `Limite de ${shift.requiredCapacity} profissionais por turno excedido (${projected}/${shift.requiredCapacity}).`,
    });
  }
  return projected;
}

// The locked writer additionally validates assignment topology.
export async function readShiftCapacityState(
  db: Conn,
  id: number,
): Promise<ShiftCapacityState> {
  const [shift] = await db
    .select({
      requiredCapacity: shiftInstances.requiredCapacity,
      status: shiftInstances.status,
    })
    .from(shiftInstances)
    .where(eq(shiftInstances.id, id))
    .limit(1)
    .for("share");
  if (!shift)
    throw new TRPCError({ code: "CONFLICT", message: "Turno inexistente." });
  return shift;
}

export async function readShiftCapacity(db: Conn, id: number) {
  return (await readShiftCapacityState(db, id)).requiredCapacity;
}
