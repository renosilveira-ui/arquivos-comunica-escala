import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALLOCATION_REPEAT_HORIZON_MONTHS,
  ALLOCATION_REPEAT_OPTIONS,
  ALLOCATION_REPEAT_SECTION_TITLE,
  DEFAULT_ALLOCATION_REPEAT_MONTHS,
  MAX_ALLOCATION_REPEAT_MONTHS,
  allocationRepeatConflictMessage,
  allocationRepeatHint,
  allocationRepeatHorizonHint,
  allocationRepeatHorizonLabel,
  allocationRepeatToast,
  clampAllocationRepeatMonths,
} from "../lib/allocation-repeat";
import {
  addMonthsToKey,
  allocationRepeatTargetDayKeys,
  daysBetweenKeys,
  isAllocationRepeatTargetDay,
  repeatLastDayKey,
  repeatScopeLastDayKey,
  repeatSlotAt,
  selectRepeatTargets,
  weekdayOrdinalInMonth,
} from "../server/allocation-repeat";
import { buildShiftTimestamps, formatHospitalTime } from "../lib/hospital-time";

const at = (date: string, start = "07:00:00", end = "13:00:00") => {
  const [startAt, endAt] = buildShiftTimestamps(date, start, end);
  return { startAt, endAt };
};

describe("regras de repetição do plantonista", () => {
  it("conta dias e ordinal do dia da semana no mês", () => {
    expect(daysBetweenKeys("2026-08-04", "2026-08-18")).toBe(14);
    expect(daysBetweenKeys("2026-08-18", "2026-08-04")).toBe(-14);
    expect(weekdayOrdinalInMonth("2026-08-04")).toBe(1);
    expect(weekdayOrdinalInMonth("2026-08-25")).toBe(4);
  });

  it("semanal pega de 7 em 7; quinzenal só de 14 em 14", () => {
    expect(
      isAllocationRepeatTargetDay("2026-08-04", "2026-08-11", "weekly"),
    ).toBe(true);
    expect(
      isAllocationRepeatTargetDay("2026-08-04", "2026-08-11", "biweekly"),
    ).toBe(false);
    expect(
      isAllocationRepeatTargetDay("2026-08-04", "2026-08-18", "biweekly"),
    ).toBe(true);
    expect(
      isAllocationRepeatTargetDay("2026-08-04", "2026-08-04", "weekly"),
    ).toBe(false);
    expect(
      isAllocationRepeatTargetDay("2026-08-11", "2026-08-04", "weekly"),
    ).toBe(false);
  });

  it("mensal só casa o mesmo ordinal em outro mês", () => {
    expect(
      isAllocationRepeatTargetDay("2026-08-11", "2026-09-08", "monthly"),
    ).toBe(true);
    expect(
      isAllocationRepeatTargetDay("2026-08-04", "2026-09-08", "monthly"),
    ).toBe(false);
  });
});

