import { getTableConfig } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";
import {
  institutionReadinessFenceInstallations,
  institutionReadinessFences,
} from "../drizzle/schema";

describe("schema da fence institucional de prontidão", () => {
  it("tem exatamente uma revisão monotônica por instituição", () => {
    const config = getTableConfig(institutionReadinessFences);

    expect(institutionReadinessFences.institutionId.notNull).toBe(true);
    expect(institutionReadinessFences.institutionId.primary).toBe(true);
    expect(institutionReadinessFences.revision.notNull).toBe(true);
    expect(institutionReadinessFences.revision.hasDefault).toBe(true);
    expect(institutionReadinessFences.revision.dataType).toBe("bigint");
    expect(config.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "institution_id",
        "revision",
        "created_at",
        "updated_at",
      ]),
    );
    expect(
      config.foreignKeys.map((foreignKey) =>
        foreignKey.reference().columns.map(({ name }) => name),
      ),
    ).toEqual(expect.arrayContaining([["institution_id"]]));
  });

  it("expõe marcador singleton de cobertura instalado", () => {
    const config = getTableConfig(institutionReadinessFenceInstallations);

    expect(institutionReadinessFenceInstallations.id.primary).toBe(true);
    expect(institutionReadinessFenceInstallations.id.notNull).toBe(true);
    expect(institutionReadinessFenceInstallations.coverageVersion.notNull).toBe(
      true,
    );
    expect(institutionReadinessFenceInstallations.coverageHash.notNull).toBe(
      true,
    );
    expect(config.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "id",
        "coverage_version",
        "coverage_hash",
        "installed_at",
      ]),
    );
  });
});
