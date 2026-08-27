import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  openMonthShiftTemplateChipLabel,
  openMonthShiftsButtonTitle,
  openMonthShiftsConfirmTitle,
  openMonthShiftsDescription,
  openMonthShiftsModeHint,
  openMonthShiftsModeLabel,
  openMonthShiftsPreviewCount,
  openMonthShiftsToast,
  planOpenMonthShifts,
  resolveOpenMonthTemplateNames,
} from "@/lib/open-month-shifts";

describe("abrir os turnos do mês — planejamento", () => {
  it("setembro/2026 com todos os dias aplicáveis gera 74 plantões", () => {
    const planned = planOpenMonthShifts({
      yearMonth: "2026-09",
      mode: "all-applicable",
    });
    expect(planned).toHaveLength(74);
    expect(planned.some((slot) => slot.weekday === 0)).toBe(false);
    expect(
      planned
        .filter((slot) => slot.dayKey === "2026-09-05")
        .map((slot) => slot.template.name),
    ).toEqual(["Manhã", "Tarde"]);
    expect(
      planned
        .filter((slot) => slot.dayKey === "2026-09-07")
        .map((slot) => slot.template.name),
    ).toEqual(["Manhã", "Tarde", "Noite"]);
  });

  it("só noites conta as noites de dia útil", () => {
    const planned = planOpenMonthShifts({
      yearMonth: "2026-09",
      mode: "nights-only",
    });
    expect(planned).toHaveLength(22);
    expect(planned.every((slot) => slot.template.name === "Noite")).toBe(true);
    expect(planned.every((slot) => slot.weekday >= 1 && slot.weekday <= 5)).toBe(
      true,
    );
  });

  it("só sábados conta manhã e tarde", () => {
    const planned = planOpenMonthShifts({
      yearMonth: "2026-09",
      mode: "weekends-only",
    });
    expect(planned).toHaveLength(8);
    expect(planned.every((slot) => slot.weekday === 6)).toBe(true);
    expect(planned.every((slot) => slot.template.name !== "Noite")).toBe(true);
  });

  it("personalizado aplica os templates escolhidos sem noite de sábado", () => {
    const planned = planOpenMonthShifts({
      yearMonth: "2026-09",
      mode: "custom",
      templateNames: ["Noite", "Manhã"],
    });
    expect(planned.every((slot) => ["Manhã", "Noite"].includes(slot.template.name))).toBe(
      true,
    );
    expect(
      planned.filter((slot) => slot.dayKey === "2026-09-05").map((slot) => slot.template.name),
    ).toEqual(["Manhã"]);
    expect(planned.filter((slot) => slot.template.name === "Noite")).toHaveLength(22);
  });

  it("personalizado exige ao menos um turno válido", () => {
    expect(() =>
      resolveOpenMonthTemplateNames("custom", []),
    ).toThrow(/Escolha ao menos um turno/);
    expect(() =>
      resolveOpenMonthTemplateNames("custom", ["Cinderela"]),
    ).toThrow(/Turno inválido/);
  });
});

describe("abrir os turnos do mês — copy", () => {
  it("usa sentence case em português sem falar de alocação", () => {
    expect(openMonthShiftsButtonTitle("setembro")).toBe(
      "Abrir os turnos de setembro",
    );
    expect(openMonthShiftsDescription()).toBe(
      "Crie os plantões vagos deste mês. Ninguém é alocado nesta etapa.",
    );
    expect(openMonthShiftsModeLabel("all-applicable")).toBe(
      "Todos os dias aplicáveis",
    );
    expect(openMonthShiftsModeLabel("nights-only")).toBe(
      "Só noites (segunda a sexta)",
    );
    expect(openMonthShiftsModeLabel("weekends-only")).toBe(
      "Só sábados (manhã e tarde)",
    );
    expect(openMonthShiftsModeLabel("custom")).toBe("Escolher turnos");
    expect(openMonthShiftsModeHint("all-applicable")).toMatch(/Domingo sem plantão/);
    expect(openMonthShiftTemplateChipLabel("Manhã")).toBe("Manhã 07:00–13:00");
    expect(openMonthShiftTemplateChipLabel("Noite")).toBe("Noite 19:00–07:00");
    expect(openMonthShiftsPreviewCount(74)).toBe(
      "74 plantões vagos neste recorte.",
    );
    expect(openMonthShiftsConfirmTitle(74)).toBe("Criar plantões vagos");
    expect(openMonthShiftsConfirmTitle(0)).toBe("Nada a criar");
    expect(openMonthShiftsToast(74, 0)).toBe(
      "74 plantões criados. Nenhum já existia.",
    );
    expect(openMonthShiftsToast(0, 74)).toBe(
      "Nenhum plantão novo. 74 já existiam.",
    );
    expect(openMonthShiftsToast(1, 1)).toBe("1 plantão criado. 1 já existia.");
  });
});

describe("wiring do botão na Agenda", () => {
  it("empty state do gestor abre turnos, não aloca nem copia o mês anterior", () => {
    const agenda = readFileSync("app/(tabs)/agenda.tsx", "utf8");
    const button = readFileSync(
      "components/agenda/OpenMonthShiftsButton.tsx",
      "utf8",
    );

    expect(agenda).toContain("OpenMonthShiftsButton");
    expect(agenda).toContain("openMonthShiftsDescription");
    expect(agenda).not.toContain("emptyMonthCalendarDescription");
    expect(agenda).not.toContain('variant="empty-state"');
    expect(button).toContain("openMonthShifts");
    expect(button).toContain("openMonthShiftsModeLabel");
    expect(button).toContain("useActionFeedback");
    expect(button).not.toContain("Alert.alert");
    expect(button).not.toContain("includeAssignments");
    expect(button).toContain("theme.colors");
    expect(button).not.toMatch(/#[0-9A-Fa-f]{3,8}/);
  });
});
