/**
 * Catálogo canônico de profissões do Escala+ (identidade profissional).
 *
 * Fonte única para signup, perfil e regras de dado obrigatório.
 * Não concede autoridade institucional, ocupação de plantão, gestão
 * nem entitlement comercial. Extensível por código estável — não é
 * ENUM MySQL rígido e não redesenha AuthZ.
 */

export const PROFESSION_CODES = [
  "MEDIC",
  "NURSING",
  "NURSING_TECHNICIAN",
  "DENTIST",
  "PHYSIOTHERAPIST",
  "LABORATORY_TECHNICIAN",
  "ADMINISTRATIVE",
  "FIREFIGHTER",
  "POLICE",
  "MAINTENANCE_TECHNICIAN",
  "OTHER",
] as const;

export type ProfessionCode = (typeof PROFESSION_CODES)[number];

export type LegacyProfessionalRole = "doctor" | "nurse" | "tech";

export type ProfessionDefinition = {
  code: ProfessionCode;
  label: string;
  registrationRequired: boolean;
  registrationLabel: string | null;
  registrationStateRequired: boolean;
  specialtyRequired: boolean;
  customProfessionNameRequired: boolean;
};

const definition = (
  value: ProfessionDefinition,
): ProfessionDefinition => value;

export const PROFESSION_DEFINITIONS: Record<
  ProfessionCode,
  ProfessionDefinition
> = {
  MEDIC: definition({
    code: "MEDIC",
    label: "Médico",
    registrationRequired: true,
    registrationLabel: "CRM",
    registrationStateRequired: true,
    specialtyRequired: true,
    customProfessionNameRequired: false,
  }),
  NURSING: definition({
    code: "NURSING",
    label: "Enfermeiro",
    registrationRequired: true,
    registrationLabel: "COREN",
    registrationStateRequired: true,
    specialtyRequired: false,
    customProfessionNameRequired: false,
  }),
  NURSING_TECHNICIAN: definition({
    code: "NURSING_TECHNICIAN",
    label: "Técnico de enfermagem",
    registrationRequired: false,
    registrationLabel: "COREN",
    registrationStateRequired: false,
    specialtyRequired: false,
    customProfessionNameRequired: false,
  }),
  DENTIST: definition({
    code: "DENTIST",
    label: "Dentista",
    registrationRequired: false,
    registrationLabel: "CRO",
    registrationStateRequired: false,
    specialtyRequired: false,
    customProfessionNameRequired: false,
  }),
  PHYSIOTHERAPIST: definition({
    code: "PHYSIOTHERAPIST",
    label: "Fisioterapeuta",
    registrationRequired: false,
    registrationLabel: "CREFITO",
    registrationStateRequired: false,
    specialtyRequired: false,
    customProfessionNameRequired: false,
  }),
  LABORATORY_TECHNICIAN: definition({
    code: "LABORATORY_TECHNICIAN",
    label: "Técnico de laboratório / análises clínicas",
    registrationRequired: false,
    registrationLabel: null,
    registrationStateRequired: false,
    specialtyRequired: false,
    customProfessionNameRequired: false,
  }),
  ADMINISTRATIVE: definition({
    code: "ADMINISTRATIVE",
    label: "Administrativo",
    registrationRequired: false,
    registrationLabel: null,
    registrationStateRequired: false,
    specialtyRequired: false,
    customProfessionNameRequired: false,
  }),
  FIREFIGHTER: definition({
    code: "FIREFIGHTER",
    label: "Bombeiro",
    registrationRequired: false,
    registrationLabel: null,
    registrationStateRequired: false,
    specialtyRequired: false,
    customProfessionNameRequired: false,
  }),
  POLICE: definition({
    code: "POLICE",
    label: "Policial",
    registrationRequired: false,
    registrationLabel: null,
    registrationStateRequired: false,
    specialtyRequired: false,
    customProfessionNameRequired: false,
  }),
  MAINTENANCE_TECHNICIAN: definition({
    code: "MAINTENANCE_TECHNICIAN",
    label: "Técnico de manutenção",
    registrationRequired: false,
    registrationLabel: null,
    registrationStateRequired: false,
    specialtyRequired: false,
    customProfessionNameRequired: false,
  }),
  OTHER: definition({
    code: "OTHER",
    label: "Outro",
    registrationRequired: false,
    registrationLabel: null,
    registrationStateRequired: false,
    specialtyRequired: false,
    customProfessionNameRequired: true,
  }),
};

export const PROFESSION_DEFINITION_LIST: readonly ProfessionDefinition[] =
  PROFESSION_CODES.map((code) => PROFESSION_DEFINITIONS[code]);

export function isProfessionCode(value: string): value is ProfessionCode {
  return Object.prototype.hasOwnProperty.call(PROFESSION_DEFINITIONS, value);
}

export function getProfessionDefinition(
  code: string,
): ProfessionDefinition | null {
  return isProfessionCode(code) ? PROFESSION_DEFINITIONS[code] : null;
}

/**
 * Mapeia o papel profissional legado (users.role / body de /register)
 * para o código de profissão. Não mapeia admin/manager: esses valores
 * são autoridade global leftover, não profissão.
 */
export function professionCodeFromLegacyProfessionalRole(
  role: LegacyProfessionalRole,
): ProfessionCode {
  switch (role) {
    case "doctor":
      return "MEDIC";
    case "nurse":
      return "NURSING";
    case "tech":
      return "NURSING_TECHNICIAN";
  }
}

export type ProfessionalIdentityWriteFields = {
  professionCode: ProfessionCode;
  customProfessionName: string | null;
  role: string;
};

const LEGACY_PROFESSIONAL_ROLE_MAX_LENGTH = 100;

/**
 * Campos persistidos em `professionals` a partir do catálogo.
 * `role` permanece o rótulo de exibição legado; a identidade canônica
 * é `professionCode`.
 */
export function professionalIdentityWriteFields(
  professionCode: ProfessionCode,
  customProfessionName?: string | null,
): ProfessionalIdentityWriteFields {
  const definition = PROFESSION_DEFINITIONS[professionCode];
  if (definition.customProfessionNameRequired) {
    const trimmed = customProfessionName?.trim() ?? "";
    if (!trimmed) {
      throw new Error("Nome da profissão é obrigatório para Outro.");
    }
    if (Array.from(trimmed).length > LEGACY_PROFESSIONAL_ROLE_MAX_LENGTH) {
      throw new Error("Nome da profissão deve ter no máximo 100 caracteres.");
    }
    return {
      professionCode,
      customProfessionName: trimmed,
      role: trimmed,
    };
  }
  return {
    professionCode,
    customProfessionName: null,
    role: definition.label,
  };
}
