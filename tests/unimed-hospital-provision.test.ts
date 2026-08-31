import { describe, expect, it } from "vitest";
import {
  assertUnimedHospitalBlueprint,
  UNIMED_HOSPITAL_BLUEPRINT,
  UNIMED_PROVISION_CONFIRM,
} from "../scripts/provision-unimed-hospitals";

describe("blueprint de provisão Unimed", () => {
  it("mantém HRU e HUS como hospitais independentes, sem escalas duplicadas", () => {
    expect(UNIMED_HOSPITAL_BLUEPRINT.map((hospital) => hospital.name)).toEqual([
      "Hospital Regional Unimed",
      "Hospital Unimed Sul",
    ]);
    expect(
      UNIMED_HOSPITAL_BLUEPRINT.flatMap((hospital) =>
        hospital.sectors.map((sector) => `${hospital.name}:${sector.name}`),
      ),
    ).toEqual([
      "Hospital Regional Unimed:Anestesia",
      "Hospital Regional Unimed:Cirurgia Geral",
      "Hospital Regional Unimed:UTI",
      "Hospital Regional Unimed:Traumatologia e Ortopedia",
      "Hospital Regional Unimed:Emergência",
      "Hospital Unimed Sul:Pediatria",
      "Hospital Unimed Sul:Anestesia",
      "Hospital Unimed Sul:Ginecologia e Obstetrícia",
    ]);
    expect(assertUnimedHospitalBlueprint).not.toThrow();
  });

  it("exige confirmação explícita e mantém a classificação clínica no catálogo", () => {
    expect(UNIMED_PROVISION_CONFIRM).toBe("UNIMED_DOIS_HOSPITAIS_V1");
    expect(
      UNIMED_HOSPITAL_BLUEPRINT.flatMap((hospital) =>
        hospital.sectors.map((sector) => sector.specialtyCode),
      ),
    ).toEqual([
      "ANESTESIOLOGIA",
      "CIRURGIA_GERAL",
      "MEDICINA_INTENSIVA",
      "ORTOPEDIA_E_TRAUMATOLOGIA",
      "MEDICINA_DE_EMERGENCIA",
      "PEDIATRIA",
      "ANESTESIOLOGIA",
      "GINECOLOGIA_E_OBSTETRICIA",
    ]);
  });
});
