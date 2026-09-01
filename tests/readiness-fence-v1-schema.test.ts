import { getTableConfig } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";
import {
  institutionReadinessFenceEvents,
  institutionReadinessFenceInstallations,
} from "../drizzle/schema";

describe("schema da readiness fence V1", () => {
  it("mantém journal append-only sem FK ou cascade silencioso", () => {
    const config = getTableConfig(institutionReadinessFenceEvents);

    expect(institutionReadinessFenceEvents.id.primary).toBe(true);
    expect(institutionReadinessFenceEvents.id.notNull).toBe(true);
    expect(institutionReadinessFenceEvents.id.dataType).toBe("bigint");
    expect(institutionReadinessFenceEvents.id.hasDefault).toBe(true);
    expect(institutionReadinessFenceEvents.institutionId.notNull).toBe(true);
    expect(config.foreignKeys).toEqual([]);
    expect(
      config.indexes.map((index) => ({
        name: index.config.name,
        columns: index.config.columns.map((column) => column.name),
      })),
    ).toEqual([
      {
        name: "idx_rdf_event_institution_id",
        columns: ["institution_id", "id"],
      },
    ]);
  });

  it("expõe recibo singleton de cobertura instalado", () => {
    const config = getTableConfig(institutionReadinessFenceInstallations);

    expect(institutionReadinessFenceInstallations.id.primary).toBe(true);
    expect(institutionReadinessFenceInstallations.id.notNull).toBe(true);
    expect(institutionReadinessFenceInstallations.coverageVersion.notNull).toBe(
      true,
    );
    expect(institutionReadinessFenceInstallations.coverageHash.notNull).toBe(
      true,
    );
    expect(
      institutionReadinessFenceInstallations.coverageHash.getSQLType(),
    ).toBe("char(64)");
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
