import { z } from "zod";

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const MAX_QUERY_DAYS = 366;
const MAX_APPOINTMENT_SPAN_DAYS = 366;
const MAX_ALERT_RULES = 8;
const MAX_TIME_ZONE_FORMATTERS = 256;
const MIN_USER_YEAR = 1800;
const MAX_USER_YEAR = 2200;

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_KEY_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

export class PersonalCalendarValidationError extends Error {
  readonly code:
    | "INVALID_DATE"
    | "INVALID_TIME"
    | "INVALID_TIME_ZONE"
    | "INVALID_LOCAL_TIME"
    | "INVALID_RANGE"
    | "INVALID_RECURRENCE"
    | "QUERY_WINDOW_TOO_LARGE";

  constructor(code: PersonalCalendarValidationError["code"], message: string) {
    super(message);
    this.name = "PersonalCalendarValidationError";
    this.code = code;
  }
}

type CivilParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA-u-ca-gregory-nu-latn", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new PersonalCalendarValidationError(
      "INVALID_TIME_ZONE",
      "Fuso horário IANA inválido.",
    );
  }
  if (formatterCache.size < MAX_TIME_ZONE_FORMATTERS) {
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

function partsAt(instantMs: number, timeZone: string): CivilParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs));
  const values = new Map(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  const result = {
    year: values.get("year"),
    month: values.get("month"),
    day: values.get("day"),
    hour: values.get("hour"),
    minute: values.get("minute"),
    second: values.get("second"),
  };
  if (Object.values(result).some((value) => value === undefined)) {
    throw new PersonalCalendarValidationError(
      "INVALID_TIME_ZONE",
      "O runtime não conseguiu resolver o fuso horário.",
    );
  }
  return result as CivilParts;
}

function civilPartsEpoch(parts: CivilParts): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
}

function sameCivilParts(left: CivilParts, right: CivilParts): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute &&
    left.second === right.second
  );
}

function parseDateKey(dateKey: string): CivilParts {
  if (!DATE_KEY_PATTERN.test(dateKey)) {
    throw new PersonalCalendarValidationError(
      "INVALID_DATE",
      "Data civil inválida.",
    );
  }
  const [year, month, day] = dateKey.split("-").map(Number);
  const epoch = Date.UTC(year, month - 1, day);
  const normalized = new Date(epoch);
  if (
    year < 1000 ||
    year > 9999 ||
    normalized.getUTCFullYear() !== year ||
    normalized.getUTCMonth() !== month - 1 ||
    normalized.getUTCDate() !== day
  ) {
    throw new PersonalCalendarValidationError(
      "INVALID_DATE",
      "Data civil inválida.",
    );
  }
  return { year, month, day, hour: 0, minute: 0, second: 0 };
}

function normalizeTimeKey(timeKey: string): string {
  if (!TIME_KEY_PATTERN.test(timeKey)) {
    throw new PersonalCalendarValidationError(
      "INVALID_TIME",
      "Horário civil inválido.",
    );
  }
  return timeKey.length === 5 ? `${timeKey}:00` : timeKey;
}

function parseCivil(dateKey: string, timeKey: string): CivilParts {
  const date = parseDateKey(dateKey);
  const [hour, minute, second] = normalizeTimeKey(timeKey)
    .split(":")
    .map(Number);
  return { ...date, hour, minute, second };
}

function utcOffsetAt(instantMs: number, timeZone: string): number {
  const truncated = Math.floor(instantMs / 1000) * 1000;
  return civilPartsEpoch(partsAt(truncated, timeZone)) - truncated;
}

export type CivilTimeDisambiguation = "REJECT" | "COMPATIBLE";

export type CivilInstant = {
  instant: Date;
  adjustedForTimeZone: boolean;
};

/**
 * Converte relógio de parede + fuso IANA em instante UTC sem depender do fuso
 * do processo. COMPATIBLE escolhe o primeiro instante em sobreposição e move
 * horários inexistentes para a primeira representação civil posterior.
 */
