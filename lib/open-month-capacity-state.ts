export type OpenMonthCapacityState = "loading" | "error" | "invalid" | "ready";

export function openMonthCapacityScopeKey(
  institutionId: number | null,
  scheduleContextId: number,
): string | null {
  return institutionId == null ? null : `${institutionId}:${scheduleContextId}`;
}

export function openMonthCapacitySnapshotKey(
  scopeKey: string | null,
  dataUpdatedAt: number,
): string | null {
  if (
    scopeKey == null ||
    !Number.isFinite(dataUpdatedAt) ||
    dataUpdatedAt <= 0
  ) {
    return null;
  }
  return `${scopeKey}@${dataUpdatedAt}`;
}

export function resolveOpenMonthCapacityState(input: {
  currentSnapshotKey: string | null;
  hydratedSnapshotKey: string | null;
  querySucceeded: boolean;
  queryFetching: boolean;
  queryFailed: boolean;
  invalidCapacity: boolean;
}): OpenMonthCapacityState {
  if (input.queryFailed) return "error";
  if (
    input.currentSnapshotKey == null ||
    !input.querySucceeded ||
    input.queryFetching ||
    input.hydratedSnapshotKey !== input.currentSnapshotKey
  ) {
    return "loading";
  }
  return input.invalidCapacity ? "invalid" : "ready";
}
