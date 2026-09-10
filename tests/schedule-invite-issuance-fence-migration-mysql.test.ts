import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";

const SERVER_URL =
  process.env.SCHEDULE_INVITE_FENCE_MIGRATION_TEST_SERVER_URL;
const DATABASE_PREFIX = "escala_siif_validation_";

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
const describeMysql = server ? describe : describe.skip;

describeMysql("migration da fence de emissão em MySQL isolado", () => {
  let admin: Connection;
  let database: Connection;
  const databaseName = `${DATABASE_PREFIX}${process.pid}`;

  async function createPrerequisites() {
    await database.query(`
      CREATE TABLE users (
        id INT NOT NULL,
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
      INSERT INTO users (id) VALUES (10), (11);
      INSERT INTO institutions (id) VALUES (1);
      INSERT INTO hospitals (id, institution_id) VALUES (2, 1);
      INSERT INTO sectors (id, institution_id, hospital_id) VALUES (3, 1, 2);
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
    await createPrerequisites();
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

  it("aceita todos os estados válidos, recusa shapes impossíveis e reroda preservando linhas", async () => {
    await database.query(migration);
    await database.query(`
      INSERT INTO schedule_invite_issuance_fences
        (institution_id, hospital_id, sector_id, invited_user_id, generation, state)
      VALUES (1, 2, 3, 10, 0, 'IDLE');
      UPDATE schedule_invite_issuance_fences
      SET generation = 1,
          state = 'PREPARING',
          lease_expires_at = DATE_ADD(NOW(), INTERVAL 1 MINUTE)
      WHERE invited_user_id = 10;
      UPDATE schedule_invite_issuance_fences
      SET state = 'PROVIDER_ACCEPTED', provider_accepted_at = NOW()
      WHERE invited_user_id = 10;
      UPDATE schedule_invite_issuance_fences
      SET state = 'ACTIVE', lease_expires_at = NULL
      WHERE invited_user_id = 10;
      UPDATE schedule_invite_issuance_fences
      SET state = 'PROVIDER_ACCEPTED_ACTIVATION_FAILED', failure_code = 'ACTIVATION_EXCEPTION'
      WHERE invited_user_id = 10;
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
    await expect(
      database.query(`
        INSERT INTO schedule_invite_issuance_fences
          (institution_id, hospital_id, sector_id, invited_user_id, state)
        VALUES (1, 2, 3, 11, 'PREPARING')
      `),
    ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
    await expect(
      database.query(`
        INSERT INTO schedule_invite_issuance_fences
          (institution_id, hospital_id, sector_id, invited_user_id, state, provider_accepted_at)
        VALUES (1, 2, 3, 11, 'IDLE', NOW())
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
        INSERT INTO schedule_invite_issuance_fences
          (institution_id, hospital_id, sector_id, invited_user_id, generation, state, provider_accepted_at, failure_code)
        VALUES (1, 2, 3, 11, 1, 'ACTIVE', NOW(), 'IMPOSSIBLE_FAILURE')
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
        MODIFY failure_code VARCHAR(65) NULL
    `);

    await expect(database.query(migration)).rejects.toThrow();
    const [columns] = await database.query<RowDataPacket[]>(`
      SELECT COLUMN_TYPE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'schedule_invite_issuance_fences'
        AND COLUMN_NAME = 'failure_code'
    `);
    expect(columns[0]?.COLUMN_TYPE).toBe("varchar(65)");
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