describe("horizonte da repetição", () => {
  it("padrão 2 meses, teto 6, e o clamp defende a borda", () => {
    expect(DEFAULT_ALLOCATION_REPEAT_MONTHS).toBe(2);
    expect(MAX_ALLOCATION_REPEAT_MONTHS).toBe(6);
    expect(ALLOCATION_REPEAT_HORIZON_MONTHS).toEqual([1, 2, 3, 4, 5, 6]);
    expect(clampAllocationRepeatMonths(0)).toBe(1);
    expect(clampAllocationRepeatMonths(99)).toBe(6);
    expect(clampAllocationRepeatMonths(2.7)).toBe(2);
    expect(clampAllocationRepeatMonths(Number.NaN)).toBe(2);
  });

  it("dia que não existe no mês de destino cai no último dia daquele mês", () => {
    expect(addMonthsToKey("2026-10-15", 2)).toBe("2026-12-15");
    expect(addMonthsToKey("2026-12-31", 2)).toBe("2027-02-28");
    expect(addMonthsToKey("2026-08-31", 1)).toBe("2026-09-30");
    expect(addMonthsToKey("2026-11-30", 1)).toBe("2026-12-30");
  });

  it("sem horizonte, o escopo antigo para no fim do mês de origem", () => {
    const { startAt } = at("2026-08-04");
    expect(repeatScopeLastDayKey(startAt, { kind: "month" })).toBe(
      "2026-08-31",
    );
    expect(repeatScopeLastDayKey(startAt, { kind: "horizon", months: 2 })).toBe(
      "2026-10-04",
    );
    // Fevereiro e os meses de 30 dias não podem escorregar para o mês seguinte.
    expect(
      repeatScopeLastDayKey(at("2027-02-09").startAt, { kind: "month" }),
    ).toBe("2027-02-28");
    expect(
      repeatScopeLastDayKey(at("2026-09-15").startAt, { kind: "month" }),
    ).toBe("2026-09-30");
  });

  it("o último dia sai do plantão de origem", () => {
    const { startAt } = at("2026-10-15");
    expect(repeatLastDayKey(startAt, 2)).toBe("2026-12-15");
    expect(repeatLastDayKey(startAt, 99)).toBe("2027-04-15");
  });

  it("enumera os dias alvo e para no horizonte", () => {
    expect(
      allocationRepeatTargetDayKeys("2026-08-04", "weekly", "2026-08-31"),
    ).toEqual(["2026-08-11", "2026-08-18", "2026-08-25"]);
    expect(
      allocationRepeatTargetDayKeys("2026-08-04", "biweekly", "2026-09-30"),
    ).toEqual(["2026-08-18", "2026-09-01", "2026-09-15", "2026-09-29"]);
    expect(
      allocationRepeatTargetDayKeys("2026-08-04", "none", "2026-12-31"),
    ).toEqual([]);
  });

  it("mensal deixa de ser inócuo quando o horizonte passa do mês", () => {
    // No recorte antigo (só o mês de origem) esta regra nunca tinha alvo.
    expect(
      allocationRepeatTargetDayKeys("2026-08-04", "monthly", "2026-10-31"),
    ).toEqual(["2026-09-01", "2026-10-06"]);
    // E o horizonte corta: 06/10 fica de fora quando ele para em 04/10.
    expect(
      allocationRepeatTargetDayKeys("2026-08-04", "monthly", "2026-10-04"),
    ).toEqual(["2026-09-01"]);
  });
});

describe("seleção de vagas existentes", () => {
  const source = { id: 1, label: "Manhã", ...at("2026-08-04") };
  const candidates = [
    { id: 2, label: "Manhã", ...at("2026-08-11") },
    { id: 3, label: "Manhã", ...at("2026-08-18") },
    { id: 4, label: "Manhã", ...at("2026-08-25") },
    { id: 5, label: "Tarde", ...at("2026-08-11", "13:00:00", "19:00:00") },
    { id: 6, label: "Manhã", ...at("2026-08-11", "08:00:00", "14:00:00") },
    { id: 7, label: "Manhã", ...at("2026-09-01") },
  ];

  it("exige mesmo rótulo e mesmo relógio, e respeita o horizonte", () => {
    expect(
      selectRepeatTargets(source, candidates, "none", "2026-10-04"),
    ).toEqual([]);
    expect(
      selectRepeatTargets(source, candidates, "weekly", "2026-08-31").map(
        (row) => row.id,
      ),
    ).toEqual([2, 3, 4]);
    expect(
      selectRepeatTargets(source, candidates, "weekly", "2026-10-04").map(
        (row) => row.id,
      ),
    ).toEqual([2, 3, 4, 7]);
    expect(
      selectRepeatTargets(source, candidates, "biweekly", "2026-10-04").map(
        (row) => row.id,
      ),
    ).toEqual([3, 7]);
    expect(
      selectRepeatTargets(source, candidates, "monthly", "2026-10-04").map(
        (row) => row.id,
      ),
    ).toEqual([7]);
  });
});

describe("a vaga que a repetição abriria", () => {
  it("preserva o horário de parede atravessando meses", () => {
    const source = at("2026-10-29", "19:00:00", "07:00:00");
    const slot = repeatSlotAt(source, "2026-12-31");
    expect(formatHospitalTime(slot.startAt)).toBe(
      formatHospitalTime(source.startAt),
    );
    expect(formatHospitalTime(slot.endAt)).toBe(
      formatHospitalTime(source.endAt),
    );
    // A duração do plantão que vira o dia não pode mudar no caminho.
    expect(slot.endAt.getTime() - slot.startAt.getTime()).toBe(
      source.endAt.getTime() - source.startAt.getTime(),
    );
  });
});

