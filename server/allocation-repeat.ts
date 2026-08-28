import { and, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import {
  ALLOCATION_REPEAT_RULES,
  type AllocationRepeatRule,
} from "../lib/allocation-repeat";
import { formatHospitalTime } from "../lib/hospital-time";
import { shiftAssignmentsV2, shiftInstances } from "../drizzle/schema";
import { getDb } from "./db";
import { dayKeyBrt, monthWindowBrt, weekdayOfKey, yearMonthBrt } from "./local-time";

export { ALLOCATION_REPEAT_RULES, type AllocationRepeatRule };

type RepeatDb = Pick<NonNullable<Awaited<ReturnType<typeof getDb>>>, "select">;

export type AllocationRepeatShift = {
  id: number;
  startAt: Date;
  endAt: Date;
  label: string;
};

export type RepeatCandidate = AllocationRepeatShift & {
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  scheduleContextId: number | null;
  specialty: string | null;
  status: string;
};

export function weekdayOrdinalInMonth(dayKey: string): number {
  const day = Number(dayKey.slice(8, 10));
  return Math.ceil(day / 7);
}

export function daysBetweenKeys(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const start = Date.UTC(fy, fm - 1, fd);
  const end = Date.UTC(ty, tm - 1, td);
  return Math.round((end - start) / 86_400_000);
}

export function isAllocationRepeatTargetDay(
  sourceDayKey: string,
  targetDayKey: string,
  rule: AllocationRepeatRule,
): boolean {
  const days = daysBetweenKeys(sourceDayKey, targetDayKey);
  if (days <= 0) return false;
  switch (rule) {
    case "none":
      return false;
    case "weekly":
      return days % 7 === 0;
    case "biweekly":
      return days % 14 === 0;
    case "monthly":
      return (
        sourceDayKey.slice(0, 7) !== targetDayKey.slice(0, 7) &&
        weekdayOfKey(sourceDayKey) === weekdayOfKey(targetDayKey) &&
        weekdayOrdinalInMonth(sourceDayKey) ===
          weekdayOrdinalInMonth(targetDayKey)
      );
  }
}

export function sameHospitalClock(
  left: { startAt: Date; endAt: Date },
  right: { startAt: Date; endAt: Date },
): boolean {
  return (
    formatHospitalTime(left.startAt) === formatHospitalTime(right.startAt) &&
    formatHospitalTime(left.endAt) === formatHospitalTime(right.endAt)
  );
}

export function selectRepeatTargets<T extends AllocationRepeatShift>(
  source: AllocationRepeatShift,
  candidates: readonly T[],
  rule: AllocationRepeatRule,
): T[] {
  if (rule === "none") return [];
  const sourceDay = dayKeyBrt(source.startAt);
  const sourceMonth = yearMonthBrt(source.startAt);
  return candidates
    .filter((candidate) => {
      if (candidate.id === source.id) return false;
      if (candidate.label !== source.label) return false;
      if (yearMonthBrt(candidate.startAt) !== sourceMonth) return false;
      if (!sameHospitalClock(source, candidate)) return false;
      return isAllocationRepeatTargetDay(
        sourceDay,
        dayKeyBrt(candidate.startAt),
        rule,
      );
    })
    .sort(
      (left, right) =>
        left.startAt.getTime() - right.startAt.getTime() || left.id - right.id,
    );
}

export async function listRepeatAssignmentCandidates(
  db: RepeatDb,
  source: RepeatCandidate,
  rule: AllocationRepeatRule,
): Promise<RepeatCandidate[]> {
  if (rule === "none") return [];
  const { end } = monthWindowBrt(yearMonthBrt(source.startAt));
  const contextFilter =
    source.scheduleContextId == null
      ? isNull(shiftInstances.scheduleContextId)
      : eq(shiftInstances.scheduleContextId, source.scheduleContextId);
  const rows = await db
    .select({
      id: shiftInstances.id,
      institutionId: shiftInstances.institutionId,
      hospitalId: shiftInstances.hospitalId,
      sectorId: shiftInstances.sectorId,
      scheduleContextId: shiftInstances.scheduleContextId,
      specialty: shiftInstances.specialty,
      label: shiftInstances.label,
      startAt: shiftInstances.startAt,
      endAt: shiftInstances.endAt,
      status: shiftInstances.status,
    })
    .from(shiftInstances)
    .where(
      and(
        eq(shiftInstances.institutionId, source.institutionId),
        eq(shiftInstances.hospitalId, source.hospitalId),
        eq(shiftInstances.sectorId, source.sectorId),
        eq(shiftInstances.label, source.label),
        contextFilter,
        gt(shiftInstances.startAt, source.startAt),
        lt(shiftInstances.startAt, end),
      ),
    );
  return selectRepeatTargets(source, rows, rule);
}

export async function listActiveAssignmentShiftIds(
  db: RepeatDb,
  institutionId: number,
  shiftInstanceIds: readonly number[],
): Promise<Set<number>> {
  if (shiftInstanceIds.length === 0) return new Set();
  const rows = await db
    .select({ shiftInstanceId: shiftAssignmentsV2.shiftInstanceId })
    .from(shiftAssignmentsV2)
    .where(
      and(
        eq(shiftAssignmentsV2.institutionId, institutionId),
        eq(shiftAssignmentsV2.isActive, true),
        inArray(shiftAssignmentsV2.shiftInstanceId, [...shiftInstanceIds]),
      ),
    );
  return new Set(rows.map((row) => row.shiftInstanceId));
}
