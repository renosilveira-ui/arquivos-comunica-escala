export type VacancyDashboardTopology = Readonly<{
  hospitalId: number;
  sectorId: number;
}>;

export type VacancyDashboardFilters = Readonly<{
  hospitalId?: number | null;
  sectorId?: number | null;
}>;

export type VacancyDashboardCounts = Readonly<{
  total: number;
  vacanciesByHospital: Record<number, number>;
  vacanciesBySector: Record<number, number>;
}>;

/**
 * A API já devolve apenas vagas acionáveis para o usuário no tenant ativo.
 * A tela recebe a população de um dia uma única vez, calcula os contadores
 * dessa mesma população e aplica localmente só os filtros de topologia.
 */
export function deriveVacancyDashboard<T extends VacancyDashboardTopology>(
  rows: readonly T[],
  filters: VacancyDashboardFilters,
): { visibleRows: T[]; counts: VacancyDashboardCounts } {
  const vacanciesByHospital: Record<number, number> = {};
  const vacanciesBySector: Record<number, number> = {};

  for (const row of rows) {
    vacanciesByHospital[row.hospitalId] =
      (vacanciesByHospital[row.hospitalId] ?? 0) + 1;
    vacanciesBySector[row.sectorId] =
      (vacanciesBySector[row.sectorId] ?? 0) + 1;
  }

  return {
    visibleRows: rows.filter(
      (row) =>
        (filters.hospitalId == null || row.hospitalId === filters.hospitalId) &&
        (filters.sectorId == null || row.sectorId === filters.sectorId),
    ),
    counts: {
      total: rows.length,
      vacanciesByHospital,
      vacanciesBySector,
    },
  };
}
