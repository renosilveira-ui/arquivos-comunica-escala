import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/mysql-core";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  notificationDeliveries,
  operationalEmailVerificationTokens,
  operationalEventRecipients,
  operationalEventRelatedContexts,
  operationalEvents,
  userOperationalEmailTrust,
} from "../drizzle/schema";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-01-operational-events-foundation.sql",
    import.meta.url,
  ),
  "utf8",
);

const foundationTables = [
  "notification_deliveries",
  "operational_email_verification_tokens",
  "operational_event_recipients",
  "operational_event_related_contexts",
  "operational_events",
  "user_operational_email_trust",
] as const;
const foundationTableSqlList = foundationTables
  .map((tableName) => "'" + tableName + "'")
  .join(", ");
const foundationSchemaTables = [
  { tableName: "operational_events", table: operationalEvents },
  {
    tableName: "operational_event_related_contexts",
    table: operationalEventRelatedContexts,
  },
  {
    tableName: "operational_event_recipients",
    table: operationalEventRecipients,
  },
  { tableName: "notification_deliveries", table: notificationDeliveries },
  {
    tableName: "user_operational_email_trust",
    table: userOperationalEmailTrust,
  },
  {
    tableName: "operational_email_verification_tokens",
    table: operationalEmailVerificationTokens,
  },
] as const;
const requiredParentUniqueKeys = [
  {
    tableName: "shift_instances",
    indexName: "uniq_shift_instances_topology_id",
    columns: ["institution_id", "hospital_id", "sector_id", "id"],
  },
  {
    tableName: "shift_assignments_v2",
    indexName: "uniq_shift_assignments_topology_id",
    columns: ["institution_id", "hospital_id", "sector_id", "id"],
  },
  {
    tableName: "schedule_invites",
    indexName: "uniq_schedule_invites_id_institution",
    columns: ["id", "institution_id"],
  },
] as const;
const minimalFoundationParentsSql =
  [
    "CREATE TABLE institutions (id INT NOT NULL, PRIMARY KEY (id)) ENGINE=InnoDB",
    "CREATE TABLE users (id INT NOT NULL, PRIMARY KEY (id)) ENGINE=InnoDB",
    "CREATE TABLE professionals (id INT NOT NULL, PRIMARY KEY (id)) ENGINE=InnoDB",
    "CREATE TABLE hospitals (id INT NOT NULL, institution_id INT NOT NULL, PRIMARY KEY (id)) ENGINE=InnoDB",
    "CREATE TABLE sectors (id INT NOT NULL, institution_id INT NOT NULL, hospital_id INT NOT NULL, PRIMARY KEY (id)) ENGINE=InnoDB",
    "CREATE TABLE schedule_contexts (id INT NOT NULL, institution_id INT NOT NULL, hospital_id INT NOT NULL, sector_id INT NOT NULL, PRIMARY KEY (id)) ENGINE=InnoDB",
    "CREATE TABLE shift_instances (id INT NOT NULL, institution_id INT NOT NULL, hospital_id INT NOT NULL, sector_id INT NOT NULL, PRIMARY KEY (id)) ENGINE=InnoDB",
    "CREATE TABLE shift_assignments_v2 (id INT NOT NULL, institution_id INT NOT NULL, hospital_id INT NOT NULL, sector_id INT NOT NULL, PRIMARY KEY (id)) ENGINE=InnoDB",
    "CREATE TABLE schedule_invites (id INT NOT NULL, institution_id INT NOT NULL, PRIMARY KEY (id)) ENGINE=InnoDB",
    "CREATE TABLE professional_institutions (user_id INT NOT NULL, institution_id INT NOT NULL) ENGINE=InnoDB",
  ].join(";\n") + ";";

const isEnabled = process.env.OPERATIONAL_EVENTS_MIGRATION_MYSQL_TEST === "1";
const describeDisposableMySql = isEnabled ? describe : describe.skip;
const temporaryDatabasePattern = /^escala_events_contract_test_[a-f0-9]{12}$/;
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const drizzleKitPath = resolve(
  repositoryRoot,
  "node_modules/drizzle-kit/bin.cjs",
);

type LocalMySqlConnectionOptions = {
  host: string;
  port: number;
  user: string;
  password: string;
};

type TableRow = RowDataPacket & {
  TABLE_NAME: string;
};

type ColumnRow = RowDataPacket & {
  COLUMN_NAME: string;
};

