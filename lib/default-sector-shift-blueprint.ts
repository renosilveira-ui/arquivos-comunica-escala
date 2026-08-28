/**
 * Blueprint padrão de escala de setor — válido para qualquer instituição.
 *
 * Usado quando o setor ainda não tem modelos de horário próprios.
 * Segunda a sexta: manhã, tarde e noite. Sábado: manhã e tarde.
 * Domingo sem cobertura. Diurnos de 6h; noturno de 12h. Relógio −03:00.
 *
 * Instituições com templates próprios não passam por aqui: o servidor
 * usa os horários cadastrados no tenant.
 */

export type DefaultSectorShiftTemplate = {
  name: "Manhã" | "Tarde" | "Noite";
  startTime: string;
  endTime: string;
  priority: number;
};

export const DEFAULT_SECTOR_SHIFT_TEMPLATES: readonly DefaultSectorShiftTemplate[] =
  [
    { name: "Manhã", startTime: "07:00:00", endTime: "13:00:00", priority: 10 },
    { name: "Tarde", startTime: "13:00:00", endTime: "19:00:00", priority: 20 },
    { name: "Noite", startTime: "19:00:00", endTime: "07:00:00", priority: 30 },
  ];

export const DEFAULT_SECTOR_COLOR = "#2563EB";
export const DEFAULT_SECTOR_CATEGORY = "servico" as const;

/**
 * Nomes dos templates ativos em um dia da semana (0 = domingo … 6 = sábado).
 * Domingo vazio; sábado sem noite — salvo o setor ter templates próprios.
 */
export function defaultTemplateNamesForWeekday(
  weekday: number,
): readonly DefaultSectorShiftTemplate["name"][] {
  if (weekday === 0) return [];
  if (weekday === 6) return ["Manhã", "Tarde"];
  return ["Manhã", "Tarde", "Noite"];
}

export function defaultTemplatesForWeekday(
  weekday: number,
): readonly DefaultSectorShiftTemplate[] {
  const names = defaultTemplateNamesForWeekday(weekday);
  return DEFAULT_SECTOR_SHIFT_TEMPLATES.filter((template) =>
    names.includes(template.name),
  );
}

/** Lista de chaves "YYYY-MM-DD" de um mês civil com os templates do dia. */
export function defaultCalendarDaysForMonth(yearMonth: string): {
  dayKey: string;
  weekday: number;
  templates: readonly DefaultSectorShiftTemplate[];
}[] {
  const [year, month] = yearMonth.split("-").map(Number);
  if (!year || !month || month < 1 || month > 12) {
    throw new Error(`yearMonth inválido: ${yearMonth}`);
  }
  const days: {
    dayKey: string;
    weekday: number;
    templates: readonly DefaultSectorShiftTemplate[];
  }[] = [];
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let d = 1; d <= lastDay; d++) {
    const dayKey = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const weekday = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
    const templates = defaultTemplatesForWeekday(weekday);
    if (templates.length > 0) {
      days.push({ dayKey, weekday, templates });
    }
  }
  return days;
}
