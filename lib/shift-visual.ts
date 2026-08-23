// lib/shift-visual.ts — como um plantão se VESTE na Agenda (proposta de
// design "Escala+ Personalidade", 23/08).
//
// A semântica (label, tom, ícone) continua em lib/shift-status.ts; aqui
// está só a tradução em tokens de cor para o cartão/célula do plantão:
// barra de 4 px à esquerda + fundo tinted + cores de nome/hora. A força
// visual vem da barra e do tinted, não de chip pintado — assim OCUPADO,
// que é a maioria, não grita.
//
//   vago (listagem)  → neutro. Vago não é erro na agenda geral.
//   vagoAcao         → danger. Onde dá para agir (vagas, panorama, detalhe).
//   pendente         → warning. O único com fundo âmbar.
//   ocupado          → success na barra, fundo branco — o nome é o conteúdo.
//   meu              → navy da marca. A única vez que a tinta marca um dado.
//   confirmada       → success tinted (presença registrada).
//   cancelada        → neutro, apagado.

import { shiftStatusMeta, type ShiftStatusContext } from "./shift-status";
import { theme } from "./theme";

export type ShiftVisualKind = "vago" | "vagoAcao" | "pendente" | "ocupado" | "meu" | "confirmada" | "cancelada";

export interface ShiftVisual {
  kind: ShiftVisualKind;
  /** Texto do estado (vem de shift-status). */
  label: string;
  /** Barra de 4 px à esquerda. */
  bar: string;
  /** Fundo e borda do cartão/célula. */
  bg: string;
  border: string;
  /** Nome do profissional. */
  nameFg: string;
  nameWeight: "400" | "500" | "600" | "700";
  /** Horário (numeral tabular). */
  timeFg: string;
  /** Ícone do estado. */
  iconFg: string;
  /** Chip de estado (texto + ícone). */
  badgeBg: string;
  badgeFg: string;
  badgeBorder: string;
}

/**
 * Resolve o "traje" a partir do status do servidor: o plantão do próprio
 * usuário é sempre "meu"; VAGO depende do contexto (listing × actionable),
 * exatamente como lib/shift-status.ts já decide.
 */
export function shiftVisualKind(
  status: string | null | undefined,
  options: { isMine?: boolean; context?: ShiftStatusContext } = {},
): ShiftVisualKind {
  const upper = (status ?? "").toUpperCase();
  if (options.isMine && (upper === "OCUPADO" || upper === "CONFIRMADA" || upper === "PENDENTE")) return "meu";
  switch (upper) {
    case "VAGO":
      return (options.context ?? "listing") === "actionable" ? "vagoAcao" : "vago";
    case "PENDENTE":
      return "pendente";
    case "CONFIRMADA":
      return "confirmada";
    case "CANCELADA":
      return "cancelada";
    case "OCUPADO":
      return "ocupado";
    default:
      return "vago";
  }
}

export function shiftVisual(kind: ShiftVisualKind): ShiftVisual {
  const { palette, colors } = theme;
  switch (kind) {
    case "vagoAcao":
      return {
        kind,
        label: "Vago",
        bar: palette.danger[600],
        bg: palette.danger[50],
        border: palette.danger[200],
        nameFg: palette.danger[900],
        nameWeight: "600",
        timeFg: palette.danger[900],
        iconFg: palette.danger[600],
        badgeBg: palette.danger[100],
        badgeFg: palette.danger[900],
        badgeBorder: palette.danger[200],
      };
    case "pendente":
      return {
        kind,
        label: "Pendente",
        bar: palette.warning[700],
        bg: palette.warning[50],
        border: palette.warning[200],
        nameFg: palette.warning[900],
        nameWeight: "600",
        timeFg: palette.warning[900],
        iconFg: palette.warning[700],
        badgeBg: palette.warning[100],
        badgeFg: palette.warning[900],
        badgeBorder: palette.warning[200],
      };
    case "ocupado":
      return {
        kind,
        label: "Ocupado",
        bar: palette.success[700],
        bg: colors.surface,
        border: colors.borderStrong,
        nameFg: colors.textPrimary,
        nameWeight: "500",
        timeFg: colors.textPrimary,
        iconFg: palette.success[700],
        badgeBg: palette.success[50],
        badgeFg: palette.success[700],
        badgeBorder: palette.success[200],
      };
    case "meu":
      return {
        kind,
        label: "Meu",
        bar: colors.brand,
        bg: palette.primary[50],
        border: palette.primary[200],
        nameFg: colors.brand,
        nameWeight: "700",
        timeFg: colors.brand,
        iconFg: colors.brand,
        badgeBg: palette.success[100],
        badgeFg: palette.success[700],
        badgeBorder: palette.success[200],
      };
    case "confirmada":
      return {
        kind,
        label: "Confirmada",
        bar: palette.success[700],
        bg: palette.success[50],
        border: palette.success[200],
        nameFg: palette.success[900],
        nameWeight: "600",
        timeFg: palette.success[900],
        iconFg: palette.success[700],
        badgeBg: palette.success[100],
        badgeFg: palette.success[700],
        badgeBorder: palette.success[200],
      };
    case "cancelada":
      return {
        kind,
        label: "Cancelada",
        bar: colors.textDisabled,
        bg: colors.surfaceAlt,
        border: colors.border,
        nameFg: colors.textMuted,
        nameWeight: "400",
        timeFg: colors.textMuted,
        iconFg: colors.textMuted,
        badgeBg: colors.surfaceAlt,
        badgeFg: colors.textSecondary,
        badgeBorder: colors.border,
      };
    default:
      return {
        kind: "vago",
        label: "Vago",
        bar: colors.textDisabled,
        bg: palette.neutral[50],
        border: colors.borderStrong,
        nameFg: colors.textSecondary,
        nameWeight: "500",
        timeFg: colors.textSecondary,
        iconFg: colors.textSecondary,
        badgeBg: colors.surfaceAlt,
        badgeFg: colors.textSecondary,
        badgeBorder: colors.borderStrong,
      };
  }
}

/** Atalho: status + contexto → traje completo (com o ícone de shift-status). */
export function shiftVisualFor(
  status: string | null | undefined,
  options: { isMine?: boolean; context?: ShiftStatusContext } = {},
): ShiftVisual & { Icon: ReturnType<typeof shiftStatusMeta>["Icon"] } {
  const kind = shiftVisualKind(status, options);
  const visual = shiftVisual(kind);
  const meta = shiftStatusMeta(status, { context: options.context });
  // "Meu" mantém o rótulo real do estado (Ocupado/Pendente) no chip: a
  // tinta navy já diz que é seu; o chip diz em que pé está.
  const label = kind === "meu" ? meta.label : visual.label;
  return { ...visual, label, Icon: meta.Icon };
}

/** Cor do traço por plantão na folha de mês (presença por estado). */
export function shiftTickColor(status: string | null | undefined, isMine = false): string {
  if (isMine) return theme.colors.brand;
  switch ((status ?? "").toUpperCase()) {
    case "PENDENTE":
      return theme.colors.statusPendente;
    case "VAGO":
      return theme.colors.statusVagoActionable;
    case "CANCELADA":
      return theme.colors.textDisabled;
    default:
      return theme.colors.statusOcupado;
  }
}
