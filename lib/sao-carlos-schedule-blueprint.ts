import type {
  MedicalSpecialtyCode,
  OperationalProfileCode,
} from "./medical-specialties";

export type ScheduleContextAdmissionPolicy =
  | "PINNED_QUALIFICATION"
  | "ALL_CFM_SPECIALTIES"
  | "ALL_CFM_EXCEPT_GENERALIST";

export type PinnedQualification =
  | { kind: "MEDICAL_SPECIALTY"; code: MedicalSpecialtyCode }
  | { kind: "OPERATIONAL_PROFILE"; code: OperationalProfileCode };

export type SaoCarlosSectorAdmission =
  | { mode: "allowlist"; qualifications: readonly PinnedQualification[] }
  | { mode: "ALL_CFM_SPECIALTIES" }
  | { mode: "ALL_CFM_EXCEPT_GENERALIST" };

export type SaoCarlosSectorBlueprint = {
  sectorName: string;
  category: "internacao" | "cirurgico" | "servico";
  color: `#${string}`;
  admission: SaoCarlosSectorAdmission;
};

/**
 * Sala de Recuperação e TRR: lista fechada do PO (26/08).
 * Clínico geral = Clínica médica (CFM). O único generalista aceito é o
 * residente em anestesiologia.
 */
export const SAO_CARLOS_RECOVERY_QUALIFICATIONS = [
  { kind: "MEDICAL_SPECIALTY", code: "CLINICA_MEDICA" },
  { kind: "OPERATIONAL_PROFILE", code: "RESIDENTE_ANESTESIOLOGIA" },
  { kind: "MEDICAL_SPECIALTY", code: "MEDICINA_DE_EMERGENCIA" },
  { kind: "MEDICAL_SPECIALTY", code: "ANESTESIOLOGIA" },
  { kind: "MEDICAL_SPECIALTY", code: "MEDICINA_INTENSIVA" },
] as const satisfies readonly PinnedQualification[];

/**
 * Ordem operacional: piloto da Sala de Recuperação, depois Traumatologia
 * (ortopedia pediu teste imediato), em seguida os demais setores.
 */
export const HSC_SCHEDULE_CONTEXT_BLUEPRINT: readonly SaoCarlosSectorBlueprint[] =
  [
    {
      sectorName: "Sala de Recuperação",
      category: "cirurgico",
      color: "#16A34A",
      admission: {
        mode: "allowlist",
        qualifications: SAO_CARLOS_RECOVERY_QUALIFICATIONS,
      },
    },
    {
      sectorName: "Traumatologia",
      category: "cirurgico",
      color: "#0369A1",
      admission: {
        mode: "allowlist",
        qualifications: [
          { kind: "MEDICAL_SPECIALTY", code: "ORTOPEDIA_E_TRAUMATOLOGIA" },
        ],
      },
    },
    {
      sectorName: "TRR",
      category: "servico",
      color: "#7C3AED",
      admission: {
        mode: "allowlist",
        qualifications: SAO_CARLOS_RECOVERY_QUALIFICATIONS,
      },
    },
    {
      sectorName: "Emergência",
      category: "servico",
      color: "#DC2626",
      admission: { mode: "ALL_CFM_SPECIALTIES" },
    },
    {
      sectorName: "UTI",
      category: "internacao",
      color: "#EA580C",
      admission: { mode: "ALL_CFM_EXCEPT_GENERALIST" },
    },
  ];

export function flattenSaoCarlosPinnedContexts(): readonly {
  sectorName: string;
  qualification: PinnedQualification;
}[] {
  return HSC_SCHEDULE_CONTEXT_BLUEPRINT.flatMap((sector) =>
    sector.admission.mode === "allowlist"
      ? sector.admission.qualifications.map((qualification) => ({
          sectorName: sector.sectorName,
          qualification,
        }))
      : [],
  );
}
