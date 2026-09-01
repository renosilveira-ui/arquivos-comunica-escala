import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  extractIdempotentTriggerStatements,
  extractIdempotentTriggerStatementsForSources,
  planIdempotentTriggerInstallation,
  type ExistingColumnDefinition,
  type ExistingKeyDefinition,
  type ExistingTableDefinition,
  type ExistingTriggerDefinition,
  type ReadinessFenceCatalog,
  READINESS_FENCE_OWNED_TABLES,
  READINESS_FENCE_SOURCE_COLUMNS,
} from "../scripts/apply-readiness-fence-migration";
import {
  assertExistingReadinessFenceV2InstallationTable,
  assertReadinessFenceV2SourceSchema,
  calculateReadinessFenceV2CoverageHash,
  classifyReadinessFenceV2ExtensionInstallation,
  extractReadinessFenceV2TableStatements,
  READINESS_FENCE_V2_OWNED_TABLE,
  READINESS_FENCE_V2_SOURCE_COLUMNS,
} from "../scripts/apply-readiness-fence-v2-migration";
import {
  READINESS_FENCE_COVERAGE_HASH,
  READINESS_FENCE_COVERAGE_VERSION,
  READINESS_FENCE_INSTALLATION_ID,
} from "../server/readiness-fence-contract";
import {
  READINESS_FENCE_V2_COVERAGE_HASH,
  READINESS_FENCE_V2_COVERAGE_VERSION,
  READINESS_FENCE_V2_EXTENSION_KEY,
  READINESS_FENCE_V2_PREDECESSOR,
} from "../server/readiness-fence-v2-contract";

const v1Migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-08-31-institution-readiness-fences.sql",
    import.meta.url,
  ),
  "utf8",
);
const v2Migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-01-institution-readiness-fence-v2-sector-service-specialties.sql",
    import.meta.url,
  ),
  "utf8",
);

function v1SourceTables(): ExistingTableDefinition[] {
  return Object.keys(READINESS_FENCE_SOURCE_COLUMNS).map((tableName) => ({
    tableName,
    tableType: "BASE TABLE",
    engine: "InnoDB",
  }));
}

function v1SourceColumns(): ExistingColumnDefinition[] {
  return Object.entries(READINESS_FENCE_SOURCE_COLUMNS).flatMap(
    ([tableName, columns]) =>
      columns.map((columnName) => ({
        tableName,
        columnName,
        columnType: "int",
        isNullable: "NO",
        columnKey: "",
      })),
  );
}

function v1OwnedTables(): ExistingTableDefinition[] {
  return READINESS_FENCE_OWNED_TABLES.map((tableName) => ({
    tableName,
    tableType: "BASE TABLE",
    engine: "InnoDB",
  }));
}

function v1OwnedColumns(): ExistingColumnDefinition[] {
  return [
    {
      tableName: "institution_readiness_fences",
      columnName: "institution_id",
      columnType: "int",
      isNullable: "NO",
      columnKey: "PRI",
    },
    {
      tableName: "institution_readiness_fences",
      columnName: "revision",
      columnType: "bigint unsigned",
      isNullable: "NO",
      columnKey: "",
    },
    {
      tableName: "institution_readiness_fences",
      columnName: "created_at",
      columnType: "timestamp",
      isNullable: "NO",
      columnKey: "",
    },
    {
      tableName: "institution_readiness_fences",
      columnName: "updated_at",
      columnType: "timestamp",
      isNullable: "NO",
      columnKey: "",
    },
    {
      tableName: "institution_readiness_fence_installations",
      columnName: "id",
      columnType: "tinyint unsigned",
      isNullable: "NO",
      columnKey: "PRI",
    },
    {
      tableName: "institution_readiness_fence_installations",
      columnName: "coverage_version",
      columnType: "varchar(64)",
      isNullable: "NO",
      columnKey: "",
    },
    {
      tableName: "institution_readiness_fence_installations",
      columnName: "coverage_hash",
      columnType: "char(64)",
      isNullable: "NO",
      columnKey: "",
    },
    {
      tableName: "institution_readiness_fence_installations",
      columnName: "installed_at",
      columnType: "timestamp",
      isNullable: "NO",
      columnKey: "",
    },
  ];
}

