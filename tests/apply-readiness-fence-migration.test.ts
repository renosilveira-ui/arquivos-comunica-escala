import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertCompleteReadinessFenceCatalog,
  assertInstallationMarkerAbsentOrExact,
  assertReadinessFenceSourceSchema,
  calculateReadinessFenceCoverageHash,
  extractIdempotentTriggerStatements,
  extractReadinessFenceTableStatements,
  idempotentTriggerMatchesExisting,
  planIdempotentTriggerInstallation,
  READINESS_FENCE_OWNED_TABLES,
  READINESS_FENCE_SOURCE_COLUMNS,
  requireSingletonInstallationMarker,
  type ExistingColumnDefinition,
  type ExistingKeyDefinition,
  type ExistingTableDefinition,
  type ExistingTriggerDefinition,
  type ReadinessFenceCatalog,
} from "../scripts/apply-readiness-fence-migration";
import {
  READINESS_FENCE_COVERAGE_HASH,
  READINESS_FENCE_COVERAGE_VERSION,
  READINESS_FENCE_INSTALLATION_ID,
} from "../server/readiness-fence-contract";

const readinessFenceMigration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-08-31-institution-readiness-fences.sql",
    import.meta.url,
  ),
  "utf8",
);

const installerSource = readFileSync(
  new URL("../scripts/apply-readiness-fence-migration.ts", import.meta.url),
  "utf8",
);

function sourceTables(): ExistingTableDefinition[] {
  return Object.keys(READINESS_FENCE_SOURCE_COLUMNS).map((tableName) => ({
    tableName,
    tableType: "BASE TABLE",
    engine: "InnoDB",
  }));
}

