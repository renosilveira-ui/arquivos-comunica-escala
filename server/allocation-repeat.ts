import { and, eq, gt, inArray, isNull, lt } from "drizzle-orm";
import {
  ALLOCATION_REPEAT_RULES,
  clampAllocationRepeatMonths,
  type AllocationRepeatRule,
} from "../lib/allocation-repeat";
import { formatHospitalTime } from "../lib/hospital-time";
import { shiftAssignmentsV2, shiftInstances } from "../drizzle/schema";
import { getDb } from "./db";
import {
  addDaysToKey,
  dayKeyBrt,
  dayWindowBrt,
  monthWindowBrt,
  weekdayOfKey,
  yearMonthBrt,
} from "./local-time";

export { ALLOCATION_REPEAT_RULES, type AllocationRepeatRule };

type RepeatDb = Pick<NonNullable<Awaited<ReturnType<typeof getDb>>>, "select">;

const DAY_MS = 86_400_000;

export type AllocationRepeatShift = {
  id: number;
  startAt: Date;
  endAt: Date;
  label: string;
};

export type RepeatCandidate = AllocationRepeatShift & {
  requiredCapacity?: number | null;
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
  return Math.round((end - start) / DAY_MS);
}

/**
 * Mesmo dia do mês, N meses à frente. Dia que não existe no mês de destino
 * (31/12 + 2) cai no último dia daquele mês — o horizonte é uma borda, não
 * uma data de plantão.
 */
