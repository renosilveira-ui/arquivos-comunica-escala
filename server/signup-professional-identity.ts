import {
  getProfessionDefinition,
  professionalIdentityWriteFields,
} from "../lib/profession-definitions";
import { parseMedicalQualification } from "./medical-qualification";

/** Identity only. Never returns institutional roles, membership or management authority. */
export function parseSignupProfessionalIdentity(input: {
  professionCode?: unknown;
  customProfessionName?: unknown;
  medicalSpecialtyCode?: unknown;
  operationalProfileCode?: unknown;
  specialty?: unknown;
  institutionId?: unknown;
}) {
  // Older mobile clients omit the profession. Preserve their medical contract.
  const legacy = input.professionCode === undefined;
  const code = legacy ? "MEDIC" : input.professionCode;
  const definition =
    typeof code === "string" ? getProfessionDefinition(code) : null;
  if (!definition)
    return { ok: false as const, error: "Selecione uma profissão válida." };
  const custom = input.customProfessionName;
  if (custom != null && typeof custom !== "string") {
    return {
      ok: false as const,
      error: "Informe o nome da profissão em texto.",
    };
  }
  if (
    !definition.customProfessionNameRequired &&
    typeof custom === "string" &&
    custom.trim()
  ) {
    return {
      ok: false as const,
      error: "O nome livre da profissão é usado apenas em Outro.",
    };
  }
  const hasMedicalData = [
    input.medicalSpecialtyCode,
    input.operationalProfileCode,
    input.specialty,
  ].some((value) => value !== undefined && value !== null && value !== "");
  if (definition.code !== "MEDIC" && hasMedicalData) {
    return {
      ok: false as const,
      error: "Qualificação médica é exclusiva do cadastro de médico.",
    };
  }
  const qualification = parseMedicalQualification({
    medicalSpecialtyCode: input.medicalSpecialtyCode,
    operationalProfileCode: input.operationalProfileCode,
    legacySpecialty: input.specialty,
    allowMissing:
      !definition.specialtyRequired ||
      (legacy &&
        input.institutionId !== undefined &&
        input.institutionId !== null &&
        input.institutionId !== ""),
  });
  if (!qualification.ok) {
    return {
      ok: false as const,
      error: legacy
        ? qualification.error
        : "Selecione uma especialidade ou perfil médico válido no catálogo, sem informações conflitantes.",
    };
  }
  try {
    return {
      ok: true as const,
      identity: professionalIdentityWriteFields(
        definition.code,
        custom as string | null | undefined,
      ),
      qualification: qualification.value,
    };
  } catch {
    return {
      ok: false as const,
      error: "Informe o nome da profissão com até 100 caracteres.",
    };
  }
}
