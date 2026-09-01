/**
 * Instalador manual da fence de prontidão V1.
 *
 * Não é chamado pelo servidor. Como DDL do MySQL não é transacional, uma
 * instalação interrompida permanece bloqueada para inspeção humana, exceto
 * pelo estado PREPARED estritamente verificável (duas tabelas exatas, zero
 * triggers V1 e zero recibo), que é seguro retomar após schema-push.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import mysql, { type Connection } from "mysql2/promise";
import {
  READINESS_FENCE_V1_COVERAGE_HASH,
  READINESS_FENCE_V1_COVERAGE_VERSION,
  READINESS_FENCE_V1_INSTALLATION_ID,
} from "../server/readiness-fence-v1-contract";

const MIGRATION_URL = new URL(
  "../drizzle/migrations/manual/2026-09-01-readiness-fence-v1-clean.sql",
  import.meta.url,
);
const INSTALLATION_LOCK = "escala:readiness-fence:2026-09-01-v1-clean";
const INSTALLATION_LOCK_TIMEOUT_SECONDS = 30;

/**
 * Fontes que um consumidor V1 futuro poderá incluir no snapshot. A V1 não
 * inclui especialidade textual, relação N:N de especialidades ou confiança de
 * e-mail: cada uma exige extensão versionada, e não mudança silenciosa.
 */
export const READINESS_FENCE_V1_SOURCE_COLUMNS = {
  institutions: ["id", "is_active"],
  hospitals: ["id", "institution_id"],
  sectors: ["id", "institution_id", "hospital_id"],
  schedule_contexts: [
    "id",
    "institution_id",
    "hospital_id",
    "sector_id",
    "active",
    "admission_policy",
  ],
  shift_templates: [
    "id",
    "institution_id",
    "hospital_id",
    "sector_id",
    "name",
    "start_time",
    "end_time",
    "is_active",
    "priority",
  ],
  shift_instances: [
    "id",
    "institution_id",
    "hospital_id",
    "sector_id",
    "schedule_context_id",
    "label",
    "status",
    "start_at",
    "end_at",
    "modality",
    "coverage_type",
    "payment_model",
    "productivity_cap_brl",
  ],
  shift_assignments_v2: [
    "id",
    "institution_id",
    "hospital_id",
    "sector_id",
    "shift_instance_id",
    "professional_id",
    "assignment_type",
    "status",
    "is_active",
  ],
  professional_institutions: [
    "id",
    "institution_id",
    "professional_id",
    "user_id",
    "role_in_institution",
    "active",
  ],
  professional_access: [
    "id",
    "institution_id",
    "professional_id",
    "hospital_id",
    "sector_id",
    "can_access",
  ],
  manager_scope: [
    "id",
    "institution_id",
    "manager_professional_id",
    "hospital_id",
    "sector_id",
    "active",
  ],
  monthly_rosters: [
    "id",
    "institution_id",
    "hospital_id",
    "year_month",
    "status",
    "version",
  ],
  users: ["id", "email", "approval_status", "deleted_at"],
  professionals: ["id", "user_id"],
  push_tokens: ["id", "user_id"],
} as const;

export const READINESS_FENCE_V1_OWNED_TABLES = [
  "institution_readiness_fences",
  "institution_readiness_fence_installations",
] as const;

type OwnedTableName = (typeof READINESS_FENCE_V1_OWNED_TABLES)[number];
/**
 * FRESH: nada próprio existe.
 * PREPARED: o schema-push já materializou as duas tabelas exatamente como o
 * contrato V1 exige, mas ainda não há triggers V1 nem recibo. É o único
 * estado interrompido que pode ser retomado sem esconder perda de cobertura.
 * COMPLETE: tabelas, triggers e recibo canônicos estão presentes.
 */
export type InstallationState = "FRESH" | "PREPARED" | "COMPLETE";

export type IdempotentTriggerDefinition = Readonly<{
  name: string;
  timing: "BEFORE" | "AFTER";
  event: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  actionStatement: string;
  statement: string;
}>;

export type ExistingTableDefinition = Readonly<{
  tableName: string;
  tableType: string;
  engine: string | null;
}>;

export type ExistingColumnDefinition = Readonly<{
  tableName: string;
  columnName: string;
  columnType: string;
  isNullable: string;
  columnDefault: string | null;
  extra: string;
}>;

export type ExistingKeyDefinition = Readonly<{
  tableName: string;
  constraintName: string;
  columnName: string;
  ordinalPosition: number;
}>;

export type ExistingForeignKeyDefinition = Readonly<{
  tableName: string;
  constraintName: string;
  columnName: string;
  referencedTableName: string;
  referencedColumnName: string;
  deleteRule: string;
  updateRule: string;
}>;

