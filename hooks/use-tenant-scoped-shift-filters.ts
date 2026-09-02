import { useCallback, useEffect, useState } from "react";
import type { ShiftFilterValues } from "@/components/shift-filters";
import { tenantFilterScopeKey } from "@/lib/tenant-filter-storage";

export type TenantScopedShiftFiltersState = Readonly<{
  tenantKey: string;
  value: ShiftFilterValues;
  initialization: "PENDING" | "DEFAULTS_APPLIED" | "EXPLICIT";
}>;

export function createNeutralShiftFilterValues(
  now = new Date(),
): ShiftFilterValues {
  return {
    hospitalId: null,
    sectorId: null,
    date: new Date(now.getTime()),
    shiftLabel: null,
  };
}

/**
 * Resolve o estado que pode ser usado neste render. O estado persistido de A
 * continua guardado até o efeito alinhar a memória, mas nunca pode pintar ou
 * consultar B durante essa janela síncrona.
 */
export function resolveTenantScopedShiftFilters(
  state: TenantScopedShiftFiltersState,
  activeTenantKey: string,
  neutralValue: ShiftFilterValues,
): ShiftFilterValues {
  return state.tenantKey === activeTenantKey ? state.value : neutralValue;
}

export function useTenantScopedShiftFilters(input: {
  institutionId: number | null;
  tenantRevision: number;
  defaults: ShiftFilterValues;
  defaultsReady: boolean;
}) {
  const tenantKey = tenantFilterScopeKey(
    input.institutionId,
    input.tenantRevision,
  );
  // Só é usado enquanto o estado ainda pertence à revisão anterior; depois
  // do efeito abaixo, `filters` volta a apontar para `storedState.value`.
  const neutralValue = createNeutralShiftFilterValues();
  const [storedState, setStoredState] = useState<TenantScopedShiftFiltersState>(
    () => ({
      tenantKey,
      value: neutralValue,
      initialization: "PENDING",
    }),
  );

  const filters = resolveTenantScopedShiftFilters(
    storedState,
    tenantKey,
    neutralValue,
  );

  // O alinhamento persiste após o render. A proteção relevante já aconteceu
  // acima: durante o primeiro render de B, `filters` é neutro, não o A salvo.
  useEffect(() => {
    setStoredState((current) =>
      current.tenantKey === tenantKey
        ? current
        : {
            tenantKey,
            value: neutralValue,
            initialization: "PENDING",
          },
    );
  }, [neutralValue, tenantKey]);

  // Defaults pertencem a uma revisão de tenant e só podem inicializar uma vez.
  // Uma ação explícita (inclusive a rota autorizada de push) ganha precedência
  // sobre uma resposta tardia de manager_scope.
  useEffect(() => {
    if (!input.defaultsReady) return;
    setStoredState((current) => {
      if (
        current.tenantKey !== tenantKey ||
        current.initialization !== "PENDING"
      ) {
        return current;
      }
      return {
        tenantKey,
        value: input.defaults,
        initialization: "DEFAULTS_APPLIED",
      };
    });
  }, [input.defaults, input.defaultsReady, tenantKey]);

  const setFilters = useCallback(
    (next: ShiftFilterValues) => {
      setStoredState({
        tenantKey,
        value: next,
        initialization: "EXPLICIT",
      });
    },
    [tenantKey],
  );

  return {
    filters,
    setFilters,
    tenantKey,
  };
}