export function civilDateTimeToInstant(
  dateKey: string,
  timeKey: string,
  timeZone: string,
  disambiguation: CivilTimeDisambiguation = "COMPATIBLE",
): CivilInstant {
  const target = parseCivil(dateKey, timeKey);
  formatterFor(timeZone);
  const naiveEpoch = civilPartsEpoch(target);
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    offsets.add(utcOffsetAt(naiveEpoch + hours * 60 * 60 * 1000, timeZone));
  }

  const candidates = [...offsets]
    .map((offset) => naiveEpoch - offset)
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((left, right) => left - right);
  const exact = candidates.filter((candidate) =>
    sameCivilParts(partsAt(candidate, timeZone), target),
  );

  if (
    exact.length === 1 ||
    (exact.length > 1 && disambiguation === "COMPATIBLE")
  ) {
    return { instant: new Date(exact[0]), adjustedForTimeZone: false };
  }
  if (exact.length > 1) {
    throw new PersonalCalendarValidationError(
      "INVALID_LOCAL_TIME",
      "O horário informado ocorre duas vezes neste fuso.",
    );
  }
  if (disambiguation === "REJECT") {
    throw new PersonalCalendarValidationError(
      "INVALID_LOCAL_TIME",
      "O horário informado não existe neste fuso.",
    );
  }

  const firstCivilAfterGap = candidates
    .map((candidate) => ({
      candidate,
      mappedCivilEpoch: civilPartsEpoch(partsAt(candidate, timeZone)),
    }))
    .filter(({ mappedCivilEpoch }) => mappedCivilEpoch > naiveEpoch)
    .sort(
      (left, right) =>
        left.mappedCivilEpoch - right.mappedCivilEpoch ||
        left.candidate - right.candidate,
    )[0];
  if (!firstCivilAfterGap) {
    throw new PersonalCalendarValidationError(
      "INVALID_LOCAL_TIME",
      "O horário informado não pode ser resolvido neste fuso.",
    );
  }
  return {
    instant: new Date(firstCivilAfterGap.candidate),
    adjustedForTimeZone: true,
  };
}

export function dateKeyToOrdinal(dateKey: string): number {
  const parts = parseDateKey(dateKey);
  return Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS;
}

