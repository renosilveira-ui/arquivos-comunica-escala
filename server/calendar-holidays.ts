export const SUPPORTED_HOLIDAY_COUNTRY = "BR" as const;
export const SUPPORTED_HOLIDAY_STATE = "CE" as const;

export type CalendarHoliday = Readonly<{
  date: string;
  name: string;
  scope: "NATIONAL" | "STATE";
  countryCode: typeof SUPPORTED_HOLIDAY_COUNTRY;
  stateCode: typeof SUPPORTED_HOLIDAY_STATE | null;
  source: "STATUTORY_CALENDAR";
}>;

const MIN_SUPPORTED_YEAR = 2000;
const MAX_SUPPORTED_YEAR = 2100;

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Algoritmo gregoriano de Meeus/Jones/Butcher. A Paixão de Cristo é a
 * sexta-feira imediatamente anterior ao domingo de Páscoa.
 */
function easterSundayUtc(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function goodFriday(year: number): string {
  const date = easterSundayUtc(year);
  date.setUTCDate(date.getUTCDate() - 2);
  return dateKey(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
  );
}

function nationalHoliday(
  year: number,
  month: number,
  day: number,
  name: string,
): CalendarHoliday {
  return {
    date: dateKey(year, month, day),
    name,
    scope: "NATIONAL",
    countryCode: SUPPORTED_HOLIDAY_COUNTRY,
    stateCode: null,
    source: "STATUTORY_CALENDAR",
  };
}

export function listBrazilCearaHolidays(year: number): CalendarHoliday[] {
  if (
    !Number.isSafeInteger(year) ||
    year < MIN_SUPPORTED_YEAR ||
    year > MAX_SUPPORTED_YEAR
  ) {
    throw new RangeError(
      `Ano de feriados precisa estar entre ${MIN_SUPPORTED_YEAR} e ${MAX_SUPPORTED_YEAR}.`,
    );
  }

  const holidays: CalendarHoliday[] = [
    nationalHoliday(year, 1, 1, "Confraternização Universal"),
    {
      ...nationalHoliday(year, 1, 1, "Paixão de Cristo"),
      date: goodFriday(year),
    },
    nationalHoliday(year, 4, 21, "Tiradentes"),
    nationalHoliday(year, 5, 1, "Dia Mundial do Trabalho"),
    nationalHoliday(year, 9, 7, "Independência do Brasil"),
    nationalHoliday(year, 10, 12, "Nossa Senhora Aparecida"),
    nationalHoliday(year, 11, 2, "Finados"),
    nationalHoliday(year, 11, 15, "Proclamação da República"),
    ...(year >= 2024
      ? [
          nationalHoliday(
            year,
            11,
            20,
            "Dia Nacional de Zumbi e da Consciência Negra",
          ),
        ]
      : []),
    nationalHoliday(year, 12, 25, "Natal"),
    {
      date: dateKey(year, 3, 25),
      name: "Data Magna do Ceará",
      scope: "STATE",
      countryCode: SUPPORTED_HOLIDAY_COUNTRY,
      stateCode: SUPPORTED_HOLIDAY_STATE,
      source: "STATUTORY_CALENDAR",
    },
  ];

  return holidays.sort(
    (left, right) =>
      left.date.localeCompare(right.date) ||
      left.scope.localeCompare(right.scope) ||
      left.name.localeCompare(right.name, "pt-BR"),
  );
}
