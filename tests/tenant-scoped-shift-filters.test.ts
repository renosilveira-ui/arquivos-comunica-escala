import { describe, expect, it } from "vitest";
import {
  createNeutralShiftFilterValues,
  resolveTenantScopedShiftFilters,
  type TenantScopedShiftFiltersState,
} from "../hooks/use-tenant-scoped-shift-filters";
import { tenantFilterScopeKey } from "../lib/tenant-filter-storage";

describe("estado controlado de filtros por tenant", () => {
  const dateA = new Date("2037-04-16T12:00:00.000Z");
  const stateA: TenantScopedShiftFiltersState = {
    tenantKey: tenantFilterScopeKey(1, 7),
    value: {
      hospitalId: 101,
      sectorId: 1001,
      date: dateA,
      shiftLabel: "MANHA",
    },
    initialization: "EXPLICIT",
  };

  it("tem identidade distinta para A → B e para revisão posterior de A", () => {
    expect(tenantFilterScopeKey(1, 7)).toBe("1:7");
    expect(tenantFilterScopeKey(2, 8)).toBe("2:8");
    expect(tenantFilterScopeKey(1, 9)).toBe("1:9");
  });

  it("usa filtro neutro já no primeiro render de B, sem aguardar efeito", () => {
    const neutralB = createNeutralShiftFilterValues(
      new Date("2037-04-17T12:00:00.000Z"),
    );

    expect(
      resolveTenantScopedShiftFilters(
        stateA,
        tenantFilterScopeKey(2, 8),
        neutralB,
      ),
    ).toEqual({
      hospitalId: null,
      sectorId: null,
      date: new Date("2037-04-17T12:00:00.000Z"),
      shiftLabel: null,
    });
  });

  it("mantém somente o estado marcado pela mesma chave de tenant", () => {
    expect(
      resolveTenantScopedShiftFilters(
        stateA,
        tenantFilterScopeKey(1, 7),
        createNeutralShiftFilterValues(),
      ),
    ).toBe(stateA.value);
  });
});
