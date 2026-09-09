import { describe, expect, it } from "vitest";

import {
  agendaDaySurface,
  buildAgendaDayPresentation,
  personalOccurrenceTimeLabel,
  personalOccurrencesOnDay,
  type PersonalAgendaOccurrence,
} from "../lib/personal-agenda-presentation";
import {
  generatePersonalCalendarOccurrences,
  personalCalendarOccurrenceLocalDates,
  personalCalendarOccurrenceLocalEnd,
  type PersonalCalendarItemDraft,
} from "../server/personal-calendar-domain";

function occurrence(
  patch: Partial<PersonalAgendaOccurrence> = {},
): PersonalAgendaOccurrence {
  return {
    itemId: 1,
    itemVersion: 1,
    occurrenceKey: "2026-09-10T11:00:00",
    title: "Consulta",
    kind: "APPOINTMENT",
    availability: "BUSY",
    originalLocalDate: "2026-09-10",
    originalLocalTime: "11:00:00",
    localDateKeys: ["2026-09-10"],
    localEndDate: "2026-09-10",
    localEndTime: "19:00:00",
    localEndExclusive: false,
    allDay: false,
    locationLabel: null,
    alertOffsets: [],
    startsAtUtc: new Date("2026-09-10T14:00:00Z"),
    endsAtUtc: new Date("2026-09-10T22:00:00Z"),
    conflict: { hasConflict: false, total: 0 },
    ...patch,
  };
}

describe("apresentação da Agenda pessoal", () => {
  it("reserva vermelho para domingo/feriado e cinza para sábado", () => {
    expect(
      agendaDaySurface({
        inMonth: true,
        isSunday: false,
        isSaturday: false,
        isHoliday: true,
        isSelected: true,
      }),
    ).toBe("SUNDAY_OR_HOLIDAY");
    expect(
      agendaDaySurface({
        inMonth: true,
        isSunday: false,
        isSaturday: true,
        isHoliday: false,
        isSelected: false,
      }),
    ).toBe("SATURDAY");
    expect(
      agendaDaySurface({
        inMonth: false,
        isSunday: true,
        isSaturday: false,
        isHoliday: true,
        isSelected: true,
      }),
    ).toBe("OUTSIDE_MONTH");
  });

  it("usa três turnos fixos e dá precedência ao azul de oferta", () => {
    expect(
      buildAgendaDayPresentation({
        dateKey: "2026-09-10",
        shifts: [{ startAt: "2026-09-10T10:00:00Z" }], // 07h hospital
        offers: [{ startAt: "2026-09-10T16:00:00Z" }], // 13h hospital
        personalOccurrences: [occurrence()], // 11h–19h: manhã/tarde/noite
      }),
    ).toEqual({
      periods: ["BUSY", "OFFER", "BUSY"],
      hasAppointment: true,
      hasReminder: false,
      hasBirthday: false,
    });
  });

  it("mostra lembrete e aniversário como insígnias, sem ocupar turno", () => {
    const reminder = occurrence({
      itemId: 2,
      kind: "REMINDER",
      allDay: true,
      originalLocalTime: null,
      localEndDate: null,
      localEndTime: null,
    });
    const birthday = occurrence({
      itemId: 3,
      kind: "BIRTHDAY",
      allDay: true,
      originalLocalTime: null,
      localEndDate: null,
      localEndTime: null,
    });
    expect(
      buildAgendaDayPresentation({
        dateKey: "2026-09-10",
        shifts: [],
        offers: [],
        personalOccurrences: [reminder, birthday],
      }),
    ).toMatchObject({
      periods: ["EMPTY", "EMPTY", "EMPTY"],
      hasReminder: true,
      hasBirthday: true,
    });
  });

  it("ordena itens do dia e formata hora sem converter pelo fuso do aparelho", () => {
    const timed = occurrence();
    const allDay = occurrence({
      itemId: 2,
      title: "Dia inteiro",
      allDay: true,
      originalLocalTime: null,
      localEndTime: null,
    });
    expect(personalOccurrencesOnDay([timed, allDay], "2026-09-10")).toEqual([
      allDay,
      timed,
    ]);
    expect(personalOccurrenceTimeLabel(timed)).toBe("11:00–19:00");
  });

  it("deriva no servidor todos os dias civis de um compromisso recorrente", () => {
    const item: PersonalCalendarItemDraft = {
      kind: "APPOINTMENT",
      title: "Congresso",
      allDay: true,
      availability: "BUSY",
      startLocalDate: "2026-09-10",
      endLocalDate: "2026-09-13",
      timeZone: "America/Fortaleza",
      locationLabel: null,
      locationProvider: null,
      locationExternalId: null,
      latitude: null,
      longitude: null,
      notes: null,
    };
    const generated = generatePersonalCalendarOccurrences(item, null, {
      fromDate: "2026-09-01",
      toDate: "2026-09-30",
    })[0];
    expect(personalCalendarOccurrenceLocalDates(item, generated)).toEqual([
      "2026-09-10",
      "2026-09-11",
      "2026-09-12",
    ]);
    expect(personalCalendarOccurrenceLocalEnd(item, generated)).toEqual({
      date: "2026-09-13",
      time: null,
      exclusive: true,
    });
  });

  it("não mostra em um novo dia um compromisso que termina exatamente à meia-noite", () => {
    const item: PersonalCalendarItemDraft = {
      kind: "APPOINTMENT",
      title: "Evento noturno",
      allDay: false,
      availability: "BUSY",
      startLocalDate: "2026-09-10",
      startLocalTime: "20:00:00",
      endLocalDate: "2026-09-11",
      endLocalTime: "00:00:00",
      timeZone: "America/Fortaleza",
      locationLabel: null,
      locationProvider: null,
      locationExternalId: null,
      latitude: null,
      longitude: null,
      notes: null,
    };
    const generated = generatePersonalCalendarOccurrences(item, null, {
      fromDate: "2026-09-01",
      toDate: "2026-09-30",
    })[0];

    expect(personalCalendarOccurrenceLocalDates(item, generated)).toEqual([
      "2026-09-10",
    ]);
  });
});
