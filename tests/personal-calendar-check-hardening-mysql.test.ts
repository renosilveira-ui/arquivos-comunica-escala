import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";

const TEST_SERVER_URL = process.env.PERSONAL_CALENDAR_MIGRATION_TEST_SERVER_URL;
const DATABASE_PREFIX = "escala_pc_check_hardening_";

type TestServer = {
  host: string;
  port: number;
  user: string;
  password: string;
};

function parseTestServer(raw: string | undefined): TestServer | null {
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
      "PERSONAL_CALENDAR_MIGRATION_TEST_SERVER_URL deve apontar somente para mysql:// local e o schema mysql.",
    );
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

function databaseName(): string {
  return `${DATABASE_PREFIX}${randomUUID().replaceAll("-", "")}`;
}

function quoteIdentifier(identifier: string): string {
  if (!/^escala_pc_check_hardening_[a-f0-9]{32}$/.test(identifier)) {
    throw new Error("Nome de schema descartável inválido.");
  }
  return `\`${identifier}\``;
}

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-09-personal-calendar-check-hardening.sql",
    import.meta.url,
  ),
  "utf8",
);
const server = parseTestServer(TEST_SERVER_URL);
const describeWithMysql = server ? describe : describe.skip;

async function createVulnerableTables(database: Connection): Promise<void> {
  await database.query(`
    CREATE TABLE personal_calendar_items (
      id INT NOT NULL AUTO_INCREMENT,
      kind ENUM('APPOINTMENT','REMINDER','BIRTHDAY') NOT NULL,
      latitude DECIMAL(10,7) NULL,
      longitude DECIMAL(10,7) NULL,
      location_provider VARCHAR(32) NULL,
      location_external_id VARCHAR(191) NULL,
      start_local_date DATE NULL,
      start_local_time TIME NULL,
      end_local_date DATE NULL,
      end_local_time TIME NULL,
      birthday_month TINYINT UNSIGNED NULL,
      birthday_day TINYINT UNSIGNED NULL,
      birthday_year INT NULL,
      all_day TINYINT(1) NOT NULL DEFAULT 0,
      PRIMARY KEY (id),
      CONSTRAINT chk_pc_item_location CHECK (
        (latitude IS NULL AND longitude IS NULL)
        OR (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180)
      ),
      CONSTRAINT chk_pc_item_location_binding CHECK (
        (location_provider IS NULL AND location_external_id IS NULL)
        OR (
          CHAR_LENGTH(TRIM(location_provider)) BETWEEN 1 AND 32
          AND CHAR_LENGTH(TRIM(location_external_id)) BETWEEN 1 AND 191
        )
      ),
      CONSTRAINT chk_pc_item_shape CHECK (
        (
          kind = 'APPOINTMENT'
          AND start_local_date IS NOT NULL
          AND end_local_date IS NOT NULL
          AND birthday_month IS NULL
          AND birthday_day IS NULL
          AND birthday_year IS NULL
          AND (
            (
              all_day = 1
              AND start_local_time IS NULL
              AND end_local_time IS NULL
              AND end_local_date > start_local_date
            )
            OR
            (
              all_day = 0
              AND start_local_time IS NOT NULL
              AND end_local_time IS NOT NULL
              AND TIMESTAMP(end_local_date, end_local_time)
                > TIMESTAMP(start_local_date, start_local_time)
            )
          )
        )
        OR
        (
          kind = 'REMINDER'
          AND start_local_date IS NOT NULL
          AND end_local_date IS NULL
          AND end_local_time IS NULL
          AND birthday_month IS NULL
          AND birthday_day IS NULL
          AND birthday_year IS NULL
          AND (
            (all_day = 1 AND start_local_time IS NULL)
            OR (all_day = 0 AND start_local_time IS NOT NULL)
          )
        )
        OR
        (
          kind = 'BIRTHDAY'
          AND all_day = 1
          AND start_local_date IS NULL
          AND start_local_time IS NULL
          AND end_local_date IS NULL
          AND end_local_time IS NULL
          AND birthday_month BETWEEN 1 AND 12
          AND birthday_day BETWEEN 1 AND 31
          AND (birthday_year IS NULL OR birthday_year BETWEEN 1800 AND 2200)
        )
      )
    ) ENGINE=InnoDB;

    CREATE TABLE personal_calendar_recurrences (
      id INT NOT NULL AUTO_INCREMENT,
      frequency ENUM('DAILY','WEEKLY','MONTHLY','YEARLY') NOT NULL,
      weekdays_mask TINYINT UNSIGNED NULL,
      termination ENUM('NEVER','UNTIL','COUNT') NOT NULL,
      until_local_date DATE NULL,
      occurrence_count INT NULL,
      PRIMARY KEY (id),
      CONSTRAINT chk_pc_recurrence_weekdays CHECK (
        (frequency = 'WEEKLY' AND weekdays_mask BETWEEN 1 AND 127)
        OR (frequency <> 'WEEKLY' AND weekdays_mask IS NULL)
      ),
      CONSTRAINT chk_pc_recurrence_termination CHECK (
        (
          termination = 'NEVER'
          AND until_local_date IS NULL
          AND occurrence_count IS NULL
        )
        OR
        (
          termination = 'UNTIL'
          AND until_local_date IS NOT NULL
          AND occurrence_count IS NULL
        )
        OR
        (
          termination = 'COUNT'
          AND until_local_date IS NULL
          AND occurrence_count BETWEEN 1 AND 10000
        )
      )
    ) ENGINE=InnoDB;
  `);
}