describe("copy em português", () => {
  it("títulos, dicas e rótulos do horizonte", () => {
    expect(ALLOCATION_REPEAT_SECTION_TITLE).toBe("Repetir esse plantonista:");
    expect(ALLOCATION_REPEAT_OPTIONS.map((option) => option.label)).toEqual([
      "Não repetir",
      "Semanalmente",
      "A cada 2 semanas",
      "1 vez por mês",
    ]);
    expect(allocationRepeatHint("none")).toMatch(/só neste plantão/i);
    expect(allocationRepeatHint("weekly")).toMatch(/7 em 7/);
    expect(allocationRepeatHint("biweekly")).toMatch(/14 em 14/);
    expect(allocationRepeatHorizonLabel(1)).toBe("1 mês");
    expect(allocationRepeatHorizonLabel(2)).toBe("2 meses");
    expect(allocationRepeatHorizonHint("weekly", 2)).toMatch(
      /Repete por 2 meses\./,
    );
    // Sem repetição não existe horizonte a anunciar.
    expect(allocationRepeatHorizonHint("none", 3)).toBe(
      allocationRepeatHint("none"),
    );
  });

  it("o toast conta alocação, vagas abertas e quem já tinha médico", () => {
    expect(allocationRepeatToast(3, 1)).toBe(
      "Alocado em 3 plantões. 1 já tinha médico.",
    );
    expect(allocationRepeatToast(2, 2)).toBe(
      "Alocado em 2 plantões. 2 já tinham médico.",
    );
    expect(allocationRepeatToast(1, 0)).toBe("Alocado em 1 plantão.");
    expect(allocationRepeatToast(8, 0, 5)).toBe(
      "Alocado em 8 plantões, 5 vagas abertas na escala.",
    );
    expect(allocationRepeatToast(4, 1, 1)).toBe(
      "Alocado em 4 plantões, 1 vaga aberta na escala. 1 já tinha médico.",
    );
  });

  it("o choque de janela nomeia os dias e sugere a saída", () => {
    const message = allocationRepeatConflictMessage([
      "2026-09-03",
      "2026-09-10",
      "2026-09-17",
      "2026-09-24",
    ]);
    expect(message).toContain("2026-09-03");
    expect(message).toContain("e mais 1");
    expect(message).toMatch(/encurte a repetição/i);
  });
});

describe("wiring do servidor", () => {
  const editor = readFileSync("server/editor.ts", "utf8");

  it("abre a escala dos meses que a repetição alcança", () => {
    // A guarda plural materializa o roster ausente como DRAFT: é ela que
    // "abre a escala" do mês futuro. A singular sozinha só veria a origem.
    expect(editor).toContain("assertMonthsEditableForUpdate");
    expect(editor).toContain("planAllocationRepeat");
    expect(editor).toContain("createRepeatSlots");
  });

  it("bloqueia quando outro plantão já ocupa a janela", () => {
    expect(editor).toContain("plan.blockedDayKeys.length > 0");
    expect(editor).toContain("allocationRepeatConflictMessage");
  });

  it("o horizonte não vence a autoridade sobre a data", () => {
    // GESTOR_MEDICO alcança o mês corrente e o seguinte; repetir por 6
    // meses não pode contornar isso, então a guarda roda por data alvo.
    expect(editor).toMatch(
      /for \(const date of repeatDates\) \{\s*assertCanEditScheduleDate\(actor, date\);/,
    );
  });

  it("a vaga nova nasce VAGO e com a trilha de criação", () => {
    expect(editor).toContain('status: "VAGO"');
    expect(editor).toContain('action: "SHIFT_CREATED"');
  });
});

describe("wiring da tela de detalhes", () => {
  const screen = readFileSync("app/shift-details.tsx", "utf8");

  it("mostra as regras e usa toast, sem Alert.alert", () => {
    expect(screen).toContain("ALLOCATION_REPEAT_SECTION_TITLE");
    expect(screen).toContain("repeatRule");
    expect(screen).toContain("useActionFeedback");
    expect(screen).toContain("allocationRepeatToast");
    expect(screen).not.toContain("Alert.alert");
    expect(screen).not.toContain("uiAlert");
    expect(screen).not.toContain("window.alert");
    expect(screen).not.toMatch(/#[0-9A-Fa-f]{3,8}/);
  });

  it("manda o horizonte escolhido junto com a regra", () => {
    expect(screen).toContain("ALLOCATION_REPEAT_HORIZON_MONTHS");
    expect(screen).toContain("setRepeatMonths");
    expect(screen).toMatch(/repeatRule,\s*repeatMonths,/);
    expect(screen).toContain("result.createdSlotCount");
  });
});
