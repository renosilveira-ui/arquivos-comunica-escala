import { describe, expect, it } from "vitest";
import {
  getProfessionDefinition,
  isProfessionCode,
  PROFESSION_CODES,
  PROFESSION_DEFINITION_LIST,
  PROFESSION_DEFINITIONS,
  professionalIdentityWriteFields,
  professionCodeFromLegacyProfessionalRole,
  type ProfessionDefinition,
} from "../lib/profession-definitions";

const AUTH_Z_LEAK =
  /GESTOR_PLUS|GESTOR_MEDICO|roleInInstitution|userRole|canManage|canOccupy|premium|managerScope|professionalAccess/i;

describe("catálogo canônico de profissões", () => {
  it("expõe exatamente as 10 profissões estruturadas + OTHER", () => {
    expect(PROFESSION_CODES).toEqual([
      "MEDIC",
      "NURSING",
      "NURSING_TECHNICIAN",
      "DENTIST",
      "PHYSIOTHERAPIST",
      "LABORATORY_TECHNICIAN",
      "ADMINISTRATIVE",
      "FIREFIGHTER",
      "POLICE",
      "MAINTENANCE_TECHNICIAN",
      "OTHER",
    ]);
    expect(PROFESSION_DEFINITION_LIST).toHaveLength(11);
    expect(new Set(PROFESSION_DEFINITION_LIST.map(({ code }) => code)).size).toBe(
      11,
    );
    expect(PROFESSION_DEFINITION_LIST.map(({ code }) => code)).toEqual([
      ...PROFESSION_CODES,
    ]);
  });

  it("usa labels PT-BR fechados pelo produto", () => {
    expect(
      Object.fromEntries(
        PROFESSION_DEFINITION_LIST.map(({ code, label }) => [code, label]),
      ),
    ).toEqual({
      MEDIC: "Médico",
      NURSING: "Enfermeiro",
      NURSING_TECHNICIAN: "Técnico de enfermagem",
      DENTIST: "Dentista",
      PHYSIOTHERAPIST: "Fisioterapeuta",
      LABORATORY_TECHNICIAN: "Técnico de laboratório / análises clínicas",
      ADMINISTRATIVE: "Administrativo",
      FIREFIGHTER: "Bombeiro",
      POLICE: "Policial",
      MAINTENANCE_TECHNICIAN: "Técnico de manutenção",
      OTHER: "Outro",
    });
  });

  it("define o contrato médico e de enfermagem sem conceder autoridade", () => {
    expect(PROFESSION_DEFINITIONS.MEDIC).toMatchObject({
      registrationRequired: true,
      registrationLabel: "CRM",
      registrationStateRequired: true,
      specialtyRequired: true,
      customProfessionNameRequired: false,
    });
    expect(PROFESSION_DEFINITIONS.NURSING).toMatchObject({
      registrationRequired: true,
      registrationLabel: "COREN",
      registrationStateRequired: true,
      specialtyRequired: false,
      customProfessionNameRequired: false,
    });
    expect(PROFESSION_DEFINITIONS.NURSING.specialtyRequired).toBe(false);
  });

  it("trata OTHER como escape estrutural, sem registro fictício", () => {
    expect(PROFESSION_DEFINITIONS.OTHER).toMatchObject({
      registrationRequired: false,
      registrationLabel: null,
      registrationStateRequired: false,
      specialtyRequired: false,
      customProfessionNameRequired: true,
    });
  });

  it("não inventa obrigação de registro ou especialidade CFM nas demais profissões", () => {
    const unspecified = PROFESSION_DEFINITION_LIST.filter(
      (item) =>
        item.code !== "MEDIC" &&
        item.code !== "NURSING" &&
        item.code !== "OTHER",
    );
    expect(
      unspecified.every(
        (item) =>
          item.registrationRequired === false &&
          item.registrationStateRequired === false &&
          item.specialtyRequired === false &&
          item.customProfessionNameRequired === false,
      ),
    ).toBe(true);
  });

  it("não carrega AuthZ, ocupação, gestão nem entitlement na definição", () => {
    const keys = Object.keys(PROFESSION_DEFINITIONS.MEDIC).sort();
    expect(keys).toEqual(
      [
        "code",
        "customProfessionNameRequired",
        "label",
        "registrationLabel",
        "registrationRequired",
        "registrationStateRequired",
        "specialtyRequired",
      ].sort(),
    );
    for (const item of PROFESSION_DEFINITION_LIST) {
      expect(JSON.stringify(item)).not.toMatch(AUTH_Z_LEAK);
    }
  });

  it("rejeita códigos desconhecidos e aceita só o catálogo", () => {
    expect(isProfessionCode("MEDIC")).toBe(true);
    expect(isProfessionCode("doctor")).toBe(false);
    expect(isProfessionCode("Médico")).toBe(false);
    expect(getProfessionDefinition("NURSING")?.label).toBe("Enfermeiro");
    expect(getProfessionDefinition("UNKNOWN")).toBeNull();
  });

  it("mapeia o papel profissional legado sem tratar gestão como profissão", () => {
    expect(professionCodeFromLegacyProfessionalRole("doctor")).toBe("MEDIC");
    expect(professionCodeFromLegacyProfessionalRole("nurse")).toBe("NURSING");
    expect(professionCodeFromLegacyProfessionalRole("tech")).toBe(
      "NURSING_TECHNICIAN",
    );
  });

  it("projeta campos de escrita: rótulo do catálogo, OTHER exige nome", () => {
    expect(professionalIdentityWriteFields("MEDIC")).toEqual({
      professionCode: "MEDIC",
      customProfessionName: null,
      role: "Médico",
    });
    expect(professionalIdentityWriteFields("NURSING")).toEqual({
      professionCode: "NURSING",
      customProfessionName: null,
      role: "Enfermeiro",
    });
    expect(
      professionalIdentityWriteFields("OTHER", "  Técnico de som  "),
    ).toEqual({
      professionCode: "OTHER",
      customProfessionName: "Técnico de som",
      role: "Técnico de som",
    });
    expect(() => professionalIdentityWriteFields("OTHER")).toThrow(
      /Nome da profissão é obrigatório/,
    );
    expect(() => professionalIdentityWriteFields("OTHER", "   ")).toThrow(
      /Nome da profissão é obrigatório/,
    );
  });

  it("é extensão estável: acrescentar profissão não exige campo de autoridade", () => {
    const extra: ProfessionDefinition = {
      code: "OTHER",
      label: "Outro",
      registrationRequired: false,
      registrationLabel: null,
      registrationStateRequired: false,
      specialtyRequired: false,
      customProfessionNameRequired: true,
    };
    expect(extra).not.toHaveProperty("canManageSchedule");
    expect(extra).not.toHaveProperty("canOccupyShift");
  });
});
