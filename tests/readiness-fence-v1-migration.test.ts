import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getTableConfig } from "drizzle-orm/mysql-core";
import { describe, expect, it, vi } from "vitest";
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
  readReadinessFenceV1Catalog,
  type ExistingColumnDefinition,
  type ExistingForeignKeyDefinition,
  type ExistingIndexDefinition,
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
  return {
    tables,
    columns,
    keys: [],
    indexes: [],
    foreignKeys: [],
    triggers: [],
  };
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
  const source = sourceCatalog();
  const tables: ExistingTableDefinition[] = [
    ...source.tables,
    {
      tableName: "institution_readiness_fence_events",
      tableType: "BASE TABLE",
      engine: "InnoDB",
    },
    {
      tableName: "institution_readiness_fence_installations",
      tableType: "BASE TABLE",
      engine: "InnoDB",
    },
  ];
  const columns: ExistingColumnDefinition[] = [
    ...source.columns,
    {
      tableName: "institution_readiness_fence_events",
      columnName: "id",
      columnType: "bigint unsigned",
      isNullable: "NO",
      columnDefault: null,
      extra: "auto_increment",
    },
    {
      tableName: "institution_readiness_fence_events",
      columnName: "institution_id",
      columnType: "int",
      isNullable: "NO",
      columnDefault: null,
      extra: "",
    },
    {
      tableName: "institution_readiness_fence_events",
      columnName: "created_at",
      columnType: "timestamp",
      isNullable: "NO",
      columnDefault: "CURRENT_TIMESTAMP",
      extra: "DEFAULT_GENERATED",
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
  ];
  const keys: ExistingKeyDefinition[] = [
    {
      tableName: "institution_readiness_fence_events",
      constraintName: "PRIMARY",
      columnName: "id",
      ordinalPosition: 1,
    },
    {
      tableName: "institution_readiness_fence_installations",
      constraintName: "PRIMARY",
      columnName: "id",
      ordinalPosition: 1,
    },
  ];
  const indexes: ExistingIndexDefinition[] = [
    {
      tableName: "institution_readiness_fence_events",
      indexName: "idx_rdf_event_institution_id",
      columnName: "institution_id",
      seqInIndex: 1,
      nonUnique: 1,
    },
    {
      tableName: "institution_readiness_fence_events",
      indexName: "idx_rdf_event_institution_id",
      columnName: "id",
      seqInIndex: 2,
      nonUnique: 1,
    },
  ];
  return {
    tables,
    columns,
    keys,
    indexes,
    foreignKeys: [],
    triggers: triggers.map(existingTrigger),
  };
}

const exactMarker = [
  {
    id: READINESS_FENCE_V1_INSTALLATION_ID,
    coverageVersion: READINESS_FENCE_V1_COVERAGE_VERSION,
    coverageHash: READINESS_FENCE_V1_COVERAGE_HASH,
  },
];

