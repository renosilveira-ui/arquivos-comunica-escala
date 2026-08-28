import type { InstitutionRole } from "@/lib/institution-roles";

export function canCreateInstitutionHospital(input: {
  isGlobalAdmin?: boolean;
  roleInInstitution?: InstitutionRole | null;
}): boolean {
  return Boolean(input.isGlobalAdmin) || input.roleInInstitution === "GESTOR_PLUS";
}

export function createHospitalButtonTitle(): string {
  return "Criar hospital";
}

export function createHospitalModalTitle(): string {
  return "Criar hospital";
}

export function createHospitalDescription(): string {
  return "Informe o nome do hospital. Depois você cria a escala do setor e abre os turnos do mês. Só o Gestor+ ou o administrador da instituição podem cadastrar.";
}

export function createHospitalEmptyTitle(): string {
  return "Cadastre o hospital da instituição";
}

export function createHospitalEmptyDescription(): string {
  return "Sem hospital não há calendário. Gestor+ e o administrador cadastram o hospital neste vínculo; o gestor de setor não cria hospital.";
}

export function createHospitalNamePlaceholder(): string {
  return "Ex.: hospital regional";
}

export function createHospitalConfirmTitle(): string {
  return "Criar hospital";
}

export function createHospitalToast(hospitalName: string): string {
  return `${hospitalName} criado. Agora você pode criar a escala do setor.`;
}