export function addMonthsToKey(dayKey: string, months: number): string {
  const [year, month, day] = dayKey.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDayOfTargetMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const safeDay = Math.min(day, lastDayOfTargetMonth);
  const yyyy = String(target.getUTCFullYear()).padStart(4, "0");
  const mm = String(target.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(safeDay).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Último dia que a repetição alcança, a partir do plantão de origem. */
export function repeatLastDayKey(sourceStartAt: Date, months: number): string {
  return addMonthsToKey(
    dayKeyBrt(sourceStartAt),
    clampAllocationRepeatMonths(months),
  );
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

/**
 * Os dias que a repetição alcança. Enumera a partir do predicado acima para
 * que gerar e filtrar nunca discordem — o horizonte máximo são ~186 dias.
 */
export function allocationRepeatTargetDayKeys(
  sourceDayKey: string,
  rule: AllocationRepeatRule,
  lastDayKey: string,
): string[] {
  if (rule === "none") return [];
  const span = daysBetweenKeys(sourceDayKey, lastDayKey);
  if (span <= 0) return [];
  const keys: string[] = [];
  for (let offset = 1; offset <= span; offset += 1) {
    const dayKey = addDaysToKey(sourceDayKey, offset);
    if (isAllocationRepeatTargetDay(sourceDayKey, dayKey, rule)) {
      keys.push(dayKey);
    }
  }
  return keys;
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

/** A janela que a vaga repetida ocuparia no dia alvo. */
export function repeatSlotAt(
  source: { startAt: Date; endAt: Date },
  targetDayKey: string,
): { startAt: Date; endAt: Date } {
  const shift =
    daysBetweenKeys(dayKeyBrt(source.startAt), targetDayKey) * DAY_MS;
  return {
    startAt: new Date(source.startAt.getTime() + shift),
    endAt: new Date(source.endAt.getTime() + shift),
  };
}

export function selectRepeatTargets<T extends AllocationRepeatShift>(
  source: AllocationRepeatShift,
  candidates: readonly T[],
  rule: AllocationRepeatRule,
  lastDayKey: string,
): T[] {
  if (rule === "none") return [];
  const sourceDay = dayKeyBrt(source.startAt);
  const allowed = new Set(
    allocationRepeatTargetDayKeys(sourceDay, rule, lastDayKey),
  );
  return candidates
    .filter((candidate) => {
      if (candidate.id === source.id) return false;
      if (candidate.label !== source.label) return false;
      if (!sameHospitalClock(source, candidate)) return false;
      return allowed.has(dayKeyBrt(candidate.startAt));
    })
    .sort(
      (left, right) =>
        left.startAt.getTime() - right.startAt.getTime() || left.id - right.id,
    );
}

/**
 * O que a repetição encontra pela frente: vagas que já existem, dias em que
 * a vaga precisa ser aberta, e dias em que outro plantão já ocupa aquela
 * janela — estes últimos bloqueiam, porque a escala do dia diz outra coisa.
 */
export type AllocationRepeatPlan = {
  lastDayKey: string;
  targets: RepeatCandidate[];
  missingDayKeys: string[];
  blockedDayKeys: string[];
};

/**
 * Até onde a repetição vai, e se ela pode abrir vaga.
 *
 * `month` é o contrato antigo, preservado para clientes que ainda não
 * mandam horizonte: vai até o fim do mês de origem e só preenche vaga que
 * já existe. Uma build antiga no aparelho do gestor não pode começar a
 * abrir plantão sozinha por causa de um deploy de servidor.
 */
export type AllocationRepeatScope =
  { kind: "month" } | { kind: "horizon"; months: number };

export function repeatScopeLastDayKey(
  sourceStartAt: Date,
  scope: AllocationRepeatScope,
): string {
  if (scope.kind === "horizon") {
    return repeatLastDayKey(sourceStartAt, scope.months);
  }
  // Fim do mês de origem, exclusivo por um dia para virar chave de dia.
  const end = monthWindowBrt(yearMonthBrt(sourceStartAt)).end;
  return dayKeyBrt(new Date(end.getTime() - DAY_MS));
}

export async function planAllocationRepeat(
  db: RepeatDb,
  source: RepeatCandidate,
  rule: AllocationRepeatRule,
  scope: AllocationRepeatScope,
): Promise<AllocationRepeatPlan> {
  const lastDayKey = repeatScopeLastDayKey(source.startAt, scope);
  if (rule === "none") {
    return { lastDayKey, targets: [], missingDayKeys: [], blockedDayKeys: [] };
  }
  const sourceDay = dayKeyBrt(source.startAt);
  const targetDayKeys = allocationRepeatTargetDayKeys(
    sourceDay,
    rule,
    lastDayKey,
  );
  if (targetDayKeys.length === 0) {
    return { lastDayKey, targets: [], missingDayKeys: [], blockedDayKeys: [] };
  }

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
      requiredCapacity: shiftInstances.requiredCapacity,
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
        contextFilter,
        gt(shiftInstances.startAt, source.startAt),
        // `end` é o início do dia seguinte: limite exclusivo.
        lt(
          shiftInstances.startAt,
          dayWindowBrt(targetDayKeys[targetDayKeys.length - 1]).end,
        ),
      ),
    );

  const targets = selectRepeatTargets(source, rows, rule, lastDayKey);
  const coveredDays = new Set(targets.map((row) => dayKeyBrt(row.startAt)));
  const missingDayKeys: string[] = [];
  const blockedDayKeys: string[] = [];
  for (const dayKey of targetDayKeys) {
    if (coveredDays.has(dayKey)) continue;
    const slot = repeatSlotAt(source, dayKey);
    // O choque é o da constraint física `uniq_shift_capacity_slot`: mesma
    // janela no mesmo contexto, e só quando os dois lados declaram
    // capacidade — com capacidade NULL o modelo legado permite que dois
    // rótulos dividam o mesmo bloco, e bloquear ali barraria escala válida.
    const collides =
      scope.kind === "horizon" &&
      source.requiredCapacity != null &&
      rows.some(
        (row) =>
          row.requiredCapacity != null &&
          row.startAt.getTime() === slot.startAt.getTime() &&
          row.endAt.getTime() === slot.endAt.getTime(),
      );
    if (collides) blockedDayKeys.push(dayKey);
    else if (scope.kind === "horizon") missingDayKeys.push(dayKey);
  }
  return { lastDayKey, targets, missingDayKeys, blockedDayKeys };
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
