import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  findMobileAgendaDay,
  type MobileAgendaWeek,
} from "@/lib/agenda-mobile-day";

const weeks: MobileAgendaWeek[] = [
  {
    weekStart: "2026-09-07",
    days: [
      { date: "2026-09-09", dow: 3, groups: [] },
      {
        date: "2026-09-10",
        dow: 4,
        groups: [
          {
            hospitalId: 1,
            hospitalName: "Hospital A",
            sectorId: 10,
            sectorName: "Centro Cirúrgico 1",
            shifts: [],
          },
          {
            hospitalId: 1,
            hospitalName: "Hospital A",
            sectorId: 11,
            sectorName: "Centro Cirúrgico 2",
            shifts: [],
          },
          {
            hospitalId: 2,
            hospitalName: "Hospital B",
            sectorId: 20,
            sectorName: "TRR",
            shifts: [],
          },
        ],
      },
    ],
  },
];

describe("Lista diária da Agenda", () => {
  it("seleciona somente o dia solicitado e preserva todos os hospitais e setores", () => {
    const day = findMobileAgendaDay(weeks, "2026-09-10");

    expect(day?.date).toBe("2026-09-10");
    expect(
      day?.groups.map((group) => `${group.hospitalName} · ${group.sectorName}`),
    ).toEqual([
      "Hospital A · Centro Cirúrgico 1",
      "Hospital A · Centro Cirúrgico 2",
      "Hospital B · TRR",
    ]);
  });

  it("não substitui um dia ausente por dados de outra data", () => {
    expect(findMobileAgendaDay(weeks, "2026-09-11")).toBeNull();
  });

  it("não declara agenda vazia quando a consulta de plantões falhou", () => {
    const component = readFileSync(
      "components/agenda/MobileDayList.tsx",
      "utf8",
    );

    expect(component).toContain("suppressScheduleContent ? null");
    expect(component).toContain("Nenhum plantão neste dia.");
  });
});
