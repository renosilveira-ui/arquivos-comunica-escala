/**
 * Instalador dedicado da fence de prontidão.
 *
 * Não é chamado automaticamente por esta frente. Quando autorizado para um
 * ambiente específico, faz pré-voo do catálogo, cria somente estruturas
 * ausentes, relê toda a cobertura e só então grava o marcador singleton.
 * Nunca faz DROP/overwrite de trigger, tabela ou marcador.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import mysql from "mysql2/promise";
import type { Connection } from "mysql2/promise";
import { resolveSslConfig } from "../server/_core/db-ssl";
import {
  READINESS_FENCE_COVERAGE_HASH,
  READINESS_FENCE_COVERAGE_VERSION,
  READINESS_FENCE_INSTALLATION_ID,
} from "../server/readiness-fence-contract";

const READINESS_FENCE_MIGRATION_URL = new URL(
  "../drizzle/migrations/manual/2026-08-31-institution-readiness-fences.sql",
  import.meta.url,
);
const READINESS_FENCE_INSTALLATION_LOCK =
  "escalas:institution-readiness-fence:2026-08-31-v1";
const READINESS_FENCE_INSTALLATION_LOCK_TIMEOUT_SECONDS = 30;

export type ReadinessFenceSourceColumns = Readonly<
  Record<string, readonly string[]>
>;

export type ReadinessFenceCoveragePredecessor = Readonly<{
  installationId: number;
  coverageVersion: string;
  coverageHash: string;
}>;

export const READINESS_FENCE_SOURCE_COLUMNS = {
  institutions: ["id", "is_active"],
  hospitals: ["id", "institution_id"],
  sectors: ["institution_id", "hospital_id", "name"],
  schedule_contexts: [
    "id",
    "institution_id",
    "hospital_id",
    "sector_id",
    "medical_specialty_id",
    "operational_profile_code",
    "admission_policy",
    "active",
  ],
  schedule_context_allowed_qualifications: [
    "schedule_context_id",
    "medical_specialty_id",
    "operational_profile_code",
  ],
  shift_templates: [
    "institution_id",
    "hospital_id",
    "sector_id",
    "name",
    "start_time",
    "end_time",
    "priority",
    "is_active",
  ],
  shift_instances: [
    "id",
    "institution_id",
    "hospital_id",
    "sector_id",
    "schedule_context_id",
    "label",
    "specialty",
    "status",
    "start_at",
    "end_at",
    "modality",
    "coverage_type",
    "payment_model",
    "productivity_cap_brl",
  ],
  shift_assignments_v2: [
    "institution_id",
    "hospital_id",
    "sector_id",
    "shift_instance_id",
    "professional_id",
    "status",
    "is_active",
  ],
  professional_institutions: [
    "institution_id",
    "professional_id",
    "user_id",
    "role_in_institution",
    "active",
  ],
  professional_access: [
    "institution_id",
    "professional_id",
    "hospital_id",
    "sector_id",
    "can_access",
  ],
  manager_scope: [
    "institution_id",
    "manager_professional_id",
    "hospital_id",
    "sector_id",
    "active",
  ],
  monthly_rosters: ["institution_id", "hospital_id", "year_month", "status"],
  users: ["id", "email", "approval_status", "deleted_at"],
  professionals: ["id", "user_id"],
  push_tokens: ["user_id"],
} as const satisfies ReadinessFenceSourceColumns;

export const READINESS_FENCE_OWNED_TABLES = [
  "institution_readiness_fences",
  "institution_readiness_fence_installations",
] as const;

type OwnedTableName = (typeof READINESS_FENCE_OWNED_TABLES)[number];

export type IdempotentTriggerDefinition = Readonly<{
  name: string;
  timing: "BEFORE" | "AFTER";
  event: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  actionStatement: string;
  statement: string;
}>;

export type ExistingTriggerDefinition = Readonly<{
  triggerName: string;
  actionTiming: string;
  eventManipulation: string;
  eventObjectTable: string;
  actionOrientation: string;
  actionStatement: string;
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
  columnKey: string;
}>;

export type ExistingKeyDefinition = Readonly<{
  tableName: string;
  constraintName: string;
  columnName: string;
  ordinalPosition: number;
  referencedTableName: string | null;
  referencedColumnName: string | null;
}>;

export type ExistingInstallationMarker = Readonly<{
  id: number | string;
  coverageVersion: string;
  coverageHash: string;
}>;

export type ReadinessFenceCatalog = Readonly<{
  tables: readonly ExistingTableDefinition[];
  columns: readonly ExistingColumnDefinition[];
  keys: readonly ExistingKeyDefinition[];
  triggers: readonly ExistingTriggerDefinition[];
}>;

function requireNonEmpty(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} é obrigatório`);
  return value;
}

export function buildReadinessFenceConnectionOptions() {
  const rawUrl = requireNonEmpty("DATABASE_URL");
  const url = new URL(rawUrl);
  if (url.protocol !== "mysql:") {
    throw new Error("DATABASE_URL deve usar protocolo mysql://");
  }
  const database = url.pathname.replace(/^\//, "");
  if (!database) throw new Error("DATABASE_URL deve informar o banco");
  const sslMode = url.searchParams.get("ssl-mode")?.toUpperCase() ?? null;
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    ssl:
      sslMode === "REQUIRED"
        ? { rejectUnauthorized: true }
        : resolveSslConfig(process.env),
  };
}

function normalizeSql(value: string): string {
  return value
    .replace(/`/g, "")
    .replace(/;\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

function compareCanonicalAscii(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function parseIdempotentTrigger(
  statement: string,
  allowedSourceTables: ReadonlySet<string>,
): IdempotentTriggerDefinition {
  const parsed =
    /^CREATE\s+TRIGGER\s+`?([A-Za-z0-9_]+)`?\s+(BEFORE|AFTER)\s+(INSERT|UPDATE|DELETE)\s+ON\s+`?([A-Za-z0-9_]+)`?\s+FOR\s+EACH\s+ROW\s+([\s\S]+);\s*$/i.exec(
      statement,
    );
  if (!parsed) {
    throw new Error(
      "@idempotent-trigger precisa conter um CREATE TRIGGER simples",
    );
  }
  const [, name, timing, event, table, rawActionStatement] = parsed;
  const normalizedTable = normalizeIdentifier(table);
  if (!allowedSourceTables.has(normalizedTable)) {
    throw new Error(`Trigger aponta para fonte não autorizada: ${table}`);
  }
  const actionStatement = rawActionStatement.trim();
  if (!actionStatement || /\bBEGIN\b|\bEND\b/i.test(actionStatement)) {
    throw new Error(
      `@idempotent-trigger ${name} precisa ter corpo de uma única instrução`,
    );
  }
  return Object.freeze({
    name,
    timing: timing.toUpperCase() as "BEFORE" | "AFTER",
    event: event.toUpperCase() as "INSERT" | "UPDATE" | "DELETE",
    table: normalizedTable,
    actionStatement,
    statement,
  });
}

/**
 * Separa triggers explicitamente marcados do SQL comum da migration. O
 * marcador é intencionalmente restrito a um CREATE TRIGGER de uma instrução:
 * isso evita parser SQL genérico e permite executar o CREATE diretamente, sem
 * PREPARE (não suportado para CREATE TRIGGER pelo MySQL).
 */
