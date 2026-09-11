/**
 * Lógica de apresentação da Agenda pessoal.
 *
 * Fica fora dos componentes de propósito: agrupamento, rótulo, resumo de
 * conflito e mescla de feriado são regras que precisam de teste sem React
 * Native no caminho. A tela consome; aqui não há `useState` nem estilo.
 *
 * Uma regra domina o arquivo: **compromisso pessoal e plantão institucional
 * nunca se confundem**. Eles têm origem diferente, autoridade diferente e
 * apresentação diferente. Um plantão aparece aqui apenas como *conflito* de
 * um compromisso — nunca como item que o usuário possa editar por esta tela.
 */

export type PersonalCalendarKind = "APPOINTMENT" | "REMINDER" | "BIRTHDAY";

export type PersonalCalendarAvailability = "BUSY" | "FREE";

export type PersonalCalendarConflictSummary = {
  hasConflict: boolean;
  total: number;
  truncated: boolean;
  conflicts: readonly {
    kind: string;
    label?: string;
    institutionName?: string;
    hospitalName?: string;
    sectorName?: string;
    title?: string;
  }[];
};

export type PersonalCalendarOccurrenceLike = {
  itemId: number;
  itemVersion: number;
  occurrenceKey: string;
  title: string;
  kind: PersonalCalendarKind;
  availability: PersonalCalendarAvailability;
  allDay: boolean;
  locationLabel: string | null;
  startsAtUtc: Date | string;
  endsAtUtc: Date | string;
  alertOffsets?: readonly number[];
  conflict?: PersonalCalendarConflictSummary;
  /** De onde veio: criado aqui ou importado do Google (somente leitura). */
  source?: "LOCAL" | "GOOGLE";
};

export type HolidayLike = {
  date: string;
  name: string;
};

export const PERSONAL_CALENDAR_VIEWS = ["DAY", "WEEK", "MONTH"] as const;

export type PersonalCalendarView = (typeof PERSONAL_CALENDAR_VIEWS)[number];

export const PERSONAL_CALENDAR_VIEW_LABELS: Record<
  PersonalCalendarView,
  string
> = {
  DAY: "Dia",
  WEEK: "Semana",
  MONTH: "Mês",
};

export const PERSONAL_CALENDAR_KIND_LABELS: Record<
  PersonalCalendarKind,
  string
> = {
  APPOINTMENT: "Compromisso",
  REMINDER: "Lembrete",
  BIRTHDAY: "Aniversário",
};

/**
 * Só compromisso ocupa horário. Lembrete e aniversário são sempre livres —
 * o domínio garante isso na persistência, e a tela não pode sugerir o
 * contrário.
 */
export function blocksTime(occurrence: {
  kind: PersonalCalendarKind;
  availability: PersonalCalendarAvailability;
}): boolean {
  return (
    occurrence.kind === "APPOINTMENT" && occurrence.availability === "BUSY"
  );
}

export function availabilityLabel(
  occurrence: Pick<PersonalCalendarOccurrenceLike, "kind" | "availability">,
): string {
  return blocksTime(occurrence) ? "Ocupado" : "Livre";
}

const MS_PER_DAY = 86_400_000;

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Chave civil "YYYY-MM-DD" de um instante, no fuso informado.
 *
 * Usa `Intl` em vez de `getDate()`: o processo pode rodar em UTC (Render), e
 * ali `getDate()` devolve o dia errado entre 21h e meia-noite no Brasil.
 */
