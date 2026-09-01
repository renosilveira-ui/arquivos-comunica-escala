/**
 * Instalador aditivo da extensão V2 da fence de prontidão.
 *
 * Exige V1 comprovadamente íntegra, cria somente a tabela/observadores V2
 * ausentes e grava recibo próprio. Nunca altera marker, trigger ou tabela V1.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import mysql from "mysql2/promise";
import type { Connection } from "mysql2/promise";
import {
  acquireReadinessFenceInstallationLock,
  assertCompleteReadinessFenceCatalog,
  buildReadinessFenceConnectionOptions,
  calculateReadinessFenceCoverageHash,
  calculateReadinessFenceCoverageHashForDefinition,
  createMissingReadinessFenceTriggers,
  extractIdempotentTriggerStatements,
  extractIdempotentTriggerStatementsForSources,
  planIdempotentTriggerInstallation,
  readReadinessFenceCatalog,
  readReadinessFenceInstallationMarkers,
  releaseReadinessFenceInstallationLock,
  requireSingletonInstallationMarker,
  type ExistingColumnDefinition,
  type ExistingInstallationMarker,
  type ExistingKeyDefinition,
  type ExistingTableDefinition,
  type IdempotentTriggerDefinition,
  type ReadinessFenceCatalog,
  type ReadinessFenceSourceColumns,
} from "./apply-readiness-fence-migration";
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

const READINESS_FENCE_V1_MIGRATION_URL = new URL(
  "../drizzle/migrations/manual/2026-08-31-institution-readiness-fences.sql",
  import.meta.url,
);
const READINESS_FENCE_V2_MIGRATION_URL = new URL(
  "../drizzle/migrations/manual/2026-09-01-institution-readiness-fence-v2-sector-service-specialties.sql",
  import.meta.url,
);

export const READINESS_FENCE_V2_OWNED_TABLE =
  "institution_readiness_fence_extension_installations";

export const READINESS_FENCE_V2_SOURCE_COLUMNS = {
  sector_service_specialties: [
    "id",
    "institution_id",
    "hospital_id",
    "sector_id",
    "medical_specialty_id",
  ],
} as const satisfies ReadinessFenceSourceColumns;

const READINESS_FENCE_V2_CATALOG_TABLES = [
  ...Object.keys(READINESS_FENCE_V2_SOURCE_COLUMNS),
  READINESS_FENCE_V2_OWNED_TABLE,
] as const;

const V2_TRIGGER_EXPECTATIONS = [
  {
    name: "trg_readiness_fence_sector_service_specialties_ai",
    event: "INSERT",
  },
  {
    name: "trg_readiness_fence_sector_service_specialties_au",
    event: "UPDATE",
  },
  {
    name: "trg_readiness_fence_sector_service_specialties_ad",
    event: "DELETE",
  },
] as const;

type ReadinessFenceV2ExtensionInstallation = Readonly<{
  extensionKey: string;
  coverageVersion: string;
  coverageHash: string;
  baseInstallationId: number | string;
  baseCoverageVersion: string;
  baseCoverageHash: string;
}>;

type ColumnRequirement = Readonly<{
  name: string;
  type: RegExp;
  nullable: "YES" | "NO";
  primary?: boolean;
}>;

const V2_OWNED_TABLE_COLUMNS: readonly ColumnRequirement[] = [
  {
    name: "extension_key",
    type: /^varchar\(64\)$/i,
    nullable: "NO",
    primary: true,
  },
  { name: "coverage_version", type: /^varchar\(64\)$/i, nullable: "NO" },
  { name: "coverage_hash", type: /^char\(64\)$/i, nullable: "NO" },
  {
    name: "base_installation_id",
    type: /^tinyint(?:\(\d+\))? unsigned$/i,
    nullable: "NO",
  },
  {
    name: "base_coverage_version",
    type: /^varchar\(64\)$/i,
    nullable: "NO",
  },
  {
    name: "base_coverage_hash",
    type: /^char\(64\)$/i,
    nullable: "NO",
  },
  { name: "installed_at", type: /^timestamp$/i, nullable: "NO" },
];

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}
function isExactV1Marker(marker: ExistingInstallationMarker): boolean {
  return (
    Number(marker.id) === READINESS_FENCE_INSTALLATION_ID &&
    marker.coverageVersion === READINESS_FENCE_COVERAGE_VERSION &&
    marker.coverageHash === READINESS_FENCE_COVERAGE_HASH
  );
}

function assertExactV1Marker(
  markers: readonly ExistingInstallationMarker[],
): void {
  const marker = requireSingletonInstallationMarker(markers);
  if (!marker || !isExactV1Marker(marker)) {
    throw new Error("READINESS_FENCE_V1_INSTALLATION_UNVERIFIED");
  }
}

function isExactV2ExtensionInstallation(
  installation: ReadinessFenceV2ExtensionInstallation,
): boolean {
  return (
    installation.extensionKey === READINESS_FENCE_V2_EXTENSION_KEY &&
    installation.coverageVersion === READINESS_FENCE_V2_COVERAGE_VERSION &&
    installation.coverageHash === READINESS_FENCE_V2_COVERAGE_HASH &&
    Number(installation.baseInstallationId) ===
      READINESS_FENCE_V2_PREDECESSOR.installationId &&
    installation.baseCoverageVersion ===
      READINESS_FENCE_V2_PREDECESSOR.coverageVersion &&
    installation.baseCoverageHash ===
      READINESS_FENCE_V2_PREDECESSOR.coverageHash
  );
}

export type ReadinessFenceV2ExtensionState =
  "V2_EXTENSION_ABSENT" | "V2_EXTENSION_EXACT";

export function classifyReadinessFenceV2ExtensionInstallation(
  installations: readonly ReadinessFenceV2ExtensionInstallation[],
): ReadinessFenceV2ExtensionState {
  if (installations.length === 0) return "V2_EXTENSION_ABSENT";
  if (
    installations.length !== 1 ||
    !isExactV2ExtensionInstallation(installations[0]!)
  ) {
    throw new Error("READINESS_FENCE_V2_EXTENSION_INSTALLATION_DIVERGENT");
  }
  return "V2_EXTENSION_EXACT";
}

function assertV1CoverageHash(
  v1Triggers: readonly IdempotentTriggerDefinition[],
): void {
  if (
    calculateReadinessFenceCoverageHash(v1Triggers) !==
    READINESS_FENCE_COVERAGE_HASH
  ) {
    throw new Error("READINESS_FENCE_V1_COVERAGE_HASH_DIVERGENT");
  }
}

export function calculateReadinessFenceV2CoverageHash(
  v2Triggers: readonly IdempotentTriggerDefinition[],
): string {
  return calculateReadinessFenceCoverageHashForDefinition(
    READINESS_FENCE_V2_COVERAGE_VERSION,
    READINESS_FENCE_V2_SOURCE_COLUMNS,
    v2Triggers,
    READINESS_FENCE_V2_PREDECESSOR,
  );
}

function assertV2CoverageHash(
  v2Triggers: readonly IdempotentTriggerDefinition[],
): void {
  if (
    calculateReadinessFenceV2CoverageHash(v2Triggers) !==
    READINESS_FENCE_V2_COVERAGE_HASH
  ) {
    throw new Error("READINESS_FENCE_V2_COVERAGE_HASH_DIVERGENT");
  }
}

export function extractReadinessFenceV2TableStatements(sql: string): string[] {
  const statements = sql
    .replace(/--[^\r\n]*/g, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  if (statements.length !== 1) {
    throw new Error("READINESS_FENCE_V2_SQL_COMMON_DIVERGENT");
  }
  const [statement] = statements;
  const match =
    /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+`?([A-Za-z0-9_]+)`?\s*\(/i.exec(
      statement!,
    );
  if (
    !match ||
    normalizeIdentifier(match[1]!) !== READINESS_FENCE_V2_OWNED_TABLE
  ) {
    throw new Error("READINESS_FENCE_V2_SQL_COMMON_DIVERGENT");
  }
  return statements;
}

