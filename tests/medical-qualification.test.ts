import { describe, expect, it } from "vitest";
import { parseMedicalQualification } from "../server/medical-qualification";

describe("qualificação médica canônica", () => {
  it("aceita exatamente uma especialidade ou perfil operacional", () => {
    expect(
      parseMedicalQualification({
        medicalSpecialtyCode: "ANESTESIOLOGIA",
        operationalProfileCode: null,
      }),
    ).toEqual({
      ok: true,
      value: {
        medicalSpecialtyCode: "ANESTESIOLOGIA",
        operationalProfileCode: null,
        legacyLabel: "Anestesiologia",
      },
    });
    expect(
      parseMedicalQualification({
        medicalSpecialtyCode: null,
        operationalProfileCode: "MEDICO_GENERALISTA",
      }),
    ).toEqual({
      ok: true,
      value: {
        medicalSpecialtyCode: null,
        operationalProfileCode: "MEDICO_GENERALISTA",
        legacyLabel: "Médico generalista",
      },
    });
  });

  it("reconhece clínico geral como Clínica médica e residente como perfil", () => {
    expect(
      parseMedicalQualification({
        medicalSpecialtyCode: undefined,
        operationalProfileCode: undefined,
        legacySpecialty: "  CLÍNICO   GERAL ",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        medicalSpecialtyCode: "CLINICA_MEDICA",
        operationalProfileCode: null,
      },
    });
    expect(
      parseMedicalQualification({
        medicalSpecialtyCode: undefined,
        operationalProfileCode: undefined,
        legacySpecialty: "Residente em anestesiologia",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        medicalSpecialtyCode: null,
        operationalProfileCode: "RESIDENTE_ANESTESIOLOGIA",
      },
    });
    expect(
      parseMedicalQualification({
        medicalSpecialtyCode: undefined,
        operationalProfileCode: undefined,
        legacySpecialty: "Clínica Médica",
      }),
    ).toMatchObject({
      ok: true,
      value: {
        medicalSpecialtyCode: "CLINICA_MEDICA",
        operationalProfileCode: null,
      },
    });
  });

  it("recusa texto livre, códigos inválidos, dupla qualificação e conflitos", () => {
    expect(
      parseMedicalQualification({
        medicalSpecialtyCode: undefined,
        operationalProfileCode: undefined,
        legacySpecialty: "Especialista em TRR",
      }),
    ).toEqual({
      ok: false,
      error: "Especialidade não reconhecida pelo catálogo médico",
    });
    expect(
      parseMedicalQualification({
        medicalSpecialtyCode: "Anestesiologia",
        operationalProfileCode: null,
      }),
    ).toEqual({ ok: false, error: "medicalSpecialtyCode inválido" });
    expect(
      parseMedicalQualification({
        medicalSpecialtyCode: "ANESTESIOLOGIA",
        operationalProfileCode: "MEDICO_GENERALISTA",
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseMedicalQualification({
        medicalSpecialtyCode: "ANESTESIOLOGIA",
        operationalProfileCode: null,
        legacySpecialty: "Ortopedia",
      }),
    ).toEqual({
      ok: false,
      error: "Qualificação estruturada conflita com specialty legado",
    });
  });

  it("só permite ausência quando a compatibilidade legada é explícita", () => {
    expect(
      parseMedicalQualification({
        medicalSpecialtyCode: null,
        operationalProfileCode: null,
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseMedicalQualification({
        medicalSpecialtyCode: null,
        operationalProfileCode: null,
        allowMissing: true,
      }),
    ).toEqual({
      ok: true,
      value: {
        medicalSpecialtyCode: null,
        operationalProfileCode: null,
        legacyLabel: null,
      },
    });
  });
});
