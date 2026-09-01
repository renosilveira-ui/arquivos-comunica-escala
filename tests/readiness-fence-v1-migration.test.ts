import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getTableConfig } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";
import {
  hospitals,
  institutions,
  managerScope,
  monthlyRosters,
  professionalAccess,
  professionalInstitutions,
  professionals,
  pushTokens,
  scheduleContexts,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  shiftTemplates,
  users,
} from "../drizzle/schema";
import {
  READINESS_FENCE_V1_COVERAGE_HASH,
  READINESS_FENCE_V1_COVERAGE_VERSION,
  READINESS_FENCE_V1_INSTALLATION_ID,
} from "../server/readiness-fence-v1-contract";
import {
  READINESS_FENCE_V1_OWNED_TABLES,
  READINESS_FENCE_V1_SOURCE_COLUMNS,
  calculateReadinessFenceV1CoverageHash,
  classifyReadinessFenceV1Installation,
  extractReadinessFenceV1Migration,
  extractReadinessFenceV1TableStatements,
  missingOrIncompatibleReadinessFenceV1Triggers,
  type ExistingColumnDefinition,
  type ExistingForeignKeyDefinition,
  type ExistingKeyDefinition,
  type ExistingTableDefinition,
  type ExistingTriggerDefinition,
  type IdempotentTriggerDefinition,
  type ReadinessFenceV1Catalog,
} from "../scripts/apply-readiness-fence-v1-migration";