export function extractIdempotentTriggerStatementsForSources(
  sql: string,
  sourceTables: readonly string[],
): {
  executableSql: string;
  triggers: IdempotentTriggerDefinition[];
} {
  const allowedSourceTables = new Set(
    sourceTables.map((table) => normalizeIdentifier(table)),
  );
  if (allowedSourceTables.size === 0) {
    throw new Error("@idempotent-trigger requer ao menos uma fonte autorizada");
  }
  const directive = /^\s*--\s*@idempotent-trigger\s*$/gim;
  const executableParts: string[] = [];
  const triggers: IdempotentTriggerDefinition[] = [];
  const names = new Set<string>();
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = directive.exec(sql))) {
    executableParts.push(sql.slice(cursor, match.index));
    const firstNonWhitespace = sql.slice(directive.lastIndex).search(/\S/);
    if (firstNonWhitespace < 0) {
      throw new Error("@idempotent-trigger sem CREATE TRIGGER");
    }
    const statementStart = directive.lastIndex + firstNonWhitespace;
    const statementEnd = sql.indexOf(";", statementStart);
    if (statementEnd < 0) {
      throw new Error("@idempotent-trigger sem terminador de instrução");
    }
    const trigger = parseIdempotentTrigger(
      sql.slice(statementStart, statementEnd + 1).trim(),
      allowedSourceTables,
    );
    if (names.has(trigger.name)) {
      throw new Error(`@idempotent-trigger duplicado: ${trigger.name}`);
    }
    names.add(trigger.name);
    triggers.push(trigger);
    cursor = statementEnd + 1;
    directive.lastIndex = cursor;
  }
  executableParts.push(sql.slice(cursor));

  return { executableSql: executableParts.join(""), triggers };
}

