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
