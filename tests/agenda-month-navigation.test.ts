import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildAgendaMonthPickerOptions,
  countShiftsInMonth,
  monthKeyOf,
  nextMonthKey,
  previousMonthKey,
  sourceMonthForCalendarTarget,
} from "@/lib/agenda-month-navigation";

describe("navegação mensal da Agenda", () => {
  it("em agosto de 2026 o seletor inclui setembro", () => {
    expect(buildAgendaMonthPickerOptions(new Date(2026, 7, 27))).toEqual([
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
    ]);
  });

  it("vira o ano sem perder o mês seguinte", () => {
    expect(buildAgendaMonthPickerOptions(new Date(2026, 11, 15))).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
  });

  it("abre o mês vazio a partir do mês anterior", () => {
    expect(sourceMonthForCalendarTarget("2026-09")).toBe("2026-08");
    expect(previousMonthKey("2026-01")).toBe("2025-12");
    expect(nextMonthKey("2026-08")).toBe("2026-09");
    expect(monthKeyOf(new Date(2026, 8, 1))).toBe("2026-09");
  });

  it("ignora plantões dos dias de padding fora do mês selecionado", () => {
    const weeks = [
      {
        days: [
          {
            date: "2026-08-31",
            groups: [{ shifts: [{ id: 1 }] }],
          },
          {
            date: "2026-09-01",
            groups: [{ shifts: [] }],
          },
        ],
      },
    ];

    expect(countShiftsInMonth(weeks, "2026-09")).toBe(0);
    expect(countShiftsInMonth(weeks, "2026-08")).toBe(1);
  });
});

describe("wiring do calendário mensal na Agenda", () => {
  it("mostra setembro e a ação de abrir calendário no mês vazio", () => {
    const agenda = readFileSync("app/(tabs)/agenda.tsx", "utf8");
    const menu = readFileSync("components/agenda/ManagerActionsMenu.tsx", "utf8");

    expect(agenda).toContain("buildAgendaMonthPickerOptions");
    expect(agenda).toContain("countShiftsInMonth");
    expect(agenda).toContain("Editar e alocar em");
    expect(agenda).toContain("calendarTargetMonth=");
    expect(agenda).toContain('variant="empty-state"');
    expect(agenda).toContain("selectedContext?.canManage");
    expect(agenda).toContain("EmptyMonthCalendarAction");
    expect(menu).toContain("sourceMonthForCalendarTarget");
    expect(menu).toContain("requestedCalendarTargetMonth");
    expect(menu).toContain("Abrir calendário de");
    expect(menu).toContain('variant === "empty-state"');
  });
});
