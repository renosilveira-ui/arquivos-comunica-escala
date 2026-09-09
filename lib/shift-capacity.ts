/** Pending requests reserve a place until accepted or rejected. */
export const MAX_SHIFT_CAPACITY = 1000;

export function shiftCapacitySummary(
  requiredCapacity: number | null | undefined,
  activeCount: number,
  legacyStatus?: string,
) {
  if (!Number.isSafeInteger(activeCount) || activeCount < 0)
    throw new Error("Contagem de alocações inválida.");
  if (
    requiredCapacity != null &&
    (!Number.isSafeInteger(requiredCapacity) ||
      requiredCapacity < 1 ||
      requiredCapacity > MAX_SHIFT_CAPACITY)
  ) {
    throw new Error("Capacidade do turno inválida.");
  }
  // NULL belongs only to the historical model: vacancies meant an empty turn.
  const capacity = requiredCapacity ?? Math.max(1, activeCount);
  return {
    requiredCapacity: requiredCapacity ?? null,
    activeCount,
    remainingCapacity:
      requiredCapacity == null &&
      legacyStatus != null &&
      legacyStatus !== "VAGO"
        ? 0
        : Math.max(0, capacity - activeCount),
  };
}

export function shiftCapacityLabel(
  requiredCapacity: number | null | undefined,
  activeCount: number,
): string {
  const summary = shiftCapacitySummary(requiredCapacity, activeCount);
  return summary.requiredCapacity == null
    ? `${activeCount} ${activeCount === 1 ? "profissional" : "profissionais"}`
    : `${activeCount}/${summary.requiredCapacity} preenchidos`;
}

export type ShiftCapacityStatsInput = Readonly<{
  status: string;
  remainingCapacity?: number;
}>;

/** Dashboard: Total counts real shifts; vacancies count unfilled places. */
export function summarizeShiftCapacityStats(
  shifts: readonly ShiftCapacityStatsInput[],
) {
  return {
    total: shifts.length,
    vago: shifts.reduce(
      (sum, shift) =>
        sum +
        (shift.remainingCapacity ?? (shift.status === "VAGO" ? 1 : 0)),
      0,
    ),
    pendente: shifts.filter((shift) => shift.status === "PENDENTE").length,
    ocupado: shifts.filter((shift) => shift.status === "OCUPADO").length,
  };
}