function assertV2MigrationShape(
  triggers: readonly IdempotentTriggerDefinition[],
): void {
  if (triggers.length !== V2_TRIGGER_EXPECTATIONS.length) {
    throw new Error("READINESS_FENCE_V2_TRIGGER_COVERAGE_DIVERGENT");
  }
  for (const expectation of V2_TRIGGER_EXPECTATIONS) {
    const trigger = triggers.find(
      (candidate) => candidate.name === expectation.name,
    );
    if (
      !trigger ||
      trigger.timing !== "AFTER" ||
      trigger.event !== expectation.event ||
      trigger.table !== "sector_service_specialties"
    ) {
      throw new Error("READINESS_FENCE_V2_TRIGGER_COVERAGE_DIVERGENT");
    }
  }
}

function columnsForTable(
  columns: readonly ExistingColumnDefinition[],
  tableName: string,
): Map<string, ExistingColumnDefinition> {
  return new Map(
    columns
      .filter((column) => normalizeIdentifier(column.tableName) === tableName)
      .map((column) => [normalizeIdentifier(column.columnName), column]),
  );
}

function assertBaseInnoDbTable(
  table: ExistingTableDefinition | undefined,
  code: string,
): asserts table is ExistingTableDefinition {
  if (
    !table ||
    table.tableType.toUpperCase() !== "BASE TABLE" ||
    table.engine?.toUpperCase() !== "INNODB"
  ) {
    throw new Error(code);
  }
}

