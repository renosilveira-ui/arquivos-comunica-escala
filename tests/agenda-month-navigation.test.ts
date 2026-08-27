import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildAgendaMonthPickerOptions,
  calendarOpenBaseHint,
  calendarOpenConfirmTitle,
  calendarOpenOriginFromPreviousMonth,
  calendarOpenPreviewTitle,
  countShiftsInMonth,
  emptyMonthCalendarDescription,
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

  it("calcula o mês anterior sem assumir que ele tenha escala", () => {
    expect(sourceMonthForCalendarTarget("2026-09")).toBe("2026-08");
    expect(previousMonthKey("2026-01")).toBe("2025-12");
    expect(nextMonthKey("2026-08")).toBe("2026-09");
    expect(monthKeyOf(new Date(2026, 8, 1))).toBe("2026-09");
  });

  it("no primeiro mês a copy não pede a escala anterior", () => {
    expect(calendarOpenOriginFromPreviousMonth(undefined)).toBe("templates");
    expect(calendarOpenOriginFromPreviousMonth(false)).toBe("templates");
    expect(emptyMonthCalendarDescription("templates")).toBe(
      "Crie o calendário deste mês a partir dos modelos de horário para começar a alocar os profissionais.",
    );
    expect(
      calendarOpenBaseHint("setembro de 2026", "agosto de 2026", "templates"),
    ).toBe(
      "Destino: setembro de 2026. Sem escala anterior — usa os modelos de horário.",
    );
    expect(
      calendarOpenPreviewTitle("agosto de 2026", "setembro de 2026", "templates"),
    ).toBe(
      "Criar o calendário de setembro de 2026 a partir dos modelos de horário:",
    );
    expect(calendarOpenConfirmTitle(12, "templates")).toBe("Confirmar calendário");
    expect(calendarOpenConfirmTitle(0, "templates")).toBe("Nada a criar");
  });

  it("com escala anterior a copy descreve a cópia do mês passado", () => {
    expect(calendarOpenOriginFromPreviousMonth(true)).toBe("previous-month");
    expect(emptyMonthCalendarDescription("previous-month")).toBe(
      "Crie o calendário deste mês a partir da escala anterior para alocar os profissionais.",
    );
    expect(
      calendarOpenBaseHint("setembro de 2026", "agosto de 2026", "previous-month"),
    ).toBe("Destino: setembro de 2026. Base: agosto de 2026.");
    expect(
      calendarOpenPreviewTitle(
        "agosto de 2026",
        "setembro de 2026",
        "previous-month",
      ),
    ).toBe("Copiar agosto de 2026 para setembro de 2026:");
    expect(calendarOpenConfirmTitle(0, "previous-month")).toBe("Nada a copiar");
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
    expect(agenda).toContain("OpenMonthShiftsButton");
    expect(agenda).toContain("openMonthShiftsDescription");
    expect(agenda).toContain("selectedContext?.canManage");
    expect(agenda).toContain("EmptyMonthCalendarAction");
    expect(agenda.split("<OpenMonthShiftsButton").length - 1).toBe(2);
    expect(menu).toContain("sourceMonthForCalendarTarget");
    expect(menu).toContain("requestedCalendarTargetMonth");
    expect(menu).toContain("Abrir calendário de");
    expect(menu).toContain('variant === "empty-state"');
    expect(agenda).not.toContain("emptyMonthCalendarDescription");
    expect(agenda).not.toContain(
      "Abra o calendário deste mês a partir da escala anterior",
    );
    expect(menu).toContain("calendarOpenPreviewTitle");
    expect(menu).toContain("hasMonthShifts");
    expect(menu).toContain("scheduleContextId");
  });
});