export function extractIdempotentTriggerStatements(sql: string): {
  executableSql: string;
  triggers: IdempotentTriggerDefinition[];
} {
  return extractIdempotentTriggerStatementsForSources(
    sql,
    Object.keys(READINESS_FENCE_SOURCE_COLUMNS),
  );
}

/**
 * A parte não-trigger da migration é deliberadamente limitada a CREATE TABLE
 * aditivo. Isso permite executar cada DDL isoladamente com mysql2, sem
 * habilitar multipleStatements no cliente.
 */
export function extractReadinessFenceTableStatements(sql: string): string[] {
  const statements = sql
    // O SQL comum é restrito a CREATE TABLE próprio; remover comentários antes
    // de separar impede que `;` documental seja interpretado como DDL.
    .replace(/--[^\r\n]*/g, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

  if (statements.length !== READINESS_FENCE_OWNED_TABLES.length) {
    throw new Error(
      "SQL comum da fence deve criar exatamente as tabelas próprias",
    );
  }

  const seenTables = new Set<string>();
  for (const statement of statements) {
    const match =
      /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+`?([A-Za-z0-9_]+)`?\s*\(/i.exec(
        statement,
      );
    if (!match) {
      throw new Error(
        "SQL comum da fence aceita somente CREATE TABLE IF NOT EXISTS",
      );
    }
    const table = normalizeIdentifier(match[1]);
    if (!READINESS_FENCE_OWNED_TABLES.includes(table as OwnedTableName)) {
      throw new Error(`CREATE TABLE fora da propriedade da fence: ${table}`);
    }
    if (seenTables.has(table)) {
      throw new Error(`CREATE TABLE duplicado da fence: ${table}`);
    }
    seenTables.add(table);
  }
  for (const table of READINESS_FENCE_OWNED_TABLES) {
    if (!seenTables.has(table)) {
      throw new Error(`CREATE TABLE ausente da fence: ${table}`);
    }
  }
  return statements;
}

export function calculateReadinessFenceCoverageHashForDefinition(
  coverageVersion: string,
  sourceColumnsDefinition: ReadinessFenceSourceColumns,
  triggers: readonly IdempotentTriggerDefinition[],
  predecessor?: ReadinessFenceCoveragePredecessor,
): string {
  const sourceColumns = Object.fromEntries(
    Object.entries(sourceColumnsDefinition)
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
        coverageVersion,
        sourceColumns,
        triggerDefinitions,
        ...(predecessor ? { predecessor } : {}),
      }),
    )
    .digest("hex");
}

export function calculateReadinessFenceCoverageHash(
  triggers: readonly IdempotentTriggerDefinition[],
): string {
  return calculateReadinessFenceCoverageHashForDefinition(
    READINESS_FENCE_COVERAGE_VERSION,
    READINESS_FENCE_SOURCE_COLUMNS,
    triggers,
  );
}

