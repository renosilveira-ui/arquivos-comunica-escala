export type OpenMonthCapacityState =
  | "loading"
  | "unresolved"
  | "error"
  | "invalid"
  | "ready";

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
  queryFetchStatus: "fetching" | "paused" | "idle" | undefined;
  hasResolvedData: boolean;
  queryFailed: boolean;
  invalidCapacity: boolean;
}): OpenMonthCapacityState {
  if (input.queryFailed) return "error";
  // isFetching=false também ocorre offline/paused. Só idle confirma que a
  // leitura acabou; cache presente durante uma pausa não é prova suficiente.
  if (input.queryFetchStatus === "fetching") return "loading";
  if (input.queryFetchStatus !== "idle") return "unresolved";
  if (
    input.currentSnapshotKey == null ||
    !input.querySucceeded ||
    !input.hasResolvedData ||
    input.hydratedSnapshotKey !== input.currentSnapshotKey
  ) {
    return "loading";
  }
  return input.invalidCapacity ? "invalid" : "ready";
}
