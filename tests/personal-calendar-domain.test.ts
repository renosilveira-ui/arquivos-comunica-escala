import { describe, expect, it } from "vitest";

import {
  PersonalCalendarValidationError,
  civilDateTimeToInstant,
  generatePersonalCalendarOccurrences,
  personalCalendarAlertOffsetsSchema,
  personalCalendarConflictSearchWindows,
  personalCalendarIntervalsOverlap,
  personalCalendarItemBlocksTime,
  personalCalendarItemDraftSchema,
  personalCalendarRecurrenceSchema,
  validatePersonalCalendarSeries,
} from "../server/personal-calendar-domain";

const FORTALEZA = "America/Fortaleza";

function timedAppointment(overrides: Record<string, unknown> = {}) {
  return {
    kind: "APPOINTMENT",
    title: "Consulta",
    allDay: false,
    availability: "BUSY",
    startLocalDate: "2026-09-10",
    startLocalTime: "09:00",
    endLocalDate: "2026-09-10",
    endLocalTime: "10:00",
    timeZone: FORTALEZA,
    ...overrides,
  };
}

function allDayAppointment(overrides: Record<string, unknown> = {}) {
  return {
    kind: "APPOINTMENT",
    title: "Congresso",
    allDay: true,
    availability: "BUSY",
    startLocalDate: "2026-09-10",
    endLocalDate: "2026-09-11",
    timeZone: FORTALEZA,
    ...overrides,
  };
}

function allDayReminder(overrides: Record<string, unknown> = {}) {
  return {
    kind: "REMINDER",
    title: "Lembrete",
    allDay: true,
    availability: "FREE",
    startLocalDate: "2026-09-01",
    timeZone: FORTALEZA,
    ...overrides,
  };
}

function recurrence(overrides: Record<string, unknown> = {}) {
  return {
    frequency: "DAILY",
    interval: 1,
    weekdaysMask: null,
    invalidDatePolicy: "SKIP",
    termination: "NEVER",
    untilLocalDate: null,
    occurrenceCount: null,
    ...overrides,
  };
}

function occurrenceDates(
  item: unknown,
  rule: unknown | null,
  fromDate: string,
  toDate: string,
) {
  return generatePersonalCalendarOccurrences(item, rule, {
    fromDate,
    toDate,
  }).map((occurrence) => occurrence.originalLocalDate);
}

