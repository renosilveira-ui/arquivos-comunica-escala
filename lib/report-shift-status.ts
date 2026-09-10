export type ReportShiftStatus =
  "confirmada" | "pendente" | "vaga" | "cancelada" | "indisponivel";

export interface ReportShiftStatusMeta {
  label: string;
  badgeVariant: "neutral" | "success" | "warning";
}

/**
 * Traduz somente os estados que pertencem ao contrato atual da API.
 * Qualquer valor novo ou corrompido permanece visível como indisponível,
 * sem ser contado como cancelamento, vaga ou confirmação.
 */
export function reportShiftStatusFromApi(status: string): ReportShiftStatus {
  switch (status) {
    case "OCUPADO":
      return "confirmada";
    case "PENDENTE":
      return "pendente";
    case "VAGO":
      return "vaga";
    default:
      return "indisponivel";
  }
}

export function reportShiftStatusMeta(
  status: ReportShiftStatus,
): ReportShiftStatusMeta {
  switch (status) {
    case "confirmada":
      return { label: "Confirmada", badgeVariant: "success" };
    case "pendente":
      return { label: "Pendente", badgeVariant: "warning" };
    case "vaga":
      return { label: "Vaga", badgeVariant: "neutral" };
    case "cancelada":
      return { label: "Cancelada", badgeVariant: "neutral" };
    case "indisponivel":
      return { label: "Status indisponível", badgeVariant: "neutral" };
  }
}
