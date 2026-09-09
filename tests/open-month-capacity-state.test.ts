import { describe, expect, it } from "vitest";
import {
  openMonthCapacityScopeKey,
  resolveOpenMonthCapacityState,
} from "../lib/open-month-capacity-state";

describe("estado de capacidade na abertura do mês", () => {
  it("bloqueia valores hidratados por outra instituição ou escala", () => {
    const scaleA = openMonthCapacityScopeKey(10, 100);
    const tenantB = openMonthCapacityScopeKey(20, 100);
    const scaleB = openMonthCapacityScopeKey(10, 200);

    expect(
      resolveOpenMonthCapacityState({
        currentScopeKey: scaleA,
        hydratedScopeKey: scaleA,
        querySucceeded: true,
        queryFailed: false,
        invalidCapacity: false,
      }),
    ).toBe("ready");

    for (const currentScopeKey of [tenantB, scaleB]) {
      expect(
        resolveOpenMonthCapacityState({
          currentScopeKey,
          hydratedScopeKey: scaleA,
          querySucceeded: true,
          queryFailed: false,
          invalidCapacity: false,
        }),
      ).toBe("loading");
    }
  });

  it("permanece fail-closed durante erro e retry", () => {
    const scope = openMonthCapacityScopeKey(10, 100);
    expect(
      resolveOpenMonthCapacityState({
        currentScopeKey: scope,
        hydratedScopeKey: null,
        querySucceeded: false,
        queryFailed: true,
        invalidCapacity: false,
      }),
    ).toBe("error");
    expect(
      resolveOpenMonthCapacityState({
        currentScopeKey: scope,
        hydratedScopeKey: null,
        querySucceeded: false,
        queryFailed: false,
        invalidCapacity: false,
      }),
    ).toBe("loading");
    expect(
      resolveOpenMonthCapacityState({
        currentScopeKey: scope,
        hydratedScopeKey: scope,
        querySucceeded: true,
        queryFailed: false,
        invalidCapacity: true,
      }),
    ).toBe("invalid");
  });
});
