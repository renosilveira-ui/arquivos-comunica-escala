/**
 * Calendário operacional da Sala de Recuperação (Hospital São Carlos).
 *
 * Segunda a sábado com plantões; domingo sem cobertura. Sábado só até 19h
 * (manhã e tarde, sem noite). Plantões diurnos de 6h; noturno de 12h.
 * A semana começa na segunda com o turno Manhã às 07:00.
 */

export const SALA_RECUPERACAO_SECTOR_NAME = "Sala de Recuperação";

export const SALA_RECUPERACAO_GESTOR_MEDICO_NAME = "Maurilio Caetano";

export type SalaRecuperacaoShiftTemplate = {
  name: string;
  startTime: string;
  endTime: string;
  priority: number;
};

export const SALA_RECUPERACAO_SHIFT_TEMPLATES: readonly SalaRecuperacaoShiftTemplate[] =
  [
    { name: "Manhã", startTime: "07:00:00", endTime: "13:00:00", priority: 10 },
    { name: "Tarde", startTime: "13:00:00", endTime: "19:00:00", priority: 20 },
    { name: "Noite", startTime: "19:00:00", endTime: "07:00:00", priority: 30 },
  ];

/**
 * Nomes dos templates ativos em um dia da semana (0 = domingo … 6 = sábado).
 */
export function salaRecuperacaoTemplateNamesForWeekday(
  weekday: number,
): readonly string[] {
  if (weekday === 0) return [];
  if (weekday === 6) return ["Manhã", "Tarde"];
  return ["Manhã", "Tarde", "Noite"];
}

export function salaRecuperacaoTemplatesForWeekday(
  weekday: number,
): readonly SalaRecuperacaoShiftTemplate[] {
  const names = salaRecuperacaoTemplateNamesForWeekday(weekday);
  return SALA_RECUPERACAO_SHIFT_TEMPLATES.filter((template) =>
    names.includes(template.name),
  );
}

/** Lista de chaves "YYYY-MM-DD" de um mês civil com os templates do dia. */
export function salaRecuperacaoCalendarDaysForMonth(
  yearMonth: string,
): { dayKey: string; weekday: number; templates: readonly SalaRecuperacaoShiftTemplate[] }[] {
  const [year, month] = yearMonth.split("-").map(Number);
  if (!year || !month || month < 1 || month > 12) {
    throw new Error(`yearMonth inválido: ${yearMonth}`);
  }
  const days: {
    dayKey: string;
    weekday: number;
    templates: readonly SalaRecuperacaoShiftTemplate[];
  }[] = [];
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let d = 1; d <= lastDay; d++) {
    const dayKey = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const weekday = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
    const templates = salaRecuperacaoTemplatesForWeekday(weekday);
    if (templates.length > 0) {
      days.push({ dayKey, weekday, templates });
    }
  }
  return days;
}
