/**
 * Relação canônica de especialidades médicas reconhecidas pela Resolução
 * CFM nº 2.380/2024 (Portaria CME nº 1/2024).
 *
 * `code` é a identidade estável usada pelo sistema. `name` é apenas o rótulo
 * humano oficial e pode ser revisado em uma futura versão do catálogo sem
 * trocar a identidade já persistida.
 */
export const MEDICAL_SPECIALTY_SOURCE_VERSION = "CFM_2380_2024" as const;

const specialty = <Code extends string>(
  code: Code,
  name: string,
  sortOrder: number,
) => ({
  code,
  name,
  sourceVersion: MEDICAL_SPECIALTY_SOURCE_VERSION,
  active: true as const,
  sortOrder,
});

export const MEDICAL_SPECIALTIES = [
  specialty("ACUPUNTURA", "Acupuntura", 1),
  specialty("ALERGIA_E_IMUNOLOGIA", "Alergia e imunologia", 2),
  specialty("ANESTESIOLOGIA", "Anestesiologia", 3),
  specialty("ANGIOLOGIA", "Angiologia", 4),
  specialty("CARDIOLOGIA", "Cardiologia", 5),
  specialty("CIRURGIA_CARDIOVASCULAR", "Cirurgia cardiovascular", 6),
  specialty("CIRURGIA_DA_MAO", "Cirurgia da mão", 7),
  specialty("CIRURGIA_DE_CABECA_E_PESCOCO", "Cirurgia de cabeça e pescoço", 8),
  specialty(
    "CIRURGIA_DO_APARELHO_DIGESTIVO",
    "Cirurgia do aparelho digestivo",
    9,
  ),
  specialty("CIRURGIA_GERAL", "Cirurgia geral", 10),
  specialty("CIRURGIA_ONCOLOGICA", "Cirurgia oncológica", 11),
  specialty("CIRURGIA_PEDIATRICA", "Cirurgia pediátrica", 12),
  specialty("CIRURGIA_PLASTICA", "Cirurgia plástica", 13),
  specialty("CIRURGIA_TORACICA", "Cirurgia torácica", 14),
  specialty("CIRURGIA_VASCULAR", "Cirurgia vascular", 15),
  specialty("CLINICA_MEDICA", "Clínica médica", 16),
  specialty("COLOPROCTOLOGIA", "Coloproctologia", 17),
  specialty("DERMATOLOGIA", "Dermatologia", 18),
  specialty("ENDOCRINOLOGIA_E_METABOLOGIA", "Endocrinologia e metabologia", 19),
  specialty("ENDOSCOPIA", "Endoscopia", 20),
  specialty("GASTROENTEROLOGIA", "Gastroenterologia", 21),
  specialty("GENETICA_MEDICA", "Genética médica", 22),
  specialty("GERIATRIA", "Geriatria", 23),
  specialty("GINECOLOGIA_E_OBSTETRICIA", "Ginecologia e obstetrícia", 24),
  specialty("HEMATOLOGIA_E_HEMOTERAPIA", "Hematologia e hemoterapia", 25),
  specialty("HOMEOPATIA", "Homeopatia", 26),
  specialty("INFECTOLOGIA", "Infectologia", 27),
  specialty("MASTOLOGIA", "Mastologia", 28),
  specialty("MEDICINA_DE_EMERGENCIA", "Medicina de emergência", 29),
  specialty(
    "MEDICINA_DE_FAMILIA_E_COMUNIDADE",
    "Medicina de família e comunidade",
    30,
  ),
  specialty("MEDICINA_DO_TRABALHO", "Medicina do trabalho", 31),
  specialty("MEDICINA_DO_TRAFEGO", "Medicina do tráfego", 32),
  specialty("MEDICINA_ESPORTIVA", "Medicina esportiva", 33),
  specialty(
    "MEDICINA_FISICA_E_REABILITACAO",
    "Medicina física e reabilitação",
    34,
  ),
  specialty("MEDICINA_INTENSIVA", "Medicina intensiva", 35),
  specialty(
    "MEDICINA_LEGAL_E_PERICIA_MEDICA",
    "Medicina legal e perícia médica",
    36,
  ),
  specialty("MEDICINA_NUCLEAR", "Medicina nuclear", 37),
  specialty("MEDICINA_PREVENTIVA_E_SOCIAL", "Medicina preventiva e social", 38),
  specialty("NEFROLOGIA", "Nefrologia", 39),
  specialty("NEUROCIRURGIA", "Neurocirurgia", 40),
  specialty("NEUROLOGIA", "Neurologia", 41),
  specialty("NUTROLOGIA", "Nutrologia", 42),
  specialty("OFTALMOLOGIA", "Oftalmologia", 43),
  specialty("ONCOLOGIA_CLINICA", "Oncologia clínica", 44),
  specialty("ORTOPEDIA_E_TRAUMATOLOGIA", "Ortopedia e traumatologia", 45),
  specialty("OTORRINOLARINGOLOGIA", "Otorrinolaringologia", 46),
  specialty("PATOLOGIA", "Patologia", 47),
  specialty(
    "PATOLOGIA_CLINICA_MEDICINA_LABORATORIAL",
    "Patologia clínica/medicina laboratorial",
    48,
  ),
  specialty("PEDIATRIA", "Pediatria", 49),
  specialty("PNEUMOLOGIA", "Pneumologia", 50),
  specialty("PSIQUIATRIA", "Psiquiatria", 51),
  specialty(
    "RADIOLOGIA_E_DIAGNOSTICO_POR_IMAGEM",
    "Radiologia e diagnóstico por imagem",
    52,
  ),
  specialty("RADIOTERAPIA", "Radioterapia", 53),
  specialty("REUMATOLOGIA", "Reumatologia", 54),
  specialty("UROLOGIA", "Urologia", 55),
] as const;

