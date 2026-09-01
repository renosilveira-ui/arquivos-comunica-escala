import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  availableScheduleContextOptions,
  isScheduleContextAvailableForAcl,
  scheduleContextClinicalReference,
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
    active: true,
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
    active: true,
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
    active: true,
    serviceSpecialties: [
      { code: "ANESTESIOLOGIA", name: "Anestesiologia" },
      { code: "MEDICINA_DE_EMERGENCIA", name: "Medicina de emergência" },
    ],
  },
  {
    id: 4,
    hospitalId: 10,
    hospitalName: "Hospital São Carlos",
    sectorId: 104,
    sectorName: "Observação",
    medicalSpecialtyCode: null,
    operationalProfileCode: null,
    qualificationName: "Referência clínica não informada",
    displayName: "Hospital São Carlos — Observação",
    active: true,
  },
];

describe("seleção administrativa de escalas", () => {
  it("oferece todos os contextos ativos apesar de especialidade ausente ou divergente", () => {
    expect(
      availableScheduleContextOptions(contexts).map((context) => context.id),
    ).toEqual([1, 2, 3, 4]);
  });

  it("mantém a seleção explícita quando a qualificação muda ou não foi informada", () => {
    const selectedIds = [1, 2, 3, 4];
    expect(
      availableScheduleContextOptions(contexts)
        .filter((context) => selectedIds.includes(context.id))
        .map((context) => context.id),
    ).toEqual(selectedIds);
  });

  it("não oferece um contexto explicitamente inativo", () => {
    const inactive = { ...contexts[1], id: 5, active: false };
    expect(
      availableScheduleContextOptions([...contexts, inactive]).map(
        (context) => context.id,
      ),
    ).toEqual([1, 2, 3, 4]);
    expect(isScheduleContextAvailableForAcl(inactive)).toBe(false);
  });

  it("trata especialidades assistenciais como rótulo, sem usá-las na seleção", () => {
    expect(scheduleContextClinicalReference(contexts[2])).toBe(
      "Anestesiologia, Medicina de emergência",
    );
    expect(scheduleContextClinicalReference(contexts[0])).toBe(
      "Médico generalista",
    );
  });

  it("não reintroduz filtro clínico nem limpeza automática no picker administrativo", () => {
    const picker = readFileSync(
      "components/ScheduleContextAccessPicker.tsx",
      "utf8",
    );
    const admin = readFileSync("app/(tabs)/admin.tsx", "utf8");

    expect(picker).toContain("availableScheduleContextOptions(contexts)");
    expect(picker).not.toContain("scheduleContextMatchesQualification");
    expect(picker).not.toContain("disabled = !qualification");
    expect(admin).not.toContain("compatibleScheduleContextIds");
    expect(admin).toContain(
      '...(professionalRole === "doctor" ? { scheduleContextIds } : {}),',
    );
    expect(admin).toContain("...(isDoctor ? { scheduleContextIds } : {}),");
    expect(admin).toContain("scheduleContextIds,");
  });
});