describe("agenda pessoal — validação de entrada", () => {
  it("normaliza texto/hora e rejeita formas incompletas de localização", () => {
    const parsed = personalCalendarItemDraftSchema.parse(
      timedAppointment({
        title: "  Reunião  ",
        locationProvider: "google",
        locationExternalId: "place-1",
        latitude: -3.7319,
        longitude: -38.5267,
      }),
    );

    expect(parsed.title).toBe("Reunião");
    expect(parsed.startLocalTime).toBe("09:00:00");
    expect(
      personalCalendarItemDraftSchema.safeParse(
        timedAppointment({ locationProvider: "google" }),
      ).success,
    ).toBe(false);
    expect(
      personalCalendarItemDraftSchema.safeParse(
        timedAppointment({ latitude: -3.7 }),
      ).success,
    ).toBe(false);
  });

  it("rejeita datas, intervalos, fusos e aniversários inválidos", () => {
    expect(
      personalCalendarItemDraftSchema.safeParse(
        timedAppointment({ startLocalDate: "2026-02-29" }),
      ).success,
    ).toBe(false);
    expect(
      personalCalendarItemDraftSchema.safeParse(
        timedAppointment({ startLocalTime: "25:99" }),
      ).success,
    ).toBe(false);
    expect(
      personalCalendarItemDraftSchema.safeParse(
        timedAppointment({ endLocalTime: "08:59" }),
      ).success,
    ).toBe(false);
    expect(
      personalCalendarItemDraftSchema.safeParse(
        timedAppointment({ timeZone: "Fortaleza" }),
      ).success,
    ).toBe(false);
    expect(
      personalCalendarItemDraftSchema.safeParse({
        kind: "BIRTHDAY",
        title: "Data impossível",
        birthdayMonth: 4,
        birthdayDay: 31,
        birthdayYear: 1800,
        timeZone: FORTALEZA,
      }).success,
    ).toBe(false);
    expect(
      personalCalendarItemDraftSchema.safeParse(
        allDayAppointment({ endLocalDate: "2026-09-10" }),
      ).success,
    ).toBe(false);
    expect(
      personalCalendarItemDraftSchema.safeParse(
        allDayAppointment({
          startLocalDate: "2026-01-01",
          endLocalDate: "2027-01-03",
        }),
      ).success,
    ).toBe(false);
  });

  it("converte safeParse em erro de domínio, sem deixar horário civil lançar", () => {
    const nonexistent = personalCalendarItemDraftSchema.safeParse(
      timedAppointment({
        startLocalDate: "2026-03-08",
        endLocalDate: "2026-03-08",
        startLocalTime: "02:30",
        endLocalTime: "04:00",
        timeZone: "America/New_York",
      }),
    );
    const ambiguousReminder = personalCalendarItemDraftSchema.safeParse({
      kind: "REMINDER",
      title: "Hora ambígua",
      allDay: false,
      startLocalDate: "2026-11-01",
      startLocalTime: "01:30",
      timeZone: "America/New_York",
    });

    expect(nonexistent.success).toBe(false);
    expect(ambiguousReminder.success).toBe(false);
  });

  it("valida a forma completa das regras de recorrência", () => {
    expect(
      personalCalendarRecurrenceSchema.safeParse(
        recurrence({ frequency: "WEEKLY", weekdaysMask: null }),
      ).success,
    ).toBe(false);
    expect(() =>
      generatePersonalCalendarOccurrences(allDayReminder(), false, {
        fromDate: "2026-09-01",
        toDate: "2026-09-01",
      }),
    ).toThrow();
    expect(
      personalCalendarRecurrenceSchema.safeParse(
        recurrence({ weekdaysMask: 2 }),
      ).success,
    ).toBe(false);
    expect(
      personalCalendarRecurrenceSchema.safeParse(
        recurrence({
          termination: "COUNT",
          occurrenceCount: null,
        }),
      ).success,
    ).toBe(false);
  });

  it("rejeita combinações item-recorrência impossíveis antes da persistência", () => {
    expect(() =>
      validatePersonalCalendarSeries(
        {
          kind: "BIRTHDAY",
          title: "Ana",
          birthdayMonth: 9,
          birthdayDay: 10,
          timeZone: FORTALEZA,
        },
        recurrence({ frequency: "YEARLY" }),
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_RECURRENCE" }));
    expect(() =>
      validatePersonalCalendarSeries(
        allDayReminder({ startLocalDate: "2026-09-10" }),
        recurrence({
          termination: "UNTIL",
          untilLocalDate: "2026-09-09",
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_RECURRENCE" }));
  });

  it("aceita no máximo oito avisos únicos e devolve offsets ordenados", () => {
    expect(
      personalCalendarAlertOffsetsSchema.parse([30, 10_080, 60, 0]),
    ).toEqual([10_080, 60, 30, 0]);
    expect(personalCalendarAlertOffsetsSchema.safeParse([60, 60]).success).toBe(
      false,
    );
    expect(
      personalCalendarAlertOffsetsSchema.safeParse([1, 2, 3, 4, 5, 6, 7, 8, 9])
        .success,
    ).toBe(false);
  });
});

describe("agenda pessoal — relógio civil e fuso IANA", () => {
  it("usa o primeiro instante na sobreposição e rejeita quando solicitado", () => {
    const compatible = civilDateTimeToInstant(
      "2026-11-01",
      "01:30",
      "America/New_York",
      "COMPATIBLE",
    );

    expect(compatible.instant.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(compatible.adjustedForTimeZone).toBe(false);
    expect(() =>
      civilDateTimeToInstant(
        "2026-11-01",
        "01:30",
        "America/New_York",
        "REJECT",
      ),
    ).toThrowError(PersonalCalendarValidationError);
  });

  it("move horário inexistente pelo tamanho do salto no modo compatível", () => {
    const compatible = civilDateTimeToInstant(
      "2026-03-08",
      "02:30",
      "America/New_York",
      "COMPATIBLE",
    );

    expect(compatible.instant.toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(compatible.adjustedForTimeZone).toBe(true);
  });

  it("materializa de forma estável um horário de quarto de hora", () => {
    expect(
      civilDateTimeToInstant(
        "2026-09-10",
        "09:00",
        "Asia/Kathmandu",
      ).instant.toISOString(),
    ).toBe("2026-09-10T03:15:00.000Z");
  });

  it("cobre dois dias civis nas bordas sem ampliar a janela pública", () => {
    expect(
      personalCalendarConflictSearchWindows({
        fromDate: "2026-09-10",
        toDate: "2026-09-10",
      }),
    ).toEqual([
      { fromDate: "2026-09-08", toDate: "2026-09-09" },
      { fromDate: "2026-09-10", toDate: "2026-09-10" },
      { fromDate: "2026-09-11", toDate: "2026-09-12" },
    ]);
  });
});

describe("agenda pessoal — expansão limitada e determinística", () => {
  it("projeta compromisso pontual atravessando meia-noite e preserva [início, fim)", () => {
    const item = timedAppointment({
      startLocalDate: "2026-09-09",
      startLocalTime: "23:00",
      endLocalDate: "2026-09-10",
      endLocalTime: "01:00",
    });
    const occurrence = generatePersonalCalendarOccurrences(item, null, {
      fromDate: "2026-09-10",
      toDate: "2026-09-10",
    });

    expect(occurrence).toHaveLength(1);
    expect(occurrence[0].occurrenceKey).toBe("2026-09-09T23:00:00");
    expect(occurrence[0].startsAtUtc.toISOString()).toBe(
      "2026-09-10T02:00:00.000Z",
    );
    expect(occurrence[0].endsAtUtc.toISOString()).toBe(
      "2026-09-10T04:00:00.000Z",
    );
    expect(
      generatePersonalCalendarOccurrences(item, null, {
        fromDate: "2026-09-11",
        toDate: "2026-09-11",
      }),
    ).toEqual([]);
  });

  it("aplica intervalo e COUNT diário mesmo ao consultar uma janela tardia", () => {
    const rule = recurrence({
      interval: 2,
      termination: "COUNT",
      occurrenceCount: 3,
    });

    expect(
      occurrenceDates(allDayReminder(), rule, "2026-09-01", "2026-09-10"),
    ).toEqual(["2026-09-01", "2026-09-03", "2026-09-05"]);
    expect(
      occurrenceDates(allDayReminder(), rule, "2026-09-06", "2026-09-10"),
    ).toEqual([]);
  });

  it("ancora semana na segunda e conta múltiplos dias sem reiniciar por janela", () => {
    const item = allDayReminder({ startLocalDate: "2026-09-07" });
    const rule = recurrence({
      frequency: "WEEKLY",
      interval: 2,
      weekdaysMask: (1 << 1) | (1 << 3),
      termination: "COUNT",
      occurrenceCount: 4,
    });

    expect(occurrenceDates(item, rule, "2026-09-01", "2026-09-30")).toEqual([
      "2026-09-07",
      "2026-09-09",
      "2026-09-21",
      "2026-09-23",
    ]);
    expect(occurrenceDates(item, rule, "2026-10-01", "2026-10-31")).toEqual([]);
  });

  it("diferencia SKIP de CLAMP_LAST_DAY no dia 31", () => {
    const item = allDayReminder({ startLocalDate: "2026-01-31" });
    const skip = recurrence({ frequency: "MONTHLY" });
    const clamp = recurrence({
      frequency: "MONTHLY",
      invalidDatePolicy: "CLAMP_LAST_DAY",
    });

    expect(occurrenceDates(item, skip, "2026-01-01", "2026-04-30")).toEqual([
      "2026-01-31",
      "2026-03-31",
    ]);
    expect(occurrenceDates(item, clamp, "2026-01-01", "2026-04-30")).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
  });

  it("não conta meses inexistentes no limite COUNT de uma série SKIP", () => {
    const item = allDayReminder({ startLocalDate: "2026-01-31" });
    const rule = recurrence({
      frequency: "MONTHLY",
      termination: "COUNT",
      occurrenceCount: 2,
    });

    expect(occurrenceDates(item, rule, "2026-03-01", "2026-03-31")).toEqual([
      "2026-03-31",
    ]);
    expect(occurrenceDates(item, rule, "2026-05-01", "2026-05-31")).toEqual([]);
  });

  it("trata 29 de fevereiro explicitamente em recorrência anual", () => {
    const item = allDayReminder({ startLocalDate: "2024-02-29" });

    expect(
      occurrenceDates(
        item,
        recurrence({ frequency: "YEARLY" }),
        "2025-01-01",
        "2025-12-31",
      ),
    ).toEqual([]);
    expect(
      occurrenceDates(
        item,
        recurrence({
          frequency: "YEARLY",
          invalidDatePolicy: "CLAMP_LAST_DAY",
        }),
        "2025-01-01",
        "2025-12-31",
      ),
    ).toEqual(["2025-02-28"]);
    expect(
      occurrenceDates(
        item,
        recurrence({ frequency: "YEARLY" }),
        "2028-01-01",
        "2028-12-31",
      ),
    ).toEqual(["2028-02-29"]);
  });

  it("materializa aniversário em 29/2 como 28/2 nos anos comuns", () => {
    const birthday = {
      kind: "BIRTHDAY",
      title: "Ana",
      birthdayMonth: 2,
      birthdayDay: 29,
      birthdayYear: 2024,
      timeZone: FORTALEZA,
    };

    expect(occurrenceDates(birthday, null, "2026-01-01", "2026-12-31")).toEqual(
      ["2026-02-28"],
    );
    expect(occurrenceDates(birthday, null, "2023-01-01", "2023-12-31")).toEqual(
      [],
    );
  });

  it("limita a janela a 366 dias e recusa janela invertida", () => {
    expect(() =>
      generatePersonalCalendarOccurrences(allDayReminder(), null, {
        fromDate: "2026-01-01",
        toDate: "2027-01-02",
      }),
    ).toThrowError(expect.objectContaining({ code: "QUERY_WINDOW_TOO_LARGE" }));
    expect(() =>
      generatePersonalCalendarOccurrences(allDayReminder(), null, {
        fromDate: "2026-09-02",
        toDate: "2026-09-01",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_RANGE" }));
  });

  it("gera a mesma chave em chamadas repetidas", () => {
    const first = generatePersonalCalendarOccurrences(
      allDayReminder(),
      recurrence(),
      { fromDate: "2026-09-01", toDate: "2026-09-03" },
    );
    const second = generatePersonalCalendarOccurrences(
      allDayReminder(),
      recurrence(),
      { fromDate: "2026-09-01", toDate: "2026-09-03" },
    );

    expect(second.map((item) => item.occurrenceKey)).toEqual(
      first.map((item) => item.occurrenceKey),
    );
  });

  it("ajusta somente a ocorrência futura atingida por salto de horário", () => {
    const item = {
      kind: "REMINDER",
      title: "Revisão semanal",
      allDay: false,
      startLocalDate: "2026-03-01",
      startLocalTime: "02:30",
      timeZone: "America/New_York",
    };
    const occurrences = generatePersonalCalendarOccurrences(
      item,
      recurrence({ frequency: "WEEKLY", weekdaysMask: 1 }),
      { fromDate: "2026-03-01", toDate: "2026-03-08" },
    );

    expect(occurrences.map((value) => value.startsAtUtc.toISOString())).toEqual(
      ["2026-03-01T07:30:00.000Z", "2026-03-08T07:30:00.000Z"],
    );
    expect(occurrences.map((value) => value.adjustedForTimeZone)).toEqual([
      false,
      true,
    ]);
  });

  it("preserva duração quando um salto futuro inverteria o fim civil", () => {
    const item = timedAppointment({
      startLocalDate: "2026-03-01",
      startLocalTime: "02:30",
      endLocalDate: "2026-03-01",
      endLocalTime: "03:00",
      timeZone: "America/New_York",
    });
    const occurrences = generatePersonalCalendarOccurrences(
      item,
      recurrence({ frequency: "WEEKLY", weekdaysMask: 1 }),
      { fromDate: "2026-03-08", toDate: "2026-03-08" },
    );

    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].startsAtUtc.toISOString()).toBe(
      "2026-03-08T07:30:00.000Z",
    );
    expect(occurrences[0].endsAtUtc.toISOString()).toBe(
      "2026-03-08T08:00:00.000Z",
    );
    expect(occurrences[0].adjustedForTimeZone).toBe(true);
  });
});

describe("agenda pessoal — colisões", () => {
  it("considera contato de borda como não colisão", () => {
    expect(
      personalCalendarIntervalsOverlap(
        {
          startsAtUtc: new Date("2026-09-10T12:00:00Z"),
          endsAtUtc: new Date("2026-09-10T13:00:00Z"),
        },
        {
          startsAtUtc: new Date("2026-09-10T13:00:00Z"),
          endsAtUtc: new Date("2026-09-10T14:00:00Z"),
        },
      ),
    ).toBe(false);
    expect(
      personalCalendarIntervalsOverlap(
        {
          startsAtUtc: new Date("2026-09-10T12:00:00Z"),
          endsAtUtc: new Date("2026-09-10T13:01:00Z"),
        },
        {
          startsAtUtc: new Date("2026-09-10T13:00:00Z"),
          endsAtUtc: new Date("2026-09-10T14:00:00Z"),
        },
      ),
    ).toBe(true);
  });

  it("somente compromisso BUSY bloqueia horário", () => {
    expect(personalCalendarItemBlocksTime(timedAppointment())).toBe(true);
    expect(
      personalCalendarItemBlocksTime(
        timedAppointment({ availability: "FREE" }),
      ),
    ).toBe(false);
    expect(personalCalendarItemBlocksTime(allDayReminder())).toBe(false);
  });

  it("recusa intervalos corrompidos em vez de mascarar o conflito", () => {
    expect(() =>
      personalCalendarIntervalsOverlap(
        {
          startsAtUtc: new Date("invalid"),
          endsAtUtc: new Date("2026-09-10T13:00:00Z"),
        },
        {
          startsAtUtc: new Date("2026-09-10T13:00:00Z"),
          endsAtUtc: new Date("2026-09-10T14:00:00Z"),
        },
      ),
    ).toThrowError(expect.objectContaining({ code: "INVALID_RANGE" }));
  });
});
