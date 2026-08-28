/**
 * Repetição da alocação direta do gestor (v1: só o mês do plantão origem).
 *
 * - none: só este plantão
 * - weekly: mesmo dia da semana, de 7 em 7 dias
 * - biweekly: de 14 em 14 dias
 * - monthly: mesmo dia da semana e mesmo ordinal no mês — em outros meses.
 *   No recorte v1 (mês corrente) não há alvo extra.
 */
export const ALLOCATION_REPEAT_RULES = [
  "none",
  "weekly",
  "biweekly",
  "monthly",
] as const;

export type AllocationRepeatRule = (typeof ALLOCATION_REPEAT_RULES)[number];

export const ALLOCATION_REPEAT_SECTION_TITLE = "Repetir essa escala:";

export const ALLOCATION_REPEAT_OPTIONS: {
  rule: AllocationRepeatRule;
  label: string;
  hint: string;
}[] = [
  {
    rule: "none",
    label: "Não repetir",
    hint: "Aloca só neste plantão.",
  },
  {
    rule: "weekly",
    label: "Semanalmente",
    hint: "Mesmo dia da semana e mesmo turno até o fim deste mês.",
  },
  {
    rule: "biweekly",
    label: "A cada 2 semanas",
    hint: "De 14 em 14 dias, mesmo turno, até o fim deste mês.",
  },
  {
    rule: "monthly",
    label: "1 vez por mês",
    hint: "Aloca só neste plantão neste mês.",
  },
];

export function allocationRepeatHint(rule: AllocationRepeatRule): string {
  return (
    ALLOCATION_REPEAT_OPTIONS.find((option) => option.rule === rule)?.hint ??
    ALLOCATION_REPEAT_OPTIONS[0].hint
  );
}

export function allocationRepeatToast(
  allocated: number,
  skippedOccupied: number,
): string {
  const allocatedPart =
    allocated === 1 ? "Alocado em 1 plantão" : `Alocado em ${allocated} plantões`;
  if (skippedOccupied <= 0) {
    return `${allocatedPart}.`;
  }
  const skippedPart =
    skippedOccupied === 1
      ? "1 já tinha médico"
      : `${skippedOccupied} já tinham médico`;
  return `${allocatedPart}. ${skippedPart}.`;
}
