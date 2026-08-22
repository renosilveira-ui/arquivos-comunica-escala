// lib/shift-status.ts — UMA semântica para o status do plantão na UI.
//
// Antes, cada tela decidia cor e texto por conta própria (VAGO era borda
// neutra na Agenda, vermelho no Panorama, cinza no Dashboard; enums crus
// "OCUPADO"/"PENDENTE" chegavam ao usuário). Regra única:
//
//   VAGO      → "Vago".     danger onde o usuário PODE AGIR (vagas,
//                            panorama, detalhe); neutral em listagem geral.
//   PENDENTE  → "Pendente". warning.
//   OCUPADO   → "Ocupado".  success.
//   cancelada → "Cancelada". neutral.
//
// Nunca renderizar o enum cru: usar shiftStatusMeta(status).label ou o
// componente <ShiftStatusBadge /> (texto + ícone, não só cor).

import { CheckCircle2, CircleDashed, Clock, XCircle, type LucideIcon } from "lucide-react-native";

export type ShiftStatusTone = "danger" | "warning" | "success" | "neutral";
export type ShiftStatusContext = "actionable" | "listing";

export interface ShiftStatusMeta {
  label: string;
  tone: ShiftStatusTone;
  Icon: LucideIcon;
}

export function shiftStatusMeta(
  status: string | null | undefined,
  options: { context?: ShiftStatusContext } = {},
): ShiftStatusMeta {
  const context = options.context ?? "listing";
  switch ((status ?? "").toUpperCase()) {
    case "VAGO":
      return { label: "Vago", tone: context === "actionable" ? "danger" : "neutral", Icon: CircleDashed };
    case "PENDENTE":
      return { label: "Pendente", tone: "warning", Icon: Clock };
    case "OCUPADO":
    case "CONFIRMADA":
      return { label: status?.toUpperCase() === "CONFIRMADA" ? "Confirmada" : "Ocupado", tone: "success", Icon: CheckCircle2 };
    case "CANCELADA":
      return { label: "Cancelada", tone: "neutral", Icon: XCircle };
    default: {
      const raw = (status ?? "").trim();
      const label = raw ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase() : "Sem status";
      return { label, tone: "neutral", Icon: CircleDashed };
    }
  }
}
