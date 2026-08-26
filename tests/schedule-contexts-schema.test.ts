import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/mysql-core";
import {
  hospitals,
  medicalSpecialties,
  professionals,
  scheduleContexts,
  sectors,
  shiftInstances,
} from "../drizzle/schema";

describe("schema de contextos de escala", () => {
  it("mantém a classificação nova nullable nas linhas legadas", () => {
    expect(professionals.medicalSpecialtyId.notNull).toBe(false);
    expect(professionals.operationalProfileCode.notNull).toBe(false);
    expect(shiftInstances.scheduleContextId.notNull).toBe(false);
    expect(professionals.specialty).toBeDefined();
    expect(shiftInstances.specialty).toBeDefined();
  });

  it("tipa o perfil generalista fora da tabela CFM", () => {
    expect(professionals.operationalProfileCode.enumValues).toEqual([
      "MEDICO_GENERALISTA",
      "RESIDENTE_ANESTESIOLOGIA",
    ]);
    expect(scheduleContexts.operationalProfileCode.enumValues).toEqual([
      "MEDICO_GENERALISTA",
      "RESIDENTE_ANESTESIOLOGIA",
    ]);
    expect(scheduleContexts.admissionPolicy.enumValues).toEqual([
      "PINNED_QUALIFICATION",
      "ALL_CFM_SPECIALTIES",
      "ALL_CFM_EXCEPT_GENERALIST",
    ]);
  });

  it("expõe a chave completa de direção da escala", () => {
    expect(scheduleContexts.institutionId.notNull).toBe(true);
    expect(scheduleContexts.hospitalId.notNull).toBe(true);
    expect(scheduleContexts.sectorId.notNull).toBe(true);
    expect(scheduleContexts.medicalSpecialtyId.notNull).toBe(false);
    expect(scheduleContexts.operationalProfileCode.notNull).toBe(false);
    expect(scheduleContexts.active.notNull).toBe(true);
    expect(scheduleContexts.active.hasDefault).toBe(true);
  });

  it("materializa CHECK, unicidade lógica e FKs no schema Drizzle", () => {
    const contextConfig = getTableConfig(scheduleContexts);
    const uniqueColumns = Object.fromEntries(
      contextConfig.uniqueConstraints.map((constraint) => [
        constraint.name,
        constraint.columns.map(({ name }) => name),
      ]),
    );

    expect(contextConfig.checks.map(({ name }) => name)).toContain(
      "chk_schedule_context_qualification_matches_policy",
    );
    expect(
      getTableConfig(professionals).checks.map(({ name }) => name),
    ).toContain("chk_professionals_at_most_one_medical_qualification");
    expect(uniqueColumns).toMatchObject({
      uniq_schedule_context_specialty: [
        "institution_id",
        "hospital_id",
        "sector_id",
        "medical_specialty_id",
      ],
      uniq_schedule_context_operational_profile: [
        "institution_id",
        "hospital_id",
        "sector_id",
        "operational_profile_code",
      ],
      uniq_schedule_context_topology_id: [
        "institution_id",
        "hospital_id",
        "sector_id",
        "id",
      ],
    });
    expect(
      contextConfig.foreignKeys.map((foreignKey) =>
        foreignKey.reference().columns.map(({ name }) => name),
      ),
    ).toEqual(
      expect.arrayContaining([
        ["institution_id"],
        ["hospital_id"],
        ["sector_id"],
        ["medical_specialty_id"],
        ["institution_id", "hospital_id"],
        ["institution_id", "hospital_id", "sector_id"],
      ]),
    );
    expect(
      getTableConfig(shiftInstances).foreignKeys.map((foreignKey) =>
        foreignKey.reference().columns.map(({ name }) => name),
      ),
    ).toEqual(
      expect.arrayContaining([
        ["schedule_context_id"],
        ["institution_id", "hospital_id", "sector_id", "schedule_context_id"],
      ]),
    );
    expect(
      getTableConfig(hospitals).uniqueConstraints.some(
        ({ name }) => name === "uniq_hospitals_topology_id",
      ),
    ).toBe(true);
    expect(
      getTableConfig(sectors).foreignKeys.map((foreignKey) =>
        foreignKey.reference().columns.map(({ name }) => name),
      ),
    ).toEqual(expect.arrayContaining([["institution_id", "hospital_id"]]));
  });

  it("mantém código e versão como dados obrigatórios do catálogo", () => {
    expect(medicalSpecialties.code.notNull).toBe(true);
    expect(medicalSpecialties.name.notNull).toBe(true);
    expect(medicalSpecialties.sourceVersion.notNull).toBe(true);
    expect(medicalSpecialties.active.notNull).toBe(true);
    expect(medicalSpecialties.sortOrder.notNull).toBe(true);
  });
});
