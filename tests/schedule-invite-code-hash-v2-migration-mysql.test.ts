import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";

const SERVER_URL =
  process.env.SCHEDULE_INVITE_HASH_V2_MIGRATION_TEST_SERVER_URL;
const DATABASE_PREFIX = "escala_sichv2_validation_";

function parseLocalServer(raw: string | undefined) {
  if (!raw) return null;
  const url = new URL(raw);
  if (
    url.protocol !== "mysql:" ||
    !new Set(["127.0.0.1", "localhost", "::1"]).has(
      url.hostname.toLowerCase(),
    ) ||
    url.pathname !== "/mysql" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "SCHEDULE_INVITE_HASH_V2_MIGRATION_TEST_SERVER_URL deve apontar somente para um MySQL local e o schema mysql.",
    );
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) {
    throw new Error("Identificador SQL de teste inválido");
  }
  return `\`${value}\``;
}

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-10-schedule-invite-code-hash-v2.sql",
    import.meta.url,
  ),
  "utf8",
);
const server = parseLocalServer(SERVER_URL);
const describeMysql = server ? describe : describe.skip;

describeMysql("migration da versão de hash do convite em MySQL isolado", () => {
  let admin: Connection;
  let database: Connection;
  const databaseName = `${DATABASE_PREFIX}${process.pid}`;

  async function createLegacyTable() {
    await database.query(`
      CREATE TABLE schedule_invites (
        id INT NOT NULL AUTO_INCREMENT,
        code_hash VARCHAR(64) NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uniq_schedule_invite_code_hash (code_hash)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
      INSERT INTO schedule_invites (code_hash)
      VALUES (REPEAT('a', 64));
    `);
  }

  beforeAll(async () => {
    if (!server) throw new Error("Servidor MySQL local ausente");
    admin = await mysql.createConnection({ ...server, database: "mysql" });
    await admin.query(
      `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(databaseName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    database = await mysql.createConnection({
      ...server,
      database: databaseName,
      multipleStatements: true,
    });
  });

  beforeEach(async () => {
    await database.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await database.query(
      `CREATE DATABASE ${quoteIdentifier(databaseName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    await database.changeUser({ database: databaseName });
  });

  afterAll(async () => {
    await database?.end();
    if (admin) {
      await admin.query(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`,
      );
      await admin.end();
    }
  });

  it("marca linhas existentes como V1, preserva hash e reroda", async () => {
    await createLegacyTable();
    await database.query(migration);
    await database.query(migration);

    const [rows] = await database.query<RowDataPacket[]>(`
      SELECT code_hash, code_hash_version
      FROM schedule_invites
    `);
    expect(rows).toEqual([
      {
        code_hash: "a".repeat(64),
        code_hash_version: "SHA256_V1",
      },
    ]);
  });

  it("recusa coluna preexistente incompatível antes de alterá-la", async () => {
    await createLegacyTable();
    await database.query(`
      ALTER TABLE schedule_invites
      ADD COLUMN code_hash_version VARCHAR(32) NULL AFTER code_hash
    `);
    await expect(database.query(migration)).rejects.toThrow();

    const [columns] = await database.query<RowDataPacket[]>(`
      SELECT COLUMN_TYPE, IS_NULLABLE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'schedule_invites'
        AND COLUMN_NAME = 'code_hash_version'
    `);
    expect(columns).toEqual([
      { COLUMN_TYPE: "varchar(32)", IS_NULLABLE: "YES" },
    ]);
  });

  it("recusa tabela sem UNIQUE canônica do hash", async () => {
    await database.query(`
      CREATE TABLE schedule_invites (
        id INT NOT NULL AUTO_INCREMENT,
        code_hash VARCHAR(64) NOT NULL,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
    `);
    await expect(database.query(migration)).rejects.toThrow();
  });
});