export function idempotentTriggerMatchesExisting(
  expected: IdempotentTriggerDefinition,
  existing: ExistingTriggerDefinition,
): boolean {
  return (
    existing.triggerName === expected.name &&
    existing.actionTiming.toUpperCase() === expected.timing &&
    existing.eventManipulation.toUpperCase() === expected.event &&
    existing.eventObjectTable === expected.table &&
    existing.actionOrientation.toUpperCase() === "ROW" &&
    normalizeSql(existing.actionStatement) ===
      normalizeSql(expected.actionStatement)
  );
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

/**
 * Classifica o catálogo antes de qualquer CREATE. Uma divergência interrompe
 * a instalação inteira antes de criar tabela ou trigger; a atualização de um
 * corpo existente exige uma migration futura com outro nome de trigger.
 */
export function planIdempotentTriggerInstallation(
  triggers: readonly IdempotentTriggerDefinition[],
  existingRows: readonly ExistingTriggerDefinition[],
): IdempotentTriggerDefinition[] {
  const expectedByName = new Map(
    triggers.map((trigger) => [trigger.name, trigger]),
  );
  const expectedSlots = new Set(triggers.map(triggerSlot));
  const existingByName = new Map<string, ExistingTriggerDefinition>();

  for (const existing of existingRows) {
    if (existingByName.has(existing.triggerName)) {
      throw new Error(`Mais de um trigger encontrado: ${existing.triggerName}`);
    }
    existingByName.set(existing.triggerName, existing);
    const expected = expectedByName.get(existing.triggerName);
    if (expected) {
      if (!idempotentTriggerMatchesExisting(expected, existing)) {
        throw new Error(
          `Trigger existente diverge da migration e não será sobrescrito: ${existing.triggerName}`,
        );
      }
      continue;
    }
    if (
      expectedSlots.has(
        triggerSlot({
          table: existing.eventObjectTable,
          timing: existing.actionTiming,
          event: existing.eventManipulation,
        }),
      )
    ) {
      throw new Error(
        `Trigger externo ocupa slot da fence e não será sobrescrito: ${existing.eventObjectTable}/${existing.actionTiming}/${existing.eventManipulation}`,
      );
    }
  }

  const missing: IdempotentTriggerDefinition[] = [];
  for (const trigger of triggers) {
    if (!existingByName.has(trigger.name)) {
      missing.push(trigger);
    }
  }
  return missing;
}

function assertCoverageHash(
  triggers: readonly IdempotentTriggerDefinition[],
): void {
  const observed = calculateReadinessFenceCoverageHash(triggers);
  if (observed !== READINESS_FENCE_COVERAGE_HASH) {
    throw new Error("READINESS_FENCE_COVERAGE_HASH_DIVERGENT");
  }
}

function assertInnoDbTable(
  table: ExistingTableDefinition | undefined,
  tableName: string,
): asserts table is ExistingTableDefinition {
  if (!table) {
    throw new Error(`Tabela obrigatória ausente: ${tableName}`);
  }
  if (
    table.tableType.toUpperCase() !== "BASE TABLE" ||
    table.engine?.toUpperCase() !== "INNODB"
  ) {
    throw new Error(`Tabela da fence sem BASE TABLE/InnoDB: ${tableName}`);
  }
}

function columnsForTable(
  columns: readonly ExistingColumnDefinition[],
  tableName: string,
): Map<string, ExistingColumnDefinition> {
  return new Map(
    columns
      .filter((column) => column.tableName === tableName)
      .map((column) => [normalizeIdentifier(column.columnName), column]),
  );
}

/** Pré-voo das fontes existentes: ausência nunca pode virar DDL parcial. */
export function assertReadinessFenceSourceSchema(
  tables: readonly ExistingTableDefinition[],
  columns: readonly ExistingColumnDefinition[],
): void {
  const tableByName = new Map(
    tables.map((table) => [normalizeIdentifier(table.tableName), table]),
  );
  for (const [tableName, requiredColumns] of Object.entries(
    READINESS_FENCE_SOURCE_COLUMNS,
  )) {
    assertInnoDbTable(tableByName.get(tableName), tableName);
    const actualColumns = columnsForTable(columns, tableName);
    for (const columnName of requiredColumns) {
      if (!actualColumns.has(columnName)) {
        throw new Error(
          `Coluna obrigatória ausente para fence: ${tableName}.${columnName}`,
        );
      }
    }
  }
}

type OwnedColumnRequirement = Readonly<{
  name: string;
  type: RegExp;
  nullable: "YES" | "NO";
  primary?: boolean;
}>;

const OWNED_TABLE_COLUMNS: Record<
  OwnedTableName,
  readonly OwnedColumnRequirement[]
> = {
  institution_readiness_fences: [
    {
      name: "institution_id",
      type: /^int(?:\(\d+\))?$/i,
      nullable: "NO",
      primary: true,
    },
    {
      name: "revision",
      type: /^bigint(?:\(\d+\))? unsigned$/i,
      nullable: "NO",
    },
    { name: "created_at", type: /^timestamp$/i, nullable: "NO" },
    { name: "updated_at", type: /^timestamp$/i, nullable: "NO" },
  ],
  institution_readiness_fence_installations: [
    {
      name: "id",
      type: /^tinyint(?:\(\d+\))? unsigned$/i,
      nullable: "NO",
      primary: true,
    },
    {
      name: "coverage_version",
      type: /^varchar\(64\)$/i,
      nullable: "NO",
    },
    { name: "coverage_hash", type: /^char\(64\)$/i, nullable: "NO" },
    { name: "installed_at", type: /^timestamp$/i, nullable: "NO" },
  ],
};

function assertOwnedTableKeys(
  tableName: OwnedTableName,
  keys: readonly ExistingKeyDefinition[],
): void {
  const tableKeys = keys.filter((key) => key.tableName === tableName);
  const primaryColumns = tableKeys
    .filter((key) => key.constraintName === "PRIMARY")
    .sort((left, right) => left.ordinalPosition - right.ordinalPosition)
    .map((key) => key.columnName);
  const expectedPrimary = OWNED_TABLE_COLUMNS[tableName]
    .filter((column) => column.primary)
    .map((column) => column.name);
  if (
    primaryColumns.length !== expectedPrimary.length ||
    primaryColumns.some((column, index) => column !== expectedPrimary[index])
  ) {
    throw new Error(`PK divergente na tabela da fence: ${tableName}`);
  }

  if (tableName === "institution_readiness_fences") {
    const hasInstitutionForeignKey = tableKeys.some(
      (key) =>
        key.columnName === "institution_id" &&
        key.referencedTableName === "institutions" &&
        key.referencedColumnName === "id",
    );
    if (!hasInstitutionForeignKey) {
      throw new Error("FK obrigatória ausente em institution_readiness_fences");
    }
  }
}

/** Valida tabela própria só quando ela já existir antes do DDL aditivo. */
export function assertExistingReadinessFenceOwnedTables(
  tables: readonly ExistingTableDefinition[],
  columns: readonly ExistingColumnDefinition[],
  keys: readonly ExistingKeyDefinition[],
): void {
  const tableByName = new Map(
    tables.map((table) => [normalizeIdentifier(table.tableName), table]),
  );
  for (const tableName of READINESS_FENCE_OWNED_TABLES) {
    const table = tableByName.get(tableName);
    if (!table) continue;
    assertInnoDbTable(table, tableName);
    const actualColumns = columnsForTable(columns, tableName);
    const requirements = OWNED_TABLE_COLUMNS[tableName];
    if (actualColumns.size !== requirements.length) {
      throw new Error(`Colunas divergentes na tabela da fence: ${tableName}`);
    }
    for (const requirement of requirements) {
      const column = actualColumns.get(requirement.name);
      if (
        !column ||
        !requirement.type.test(column.columnType) ||
        column.isNullable.toUpperCase() !== requirement.nullable
      ) {
        throw new Error(
          `Coluna divergente na tabela da fence: ${tableName}.${requirement.name}`,
        );
      }
    }
    assertOwnedTableKeys(tableName, keys);
  }
}

function assertNoOwnedTableTriggers(
  triggers: readonly ExistingTriggerDefinition[],
): void {
  const ownedTrigger = triggers.find((trigger) =>
    READINESS_FENCE_OWNED_TABLES.includes(
      normalizeIdentifier(trigger.eventObjectTable) as OwnedTableName,
    ),
  );
  if (ownedTrigger) {
    throw new Error(
      `Tabela própria da fence não pode ter trigger: ${ownedTrigger.eventObjectTable}`,
    );
  }
}

export function assertCompleteReadinessFenceCatalog(
  catalog: ReadinessFenceCatalog,
  expectedTriggers: readonly IdempotentTriggerDefinition[],
): IdempotentTriggerDefinition[] {
  assertReadinessFenceSourceSchema(catalog.tables, catalog.columns);
  assertExistingReadinessFenceOwnedTables(
    catalog.tables,
    catalog.columns,
    catalog.keys,
  );
  assertNoOwnedTableTriggers(catalog.triggers);
  return planIdempotentTriggerInstallation(expectedTriggers, catalog.triggers);
}

function isExactInstallationMarker(
  marker: ExistingInstallationMarker,
): boolean {
  return (
    Number(marker.id) === READINESS_FENCE_INSTALLATION_ID &&
    marker.coverageVersion === READINESS_FENCE_COVERAGE_VERSION &&
    marker.coverageHash === READINESS_FENCE_COVERAGE_HASH
  );
}

export function assertInstallationMarkerAbsentOrExact(
  marker: ExistingInstallationMarker | undefined,
): void {
  if (marker && !isExactInstallationMarker(marker)) {
    throw new Error("READINESS_FENCE_INSTALLATION_MARKER_DIVERGENT");
  }
}

export function requireSingletonInstallationMarker(
  markers: readonly ExistingInstallationMarker[],
): ExistingInstallationMarker | undefined {
  if (markers.length === 0) return undefined;
  if (markers.length !== 1) {
    throw new Error("READINESS_FENCE_INSTALLATION_MARKER_DIVERGENT");
  }
  const [marker] = markers;
  assertInstallationMarkerAbsentOrExact(marker);
  return marker;
}

function catalogHasTable(
  catalog: ReadinessFenceCatalog,
  tableName: OwnedTableName,
): boolean {
  return catalog.tables.some(
    (table) => normalizeIdentifier(table.tableName) === tableName,
  );
}

function assertAllReadinessFenceOwnedTablesPresent(
  catalog: ReadinessFenceCatalog,
): void {
  for (const tableName of READINESS_FENCE_OWNED_TABLES) {
    if (!catalogHasTable(catalog, tableName)) {
      throw new Error(`Tabela própria ausente após instalação: ${tableName}`);
    }
  }
}

export async function readReadinessFenceCatalog(
  connection: Connection,
  additionalCatalogTables: readonly string[] = [],
): Promise<ReadinessFenceCatalog> {
  const normalizedAdditionalCatalogTables =
    additionalCatalogTables.map(normalizeIdentifier);
  const tableNames = [
    ...new Set([
      ...Object.keys(READINESS_FENCE_SOURCE_COLUMNS),
      ...READINESS_FENCE_OWNED_TABLES,
      ...normalizedAdditionalCatalogTables,
    ]),
  ];
  const keyTableNames = [
    ...READINESS_FENCE_OWNED_TABLES,
    ...normalizedAdditionalCatalogTables,
  ];
  const [tableRows] = await connection.query(
    `SELECT TABLE_NAME AS tableName,
            TABLE_TYPE AS tableType,
            ENGINE AS engine
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN (?)`,
    [tableNames],
  );
  const [columnRows] = await connection.query(
    `SELECT TABLE_NAME AS tableName,
            COLUMN_NAME AS columnName,
            COLUMN_TYPE AS columnType,
            IS_NULLABLE AS isNullable,
            COLUMN_KEY AS columnKey
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN (?)`,
    [tableNames],
  );
  const [keyRows] = await connection.query(
    `SELECT TABLE_NAME AS tableName,
            CONSTRAINT_NAME AS constraintName,
            COLUMN_NAME AS columnName,
            ORDINAL_POSITION AS ordinalPosition,
            REFERENCED_TABLE_NAME AS referencedTableName,
            REFERENCED_COLUMN_NAME AS referencedColumnName
     FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN (?)`,
    [keyTableNames],
  );
  const [triggerRows] = await connection.query(
    `SELECT TRIGGER_NAME AS triggerName,
            ACTION_TIMING AS actionTiming,
            EVENT_MANIPULATION AS eventManipulation,
            EVENT_OBJECT_TABLE AS eventObjectTable,
            ACTION_ORIENTATION AS actionOrientation,
            ACTION_STATEMENT AS actionStatement
     FROM INFORMATION_SCHEMA.TRIGGERS
     WHERE TRIGGER_SCHEMA = DATABASE()
       AND EVENT_OBJECT_TABLE IN (?)`,
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
    triggers: Array.isArray(triggerRows)
      ? (triggerRows as ExistingTriggerDefinition[])
      : [],
  };
}

export async function readReadinessFenceInstallationMarkers(
  connection: Connection,
): Promise<ExistingInstallationMarker[]> {
  const [rows] = await connection.query(
    `SELECT id,
            coverage_version AS coverageVersion,
            coverage_hash AS coverageHash
     FROM institution_readiness_fence_installations`,
  );
  return Array.isArray(rows) ? (rows as ExistingInstallationMarker[]) : [];
}

export async function acquireReadinessFenceInstallationLock(
  connection: Connection,
): Promise<void> {
  const [rows] = await connection.query("SELECT GET_LOCK(?, ?) AS acquired", [
    READINESS_FENCE_INSTALLATION_LOCK,
    READINESS_FENCE_INSTALLATION_LOCK_TIMEOUT_SECONDS,
  ]);
  const acquired = Array.isArray(rows)
    ? Number((rows[0] as { acquired?: unknown } | undefined)?.acquired)
    : 0;
  if (acquired !== 1) {
    throw new Error("READINESS_FENCE_INSTALLATION_LOCK_UNAVAILABLE");
  }
}

export async function releaseReadinessFenceInstallationLock(
  connection: Connection,
): Promise<void> {
  await connection.query("SELECT RELEASE_LOCK(?)", [
    READINESS_FENCE_INSTALLATION_LOCK,
  ]);
}

async function createTableStatements(
  connection: Connection,
  statements: readonly string[],
): Promise<void> {
  for (const statement of statements) {
    await connection.query(statement);
  }
}

export async function createMissingReadinessFenceTriggers(
  connection: Connection,
  triggers: readonly IdempotentTriggerDefinition[],
): Promise<void> {
  for (const trigger of triggers) {
    await connection.query(trigger.statement);
  }
}

async function insertInstallationMarker(connection: Connection): Promise<void> {
  await connection.beginTransaction();
  try {
    await connection.query(
      `INSERT INTO institution_readiness_fence_installations
        (id, coverage_version, coverage_hash)
       VALUES (?, ?, ?)`,
      [
        READINESS_FENCE_INSTALLATION_ID,
        READINESS_FENCE_COVERAGE_VERSION,
        READINESS_FENCE_COVERAGE_HASH,
      ],
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }
}

/**
 * Só execute após autorização explícita para um ambiente nomeado. A execução
 * de DDL é inevitavelmente não-atômica no MySQL; por isso o marcador é escrito
 * apenas depois do pós-voo completo e o runtime o exige antes de usar a fence.
 */
export async function applyReadinessFenceMigration(): Promise<void> {
  const migrationSql = readFileSync(
    fileURLToPath(READINESS_FENCE_MIGRATION_URL),
    "utf8",
  );
  const { executableSql, triggers } =
    extractIdempotentTriggerStatements(migrationSql);
  if (triggers.length === 0) {
    throw new Error("Nenhum trigger de fence foi encontrado na migration");
  }
  assertCoverageHash(triggers);
  const tableStatements = extractReadinessFenceTableStatements(executableSql);

  const connection = await mysql.createConnection(
    buildReadinessFenceConnectionOptions(),
  );
  let lockAcquired = false;
  try {
    await acquireReadinessFenceInstallationLock(connection);
    lockAcquired = true;

    const preflight = await readReadinessFenceCatalog(connection);
    const missingTriggers = assertCompleteReadinessFenceCatalog(
      preflight,
      triggers,
    );
    const preflightMarker = catalogHasTable(
      preflight,
      "institution_readiness_fence_installations",
    )
      ? requireSingletonInstallationMarker(
          await readReadinessFenceInstallationMarkers(connection),
        )
      : undefined;

    if (preflightMarker) {
      assertAllReadinessFenceOwnedTablesPresent(preflight);
      if (missingTriggers.length > 0) {
        throw new Error("READINESS_FENCE_INSTALLATION_MARKER_DRIFT");
      }
      console.log("Migration da fence de prontidão já está íntegra");
      return;
    }

    await createTableStatements(connection, tableStatements);
    await createMissingReadinessFenceTriggers(connection, missingTriggers);

    const postflight = await readReadinessFenceCatalog(connection);
    assertAllReadinessFenceOwnedTablesPresent(postflight);
    const remainingTriggers = assertCompleteReadinessFenceCatalog(
      postflight,
      triggers,
    );
    if (remainingTriggers.length > 0) {
      throw new Error("READINESS_FENCE_POSTFLIGHT_INCOMPLETE");
    }
    const postflightMarker = requireSingletonInstallationMarker(
      await readReadinessFenceInstallationMarkers(connection),
    );
    if (postflightMarker) {
      throw new Error("READINESS_FENCE_INSTALLATION_MARKER_RACE");
    }

    // Sem ON DUPLICATE/overwrite: uma escrita externa concorrente deve falhar
    // e preservar o estado para inspeção, jamais reclassificá-lo silenciosamente.
    await insertInstallationMarker(connection);
    console.log("Migration da fence de prontidão aplicada");
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
  applyReadinessFenceMigration().catch((error) => {
    console.error(
      "Falha ao aplicar migration da fence de prontidão:",
      error instanceof Error ? error.message : "erro desconhecido",
    );
    process.exitCode = 1;
  });
}
