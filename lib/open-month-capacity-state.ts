export type OpenMonthCapacityState = "loading" | "error" | "invalid" | "ready";

export function openMonthCapacityScopeKey(
  institutionId: number | null,
  scheduleContextId: number,
): string | null {
  return institutionId == null ? null : `${institutionId}:${scheduleContextId}`;
}

export function resolveOpenMonthCapacityState(input: {
  currentScopeKey: string | null;
  hydratedScopeKey: string | null;
  querySucceeded: boolean;
  queryFailed: boolean;
  invalidCapacity: boolean;
}): OpenMonthCapacityState {
  if (input.queryFailed) return "error";
  if (
    input.currentScopeKey == null ||
    !input.querySucceeded ||
    input.hydratedScopeKey !== input.currentScopeKey
  ) {
    return "loading";
  }
  return input.invalidCapacity ? "invalid" : "ready";
}