describeWithMysql("hardening dos CHECKs em MySQL isolado", () => {
  let admin: Connection;
  const createdSchemas = new Set<string>();

  beforeAll(async () => {
    if (!server) throw new Error("Servidor MySQL local não configurado.");
    admin = await mysql.createConnection({ ...server, database: "mysql" });
  });

  afterAll(async () => {
    try {
      for (const schema of createdSchemas) {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(schema)}`);
      }
    } finally {
      await admin?.end();
    }
  });

  async function withSchema(
    run: (database: Connection) => Promise<void>,
  ): Promise<void> {
    if (!server) throw new Error("Servidor MySQL local não configurado.");
    const schema = databaseName();
    await admin.query(`CREATE DATABASE ${quoteIdentifier(schema)}`);
    createdSchemas.add(schema);
    const database = await mysql.createConnection({
      ...server,
      database: schema,
      multipleStatements: true,
    });
    try {
      await createVulnerableTables(database);
      await run(database);
    } finally {
      await database.end();
    }
  }

  it("rejeita os cinco estados que antes resultavam UNKNOWN", async () => {
    await withSchema(async (database) => {
      await database.query(migration);
      await database.query(migration);

      const appointment = `
        INSERT INTO personal_calendar_items (
          kind, latitude, longitude, location_provider, location_external_id,
          start_local_date, end_local_date, all_day
        ) VALUES ('APPOINTMENT', ?, ?, ?, ?, '2026-09-10', '2026-09-11', 1)
      `;
      await expect(
        database.execute(appointment, [10, null, null, null]),
      ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
      await expect(
        database.execute(appointment, [null, null, "maps", null]),
      ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
      await expect(
        database.query(`
          INSERT INTO personal_calendar_items (kind, all_day)
          VALUES ('BIRTHDAY', 1)
        `),
      ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
      await expect(
        database.query(`
          INSERT INTO personal_calendar_recurrences
            (frequency, weekdays_mask, termination)
          VALUES ('WEEKLY', NULL, 'NEVER')
        `),
      ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
      await expect(
        database.query(`
          INSERT INTO personal_calendar_recurrences
            (frequency, weekdays_mask, termination, occurrence_count)
          VALUES ('DAILY', NULL, 'COUNT', NULL)
        `),
      ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
    });
  });

  it("falha antes do DDL se já houver linha incompatível", async () => {
    await withSchema(async (database) => {
      await database.query(`
        INSERT INTO personal_calendar_items (
          kind, latitude, longitude, start_local_date, end_local_date, all_day
        ) VALUES ('APPOINTMENT', 10, NULL, '2026-09-10', '2026-09-11', 1)
      `);

      await expect(database.query(migration)).rejects.toMatchObject({
        code: "ER_NO_SUCH_TABLE",
        message: expect.stringContaining(
          "personal_calendar_check_hardening_preflight_failed",
        ),
      });

      const [constraint] = await database.query<RowDataPacket[]>(`
        SELECT CHECK_CLAUSE
        FROM information_schema.CHECK_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE()
          AND CONSTRAINT_NAME = 'chk_pc_item_location'
      `);
      expect(String(constraint[0]?.CHECK_CLAUSE).toLowerCase()).not.toContain(
        "latitude is not null",
      );
    });
  });
});