function v1OwnedKeys(): ExistingKeyDefinition[] {
  return [
    {
      tableName: "institution_readiness_fences",
      constraintName: "PRIMARY",
      columnName: "institution_id",
      ordinalPosition: 1,
      referencedTableName: null,
      referencedColumnName: null,
    },
    {
      tableName: "institution_readiness_fences",
      constraintName: "fk_institution_readiness_fences_institution",
      columnName: "institution_id",
      ordinalPosition: 1,
      referencedTableName: "institutions",
      referencedColumnName: "id",
    },
    {
      tableName: "institution_readiness_fence_installations",
      constraintName: "PRIMARY",
      columnName: "id",
      ordinalPosition: 1,
      referencedTableName: null,
      referencedColumnName: null,
    },
  ];
}

function v2SourceTable(): ExistingTableDefinition {
  return {
    tableName: "sector_service_specialties",
    tableType: "BASE TABLE",
    engine: "InnoDB",
  };
}

function v2SourceColumns(): ExistingColumnDefinition[] {
  return READINESS_FENCE_V2_SOURCE_COLUMNS.sector_service_specialties.map(
    (columnName) => ({
      tableName: "sector_service_specialties",
      columnName,
      columnType: "int",
      isNullable: "NO",
      columnKey: "",
    }),
  );
}

function v2SourceKeys(): ExistingKeyDefinition[] {
  return [
    {
      tableName: "sector_service_specialties",
      constraintName: "PRIMARY",
      columnName: "id",
      ordinalPosition: 1,
      referencedTableName: null,
      referencedColumnName: null,
    },
    {
      tableName: "sector_service_specialties",
      constraintName: "fk_sector_service_specialty_institution",
      columnName: "institution_id",
      ordinalPosition: 1,
      referencedTableName: "institutions",
      referencedColumnName: "id",
    },
    {
      tableName: "sector_service_specialties",
      constraintName: "fk_sector_service_specialty_hospital",
      columnName: "hospital_id",
      ordinalPosition: 1,
      referencedTableName: "hospitals",
      referencedColumnName: "id",
    },
    {
      tableName: "sector_service_specialties",
      constraintName: "fk_sector_service_specialty_sector",
      columnName: "sector_id",
      ordinalPosition: 1,
      referencedTableName: "sectors",
      referencedColumnName: "id",
    },
    {
      tableName: "sector_service_specialties",
      constraintName: "fk_sector_service_specialty_medical_specialty",
      columnName: "medical_specialty_id",
      ordinalPosition: 1,
      referencedTableName: "medical_specialties",
      referencedColumnName: "id",
    },
    ...[
      "institution_id",
      "hospital_id",
      "sector_id",
      "medical_specialty_id",
    ].map((columnName, index) => ({
      tableName: "sector_service_specialties",
      constraintName: "uniq_sector_service_specialty",
      columnName,
      ordinalPosition: index + 1,
      referencedTableName: null,
      referencedColumnName: null,
    })),
    ...[
      ["institution_id", "institution_id"],
      ["hospital_id", "hospital_id"],
      ["sector_id", "id"],
    ].map(([columnName, referencedColumnName], index) => ({
      tableName: "sector_service_specialties",
      constraintName: "fk_sector_service_specialty_topology",
      columnName: columnName!,
      ordinalPosition: index + 1,
      referencedTableName: "sectors",
      referencedColumnName: referencedColumnName!,
    })),
  ];
}

function v2OwnedTable(): ExistingTableDefinition {
  return {
    tableName: READINESS_FENCE_V2_OWNED_TABLE,
    tableType: "BASE TABLE",
    engine: "InnoDB",
  };
}

function v2OwnedColumns(): ExistingColumnDefinition[] {
  return [
    ["extension_key", "varchar(64)", "PRI"],
    ["coverage_version", "varchar(64)", ""],
    ["coverage_hash", "char(64)", ""],
    ["base_installation_id", "tinyint unsigned", ""],
    ["base_coverage_version", "varchar(64)", ""],
    ["base_coverage_hash", "char(64)", ""],
    ["installed_at", "timestamp", ""],
  ].map(([columnName, columnType, columnKey]) => ({
    tableName: READINESS_FENCE_V2_OWNED_TABLE,
    columnName: columnName!,
    columnType: columnType!,
    isNullable: "NO",
    columnKey: columnKey!,
  }));
}

