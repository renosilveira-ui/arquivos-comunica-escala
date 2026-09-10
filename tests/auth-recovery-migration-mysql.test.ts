import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import mysql, {
  type Connection,
  type RowDataPacket,
} from "mysql2/promise";

const SERVER_URL = process.env.AUTH_RECOVERY_MIGRATION_TEST_SERVER_URL;
const DISPOSABLE_MARKER = process.env.AUTH_RECOVERY_MIGRATION_TEST_MARKER;
const DATABASE_PREFIX = "escalas_test_auth_recovery_";

function parseLocalServer(raw: string | undefined) {
  if (!raw) {
    throw new Error(
      "AUTH_RECOVERY_MIGRATION_TEST_SERVER_URL é obrigatória; a prova não pode ser pulada.",
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
      "AUTH_RECOVERY_MIGRATION_TEST_SERVER_URL deve apontar somente para um MySQL local e o schema mysql.",
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
      "AUTH_RECOVERY_MIGRATION_TEST_MARKER deve ser um marker opaco explícito de 32-128 caracteres.",
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
    "../drizzle/migrations/manual/2026-09-10-auth-recovery-requests.sql",
    import.meta.url,
  ),
  "utf8",
);
const server = parseLocalServer(SERVER_URL);
const marker = requireMarker(DISPOSABLE_MARKER);

describe("migration de recuperação de credenciais em MySQL isolado", () => {
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
        CONSTRAINT chk_disposable_test_target_singleton CHECK (id = 1)
      ) ENGINE=InnoDB;
    `);
    await database.execute(
      "INSERT INTO __escalas_disposable_test_target_v1 (id, database_name, marker_hash) VALUES (1, ?, ?)",
      [databaseName, markerHash],
    );
  }

  async function createPrerequisites() {
    await database.query(`
      CREATE TABLE users (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB;
      CREATE TABLE institutions (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB;
      CREATE TABLE professional_institutions (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB;
      INSERT INTO users (id) VALUES (1);
      INSERT INTO institutions (id) VALUES (1);
      INSERT INTO professional_institutions (id) VALUES (1);
    `);
  }

  beforeAll(async () => {
    admin = await mysql.createConnection({ ...server, database: "mysql" });
    const [rows] = await admin.query<RowDataPacket[]>(
      "SELECT VERSION() AS version",
    );
    expect(String(rows[0]?.version)).toMatch(/^8\.0\.45(?:\D|$)/);
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
    await createPrerequisites();
  });

  afterEach(async () => {
    await database?.end();
  });

  afterAll(async () => {
    await admin?.end();
  });

  it("aplica, valida shapes e reroda sem duplicar o contrato", async () => {
    await database.query(migration);
    await database.query(migration);

    const [checks] = await database.query<RowDataPacket[]>(`
      SELECT CONSTRAINT_NAME
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'auth_recovery_requests'
        AND CONSTRAINT_TYPE = 'CHECK'
      ORDER BY CONSTRAINT_NAME
    `);
    expect(checks.map((row) => row.CONSTRAINT_NAME)).toEqual([
      "chk_auth_recovery_active_binding",
      "chk_auth_recovery_active_slot",
      "chk_auth_recovery_actor_binding",
      "chk_auth_recovery_attempts",
      "chk_auth_recovery_deadline",
      "chk_auth_recovery_hashes",
      "chk_auth_recovery_state_payload",
    ]);

    await database.query(`
      INSERT INTO auth_recovery_requests (
        kind, request_actor_kind, target_user_id, token_hash, sealed_payload,
        available_at, delivery_deadline_at
      ) VALUES (
        'SELF_SERVICE', 'UNAUTHENTICATED', 1, REPEAT('a', 64), 'sealed',
        NOW(), DATE_ADD(NOW(), INTERVAL 1 HOUR)
      )
    `);
    await expect(
      database.query(`
        INSERT INTO auth_recovery_requests (
          kind, request_actor_kind, target_user_id, token_hash, sealed_payload,
          available_at, delivery_deadline_at, attempt_count
        ) VALUES (
          'SELF_SERVICE', 'UNAUTHENTICATED', 1, REPEAT('b', 64), 'sealed',
          NOW(), DATE_ADD(NOW(), INTERVAL 1 HOUR), 6
        )
      `),
    ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
  });

  it("recusa drift semântico de CHECK e o preserva para diagnóstico", async () => {
    await database.query(migration);
    await database.query(`
      ALTER TABLE auth_recovery_requests
        DROP CHECK chk_auth_recovery_attempts,
        ADD CONSTRAINT chk_auth_recovery_attempts CHECK (
          attempt_count >= 0 AND attempt_count <= 4
        )
    `);

    await expect(database.query(migration)).rejects.toThrow();
    const [checks] = await database.query<RowDataPacket[]>(`
      SELECT CHECK_CLAUSE
      FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE()
        AND CONSTRAINT_NAME = 'chk_auth_recovery_attempts'
    `);
    expect(String(checks[0]?.CHECK_CLAUSE)).toContain("<= 4");
  });

  it("recusa objeto homônimo incompatível antes de qualquer reparo", async () => {
    await database.query(`
      CREATE TABLE auth_recovery_requests (
        id INT NOT NULL PRIMARY KEY,
        sentinel VARCHAR(32) NOT NULL
      ) ENGINE=InnoDB;
      INSERT INTO auth_recovery_requests (id, sentinel) VALUES (1, 'PRESERVE_ME');
    `);

    await expect(database.query(migration)).rejects.toThrow();
    const [rows] = await database.query<RowDataPacket[]>(
      "SELECT id, sentinel FROM auth_recovery_requests",
    );
    expect(rows).toEqual([{ id: 1, sentinel: "PRESERVE_ME" }]);
  });
});