describe("migration da readiness fence V1", () => {
  const parsed = extractReadinessFenceV1Migration(MIGRATION_SQL);

  it("pina 40 observadores e dois guardas append-only sem specialty como autoridade", () => {
    expect(parsed.triggers).toHaveLength(42);
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
    expect(MIGRATION_SQL).not.toContain("institution_readiness_fences");
    const journalGuards = parsed.triggers.filter(
      (trigger) => trigger.table === "institution_readiness_fence_events",
    );
    expect(journalGuards.map((trigger) => trigger.name).sort()).toEqual([
      "trg_rdf_evt_bd",
      "trg_rdf_evt_bu",
    ]);
    for (const trigger of journalGuards) {
      expect(trigger.timing).toBe("BEFORE");
      expect(["UPDATE", "DELETE"]).toContain(trigger.event);
      expect(trigger.actionStatement).toContain("SIGNAL SQLSTATE '45000'");
      expect(trigger.actionStatement).toContain(
        "READINESS_FENCE_V1_EVENT_IMMUTABLE",
      );
    }
    const sourceObservers = parsed.triggers.filter(
      (trigger) => trigger.table !== "institution_readiness_fence_events",
    );
    expect(sourceObservers).toHaveLength(40);
    for (const trigger of sourceObservers) {
      expect(trigger.actionStatement).toContain(
        "institution_readiness_fence_events",
      );
      expect(trigger.actionStatement).not.toMatch(/ON\s+DUPLICATE\s+KEY/i);
    }
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

  it("aceita somente as duas tabelas explícitas do journal e recibo", () => {
    const tableStatements = extractReadinessFenceV1TableStatements(
      parsed.tableSql,
    );
    expect(tableStatements).toHaveLength(
      READINESS_FENCE_V1_OWNED_TABLES.length,
    );
    expect(tableStatements.join("\n")).not.toMatch(/FOREIGN\s+KEY/i);
    expect(tableStatements.join("\n")).not.toMatch(/ON\s+DELETE\s+CASCADE/i);
    expect(() =>
      extractReadinessFenceV1TableStatements(
        parsed.tableSql.replace(
          "CREATE TABLE institution_readiness_fence_events",
          "CREATE TABLE IF NOT EXISTS institution_readiness_fence_events",
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

  it("reconhece somente schema-push integral sem trigger nem recibo como PREPARED", () => {
    expect(
      classifyReadinessFenceV1Installation(
        completeCatalog([]),
        parsed.triggers,
        [],
      ),
    ).toBe("PREPARED");
  });

  it("aceita as formas equivalentes now() geradas pelo Drizzle para timestamps", () => {
    const compatible = completeCatalog([]);
    const drizzleSchemaPushCatalog: ReadinessFenceV1Catalog = {
      ...compatible,
      columns: compatible.columns.map((column) =>
        ["created_at", "installed_at"].includes(column.columnName)
          ? { ...column, columnDefault: "now()" }
          : column,
      ),
    };

    expect(
      classifyReadinessFenceV1Installation(
        drizzleSchemaPushCatalog,
        parsed.triggers,
        [],
      ),
    ).toBe("PREPARED");
  });

  it("falha fechada para fonte ausente ou instalação parcial", () => {
    const missingSource = sourceCatalog();
    const noSource: ReadinessFenceV1Catalog = {
      ...missingSource,
      tables: missingSource.tables.filter(
        (table) => table.tableName !== "shift_instances",
      ),
    };
    expect(() =>
      classifyReadinessFenceV1Installation(
        noSource,
        parsed.triggers,
        undefined,
      ),
    ).toThrow("READINESS_FENCE_V1_SOURCE_SCHEMA_UNVERIFIED");

    const partial = completeCatalog(parsed.triggers);
    expect(() =>
      classifyReadinessFenceV1Installation(
        { ...partial, tables: partial.tables.slice(0, -1) },
        parsed.triggers,
        undefined,
      ),
    ).toThrow("READINESS_FENCE_V1_PARTIAL_INSTALLATION");

    expect(() =>
      classifyReadinessFenceV1Installation(
        completeCatalog([parsed.triggers[0]!]),
        parsed.triggers,
        [],
      ),
    ).toThrow("READINESS_FENCE_V1_PARTIAL_INSTALLATION");

    expect(() =>
      classifyReadinessFenceV1Installation(
        completeCatalog([]),
        parsed.triggers,
        exactMarker,
      ),
    ).toThrow("READINESS_FENCE_V1_PARTIAL_INSTALLATION");
  });

  it("recusa journal preparado sem índice, com coluna divergente ou FK", () => {
    const compatible = completeCatalog([]);
    expect(() =>
      classifyReadinessFenceV1Installation(
        { ...compatible, indexes: [] },
        parsed.triggers,
        [],
      ),
    ).toThrow("READINESS_FENCE_V1_OWNED_SCHEMA_DIVERGENT");
    expect(() =>
      classifyReadinessFenceV1Installation(
        {
          ...compatible,
          columns: compatible.columns.map((column) =>
            column.tableName === "institution_readiness_fence_events" &&
            column.columnName === "id"
              ? { ...column, extra: "" }
              : column,
          ),
        },
        parsed.triggers,
        [],
      ),
    ).toThrow("READINESS_FENCE_V1_OWNED_SCHEMA_DIVERGENT");
    const foreignKeys: ExistingForeignKeyDefinition[] = [
      {
        constraintSchema: "escalas",
        tableName: "institution_readiness_fence_events",
        constraintName: "fk_rdf_event_institution",
        columnName: "institution_id",
        referencedTableSchema: "outro_schema",
        referencedTableName: "institutions",
        referencedColumnName: "id",
        deleteRule: "CASCADE",
        updateRule: "RESTRICT",
      },
    ];
    expect(() =>
      classifyReadinessFenceV1Installation(
        { ...compatible, foreignKeys },
        parsed.triggers,
        [],
      ),
    ).toThrow("READINESS_FENCE_V1_OWNED_SCHEMA_DIVERGENT");
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

  it("recusa trigger conhecido divergente e trigger externo no journal", () => {
    const expected = parsed.triggers[0]!;
    expect(() =>
      missingOrIncompatibleReadinessFenceV1Triggers(parsed.triggers, [
        {
          triggerName: expected.name,
          actionTiming: expected.timing,
          eventManipulation: expected.event,
          eventObjectTable: "tabela_externa",
          actionOrientation: "ROW",
          actionStatement: "SET @unexpected = 1",
        },
      ]),
    ).toThrow("READINESS_FENCE_V1_TRIGGER_CATALOG_DIVERGENT");

    const catalog = completeCatalog(parsed.triggers);
    expect(() =>
      classifyReadinessFenceV1Installation(
        {
          ...catalog,
          triggers: [
            ...catalog.triggers,
            {
              triggerName: "trg_rdf_externo",
              actionTiming: "AFTER",
              eventManipulation: "UPDATE",
              eventObjectTable: "institution_readiness_fence_events",
              actionOrientation: "ROW",
              actionStatement: "SET @unexpected = 1",
            },
          ],
        },
        parsed.triggers,
        exactMarker,
      ),
    ).toThrow("READINESS_FENCE_V1_OWNED_TRIGGER_UNSUPPORTED");
  });

  it("consulta índice e foreign keys somente nas tabelas próprias", async () => {
    const query = vi.fn().mockResolvedValue([[], []]);
    await readReadinessFenceV1Catalog({ query } as never, parsed.triggers);

    const [, indexParams] = query.mock.calls[3]!;
    expect(query.mock.calls[3]![0]).toContain("INFORMATION_SCHEMA.STATISTICS");
    expect(indexParams).toEqual([READINESS_FENCE_V1_OWNED_TABLES]);

    const [, foreignKeyParams] = query.mock.calls[4]!;
    expect(query.mock.calls[4]![0]).not.toContain("CONSTRAINT_NAME = ?");
    expect(foreignKeyParams).toEqual([READINESS_FENCE_V1_OWNED_TABLES]);

    const [, triggerParams] = query.mock.calls[5]!;
    expect(query.mock.calls[5]![0]).toContain("TRIGGER_NAME IN (?)");
    expect(triggerParams).toEqual([
      expect.any(Array),
      parsed.triggers.map((trigger) => trigger.name),
    ]);
  });

  it("só reconhece complete com marcador singleton exato e todos triggers", () => {
    const catalog = completeCatalog(parsed.triggers);
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
