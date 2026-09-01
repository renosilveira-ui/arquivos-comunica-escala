export type ScheduleContextServiceSpecialty = {
  code: string;
  name: string;
};

export type ScheduleContextAccessOption = {
  id: number;
  hospitalId: number;
  hospitalName: string;
  sectorId: number;
  sectorName: string;
  medicalSpecialtyCode: string | null;
  operationalProfileCode: string | null;
  qualificationKind?: "SPECIALTY" | "OPERATIONAL_PROFILE" | "SECTOR_POLICY";
  qualificationCode?: string;
  qualificationName: string;
  displayName: string;
  /**
   * O catálogo administrativo é tenant-scoped e só deve conter escalas
   * ativas. O campo é opcional para manter compatibilidade com a API atual;
   * quando presente como `false`, a UI nunca o oferece para seleção.
   */
  active?: boolean;
  /**
   * Rótulos assistenciais do setor: apresentados para orientar o gestor, mas
   * não participam de qualquer decisão de acesso.
   */
  serviceSpecialties?: readonly ScheduleContextServiceSpecialty[];
};

/**
 * O cliente não interpreta especialidade/perfil para conceder ou negar ACL.
 * A API administrativa já é tenant-scoped; o servidor revalida ID, atividade
 * e topologia no momento da gravação. Aqui só evitamos apresentar um item que
 * uma resposta atualizada tenha marcado explicitamente como inativo.
 */
export function isScheduleContextAvailableForAcl(
  context: ScheduleContextAccessOption,
): boolean {
  return context.active !== false;
}

export function availableScheduleContextOptions(
  contexts: readonly ScheduleContextAccessOption[],
): ScheduleContextAccessOption[] {
  return contexts.filter(isScheduleContextAvailableForAcl);
}

/** Somente apresentação clínica; nunca deve ser usada para filtrar ACL. */
export function scheduleContextClinicalReference(
  context: ScheduleContextAccessOption,
): string {
  const serviceSpecialtyNames = (context.serviceSpecialties ?? [])
    .map((specialty) => specialty.name.trim())
    .filter(Boolean);
  if (serviceSpecialtyNames.length > 0) {
    return serviceSpecialtyNames.join(", ");
  }
  return context.qualificationName.trim() || "Referência clínica não informada";
}
