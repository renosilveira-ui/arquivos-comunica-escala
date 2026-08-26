import type {
  MedicalSpecialtyCode,
  OperationalProfileCode,
} from "@/lib/medical-specialties";

export type ScheduleContextQualificationSelection =
  | { kind: "MEDICAL_SPECIALTY"; code: MedicalSpecialtyCode }
  | { kind: "OPERATIONAL_PROFILE"; code: OperationalProfileCode };

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
};

export function scheduleContextMatchesQualification(
  context: ScheduleContextAccessOption,
  qualification: ScheduleContextQualificationSelection | null,
): boolean {
  if (!qualification) return false;
  if (
    context.qualificationKind === "SECTOR_POLICY" &&
    (context.qualificationCode === "ALL_CFM_SPECIALTIES" ||
      context.qualificationCode === "ALL_CFM_EXCEPT_GENERALIST")
  ) {
    return qualification.kind === "MEDICAL_SPECIALTY";
  }
  return qualification.kind === "MEDICAL_SPECIALTY"
    ? context.medicalSpecialtyCode === qualification.code &&
        context.operationalProfileCode === null
    : context.operationalProfileCode === qualification.code &&
        context.medicalSpecialtyCode === null;
}

export function compatibleScheduleContextIds(input: {
  contexts: ScheduleContextAccessOption[];
  qualification: ScheduleContextQualificationSelection | null;
  selectedIds: number[];
}): number[] {
  const compatibleIds = new Set(
    input.contexts
      .filter((context) =>
        scheduleContextMatchesQualification(context, input.qualification),
      )
      .map((context) => context.id),
  );
  return input.selectedIds.filter((id) => compatibleIds.has(id));
}