export function dayKeyInTimeZone(
  value: Date | string,
  timeZone: string,
): string {
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

export function addDaysToDayKey(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

/** Segunda-feira da semana que contém `dayKey`. */
export function startOfWeekDayKey(dayKey: string): string {
  const [year, month, day] = dayKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  // getUTCDay: 0 = domingo. A semana brasileira começa na segunda.
  const offset = (date.getUTCDay() + 6) % 7;
  return addDaysToDayKey(dayKey, -offset);
}

export function startOfMonthDayKey(dayKey: string): string {
  return `${dayKey.slice(0, 7)}-01`;
}

export function endOfMonthDayKey(dayKey: string): string {
  const [year, month] = dayKey.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${dayKey.slice(0, 7)}-${String(lastDay).padStart(2, "0")}`;
}

/**
 * Janela de consulta de cada modo.
 *
 * O servidor recusa janela invertida ou acima de 366 dias; estas três nunca
 * chegam perto do teto, mas o cálculo é explícito para que a tela não mande
 * uma janela que o contrato recusaria.
 */
export function windowForView(
  view: PersonalCalendarView,
  anchorDayKey: string,
): { fromDate: string; toDate: string } {
  if (view === "DAY") {
    return { fromDate: anchorDayKey, toDate: anchorDayKey };
  }
  if (view === "WEEK") {
    const from = startOfWeekDayKey(anchorDayKey);
    return { fromDate: from, toDate: addDaysToDayKey(from, 6) };
  }
  return {
    fromDate: startOfMonthDayKey(anchorDayKey),
    toDate: endOfMonthDayKey(anchorDayKey),
  };
}

export function shiftAnchor(
  view: PersonalCalendarView,
  anchorDayKey: string,
  direction: 1 | -1,
): string {
  if (view === "DAY") return addDaysToDayKey(anchorDayKey, direction);
  if (view === "WEEK") return addDaysToDayKey(anchorDayKey, 7 * direction);
  const [year, month] = anchorDayKey.split("-").map(Number);
  const moved = new Date(Date.UTC(year, month - 1 + direction, 1));
  return moved.toISOString().slice(0, 10);
}

export type PersonalCalendarDayGroup = {
  dayKey: string;
  holidayName: string | null;
  occurrences: PersonalCalendarOccurrenceLike[];
};

/**
 * Agrupa ocorrências por dia civil, preenchendo os dias vazios da janela.
 *
 * Dias vazios importam: sem eles, "Semana" mostraria uma lista contínua em
 * que o usuário não percebe que quarta não tem nada. O vazio é informação.
 */
export function groupOccurrencesByDay(input: {
  fromDate: string;
  toDate: string;
  occurrences: readonly PersonalCalendarOccurrenceLike[];
  holidays?: readonly HolidayLike[];
  timeZone: string;
  includeEmptyDays?: boolean;
}): PersonalCalendarDayGroup[] {
  const holidayByDay = new Map<string, string>();
  for (const holiday of input.holidays ?? []) {
    if (!holidayByDay.has(holiday.date)) {
      holidayByDay.set(holiday.date, holiday.name);
    }
  }

  const byDay = new Map<string, PersonalCalendarOccurrenceLike[]>();
  for (const occurrence of input.occurrences) {
    const dayKey = dayKeyInTimeZone(occurrence.startsAtUtc, input.timeZone);
    if (!dayKey) continue;
    // Uma ocorrência que começa antes da janela ainda aparece no dia dela.
    const bucket = byDay.get(dayKey);
    if (bucket) bucket.push(occurrence);
    else byDay.set(dayKey, [occurrence]);
  }

  const dayKeys: string[] = [];
  if (input.includeEmptyDays === false) {
    dayKeys.push(...[...byDay.keys()].sort());
  } else {
    let cursor = input.fromDate;
    let guard = 0;
    while (cursor <= input.toDate && guard < 400) {
      dayKeys.push(cursor);
      cursor = addDaysToDayKey(cursor, 1);
      guard += 1;
    }
    for (const dayKey of byDay.keys()) {
      if (!dayKeys.includes(dayKey)) dayKeys.push(dayKey);
    }
    dayKeys.sort();
  }

  return dayKeys.map((dayKey) => ({
    dayKey,
    holidayName: holidayByDay.get(dayKey) ?? null,
    occurrences: (byDay.get(dayKey) ?? []).slice().sort(compareOccurrences),
  }));
}

/**
 * Dia inteiro primeiro, depois por horário, e por fim por título.
 *
 * O desempate por `occurrenceKey` no fim evita que duas ocorrências
 * idênticas troquem de posição entre renderizações.
 */
export function compareOccurrences(
  left: PersonalCalendarOccurrenceLike,
  right: PersonalCalendarOccurrenceLike,
): number {
  if (left.allDay !== right.allDay) return left.allDay ? -1 : 1;
  const byStart =
    toDate(left.startsAtUtc).getTime() - toDate(right.startsAtUtc).getTime();
  if (byStart !== 0) return byStart;
  const byTitle = left.title.localeCompare(right.title, "pt-BR");
  if (byTitle !== 0) return byTitle;
  return left.occurrenceKey.localeCompare(right.occurrenceKey);
}

export function formatOccurrenceTime(
  occurrence: Pick<
    PersonalCalendarOccurrenceLike,
    "allDay" | "startsAtUtc" | "endsAtUtc" | "kind"
  >,
  timeZone: string,
): string {
  if (occurrence.allDay) return "Dia inteiro";
  const format = (value: Date | string) => {
    try {
      return new Intl.DateTimeFormat("pt-BR", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(toDate(value));
    } catch {
      return "--:--";
    }
  };
  const start = format(occurrence.startsAtUtc);
  // Lembrete é um instante pontual: mostrar "08:00 – 08:00" sugeriria
  // duração onde não há.
  if (occurrence.kind === "REMINDER") return start;
  const end = format(occurrence.endsAtUtc);
  return start === end ? start : `${start} – ${end}`;
}

export function formatDayHeading(dayKey: string): string {
  const [year, month, day] = dayKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: "UTC",
      weekday: "long",
      day: "2-digit",
      month: "long",
    }).format(date);
  } catch {
    return dayKey;
  }
}

/**
 * Texto do conflito com plantão próprio.
 *
 * Aparece no compromisso pessoal porque é ali que o usuário decide. O
 * plantão em si continua sendo governado pela escala — esta tela informa,
 * não negocia.
 */
export function conflictSummaryText(
  conflict: PersonalCalendarConflictSummary | undefined,
): string | null {
  if (!conflict?.hasConflict || conflict.total === 0) return null;
  const first = conflict.conflicts[0];
  const place =
    first?.hospitalName && first?.sectorName
      ? `${first.sectorName} · ${first.hospitalName}`
      : (first?.label ?? first?.title ?? null);
  if (conflict.total === 1) {
    return place ? `Conflito com plantão: ${place}` : "Conflito com um plantão";
  }
  const suffix = conflict.truncated ? "+" : "";
  return `Conflito com ${conflict.total}${suffix} plantões`;
}

export function accessibilityLabelForOccurrence(
  occurrence: PersonalCalendarOccurrenceLike,
  timeZone: string,
): string {
  const parts = [
    PERSONAL_CALENDAR_KIND_LABELS[occurrence.kind],
    occurrence.title,
    formatOccurrenceTime(occurrence, timeZone),
  ];
  if (blocksTime(occurrence)) parts.push("ocupa horário");
  if (occurrence.locationLabel) parts.push(occurrence.locationLabel);
  const conflict = conflictSummaryText(occurrence.conflict);
  if (conflict) parts.push(conflict);
  return parts.join(", ");
}

/**
 * `notes` é conteúdo privado e longo. O contrato de listagem não o entrega,
 * e a tela não pode inventá-lo: este guardião existe para que um refactor
 * futuro que passe a incluir notes na listagem quebre um teste, em vez de
 * vazar anotação médica numa lista.
 */
export function listingExposesNotes(occurrence: object): boolean {
  return "notes" in occurrence;
}

export type PersonalCalendarScreenState =
  | { kind: "LOADING" }
  | { kind: "ERROR" }
  | { kind: "EMPTY" }
  | { kind: "READY"; groups: PersonalCalendarDayGroup[] };

/**
 * Erro NUNCA vira estado vazio.
 *
 * "Nenhum compromisso" e "não consegui carregar" levam o usuário a decisões
 * opostas: o primeiro convida a criar, o segundo a tentar de novo. Trocar um
 * pelo outro faz alguém concluir que a agenda está limpa quando ela apenas
 * não carregou.
 */
export function resolvePersonalCalendarScreenState(input: {
  isLoading: boolean;
  isError: boolean;
  groups: PersonalCalendarDayGroup[] | null;
}): PersonalCalendarScreenState {
  if (input.isError) return { kind: "ERROR" };
  if (input.isLoading || input.groups === null) return { kind: "LOADING" };
  const hasAny = input.groups.some((group) => group.occurrences.length > 0);
  return hasAny ? { kind: "READY", groups: input.groups } : { kind: "EMPTY" };
}

export const WEEKDAY_SHORT_LABELS = [
  "Seg",
  "Ter",
  "Qua",
  "Qui",
  "Sex",
  "Sáb",
  "Dom",
] as const;

/** Bitmask de dias da semana usado pela recorrência semanal (bit 0 = segunda). */
export function weekdaysMaskFromIndexes(indexes: readonly number[]): number {
  return indexes.reduce((mask, index) => mask | (1 << index), 0);
}

export function weekdayIndexesFromMask(mask: number): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < 7; index += 1) {
    if (mask & (1 << index)) indexes.push(index);
  }
  return indexes;
}

export function weekdayIndexForDayKey(dayKey: string): number {
  const [year, month, day] = dayKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (date.getUTCDay() + 6) % 7;
}

export function recurrenceSummary(
  recurrence: {
    frequency: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
    interval: number;
    weekdaysMask: number | null;
    termination: "NEVER" | "UNTIL" | "COUNT";
    untilLocalDate: string | null;
    occurrenceCount: number | null;
  } | null,
): string {
  if (!recurrence) return "Não se repete";
  const every = recurrence.interval > 1 ? `a cada ${recurrence.interval} ` : "";
  let base: string;
  if (recurrence.frequency === "DAILY") {
    base = recurrence.interval > 1 ? `${every}dias` : "Todos os dias";
  } else if (recurrence.frequency === "WEEKLY") {
    const days = weekdayIndexesFromMask(recurrence.weekdaysMask ?? 0)
      .map((index) => WEEKDAY_SHORT_LABELS[index])
      .join(", ");
    const prefix = recurrence.interval > 1 ? `${every}semanas` : "Toda semana";
    base = days ? `${prefix}: ${days}` : prefix;
  } else if (recurrence.frequency === "MONTHLY") {
    base = recurrence.interval > 1 ? `${every}meses` : "Todo mês";
  } else {
    base = recurrence.interval > 1 ? `${every}anos` : "Todo ano";
  }
  if (recurrence.termination === "UNTIL" && recurrence.untilLocalDate) {
    const [year, month, day] = recurrence.untilLocalDate.split("-");
    return `${base}, até ${day}/${month}/${year}`;
  }
  if (recurrence.termination === "COUNT" && recurrence.occurrenceCount) {
    return `${base}, ${recurrence.occurrenceCount} vezes`;
  }
  return base;
}

export const ALERT_OFFSET_OPTIONS: readonly {
  minutes: number;
  label: string;
}[] = [
  { minutes: 0, label: "Na hora" },
  { minutes: 5, label: "5 minutos antes" },
  { minutes: 15, label: "15 minutos antes" },
  { minutes: 30, label: "30 minutos antes" },
  { minutes: 60, label: "1 hora antes" },
  { minutes: 120, label: "2 horas antes" },
  { minutes: 1440, label: "1 dia antes" },
  { minutes: 2880, label: "2 dias antes" },
];

export function alertOffsetsSummary(offsets: readonly number[]): string {
  if (offsets.length === 0) return "Sem alerta";
  const labels = offsets
    .slice()
    .sort((left, right) => left - right)
    .map(
      (minutes) =>
        ALERT_OFFSET_OPTIONS.find((option) => option.minutes === minutes)
          ?.label ?? `${minutes} min antes`,
    );
  return labels.join(" · ");
}

export { MS_PER_DAY };
