import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import {
  parseStoredTenantFilterId,
  sanitizeTenantFilterSelection,
  tenantFilterScopeKey,
  tenantFilterStorageKey,
} from "@/lib/tenant-filter-storage";

/**
 * localStorage NÃO existe no React Native — acessá-lo direto lança
 * ReferenceError dentro do useEffect e derruba a tela inteira (crash da
 * aba Solicitações no iOS). No nativo a persistência do último filtro é
 * dispensável: devolve null e o default segue sem memória.
 */
function readLastFilter(key: string | null): string | null {
  if (key === null) return null;
  try {
    if (typeof globalThis.localStorage === "undefined") return null;
    return globalThis.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export interface FilterDefaults {
  hospitalId: number | null;
  sectorId: number | null;
  date: Date;
  shiftLabel: string | null;
}

interface UseFilterDefaultsOptions {
  institutionId: number | null;
  tenantRevision: number;
  hospitals: { id: number; name: string }[];
  sectors: { id: number; hospitalId: number; name: string }[];
  /** Só calcula defaults depois que a topologia do tenant corrente chegou. */
  topologyReady: boolean;
}

type TenantScopedDefaultsState = Readonly<{
  tenantKey: string;
  defaults: FilterDefaults;
  ready: boolean;
}>;

function createNeutralFilterDefaults(now = new Date()): FilterDefaults {
  return {
    hospitalId: null,
    sectorId: null,
    date: new Date(now.getTime()),
    shiftLabel: null,
  };
}

/**
 * Hook para determinar defaults inteligentes dos filtros baseado em manager_scope
 *
 * Regras:
 * 1. Se gestor tem acesso a 1 hospital apenas → auto-seleciona
 * 2. Se gestor tem acesso a vários hospitais → "Selecione um hospital" (ou lembrar último usado)
 * 3. Setor dependente:
 *    - Se hospital selecionado e gestor tem 1 setor naquele hospital → auto-seleciona
 *    - Se tiver vários → deixa escolher
 * 4. Data → padrão "Hoje" sempre
 * 5. Turno → padrão "Todos"
 *
 * Persistência em localStorage:
 * - chave por instituição para hospital
 * - chave por instituição para setor
 * - lastDateMode (Hoje/Amanhã/Escolher)
 * - lastShiftToggle
 */
export function useFilterDefaults(options: UseFilterDefaultsOptions) {
  // Buscar manager_scope do gestor logado
  const {
    data: managerScope,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = trpc.professionals.getManagerScope.useQuery();

  const activeTenantKey = tenantFilterScopeKey(
    options.institutionId,
    options.tenantRevision,
  );
  // A identidade só importa enquanto a revisão nova ainda não foi persistida
  // no estado abaixo. Nesse render transitório, a data continua sendo o dia
  // local corrente; a seleção antiga nunca é exposta.
  const neutralDefaults = createNeutralFilterDefaults();
  const [defaultsState, setDefaultsState] = useState<TenantScopedDefaultsState>(
    () => ({
      tenantKey: activeTenantKey,
      defaults: neutralDefaults,
      ready: false,
    }),
  );
  const defaults =
    defaultsState.tenantKey === activeTenantKey
      ? defaultsState.defaults
      : neutralDefaults;
  const defaultsReady =
    defaultsState.tenantKey === activeTenantKey && defaultsState.ready;

  useEffect(() => {
    // Uma resposta anterior pode ficar brevemente no cache durante A → B.
    // Só inicializamos depois da busca atual e da topologia do tenant.
    if (isLoading || isFetching || !managerScope || !options.topologyReady) {
      return;
    }

    const rememberedSelection = sanitizeTenantFilterSelection({
      hospitalId: parseStoredTenantFilterId(
        readLastFilter(
          tenantFilterStorageKey(options.institutionId, "hospital"),
        ),
      ),
      sectorId: parseStoredTenantFilterId(
        readLastFilter(tenantFilterStorageKey(options.institutionId, "sector")),
      ),
      hospitals: options.hospitals,
      sectors: options.sectors,
    });
    let nextDefaults: FilterDefaults;

    // GESTOR_PLUS pode ver tudo, não auto-seleciona nada
    if (managerScope.canManageAll) {
      nextDefaults = {
        hospitalId: rememberedSelection.hospitalId,
        sectorId: rememberedSelection.sectorId,
        date: new Date(),
        shiftLabel: null,
      };
    } else if (managerScope.role === "USER") {
      // USER não tem manager_scope.
      nextDefaults = {
        hospitalId: null,
        sectorId: null,
        date: new Date(),
        shiftLabel: null,
      };
    } else {
      // GESTOR_MEDICO: revalida o escopo também contra a topologia recém
      // carregada. Um scope cacheado de A nunca escolhe um hospital de B.
      const visibleHospitalIds = new Set(
        options.hospitals.map((hospital) => hospital.id),
      );
      const scopedHospitalIds = managerScope.hospitals.filter((hospitalId) =>
        visibleHospitalIds.has(hospitalId),
      );
      const scopedSectors = managerScope.sectors.filter((scope) =>
        options.sectors.some(
          (sector) =>
            sector.id === scope.sectorId &&
            sector.hospitalId === scope.hospitalId,
        ),
      );

      // Regra 1: Se gestor tem acesso a 1 hospital apenas → auto-seleciona.
      let defaultHospitalId: number | null = null;
      if (scopedHospitalIds.length === 1) {
        defaultHospitalId = scopedHospitalIds[0];
      } else if (
        scopedHospitalIds.length > 1 &&
        rememberedSelection.hospitalId !== null &&
        scopedHospitalIds.includes(rememberedSelection.hospitalId)
      ) {
        defaultHospitalId = rememberedSelection.hospitalId;
      }

      // Regra 3: setor dependente.
      let defaultSectorId: number | null = null;
      if (defaultHospitalId !== null) {
        const sectorsInHospital = scopedSectors.filter(
          (sector) => sector.hospitalId === defaultHospitalId,
        );
        if (sectorsInHospital.length === 1) {
          defaultSectorId = sectorsInHospital[0].sectorId;
        } else if (
          sectorsInHospital.length > 1 &&
          rememberedSelection.sectorId !== null &&
          sectorsInHospital.some(
            (sector) => sector.sectorId === rememberedSelection.sectorId,
          )
        ) {
          defaultSectorId = rememberedSelection.sectorId;
        }
      }

      nextDefaults = {
        hospitalId: defaultHospitalId,
        sectorId: defaultSectorId,
        date: new Date(),
        shiftLabel: null,
      };
    }

    setDefaultsState((current) =>
      current.tenantKey === activeTenantKey && current.ready
        ? current
        : {
            tenantKey: activeTenantKey,
            defaults: nextDefaults,
            ready: true,
          },
    );
  }, [
    activeTenantKey,
    isFetching,
    isLoading,
    managerScope,
    options.hospitals,
    options.institutionId,
    options.sectors,
    options.topologyReady,
  ]);

  return {
    defaults,
    defaultsReady,
    defaultsTenantKey: activeTenantKey,
    isLoading,
    isError,
    error,
    refetch,
    managerScope,
  };
}
