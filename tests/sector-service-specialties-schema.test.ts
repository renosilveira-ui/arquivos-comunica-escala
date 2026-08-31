import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/mysql-core";
import {
  medicalSpecialties,
  sectorServiceSpecialties,
} from "../drizzle/schema";

describe("schema de especialidades assistenciais por setor", () => {
  it("mantém a relação N:N dentro da topologia canônica", () => {
    expect(sectorServiceSpecialties.institutionId.notNull).toBe(true);
    expect(sectorServiceSpecialties.hospitalId.notNull).toBe(true);
    expect(sectorServiceSpecialties.sectorId.notNull).toBe(true);
    expect(sectorServiceSpecialties.medicalSpecialtyId.notNull).toBe(true);
    expect(sectorServiceSpecialties.createdAt.notNull).toBe(true);

    const config = getTableConfig(sectorServiceSpecialties);
    const uniqueColumns = Object.fromEntries(
      config.uniqueConstraints.map((constraint) => [
        constraint.name,
        constraint.columns.map(({ name }) => name),
      ]),
    );
    expect(uniqueColumns).toMatchObject({
      uniq_sector_service_specialty: [
        "institution_id",
        "hospital_id",
        "sector_id",
        "medical_specialty_id",
      ],
    });
    expect(config.indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          config: expect.objectContaining({
            name: "idx_sector_service_specialty_specialty",
          }),
        }),
      ]),
    );
    expect(
      config.foreignKeys.map((foreignKey) =>
        foreignKey.reference().columns.map(({ name }) => name),
      ),
    ).toEqual(
      expect.arrayContaining([
        ["institution_id"],
        ["hospital_id"],
        ["sector_id"],
        ["medical_specialty_id"],
        ["institution_id", "hospital_id", "sector_id"],
      ]),
    );
  });

  it("referencia o catálogo médico existente, sem criar outro catálogo", () => {
    expect(sectorServiceSpecialties.medicalSpecialtyId.name).toBe(
      "medical_specialty_id",
    );
    expect(medicalSpecialties.code.name).toBe("code");
  });
});
