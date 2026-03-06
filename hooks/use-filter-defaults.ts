import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";

export interface FilterDefaults {
  hospitalId: number | null;
  sectorId: number | null;
  date: Date;
  shiftLabel: string | null;
}

interface UseFilterDefaultsOptions {
  hospitals: Array<{ id: number; name: string }>;
  sectors: Array<{ id: number; hospitalId: number; name: string }>;
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
 * - lastHospitalId
 * - lastSectorId
 * - lastDateMode (Hoje/Amanhã/Escolher)
 * - lastShiftToggle
 */
export function useFilterDefaults(options: UseFilterDefaultsOptions) {
  const { hospitals, sectors } = options;
  
  // Buscar manager_scope do gestor logado
  const { data: managerScope, isLoading } = trpc.professionals.getManagerScope.useQuery();

  const [defaults, setDefaults] = useState<FilterDefaults>({
    hospitalId: null,
    sectorId: null,
    date: new Date(), // Padrão "Hoje"
    shiftLabel: null, // Padrão "Todos"
  });

  useEffect(() => {
    if (isLoading || !managerScope) return;

    // GESTOR_PLUS pode ver tudo, não auto-seleciona nada
    if (managerScope.canManageAll) {
      // Tentar carregar do localStorage
      const lastHospitalId = localStorage.getItem("lastHospitalId");
      const lastSectorId = localStorage.getItem("lastSectorId");
      
      setDefaults({
        hospitalId: lastHospitalId ? parseInt(lastHospitalId, 10) : null,
        sectorId: lastSectorId ? parseInt(lastSectorId, 10) : null,
        date: new Date(),
        shiftLabel: null,
      });
      return;
    }

    // USER não tem manager_scope
    if (managerScope.role === "USER") {
      setDefaults({
        hospitalId: null,
        sectorId: null,
        date: new Date(),
        shiftLabel: null,
      });
      return;
    }

    // GESTOR_MEDICO: aplicar defaults inteligentes
    const { hospitals: scopedHospitalIds, sectors: scopedSectors } = managerScope;

    // Regra 1: Se gestor tem acesso a 1 hospital apenas → auto-seleciona
    let defaultHospitalId: number | null = null;
    
    if (scopedHospitalIds.length === 1) {
      defaultHospitalId = scopedHospitalIds[0];
    } else if (scopedHospitalIds.length > 1) {
      // Tentar carregar do localStorage e validar se ainda tem permissão
        const lastHospitalId = localStorage.getItem("lastHospitalId");
        if (lastHospitalId) {
          const lastHospitalIdNum = parseInt(lastHospitalId, 10);
          if ((scopedHospitalIds as number[]).includes(lastHospitalIdNum)) {
            defaultHospitalId = lastHospitalIdNum;
          }
        }
    }

    // Regra 3: Setor dependente
    let defaultSectorId: number | null = null;
    
    if (defaultHospitalId !== null) {
      // Filtrar setores do hospital selecionado que o gestor pode acessar
      const sectorsInHospital = scopedSectors.filter(
        s => s.hospitalId === defaultHospitalId
      );

      if (sectorsInHospital.length === 1) {
        // Auto-seleciona se tiver 1 setor apenas
        defaultSectorId = sectorsInHospital[0].sectorId;
      } else if (sectorsInHospital.length > 1) {
        // Tentar carregar do localStorage e validar se ainda tem permissão
        const lastSectorId = localStorage.getItem("lastSectorId");
        if (lastSectorId) {
          const lastSectorIdNum = parseInt(lastSectorId, 10);
          if (sectorsInHospital.some(s => s.sectorId === lastSectorIdNum)) {
            defaultSectorId = lastSectorIdNum;
          }
        }
      }
    }

    setDefaults({
      hospitalId: defaultHospitalId,
      sectorId: defaultSectorId,
      date: new Date(), // Padrão "Hoje"
      shiftLabel: null, // Padrão "Todos"
    });
  }, [managerScope, isLoading, hospitals, sectors]);

  return { defaults, isLoading, managerScope };
}
