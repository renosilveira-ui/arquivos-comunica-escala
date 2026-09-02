import { describe, expect, it } from "vitest";
import { deriveVacancyDashboard } from "../lib/vacancy-dashboard";

describe("painel móvel de vagas", () => {
  const rows = [
    { id: 1, hospitalId: 10, sectorId: 100 },
    { id: 2, hospitalId: 10, sectorId: 101 },
    { id: 3, hospitalId: 20, sectorId: 200 },
  ];

  it("deriva lista e contadores da mesma população acionável", () => {
    const dashboard = deriveVacancyDashboard(rows, { hospitalId: 10 });

    expect(dashboard.visibleRows.map((row) => row.id)).toEqual([1, 2]);
    expect(dashboard.counts).toEqual({
      total: 3,
      vacanciesByHospital: { 10: 2, 20: 1 },
      vacanciesBySector: { 100: 1, 101: 1, 200: 1 },
    });
  });

  it("não mistura setores de hospitais irmãos ao aplicar o filtro", () => {
    const dashboard = deriveVacancyDashboard(rows, {
      hospitalId: 10,
      sectorId: 200,
    });

    expect(dashboard.visibleRows).toEqual([]);
    expect(dashboard.counts.vacanciesByHospital).toEqual({ 10: 2, 20: 1 });
  });
});