function sourceColumns(): ExistingColumnDefinition[] {
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

function ownedTables(): ExistingTableDefinition[] {
  return [
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
  ];
}

function ownedColumns(): ExistingColumnDefinition[] {
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

function ownedKeys(): ExistingKeyDefinition[] {
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

function existingTriggers(): ExistingTriggerDefinition[] {
  return extractIdempotentTriggerStatements(
    readinessFenceMigration,
  ).triggers.map((trigger) => ({
    triggerName: trigger.name,
    actionTiming: trigger.timing,
    eventManipulation: trigger.event,
    eventObjectTable: trigger.table,
    actionOrientation: "ROW",
    actionStatement: trigger.actionStatement,
  }));
}

function completeCatalog(): ReadinessFenceCatalog {
  return {
    tables: [...sourceTables(), ...ownedTables()],
    columns: [...sourceColumns(), ...ownedColumns()],
    keys: ownedKeys(),
    triggers: existingTriggers(),
  };
}

describe("instalador dedicado da fence de prontidão", () => {
  it("separa tabelas aditivas dos triggers e fixa o hash do contrato", () => {
    const extracted = extractIdempotentTriggerStatements(
      readinessFenceMigration,
    );
    const tableStatements = extractReadinessFenceTableStatements(
      extracted.executableSql,
    );

    expect(tableStatements).toHaveLength(2);
    expect(tableStatements.join("\n")).toContain(
      "CREATE TABLE IF NOT EXISTS institution_readiness_fences",
    );
    expect(tableStatements.join("\n")).toContain(
      "CREATE TABLE IF NOT EXISTS institution_readiness_fence_installations",
    );
    expect(extracted.executableSql).not.toContain("CREATE TRIGGER");
    expect(extracted.triggers).toHaveLength(45);
    expect(calculateReadinessFenceCoverageHash(extracted.triggers)).toBe(
      READINESS_FENCE_COVERAGE_HASH,
    );
    expect(READINESS_FENCE_COVERAGE_HASH).toBe(
      "78897f2a765031f6fcef0d1e81c0268514f48e4531a798612eabe25124984166",
    );
    expect(READINESS_FENCE_COVERAGE_HASH).toMatch(/^[a-f0-9]{64}$/);
    expect(READINESS_FENCE_COVERAGE_HASH).not.toContain("__");
    for (const trigger of extracted.triggers) {
      expect(trigger.name.length).toBeLessThanOrEqual(64);
    }
  });

  it("recusa SQL comum que tente criar estrutura fora da propriedade da fence", () => {
    expect(() =>
      extractReadinessFenceTableStatements(
        "CREATE TABLE IF NOT EXISTS other_table (id INT);",
      ),
    ).toThrow("exatamente as tabelas próprias");
  });

  it("ignora ponto e vírgula em comentário antes de separar DDL", () => {
    expect(
      extractReadinessFenceTableStatements(`
        -- comentário administrativo; não é uma instrução
        CREATE TABLE IF NOT EXISTS institution_readiness_fences (id INT);
        -- outro comentário; ainda não é uma instrução
        CREATE TABLE IF NOT EXISTS institution_readiness_fence_installations (id INT);
      `),
    ).toHaveLength(2);
    expect(
      extractReadinessFenceTableStatements(`
        CREATE TABLE IF NOT EXISTS institution_readiness_fences (id INT) -- comentário inline; não é DDL
        ;
        CREATE TABLE IF NOT EXISTS institution_readiness_fence_installations (id INT);
      `),
    ).toHaveLength(2);
  });

  it("não contém caminho de DROP/overwrite e faz pré/pós-voo antes do marcador", () => {
    expect(installerSource).not.toMatch(/\bDROP\s+(?:TABLE|TRIGGER)\b/i);
    expect(installerSource).not.toMatch(
      /CREATE\s+OR\s+REPLACE\s+(?:TABLE|TRIGGER)/i,
    );
    expect(installerSource).not.toMatch(/multipleStatements\s*:\s*true/);
    expect(installerSource).not.toContain("localeCompare");
    expect(installerSource).toContain("INFORMATION_SCHEMA.TABLES");
    expect(installerSource).toContain("INFORMATION_SCHEMA.COLUMNS");
    expect(installerSource).toContain("INFORMATION_SCHEMA.TRIGGERS");
    expect(installerSource).toContain("GET_LOCK");
    expect(installerSource).toContain("RELEASE_LOCK");
    expect(installerSource).toContain("await createTableStatements");
    expect(installerSource).toContain("await createMissingTriggers");
    expect(installerSource).toContain("await insertInstallationMarker");
    expect(
      installerSource.indexOf("const preflight = await readCatalog"),
    ).toBeLessThan(installerSource.indexOf("await createTableStatements"));
    expect(
      installerSource.indexOf("const postflight = await readCatalog"),
    ).toBeLessThan(installerSource.indexOf("await insertInstallationMarker"));
  });

  it("rejeita marcador sem um CREATE TRIGGER de uma instrução", () => {
    expect(() =>
      extractIdempotentTriggerStatements(`
        -- @idempotent-trigger
        CREATE TRIGGER broken AFTER INSERT ON sectors
        FOR EACH ROW BEGIN SELECT 1; END;
      `),
    ).toThrow("única instrução");
  });

  it("aceita somente uma definição existente equivalente e orientada por linha", () => {
    const [expected] = extractIdempotentTriggerStatements(
      readinessFenceMigration,
    ).triggers;
    if (!expected) throw new Error("fixture sem trigger");

    expect(
      idempotentTriggerMatchesExisting(expected, {
        triggerName: expected.name,
        actionTiming: expected.timing,
        eventManipulation: expected.event,
        eventObjectTable: expected.table,
        actionOrientation: "ROW",
        actionStatement: `  ${expected.actionStatement.replace(/\s+/g, " ")}  `,
      }),
    ).toBe(true);
    expect(
      idempotentTriggerMatchesExisting(expected, {
        triggerName: expected.name,
        actionTiming: expected.timing,
        eventManipulation: expected.event,
        eventObjectTable: expected.table,
        actionOrientation: "STATEMENT",
        actionStatement: expected.actionStatement,
      }),
    ).toBe(false);
  });

  it("falha antes de DDL para nome divergente ou slot externo ocupado", () => {
    const [expected] = extractIdempotentTriggerStatements(
      readinessFenceMigration,
    ).triggers;
    if (!expected) throw new Error("fixture sem trigger");

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
            triggerName: "external_slot_trigger",
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

  it("pré-valida fonte, engine e formato das tabelas próprias", () => {
    const tables = sourceTables();
    const columns = sourceColumns();
    expect(() =>
      assertReadinessFenceSourceSchema(tables, columns),
    ).not.toThrow();
    expect(() =>
      assertReadinessFenceSourceSchema(
        tables.filter((table) => table.tableName !== "shift_instances"),
        columns,
      ),
    ).toThrow("Tabela obrigatória ausente: shift_instances");
    expect(() =>
      assertReadinessFenceSourceSchema(
        tables.map((table) =>
          table.tableName === "users" ? { ...table, engine: "MyISAM" } : table,
        ),
        columns,
      ),
    ).toThrow("BASE TABLE/InnoDB: users");

    const catalog = completeCatalog();
    expect(() =>
      assertCompleteReadinessFenceCatalog(catalog, [
        extractIdempotentTriggerStatements(readinessFenceMigration)
          .triggers[0]!,
      ]),
    ).not.toThrow();
    expect(() =>
      assertCompleteReadinessFenceCatalog(
        {
          ...catalog,
          columns: catalog.columns.filter(
            (column) =>
              !(
                column.tableName ===
                  "institution_readiness_fence_installations" &&
                column.columnName === "coverage_hash"
              ),
          ),
        },
        [],
      ),
    ).toThrow("Colunas divergentes");
  });

  it("exige catálogo integral sem trigger nas tabelas próprias", () => {
    const extracted = extractIdempotentTriggerStatements(
      readinessFenceMigration,
    );
    expect(
      assertCompleteReadinessFenceCatalog(
        completeCatalog(),
        extracted.triggers,
      ),
    ).toEqual([]);
    expect(() =>
      assertCompleteReadinessFenceCatalog(
        {
          ...completeCatalog(),
          triggers: [
            ...existingTriggers(),
            {
              triggerName: "trg_external_on_fence",
              actionTiming: "AFTER",
              eventManipulation: "INSERT",
              eventObjectTable: READINESS_FENCE_OWNED_TABLES[0],
              actionOrientation: "ROW",
              actionStatement: "SELECT 1",
            },
          ],
        },
        extracted.triggers,
      ),
    ).toThrow("não pode ter trigger");
  });

  it("aceita marcador exato e recusa qualquer deriva", () => {
    expect(() =>
      assertInstallationMarkerAbsentOrExact(undefined),
    ).not.toThrow();
    expect(() =>
      assertInstallationMarkerAbsentOrExact({
        id: READINESS_FENCE_INSTALLATION_ID,
        coverageVersion: READINESS_FENCE_COVERAGE_VERSION,
        coverageHash: READINESS_FENCE_COVERAGE_HASH,
      }),
    ).not.toThrow();
    expect(() =>
      assertInstallationMarkerAbsentOrExact({
        id: READINESS_FENCE_INSTALLATION_ID,
        coverageVersion: "other",
        coverageHash: READINESS_FENCE_COVERAGE_HASH,
      }),
    ).toThrow("MARKER_DIVERGENT");
    expect(
      requireSingletonInstallationMarker([
        {
          id: READINESS_FENCE_INSTALLATION_ID,
          coverageVersion: READINESS_FENCE_COVERAGE_VERSION,
          coverageHash: READINESS_FENCE_COVERAGE_HASH,
        },
      ]),
    ).toMatchObject({ id: READINESS_FENCE_INSTALLATION_ID });
    expect(() =>
      requireSingletonInstallationMarker([
        {
          id: READINESS_FENCE_INSTALLATION_ID,
          coverageVersion: READINESS_FENCE_COVERAGE_VERSION,
          coverageHash: READINESS_FENCE_COVERAGE_HASH,
        },
        {
          id: 2,
          coverageVersion: READINESS_FENCE_COVERAGE_VERSION,
          coverageHash: READINESS_FENCE_COVERAGE_HASH,
        },
      ]),
    ).toThrow("MARKER_DIVERGENT");
  });
});
