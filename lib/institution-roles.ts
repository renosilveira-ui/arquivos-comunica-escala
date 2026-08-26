export type InstitutionRole = "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";

export const INSTITUTION_ROLE_LABELS: Record<InstitutionRole, string> = {
  USER: "Usuário",
  GESTOR_MEDICO: "Gestor médico",
  GESTOR_PLUS: "Gestor+",
};

/** Rótulo canônico do papel na instituição ativa; evita users.role legado na UI. */
export function profileRoleBadgeLabel(input: {
  isGlobalAdmin?: boolean;
  roleInInstitution?: InstitutionRole | null;
  legacyGlobalRole?: string | null;
}): string {
  if (input.isGlobalAdmin) return "Administrador";
  if (input.roleInInstitution) {
    return INSTITUTION_ROLE_LABELS[input.roleInInstitution];
  }
  switch (input.legacyGlobalRole) {
    case "admin":
      return "Administrador";
    case "manager":
      return "Gestor";
    case "doctor":
      return "Médico";
    case "nurse":
      return "Enfermeiro(a)";
    case "tech":
      return "Técnico(a)";
    default:
      return "";
  }
}