function assertConstraint(
  keys: readonly ExistingKeyDefinition[],
  tableName: string,
  constraintName: string,
  expectedColumns: readonly string[],
  expectedReferences: readonly Readonly<{
    table: string | null;
    column: string | null;
  }>[],
  code: string,
): void {
  const actual = keys
    .filter(
      (key) =>
        normalizeIdentifier(key.tableName) === tableName &&
        normalizeIdentifier(key.constraintName) === constraintName,
    )
    .sort((left, right) => left.ordinalPosition - right.ordinalPosition);
  if (
    actual.length !== expectedColumns.length ||
    expectedReferences.length !== expectedColumns.length
  ) {
    throw new Error(code);
  }
  for (const [index, expectedColumn] of expectedColumns.entries()) {
    const observed = actual[index];
    const expectedReference = expectedReferences[index];
    if (
      !observed ||
      normalizeIdentifier(observed.columnName) !== expectedColumn ||
      normalizeIdentifier(observed.referencedTableName ?? "") !==
        normalizeIdentifier(expectedReference?.table ?? "") ||
      normalizeIdentifier(observed.referencedColumnName ?? "") !==
        normalizeIdentifier(expectedReference?.column ?? "")
    ) {
      throw new Error(code);
    }
  }
}

/**
 * A V2 só aceita relação N:N topologicamente canônica. A atividade do
 * catálogo global não é inspecionada: a presença do vínculo é o metadado V2.
 */
