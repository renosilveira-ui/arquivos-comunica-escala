import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALLOCATION_REPEAT_OPTIONS,
  ALLOCATION_REPEAT_SECTION_TITLE,
  allocationRepeatHint,
  allocationRepeatToast,
} from "../lib/allocation-repeat";
import {
  daysBetweenKeys,
  isAllocationRepeatTargetDay,
  selectRepeatTargets,
  weekdayOrdinalInMonth,
} from "../server/allocation-repeat";
import { buildShiftTimestamps } from "../lib/hospital-time";

const at = (date: string, start = "07:00:00", end = "13:00:00") => {
  const [startAt, endAt] = buildShiftTimestamps(date, start, end);
  return { startAt, endAt };
};

describe("regras de repetição da alocação", () => {
  it("conta dias e ordinal do dia da semana no mês", () => {
    expect(daysBetweenKeys("2026-08-04", "2026-08-11")).toBe(7);
    expect(daysBetweenKeys("2026-08-04", "2026-08-18")).toBe(14);
    expect(weekdayOrdinalInMonth("2026-08-04")).toBe(1);
    expect(weekdayOrdinalInMonth("2026-08-11")).toBe(2);
    expect(weekdayOrdinalInMonth("2026-08-25")).toBe(4);
  });

  it("semanal pega de 7 em 7; quinzenal só de 14 em 14", () => {
    expect(isAllocationRepeatTargetDay("2026-08-04", "2026-08-11", "weekly")).toBe(
      true,
    );
    expect(isAllocationRepeatTargetDay("2026-08-04", "2026-08-18", "weekly")).toBe(
      true,
    );
    expect(isAllocationRepeatTargetDay("2026-08-04", "2026-08-11", "biweekly")).toBe(
      false,
    );
    expect(
      isAllocationRepeatTargetDay("2026-08-04", "2026-08-18", "biweekly"),
    ).toBe(true);
    expect(isAllocationRepeatTargetDay("2026-08-04", "2026-08-04", "weekly")).toBe(
      false,
    );
    expect(isAllocationRepeatTargetDay("2026-08-04", "2026-08-11", "none")).toBe(
      false,
    );
  });

  it("mensal só casa o mesmo ordinal em outro mês", () => {
    expect(
      isAllocationRepeatTargetDay("2026-08-04", "2026-08-25", "monthly"),
    ).toBe(false);
    expect(
      isAllocationRepeatTargetDay("2026-08-04", "2026-09-01", "monthly"),
    ).toBe(true);
    expect(
      isAllocationRepeatTargetDay("2026-08-11", "2026-09-08", "monthly"),
    ).toBe(true);
    expect(
      isAllocationRepeatTargetDay("2026-08-04", "2026-09-08", "monthly"),
    ).toBe(false);
  });

  it("v1 filtra só o mês origem, mesmo relógio e mesmo rótulo", () => {
    const source = { id: 1, label: "Manhã", ...at("2026-08-04") };
    const candidates = [
      { id: 2, label: "Manhã", ...at("2026-08-11") },
      { id: 3, label: "Manhã", ...at("2026-08-18") },
      { id: 4, label: "Manhã", ...at("2026-08-25") },
      { id: 5, label: "Tarde", ...at("2026-08-11", "13:00:00", "19:00:00") },
      { id: 6, label: "Manhã", ...at("2026-08-11", "08:00:00", "14:00:00") },
      { id: 7, label: "Manhã", ...at("2026-09-01") },
    ];

    expect(selectRepeatTargets(source, candidates, "none")).toEqual([]);
    expect(
      selectRepeatTargets(source, candidates, "weekly").map((row) => row.id),
    ).toEqual([2, 3, 4]);
    expect(
      selectRepeatTargets(source, candidates, "biweekly").map((row) => row.id),
    ).toEqual([3]);
    expect(selectRepeatTargets(source, candidates, "monthly")).toEqual([]);
  });

  it("copy do toast e das opções em português", () => {
    expect(ALLOCATION_REPEAT_SECTION_TITLE).toBe("Repetir essa escala:");
    expect(ALLOCATION_REPEAT_OPTIONS.map((option) => option.label)).toEqual([
      "Não repetir",
      "Semanalmente",
      "A cada 2 semanas",
      "1 vez por mês",
    ]);
    expect(allocationRepeatHint("none")).toMatch(/só neste plantão/i);
    expect(allocationRepeatHint("weekly")).toMatch(/fim deste mês/);
    expect(allocationRepeatHint("biweekly")).toMatch(/14 em 14/);
    expect(allocationRepeatHint("monthly")).toMatch(/neste mês/);
    expect(allocationRepeatToast(3, 1)).toBe(
      "Alocado em 3 plantões. 1 já tinha médico.",
    );
    expect(allocationRepeatToast(2, 2)).toBe(
      "Alocado em 2 plantões. 2 já tinham médico.",
    );
    expect(allocationRepeatToast(1, 0)).toBe("Alocado em 1 plantão.");
  });
});

describe("wiring da tela de detalhes", () => {
  it("mostra as regras e usa toast, sem Alert.alert", () => {
    const screen = readFileSync("app/shift-details.tsx", "utf8");
    expect(screen).toContain("ALLOCATION_REPEAT_SECTION_TITLE");
    expect(screen).toContain("repeatRule");
    expect(screen).toContain("useActionFeedback");
    expect(screen).toContain("allocationRepeatToast");
    expect(screen).not.toContain("Alert.alert");
    expect(screen).not.toContain("uiAlert");
    expect(screen).not.toContain("window.alert");
    expect(screen).not.toMatch(/#[0-9A-Fa-f]{3,8}/);
  });
});
