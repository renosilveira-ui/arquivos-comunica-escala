import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
const minimalFoundationParentsSql = [
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

const isEnabled =
  process.env.OPERATIONAL_EVENTS_MIGRATION_MYSQL_TEST === "1";
const describeDisposableMySql = isEnabled ? describe : describe.skip;
const temporaryDatabasePattern =
  /^escala_events_contract_test_[a-f0-9]{12}$/;

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

describeDisposableMySql(
  "migration de eventos operacionais em MySQL descartável",
  () => {
    let adminConnection: Awaited<ReturnType<typeof mysql.createConnection>>;
    let connectionOptions: LocalMySqlConnectionOptions;
    let negativeDatabaseName = "";
    let negativeDatabaseCreated = false;
    let positiveDatabaseName = "";
    let positiveDatabaseCreated = false;

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
    });

    afterAll(async () => {
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
        const groupConcatMaxLen = Number(
          beforeRows[0]?.group_concat_max_len,
        );

        await connection.query(migration);
        await connection.query(migration);

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