export function assertReadinessFenceV2SourceSchema(
  catalog: ReadinessFenceCatalog,
): void {
  const source = catalog.tables.find(
    (table) =>
      normalizeIdentifier(table.tableName) === "sector_service_specialties",
  );
  assertBaseInnoDbTable(source, "READINESS_FENCE_V2_SOURCE_TABLE_UNVERIFIED");
  const columns = columnsForTable(
    catalog.columns,
    "sector_service_specialties",
  );
  for (const columnName of READINESS_FENCE_V2_SOURCE_COLUMNS.sector_service_specialties) {
    const column = columns.get(columnName);
    if (!column || column.isNullable.toUpperCase() !== "NO") {
      throw new Error(
        `READINESS_FENCE_V2_SOURCE_COLUMN_UNVERIFIED:${columnName}`,
      );
    }
  }
  assertConstraint(
    catalog.keys,
    "sector_service_specialties",
    "fk_sector_service_specialty_institution",
    ["institution_id"],
    [{ table: "institutions", column: "id" }],
    "READINESS_FENCE_V2_SOURCE_CONSTRAINT_UNVERIFIED:institution",
  );
  assertConstraint(
    catalog.keys,
    "sector_service_specialties",
    "fk_sector_service_specialty_hospital",
    ["hospital_id"],
    [{ table: "hospitals", column: "id" }],
    "READINESS_FENCE_V2_SOURCE_CONSTRAINT_UNVERIFIED:hospital",
  );
  assertConstraint(
    catalog.keys,
    "sector_service_specialties",
    "fk_sector_service_specialty_sector",
    ["sector_id"],
    [{ table: "sectors", column: "id" }],
    "READINESS_FENCE_V2_SOURCE_CONSTRAINT_UNVERIFIED:sector",
  );
  assertConstraint(
    catalog.keys,
    "sector_service_specialties",
    "fk_sector_service_specialty_medical_specialty",
    ["medical_specialty_id"],
    [{ table: "medical_specialties", column: "id" }],
    "READINESS_FENCE_V2_SOURCE_CONSTRAINT_UNVERIFIED:medical_specialty",
  );
  assertConstraint(
    catalog.keys,
    "sector_service_specialties",
    "primary",
    ["id"],
    [{ table: null, column: null }],
    "READINESS_FENCE_V2_SOURCE_CONSTRAINT_UNVERIFIED:primary",
  );
  assertConstraint(
    catalog.keys,
    "sector_service_specialties",
    "uniq_sector_service_specialty",
    ["institution_id", "hospital_id", "sector_id", "medical_specialty_id"],
    [
      { table: null, column: null },
      { table: null, column: null },
      { table: null, column: null },
      { table: null, column: null },
    ],
    "READINESS_FENCE_V2_SOURCE_CONSTRAINT_UNVERIFIED:unique",
  );
  assertConstraint(
    catalog.keys,
    "sector_service_specialties",
    "fk_sector_service_specialty_topology",
    ["institution_id", "hospital_id", "sector_id"],
    [
      { table: "sectors", column: "institution_id" },
      { table: "sectors", column: "hospital_id" },
      { table: "sectors", column: "id" },
    ],
    "READINESS_FENCE_V2_SOURCE_CONSTRAINT_UNVERIFIED:topology",
  );
}

/** Valida tabela V2 já existente antes de qualquer DDL; ausência é recuperável. */
export function assertExistingReadinessFenceV2InstallationTable(
  catalog: ReadinessFenceCatalog,
): void {
  const table = catalog.tables.find(
    (candidate) =>
      normalizeIdentifier(candidate.tableName) ===
      READINESS_FENCE_V2_OWNED_TABLE,
  );
  if (!table) return;
  assertBaseInnoDbTable(
    table,
    "READINESS_FENCE_V2_INSTALLATION_TABLE_UNVERIFIED",
  );
  const columns = columnsForTable(
    catalog.columns,
    READINESS_FENCE_V2_OWNED_TABLE,
  );
  if (columns.size !== V2_OWNED_TABLE_COLUMNS.length) {
    throw new Error("READINESS_FENCE_V2_INSTALLATION_TABLE_UNVERIFIED");
  }
  for (const requirement of V2_OWNED_TABLE_COLUMNS) {
    const column = columns.get(requirement.name);
    if (
      !column ||
      !requirement.type.test(column.columnType) ||
      column.isNullable.toUpperCase() !== requirement.nullable
    ) {
      throw new Error("READINESS_FENCE_V2_INSTALLATION_TABLE_UNVERIFIED");
    }
  }
  assertConstraint(
    catalog.keys,
    READINESS_FENCE_V2_OWNED_TABLE,
    "primary",
    ["extension_key"],
    [{ table: null, column: null }],
    "READINESS_FENCE_V2_INSTALLATION_TABLE_UNVERIFIED",
  );
  assertConstraint(
    catalog.keys,
    READINESS_FENCE_V2_OWNED_TABLE,
    "fk_readiness_fence_extension_base_installation",
    ["base_installation_id"],
    [{ table: "institution_readiness_fence_installations", column: "id" }],
    "READINESS_FENCE_V2_INSTALLATION_TABLE_UNVERIFIED",
  );
  if (
    catalog.triggers.some(
      (trigger) =>
        normalizeIdentifier(trigger.eventObjectTable) ===
        READINESS_FENCE_V2_OWNED_TABLE,
    )
  ) {
    throw new Error("READINESS_FENCE_V2_INSTALLATION_TABLE_UNVERIFIED");
  }
}

