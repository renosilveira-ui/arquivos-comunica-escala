import { describe, expect, it } from "vitest";

import {
  MAX_PERSONAL_CALENDAR_QUERY_DAYS,
  PersonalCalendarValidationError,
  generatePersonalCalendarOccurrences,
  personalCalendarOccurrenceWindowSchema,
  validatePersonalCalendarWindow,
} from "../server/personal-calendar-domain";

const ITEM = {
  kind: "APPOINTMENT" as const,
  title: "Consulta",
  allDay: false,
  availability: "BUSY" as const,
  startLocalDate: "2026-09-10",
  startLocalTime: "08:00",
  endLocalDate: "2026-09-10",
  endLocalTime: "09:00",
  timeZone: "America/Sao_Paulo",
};

describe("janela da Agenda pessoal — invariante na borda de entrada", () => {
  /**
   * Antes desta frente a regra só existia dentro da expansão de ocorrências,
   * que nem sempre roda. Uma janela invertida numa conta vazia passava; na
   * mesma conta com um compromisso, virava 500. O contrato agora é único e
   * é aplicado antes de tocar o banco.
   */
  it("recusa janela que termina antes de começar", () => {
    const parsed = personalCalendarOccurrenceWindowSchema.safeParse({
      fromDate: "2026-09-30",
      toDate: "2026-09-01",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0].message).toBe(
      "A janela termina antes de começar.",
    );
    expect(parsed.error.issues[0].path).toEqual(["toDate"]);
  });

  it("recusa janela maior que o teto de consulta", () => {
    const parsed = personalCalendarOccurrenceWindowSchema.safeParse({
      fromDate: "2026-01-01",
      toDate: "2027-12-31",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0].message).toContain(
      String(MAX_PERSONAL_CALENDAR_QUERY_DAYS),
    );
  });

  it("aceita exatamente o teto e recusa um dia além", () => {
    const start = new Date(Date.UTC(2026, 0, 1));
    const atLimit = new Date(start);
    atLimit.setUTCDate(
      atLimit.getUTCDate() + MAX_PERSONAL_CALENDAR_QUERY_DAYS - 1,
    );
    const beyond = new Date(atLimit);
    beyond.setUTCDate(beyond.getUTCDate() + 1);
    const key = (date: Date) => date.toISOString().slice(0, 10);

    expect(
      personalCalendarOccurrenceWindowSchema.safeParse({
        fromDate: key(start),
        toDate: key(atLimit),
      }).success,
    ).toBe(true);
    expect(
      personalCalendarOccurrenceWindowSchema.safeParse({
        fromDate: key(start),
        toDate: key(beyond),
      }).success,
    ).toBe(false);
  });

  it("aceita janela de um único dia", () => {
    expect(
      personalCalendarOccurrenceWindowSchema.safeParse({
        fromDate: "2026-09-10",
        toDate: "2026-09-10",
      }).success,
    ).toBe(true);
  });

  it("a regra continua valendo para quem chama o domínio direto", () => {
    expect(() =>
      validatePersonalCalendarWindow({
        fromDate: "2026-09-30",
        toDate: "2026-09-01",
      }),
    ).toThrow(PersonalCalendarValidationError);
    expect(() =>
      generatePersonalCalendarOccurrences(ITEM, null, {
        fromDate: "2026-09-30",
        toDate: "2026-09-01",
      }),
    ).toThrow(PersonalCalendarValidationError);
  });

  it("janela válida continua expandindo normalmente", () => {
    const occurrences = generatePersonalCalendarOccurrences(ITEM, null, {
      fromDate: "2026-09-01",
      toDate: "2026-09-30",
    });
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].startsAtUtc.toISOString()).toBe(
      "2026-09-10T11:00:00.000Z",
    );
  });
});
