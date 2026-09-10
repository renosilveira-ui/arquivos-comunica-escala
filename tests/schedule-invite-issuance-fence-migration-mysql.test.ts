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
import mysql, {
  type Connection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";

const SERVER_URL = process.env.SCHEDULE_INVITE_FENCE_MIGRATION_TEST_SERVER_URL;
const DISPOSABLE_MARKER = process.env.SCHEDULE_INVITE_MIGRATION_TEST_MARKER;
const DATABASE_PREFIX = "escalas_test_invite_fence_";

function parseLocalServer(raw: string | undefined) {
  if (!raw) {
    throw new Error(
      "SCHEDULE_INVITE_FENCE_MIGRATION_TEST_SERVER_URL é obrigatória; a prova não pode ser pulada.",
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
      "SCHEDULE_INVITE_FENCE_MIGRATION_TEST_SERVER_URL deve apontar somente para um MySQL local e o schema mysql.",
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
    "../drizzle/migrations/manual/2026-09-10-schedule-invite-issuance-fences.sql",
    import.meta.url,
  ),
  "utf8",
);
const server = parseLocalServer(SERVER_URL);
const marker = requireMarker(DISPOSABLE_MARKER);

describe("migration da fence de emissão em MySQL isolado", () => {
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

  async function createPrerequisites() {
    await database.query(`
      CREATE TABLE users (
        id INT NOT NULL,
        email VARCHAR(320) NULL,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB;
      CREATE TABLE institutions (
        id INT NOT NULL,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB;
      CREATE TABLE hospitals (
        id INT NOT NULL,
        institution_id INT NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uniq_hospitals_topology_id (institution_id, id)
      ) ENGINE=InnoDB;
      CREATE TABLE sectors (
        id INT NOT NULL,
        institution_id INT NOT NULL,
        hospital_id INT NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uniq_sectors_topology_id (institution_id, hospital_id, id)
      ) ENGINE=InnoDB;
      CREATE TABLE schedule_invites (
        id INT NOT NULL AUTO_INCREMENT,
        institution_id INT NOT NULL,
        hospital_id INT NOT NULL,
        sector_id INT NOT NULL,
        invited_user_id INT NULL,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB;
      INSERT INTO users (id, email) VALUES
        (10, 'target-10@example.test'),
        (11, 'target-11@example.test');
      INSERT INTO institutions (id) VALUES (1);
      INSERT INTO hospitals (id, institution_id) VALUES (2, 1);
      INSERT INTO sectors (id, institution_id, hospital_id) VALUES (3, 1, 2);
    `);
  }

  beforeAll(async () => {
    admin = await mysql.createConnection({ ...server, database: "mysql" });
    const [version] = await admin.query<RowDataPacket[]>(
      "SELECT VERSION() AS version",
    );
    if (!/^8\.0\.45(?:\D|$)/.test(String(version[0]?.version))) {
      throw new Error(
        "A prova exige a serialização de catálogo comprovada no MySQL 8.0.45.",
      );
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
    await createPrerequisites();
  });

  afterEach(async () => {
    await database?.end();
  });

  afterAll(async () => {
    await admin?.end();
  });

  it("aceita todos os estados válidos, recusa shapes impossíveis e reroda preservando linhas", async () => {
    await database.query(migration);
    await database.query(`
      INSERT INTO schedule_invite_issuance_fences
        (institution_id, hospital_id, sector_id, invited_user_id)
      VALUES (1, 2, 3, 10);
      UPDATE schedule_invite_issuance_fences
      SET generation = 1,
          state = 'PREPARING',
          lease_token = REPEAT('a', 64),
          attempt_expires_at = DATE_ADD(NOW(), INTERVAL 1 DAY),
          code_nonce = REPEAT('b', 64),
          code_pepper_key_id = REPEAT('c', 64),
          recipient_binding_hash = REPEAT('d', 64),
          provider_idempotency_key = REPEAT('e', 64),
          provider_request_fingerprint = REPEAT('f', 64),
          attempt_count = 1,
          lease_expires_at = DATE_ADD(NOW(), INTERVAL 1 MINUTE)
      WHERE invited_user_id = 10;
      UPDATE schedule_invite_issuance_fences
      SET state = 'PROVIDER_UNKNOWN', failure_code = 'TIMEOUT'
      WHERE invited_user_id = 10;
      UPDATE schedule_invite_issuance_fences
      SET state = 'PREPARING', failure_code = NULL
      WHERE invited_user_id = 10;
      UPDATE schedule_invite_issuance_fences
      SET state = 'PROVIDER_ACCEPTED', provider_accepted_at = NOW()
      WHERE invited_user_id = 10;
      UPDATE schedule_invite_issuance_fences
      SET state = 'PROVIDER_ACCEPTED_ACTIVATION_FAILED', lease_token = NULL,
          lease_expires_at = NULL, failure_code = 'ACTIVATION_EXCEPTION'
      WHERE invited_user_id = 10;
      UPDATE schedule_invite_issuance_fences
      SET state = 'PROVIDER_REJECTED', provider_accepted_at = NULL,
          failure_code = 'INVALID_IDEMPOTENCY_KEY', terminal_failure = 1
      WHERE invited_user_id = 10;
      UPDATE schedule_invite_issuance_fences
      SET state = 'PROVIDER_ACCEPTED_ACTIVATION_FAILED',
          provider_accepted_at = NOW(), failure_code = 'ACTIVATION_EXCEPTION',
          terminal_failure = 0
      WHERE invited_user_id = 10;
      INSERT INTO schedule_invite_issuance_journal
        (institution_id, hospital_id, sector_id, invited_user_id, generation, event, reason_code)
      VALUES
        (1, 2, 3, 10, 1, 'PROVIDER_UNKNOWN', 'TIMEOUT'),
        (1, 2, 3, 10, 1, 'ACTIVATION_FAILED', 'ACTIVATION_EXCEPTION');
    `);
    await database.query(migration);

    const [rows] = await database.query<RowDataPacket[]>(`
      SELECT generation, state, failure_code
      FROM schedule_invite_issuance_fences
      WHERE invited_user_id = 10
    `);
    expect(rows).toEqual([
      {
        generation: 1,
        state: "PROVIDER_ACCEPTED_ACTIVATION_FAILED",
        failure_code: "ACTIVATION_EXCEPTION",
      },
    ]);
    const [journal] = await database.query<RowDataPacket[]>(`
      SELECT generation, event, reason_code
      FROM schedule_invite_issuance_journal
      WHERE invited_user_id = 10
      ORDER BY id
    `);
    expect(journal).toEqual([
      { generation: 1, event: "PROVIDER_UNKNOWN", reason_code: "TIMEOUT" },
      {
        generation: 1,
        event: "ACTIVATION_FAILED",
        reason_code: "ACTIVATION_EXCEPTION",
      },
    ]);
    await expect(
      database.query(`
        UPDATE schedule_invite_issuance_journal
        SET reason_code = 'TAMPERED'
        WHERE invited_user_id = 10
      `),
    ).rejects.toMatchObject({ sqlState: "45000" });
    await expect(
      database.query(`
        DELETE FROM schedule_invite_issuance_journal
        WHERE invited_user_id = 10
      `),
    ).rejects.toMatchObject({ sqlState: "45000" });
    await expect(
      database.query(`
        INSERT INTO schedule_invite_issuance_fences
          (institution_id, hospital_id, sector_id, invited_user_id, generation, state)
        VALUES (1, 2, 3, 11, 1, 'PREPARING')
      `),
    ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
    await expect(
      database.query(`
        INSERT INTO schedule_invite_issuance_fences
          (institution_id, hospital_id, sector_id, invited_user_id, provider_accepted_at)
        VALUES (1, 2, 3, 11, NOW())
      `),
    ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
    await expect(
      database.query(`
        INSERT INTO schedule_invite_issuance_fences
          (institution_id, hospital_id, sector_id, invited_user_id, generation, state)
        VALUES (1, 2, 3, 11, 0, 'PROVIDER_REJECTED')
      `),
    ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
    await expect(
      database.query(`
        INSERT INTO schedule_invite_issuance_journal
          (institution_id, hospital_id, sector_id, invited_user_id, generation, event)
        VALUES (1, 2, 3, 11, 0, 'CLAIMED')
      `),
    ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
    await expect(
      database.query(`
        INSERT INTO schedule_invite_issuance_fences
          (institution_id, hospital_id, sector_id, invited_user_id)
        VALUES (1, 2, 3, 10)
      `),
    ).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
  });

  it("preflight recusa tabela homônima parcial antes de alterar seu estado", async () => {
    await database.query(`
      CREATE TABLE schedule_invite_issuance_fences (
        id INT NOT NULL AUTO_INCREMENT,
        sentinel VARCHAR(32) NOT NULL,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB;
      INSERT INTO schedule_invite_issuance_fences (sentinel) VALUES ('PRESERVE_ME');
    `);

    await expect(database.query(migration)).rejects.toThrow();
    const [rows] = await database.query<RowDataPacket[]>(
      "SELECT sentinel FROM schedule_invite_issuance_fences",
    );
    expect(rows).toEqual([{ sentinel: "PRESERVE_ME" }]);
    const [columns] = await database.query<RowDataPacket[]>(`
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'schedule_invite_issuance_fences'
      ORDER BY ORDINAL_POSITION
    `);
    expect(columns.map((row) => row.COLUMN_NAME)).toEqual(["id", "sentinel"]);
  });

  it("postflight do primeiro run recusa tipo criado fora do manifesto", async () => {
    const driftedCreate = migration.replace(
      "provider_correlation_id VARCHAR(128) NULL DEFAULT NULL,",
      "provider_correlation_id VARCHAR(127) NULL DEFAULT NULL,",
    );
    expect(driftedCreate).not.toBe(migration);

    await expect(database.query(driftedCreate)).rejects.toThrow();
    const [columns] = await database.query<RowDataPacket[]>(`
      SELECT COLUMN_TYPE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'schedule_invite_issuance_fences'
        AND COLUMN_NAME = 'provider_correlation_id'
    `);
    expect(columns).toEqual([{ COLUMN_TYPE: "varchar(127)" }]);
  });

  it("postflight do primeiro run recusa default criado fora do manifesto", async () => {
    const driftedCreate = migration.replace(
      "failure_code VARCHAR(64) NULL DEFAULT NULL,",
      "failure_code VARCHAR(64) NULL DEFAULT 'DRIFT',",
    );
    expect(driftedCreate).not.toBe(migration);

    await expect(database.query(driftedCreate)).rejects.toThrow();
    const [columns] = await database.query<RowDataPacket[]>(`
      SELECT COLUMN_DEFAULT
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'schedule_invite_issuance_fences'
        AND COLUMN_NAME = 'failure_code'
    `);
    expect(columns).toEqual([{ COLUMN_DEFAULT: "DRIFT" }]);
  });

  it("preflight recusa view homônima antes do CREATE TABLE", async () => {
    await database.query(`
      CREATE VIEW schedule_invite_issuance_fences AS
      SELECT 'PRESERVE_VIEW' AS sentinel
    `);

    await expect(database.query(migration)).rejects.toThrow();
    const [rows] = await database.query<RowDataPacket[]>(
      "SELECT sentinel FROM schedule_invite_issuance_fences",
    );
    expect(rows).toEqual([{ sentinel: "PRESERVE_VIEW" }]);
    const [objects] = await database.query<RowDataPacket[]>(`
      SELECT TABLE_TYPE
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'schedule_invite_issuance_fences'
    `);
    expect(objects).toEqual([{ TABLE_TYPE: "VIEW" }]);
  });

  it("preflight recusa drift de tipo em tabela antes válida", async () => {
    await database.query(migration);
    await database.query(`
      ALTER TABLE schedule_invite_issuance_fences
        MODIFY provider_correlation_id VARCHAR(129) NULL
    `);

    await expect(database.query(migration)).rejects.toThrow();
    const [columns] = await database.query<RowDataPacket[]>(`
      SELECT COLUMN_TYPE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'schedule_invite_issuance_fences'
        AND COLUMN_NAME = 'provider_correlation_id'
    `);
    expect(columns[0]?.COLUMN_TYPE).toBe("varchar(129)");
  });

  it("preflight recusa índice invisível e preserva o drift para diagnóstico", async () => {
    await database.query(migration);
    await database.query(`
      ALTER TABLE schedule_invite_issuance_fences
        ALTER INDEX fk_schedule_invite_issuance_invited_user INVISIBLE
    `);

    await expect(database.query(migration)).rejects.toThrow();
    const [indexes] = await database.query<RowDataPacket[]>(`
      SELECT IS_VISIBLE
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'schedule_invite_issuance_fences'
        AND INDEX_NAME = 'fk_schedule_invite_issuance_invited_user'
      LIMIT 1
    `);
    expect(indexes).toEqual([{ IS_VISIBLE: "NO" }]);
  });

  it("preflight recusa drift adversarial da cláusula CHECK normalizada", async () => {
    await database.query(migration);
    await database.query(`
      ALTER TABLE schedule_invite_issuance_fences
        DROP CHECK chk_schedule_invite_issuance_generation,
        ADD CONSTRAINT chk_schedule_invite_issuance_generation CHECK (
          (state = 'IDLE' AND generation = 0)
          OR (state <> 'IDLE' AND generation >= 0)
        )
    `);

    await expect(database.query(migration)).rejects.toThrow();
  });

  it("preflight recusa drift de ação referencial mesmo com nome e colunas iguais", async () => {
    await database.query(migration);
    await database.query(`
      ALTER TABLE schedule_invite_issuance_fences
        DROP FOREIGN KEY fk_schedule_invite_issuance_invited_user
    `);
    await database.query(`
      ALTER TABLE schedule_invite_issuance_fences
        ADD CONSTRAINT fk_schedule_invite_issuance_invited_user
          FOREIGN KEY (invited_user_id) REFERENCES users (id)
          ON UPDATE CASCADE ON DELETE CASCADE
    `);

    await expect(database.query(migration)).rejects.toThrow();
  });

  it("preflight recusa trigger append-only com ACTION_STATEMENT adulterado", async () => {
    await database.query(migration);
    await database.query(`
      DROP TRIGGER trg_schedule_invite_issuance_journal_no_update;
      CREATE TRIGGER trg_schedule_invite_issuance_journal_no_update
        BEFORE UPDATE ON schedule_invite_issuance_journal
        FOR EACH ROW SET NEW.reason_code = NEW.reason_code
    `);

    await expect(database.query(migration)).rejects.toThrow();
  });

  it("repara somente o subconjunto exato de triggers perdido por crash", async () => {
    await database.query(migration);
    await database.query(`
      DROP TRIGGER trg_schedule_invite_issuance_journal_no_update;
      DROP TRIGGER trg_users_schedule_invite_email_egress_guard;
    `);

    await database.query(migration);
    const [triggers] = await database.query<RowDataPacket[]>(`
      SELECT TRIGGER_NAME
      FROM INFORMATION_SCHEMA.TRIGGERS
      WHERE TRIGGER_SCHEMA = DATABASE()
        AND TRIGGER_NAME IN (
          'trg_schedule_invite_issuance_journal_no_update',
          'trg_schedule_invite_issuance_journal_no_delete',
          'trg_users_schedule_invite_email_egress_guard'
        )
      ORDER BY TRIGGER_NAME
    `);
    expect(triggers).toEqual([
      { TRIGGER_NAME: "trg_schedule_invite_issuance_journal_no_delete" },
      { TRIGGER_NAME: "trg_schedule_invite_issuance_journal_no_update" },
      { TRIGGER_NAME: "trg_users_schedule_invite_email_egress_guard" },
    ]);

    await database.query(`
      DROP TRIGGER trg_schedule_invite_issuance_journal_no_update;
      DROP TRIGGER trg_schedule_invite_issuance_journal_no_delete;
      DROP TRIGGER trg_users_schedule_invite_email_egress_guard;
    `);
    await database.query(migration);
    const [repaired] = await database.query<RowDataPacket[]>(`
      SELECT COUNT(*) AS count
      FROM INFORMATION_SCHEMA.TRIGGERS
      WHERE TRIGGER_SCHEMA = DATABASE()
        AND TRIGGER_NAME IN (
          'trg_schedule_invite_issuance_journal_no_update',
          'trg_schedule_invite_issuance_journal_no_delete',
          'trg_users_schedule_invite_email_egress_guard'
        )
    `);
    expect(Number(repaired[0]?.count)).toBe(3);
  });

  it("retoma o estado próprio após criar a fence e antes de criar o journal", async () => {
    await database.query(migration);
    await database.query(`
      DROP TRIGGER trg_users_schedule_invite_email_egress_guard;
      DROP TABLE schedule_invite_issuance_journal;
    `);

    await database.query(migration);
    const [objects] = await database.query<RowDataPacket[]>(`
      SELECT
        (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'schedule_invite_issuance_fences'
            AND TABLE_TYPE = 'BASE TABLE') AS fences_count,
        (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'schedule_invite_issuance_journal'
            AND TABLE_TYPE = 'BASE TABLE') AS journal_count,
        (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TRIGGERS
          WHERE TRIGGER_SCHEMA = DATABASE()
            AND TRIGGER_NAME IN (
              'trg_schedule_invite_issuance_journal_no_update',
              'trg_schedule_invite_issuance_journal_no_delete',
              'trg_users_schedule_invite_email_egress_guard'
            )) AS trigger_count
    `);
    expect(objects).toEqual([
      { fences_count: 1, journal_count: 1, trigger_count: 3 },
    ]);
  });

  it("não trata journal órfão como estado parcial produzido pela própria ordem DDL", async () => {
    await database.query(migration);
    await database.query(`
      DROP TRIGGER trg_schedule_invite_issuance_journal_no_update;
      DROP TRIGGER trg_schedule_invite_issuance_journal_no_delete;
      DROP TRIGGER trg_users_schedule_invite_email_egress_guard;
      DROP TABLE schedule_invite_issuance_fences;
    `);

    await expect(database.query(migration)).rejects.toThrow();
    const [journal] = await database.query<RowDataPacket[]>(`
      SELECT COUNT(*) AS count
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'schedule_invite_issuance_journal'
        AND TABLE_TYPE = 'BASE TABLE'
    `);
    expect(Number(journal[0]?.count)).toBe(1);
  });

  it("recusa drift no trigger de e-mail em vez de sobrescrevê-lo", async () => {
    await database.query(migration);
    await database.query(`
      DROP TRIGGER trg_users_schedule_invite_email_egress_guard;
      CREATE TRIGGER trg_users_schedule_invite_email_egress_guard
        BEFORE UPDATE ON users
        FOR EACH ROW SET NEW.email = NEW.email
    `);

    await expect(database.query(migration)).rejects.toThrow();
  });

  it("bloqueia somente mudança real de e-mail durante egress com lease viva", async () => {
    await database.query(migration);
    await database.query(`
      INSERT INTO schedule_invite_issuance_fences (
        institution_id, hospital_id, sector_id, invited_user_id,
        generation, state, lease_token, lease_expires_at,
        attempt_expires_at, code_nonce, code_pepper_key_id,
        recipient_binding_hash, provider_idempotency_key,
        provider_request_fingerprint, attempt_count
      ) VALUES (
        1, 2, 3, 10, 1, 'PREPARING', REPEAT('a', 64),
        DATE_ADD(NOW(), INTERVAL 1 MINUTE), DATE_ADD(NOW(), INTERVAL 1 DAY),
        REPEAT('b', 64), REPEAT('c', 64), REPEAT('d', 64),
        REPEAT('e', 64), REPEAT('f', 64), 1
      )
    `);

    await database.query(
      "UPDATE users SET email = email WHERE id = 10",
    );
    await expect(
      database.query(
        "UPDATE users SET email = 'new-10@example.test' WHERE id = 10",
      ),
    ).rejects.toMatchObject({
      sqlState: "45000",
      sqlMessage: expect.stringContaining(
        "SCHEDULE_INVITE_EMAIL_CHANGE_BLOCKED_DURING_EGRESS",
      ),
    });

    await database.query(`
      UPDATE schedule_invite_issuance_fences
      SET lease_expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND)
      WHERE invited_user_id = 10
    `);
    await database.query(
      "UPDATE users SET email = 'new-10@example.test' WHERE id = 10",
    );
  });

  it("recusa material opaco nulo ou malformado e journal semanticamente impossível", async () => {
    await database.query(migration);
    const validTail = `
      REPEAT('c', 64), REPEAT('d', 64), REPEAT('e', 64),
      REPEAT('f', 64), 1
    `;
    await expect(
      database.query(`
        INSERT INTO schedule_invite_issuance_fences (
          institution_id, hospital_id, sector_id, invited_user_id,
          generation, state, lease_token, lease_expires_at,
          attempt_expires_at, code_nonce, code_pepper_key_id,
          recipient_binding_hash, provider_idempotency_key,
          provider_request_fingerprint, attempt_count
        ) VALUES (
          1, 2, 3, 10, 1, 'PREPARING', REPEAT('a', 64),
          DATE_ADD(NOW(), INTERVAL 1 MINUTE), DATE_ADD(NOW(), INTERVAL 1 DAY),
          NULL, ${validTail}
        )
      `),
    ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
    await expect(
      database.query(`
        INSERT INTO schedule_invite_issuance_fences (
          institution_id, hospital_id, sector_id, invited_user_id,
          generation, state, lease_token, lease_expires_at,
          attempt_expires_at, code_nonce, code_pepper_key_id,
          recipient_binding_hash, provider_idempotency_key,
          provider_request_fingerprint, attempt_count
        ) VALUES (
          1, 2, 3, 10, 1, 'PREPARING', REPEAT('a', 64),
          DATE_ADD(NOW(), INTERVAL 1 MINUTE), DATE_ADD(NOW(), INTERVAL 1 DAY),
          CONCAT(REPEAT('b', 63), CHAR(10)), REPEAT('c', 64),
          REPEAT('d', 64), REPEAT('e', 64), REPEAT('f', 64), 1
        )
      `),
    ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
    await expect(
      database.query(`
        INSERT INTO schedule_invite_issuance_fences (
          institution_id, hospital_id, sector_id, invited_user_id,
          generation, state, attempt_expires_at, code_nonce,
          code_pepper_key_id, recipient_binding_hash,
          provider_idempotency_key, provider_request_fingerprint,
          failure_code, attempt_count
        ) VALUES (
          1, 2, 3, 11, 1, 'PROVIDER_REJECTED',
          DATE_ADD(NOW(), INTERVAL 1 DAY), REPEAT('b', 64),
          REPEAT('c', 64), REPEAT('d', 64), REPEAT('e', 64),
          REPEAT('f', 64), CONCAT('INVALID', CHAR(10)), 1
        )
      `),
    ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
    await expect(
      database.query(`
        INSERT INTO schedule_invite_issuance_fences (
          institution_id, hospital_id, sector_id, invited_user_id,
          generation, state, lease_token, lease_expires_at,
          attempt_expires_at, code_nonce, code_pepper_key_id,
          recipient_binding_hash, provider_idempotency_key,
          provider_request_fingerprint, provider_correlation_id,
          provider_accepted_at, attempt_count
        ) VALUES (
          1, 2, 3, 11, 1, 'PROVIDER_ACCEPTED', REPEAT('a', 64),
          DATE_ADD(NOW(), INTERVAL 1 MINUTE), DATE_ADD(NOW(), INTERVAL 1 DAY),
          REPEAT('b', 64), REPEAT('c', 64), REPEAT('d', 64),
          REPEAT('e', 64), REPEAT('f', 64), CONCAT('provider-id', CHAR(10)),
          NOW(), 1
        )
      `),
    ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
    await expect(
      database.query(`
        INSERT INTO schedule_invite_issuance_fences (
          institution_id, hospital_id, sector_id, invited_user_id,
          generation, state, attempt_expires_at, code_nonce,
          code_pepper_key_id, recipient_binding_hash,
          provider_idempotency_key, provider_request_fingerprint,
          failure_code, attempt_count, terminal_failure
        ) VALUES (
          1, 2, 3, 11, 1, 'PROVIDER_REJECTED',
          DATE_ADD(NOW(), INTERVAL 1 DAY), REPEAT('b', 64),
          REPEAT('c', 64), REPEAT('d', 64), REPEAT('e', 64),
          REPEAT('f', 64), 'INVALID_IDEMPOTENCY_KEY', 1, 0
        )
      `),
    ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
    await expect(
      database.query(`
        INSERT INTO schedule_invite_issuance_fences (
          institution_id, hospital_id, sector_id, invited_user_id,
          generation, state, lease_token, lease_expires_at,
          attempt_expires_at, code_nonce, code_pepper_key_id,
          recipient_binding_hash, provider_idempotency_key,
          provider_request_fingerprint, attempt_count
        ) VALUES (
          1, 2, 3, 10, 1, 'PREPARING', REPEAT('A', 64),
          DATE_ADD(NOW(), INTERVAL 1 MINUTE), DATE_ADD(NOW(), INTERVAL 1 DAY),
          REPEAT('b', 64), ${validTail}
        )
      `),
    ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
    await expect(
      database.query(`
        INSERT INTO schedule_invite_issuance_journal
          (institution_id, hospital_id, sector_id, invited_user_id, generation, event)
        VALUES (1, 2, 3, 10, 1, 'PROVIDER_UNKNOWN')
      `),
    ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
    await expect(
      database.query(`
        INSERT INTO schedule_invite_issuance_journal
          (institution_id, hospital_id, sector_id, invited_user_id, generation,
           event, provider_correlation_id)
        VALUES (1, 2, 3, 10, 1, 'CLAIMED', 'provider_123')
      `),
    ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
    await expect(
      database.query(`
        INSERT INTO schedule_invite_issuance_journal
          (institution_id, hospital_id, sector_id, invited_user_id, generation,
           event, provider_correlation_id)
        VALUES (1, 2, 3, 10, 1, 'PROVIDER_ACCEPTED', CONCAT('provider-id', CHAR(10)))
      `),
    ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
  });

  it("aceita ACTIVE somente quando schedule_invite_id pertence ao mesmo escopo nominal", async () => {
    await database.query(migration);
    const [invite] = await database.execute<ResultSetHeader>(`
      INSERT INTO schedule_invites
        (institution_id, hospital_id, sector_id, invited_user_id)
      VALUES (1, 2, 3, 10)
    `);
    const material = `
      1, 'ACTIVE', DATE_ADD(NOW(), INTERVAL 1 DAY), REPEAT('b', 64),
      REPEAT('c', 64), REPEAT('d', 64), REPEAT('e', 64), REPEAT('f', 64),
      NOW(), ?, 1
    `;
    await expect(
      database.execute(
        `INSERT INTO schedule_invite_issuance_fences (
          institution_id, hospital_id, sector_id, invited_user_id,
          generation, state, attempt_expires_at, code_nonce,
          code_pepper_key_id, recipient_binding_hash,
          provider_idempotency_key, provider_request_fingerprint,
          provider_accepted_at, schedule_invite_id, attempt_count
        ) VALUES (1, 2, 3, 11, ${material})`,
        [invite.insertId],
      ),
    ).rejects.toMatchObject({ code: "ER_NO_REFERENCED_ROW_2" });
    await database.execute(
      `INSERT INTO schedule_invite_issuance_fences (
        institution_id, hospital_id, sector_id, invited_user_id,
        generation, state, attempt_expires_at, code_nonce,
        code_pepper_key_id, recipient_binding_hash,
        provider_idempotency_key, provider_request_fingerprint,
        provider_accepted_at, schedule_invite_id, attempt_count
      ) VALUES (1, 2, 3, 10, ${material})`,
      [invite.insertId],
    );
  });

  it("preflight recusa trigger extra sem executá-lo", async () => {
    await database.query(migration);
    await database.query(`
      CREATE TRIGGER trg_siif_unexpected
        BEFORE UPDATE ON schedule_invite_issuance_fences
        FOR EACH ROW SET NEW.failure_code = NEW.failure_code
    `);

    await expect(database.query(migration)).rejects.toThrow();
    const [triggers] = await database.query<RowDataPacket[]>(`
      SELECT TRIGGER_NAME
      FROM INFORMATION_SCHEMA.TRIGGERS
      WHERE TRIGGER_SCHEMA = DATABASE()
        AND EVENT_OBJECT_TABLE = 'schedule_invite_issuance_fences'
    `);
    expect(triggers).toEqual([{ TRIGGER_NAME: "trg_siif_unexpected" }]);
  });
});