export type MedicalSpecialty = (typeof MEDICAL_SPECIALTIES)[number];
export type MedicalSpecialtyCode = MedicalSpecialty["code"];

/**
 * Perfil operacional não é especialidade reconhecida pelo CFM. Em especial,
 * "médico generalista" nunca deve ser persistido como Clínica médica.
 */
export const OPERATIONAL_PROFILE_CODES = [
  "MEDICO_GENERALISTA",
  "RESIDENTE_ANESTESIOLOGIA",
] as const;

export type OperationalProfileCode = (typeof OPERATIONAL_PROFILE_CODES)[number];

export const OPERATIONAL_PROFILES = [
  { code: "MEDICO_GENERALISTA", name: "Médico generalista" },
  {
    code: "RESIDENTE_ANESTESIOLOGIA",
    name: "Residente em anestesiologia",
  },
] as const satisfies readonly {
  code: OperationalProfileCode;
  name: string;
}[];

/** Perfis sem título de especialista. Não entram em UTI nem em setor aberto CFM. */
export function isGeneralistOperationalProfile(
  code: string | null | undefined,
): boolean {
  return (
    code === "MEDICO_GENERALISTA" || code === "RESIDENTE_ANESTESIOLOGIA"
  );
}

const MEDICAL_SPECIALTY_CODE_SET = new Set<string>(
  MEDICAL_SPECIALTIES.map(({ code }) => code),
);

export function isMedicalSpecialtyCode(
  value: string,
): value is MedicalSpecialtyCode {
  return MEDICAL_SPECIALTY_CODE_SET.has(value);
}

export function isOperationalProfileCode(
  value: string,
): value is OperationalProfileCode {
  return (OPERATIONAL_PROFILE_CODES as readonly string[]).includes(value);
}

export function getMedicalSpecialtyByCode(code: MedicalSpecialtyCode) {
  return MEDICAL_SPECIALTIES.find(
    (specialtyItem) => specialtyItem.code === code,
  );
}

export function getOperationalProfileByCode(code: OperationalProfileCode) {
  return OPERATIONAL_PROFILES.find((profile) => profile.code === code);
}
