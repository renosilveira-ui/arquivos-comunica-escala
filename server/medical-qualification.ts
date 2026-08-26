import {
  MEDICAL_SPECIALTIES,
  OPERATIONAL_PROFILES,
  isMedicalSpecialtyCode,
  isOperationalProfileCode,
  type MedicalSpecialtyCode,
  type OperationalProfileCode,
} from "../lib/medical-specialties";

export type CanonicalMedicalQualification = {
  medicalSpecialtyCode: MedicalSpecialtyCode | null;
  operationalProfileCode: OperationalProfileCode | null;
  /** Projeção temporária para builds/rotinas que ainda leem `specialty`. */
  legacyLabel: string | null;
};

export type MedicalQualificationParseResult =
  | { ok: true; value: CanonicalMedicalQualification }
  | { ok: false; error: string };

function normalizeLabel(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

const LEGACY_SPECIALTY_BY_LABEL = new Map<string, MedicalSpecialtyCode>(
  MEDICAL_SPECIALTIES.map((item) => [normalizeLabel(item.name), item.code]),
);

// Alias historicamente utilizado antes do catálogo estruturado.
LEGACY_SPECIALTY_BY_LABEL.set(
  normalizeLabel("Ortopedia"),
  "ORTOPEDIA_E_TRAUMATOLOGIA",
);

LEGACY_SPECIALTY_BY_LABEL.set(
  normalizeLabel("Clínico geral"),
  "CLINICA_MEDICA",
);
LEGACY_SPECIALTY_BY_LABEL.set(
  normalizeLabel("Clínica geral"),
  "CLINICA_MEDICA",
);

const LEGACY_OPERATIONAL_PROFILE_BY_LABEL = new Map<
  string,
  OperationalProfileCode
>([
  [normalizeLabel("Médico generalista"), "MEDICO_GENERALISTA"],
  [normalizeLabel("Residente em anestesiologia"), "RESIDENTE_ANESTESIOLOGIA"],
  [normalizeLabel("Residente de anestesiologia"), "RESIDENTE_ANESTESIOLOGIA"],
  [normalizeLabel("Residente anestesiologia"), "RESIDENTE_ANESTESIOLOGIA"],
]);

function qualificationFromLegacyLabel(
  value: string,
): CanonicalMedicalQualification | null {
  const normalized = normalizeLabel(value);
  if (!normalized) return null;
  const specialtyCode = LEGACY_SPECIALTY_BY_LABEL.get(normalized);
  if (specialtyCode) {
    const specialty = MEDICAL_SPECIALTIES.find(
      (item) => item.code === specialtyCode,
    )!;
    return {
      medicalSpecialtyCode: specialtyCode,
      operationalProfileCode: null,
      legacyLabel: specialty.name,
    };
  }
  const profileCode = LEGACY_OPERATIONAL_PROFILE_BY_LABEL.get(normalized);
  if (profileCode) {
    const profile = OPERATIONAL_PROFILES.find(
      (item) => item.code === profileCode,
    )!;
    return {
      medicalSpecialtyCode: null,
      operationalProfileCode: profileCode,
      legacyLabel: profile.name,
    };
  }
  return null;
}

function sameQualification(
  left: CanonicalMedicalQualification,
  right: CanonicalMedicalQualification,
): boolean {
  return (
    left.medicalSpecialtyCode === right.medicalSpecialtyCode &&
    left.operationalProfileCode === right.operationalProfileCode
  );
}

/**
 * Converte o payload público em identidade canônica.
 *
 * `legacySpecialty` só aceita um rótulo oficial/alias conhecido para manter a
 * build anterior compatível durante a troca. Texto arbitrário é recusado e
 * "Clínico geral" / "Clínica geral" viram Clínica médica. O único
 * generalista aceito no piloto é o residente em anestesiologia.
 */
export function parseMedicalQualification(input: {
  medicalSpecialtyCode: unknown;
  operationalProfileCode: unknown;
  legacySpecialty?: unknown;
  allowMissing?: boolean;
}): MedicalQualificationParseResult {
  const medicalSpecialtyCode =
    typeof input.medicalSpecialtyCode === "string"
      ? input.medicalSpecialtyCode.trim()
      : input.medicalSpecialtyCode;
  const operationalProfileCode =
    typeof input.operationalProfileCode === "string"
      ? input.operationalProfileCode.trim()
      : input.operationalProfileCode;

  if (
    medicalSpecialtyCode !== undefined &&
    medicalSpecialtyCode !== null &&
    medicalSpecialtyCode !== "" &&
    (typeof medicalSpecialtyCode !== "string" ||
      !isMedicalSpecialtyCode(medicalSpecialtyCode))
  ) {
    return { ok: false, error: "medicalSpecialtyCode inválido" };
  }
  if (
    operationalProfileCode !== undefined &&
    operationalProfileCode !== null &&
    operationalProfileCode !== "" &&
    (typeof operationalProfileCode !== "string" ||
      !isOperationalProfileCode(operationalProfileCode))
  ) {
    return { ok: false, error: "operationalProfileCode inválido" };
  }

  const canonicalSpecialtyCode =
    typeof medicalSpecialtyCode === "string" && medicalSpecialtyCode
      ? medicalSpecialtyCode
      : null;
  const canonicalProfileCode =
    typeof operationalProfileCode === "string" && operationalProfileCode
      ? operationalProfileCode
      : null;
  if (canonicalSpecialtyCode && canonicalProfileCode) {
    return {
      ok: false,
      error:
        "Selecione uma especialidade CFM ou um perfil operacional, não ambos",
    };
  }

  let structured: CanonicalMedicalQualification | null = null;
  if (canonicalSpecialtyCode) {
    const specialty = MEDICAL_SPECIALTIES.find(
      (item) => item.code === canonicalSpecialtyCode,
    )!;
    structured = {
      medicalSpecialtyCode: canonicalSpecialtyCode,
      operationalProfileCode: null,
      legacyLabel: specialty.name,
    };
  } else if (canonicalProfileCode) {
    const profile = OPERATIONAL_PROFILES.find(
      (item) => item.code === canonicalProfileCode,
    )!;
    structured = {
      medicalSpecialtyCode: null,
      operationalProfileCode: canonicalProfileCode,
      legacyLabel: profile.name,
    };
  }

  let legacy: CanonicalMedicalQualification | null = null;
  if (
    input.legacySpecialty !== undefined &&
    input.legacySpecialty !== null &&
    input.legacySpecialty !== ""
  ) {
    if (typeof input.legacySpecialty !== "string") {
      return { ok: false, error: "specialty legado deve ser texto" };
    }
    legacy = qualificationFromLegacyLabel(input.legacySpecialty);
    if (!legacy) {
      return {
        ok: false,
        error: "Especialidade não reconhecida pelo catálogo médico",
      };
    }
  }

  if (structured && legacy && !sameQualification(structured, legacy)) {
    return {
      ok: false,
      error: "Qualificação estruturada conflita com specialty legado",
    };
  }
  const value = structured ?? legacy;
  if (!value && !input.allowMissing) {
    return {
      ok: false,
      error: "Selecione a especialidade ou o perfil operacional",
    };
  }
  return {
    ok: true,
    value: value ?? {
      medicalSpecialtyCode: null,
      operationalProfileCode: null,
      legacyLabel: null,
    },
  };
}
