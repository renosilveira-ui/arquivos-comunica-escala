import { describe, expect, it } from "vitest";
import {
  openMonthCapacityScopeKey,
  openMonthCapacitySnapshotKey,
  resolveOpenMonthCapacityState,
} from "../lib/open-month-capacity-state";

describe("estado de capacidade na abertura do mês", () => {
  it("bloqueia valores hidratados por outra instituição ou escala", () => {
    const scaleA = openMonthCapacityScopeKey(10, 100);
    const tenantB = openMonthCapacityScopeKey(20, 100);
    const scaleB = openMonthCapacityScopeKey(10, 200);
    const scaleASnapshot = openMonthCapacitySnapshotKey(scaleA, 1);

    expect(
      resolveOpenMonthCapacityState({
        currentSnapshotKey: scaleASnapshot,
        hydratedSnapshotKey: scaleASnapshot,
        querySucceeded: true,
        queryFetchStatus: "idle",
        hasResolvedData: true,
        queryFailed: false,
        invalidCapacity: false,
      }),
    ).toBe("ready");

    for (const currentScopeKey of [tenantB, scaleB]) {
      const currentSnapshotKey = openMonthCapacitySnapshotKey(
        currentScopeKey,
        1,
      );
      expect(
        resolveOpenMonthCapacityState({
          currentSnapshotKey,
          hydratedSnapshotKey: scaleASnapshot,
          querySucceeded: true,
          queryFetchStatus: "idle",
          hasResolvedData: true,
          queryFailed: false,
          invalidCapacity: false,
        }),
      ).toBe("loading");
    }
  });

  it("permanece fail-closed durante erro e retry", () => {
    const scope = openMonthCapacityScopeKey(10, 100);
    const snapshot = openMonthCapacitySnapshotKey(scope, 1);
    expect(
      resolveOpenMonthCapacityState({
        currentSnapshotKey: snapshot,
        hydratedSnapshotKey: null,
        querySucceeded: false,
        queryFetchStatus: "idle",
        hasResolvedData: true,
        queryFailed: true,
        invalidCapacity: false,
      }),
    ).toBe("error");
    expect(
      resolveOpenMonthCapacityState({
        currentSnapshotKey: snapshot,
        hydratedSnapshotKey: null,
        querySucceeded: false,
        queryFetchStatus: "fetching",
        hasResolvedData: true,
        queryFailed: false,
        invalidCapacity: false,
      }),
    ).toBe("loading");
    expect(
      resolveOpenMonthCapacityState({
        currentSnapshotKey: snapshot,
        hydratedSnapshotKey: snapshot,
        querySucceeded: true,
        queryFetchStatus: "idle",
        hasResolvedData: true,
        queryFailed: false,
        invalidCapacity: true,
      }),
    ).toBe("invalid");
  });

  it("não reutiliza capacidade de uma resposta anterior do mesmo contexto", () => {
    const scope = openMonthCapacityScopeKey(10, 100);
    const oldSnapshot = openMonthCapacitySnapshotKey(scope, 1000);
    const currentSnapshot = openMonthCapacitySnapshotKey(scope, 2000);

    expect(oldSnapshot).not.toBe(currentSnapshot);
    expect(
      resolveOpenMonthCapacityState({
        currentSnapshotKey: currentSnapshot,
        hydratedSnapshotKey: oldSnapshot,
        querySucceeded: true,
        queryFetchStatus: "idle",
        hasResolvedData: true,
        queryFailed: false,
        invalidCapacity: false,
      }),
    ).toBe("loading");
    expect(
      resolveOpenMonthCapacityState({
        currentSnapshotKey: currentSnapshot,
        hydratedSnapshotKey: currentSnapshot,
        querySucceeded: true,
        queryFetchStatus: "fetching",
        hasResolvedData: true,
        queryFailed: false,
        invalidCapacity: false,
      }),
    ).toBe("loading");
  });
});
