/**
 * Repetição do plantonista.
 *
 * Vocabulário (docs/product/escala-ux.md): a *escala* é o conjunto de vagas
 * de um mês; o *plantão* é uma vaga dessa escala; o *plantonista* é quem a
 * ocupa. O que se repete é sempre o plantonista — a vaga é o lugar onde ele
 * cai.
 *
 * - none: só este plantão
 * - weekly: mesmo dia da semana, de 7 em 7 dias
 * - biweekly: de 14 em 14 dias
 * - monthly: mesmo dia da semana e mesmo ordinal no mês
 *
 * Até quando: o gestor escolhe o horizonte em meses (padrão 2, teto 6).
 * Quando a repetição passa do mês de origem, a escala dos meses seguintes é
 * aberta para recebê-la — inclusive criando a vaga que ainda não existe,
 * cópia do plantão de origem. A repetição abre só as vagas de que ela
 * precisa; a forma completa do mês (tem noite? tem fim de semana?) é
 * declarada pelo gestor em outro lugar.
 */
import { isoToBr } from "./form-masks-br";

export const ALLOCATION_REPEAT_RULES = [
  "none",
  "weekly",
  "biweekly",
  "monthly",
] as const;

export type AllocationRepeatRule = (typeof ALLOCATION_REPEAT_RULES)[number];

export const ALLOCATION_REPEAT_SECTION_TITLE = "Repetir esse plantonista:";

/** Horizonte padrão da repetição, em meses. */
export const DEFAULT_ALLOCATION_REPEAT_MONTHS = 2;

/** Teto do horizonte. Além disso o gestor planeja mês a mês. */
export const MAX_ALLOCATION_REPEAT_MONTHS = 6;

export const ALLOCATION_REPEAT_HORIZON_MONTHS: readonly number[] = [
  1, 2, 3, 4, 5, 6,
];

export function allocationRepeatHorizonLabel(months: number): string {
  return months === 1 ? "1 mês" : `${months} meses`;
}

export function clampAllocationRepeatMonths(months: number): number {
  if (!Number.isFinite(months)) return DEFAULT_ALLOCATION_REPEAT_MONTHS;
  const whole = Math.trunc(months);
  if (whole < 1) return 1;
  if (whole > MAX_ALLOCATION_REPEAT_MONTHS) return MAX_ALLOCATION_REPEAT_MONTHS;
  return whole;
}

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
    hint: "Mesmo dia da semana e mesmo turno, de 7 em 7 dias.",
  },
  {
    rule: "biweekly",
    label: "A cada 2 semanas",
    hint: "Mesmo dia da semana e mesmo turno, de 14 em 14 dias.",
  },
  {
    rule: "monthly",
    label: "1 vez por mês",
    hint: "Mesma semana do mês e mesmo dia da semana, uma vez por mês.",
  },
];

export function allocationRepeatHint(rule: AllocationRepeatRule): string {
  return (
    ALLOCATION_REPEAT_OPTIONS.find((option) => option.rule === rule)?.hint ??
    ALLOCATION_REPEAT_OPTIONS[0].hint
  );
}

export function allocationRepeatHorizonHint(
  rule: AllocationRepeatRule,
  months: number,
): string {
  if (rule === "none") return allocationRepeatHint(rule);
  return `${allocationRepeatHint(rule)} Repete por ${allocationRepeatHorizonLabel(
    clampAllocationRepeatMonths(months),
  )}.`;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

export function allocationRepeatToast(
  allocated: number,
  skippedOccupied: number,
  createdSlots = 0,
): string {
  const parts = [
    allocated === 1
      ? "Alocado em 1 plantão"
      : `Alocado em ${allocated} plantões`,
  ];
  if (createdSlots > 0) {
    parts.push(
      `${plural(createdSlots, "vaga aberta", "vagas abertas")} na escala`,
    );
  }
  const head = `${parts.join(", ")}.`;
  if (skippedOccupied <= 0) return head;
  const skippedPart =
    skippedOccupied === 1
      ? "1 já tinha médico"
      : `${skippedOccupied} já tinham médico`;
  return `${head} ${skippedPart}.`;
}

/**
 * Mensagem do bloqueio por choque de janela: já existe outro plantão
 * ocupando exatamente aquele horário no setor, então a vaga da repetição
 * não pode ser aberta ali.
 *
 * Os dias chegam em ISO e saem em DD/MM/AAAA — quem lê é o gestor.
 */
export function allocationRepeatConflictMessage(
  blockedDays: readonly string[],
): string {
  const shown = blockedDays.slice(0, 3).map(isoToBr).join(", ");
  const rest = blockedDays.length - 3;
  const tail = rest > 0 ? ` e mais ${rest}` : "";
  return `Já existe outro plantão neste horário em ${shown}${tail}. Ajuste a escala desses dias ou encurte a repetição.`;
}

/**
 * O que a repetição fará, dito antes de fazer. Uma ação que pode abrir oito
 * plantões não deve ser descoberta pelo resultado.
 */
export function allocationRepeatPreviewText(preview: {
  matchCount: number;
  willOpenCount: number;
  blockedDays: readonly string[];
  lastDayKey: string;
}): string {
  if (preview.blockedDays.length > 0) {
    return allocationRepeatConflictMessage(preview.blockedDays);
  }
  const total = 1 + preview.matchCount + preview.willOpenCount;
  const head =
    total === 1
      ? "Aloca só neste plantão"
      : `Aloca em ${total} plantões, até ${isoToBr(preview.lastDayKey)}`;
  if (preview.willOpenCount <= 0) return `${head}.`;
  return `${head} — ${plural(
    preview.willOpenCount,
    "vaga será aberta",
    "vagas serão abertas",
  )} na escala.`;
}
