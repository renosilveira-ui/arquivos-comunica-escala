import { describe, expect, it } from "vitest";
import {
  compatibleScheduleContextIds,
  scheduleContextMatchesQualification,
  type ScheduleContextAccessOption,
} from "../components/ScheduleContextAccessPicker.logic";

const contexts: ScheduleContextAccessOption[] = [
  {
    id: 1,
    hospitalId: 10,
    hospitalName: "Hospital São Carlos",
    sectorId: 101,
    sectorName: "TRR",
    medicalSpecialtyCode: null,
    operationalProfileCode: "MEDICO_GENERALISTA",
    qualificationName: "Médico generalista",
    displayName: "Hospital São Carlos — TRR — Médico generalista",
  },
  {
    id: 2,
    hospitalId: 10,
    hospitalName: "Hospital São Carlos",
    sectorId: 102,
    sectorName: "Emergência",
    medicalSpecialtyCode: null,
    operationalProfileCode: "MEDICO_GENERALISTA",
    qualificationName: "Médico generalista",
    displayName: "Hospital São Carlos — Emergência — Médico generalista",
  },
  {
    id: 3,
    hospitalId: 10,
    hospitalName: "Hospital São Carlos",
    sectorId: 103,
    sectorName: "Sala de Recuperação",
    medicalSpecialtyCode: "ANESTESIOLOGIA",
    operationalProfileCode: null,
    qualificationName: "Anestesiologia",
    displayName: "Hospital São Carlos — Sala de Recuperação — Anestesiologia",
  },
];

describe("seleção administrativa de escalas", () => {
  it("mostra TRR e Emergência ao generalista, sem misturar Anestesiologia", () => {
    const generalist = {
      kind: "OPERATIONAL_PROFILE" as const,
      code: "MEDICO_GENERALISTA" as const,
    };
    expect(
      contexts
        .filter((context) =>
          scheduleContextMatchesQualification(context, generalist),
        )
        .map((context) => context.id),
    ).toEqual([1, 2]);
  });

  it("remove seleções incompatíveis quando a qualificação muda", () => {
    expect(
      compatibleScheduleContextIds({
        contexts,
        qualification: {
          kind: "MEDICAL_SPECIALTY",
          code: "ANESTESIOLOGIA",
        },
        selectedIds: [1, 2, 3],
      }),
    ).toEqual([3]);
  });

  it("oferece Emergência aberta a especialista CFM, não a residente", () => {
    const emergency: ScheduleContextAccessOption = {
      id: 4,
      hospitalId: 10,
      hospitalName: "Hospital São Carlos",
      sectorId: 102,
      sectorName: "Emergência",
      medicalSpecialtyCode: null,
      operationalProfileCode: null,
      qualificationKind: "SECTOR_POLICY",
      qualificationCode: "ALL_CFM_SPECIALTIES",
      qualificationName: "Todas as especialidades",
      displayName: "Hospital São Carlos — Emergência",
    };
    expect(
      scheduleContextMatchesQualification(emergency, {
        kind: "MEDICAL_SPECIALTY",
        code: "ANESTESIOLOGIA",
      }),
    ).toBe(true);
    expect(
      scheduleContextMatchesQualification(emergency, {
        kind: "OPERATIONAL_PROFILE",
        code: "RESIDENTE_ANESTESIOLOGIA",
      }),
    ).toBe(false);
  });
});
