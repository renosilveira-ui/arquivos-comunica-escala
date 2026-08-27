export type MonthlyRosterStatus = "DRAFT" | "PUBLISHED" | "LOCKED";

/**
 * PUBLISHED/LOCKED é o status de `monthly_rosters` no par hospital+mês,
 * independente de existirem `shift_instances`. Mês publicado e vazio
 * ainda está sendo montado: o motivo de auditoria só entra quando já
 * há plantão (ou quando o mês está LOCKED).
 */
export function requiresPublishedMonthReason(
  status: MonthlyRosterStatus | undefined,
  hasShifts?: boolean,
): boolean {
  if (status === "LOCKED") return true;
  if (status === "PUBLISHED") return hasShifts !== false;
  return false;
}

export function validatePublishedMonthReason(
  status: MonthlyRosterStatus | undefined,
  reason: string,
  hasShifts?: boolean,
): string | null {
  if (!requiresPublishedMonthReason(status, hasShifts)) return null;
  if (reason.trim().length < 5) {
    return "Informe o motivo da edição (mínimo 5 caracteres) para meses publicados ou bloqueados.";
  }
  return null;
}
