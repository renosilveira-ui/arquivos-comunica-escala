import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ALERT_OFFSET_OPTIONS,
  MAX_ALERT_SELECTION,
  PERSONAL_CALENDAR_KIND_LABELS,
  accessibilityLabelForOccurrence,
  addDaysToDayKey,
  alertOffsetsSummary,
  availabilityLabel,
  blocksTime,
  compareOccurrences,
  conflictSummaryText,
  dayKeyInTimeZone,
  endOfMonthDayKey,
  formatOccurrenceTime,
  groupOccurrencesByDay,
  listingExposesNotes,
  recurrenceSummary,
  resolvePersonalCalendarScreenState,
  shiftAnchor,
  startOfWeekDayKey,
  weekdayIndexForDayKey,
  weekdayIndexesFromMask,
  weekdaysMaskFromIndexes,
  windowForView,
  type PersonalCalendarOccurrenceLike,
} from "../lib/personal-calendar-view";

const TZ = "America/Sao_Paulo";

function occurrence(
  overrides: Partial<PersonalCalendarOccurrenceLike> = {},
): PersonalCalendarOccurrenceLike {
  return {
    itemId: 1,
    itemVersion: 1,
    occurrenceKey: "k1",
    title: "Consulta",
    kind: "APPOINTMENT",
    availability: "BUSY",
    allDay: false,
    locationLabel: null,
    startsAtUtc: new Date("2026-09-10T11:00:00Z"),
    endsAtUtc: new Date("2026-09-10T12:00:00Z"),
    alertOffsets: [],
    ...overrides,
  };
}

