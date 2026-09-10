import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";

const SERVER_URL =
  process.env.SCHEDULE_INVITE_HASH_V2_MIGRATION_TEST_SERVER_URL;
const DISPOSABLE_MARKER = process.env.SCHEDULE_INVITE_MIGRATION_TEST_MARKER;
const DATABASE_PREFIX = "escalas_test_invite_hash_";

function parseLocalServer(raw: string | undefined) {
  if (!raw) {
    throw new Error(
      "SCHEDULE_INVITE_HASH_V2_MIGRATION_TEST_SERVER_URL é obrigatória; a prova não pode ser pulada.",
    );
  }
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

function requireMarker(raw: string | undefined): string {
  if (
    !raw ||
    raw.length < 32 ||
    raw.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(raw)
  ) {
    throw new Error(
      "SCHEDULE_INVITE_MIGRATION_TEST_MARKER deve ser um marker opaco explícito de 32-128 caracteres.",
    );
  }
  return raw;
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
const marker = requireMarker(DISPOSABLE_MARKER);

describe("migration da versão de hash do convite em MySQL isolado", () => {
  let admin: Connection;
  let database: Connection;
  let databaseName = "";

  async function installAndVerifyMarker() {
    const markerHash = createHash("sha256")
      .update(
        [
          "escalas-disposable-test-target-v1",
          server.host === "localhost" ? "127.0.0.1" : server.host,
          String(server.port),
          databaseName,
          marker,
        ].join("\0"),
      )
      .digest("hex");
    await database.query(`
      CREATE TABLE __escalas_disposable_test_target_v1 (
        id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
        database_name VARCHAR(64) NOT NULL,
        marker_hash CHAR(64) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT chk_disposable_test_target_singleton CHECK (id = 1)
      ) ENGINE=InnoDB;
    `);
    await database.execute(
      "INSERT INTO __escalas_disposable_test_target_v1 (id, database_name, marker_hash) VALUES (1, ?, ?)",
      [databaseName, markerHash],
    );
    const [rows] = await database.query<RowDataPacket[]>(
      "SELECT DATABASE() AS connected_database, database_name, marker_hash FROM __escalas_disposable_test_target_v1 WHERE id = 1 LIMIT 2",
    );
    expect(rows).toEqual([
      {
        connected_database: databaseName,
        database_name: databaseName,
        marker_hash: markerHash,
      },
    ]);
  }

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
    admin = await mysql.createConnection({ ...server, database: "mysql" });
    const [version] = await admin.query<RowDataPacket[]>(
      "SELECT VERSION() AS version",
    );
    if (!/^8\./.test(String(version[0]?.version))) {
      throw new Error("A prova exige o serviço MySQL 8 efêmero.");
    }
  });

  beforeEach(async () => {
    databaseName = `${DATABASE_PREFIX}${process.pid}_${randomBytes(6).toString("hex")}`;
    await admin.query(
      `CREATE DATABASE ${quoteIdentifier(databaseName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
    database = await mysql.createConnection({
      ...server,
      database: databaseName,
      multipleStatements: true,
    });
    await installAndVerifyMarker();
  });

  afterEach(async () => {
    await database?.end();
  });

  afterAll(async () => {
    await admin?.end();
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

    await database.query(
      "INSERT INTO schedule_invites (code_hash) VALUES (REPEAT('b', 64))",
    );
    const [newRows] = await database.query<RowDataPacket[]>(`
      SELECT code_hash_version
      FROM schedule_invites
      WHERE code_hash = REPEAT('b', 64)
    `);
    expect(newRows).toEqual([{ code_hash_version: "HMAC_SHA256_V2" }]);

    const [column] = await database.query<RowDataPacket[]>(`
      SELECT COLUMN_DEFAULT
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'schedule_invites'
        AND COLUMN_NAME = 'code_hash_version'
    `);
    expect(column).toEqual([{ COLUMN_DEFAULT: "HMAC_SHA256_V2" }]);
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
