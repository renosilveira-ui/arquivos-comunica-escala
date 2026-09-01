import { getTableConfig } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";
import {
  institutionReadinessFenceExtensionInstallations,
  institutionReadinessFenceInstallations,
} from "../drizzle/schema";

describe("schema do recibo aditivo V2 da fence", () => {
  it("mantém a prova V1 separada e referencia o marcador singleton", () => {
    const config = getTableConfig(
      institutionReadinessFenceExtensionInstallations,
    );

    expect(
      institutionReadinessFenceExtensionInstallations.extensionKey.primary,
    ).toBe(true);
    expect(
      institutionReadinessFenceExtensionInstallations.baseInstallationId
        .notNull,
    ).toBe(true);
    expect(config.columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "extension_key",
        "coverage_version",
        "coverage_hash",
        "base_installation_id",
        "base_coverage_version",
        "base_coverage_hash",
        "installed_at",
      ]),
    );
    expect(
      config.foreignKeys.map((foreignKey) =>
        foreignKey.reference().columns.map(({ name }) => name),
      ),
    ).toEqual(expect.arrayContaining([["base_installation_id"]]));
    expect(institutionReadinessFenceInstallations.id.primary).toBe(true);
  });
});