function assertReadinessFenceV2InstallationTablePresent(
  catalog: ReadinessFenceCatalog,
): void {
  if (
    !catalog.tables.some(
      (table) =>
        normalizeIdentifier(table.tableName) === READINESS_FENCE_V2_OWNED_TABLE,
    )
  ) {
    throw new Error("READINESS_FENCE_V2_INSTALLATION_TABLE_MISSING");
  }
  assertExistingReadinessFenceV2InstallationTable(catalog);
}

function assertV1CatalogIntegrity(
  catalog: ReadinessFenceCatalog,
  v1Triggers: readonly IdempotentTriggerDefinition[],
): void {
  const missingV1Triggers = assertCompleteReadinessFenceCatalog(
    catalog,
    v1Triggers,
  );
  if (missingV1Triggers.length > 0) {
    throw new Error("READINESS_FENCE_V1_TRIGGERS_INCOMPLETE");
  }
}

async function createV2TableStatements(
  connection: Connection,
  statements: readonly string[],
): Promise<void> {
  for (const statement of statements) {
    await connection.query(statement);
  }
}

async function readReadinessFenceV2ExtensionInstallations(
  connection: Connection,
): Promise<ReadinessFenceV2ExtensionInstallation[]> {
  const [rows] = await connection.query(
    `SELECT extension_key AS extensionKey,
            coverage_version AS coverageVersion,
            coverage_hash AS coverageHash,
            base_installation_id AS baseInstallationId,
            base_coverage_version AS baseCoverageVersion,
            base_coverage_hash AS baseCoverageHash
     FROM institution_readiness_fence_extension_installations
     WHERE extension_key = ?`,
    [READINESS_FENCE_V2_EXTENSION_KEY],
  );
  return Array.isArray(rows)
    ? (rows as ReadinessFenceV2ExtensionInstallation[])
    : [];
}

