/**
 * Abrir os turnos do mês: cria plantões vagos (sem alocar).
 *
 * Recorte padrão (quando o setor não declara outro calendário):
 * segunda a sexta com manhã, tarde e noite; sábado só manhã e tarde;
 * domingo sem cobertura. Horários vêm dos templates do tenant.
 */

import {
  DEFAULT_SECTOR_SHIFT_TEMPLATES,
  defaultCalendarDaysForMonth,
  type DefaultSectorShiftTemplate,
} from "./default-sector-shift-blueprint";

export const OPEN_MONTH_SHIFT_MODES = [
  "all-applicable",
  "nights-only",
  "weekends-only",
  "custom",
] as const;

export type OpenMonthShiftsMode = (typeof OPEN_MONTH_SHIFT_MODES)[number];

export const OPEN_MONTH_SHIFT_TEMPLATE_NAMES = [
  "Manhã",
  "Tarde",
  "Noite",
] as const;

export type OpenMonthShiftTemplateName =
  (typeof OPEN_MONTH_SHIFT_TEMPLATE_NAMES)[number];

export type PlannedOpenMonthShift = {
  dayKey: string;
  weekday: number;
  template: DefaultSectorShiftTemplate;
};

const TEMPLATE_NAME_SET = new Set<string>(OPEN_MONTH_SHIFT_TEMPLATE_NAMES);

export function isOpenMonthShiftTemplateName(
  value: string,
): value is OpenMonthShiftTemplateName {
  return TEMPLATE_NAME_SET.has(value);
}

export function resolveOpenMonthTemplateNames(
  mode: OpenMonthShiftsMode,
  templateNames?: readonly string[],
): readonly OpenMonthShiftTemplateName[] {
  if (mode === "custom") {
    if (!templateNames?.length) {
      throw new Error("Escolha ao menos um turno (manhã, tarde ou noite).");
    }
    const unique: OpenMonthShiftTemplateName[] = [];
    for (const name of templateNames) {
      if (!isOpenMonthShiftTemplateName(name)) {
        throw new Error(`Turno inválido: ${name}.`);
      }
      if (!unique.includes(name)) unique.push(name);
    }
    return unique;
  }
  if (mode === "nights-only") return ["Noite"];
  if (mode === "weekends-only") return ["Manhã", "Tarde"];
  return ["Manhã", "Tarde", "Noite"];
}

export function planOpenMonthShifts(input: {
  yearMonth: string;
  mode: OpenMonthShiftsMode;
  templateNames?: readonly string[];
}): PlannedOpenMonthShift[] {
  const selected = new Set(
    resolveOpenMonthTemplateNames(input.mode, input.templateNames),
  );
  const planned: PlannedOpenMonthShift[] = [];
  for (const day of defaultCalendarDaysForMonth(input.yearMonth)) {
    if (input.mode === "weekends-only" && day.weekday !== 6) continue;
    for (const template of day.templates) {
      if (!selected.has(template.name)) continue;
      planned.push({
        dayKey: day.dayKey,
        weekday: day.weekday,
        template,
      });
    }
  }
  return planned;
}

export function openMonthShiftsButtonTitle(monthName: string): string {
  return `Abrir os turnos de ${monthName}`;
}

export function openMonthShiftsDescription(): string {
  return "Crie os plantões vagos deste mês. Ninguém é alocado nesta etapa.";
}

export function openMonthShiftsModalTitle(): string {
  return "Abrir os turnos do mês";
}

export function openMonthShiftsModeLabel(mode: OpenMonthShiftsMode): string {
  switch (mode) {
    case "all-applicable":
      return "Todos os dias aplicáveis";
    case "nights-only":
      return "Só noites (segunda a sexta)";
    case "weekends-only":
      return "Só sábados (manhã e tarde)";
    case "custom":
      return "Escolher turnos";
  }
}

export function openMonthShiftsModeHint(mode: OpenMonthShiftsMode): string {
  switch (mode) {
    case "all-applicable":
      return "Segunda a sexta: manhã, tarde e noite. Sábado: manhã e tarde. Domingo sem plantão.";
    case "nights-only":
      return "Somente o plantão das 19:00 às 07:00 nos dias úteis.";
    case "weekends-only":
      return "Somente sábado, manhã e tarde. Domingo continua sem plantão.";
    case "custom":
      return "Escolha manhã, tarde e/ou noite. O domingo e a noite de sábado continuam de fora.";
  }
}

export function openMonthShiftTemplateChipLabel(
  name: OpenMonthShiftTemplateName,
): string {
  const template = DEFAULT_SECTOR_SHIFT_TEMPLATES.find(
    (item) => item.name === name,
  );
  if (!template) return name;
  const start = template.startTime.slice(0, 5);
  const end = template.endTime.slice(0, 5);
  return `${name} ${start}–${end}`;
}

export function openMonthShiftsPreviewCount(count: number): string {
  if (count === 0) return "Nenhum plantão neste recorte.";
  if (count === 1) return "1 plantão vago neste recorte.";
  return `${count} plantões vagos neste recorte.`;
}

export function openMonthShiftsConfirmTitle(count: number): string {
  if (count === 0) return "Nada a criar";
  return "Criar plantões vagos";
}

export function openMonthShiftsToast(created: number, skipped: number): string {
  const createdPart =
    created === 0
      ? "Nenhum plantão novo"
      : created === 1
        ? "1 plantão criado"
        : `${created} plantões criados`;
  const skippedPart =
    skipped === 0
      ? "nenhum já existia"
      : skipped === 1
        ? "1 já existia"
        : `${skipped} já existiam`;
  return `${createdPart}. ${skippedPart.charAt(0).toUpperCase()}${skippedPart.slice(1)}.`;
}