const MIGRATION_SQL = readFileSync(
  fileURLToPath(
    new URL(
      "../drizzle/migrations/manual/2026-09-01-readiness-fence-v1-clean.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

const sourceTables = {
  institutions,
  hospitals,
  sectors,
  schedule_contexts: scheduleContexts,
  shift_templates: shiftTemplates,
  shift_instances: shiftInstances,
  shift_assignments_v2: shiftAssignmentsV2,
  professional_institutions: professionalInstitutions,
  professional_access: professionalAccess,
  manager_scope: managerScope,
  monthly_rosters: monthlyRosters,
  users,
  professionals,
  push_tokens: pushTokens,
} as const;

function sourceCatalog(): ReadinessFenceV1Catalog {
  const tables: ExistingTableDefinition[] = Object.keys(
    READINESS_FENCE_V1_SOURCE_COLUMNS,
  ).map((tableName) => ({
    tableName,
    tableType: "BASE TABLE",
    engine: "InnoDB",
  }));
  const columns: ExistingColumnDefinition[] = Object.entries(
    READINESS_FENCE_V1_SOURCE_COLUMNS,
  ).flatMap(([tableName, requiredColumns]) =>
    requiredColumns.map((columnName) => ({
      tableName,
      columnName,
      columnType: "int",
      isNullable: "NO",
      columnDefault: null,
      extra: "",
    })),
  );
  return { tables, columns, keys: [], foreignKeys: [], triggers: [] };
}

function existingTrigger(
  trigger: IdempotentTriggerDefinition,
): ExistingTriggerDefinition {
  return {
    triggerName: trigger.name,
    actionTiming: trigger.timing,
    eventManipulation: trigger.event,
    eventObjectTable: trigger.table,
    actionOrientation: "ROW",
    actionStatement: trigger.actionStatement,
  };
}

function completeCatalog(
  triggers: readonly IdempotentTriggerDefinition[],
): ReadinessFenceV1Catalog {
  const catalog = sourceCatalog();
  catalog.tables.push(
    {
      tableName: "institution_readiness_fences",
      tableType: "BASE TABLE",
      engine: "InnoDB",
    },
    {
      tableName: "institution_readiness_fence_installations",
      tableType: "BASE TABLE",
      engine: "InnoDB",
    },
  );
  catalog.columns.push(
    {
      tableName: "institution_readiness_fences",
      columnName: "institution_id",
      columnType: "int",
      isNullable: "NO",
      columnDefault: null,
      extra: "",
    },
    {
      tableName: "institution_readiness_fences",
      columnName: "revision",
      columnType: "bigint unsigned",
      isNullable: "NO",
      columnDefault: "0",
      extra: "",
    },
    {
      tableName: "institution_readiness_fences",
      columnName: "created_at",
      columnType: "timestamp",
      isNullable: "NO",
      columnDefault: "CURRENT_TIMESTAMP",
      extra: "DEFAULT_GENERATED",
    },
    {
      tableName: "institution_readiness_fences",
      columnName: "updated_at",
      columnType: "timestamp",
      isNullable: "NO",
      columnDefault: "CURRENT_TIMESTAMP",
      extra: "DEFAULT_GENERATED on update CURRENT_TIMESTAMP",
    },
    {
      tableName: "institution_readiness_fence_installations",
      columnName: "id",
      columnType: "tinyint unsigned",
      isNullable: "NO",
      columnDefault: null,
      extra: "",
    },
    {
      tableName: "institution_readiness_fence_installations",
      columnName: "coverage_version",
      columnType: "varchar(64)",
      isNullable: "NO",
      columnDefault: null,
      extra: "",
    },
    {
      tableName: "institution_readiness_fence_installations",
      columnName: "coverage_hash",
      columnType: "char(64)",
      isNullable: "NO",
      columnDefault: null,
      extra: "",
    },
    {
      tableName: "institution_readiness_fence_installations",
      columnName: "installed_at",
      columnType: "timestamp",
      isNullable: "NO",
      columnDefault: "CURRENT_TIMESTAMP",
      extra: "DEFAULT_GENERATED",
    },
  );
  const keys: ExistingKeyDefinition[] = [
    {
      tableName: "institution_readiness_fences",
      constraintName: "PRIMARY",
      columnName: "institution_id",
      ordinalPosition: 1,
    },
    {
      tableName: "institution_readiness_fence_installations",
      constraintName: "PRIMARY",
      columnName: "id",
      ordinalPosition: 1,
    },
  ];
  const foreignKeys: ExistingForeignKeyDefinition[] = [
    {
      tableName: "institution_readiness_fences",
      constraintName: "fk_rdf_institution",
      referencedTableName: "institutions",
      deleteRule: "CASCADE",
      updateRule: "RESTRICT",
    },
  ];
  return {
    ...catalog,
    keys,
    foreignKeys,
    triggers: triggers.map(existingTrigger),
  };
}

describe("migration da readiness fence V1", () => {
  const parsed = extractReadinessFenceV1Migration(MIGRATION_SQL);

  it("pina a cobertura canônica de 40 triggers sem specialty como autoridade", () => {
    expect(parsed.triggers).toHaveLength(40);
    expect(new Set(parsed.triggers.map((trigger) => trigger.name)).size).toBe(
      parsed.triggers.length,
    );
    expect(calculateReadinessFenceV1CoverageHash(parsed.triggers)).toBe(
      READINESS_FENCE_V1_COVERAGE_HASH,
    );
    expect(Object.keys(READINESS_FENCE_V1_SOURCE_COLUMNS)).not.toEqual(
      expect.arrayContaining([
        "medical_specialties",
        "sector_service_specialties",
        "schedule_context_allowed_qualifications",
      ]),
    );
    expect(MIGRATION_SQL).not.toContain("specialty <=>");
  });

  it("só declara fontes e colunas existentes no schema canônico", () => {
    for (const [tableName, requiredColumns] of Object.entries(
      READINESS_FENCE_V1_SOURCE_COLUMNS,
    )) {
      const table = sourceTables[tableName as keyof typeof sourceTables];
      expect(table, tableName).toBeDefined();
      expect(getTableConfig(table).name).toBe(tableName);
      const actualColumns = new Set(
        getTableConfig(table).columns.map((column) => column.name),
      );
      for (const requiredColumn of requiredColumns) {
        expect(actualColumns, `${tableName}.${requiredColumn}`).toContain(
          requiredColumn,
        );
      }
    }
  });

  it("aceita somente os dois CREATE TABLE explícitos da própria fence", () => {
    expect(
      extractReadinessFenceV1TableStatements(parsed.tableSql),
    ).toHaveLength(READINESS_FENCE_V1_OWNED_TABLES.length);
    expect(() =>
      extractReadinessFenceV1TableStatements(
        parsed.tableSql.replace(
          "CREATE TABLE institution_readiness_fences",
          "CREATE TABLE IF NOT EXISTS institution_readiness_fences",
        ),
      ),
    ).toThrow("READINESS_FENCE_V1_TABLE_DDL_INVALID");
  });

  it("considera banco sem estruturas próprias como fresh, nunca complete", () => {
    expect(
      classifyReadinessFenceV1Installation(
        sourceCatalog(),
        parsed.triggers,
        undefined,
      ),
    ).toBe("FRESH");
  });

  it("falha fechada para fonte ausente ou instalação parcial", () => {
    const noSource = sourceCatalog();
    noSource.tables = noSource.tables.filter(
      (table) => table.tableName !== "shift_instances",
    );
    expect(() =>
      classifyReadinessFenceV1Installation(
        noSource,
        parsed.triggers,
        undefined,
      ),
    ).toThrow("READINESS_FENCE_V1_SOURCE_SCHEMA_UNVERIFIED");

    const partial = completeCatalog(parsed.triggers);
    partial.tables.pop();
    expect(() =>
      classifyReadinessFenceV1Installation(partial, parsed.triggers, undefined),
    ).toThrow("READINESS_FENCE_V1_PARTIAL_INSTALLATION");
  });

  it("não ocupa nem sobrescreve um trigger externo no mesmo slot", () => {
    const expected = parsed.triggers[0]!;
    expect(() =>
      missingOrIncompatibleReadinessFenceV1Triggers(parsed.triggers, [
        {
          triggerName: "trg_externo",
          actionTiming: expected.timing,
          eventManipulation: expected.event,
          eventObjectTable: expected.table,
          actionOrientation: "ROW",
          actionStatement: "INSERT INTO outra_tabela VALUES (1)",
        },
      ]),
    ).toThrow("READINESS_FENCE_V1_TRIGGER_SLOT_OCCUPIED");
  });

  it("recusa trigger externo nas próprias tabelas da fence", () => {
    const catalog = completeCatalog(parsed.triggers);
    catalog.triggers.push({
      triggerName: "trg_rdf_externo",
      actionTiming: "AFTER",
      eventManipulation: "UPDATE",
      eventObjectTable: "institution_readiness_fences",
      actionOrientation: "ROW",
      actionStatement: "SET @unexpected = 1",
    });

    expect(() =>
      classifyReadinessFenceV1Installation(catalog, parsed.triggers, [
        {
          id: READINESS_FENCE_V1_INSTALLATION_ID,
          coverageVersion: READINESS_FENCE_V1_COVERAGE_VERSION,
          coverageHash: READINESS_FENCE_V1_COVERAGE_HASH,
        },
      ]),
    ).toThrow("READINESS_FENCE_V1_OWNED_TRIGGER_UNSUPPORTED");
  });

  it("só reconhece complete com marcador singleton exato e todos triggers", () => {
    const catalog = completeCatalog(parsed.triggers);
    const exactMarker = [
      {
        id: READINESS_FENCE_V1_INSTALLATION_ID,
        coverageVersion: READINESS_FENCE_V1_COVERAGE_VERSION,
        coverageHash: READINESS_FENCE_V1_COVERAGE_HASH,
      },
    ];
    expect(
      classifyReadinessFenceV1Installation(
        catalog,
        parsed.triggers,
        exactMarker,
      ),
    ).toBe("COMPLETE");
    expect(() =>
      classifyReadinessFenceV1Installation(catalog, parsed.triggers, []),
    ).toThrow("READINESS_FENCE_V1_INSTALLATION_MARKER_UNVERIFIED");
  });
});
