/**
 * Navegação mensal da Agenda: o gestor precisa conseguir escolher o
 * próximo mês (ex.: setembro) mesmo quando ele ainda não tem plantões.
 */

export function monthKeyOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function nextMonthKey(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  return monthKeyOf(new Date(year, month, 1));
}

export function previousMonthKey(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  return monthKeyOf(new Date(year, month - 2, 1));
}

export function clampDayKeyToMonth(dayKey: string, monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  const preferredDay = Number(dayKey.slice(8, 10));
  const lastDay = new Date(year, month, 0).getDate();
  return `${monthKey}-${String(Math.min(preferredDay, lastDay)).padStart(2, "0")}`;
}

export function stepDayKey(dayKey: string, delta: number): string {
  const date = new Date(`${dayKey}T12:00:00`);
  date.setDate(date.getDate() + delta);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * A folha mensal tem 42 dias e pode atravessar uma virada de ano. Retorna o
 * ano do mês e, quando necessário, o único ano adjacente da grade.
 */
export function agendaHolidayYearsForWindow(
  monthKey: string,
  fromDate: string,
  toDate: string,
): { primaryYear: number; adjacentYear: number | null } {
  const primaryYear = Number(monthKey.slice(0, 4));
  const boundaryYears = [
    Number(fromDate.slice(0, 4)),
    Number(toDate.slice(0, 4)),
  ];
  return {
    primaryYear,
    adjacentYear:
      boundaryYears.find((year) => year !== primaryYear) ?? null,
  };
}

export function sourceMonthForCalendarTarget(targetMonth: string): string {
  return previousMonthKey(targetMonth);
}

/** Origem do primeiro calendário de um mês ainda sem plantões. */
export type CalendarOpenOrigin = "previous-month" | "templates";

export function calendarOpenOriginFromPreviousMonth(
  hasPreviousMonthShifts: boolean | undefined,
): CalendarOpenOrigin {
  return hasPreviousMonthShifts === true ? "previous-month" : "templates";
}

export function emptyMonthCalendarDescription(
  origin: CalendarOpenOrigin,
): string {
  return origin === "previous-month"
    ? "Crie o calendário deste mês a partir da escala anterior para alocar os profissionais."
    : "Crie o calendário deste mês a partir dos modelos de horário para começar a alocar os profissionais.";
}

export function calendarOpenBaseHint(
  targetLabel: string,
  sourceLabel: string,
  origin: CalendarOpenOrigin,
): string {
  return origin === "previous-month"
    ? `Destino: ${targetLabel}. Base: ${sourceLabel}.`
    : `Destino: ${targetLabel}. Sem escala anterior — usa os modelos de horário.`;
}

export function calendarOpenPreviewTitle(
  sourceLabel: string,
  targetLabel: string,
  origin: CalendarOpenOrigin,
): string {
  return origin === "previous-month"
    ? `Copiar ${sourceLabel} para ${targetLabel}:`
    : `Criar o calendário de ${targetLabel} a partir dos modelos de horário:`;
}

export function calendarOpenConfirmTitle(
  created: number,
  origin: CalendarOpenOrigin,
): string {
  if (created === 0) {
    return origin === "previous-month" ? "Nada a copiar" : "Nada a criar";
  }
  return origin === "previous-month"
    ? "Confirmar cópia"
    : "Confirmar calendário";
}

/**
 * Sempre inclui o mês anterior, o corrente e os dois seguintes.
 * Chaves extras (mês atualmente em tela) entram sem duplicar.
 */
export function buildAgendaMonthPickerOptions(
  now: Date,
  extraKeys: readonly string[] = [],
): string[] {
  const current = monthKeyOf(now);
  const keys = new Set<string>([
    previousMonthKey(current),
    current,
    nextMonthKey(current),
    nextMonthKey(nextMonthKey(current)),
    ...extraKeys.filter((key) => /^\d{4}-\d{2}$/.test(key)),
  ]);
  return [...keys].sort();
}

export function countShiftsInMonth(
  weeks: readonly {
    days: readonly {
      date: string;
      groups: readonly { shifts: readonly unknown[] }[];
    }[];
  }[],
  monthKey: string,
): number {
  const prefix = `${monthKey}-`;
  return weeks.reduce(
    (weekAcc, week) =>
      weekAcc +
      week.days.reduce((dayAcc, day) => {
        if (!day.date.startsWith(prefix)) return dayAcc;
        return (
          dayAcc +
          day.groups.reduce(
            (groupAcc, group) => groupAcc + group.shifts.length,
            0,
          )
        );
      }, 0),
    0,
  );
}