describe("janela por modo de visualização", () => {
  it("dia é um único dia", () => {
    expect(windowForView("DAY", "2026-09-10")).toEqual({
      fromDate: "2026-09-10",
      toDate: "2026-09-10",
    });
  });

  it("semana começa na segunda e cobre 7 dias", () => {
    // 2026-09-10 é uma quinta-feira.
    expect(windowForView("WEEK", "2026-09-10")).toEqual({
      fromDate: "2026-09-07",
      toDate: "2026-09-13",
    });
  });

  it("mês cobre do dia 1 ao último, inclusive fevereiro bissexto", () => {
    expect(windowForView("MONTH", "2026-09-10")).toEqual({
      fromDate: "2026-09-01",
      toDate: "2026-09-30",
    });
    expect(endOfMonthDayKey("2028-02-15")).toBe("2028-02-29");
    expect(endOfMonthDayKey("2026-02-15")).toBe("2026-02-28");
  });

  it("nenhuma janela chega perto do teto de 366 dias do servidor", () => {
    for (const view of ["DAY", "WEEK", "MONTH"] as const) {
      const w = windowForView(view, "2026-01-15");
      const span =
        (Date.parse(`${w.toDate}T00:00:00Z`) -
          Date.parse(`${w.fromDate}T00:00:00Z`)) /
          86_400_000 +
        1;
      expect(span).toBeLessThanOrEqual(31);
      expect(span).toBeGreaterThan(0);
    }
  });

  it("navegação avança e volta sem pular mês curto", () => {
    expect(shiftAnchor("DAY", "2026-09-30", 1)).toBe("2026-10-01");
    expect(shiftAnchor("WEEK", "2026-09-10", -1)).toBe("2026-09-03");
    expect(shiftAnchor("MONTH", "2026-01-31", 1)).toBe("2026-02-01");
    expect(shiftAnchor("MONTH", "2026-03-15", -1)).toBe("2026-02-01");
  });

  it("semana de domingo pertence à semana que começou na segunda anterior", () => {
    // 2026-09-13 é domingo.
    expect(startOfWeekDayKey("2026-09-13")).toBe("2026-09-07");
    expect(weekdayIndexForDayKey("2026-09-07")).toBe(0);
    expect(weekdayIndexForDayKey("2026-09-13")).toBe(6);
  });

  it("soma de dias atravessa virada de ano", () => {
    expect(addDaysToDayKey("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysToDayKey("2027-01-01", -1)).toBe("2026-12-31");
  });
});

describe("agrupamento por dia", () => {
  /**
   * O processo roda em UTC no Render. Sem conversão por fuso, um compromisso
   * às 21h de São Paulo (00h UTC do dia seguinte) apareceria no dia errado —
   * o mesmo defeito que a auditoria de 22/08 encontrou no domínio de escala.
   */
  it("usa o relógio local, não o do processo", () => {
    expect(dayKeyInTimeZone(new Date("2026-09-11T02:00:00Z"), TZ)).toBe(
      "2026-09-10",
    );
    const groups = groupOccurrencesByDay({
      fromDate: "2026-09-10",
      toDate: "2026-09-11",
      occurrences: [
        occurrence({ startsAtUtc: new Date("2026-09-11T02:00:00Z") }),
      ],
      timeZone: TZ,
    });
    expect(
      groups.find((g) => g.dayKey === "2026-09-10")?.occurrences,
    ).toHaveLength(1);
    expect(
      groups.find((g) => g.dayKey === "2026-09-11")?.occurrences,
    ).toHaveLength(0);
  });

  it("preenche dias vazios da janela, porque o vazio informa", () => {
    const groups = groupOccurrencesByDay({
      fromDate: "2026-09-07",
      toDate: "2026-09-13",
      occurrences: [],
      timeZone: TZ,
    });
    expect(groups).toHaveLength(7);
    expect(groups.every((group) => group.occurrences.length === 0)).toBe(true);
  });

  it("omite dias vazios quando pedido (mês)", () => {
    const groups = groupOccurrencesByDay({
      fromDate: "2026-09-01",
      toDate: "2026-09-30",
      occurrences: [occurrence()],
      timeZone: TZ,
      includeEmptyDays: false,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].dayKey).toBe("2026-09-10");
  });

  it("marca feriado no dia certo", () => {
    const groups = groupOccurrencesByDay({
      fromDate: "2026-09-07",
      toDate: "2026-09-07",
      occurrences: [],
      holidays: [{ date: "2026-09-07", name: "Independência do Brasil" }],
      timeZone: TZ,
    });
    expect(groups[0].holidayName).toBe("Independência do Brasil");
  });

  it("ordena dia inteiro antes, depois por horário e título", () => {
    const groups = groupOccurrencesByDay({
      fromDate: "2026-09-10",
      toDate: "2026-09-10",
      occurrences: [
        occurrence({
          occurrenceKey: "b",
          title: "Zebra",
          startsAtUtc: new Date("2026-09-10T15:00:00Z"),
        }),
        occurrence({
          occurrenceKey: "c",
          title: "Alfa",
          startsAtUtc: new Date("2026-09-10T15:00:00Z"),
        }),
        occurrence({
          occurrenceKey: "a",
          title: "Inteiro",
          allDay: true,
          startsAtUtc: new Date("2026-09-10T03:00:00Z"),
        }),
      ],
      timeZone: TZ,
    });
    expect(groups[0].occurrences.map((o) => o.title)).toEqual([
      "Inteiro",
      "Alfa",
      "Zebra",
    ]);
  });

  it("a ordenação é estável entre renderizações", () => {
    const left = occurrence({ occurrenceKey: "a", title: "Igual" });
    const right = occurrence({ occurrenceKey: "b", title: "Igual" });
    expect(compareOccurrences(left, right)).toBeLessThan(0);
    expect(compareOccurrences(right, left)).toBeGreaterThan(0);
  });
});

describe("rótulos e disponibilidade", () => {
  it("só compromisso ocupado bloqueia horário", () => {
    expect(blocksTime({ kind: "APPOINTMENT", availability: "BUSY" })).toBe(
      true,
    );
    expect(blocksTime({ kind: "APPOINTMENT", availability: "FREE" })).toBe(
      false,
    );
    expect(blocksTime({ kind: "REMINDER", availability: "FREE" })).toBe(false);
    expect(blocksTime({ kind: "BIRTHDAY", availability: "FREE" })).toBe(false);
  });

  it("rótulo acompanha a regra", () => {
    expect(
      availabilityLabel({ kind: "APPOINTMENT", availability: "BUSY" }),
    ).toBe("Ocupado");
    expect(availabilityLabel({ kind: "REMINDER", availability: "FREE" })).toBe(
      "Livre",
    );
  });

  it("lembrete mostra um instante, não um intervalo", () => {
    expect(
      formatOccurrenceTime(
        {
          kind: "REMINDER",
          allDay: false,
          startsAtUtc: new Date("2026-09-10T11:00:00Z"),
          endsAtUtc: new Date("2026-09-10T11:00:00Z"),
        },
        TZ,
      ),
    ).toBe("08:00");
  });

  it("compromisso mostra intervalo no relógio local", () => {
    expect(formatOccurrenceTime(occurrence(), TZ)).toBe("08:00 – 09:00");
  });

  it("dia inteiro não inventa horário", () => {
    expect(formatOccurrenceTime(occurrence({ allDay: true }), TZ)).toBe(
      "Dia inteiro",
    );
  });

  it("copy em português para cada tipo", () => {
    expect(PERSONAL_CALENDAR_KIND_LABELS).toEqual({
      APPOINTMENT: "Compromisso",
      REMINDER: "Lembrete",
      BIRTHDAY: "Aniversário",
    });
  });
});

describe("conflito com plantão próprio", () => {
  it("sem conflito não gera texto", () => {
    expect(conflictSummaryText(undefined)).toBeNull();
    expect(
      conflictSummaryText({
        hasConflict: false,
        total: 0,
        truncated: false,
        conflicts: [],
      }),
    ).toBeNull();
  });

  it("um conflito nomeia setor e hospital", () => {
    expect(
      conflictSummaryText({
        hasConflict: true,
        total: 1,
        truncated: false,
        conflicts: [
          { kind: "SHIFT", sectorName: "UTI", hospitalName: "São Carlos" },
        ],
      }),
    ).toBe("Conflito com plantão: UTI · São Carlos");
  });

  it("vários conflitos contam, e truncado mostra o sinal de mais", () => {
    expect(
      conflictSummaryText({
        hasConflict: true,
        total: 3,
        truncated: false,
        conflicts: [{ kind: "SHIFT" }],
      }),
    ).toBe("Conflito com 3 plantões");
    expect(
      conflictSummaryText({
        hasConflict: true,
        total: 20,
        truncated: true,
        conflicts: [{ kind: "SHIFT" }],
      }),
    ).toBe("Conflito com 20+ plantões");
  });

  it("o rótulo de acessibilidade carrega o conflito", () => {
    const label = accessibilityLabelForOccurrence(
      occurrence({
        locationLabel: "Clínica",
        conflict: {
          hasConflict: true,
          total: 1,
          truncated: false,
          conflicts: [
            { kind: "SHIFT", sectorName: "UTI", hospitalName: "HSC" },
          ],
        },
      }),
      TZ,
    );
    expect(label).toContain("Compromisso");
    expect(label).toContain("08:00 – 09:00");
    expect(label).toContain("ocupa horário");
    expect(label).toContain("Clínica");
    expect(label).toContain("Conflito");
  });
});

describe("estado da tela", () => {
  /**
   * "Nenhum compromisso" e "não consegui carregar" levam a decisões opostas.
   * Trocar um pelo outro faz o médico concluir que a agenda está limpa
   * quando ela apenas não carregou.
   */
  it("erro nunca vira estado vazio", () => {
    expect(
      resolvePersonalCalendarScreenState({
        isLoading: false,
        isError: true,
        groups: [],
      }),
    ).toEqual({ kind: "ERROR" });
    expect(
      resolvePersonalCalendarScreenState({
        isLoading: true,
        isError: true,
        groups: null,
      }),
    ).toEqual({ kind: "ERROR" });
  });

  it("carregando não vira vazio", () => {
    expect(
      resolvePersonalCalendarScreenState({
        isLoading: true,
        isError: false,
        groups: null,
      }),
    ).toEqual({ kind: "LOADING" });
  });

  it("janela sem nenhuma ocorrência é vazio de verdade", () => {
    const groups = groupOccurrencesByDay({
      fromDate: "2026-09-07",
      toDate: "2026-09-13",
      occurrences: [],
      timeZone: TZ,
    });
    expect(
      resolvePersonalCalendarScreenState({
        isLoading: false,
        isError: false,
        groups,
      }),
    ).toEqual({ kind: "EMPTY" });
  });

  it("com ocorrência entrega os grupos", () => {
    const groups = groupOccurrencesByDay({
      fromDate: "2026-09-10",
      toDate: "2026-09-10",
      occurrences: [occurrence()],
      timeZone: TZ,
    });
    const state = resolvePersonalCalendarScreenState({
      isLoading: false,
      isError: false,
      groups,
    });
    expect(state.kind).toBe("READY");
  });
});

describe("privacidade das anotações", () => {
  /**
   * `notes` é conteúdo privado e longo — pode conter informação clínica. O
   * contrato de listagem não o entrega, e a tela não pode reintroduzi-lo.
   */
  it("a ocorrência de listagem não carrega notes", () => {
    expect(listingExposesNotes(occurrence())).toBe(false);
  });

  it("a tela de lista não lê notes de lugar nenhum", () => {
    for (const file of [
      "../components/agenda/PersonalCalendarDaySection.tsx",
      "../app/personal-calendar.tsx",
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, `${file} não pode exibir notes`).not.toMatch(/\bnotes\b/);
    }
  });
});

describe("recorrência e alertas", () => {
  it("bitmask de dias da semana vai e volta", () => {
    expect(weekdaysMaskFromIndexes([0, 2, 4])).toBe(1 + 4 + 16);
    expect(weekdayIndexesFromMask(21)).toEqual([0, 2, 4]);
    expect(weekdaysMaskFromIndexes([])).toBe(0);
  });

  it("resumo de recorrência em português", () => {
    expect(recurrenceSummary(null)).toBe("Não se repete");
    expect(
      recurrenceSummary({
        frequency: "WEEKLY",
        interval: 1,
        weekdaysMask: weekdaysMaskFromIndexes([0, 2]),
        termination: "NEVER",
        untilLocalDate: null,
        occurrenceCount: null,
      }),
    ).toBe("Toda semana: Seg, Qua");
    expect(
      recurrenceSummary({
        frequency: "DAILY",
        interval: 3,
        weekdaysMask: null,
        termination: "COUNT",
        untilLocalDate: null,
        occurrenceCount: 10,
      }),
    ).toBe("a cada 3 dias, 10 vezes");
    expect(
      recurrenceSummary({
        frequency: "MONTHLY",
        interval: 1,
        weekdaysMask: null,
        termination: "UNTIL",
        untilLocalDate: "2027-03-01",
        occurrenceCount: null,
      }),
    ).toBe("Todo mês, até 01/03/2027");
  });

  it("resumo de alertas ordena e nomeia", () => {
    expect(alertOffsetsSummary([])).toBe("Sem alerta");
    expect(alertOffsetsSummary([60, 15])).toBe(
      "15 minutos antes · 1 hora antes",
    );
  });

  it("o teto de seleção acompanha o do domínio, não o tamanho do catálogo", () => {
    // Antes o catálogo tinha 8 opções e estourar era impossível; a garantia
    // vinha de manter a lista pequena. Com 12 opções ela precisa vir daqui:
    // o número da tela e o do servidor não podem se soltar.
    const domain = readFileSync("server/personal-calendar-domain.ts", "utf8");
    const declared = /const MAX_ALERT_RULES = (\d+);/.exec(domain);
    expect(declared, "MAX_ALERT_RULES não encontrado no domínio").not.toBeNull();
    expect(Number(declared![1])).toBe(MAX_ALERT_SELECTION);

    // E a tela precisa de fato cortar nesse número — uma constante que
    // ninguém aplica é decoração.
    const screen = readFileSync("app/personal-event.tsx", "utf8");
    expect(screen).toContain("slice(0, MAX_ALERT_SELECTION)");
  });

  it("toda opção de alerta é aceita pelo servidor", () => {
    // O schema do domínio aceita inteiros de 0 a 525.600 minutos (um ano).
    expect(
      ALERT_OFFSET_OPTIONS.every(
        (option) =>
          Number.isInteger(option.minutes) &&
          option.minutes >= 0 &&
          option.minutes <= 525_600,
      ),
    ).toBe(true);
    // Sem duplicata: o servidor recusa a lista inteira se houver.
    const minutes = ALERT_OFFSET_OPTIONS.map((option) => option.minutes);
    expect(new Set(minutes).size).toBe(minutes.length);
  });
});

describe("conformidade de UI com as convenções do repositório", () => {
  const screens = [
    "../app/personal-calendar.tsx",
    "../app/personal-event.tsx",
    "../components/agenda/PersonalCalendarDaySection.tsx",
  ];

  it("nenhuma cor literal fora dos tokens do tema", () => {
    for (const file of screens) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      const literals = source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      expect(literals, `${file} usa cor literal`).toEqual([]);
      expect(source, `${file} deve usar theme`).toContain("@/lib/theme");
    }
  });

  it("erro de query usa QueryErrorState, nunca empty state", () => {
    for (const file of [
      "../app/personal-calendar.tsx",
      "../app/personal-event.tsx",
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, `${file} precisa tratar isError`).toContain(
        "QueryErrorState",
      );
    }
  });

  it("nenhum Alert.alert ou window.alert direto", () => {
    for (const file of screens) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(/Alert\.alert\(/);
      expect(source).not.toMatch(/window\.(alert|confirm)\(/);
    }
  });

  it("a exclusão passa por confirmação destrutiva", () => {
    const source = readFileSync(
      new URL("../app/personal-event.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("confirmDestructive");
  });

  it("alvo de toque mínimo de 44pt nos controles", () => {
    for (const file of screens) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      const smallTargets = source.match(/minHeight:\s*(\d+)/g) ?? [];
      for (const match of smallTargets) {
        const value = Number(match.replace(/\D/g, ""));
        // 36 é o tamanho `sm` do AppButton, permitido para chips; abaixo
        // disso nada é tocável com segurança.
        expect(value, `${file} tem alvo de ${value}pt`).toBeGreaterThanOrEqual(
          36,
        );
      }
    }
  });

  it("a agenda pessoal não depende de tenant ativo", () => {
    for (const file of screens) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, `${file} não pode ler instituição`).not.toMatch(
        /institutionId|useTenantState|roleInInstitution|managerScope/,
      );
    }
  });
});