export type ExistingTriggerDefinition = Readonly<{
  triggerName: string;
  actionTiming: string;
  eventManipulation: string;
  eventObjectTable: string;
  actionOrientation: string;
  actionStatement: string;
}>;

export type ExistingInstallationMarker = Readonly<{
  id: number | string;
  coverageVersion: string;
  coverageHash: string;
}>;

export type ReadinessFenceV1Catalog = Readonly<{
  tables: readonly ExistingTableDefinition[];
  columns: readonly ExistingColumnDefinition[];
  keys: readonly ExistingKeyDefinition[];
  foreignKeys: readonly ExistingForeignKeyDefinition[];
  triggers: readonly ExistingTriggerDefinition[];
}>;

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeSql(value: string): string {
  return value
    .replace(/`/g, "")
    .replace(/;\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function compareCanonicalAscii(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sourceTableNames(): string[] {
  return Object.keys(READINESS_FENCE_V1_SOURCE_COLUMNS);
}

function parseTrigger(
  statement: string,
  allowedTables: ReadonlySet<string>,
): IdempotentTriggerDefinition {
  const parsed =
    /^CREATE\s+TRIGGER\s+`?([A-Za-z0-9_]+)`?\s+(BEFORE|AFTER)\s+(INSERT|UPDATE|DELETE)\s+ON\s+`?([A-Za-z0-9_]+)`?\s+FOR\s+EACH\s+ROW\s+([\s\S]+);\s*$/i.exec(
      statement,
    );
  if (!parsed) throw new Error("READINESS_FENCE_V1_TRIGGER_PARSE_FAILED");

  const [, name, timing, event, rawTable, rawActionStatement] = parsed;
  const table = normalizeIdentifier(rawTable);
  if (!allowedTables.has(table)) {
    throw new Error("READINESS_FENCE_V1_TRIGGER_SOURCE_UNAUTHORIZED");
  }
  const actionStatement = rawActionStatement.trim();
  if (!actionStatement || /\bBEGIN\b|\bEND\b/i.test(actionStatement)) {
    throw new Error("READINESS_FENCE_V1_TRIGGER_BODY_UNSUPPORTED");
  }
  return Object.freeze({
    name,
    timing: timing.toUpperCase() as "BEFORE" | "AFTER",
    event: event.toUpperCase() as "INSERT" | "UPDATE" | "DELETE",
    table,
    actionStatement,
    statement,
  });
}

/**
 * Extrai somente triggers declarados explicitamente. O SQL comum não pode
 * carregar DDL implícito além das duas tabelas próprias.
 */
export function extractReadinessFenceV1Migration(
  migrationSql: string,
): Readonly<{
  tableSql: string;
  triggers: readonly IdempotentTriggerDefinition[];
}> {
  const allowedTables = new Set(sourceTableNames());
  const directive = /^\s*--\s*@readiness-fence-trigger\s*$/gim;
  const tableSqlParts: string[] = [];
  const triggers: IdempotentTriggerDefinition[] = [];
  const names = new Set<string>();
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = directive.exec(migrationSql))) {
    tableSqlParts.push(migrationSql.slice(cursor, match.index));
    const remaining = migrationSql.slice(directive.lastIndex);
    const firstNonWhitespace = remaining.search(/\S/);
    if (firstNonWhitespace < 0) {
      throw new Error("READINESS_FENCE_V1_TRIGGER_MISSING");
    }
    const statementStart = directive.lastIndex + firstNonWhitespace;
    const statementEnd = migrationSql.indexOf(";", statementStart);
    if (statementEnd < 0) {
      throw new Error("READINESS_FENCE_V1_TRIGGER_UNTERMINATED");
    }
    const trigger = parseTrigger(
      migrationSql.slice(statementStart, statementEnd + 1).trim(),
      allowedTables,
    );
    if (names.has(trigger.name)) {
      throw new Error("READINESS_FENCE_V1_TRIGGER_DUPLICATE");
    }
    names.add(trigger.name);
    triggers.push(trigger);
    cursor = statementEnd + 1;
    directive.lastIndex = cursor;
  }

  tableSqlParts.push(migrationSql.slice(cursor));
  if (triggers.length === 0) {
    throw new Error("READINESS_FENCE_V1_TRIGGER_EMPTY");
  }
  return Object.freeze({ tableSql: tableSqlParts.join(""), triggers });
}

/**
 * Não existe executor SQL genérico: os dois CREATE TABLE são a única parcela
 * sem trigger e precisam ser reconhecidos antes de qualquer mutação.
 */
export function extractReadinessFenceV1TableStatements(
  tableSql: string,
): readonly string[] {
  const statements = tableSql
    .replace(/--[^\r\n]*/g, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);

  if (statements.length !== READINESS_FENCE_V1_OWNED_TABLES.length) {
    throw new Error("READINESS_FENCE_V1_TABLE_DDL_INVALID");
  }

  const seen = new Set<string>();
  for (const statement of statements) {
    const match = /^CREATE\s+TABLE\s+`?([A-Za-z0-9_]+)`?\s*\(/i.exec(statement);
    if (!match || /\bIF\s+NOT\s+EXISTS\b/i.test(statement)) {
      throw new Error("READINESS_FENCE_V1_TABLE_DDL_INVALID");
    }
    const table = normalizeIdentifier(match[1]);
    if (
      !READINESS_FENCE_V1_OWNED_TABLES.includes(table as OwnedTableName) ||
      seen.has(table)
    ) {
      throw new Error("READINESS_FENCE_V1_TABLE_DDL_INVALID");
    }
    seen.add(table);
  }
  for (const table of READINESS_FENCE_V1_OWNED_TABLES) {
    if (!seen.has(table)) {
      throw new Error("READINESS_FENCE_V1_TABLE_DDL_INVALID");
    }
  }
  return statements;
}

export function calculateReadinessFenceV1CoverageHash(
  triggers: readonly IdempotentTriggerDefinition[],
): string {
  const sourceColumns = Object.fromEntries(
    Object.entries(READINESS_FENCE_V1_SOURCE_COLUMNS)
      .sort(([left], [right]) => compareCanonicalAscii(left, right))
      .map(([table, columns]) => [table, [...columns].sort()]),
  );
  const triggerDefinitions = [...triggers]
    .map((trigger) => ({
      name: trigger.name,
      timing: trigger.timing,
      event: trigger.event,
      table: trigger.table,
      actionStatement: normalizeSql(trigger.actionStatement),
    }))
    .sort((left, right) => compareCanonicalAscii(left.name, right.name));
  return createHash("sha256")
    .update(
      JSON.stringify({
        coverageVersion: READINESS_FENCE_V1_COVERAGE_VERSION,
        sourceColumns,
        triggerDefinitions,
      }),
    )
    .digest("hex");
}

function triggerSlot(trigger: {
  table: string;
  timing: string;
  event: string;
}): string {
  return [
    normalizeIdentifier(trigger.table),
    trigger.timing.toUpperCase(),
    trigger.event.toUpperCase(),
  ].join("\u0000");
}

export function idempotentTriggerMatchesExisting(
  expected: IdempotentTriggerDefinition,
  existing: ExistingTriggerDefinition,
): boolean {
  return (
    existing.triggerName === expected.name &&
    existing.actionTiming.toUpperCase() === expected.timing &&
    existing.eventManipulation.toUpperCase() === expected.event &&
    normalizeIdentifier(existing.eventObjectTable) === expected.table &&
    existing.actionOrientation.toUpperCase() === "ROW" &&
    normalizeSql(existing.actionStatement) ===
      normalizeSql(expected.actionStatement)
  );
}

/**
 * Um nome conhecido divergente ou trigger externo no mesmo slot nunca é
 * reescrito. O retorno contém somente os triggers ausentes.
 */
export function missingOrIncompatibleReadinessFenceV1Triggers(
  expected: readonly IdempotentTriggerDefinition[],
  existing: readonly ExistingTriggerDefinition[],
): readonly IdempotentTriggerDefinition[] {
  const expectedByName = new Map(
    expected.map((trigger) => [trigger.name, trigger]),
  );
  const expectedSlots = new Set(expected.map(triggerSlot));
  const seenNames = new Set<string>();

  for (const trigger of existing) {
    if (seenNames.has(trigger.triggerName)) {
      throw new Error("READINESS_FENCE_V1_TRIGGER_CATALOG_DIVERGENT");
    }
    seenNames.add(trigger.triggerName);
    const expectedTrigger = expectedByName.get(trigger.triggerName);
    if (expectedTrigger) {
      if (!idempotentTriggerMatchesExisting(expectedTrigger, trigger)) {
        throw new Error("READINESS_FENCE_V1_TRIGGER_CATALOG_DIVERGENT");
      }
      continue;
    }
    if (
      expectedSlots.has(
        triggerSlot({
          table: trigger.eventObjectTable,
          timing: trigger.actionTiming,
          event: trigger.eventManipulation,
        }),
      )
    ) {
      throw new Error("READINESS_FENCE_V1_TRIGGER_SLOT_OCCUPIED");
    }
  }
  return expected.filter((trigger) => !seenNames.has(trigger.name));
}

function assertBaseInnoDbTable(
  table: ExistingTableDefinition | undefined,
  errorCode: string,
): asserts table is ExistingTableDefinition {
  if (
    !table ||
    table.tableType.toUpperCase() !== "BASE TABLE" ||
    table.engine?.toUpperCase() !== "INNODB"
  ) {
    throw new Error(errorCode);
  }
}

function tablesByName(
  tables: readonly ExistingTableDefinition[],
): Map<string, ExistingTableDefinition> {
  return new Map(
    tables.map((table) => [normalizeIdentifier(table.tableName), table]),
  );
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

/** Ausência de fonte nunca pode virar instalação parcial. */
export function assertReadinessFenceV1SourceSchema(
  catalog: ReadinessFenceV1Catalog,
): void {
  const byName = tablesByName(catalog.tables);
  for (const [tableName, requiredColumns] of Object.entries(
    READINESS_FENCE_V1_SOURCE_COLUMNS,
  )) {
    assertBaseInnoDbTable(
      byName.get(tableName),
      "READINESS_FENCE_V1_SOURCE_SCHEMA_UNVERIFIED",
    );
    const actualColumns = columnsForTable(catalog.columns, tableName);
    for (const columnName of requiredColumns) {
      if (!actualColumns.has(columnName)) {
        throw new Error("READINESS_FENCE_V1_SOURCE_SCHEMA_UNVERIFIED");
      }
    }
  }
}

type OwnedColumnRequirement = Readonly<{
  name: string;
  type: RegExp;
  nullable: "YES" | "NO";
  default: (value: string | null) => boolean;
  extra?: RegExp;
  primary?: boolean;
}>;

const DEFAULT_NONE = (value: string | null) => value === null;
const DEFAULT_ZERO = (value: string | null) => value === "0";
const DEFAULT_CURRENT_TIMESTAMP = (value: string | null) =>
  value !== null && /^current_timestamp(?:\(\))?$/i.test(value);

const OWNED_COLUMNS: Record<OwnedTableName, readonly OwnedColumnRequirement[]> =
  {
    institution_readiness_fences: [
      {
        name: "institution_id",
        type: /^int(?:\(\d+\))?$/i,
        nullable: "NO",
        default: DEFAULT_NONE,
        primary: true,
      },
      {
        name: "revision",
        type: /^bigint(?:\(\d+\))? unsigned$/i,
        nullable: "NO",
        default: DEFAULT_ZERO,
      },
      {
        name: "created_at",
        type: /^timestamp$/i,
        nullable: "NO",
        default: DEFAULT_CURRENT_TIMESTAMP,
        extra: /^(?:default_generated)?$/i,
      },
      {
        name: "updated_at",
        type: /^timestamp$/i,
        nullable: "NO",
        default: DEFAULT_CURRENT_TIMESTAMP,
        extra: /^(?:default_generated )?on update current_timestamp(?:\(\))?$/i,
      },
    ],
    institution_readiness_fence_installations: [
      {
        name: "id",
        type: /^tinyint(?:\(\d+\))? unsigned$/i,
        nullable: "NO",
        default: DEFAULT_NONE,
        primary: true,
      },
      {
        name: "coverage_version",
        type: /^varchar\(64\)$/i,
        nullable: "NO",
        default: DEFAULT_NONE,
      },
      {
        name: "coverage_hash",
        type: /^char\(64\)$/i,
        nullable: "NO",
        default: DEFAULT_NONE,
      },
      {
        name: "installed_at",
        type: /^timestamp$/i,
        nullable: "NO",
        default: DEFAULT_CURRENT_TIMESTAMP,
        extra: /^(?:default_generated)?$/i,
      },
    ],
  };

function assertOwnedTableShape(
  catalog: ReadinessFenceV1Catalog,
  tableName: OwnedTableName,
): void {
  const table = tablesByName(catalog.tables).get(tableName);
  assertBaseInnoDbTable(table, "READINESS_FENCE_V1_OWNED_SCHEMA_DIVERGENT");

  const actualColumns = columnsForTable(catalog.columns, tableName);
  const expectedColumns = OWNED_COLUMNS[tableName];
  if (actualColumns.size !== expectedColumns.length) {
    throw new Error("READINESS_FENCE_V1_OWNED_SCHEMA_DIVERGENT");
  }
  for (const expected of expectedColumns) {
    const actual = actualColumns.get(expected.name);
    if (
      !actual ||
      !expected.type.test(actual.columnType) ||
      actual.isNullable.toUpperCase() !== expected.nullable ||
      !expected.default(actual.columnDefault) ||
      (expected.extra
        ? !expected.extra.test(actual.extra.trim())
        : actual.extra.trim() !== "")
    ) {
      throw new Error("READINESS_FENCE_V1_OWNED_SCHEMA_DIVERGENT");
    }
  }

  const primaryColumns = catalog.keys
    .filter(
      (key) =>
        normalizeIdentifier(key.tableName) === tableName &&
        key.constraintName === "PRIMARY",
    )
    .sort((left, right) => left.ordinalPosition - right.ordinalPosition)
    .map((key) => normalizeIdentifier(key.columnName));
  const expectedPrimary = expectedColumns
    .filter((column) => column.primary)
    .map((column) => column.name);
  if (
    primaryColumns.length !== expectedPrimary.length ||
    primaryColumns.some((column, index) => column !== expectedPrimary[index])
  ) {
    throw new Error("READINESS_FENCE_V1_OWNED_SCHEMA_DIVERGENT");
  }

  const foreignKeys = catalog.foreignKeys.filter(
    (foreignKey) => normalizeIdentifier(foreignKey.tableName) === tableName,
  );
  if (tableName === "institution_readiness_fences") {
    if (
      foreignKeys.length !== 1 ||
      normalizeIdentifier(foreignKeys[0]!.constraintName) !==
        "fk_rdf_institution" ||
      normalizeIdentifier(foreignKeys[0]!.columnName) !== "institution_id" ||
      normalizeIdentifier(foreignKeys[0]!.referencedTableName) !==
        "institutions" ||
      normalizeIdentifier(foreignKeys[0]!.referencedColumnName) !== "id" ||
      foreignKeys[0]!.deleteRule.toUpperCase() !== "CASCADE" ||
      !["RESTRICT", "NO ACTION"].includes(
        foreignKeys[0]!.updateRule.toUpperCase(),
      )
    ) {
      throw new Error("READINESS_FENCE_V1_OWNED_SCHEMA_DIVERGENT");
    }
  } else if (foreignKeys.length !== 0) {
    throw new Error("READINESS_FENCE_V1_OWNED_SCHEMA_DIVERGENT");
  }
}

function ownedTablePresence(catalog: ReadinessFenceV1Catalog): number {
  const byName = tablesByName(catalog.tables);
  return READINESS_FENCE_V1_OWNED_TABLES.filter((table) => byName.has(table))
    .length;
}

function assertNoOwnedTableTriggers(catalog: ReadinessFenceV1Catalog): void {
  const hasOwnedTrigger = catalog.triggers.some((trigger) =>
    READINESS_FENCE_V1_OWNED_TABLES.includes(
      normalizeIdentifier(trigger.eventObjectTable) as OwnedTableName,
    ),
  );
  if (hasOwnedTrigger) {
    throw new Error("READINESS_FENCE_V1_OWNED_TRIGGER_UNSUPPORTED");
  }
}

function exactMarker(
  markers: readonly ExistingInstallationMarker[],
): ExistingInstallationMarker {
  if (markers.length !== 1) {
    throw new Error("READINESS_FENCE_V1_INSTALLATION_MARKER_UNVERIFIED");
  }
  const [marker] = markers;
  if (
    Number(marker?.id) !== READINESS_FENCE_V1_INSTALLATION_ID ||
    marker?.coverageVersion !== READINESS_FENCE_V1_COVERAGE_VERSION ||
    marker?.coverageHash !== READINESS_FENCE_V1_COVERAGE_HASH
  ) {
    throw new Error("READINESS_FENCE_V1_INSTALLATION_MARKER_UNVERIFIED");
  }
  return marker;
}

/**
 * Antes de qualquer DDL a instalação só pode estar totalmente ausente,
 * totalmente completa ou PREPARED. PREPARED é estritamente as duas tabelas
 * próprias com contrato exato, zero triggers V1 e zero recibos: é o estado
 * que um schema-push pode deixar antes do instalador dedicado acrescentar os
 * triggers. Qualquer outro meio-termo continua exigindo auditoria humana.
 */
export function classifyReadinessFenceV1Installation(
  catalog: ReadinessFenceV1Catalog,
  expectedTriggers: readonly IdempotentTriggerDefinition[],
  markers: readonly ExistingInstallationMarker[] | undefined,
): InstallationState {
  assertReadinessFenceV1SourceSchema(catalog);
  assertNoOwnedTableTriggers(catalog);
  const missingTriggers = missingOrIncompatibleReadinessFenceV1Triggers(
    expectedTriggers,
    catalog.triggers,
  );
  const ownedCount = ownedTablePresence(catalog);

  if (ownedCount === 0) {
    if (
      markers !== undefined ||
      missingTriggers.length !== expectedTriggers.length
    ) {
      throw new Error("READINESS_FENCE_V1_PARTIAL_INSTALLATION");
    }
    return "FRESH";
  }

  if (ownedCount !== READINESS_FENCE_V1_OWNED_TABLES.length) {
    throw new Error("READINESS_FENCE_V1_PARTIAL_INSTALLATION");
  }
  for (const table of READINESS_FENCE_V1_OWNED_TABLES) {
    assertOwnedTableShape(catalog, table);
  }

  if (markers === undefined) {
    throw new Error("READINESS_FENCE_V1_PARTIAL_INSTALLATION");
  }

  if (
    missingTriggers.length === expectedTriggers.length &&
    markers.length === 0
  ) {
    return "PREPARED";
  }

  if (missingTriggers.length !== 0) {
    throw new Error("READINESS_FENCE_V1_PARTIAL_INSTALLATION");
  }
  exactMarker(markers);
  return "COMPLETE";
}

const LOOPBACK_DATABASE_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
]);

/**
 * A instalação normal exige TLS. A exceção de loopback só existe para a
 * prova efêmera explicitamente autorizada em NODE_ENV=test; ela não é um
 * fallback implícito para desenvolvimento ou produção.
 */
export function buildReadinessFenceV1ConnectionOptions(
  rawUrl: string,
  options: Readonly<{ allowInsecureLoopbackForTest?: boolean }> = {},
) {
  if (!rawUrl.trim()) {
    throw new Error("READINESS_FENCE_V1_DATABASE_URL é obrigatória");
  }
  const url = new URL(rawUrl);
  if (url.protocol !== "mysql:") {
    throw new Error("READINESS_FENCE_V1_DATABASE_URL deve usar mysql://");
  }
  if (url.hash) {
    throw new Error("READINESS_FENCE_V1_DATABASE_URL não aceita fragmento");
  }
  for (const key of url.searchParams.keys()) {
    if (key !== "ssl-mode") {
      throw new Error(
        "READINESS_FENCE_V1_DATABASE_URL contém opção não autorizada",
      );
    }
  }
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!database || database.includes("/")) {
    throw new Error(
      "READINESS_FENCE_V1_DATABASE_URL deve informar exatamente um banco",
    );
  }

  const sslMode = url.searchParams.get("ssl-mode")?.toUpperCase();
  if (sslMode && sslMode !== "REQUIRED") {
    throw new Error(
      "READINESS_FENCE_V1_DATABASE_URL aceita somente ssl-mode=REQUIRED",
    );
  }
  const isLoopback = LOOPBACK_DATABASE_HOSTS.has(url.hostname.toLowerCase());
  if (
    sslMode !== "REQUIRED" &&
    !(isLoopback && options.allowInsecureLoopbackForTest)
  ) {
    throw new Error("READINESS_FENCE_V1_DATABASE_TLS_REQUIRED");
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    ssl: sslMode === "REQUIRED" ? { rejectUnauthorized: true } : undefined,
  };
}

export async function readReadinessFenceV1Catalog(
  connection: Connection,
): Promise<ReadinessFenceV1Catalog> {
  const sourceTables = sourceTableNames();
  const tableNames = [...sourceTables, ...READINESS_FENCE_V1_OWNED_TABLES];
  const [tableRows] = await connection.query(
    [
      "SELECT TABLE_NAME AS tableName,",
      "       TABLE_TYPE AS tableType,",
      "       ENGINE AS engine",
      "FROM INFORMATION_SCHEMA.TABLES",
      "WHERE TABLE_SCHEMA = DATABASE()",
      "  AND TABLE_NAME IN (?)",
    ].join("\n"),
    [tableNames],
  );
  const [columnRows] = await connection.query(
    [
      "SELECT TABLE_NAME AS tableName,",
      "       COLUMN_NAME AS columnName,",
      "       COLUMN_TYPE AS columnType,",
      "       IS_NULLABLE AS isNullable,",
      "       COLUMN_DEFAULT AS columnDefault,",
      "       EXTRA AS extra",
      "FROM INFORMATION_SCHEMA.COLUMNS",
      "WHERE TABLE_SCHEMA = DATABASE()",
      "  AND TABLE_NAME IN (?)",
    ].join("\n"),
    [tableNames],
  );
  const [keyRows] = await connection.query(
    [
      "SELECT TABLE_NAME AS tableName,",
      "       CONSTRAINT_NAME AS constraintName,",
      "       COLUMN_NAME AS columnName,",
      "       ORDINAL_POSITION AS ordinalPosition",
      "FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE",
      "WHERE TABLE_SCHEMA = DATABASE()",
      "  AND TABLE_NAME IN (?)",
    ].join("\n"),
    [READINESS_FENCE_V1_OWNED_TABLES],
  );
  const [foreignKeyRows] = await connection.query(
    [
      "SELECT kcu.TABLE_NAME AS tableName,",
      "       kcu.CONSTRAINT_NAME AS constraintName,",
      "       kcu.COLUMN_NAME AS columnName,",
      "       kcu.REFERENCED_TABLE_NAME AS referencedTableName,",
      "       kcu.REFERENCED_COLUMN_NAME AS referencedColumnName,",
      "       rc.DELETE_RULE AS deleteRule,",
      "       rc.UPDATE_RULE AS updateRule",
      "FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS kcu",
      "JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS AS rc",
      "  ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA",
      " AND rc.TABLE_NAME = kcu.TABLE_NAME",
      " AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME",
      "WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()",
      "  AND kcu.TABLE_NAME IN (?)",
      "  AND kcu.REFERENCED_TABLE_NAME IS NOT NULL",
    ].join("\n"),
    [READINESS_FENCE_V1_OWNED_TABLES],
  );
  const [triggerRows] = await connection.query(
    [
      "SELECT TRIGGER_NAME AS triggerName,",
      "       ACTION_TIMING AS actionTiming,",
      "       EVENT_MANIPULATION AS eventManipulation,",
      "       EVENT_OBJECT_TABLE AS eventObjectTable,",
      "       ACTION_ORIENTATION AS actionOrientation,",
      "       ACTION_STATEMENT AS actionStatement",
      "FROM INFORMATION_SCHEMA.TRIGGERS",
      "WHERE TRIGGER_SCHEMA = DATABASE()",
      "  AND EVENT_OBJECT_TABLE IN (?)",
    ].join("\n"),
    [tableNames],
  );

  return {
    tables: Array.isArray(tableRows)
      ? (tableRows as ExistingTableDefinition[])
      : [],
    columns: Array.isArray(columnRows)
      ? (columnRows as ExistingColumnDefinition[])
      : [],
    keys: Array.isArray(keyRows) ? (keyRows as ExistingKeyDefinition[]) : [],
    foreignKeys: Array.isArray(foreignKeyRows)
      ? (foreignKeyRows as ExistingForeignKeyDefinition[])
      : [],
    triggers: Array.isArray(triggerRows)
      ? (triggerRows as ExistingTriggerDefinition[])
      : [],
  };
}

export async function readReadinessFenceV1Markers(
  connection: Connection,
): Promise<readonly ExistingInstallationMarker[]> {
  const [rows] = await connection.query(
    [
      "SELECT id,",
      "       coverage_version AS coverageVersion,",
      "       coverage_hash AS coverageHash",
      "FROM institution_readiness_fence_installations",
    ].join("\n"),
  );
  return Array.isArray(rows) ? (rows as ExistingInstallationMarker[]) : [];
}

async function acquireInstallationLock(connection: Connection): Promise<void> {
  const [rows] = await connection.query("SELECT GET_LOCK(?, ?) AS acquired", [
    INSTALLATION_LOCK,
    INSTALLATION_LOCK_TIMEOUT_SECONDS,
  ]);
  const acquired = Array.isArray(rows)
    ? Number((rows[0] as { acquired?: unknown } | undefined)?.acquired)
    : 0;
  if (acquired !== 1) {
    throw new Error("READINESS_FENCE_V1_INSTALLATION_LOCK_UNAVAILABLE");
  }
}

async function releaseInstallationLock(connection: Connection): Promise<void> {
  await connection.query("SELECT RELEASE_LOCK(?)", [INSTALLATION_LOCK]);
}

async function assertPostDdlBeforeMarker(
  connection: Connection,
  expectedTriggers: readonly IdempotentTriggerDefinition[],
): Promise<void> {
  const catalog = await readReadinessFenceV1Catalog(connection);
  assertReadinessFenceV1SourceSchema(catalog);
  assertNoOwnedTableTriggers(catalog);
  if (ownedTablePresence(catalog) !== READINESS_FENCE_V1_OWNED_TABLES.length) {
    throw new Error("READINESS_FENCE_V1_POSTFLIGHT_INCOMPLETE");
  }
  for (const table of READINESS_FENCE_V1_OWNED_TABLES) {
    assertOwnedTableShape(catalog, table);
  }
  if (
    missingOrIncompatibleReadinessFenceV1Triggers(
      expectedTriggers,
      catalog.triggers,
    ).length !== 0
  ) {
    throw new Error("READINESS_FENCE_V1_POSTFLIGHT_INCOMPLETE");
  }
  if ((await readReadinessFenceV1Markers(connection)).length !== 0) {
    throw new Error("READINESS_FENCE_V1_POSTFLIGHT_INCOMPLETE");
  }
}

async function insertExactInstallationMarker(
  connection: Connection,
): Promise<void> {
  await connection.query(
    [
      "INSERT INTO institution_readiness_fence_installations",
      "  (id, coverage_version, coverage_hash)",
      "VALUES (?, ?, ?)",
    ].join("\n"),
    [
      READINESS_FENCE_V1_INSTALLATION_ID,
      READINESS_FENCE_V1_COVERAGE_VERSION,
      READINESS_FENCE_V1_COVERAGE_HASH,
    ],
  );
}

export async function applyReadinessFenceV1Migration(
  options: Readonly<{
    explicitApproval: true;
    databaseUrl: string;
    /** Só aceito pela prova isolada, que também exige NODE_ENV=test. */
    allowInsecureLoopbackForTest?: true;
  }>,
): Promise<InstallationState> {
  if (options.explicitApproval !== true) {
    throw new Error("READINESS_FENCE_V1_EXPLICIT_APPROVAL_REQUIRED");
  }

  const migrationSql = readFileSync(fileURLToPath(MIGRATION_URL), "utf8");
  const { tableSql, triggers } = extractReadinessFenceV1Migration(migrationSql);
  if (
    calculateReadinessFenceV1CoverageHash(triggers) !==
    READINESS_FENCE_V1_COVERAGE_HASH
  ) {
    throw new Error("READINESS_FENCE_V1_COVERAGE_HASH_DIVERGENT");
  }
  const tableStatements = extractReadinessFenceV1TableStatements(tableSql);
  const connection = await mysql.createConnection(
    buildReadinessFenceV1ConnectionOptions(options.databaseUrl, {
      allowInsecureLoopbackForTest:
        process.env.NODE_ENV === "test" &&
        options.allowInsecureLoopbackForTest === true,
    }),
  );
  let lockAcquired = false;

  try {
    await acquireInstallationLock(connection);
    lockAcquired = true;
    const preflight = await readReadinessFenceV1Catalog(connection);
    const ownedCount = ownedTablePresence(preflight);
    const markers =
      ownedCount === READINESS_FENCE_V1_OWNED_TABLES.length
        ? await readReadinessFenceV1Markers(connection)
        : undefined;
    const state = classifyReadinessFenceV1Installation(
      preflight,
      triggers,
      markers,
    );
    if (state === "COMPLETE") {
      console.log("Readiness fence V1 já está íntegra.");
      return state;
    }

    if (state === "FRESH") {
      for (const statement of tableStatements) {
        await connection.query(statement);
      }
    }
    for (const trigger of triggers) {
      await connection.query(trigger.statement);
    }

    await assertPostDdlBeforeMarker(connection, triggers);
    await insertExactInstallationMarker(connection);

    const postflight = await readReadinessFenceV1Catalog(connection);
    const completeState = classifyReadinessFenceV1Installation(
      postflight,
      triggers,
      await readReadinessFenceV1Markers(connection),
    );
    if (completeState !== "COMPLETE") {
      throw new Error("READINESS_FENCE_V1_POSTFLIGHT_INCOMPLETE");
    }
    console.log("Readiness fence V1 instalada.");
    return completeState;
  } finally {
    if (lockAcquired) {
      await releaseInstallationLock(connection);
    }
    await connection.end();
  }
}

type DedicatedCliEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * O comando dedicado nunca usa DATABASE_URL por acidente. A escolha do alvo
 * é explícita e a senha não aparece em nenhuma mensagem de uso ou de erro.
 */
export function readReadinessFenceV1DedicatedCliOptions(
  env: DedicatedCliEnvironment = process.env,
): Readonly<{
  explicitApproval: true;
  databaseUrl: string;
  allowInsecureLoopbackForTest?: true;
}> {
  if (env.READINESS_FENCE_V1_APPLY !== "1") {
    throw new Error("READINESS_FENCE_V1_EXPLICIT_APPROVAL_REQUIRED");
  }
  const databaseUrl = env.READINESS_FENCE_V1_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("READINESS_FENCE_V1_DATABASE_URL_REQUIRED");
  }
  if (env.READINESS_FENCE_V1_ALLOW_INSECURE_LOOPBACK_FOR_TEST === "1") {
    if (env.NODE_ENV !== "test") {
      throw new Error("READINESS_FENCE_V1_INSECURE_LOOPBACK_TEST_ONLY");
    }
    return Object.freeze({
      explicitApproval: true,
      databaseUrl,
      allowInsecureLoopbackForTest: true,
    });
  }
  return Object.freeze({ explicitApproval: true, databaseUrl });
}

function safeReadinessFenceV1CliErrorCode(error: unknown): string {
  if (
    error instanceof Error &&
    /^READINESS_FENCE_V1_[A-Z0-9_]+$/.test(error.message)
  ) {
    return error.message;
  }
  return "READINESS_FENCE_V1_INSTALLATION_FAILED";
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(pathToFileURL(process.argv[1]))
) {
  void (async () => {
    await applyReadinessFenceV1Migration(
      readReadinessFenceV1DedicatedCliOptions(),
    );
  })().catch((error) => {
    // Não expõe URL, usuário, senha ou mensagem bruta do driver.
    console.error(
      "Falha ao instalar readiness fence V1:",
      safeReadinessFenceV1CliErrorCode(error),
    );
    process.exitCode = 1;
  });
}
