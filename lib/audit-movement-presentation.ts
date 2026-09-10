/** O nome pode vir do snapshot; ausência nunca deve usar contato como fallback. */
export function auditActorLabel(
  actor: { name?: string | null } | null | undefined,
): string {
  return actor?.name?.trim() || "Usuário desconhecido";
}