function v2OwnedKeys(): ExistingKeyDefinition[] {
  return [
    {
      tableName: READINESS_FENCE_V2_OWNED_TABLE,
      constraintName: "PRIMARY",
      columnName: "extension_key",
      ordinalPosition: 1,
      referencedTableName: null,
      referencedColumnName: null,
    },
    {
      tableName: READINESS_FENCE_V2_OWNED_TABLE,
      constraintName: "fk_readiness_fence_extension_base_installation",
      columnName: "base_installation_id",
      ordinalPosition: 1,
      referencedTableName: "institution_readiness_fence_installations",
      referencedColumnName: "id",
    },
  ];
}

function existingV1Triggers(): ExistingTriggerDefinition[] {
  return extractIdempotentTriggerStatements(v1Migration).triggers.map(
    (trigger) => ({
      triggerName: trigger.name,
      actionTiming: trigger.timing,
      eventManipulation: trigger.event,
      eventObjectTable: trigger.table,
      actionOrientation: "ROW",
      actionStatement: trigger.actionStatement,
    }),
  );
}

function existingV2Triggers(): ExistingTriggerDefinition[] {
  return extractIdempotentTriggerStatementsForSources(v2Migration, [
    "sector_service_specialties",
  ]).triggers.map((trigger) => ({
    triggerName: trigger.name,
    actionTiming: trigger.timing,
    eventManipulation: trigger.event,
    eventObjectTable: trigger.table,
    actionOrientation: "ROW",
    actionStatement: trigger.actionStatement,
  }));
}

function completeCatalog(includeV2OwnedTable = true): ReadinessFenceCatalog {
  return {
    tables: [
      ...v1SourceTables(),
      ...v1OwnedTables(),
      v2SourceTable(),
      ...(includeV2OwnedTable ? [v2OwnedTable()] : []),
    ],
    columns: [
      ...v1SourceColumns(),
      ...v1OwnedColumns(),
      ...v2SourceColumns(),
      ...(includeV2OwnedTable ? v2OwnedColumns() : []),
    ],
    keys: [
      ...v1OwnedKeys(),
      ...v2SourceKeys(),
      ...(includeV2OwnedTable ? v2OwnedKeys() : []),
    ],
    triggers: [...existingV1Triggers(), ...existingV2Triggers()],
  };
}

function exactV2Receipt() {
  return {
    extensionKey: READINESS_FENCE_V2_EXTENSION_KEY,
    coverageVersion: READINESS_FENCE_V2_COVERAGE_VERSION,
    coverageHash: READINESS_FENCE_V2_COVERAGE_HASH,
    baseInstallationId: READINESS_FENCE_V2_PREDECESSOR.installationId,
    baseCoverageVersion: READINESS_FENCE_V2_PREDECESSOR.coverageVersion,
    baseCoverageHash: READINESS_FENCE_V2_PREDECESSOR.coverageHash,
  };
}

