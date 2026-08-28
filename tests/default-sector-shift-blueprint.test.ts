import { describe, expect, it } from "vitest";
import {
  DEFAULT_SECTOR_SHIFT_TEMPLATES,
  defaultCalendarDaysForMonth,
  defaultTemplateNamesForWeekday,
} from "../lib/default-sector-shift-blueprint";
import { SALA_RECUPERACAO_SHIFT_TEMPLATES } from "../lib/sala-recuperacao-shift-blueprint";

describe("blueprint padrão de escala de setor", () => {
  it("define manhã, tarde e noite no relógio −03:00", () => {
    expect(DEFAULT_SECTOR_SHIFT_TEMPLATES).toEqual([
      { name: "Manhã", startTime: "07:00:00", endTime: "13:00:00", priority: 10 },
      { name: "Tarde", startTime: "13:00:00", endTime: "19:00:00", priority: 20 },
      { name: "Noite", startTime: "19:00:00", endTime: "07:00:00", priority: 30 },
    ]);
  });

  it("é o mesmo recorte que a Sala de Recuperação reexporta", () => {
    expect(SALA_RECUPERACAO_SHIFT_TEMPLATES).toEqual(
      DEFAULT_SECTOR_SHIFT_TEMPLATES,
    );
  });

  it("domingo vazio, sábado sem noite, dias úteis com três turnos", () => {
    expect(defaultTemplateNamesForWeekday(0)).toEqual([]);
    expect(defaultTemplateNamesForWeekday(6)).toEqual(["Manhã", "Tarde"]);
    expect(defaultTemplateNamesForWeekday(1)).toEqual(["Manhã", "Tarde", "Noite"]);
  });

  it("setembro/2026 gera 74 janelas sem importar São Carlos", () => {
    const days = defaultCalendarDaysForMonth("2026-09");
    expect(days.some((day) => day.weekday === 0)).toBe(false);
    expect(days.find((day) => day.dayKey === "2026-09-05")?.templates.map((t) => t.name)).toEqual([
      "Manhã",
      "Tarde",
    ]);
    expect(
      days.reduce((sum, day) => sum + day.templates.length, 0),
    ).toBe(74);
  });
});