type SessionValueRow = RowDataPacket & {
  group_concat_max_len: number | string;
};

type ForeignKeyRow = RowDataPacket & {
  TABLE_NAME: string;
  CONSTRAINT_NAME: string;
  ORDINAL_POSITION: number | string;
  COLUMN_NAME: string;
  REFERENCED_TABLE_NAME: string;
  REFERENCED_COLUMN_NAME: string;
  UPDATE_RULE: string;
  DELETE_RULE: string;
};

type IndexRow = RowDataPacket & {
  TABLE_NAME: string;
  INDEX_NAME: string;
  NON_UNIQUE: number | string;
  SEQ_IN_INDEX: number | string;
  COLUMN_NAME: string;
};

type PhysicalForeignKey = {
  tableName: string;
  constraintName: string;
  columns: string[];
  referencedTableName: string;
  referencedColumns: string[];
  updateRule: string;
  deleteRule: string;
};

function localMySqlConnectionOptions(): LocalMySqlConnectionOptions {
  const rawUrl = process.env.OPERATIONAL_EVENTS_MIGRATION_MYSQL_URL?.trim();
  if (!rawUrl) {
    throw new Error(
      "OPERATIONAL_EVENTS_MIGRATION_MYSQL_URL é obrigatória para a prova MySQL descartável",
    );
  }

  const url = new URL(rawUrl);
  if (
    url.protocol !== "mysql:" ||
    url.hostname !== "127.0.0.1" ||
    (url.port && url.port !== "3306") ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "A prova MySQL aceita somente mysql://127.0.0.1:3306 sem query ou fragmento",
    );
  }

  return {
    host: url.hostname,
    port: 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

function quoteTemporaryDatabaseName(name: string): string {
  if (!temporaryDatabasePattern.test(name)) {
    throw new Error("Nome de banco descartável fora do contrato");
  }

  const quote = String.fromCharCode(96);
  return quote + name + quote;
}

function databaseUrlFor(
  options: LocalMySqlConnectionOptions,
  databaseName: string,
): string {
  return (
    "mysql://" +
    encodeURIComponent(options.user) +
    ":" +
    encodeURIComponent(options.password) +
    "@" +
    options.host +
    ":" +
    options.port +
    "/" +
    databaseName
  );
}

function runFreshSchemaPush(
  options: LocalMySqlConnectionOptions,
  databaseName: string,
) {
  const result = spawnSync(
    process.execPath,
    [drizzleKitPath, "push", "--force"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: databaseUrlFor(options, databaseName),
        DATABASE_SSL: "false",
        NODE_ENV: "test",
      },
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 || result.signal) {
    throw new Error(
      "drizzle-kit push falhou no schema descartável de eventos operacionais",
    );
  }
}

function expectedPhysicalForeignKeys(): PhysicalForeignKey[] {
  return foundationSchemaTables.flatMap(({ tableName, table }) =>
    getTableConfig(table).foreignKeys.map((foreignKey) => {
      const reference = foreignKey.reference();
      return {
        tableName,
        constraintName: foreignKey.getName(),
        columns: reference.columns.map(({ name }) => name),
        referencedTableName: getTableName(reference.foreignTable),
        referencedColumns: reference.foreignColumns.map(({ name }) => name),
        updateRule: (foreignKey.onUpdate ?? "no action").toUpperCase(),
        deleteRule: (foreignKey.onDelete ?? "no action").toUpperCase(),
      };
    }),
  );
}

async function expectPhysicalFoundationForeignKeys(
  connection: Awaited<ReturnType<typeof mysql.createConnection>>,
) {
  const [rows] = await connection.query<ForeignKeyRow[]>(
    "SELECT key_columns.TABLE_NAME, key_columns.CONSTRAINT_NAME, key_columns.ORDINAL_POSITION, key_columns.COLUMN_NAME, key_columns.REFERENCED_TABLE_NAME, key_columns.REFERENCED_COLUMN_NAME, referential_constraints.UPDATE_RULE, referential_constraints.DELETE_RULE FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS key_columns INNER JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS AS referential_constraints ON referential_constraints.CONSTRAINT_SCHEMA = key_columns.CONSTRAINT_SCHEMA AND referential_constraints.TABLE_NAME = key_columns.TABLE_NAME AND referential_constraints.CONSTRAINT_NAME = key_columns.CONSTRAINT_NAME WHERE key_columns.CONSTRAINT_SCHEMA = DATABASE() AND key_columns.TABLE_NAME IN (" +
      foundationTableSqlList +
      ") AND key_columns.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY key_columns.TABLE_NAME, key_columns.CONSTRAINT_NAME, key_columns.ORDINAL_POSITION",
  );

  const actual = new Map<string, PhysicalForeignKey>();
  for (const row of rows) {
    const key = row.TABLE_NAME + ":" + row.CONSTRAINT_NAME;
    const current = actual.get(key);
    if (current) {
      current.columns.push(row.COLUMN_NAME);
      current.referencedColumns.push(row.REFERENCED_COLUMN_NAME);
      continue;
    }
    actual.set(key, {
      tableName: row.TABLE_NAME,
      constraintName: row.CONSTRAINT_NAME,
      columns: [row.COLUMN_NAME],
      referencedTableName: row.REFERENCED_TABLE_NAME,
      referencedColumns: [row.REFERENCED_COLUMN_NAME],
      updateRule: row.UPDATE_RULE,
      deleteRule: row.DELETE_RULE,
    });
  }

  const expected = expectedPhysicalForeignKeys();
  expect(expected).toHaveLength(36);
  const expectedByKey = new Map(
    expected.map((foreignKey) => [
      foreignKey.tableName + ":" + foreignKey.constraintName,
      foreignKey,
    ]),
  );
  expect([...actual.keys()].sort()).toEqual([...expectedByKey.keys()].sort());
  for (const [key, expectedForeignKey] of expectedByKey) {
    expect(actual.get(key)).toEqual(expectedForeignKey);
  }
}

async function expectPhysicalParentUniqueKeys(
  connection: Awaited<ReturnType<typeof mysql.createConnection>>,
) {
  const [rows] = await connection.query<IndexRow[]>(
    "SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME IN ('uniq_shift_instances_topology_id', 'uniq_shift_assignments_topology_id', 'uniq_schedule_invites_id_institution') ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX",
  );

  for (const expectedKey of requiredParentUniqueKeys) {
    const matchingRows = rows.filter(
      (row) =>
        row.TABLE_NAME === expectedKey.tableName &&
        row.INDEX_NAME === expectedKey.indexName,
    );
    expect(matchingRows.map(({ COLUMN_NAME }) => COLUMN_NAME)).toEqual(
      expectedKey.columns,
    );
    expect(
      matchingRows.every(({ NON_UNIQUE }) => Number(NON_UNIQUE) === 0),
    ).toBe(true);
    expect(
      matchingRows.map(({ SEQ_IN_INDEX }) => Number(SEQ_IN_INDEX)),
    ).toEqual(expectedKey.columns.map((_, index) => index + 1));
  }
}

describeDisposableMySql(
  "migration de eventos operacionais em MySQL descartável",
  () => {
    let adminConnection: Awaited<ReturnType<typeof mysql.createConnection>>;
    let connectionOptions: LocalMySqlConnectionOptions;
    let negativeDatabaseName = "";
    let negativeDatabaseCreated = false;
    let positiveDatabaseName = "";
    let positiveDatabaseCreated = false;
    let freshSchemaDatabaseName = "";
    let freshSchemaDatabaseCreated = false;

    beforeAll(async () => {
      connectionOptions = localMySqlConnectionOptions();
      negativeDatabaseName =
        "escala_events_contract_test_" + randomBytes(6).toString("hex");
      adminConnection = await mysql.createConnection(connectionOptions);
      await adminConnection.query(
        "CREATE DATABASE " + quoteTemporaryDatabaseName(negativeDatabaseName),
      );
      negativeDatabaseCreated = true;
      positiveDatabaseName =
        "escala_events_contract_test_" + randomBytes(6).toString("hex");
      await adminConnection.query(
        "CREATE DATABASE " + quoteTemporaryDatabaseName(positiveDatabaseName),
      );
      positiveDatabaseCreated = true;
      freshSchemaDatabaseName =
        "escala_events_contract_test_" + randomBytes(6).toString("hex");
      await adminConnection.query(
        "CREATE DATABASE " +
          quoteTemporaryDatabaseName(freshSchemaDatabaseName),
      );
      freshSchemaDatabaseCreated = true;
    });

    afterAll(async () => {
      if (
        freshSchemaDatabaseCreated &&
        freshSchemaDatabaseName &&
        adminConnection
      ) {
        await adminConnection.query(
          "DROP DATABASE " +
            quoteTemporaryDatabaseName(freshSchemaDatabaseName),
        );
      }
      if (positiveDatabaseCreated && positiveDatabaseName && adminConnection) {
        await adminConnection.query(
          "DROP DATABASE " + quoteTemporaryDatabaseName(positiveDatabaseName),
        );
      }
      if (negativeDatabaseCreated && negativeDatabaseName && adminConnection) {
        await adminConnection.query(
          "DROP DATABASE " + quoteTemporaryDatabaseName(negativeDatabaseName),
        );
      }
      await adminConnection?.end();
    });

    it("cria o schema novo com as 36 FKs e chaves-pai antes de reaplicar a migration", async () => {
      runFreshSchemaPush(connectionOptions, freshSchemaDatabaseName);
      const connection = await mysql.createConnection({
        ...connectionOptions,
        database: freshSchemaDatabaseName,
        multipleStatements: true,
      });

      try {
        await expectPhysicalParentUniqueKeys(connection);
        await expectPhysicalFoundationForeignKeys(connection);

        await connection.query(migration);
        await connection.query(migration);

        await expectPhysicalParentUniqueKeys(connection);
        await expectPhysicalFoundationForeignKeys(connection);
      } finally {
        await connection.end();
      }
    }, 120_000);

    it("rejeita tabela parcial sem mascará-la nem criar as demais tabelas", async () => {
      const connection = await mysql.createConnection({
        ...connectionOptions,
        database: negativeDatabaseName,
        multipleStatements: true,
      });

      try {
        await connection.query(
          "CREATE TABLE operational_events (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB",
        );

        let rejection: unknown;
        try {
          await connection.query(migration);
        } catch (error) {
          rejection = error;
        }

        expect(rejection).toBeDefined();
        expect(String(rejection)).toContain(
          "__operational_events_contract_preflight_rejected__",
        );

        const [columns] = await connection.query<ColumnRow[]>(
          "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'operational_events' ORDER BY ORDINAL_POSITION",
        );
        expect(columns.map(({ COLUMN_NAME }) => COLUMN_NAME)).toEqual(["id"]);

        const [tables] = await connection.query<TableRow[]>(
          "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (" +
            foundationTableSqlList +
            ") ORDER BY TABLE_NAME",
        );
        expect(tables.map(({ TABLE_NAME }) => TABLE_NAME)).toEqual([
          "operational_events",
        ]);
      } finally {
        await connection.end();
      }
    });

    it("reaplica na mesma conexão após limpar a tabela temporária, mas rejeita uma inesperada", async () => {
      const connection = await mysql.createConnection({
        ...connectionOptions,
        database: positiveDatabaseName,
        multipleStatements: true,
      });

      try {
        await connection.query(minimalFoundationParentsSql);
        const [beforeRows] = await connection.query<SessionValueRow[]>(
          "SELECT @@SESSION.group_concat_max_len AS group_concat_max_len",
        );
        const groupConcatMaxLen = Number(beforeRows[0]?.group_concat_max_len);

        await connection.query(migration);
        await expectPhysicalParentUniqueKeys(connection);
        await expectPhysicalFoundationForeignKeys(connection);

        await connection.query(migration);
        await expectPhysicalParentUniqueKeys(connection);
        await expectPhysicalFoundationForeignKeys(connection);

        const [afterRows] = await connection.query<SessionValueRow[]>(
          "SELECT @@SESSION.group_concat_max_len AS group_concat_max_len",
        );
        expect(Number(afterRows[0]?.group_concat_max_len)).toBe(
          groupConcatMaxLen,
        );

        const [tables] = await connection.query<TableRow[]>(
          "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (" +
            foundationTableSqlList +
            ") ORDER BY TABLE_NAME",
        );
        expect(tables.map(({ TABLE_NAME }) => TABLE_NAME)).toEqual([
          ...foundationTables,
        ]);

        await connection.query(
          "CREATE TEMPORARY TABLE _operational_events_contract_expected (id INT NOT NULL PRIMARY KEY) ENGINE=MEMORY",
        );

        let rejection: unknown;
        try {
          await connection.query(migration);
        } catch (error) {
          rejection = error;
        }
        expect(rejection).toBeDefined();
        expect(String(rejection)).toContain(
          "_operational_events_contract_expected",
        );
      } finally {
        await connection.end();
      }
    });
  },
);
