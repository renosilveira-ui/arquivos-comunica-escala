export type MonthlyRosterStatus = "DRAFT" | "PUBLISHED" | "LOCKED";

/**
 * Motivo de auditoria só para edição destrutiva de plantão já existente
 * (mover/atualizar em edit-shift). Criar vago / abrir o mês NUNCA pede
 * motivo em PUBLISHED — montar a escala é trabalho normal do gestor.
 *
 * LOCKED continua exigindo motivo. PUBLISHED vazio também não pede.
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