export function addCivilDays(dateKey: string, days: number): string {
  if (!Number.isInteger(days)) {
    throw new PersonalCalendarValidationError(
      "INVALID_DATE",
      "Deslocamento de data inválido.",
    );
  }
  const date = new Date((dateKeyToOrdinal(dateKey) + days) * DAY_MS);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function compareDateKeys(left: string, right: string): number {
  return dateKeyToOrdinal(left) - dateKeyToOrdinal(right);
}

function weekdayOfDateKey(dateKey: string): number {
  return new Date(dateKeyToOrdinal(dateKey) * DAY_MS).getUTCDay();
}

function mondayOfDateKey(dateKey: string): string {
  const weekday = weekdayOfDateKey(dateKey);
  return addCivilDays(dateKey, weekday === 0 ? -6 : 1 - weekday);
}

function monthIndex(dateKey: string): number {
  const { year, month } = parseDateKey(dateKey);
  return year * 12 + month - 1;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dateKeyFromMonthIndex(
  index: number,
  desiredDay: number,
  invalidDatePolicy: "SKIP" | "CLAMP_LAST_DAY",
): string | null {
  const year = Math.floor(index / 12);
  const monthZero = ((index % 12) + 12) % 12;
  const month = monthZero + 1;
  const lastDay = daysInMonth(year, month);
  if (desiredDay > lastDay && invalidDatePolicy === "SKIP") return null;
  const day = Math.min(desiredDay, lastDay);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const titleSchema = z.string().trim().min(1).max(160);
const optionalTrimmed = (max: number) =>
  z.string().trim().min(1).max(max).nullable().optional().default(null);
const dateKeySchema = z.string().refine(
  (value) => {
    try {
      const { year } = parseDateKey(value);
      return year >= MIN_USER_YEAR && year <= MAX_USER_YEAR;
    } catch {
      return false;
    }
  },
  { message: "Data civil inválida." },
);
const timeKeySchema = z
  .string()
  .refine((value) => TIME_KEY_PATTERN.test(value), {
    message: "Horário civil inválido.",
  })
  .transform(normalizeTimeKey);
const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    (value) => {
      try {
        formatterFor(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: "Fuso horário IANA inválido." },
  );

function uniqueLocalInstantOrIssue(
  dateKey: string,
  timeKey: string,
  timeZone: string,
  context: z.core.$RefinementCtx,
  path: string,
): Date | null {
  try {
    return civilDateTimeToInstant(dateKey, timeKey, timeZone, "REJECT").instant;
  } catch (error) {
    if (error instanceof PersonalCalendarValidationError) {
      context.addIssue({
        code: "custom",
        path: [path],
        message: error.message,
      });
      return null;
    }
    throw error;
  }
}

const commonItemShape = {
  title: titleSchema,
  locationLabel: optionalTrimmed(255),
  locationProvider: optionalTrimmed(32),
  locationExternalId: optionalTrimmed(191),
  latitude: z.number().min(-90).max(90).nullable().optional().default(null),
  longitude: z.number().min(-180).max(180).nullable().optional().default(null),
  notes: z.string().trim().max(10_000).nullable().optional().default(null),
  timeZone: timeZoneSchema,
};

const appointmentTimedSchema = z
  .object({
    ...commonItemShape,
    kind: z.literal("APPOINTMENT"),
    allDay: z.literal(false),
    availability: z.enum(["BUSY", "FREE"]).default("BUSY"),
    startLocalDate: dateKeySchema,
    startLocalTime: timeKeySchema,
    endLocalDate: dateKeySchema,
    endLocalTime: timeKeySchema,
  })
  .strict();

const appointmentAllDaySchema = z
  .object({
    ...commonItemShape,
    kind: z.literal("APPOINTMENT"),
    allDay: z.literal(true),
    availability: z.enum(["BUSY", "FREE"]).default("BUSY"),
    startLocalDate: dateKeySchema,
    endLocalDate: dateKeySchema,
  })
  .strict();

const reminderTimedSchema = z
  .object({
    ...commonItemShape,
    kind: z.literal("REMINDER"),
    allDay: z.literal(false),
    availability: z.literal("FREE").default("FREE"),
    startLocalDate: dateKeySchema,
    startLocalTime: timeKeySchema,
  })
  .strict();

const reminderAllDaySchema = z
  .object({
    ...commonItemShape,
    kind: z.literal("REMINDER"),
    allDay: z.literal(true),
    availability: z.literal("FREE").default("FREE"),
    startLocalDate: dateKeySchema,
  })
  .strict();

const birthdaySchema = z
  .object({
    ...commonItemShape,
    kind: z.literal("BIRTHDAY"),
    allDay: z.literal(true).default(true),
    availability: z.literal("FREE").default("FREE"),
    birthdayMonth: z.number().int().min(1).max(12),
    birthdayDay: z.number().int().min(1).max(31),
    birthdayYear: z
      .number()
      .int()
      .min(MIN_USER_YEAR)
      .max(MAX_USER_YEAR)
      .nullable()
      .default(null),
  })
  .strict();

export const personalCalendarItemDraftSchema = z
  .union([
    appointmentTimedSchema,
    appointmentAllDaySchema,
    reminderTimedSchema,
    reminderAllDaySchema,
    birthdaySchema,
  ])
  .superRefine((item, context) => {
    const hasLatitude = item.latitude !== null;
    const hasLongitude = item.longitude !== null;
    if (hasLatitude !== hasLongitude) {
      context.addIssue({
        code: "custom",
        path: [hasLatitude ? "longitude" : "latitude"],
        message: "Latitude e longitude precisam ser informadas juntas.",
      });
    }
    const hasProvider = item.locationProvider !== null;
    const hasExternalId = item.locationExternalId !== null;
    if (hasProvider !== hasExternalId) {
      context.addIssue({
        code: "custom",
        path: [hasProvider ? "locationExternalId" : "locationProvider"],
        message:
          "Provider e identificador externo precisam ser informados juntos.",
      });
    }
    if (item.kind === "BIRTHDAY") {
      const maxDay =
        item.birthdayMonth >= 1 && item.birthdayMonth <= 12
          ? daysInMonth(2000, item.birthdayMonth)
          : null;
      if (maxDay !== null && item.birthdayDay > maxDay) {
        context.addIssue({
          code: "custom",
          path: ["birthdayDay"],
          message: "Dia de aniversário inválido para o mês.",
        });
      }
      return;
    }
    if (item.kind === "REMINDER" && !item.allDay) {
      uniqueLocalInstantOrIssue(
        item.startLocalDate,
        item.startLocalTime,
        item.timeZone,
        context,
        "startLocalTime",
      );
      return;
    }
    if (item.kind !== "APPOINTMENT") return;
    let startOrdinal: number;
    let endOrdinal: number;
    try {
      startOrdinal = dateKeyToOrdinal(item.startLocalDate);
      endOrdinal = dateKeyToOrdinal(item.endLocalDate);
    } catch {
      // Os schemas dos campos já registraram o erro de data correspondente.
      return;
    }
    const spanDays = endOrdinal - startOrdinal;
    if (spanDays < 0 || spanDays > MAX_APPOINTMENT_SPAN_DAYS) {
      context.addIssue({
        code: "custom",
        path: ["endLocalDate"],
        message: "Intervalo do compromisso inválido.",
      });
      return;
    }
    if (item.allDay && spanDays < 1) {
      context.addIssue({
        code: "custom",
        path: ["endLocalDate"],
        message: "O fim de compromisso de dia inteiro é exclusivo.",
      });
      return;
    }
    if (!item.allDay) {
      const start = uniqueLocalInstantOrIssue(
        item.startLocalDate,
        item.startLocalTime,
        item.timeZone,
        context,
        "startLocalTime",
      );
      const end = uniqueLocalInstantOrIssue(
        item.endLocalDate,
        item.endLocalTime,
        item.timeZone,
        context,
        "endLocalTime",
      );
      if (start && end && end.getTime() <= start.getTime()) {
        context.addIssue({
          code: "custom",
          path: ["endLocalTime"],
          message: "O fim precisa ocorrer depois do início.",
        });
      }
    }
  });

export type PersonalCalendarItemDraft = z.infer<
  typeof personalCalendarItemDraftSchema
>;

export const personalCalendarRecurrenceSchema = z
  .object({
    frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]),
    interval: z.number().int().min(1).max(100).default(1),
    weekdaysMask: z.number().int().min(1).max(127).nullable().default(null),
    invalidDatePolicy: z.enum(["SKIP", "CLAMP_LAST_DAY"]).default("SKIP"),
    termination: z.enum(["NEVER", "UNTIL", "COUNT"]).default("NEVER"),
    untilLocalDate: dateKeySchema.nullable().default(null),
    occurrenceCount: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((recurrence, context) => {
    if (
      (recurrence.frequency === "WEEKLY") !==
      (recurrence.weekdaysMask !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["weekdaysMask"],
        message:
          "Dias da semana são obrigatórios apenas na recorrência semanal.",
      });
    }
    const terminationShapeIsValid =
      (recurrence.termination === "NEVER" &&
        recurrence.untilLocalDate === null &&
        recurrence.occurrenceCount === null) ||
      (recurrence.termination === "UNTIL" &&
        recurrence.untilLocalDate !== null &&
        recurrence.occurrenceCount === null) ||
      (recurrence.termination === "COUNT" &&
        recurrence.untilLocalDate === null &&
        recurrence.occurrenceCount !== null);
    if (!terminationShapeIsValid) {
      context.addIssue({
        code: "custom",
        path: ["termination"],
        message: "Término da recorrência inconsistente.",
      });
    }
  });

export type PersonalCalendarRecurrence = z.infer<
  typeof personalCalendarRecurrenceSchema
>;

export const personalCalendarAlertOffsetsSchema = z
  .array(z.number().int().min(0).max(525_600))
  .max(MAX_ALERT_RULES)
  .transform((values, context) => {
    const unique = [...new Set(values)].sort((left, right) => right - left);
    if (unique.length !== values.length) {
      context.addIssue({
        code: "custom",
        message: "Avisos duplicados não são permitidos.",
      });
      return z.NEVER;
    }
    return unique;
  });

export type GeneratedPersonalCalendarOccurrence = {
  occurrenceKey: string;
  originalLocalDate: string;
  originalLocalTime: string | null;
  startsAtUtc: Date;
  endsAtUtc: Date;
  adjustedForTimeZone: boolean;
  allDay: boolean;
};

export type PersonalCalendarTimeInterval = {
  startsAtUtc: Date;
  endsAtUtc: Date;
};

function validatedInterval(
  interval: PersonalCalendarTimeInterval,
): readonly [number, number] {
  const start = interval.startsAtUtc.getTime();
  const end = interval.endsAtUtc.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new PersonalCalendarValidationError(
      "INVALID_RANGE",
      "Intervalo temporal inválido.",
    );
  }
  return [start, end];
}

/** Regra canônica de colisão: intervalos semiabertos [início, fim). */
export function personalCalendarIntervalsOverlap(
  left: PersonalCalendarTimeInterval,
  right: PersonalCalendarTimeInterval,
): boolean {
  const [leftStart, leftEnd] = validatedInterval(left);
  const [rightStart, rightEnd] = validatedInterval(right);
  return leftStart < rightEnd && rightStart < leftEnd;
}

export function personalCalendarItemBlocksTime(rawItem: unknown): boolean {
  const item = personalCalendarItemDraftSchema.parse(rawItem);
  return item.kind === "APPOINTMENT" && item.availability === "BUSY";
}

export type PersonalCalendarOccurrenceWindow = {
  fromDate: string;
  toDate: string;
};

export const personalCalendarOccurrenceWindowSchema = z
  .object({
    fromDate: dateKeySchema,
    toDate: dateKeySchema,
  })
  .strict();

function startDateFor(item: PersonalCalendarItemDraft): string {
  if (item.kind === "BIRTHDAY") {
    const year = item.birthdayYear ?? MIN_USER_YEAR;
    return `${year}-${String(item.birthdayMonth).padStart(2, "0")}-${String(item.birthdayDay).padStart(2, "0")}`;
  }
  return item.startLocalDate;
}

function appointmentDurationDays(item: PersonalCalendarItemDraft): number {
  if (item.kind !== "APPOINTMENT") return item.kind === "BIRTHDAY" ? 1 : 0;
  return (
    dateKeyToOrdinal(item.endLocalDate) - dateKeyToOrdinal(item.startLocalDate)
  );
}

function originalAppointmentDurationMs(
  item: Extract<PersonalCalendarItemDraft, { kind: "APPOINTMENT" }>,
): number {
  if (item.allDay) return appointmentDurationDays(item) * DAY_MS;
  const start = civilDateTimeToInstant(
    item.startLocalDate,
    item.startLocalTime,
    item.timeZone,
    "REJECT",
  ).instant;
  const end = civilDateTimeToInstant(
    item.endLocalDate,
    item.endLocalTime,
    item.timeZone,
    "REJECT",
  ).instant;
  return end.getTime() - start.getTime();
}

function occurrenceOrdinalAllowed(
  recurrence: PersonalCalendarRecurrence,
  candidateDate: string,
  ordinal: number,
): boolean {
  if (
    recurrence.termination === "UNTIL" &&
    recurrence.untilLocalDate !== null &&
    compareDateKeys(candidateDate, recurrence.untilLocalDate) > 0
  ) {
    return false;
  }
  if (
    recurrence.termination === "COUNT" &&
    recurrence.occurrenceCount !== null &&
    ordinal > recurrence.occurrenceCount
  ) {
    return false;
  }
  return true;
}

function countSelectedWeekdays(
  mask: number,
  fromMondayIndex: number,
  toMondayIndex: number,
): number {
  let count = 0;
  for (
    let mondayIndex = fromMondayIndex;
    mondayIndex <= toMondayIndex;
    mondayIndex += 1
  ) {
    const weekday = mondayIndex === 6 ? 0 : mondayIndex + 1;
    if ((mask & (1 << weekday)) !== 0) count += 1;
  }
  return count;
}

function weeklyOccurrenceOrdinal(
  startDate: string,
  candidateDate: string,
  interval: number,
  mask: number,
): number | null {
  const startMonday = mondayOfDateKey(startDate);
  const candidateMonday = mondayOfDateKey(candidateDate);
  const weekDiff =
    (dateKeyToOrdinal(candidateMonday) - dateKeyToOrdinal(startMonday)) / 7;
  if (
    !Number.isInteger(weekDiff) ||
    weekDiff < 0 ||
    weekDiff % interval !== 0
  ) {
    return null;
  }
  const candidateWeekday = weekdayOfDateKey(candidateDate);
  if ((mask & (1 << candidateWeekday)) === 0) return null;
  if (compareDateKeys(candidateDate, startDate) < 0) return null;

  const startWeekday = weekdayOfDateKey(startDate);
  const startMondayIndex = startWeekday === 0 ? 6 : startWeekday - 1;
  const candidateMondayIndex =
    candidateWeekday === 0 ? 6 : candidateWeekday - 1;
  if (weekDiff === 0) {
    return countSelectedWeekdays(mask, startMondayIndex, candidateMondayIndex);
  }
  const firstWeekCount = countSelectedWeekdays(mask, startMondayIndex, 6);
  const fullWeekCount = countSelectedWeekdays(mask, 0, 6);
  const eligibleWeekNumber = weekDiff / interval;
  return (
    firstWeekCount +
    Math.max(0, eligibleWeekNumber - 1) * fullWeekCount +
    countSelectedWeekdays(mask, 0, candidateMondayIndex)
  );
}

function monthlyOccurrenceOrdinal(
  startDate: string,
  candidateMonthIndex: number,
  recurrence: PersonalCalendarRecurrence,
): number {
  const startMonthIndex = monthIndex(startDate);
  const desiredDay = parseDateKey(startDate).day;
  let ordinal = 0;
  for (
    let current = startMonthIndex;
    current <= candidateMonthIndex;
    current += recurrence.interval
  ) {
    if (
      dateKeyFromMonthIndex(
        current,
        desiredDay,
        recurrence.invalidDatePolicy,
      ) !== null
    ) {
      ordinal += 1;
    }
  }
  return ordinal;
}

function yearlyCandidateDate(
  startDate: string,
  year: number,
  invalidDatePolicy: "SKIP" | "CLAMP_LAST_DAY",
): string | null {
  const start = parseDateKey(startDate);
  const lastDay = daysInMonth(year, start.month);
  if (start.day > lastDay && invalidDatePolicy === "SKIP") return null;
  return `${year}-${String(start.month).padStart(2, "0")}-${String(Math.min(start.day, lastDay)).padStart(2, "0")}`;
}

function yearlyOccurrenceOrdinal(
  startDate: string,
  candidateYear: number,
  recurrence: PersonalCalendarRecurrence,
): number {
  const startYear = parseDateKey(startDate).year;
  let ordinal = 0;
  for (
    let year = startYear;
    year <= candidateYear;
    year += recurrence.interval
  ) {
    if (
      yearlyCandidateDate(startDate, year, recurrence.invalidDatePolicy) !==
      null
    ) {
      ordinal += 1;
    }
  }
  return ordinal;
}

function recurringCandidateDates(
  item: PersonalCalendarItemDraft,
  recurrence: PersonalCalendarRecurrence,
  scanFromDate: string,
  scanToDate: string,
): string[] {
  if (item.kind === "BIRTHDAY") {
    throw new PersonalCalendarValidationError(
      "INVALID_RECURRENCE",
      "Aniversário já possui recorrência anual implícita.",
    );
  }
  const startDate = item.startLocalDate;
  if (
    recurrence.termination === "UNTIL" &&
    recurrence.untilLocalDate !== null &&
    compareDateKeys(recurrence.untilLocalDate, startDate) < 0
  ) {
    throw new PersonalCalendarValidationError(
      "INVALID_RECURRENCE",
      "O término da recorrência não pode anteceder o início.",
    );
  }
  const candidates: string[] = [];

  if (recurrence.frequency === "DAILY") {
    const firstDifference = Math.max(
      0,
      dateKeyToOrdinal(scanFromDate) - dateKeyToOrdinal(startDate),
    );
    const firstIndex = Math.ceil(firstDifference / recurrence.interval);
    for (let index = firstIndex; ; index += 1) {
      const candidate = addCivilDays(startDate, index * recurrence.interval);
      if (compareDateKeys(candidate, scanToDate) > 0) break;
      if (occurrenceOrdinalAllowed(recurrence, candidate, index + 1)) {
        candidates.push(candidate);
      }
      if (
        recurrence.termination === "COUNT" &&
        recurrence.occurrenceCount !== null &&
        index + 1 >= recurrence.occurrenceCount
      ) {
        break;
      }
    }
    return candidates;
  }

  if (recurrence.frequency === "WEEKLY") {
    const mask = recurrence.weekdaysMask;
    if (mask === null) {
      throw new PersonalCalendarValidationError(
        "INVALID_RECURRENCE",
        "Recorrência semanal sem dias selecionados.",
      );
    }
    for (
      let candidate =
        compareDateKeys(scanFromDate, startDate) < 0 ? startDate : scanFromDate;
      compareDateKeys(candidate, scanToDate) <= 0;
      candidate = addCivilDays(candidate, 1)
    ) {
      const ordinal = weeklyOccurrenceOrdinal(
        startDate,
        candidate,
        recurrence.interval,
        mask,
      );
      if (
        ordinal !== null &&
        ordinal > 0 &&
        occurrenceOrdinalAllowed(recurrence, candidate, ordinal)
      ) {
        candidates.push(candidate);
      }
    }
    return candidates;
  }

  if (recurrence.frequency === "MONTHLY") {
    const startMonth = monthIndex(startDate);
    const firstMonth = Math.max(startMonth, monthIndex(scanFromDate));
    const firstDifference = firstMonth - startMonth;
    let current =
      startMonth +
      Math.ceil(firstDifference / recurrence.interval) * recurrence.interval;
    const finalMonth = monthIndex(scanToDate);
    const desiredDay = parseDateKey(startDate).day;
    for (; current <= finalMonth; current += recurrence.interval) {
      const candidate = dateKeyFromMonthIndex(
        current,
        desiredDay,
        recurrence.invalidDatePolicy,
      );
      if (!candidate || compareDateKeys(candidate, startDate) < 0) continue;
      const ordinal = monthlyOccurrenceOrdinal(startDate, current, recurrence);
      if (occurrenceOrdinalAllowed(recurrence, candidate, ordinal)) {
        candidates.push(candidate);
      }
    }
    return candidates;
  }

  const startYear = parseDateKey(startDate).year;
  const firstYear = Math.max(startYear, parseDateKey(scanFromDate).year);
  const firstDifference = firstYear - startYear;
  let year =
    startYear +
    Math.ceil(firstDifference / recurrence.interval) * recurrence.interval;
  const finalYear = parseDateKey(scanToDate).year;
  for (; year <= finalYear; year += recurrence.interval) {
    const candidate = yearlyCandidateDate(
      startDate,
      year,
      recurrence.invalidDatePolicy,
    );
    if (!candidate || compareDateKeys(candidate, startDate) < 0) continue;
    const ordinal = yearlyOccurrenceOrdinal(startDate, year, recurrence);
    if (occurrenceOrdinalAllowed(recurrence, candidate, ordinal)) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

function birthdayCandidateDates(
  item: Extract<PersonalCalendarItemDraft, { kind: "BIRTHDAY" }>,
  scanFromDate: string,
  scanToDate: string,
): string[] {
  const firstYear = parseDateKey(scanFromDate).year;
  const finalYear = parseDateKey(scanToDate).year;
  const candidates: string[] = [];
  for (let year = firstYear; year <= finalYear; year += 1) {
    if (item.birthdayYear !== null && year < item.birthdayYear) continue;
    const lastDay = daysInMonth(year, item.birthdayMonth);
    const day = Math.min(item.birthdayDay, lastDay);
    const candidate = `${year}-${String(item.birthdayMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (
      compareDateKeys(candidate, scanFromDate) >= 0 &&
      compareDateKeys(candidate, scanToDate) <= 0
    ) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

function buildOccurrence(
  item: PersonalCalendarItemDraft,
  occurrenceDate: string,
): GeneratedPersonalCalendarOccurrence {
  const originalLocalTime =
    item.kind !== "BIRTHDAY" && !item.allDay ? item.startLocalTime : null;
  const start = civilDateTimeToInstant(
    occurrenceDate,
    originalLocalTime ?? "00:00:00",
    item.timeZone,
    "COMPATIBLE",
  );
  let end: CivilInstant;
  if (item.kind === "APPOINTMENT") {
    const endDate = addCivilDays(occurrenceDate, appointmentDurationDays(item));
    end = civilDateTimeToInstant(
      endDate,
      item.allDay ? "00:00:00" : item.endLocalTime,
      item.timeZone,
      "COMPATIBLE",
    );
  } else if (item.allDay) {
    end = civilDateTimeToInstant(
      addCivilDays(occurrenceDate, 1),
      "00:00:00",
      item.timeZone,
      "COMPATIBLE",
    );
  } else {
    end = {
      instant: new Date(start.instant.getTime() + MINUTE_MS),
      adjustedForTimeZone: start.adjustedForTimeZone,
    };
  }
  if (end.instant.getTime() <= start.instant.getTime()) {
    if (
      item.kind === "APPOINTMENT" &&
      (start.adjustedForTimeZone || end.adjustedForTimeZone)
    ) {
      end = {
        instant: new Date(
          start.instant.getTime() + originalAppointmentDurationMs(item),
        ),
        adjustedForTimeZone: true,
      };
    } else {
      throw new PersonalCalendarValidationError(
        "INVALID_RANGE",
        "Ocorrência com intervalo temporal inválido.",
      );
    }
  }
  return {
    occurrenceKey: `${occurrenceDate}T${originalLocalTime ?? "ALL_DAY"}`,
    originalLocalDate: occurrenceDate,
    originalLocalTime,
    startsAtUtc: start.instant,
    endsAtUtc: end.instant,
    adjustedForTimeZone: start.adjustedForTimeZone || end.adjustedForTimeZone,
    allDay: item.allDay,
  };
}

/** Expansão pura e limitada; não consulta nem escreve banco. */
export function generatePersonalCalendarOccurrences(
  rawItem: unknown,
  rawRecurrence: unknown | null,
  rawWindow: unknown,
): GeneratedPersonalCalendarOccurrence[] {
  const item = personalCalendarItemDraftSchema.parse(rawItem);
  const recurrence =
    rawRecurrence === null
      ? null
      : personalCalendarRecurrenceSchema.parse(rawRecurrence);
  const window = personalCalendarOccurrenceWindowSchema.parse(rawWindow);
  const fromOrdinal = dateKeyToOrdinal(window.fromDate);
  const toOrdinal = dateKeyToOrdinal(window.toDate);
  if (toOrdinal < fromOrdinal) {
    throw new PersonalCalendarValidationError(
      "INVALID_RANGE",
      "A janela termina antes de começar.",
    );
  }
  if (toOrdinal - fromOrdinal + 1 > MAX_QUERY_DAYS) {
    throw new PersonalCalendarValidationError(
      "QUERY_WINDOW_TOO_LARGE",
      `A consulta pode abranger no máximo ${MAX_QUERY_DAYS} dias.`,
    );
  }
  if (item.kind === "BIRTHDAY" && recurrence) {
    throw new PersonalCalendarValidationError(
      "INVALID_RECURRENCE",
      "Aniversário já possui recorrência anual implícita.",
    );
  }

  const windowStart = civilDateTimeToInstant(
    window.fromDate,
    "00:00:00",
    item.timeZone,
  ).instant;
  const windowEnd = civilDateTimeToInstant(
    addCivilDays(window.toDate, 1),
    "00:00:00",
    item.timeZone,
  ).instant;
  const scanFromDate = addCivilDays(
    window.fromDate,
    -appointmentDurationDays(item),
  );
  const candidateDates =
    item.kind === "BIRTHDAY"
      ? birthdayCandidateDates(item, scanFromDate, window.toDate)
      : recurrence
        ? recurringCandidateDates(item, recurrence, scanFromDate, window.toDate)
        : [startDateFor(item)];

  return candidateDates
    .map((date) => buildOccurrence(item, date))
    .filter(
      (occurrence) =>
        occurrence.startsAtUtc.getTime() < windowEnd.getTime() &&
        occurrence.endsAtUtc.getTime() > windowStart.getTime(),
    )
    .sort(
      (left, right) =>
        left.startsAtUtc.getTime() - right.startsAtUtc.getTime() ||
        left.occurrenceKey.localeCompare(right.occurrenceKey),
    );
}
