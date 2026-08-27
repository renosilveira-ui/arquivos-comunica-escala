import { describe, expect, it } from "vitest";
import {
  SALA_RECUPERACAO_GESTOR_MEDICO_NAME,
  SALA_RECUPERACAO_SHIFT_TEMPLATES,
  salaRecuperacaoCalendarDaysForMonth,
  salaRecuperacaoTemplateNamesForWeekday,
  salaRecuperacaoTemplatesForWeekday,
} from "../lib/sala-recuperacao-shift-blueprint";

describe("Sala de Recuperação — blueprint de horários", () => {
  it("define três templates com 6h diurno e 12h noturno começando às 07:00", () => {
    expect(SALA_RECUPERACAO_SHIFT_TEMPLATES).toEqual([
      { name: "Manhã", startTime: "07:00:00", endTime: "13:00:00", priority: 10 },
      { name: "Tarde", startTime: "13:00:00", endTime: "19:00:00", priority: 20 },
      { name: "Noite", startTime: "19:00:00", endTime: "07:00:00", priority: 30 },
    ]);
  });

  it("nomeia Maurilio Caetano como gestor médico esperado", () => {
    expect(SALA_RECUPERACAO_GESTOR_MEDICO_NAME).toBe("Maurilio Caetano");
  });

  it("segunda a sexta têm manhã, tarde e noite", () => {
    for (const weekday of [1, 2, 3, 4, 5]) {
      expect(salaRecuperacaoTemplateNamesForWeekday(weekday)).toEqual([
        "Manhã",
        "Tarde",
        "Noite",
      ]);
    }
  });

  it("sábado só até 19h — sem noite", () => {
    expect(salaRecuperacaoTemplateNamesForWeekday(6)).toEqual(["Manhã", "Tarde"]);
    expect(salaRecuperacaoTemplatesForWeekday(6).map((t) => t.name)).toEqual([
      "Manhã",
      "Tarde",
    ]);
  });

  it("domingo não tem plantão", () => {
    expect(salaRecuperacaoTemplateNamesForWeekday(0)).toEqual([]);
    expect(salaRecuperacaoTemplatesForWeekday(0)).toEqual([]);
  });

  it("calendário de setembro/2026 respeita sábado sem noite e domingo vazio", () => {
    const days = salaRecuperacaoCalendarDaysForMonth("2026-09");
    const saturday = days.find((d) => d.dayKey === "2026-09-05");
    const sundayKeys = days.filter((d) => d.weekday === 0);
    const monday = days.find((d) => d.dayKey === "2026-09-07");

    expect(sundayKeys).toHaveLength(0);
    expect(saturday?.templates.map((t) => t.name)).toEqual(["Manhã", "Tarde"]);
    expect(monday?.templates.map((t) => t.name)).toEqual([
      "Manhã",
      "Tarde",
      "Noite",
    ]);
  });

  it("rejeita yearMonth inválido", () => {
    expect(() => salaRecuperacaoCalendarDaysForMonth("2026-13")).toThrow(
      /inválido/,
    );
  });
});
