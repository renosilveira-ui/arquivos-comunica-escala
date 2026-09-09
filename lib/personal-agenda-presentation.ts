import { formatHospitalTime } from "./hospital-time";

export const AGENDA_DAY_PERIODS = ["MORNING", "AFTERNOON", "NIGHT"] as const;
export type AgendaDayPeriod = (typeof AGENDA_DAY_PERIODS)[number];
export type AgendaPeriodSignal = "EMPTY" | "BUSY" | "OFFER";
export type AgendaDaySurface =
  "OUTSIDE_MONTH" | "SUNDAY_OR_HOLIDAY" | "SATURDAY" | "SELECTED" | "PLAIN";

export type PersonalAgendaOccurrence = Readonly<{
  itemId: number;
  itemVersion: number;
  occurrenceKey: string;
  title: string;
  kind: "APPOINTMENT" | "REMINDER" | "BIRTHDAY";
  availability: "BUSY" | "FREE";
  originalLocalDate: string;
  originalLocalTime: string | null;
  localDateKeys: readonly string[];
  localEndDate: string | null;
  localEndTime: string | null;
  localEndExclusive: boolean;
  allDay: boolean;
  locationLabel: string | null;
  alertOffsets: readonly number[];
  startsAtUtc: Date | string;
  endsAtUtc: Date | string;
  conflict: Readonly<{ hasConflict: boolean; total: number }>;
}>;

type ShiftSignal = Readonly<{ startAt: Date | string }>;
type OfferSignal = Readonly<{ startAt: Date | string }>;

export type AgendaDayPresentation = Readonly<{
  periods: readonly [
    AgendaPeriodSignal,
    AgendaPeriodSignal,
    AgendaPeriodSignal,
  ];
  hasAppointment: boolean;
  hasReminder: boolean;
  hasBirthday: boolean;
}>;

function minutesOf(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

export function agendaDaySurface(input: {
  inMonth: boolean;
  isSunday: boolean;
  isSaturday: boolean;
  isHoliday: boolean;
  isSelected: boolean;
}): AgendaDaySurface {
  if (!input.inMonth) return "OUTSIDE_MONTH";
  if (input.isSunday || input.isHoliday) return "SUNDAY_OR_HOLIDAY";
  if (input.isSelected) return "SELECTED";
  if (input.isSaturday) return "SATURDAY";
  return "PLAIN";
}

export function agendaPeriodFromLocalTime(time: string): AgendaDayPeriod {
  const minutes = minutesOf(time);
  if (minutes >= 6 * 60 && minutes < 12 * 60) return "MORNING";
  if (minutes >= 12 * 60 && minutes < 18 * 60) return "AFTERNOON";
  return "NIGHT";
}

export function agendaPeriodFromHospitalInstant(
  value: Date | string,
): AgendaDayPeriod {
  return agendaPeriodFromLocalTime(formatHospitalTime(value));
}

function periodIndex(period: AgendaDayPeriod): number {
  return AGENDA_DAY_PERIODS.indexOf(period);
}

function intervalOverlaps(
  start: number,
  end: number,
  intervalStart: number,
  intervalEnd: number,
): boolean {
  return start < intervalEnd && intervalStart < end;
}

function appointmentPeriodsOnDay(
  occurrence: PersonalAgendaOccurrence,
  dateKey: string,
): AgendaDayPeriod[] {
  if (occurrence.allDay) return [...AGENDA_DAY_PERIODS];
  if (
    occurrence.originalLocalTime === null ||
    occurrence.localEndDate === null ||
    occurrence.localEndTime === null
  ) {
    return [];
  }

  const start =
    dateKey === occurrence.originalLocalDate
      ? minutesOf(occurrence.originalLocalTime)
      : 0;
  const end =
    dateKey === occurrence.localEndDate
      ? minutesOf(occurrence.localEndTime)
      : 24 * 60;
  if (end <= start) return [];

  const periods: AgendaDayPeriod[] = [];
  if (
    intervalOverlaps(start, end, 0, 6 * 60) ||
    intervalOverlaps(start, end, 18 * 60, 24 * 60)
  ) {
    periods.push("NIGHT");
  }
  if (intervalOverlaps(start, end, 6 * 60, 12 * 60)) {
    periods.push("MORNING");
  }
  if (intervalOverlaps(start, end, 12 * 60, 18 * 60)) {
    periods.push("AFTERNOON");
  }
  return periods;
}

export function personalOccurrencesOnDay(
  occurrences: readonly PersonalAgendaOccurrence[],
  dateKey: string,
): PersonalAgendaOccurrence[] {
  return occurrences
    .filter((occurrence) => occurrence.localDateKeys.includes(dateKey))
    .sort((left, right) => {
      if (left.allDay !== right.allDay) return left.allDay ? -1 : 1;
      const time = (left.originalLocalTime ?? "").localeCompare(
        right.originalLocalTime ?? "",
      );
      return time || left.title.localeCompare(right.title, "pt-BR");
    });
}

export function buildAgendaDayPresentation(input: {
  dateKey: string;
  shifts: readonly ShiftSignal[];
  offers: readonly OfferSignal[];
  personalOccurrences: readonly PersonalAgendaOccurrence[];
}): AgendaDayPresentation {
  const periods: AgendaPeriodSignal[] = ["EMPTY", "EMPTY", "EMPTY"];
  const setBusy = (period: AgendaDayPeriod) => {
    const index = periodIndex(period);
    if (periods[index] === "EMPTY") periods[index] = "BUSY";
  };
  const setOffer = (period: AgendaDayPeriod) => {
    periods[periodIndex(period)] = "OFFER";
  };

  for (const shift of input.shifts) {
    setBusy(agendaPeriodFromHospitalInstant(shift.startAt));
  }
  for (const occurrence of input.personalOccurrences) {
    if (
      occurrence.kind !== "APPOINTMENT" ||
      !occurrence.localDateKeys.includes(input.dateKey)
    ) {
      continue;
    }
    for (const period of appointmentPeriodsOnDay(occurrence, input.dateKey)) {
      setBusy(period);
    }
  }
  // Oferta tem precedência visual sobre plantão/compromisso no mesmo turno.
  for (const offer of input.offers) {
    setOffer(agendaPeriodFromHospitalInstant(offer.startAt));
  }

  const onDay = personalOccurrencesOnDay(
    input.personalOccurrences,
    input.dateKey,
  );
  return {
    periods: periods as [
      AgendaPeriodSignal,
      AgendaPeriodSignal,
      AgendaPeriodSignal,
    ],
    hasAppointment: onDay.some(
      (occurrence) => occurrence.kind === "APPOINTMENT",
    ),
    hasReminder: onDay.some((occurrence) => occurrence.kind === "REMINDER"),
    hasBirthday: onDay.some((occurrence) => occurrence.kind === "BIRTHDAY"),
  };
}

export function greetingForHour(
  hour: number,
): "Bom dia" | "Boa tarde" | "Boa noite" {
  if (hour >= 5 && hour < 12) return "Bom dia";
  if (hour >= 12 && hour < 18) return "Boa tarde";
  return "Boa noite";
}

export function personalOccurrenceTimeLabel(
  occurrence: PersonalAgendaOccurrence,
): string {
  if (occurrence.allDay) return "Dia inteiro";
  const start = occurrence.originalLocalTime?.slice(0, 5) ?? "";
  if (occurrence.kind !== "APPOINTMENT") return start;
  const end = occurrence.localEndTime?.slice(0, 5) ?? "";
  return end ? `${start}–${end}` : start;
}
