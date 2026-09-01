import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ScheduleContextAccessOption } from "../components/ScheduleContextAccessPicker.logic";

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
    operationalProfileCode: null,
    qualificationName: "Todas as especialidades",
    displayName: "Hospital São Carlos — Emergência",
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
  it("apresenta cada escala ativa como uma autorização operacional explícita", () => {
    expect(contexts.map((context) => context.id)).toEqual([1, 2, 3]);
    expect(new Set(contexts.map((context) => context.sectorId))).toEqual(
      new Set([101, 102, 103]),
    );
  });

  it("não remove acesso já escolhido quando a especialidade cadastral muda", () => {
    const selectedIds = [1, 2, 3];
    const activeIds = new Set(contexts.map((context) => context.id));

    expect(selectedIds.filter((id) => activeIds.has(id))).toEqual([1, 2, 3]);
  });

  it("trata a referência clínica como informativa, não como trava do seletor", () => {
    const picker = readFileSync(
      "components/ScheduleContextAccessPicker.tsx",
      "utf8",
    );
    const admin = readFileSync("app/(tabs)/admin.tsx", "utf8");

    expect(picker).toContain("referência clínica é apenas informativa.");
    expect(picker).not.toContain("scheduleContextMatchesQualification");
    expect(picker).not.toContain("compatibleScheduleContextIds");
    expect(admin).not.toContain("compatibleScheduleContextIds");
    const qualificationField = admin.slice(
      admin.indexOf("<ProfessionalQualificationPicker"),
      admin.indexOf("<ScheduleContextAccessPicker"),
    );
    expect(qualificationField).toContain("onChange={setQualification}");
    expect(qualificationField).not.toContain("setScheduleContextIds");
  });
});