async function insertReadinessFenceV2ExtensionInstallation(
  connection: Connection,
): Promise<void> {
  await connection.beginTransaction();
  try {
    await connection.query(
      `INSERT INTO institution_readiness_fence_extension_installations
        (extension_key, coverage_version, coverage_hash,
         base_installation_id, base_coverage_version, base_coverage_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        READINESS_FENCE_V2_EXTENSION_KEY,
        READINESS_FENCE_V2_COVERAGE_VERSION,
        READINESS_FENCE_V2_COVERAGE_HASH,
        READINESS_FENCE_V2_PREDECESSOR.installationId,
        READINESS_FENCE_V2_PREDECESSOR.coverageVersion,
        READINESS_FENCE_V2_PREDECESSOR.coverageHash,
      ],
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

/**
 * Só execute depois de V1 autorizada para o mesmo ambiente. CREATE TABLE e
 * CREATE TRIGGER fazem commit implícito no MySQL; por isso DDL parcial sem
 * recibo é recuperável, mas um recibo já presente sem cobertura é drift.
 */
export async function applyReadinessFenceV2Migration(): Promise<void> {
  const v1Sql = readFileSync(
    fileURLToPath(READINESS_FENCE_V1_MIGRATION_URL),
    "utf8",
  );
  const v1Extracted = extractIdempotentTriggerStatements(v1Sql);
  const v2Sql = readFileSync(
    fileURLToPath(READINESS_FENCE_V2_MIGRATION_URL),
    "utf8",
  );
  const v2Extracted = extractIdempotentTriggerStatementsForSources(
    v2Sql,
    Object.keys(READINESS_FENCE_V2_SOURCE_COLUMNS),
  );
  const tableStatements = extractReadinessFenceV2TableStatements(
    v2Extracted.executableSql,
  );
  assertV1CoverageHash(v1Extracted.triggers);
  assertV2MigrationShape(v2Extracted.triggers);
  assertV2CoverageHash(v2Extracted.triggers);

  const connection = await mysql.createConnection(
    buildReadinessFenceConnectionOptions(),
  );
  let lockAcquired = false;
  try {
    await acquireReadinessFenceInstallationLock(connection);
    lockAcquired = true;

    const preflight = await readReadinessFenceCatalog(
      connection,
      READINESS_FENCE_V2_CATALOG_TABLES,
    );
    assertV1CatalogIntegrity(preflight, v1Extracted.triggers);
    assertExactV1Marker(
      await readReadinessFenceInstallationMarkers(connection),
    );
    assertReadinessFenceV2SourceSchema(preflight);
    assertExistingReadinessFenceV2InstallationTable(preflight);
    const missingV2Triggers = planIdempotentTriggerInstallation(
      v2Extracted.triggers,
      preflight.triggers,
    );
    const preflightExtensionState = preflight.tables.some(
      (table) =>
        normalizeIdentifier(table.tableName) === READINESS_FENCE_V2_OWNED_TABLE,
    )
      ? classifyReadinessFenceV2ExtensionInstallation(
          await readReadinessFenceV2ExtensionInstallations(connection),
        )
      : "V2_EXTENSION_ABSENT";

    if (preflightExtensionState === "V2_EXTENSION_EXACT") {
      if (missingV2Triggers.length > 0) {
        throw new Error("READINESS_FENCE_V2_EXTENSION_INSTALLATION_DRIFT");
      }
      console.log("Extensão V2 da fence de prontidão já está íntegra");
      return;
    }

    await createV2TableStatements(connection, tableStatements);
    await createMissingReadinessFenceTriggers(connection, missingV2Triggers);

    const postflight = await readReadinessFenceCatalog(
      connection,
      READINESS_FENCE_V2_CATALOG_TABLES,
    );
    assertV1CatalogIntegrity(postflight, v1Extracted.triggers);
    assertExactV1Marker(
      await readReadinessFenceInstallationMarkers(connection),
    );
    assertReadinessFenceV2SourceSchema(postflight);
    assertReadinessFenceV2InstallationTablePresent(postflight);
    const remainingV2Triggers = planIdempotentTriggerInstallation(
      v2Extracted.triggers,
      postflight.triggers,
    );
    if (remainingV2Triggers.length > 0) {
      throw new Error("READINESS_FENCE_V2_POSTFLIGHT_INCOMPLETE");
    }
    if (
      classifyReadinessFenceV2ExtensionInstallation(
        await readReadinessFenceV2ExtensionInstallations(connection),
      ) !== "V2_EXTENSION_ABSENT"
    ) {
      throw new Error("READINESS_FENCE_V2_EXTENSION_INSTALLATION_RACE");
    }

    // Sem UPSERT: V1 não é tocada e uma corrida no recibo V2 falha para
    // inspeção, em vez de reclassificar cobertura parcialmente observada.
    await insertReadinessFenceV2ExtensionInstallation(connection);
    if (
      classifyReadinessFenceV2ExtensionInstallation(
        await readReadinessFenceV2ExtensionInstallations(connection),
      ) !== "V2_EXTENSION_EXACT"
    ) {
      throw new Error("READINESS_FENCE_V2_EXTENSION_INSTALLATION_WRITE_FAILED");
    }
    console.log("Extensão V2 da fence de prontidão aplicada");
  } finally {
    if (lockAcquired) {
      await releaseReadinessFenceInstallationLock(connection);
    }
    await connection.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  applyReadinessFenceV2Migration().catch((error) => {
    console.error(
      "Falha ao aplicar extensão V2 da fence de prontidão:",
      error instanceof Error ? error.message : "erro desconhecido",
    );
    process.exitCode = 1;
  });
}