describe("instalador aditivo da extensão V2 da fence", () => {
  it("fixa o hash V2 sobre somente a relação N:N e a prova V1", () => {
    const extracted = extractIdempotentTriggerStatementsForSources(
      v2Migration,
      ["sector_service_specialties"],
    );

    expect(
      extractReadinessFenceV2TableStatements(extracted.executableSql),
    ).toHaveLength(1);
    expect(extracted.triggers).toHaveLength(3);
    expect(calculateReadinessFenceV2CoverageHash(extracted.triggers)).toBe(
      READINESS_FENCE_V2_COVERAGE_HASH,
    );
    expect(READINESS_FENCE_V2_COVERAGE_HASH).toBe(
      "78a001ddfa0c443a9ca833d75e2b43e764478b91244eac5a2bf82192866cd435",
    );
    expect(READINESS_FENCE_V2_PREDECESSOR).toEqual({
      installationId: READINESS_FENCE_INSTALLATION_ID,
      coverageVersion: READINESS_FENCE_COVERAGE_VERSION,
      coverageHash: READINESS_FENCE_COVERAGE_HASH,
    });
  });

  it("aceita somente recibo V2 exato e deixa V1 imutável", () => {
    expect(classifyReadinessFenceV2ExtensionInstallation([])).toBe(
      "V2_EXTENSION_ABSENT",
    );
    expect(
      classifyReadinessFenceV2ExtensionInstallation([exactV2Receipt()]),
    ).toBe("V2_EXTENSION_EXACT");
    expect(() =>
      classifyReadinessFenceV2ExtensionInstallation([
        { ...exactV2Receipt(), baseCoverageHash: "b".repeat(64) },
      ]),
    ).toThrow("V2_EXTENSION_INSTALLATION_DIVERGENT");
    expect(() =>
      classifyReadinessFenceV2ExtensionInstallation([
        exactV2Receipt(),
        exactV2Receipt(),
      ]),
    ).toThrow("V2_EXTENSION_INSTALLATION_DIVERGENT");
  });

  it("exige a relação N:N topológica sem consultar atividade do catálogo", () => {
    const catalog = completeCatalog(false);
    expect(() => assertReadinessFenceV2SourceSchema(catalog)).not.toThrow();
    expect(
      catalog.tables.some((table) => table.tableName === "medical_specialties"),
    ).toBe(false);
    expect(() =>
      assertReadinessFenceV2SourceSchema({
        ...catalog,
        keys: catalog.keys.filter(
          (key) =>
            key.constraintName !== "fk_sector_service_specialty_topology",
        ),
      }),
    ).toThrow("SOURCE_CONSTRAINT_UNVERIFIED:topology");
    expect(() =>
      assertReadinessFenceV2SourceSchema({
        ...catalog,
        keys: catalog.keys.filter(
          (key) =>
            key.constraintName !==
            "fk_sector_service_specialty_medical_specialty",
        ),
      }),
    ).toThrow("SOURCE_CONSTRAINT_UNVERIFIED:medical_specialty");
    expect(() =>
      assertReadinessFenceV2SourceSchema({
        ...catalog,
        keys: catalog.keys.map((key) =>
          key.constraintName === "fk_sector_service_specialty_hospital"
            ? { ...key, referencedTableName: "institutions" }
            : key,
        ),
      }),
    ).toThrow("SOURCE_CONSTRAINT_UNVERIFIED:hospital");
  });

  it("valida a tabela própria se ela existir, mas permite recuperação sem recibo", () => {
    expect(() =>
      assertExistingReadinessFenceV2InstallationTable(completeCatalog(false)),
    ).not.toThrow();
    expect(() =>
      assertExistingReadinessFenceV2InstallationTable(completeCatalog()),
    ).not.toThrow();
    expect(() =>
      assertExistingReadinessFenceV2InstallationTable({
        ...completeCatalog(),
        columns: completeCatalog().columns.filter(
          (column) =>
            !(
              column.tableName === READINESS_FENCE_V2_OWNED_TABLE &&
              column.columnName === "base_coverage_hash"
            ),
        ),
      }),
    ).toThrow("INSTALLATION_TABLE_UNVERIFIED");
  });

  it("recusa trigger V2 divergente ou slot externo sem sobrescrever", () => {
    const [expected] = extractIdempotentTriggerStatementsForSources(
      v2Migration,
      ["sector_service_specialties"],
    ).triggers;
    if (!expected) throw new Error("fixture sem trigger V2");

    expect(() =>
      planIdempotentTriggerInstallation(
        [expected],
        [
          {
            triggerName: expected.name,
            actionTiming: expected.timing,
            eventManipulation: expected.event,
            eventObjectTable: expected.table,
            actionOrientation: "ROW",
            actionStatement: "INSERT INTO another_table VALUES (1)",
          },
        ],
      ),
    ).toThrow("não será sobrescrito");
    expect(() =>
      planIdempotentTriggerInstallation(
        [expected],
        [
          {
            triggerName: "external_v2_slot",
            actionTiming: expected.timing,
            eventManipulation: expected.event,
            eventObjectTable: expected.table,
            actionOrientation: "ROW",
            actionStatement: "SELECT 1",
          },
        ],
      ),
    ).toThrow("ocupa slot");
  });
});
