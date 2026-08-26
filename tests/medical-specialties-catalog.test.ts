import { describe, expect, it } from "vitest";
import {
  getMedicalSpecialtyByCode,
  getOperationalProfileByCode,
  isMedicalSpecialtyCode,
  isOperationalProfileCode,
  MEDICAL_SPECIALTIES,
  MEDICAL_SPECIALTY_SOURCE_VERSION,
  OPERATIONAL_PROFILES,
  OPERATIONAL_PROFILE_CODES,
} from "../lib/medical-specialties";

describe("catálogo canônico de especialidades médicas", () => {
  it("contém exatamente as 55 especialidades da Resolução CFM 2.380/2024", () => {
    expect(MEDICAL_SPECIALTIES).toHaveLength(55);
    expect(MEDICAL_SPECIALTIES.map(({ sortOrder }) => sortOrder)).toEqual(
      Array.from({ length: 55 }, (_, index) => index + 1),
    );
    expect(new Set(MEDICAL_SPECIALTIES.map(({ code }) => code)).size).toBe(55);
    expect(new Set(MEDICAL_SPECIALTIES.map(({ name }) => name)).size).toBe(55);
    expect(
      MEDICAL_SPECIALTIES.every(
        ({ sourceVersion, active }) =>
          sourceVersion === MEDICAL_SPECIALTY_SOURCE_VERSION && active,
      ),
    ).toBe(true);
  });

  it("mantém códigos estáveis para as qualificações usadas no backfill", () => {
    expect(getMedicalSpecialtyByCode("ANESTESIOLOGIA")).toMatchObject({
      name: "Anestesiologia",
      sortOrder: 3,
    });
    expect(
      getMedicalSpecialtyByCode("ORTOPEDIA_E_TRAUMATOLOGIA"),
    ).toMatchObject({
      name: "Ortopedia e traumatologia",
      sortOrder: 45,
    });
    expect(getMedicalSpecialtyByCode("CLINICA_MEDICA")).toMatchObject({
      name: "Clínica médica",
      sortOrder: 16,
    });
  });

  it("separa generalista e residente do catálogo CFM", () => {
    expect(OPERATIONAL_PROFILE_CODES).toEqual([
      "MEDICO_GENERALISTA",
      "RESIDENTE_ANESTESIOLOGIA",
    ]);
    expect(OPERATIONAL_PROFILES).toEqual([
      { code: "MEDICO_GENERALISTA", name: "Médico generalista" },
      {
        code: "RESIDENTE_ANESTESIOLOGIA",
        name: "Residente em anestesiologia",
      },
    ]);
    expect(getOperationalProfileByCode("RESIDENTE_ANESTESIOLOGIA")).toEqual({
      code: "RESIDENTE_ANESTESIOLOGIA",
      name: "Residente em anestesiologia",
    });
    expect(
      MEDICAL_SPECIALTIES.some(({ code }) => code === "MEDICO_GENERALISTA"),
    ).toBe(false);
  });

  it("expõe validadores puros sem aceitar texto livre", () => {
    expect(isMedicalSpecialtyCode("ANESTESIOLOGIA")).toBe(true);
    expect(isMedicalSpecialtyCode("Anestesiologia")).toBe(false);
    expect(isMedicalSpecialtyCode("CLINICA_GERAL")).toBe(false);
    expect(isOperationalProfileCode("MEDICO_GENERALISTA")).toBe(true);
    expect(isOperationalProfileCode("CLINICA_MEDICA")).toBe(false);
  });
});
