import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { getTableConfig, MySqlDialect } from "drizzle-orm/mysql-core";
import {
  personalCalendarItems,
  personalCalendarRecurrences,
} from "../drizzle/schema";

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
const checkNames = [
  "chk_pc_item_location",
  "chk_pc_item_location_binding",
  "chk_pc_item_shape",
  "chk_pc_recurrence_weekdays",
  "chk_pc_recurrence_termination",
] as const;
type CheckName = (typeof checkNames)[number];

const dialect = new MySqlDialect();
const canonicalChecks = [personalCalendarItems, personalCalendarRecurrences]
  .flatMap((table) => {
    const config = getTableConfig(table);
    return config.checks.map((check) => ({
      name: check.name,
      table: config.name,
      expression: dialect
        .sqlToQuery(check.value)
        .sql.replaceAll(`\`${config.name}\`.`, ""),
    }));
  })
  .filter((check) => checkNames.includes(check.name as CheckName));

function canonicalCheck(name: CheckName) {
  const check = canonicalChecks.find((candidate) => candidate.name === name);
  if (!check) throw new Error(`CHECK canônico ausente: ${name}`);
  return check;
}

async function replaceCheck(
  database: Connection,
  name: CheckName,
  expression = canonicalCheck(name).expression,
): Promise<void> {
  const check = canonicalCheck(name);
  await database.query(
    `ALTER TABLE \`${check.table}\` DROP CHECK \`${name}\`,
      ADD CONSTRAINT \`${name}\` CHECK (${expression}) ENFORCED`,
  );
}

async function installCanonicalChecks(database: Connection): Promise<void> {
  for (const name of checkNames) await replaceCheck(database, name);
}

async function catalog(database: Connection) {
  const [rows] = await database.query<RowDataPacket[]>(`
    SELECT tc.TABLE_NAME, tc.CONSTRAINT_NAME, tc.ENFORCED, cc.CHECK_CLAUSE
    FROM information_schema.TABLE_CONSTRAINTS tc
    JOIN information_schema.CHECK_CONSTRAINTS cc
      ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
      AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
    WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
      AND tc.CONSTRAINT_TYPE = 'CHECK'
    ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME
  `);
  return rows;
}

const appointmentSql = `INSERT INTO personal_calendar_items (
  kind, latitude, longitude, location_provider, location_external_id,
  start_local_date, end_local_date, all_day
) VALUES ('APPOINTMENT', ?, ?, ?, ?, '2026-09-10', '2026-09-11', 1)`;

const invalidCases = [
  {
    name: "latitude sem longitude",
    check: "chk_pc_item_location",
    sql: appointmentSql,
    values: [10, null, null, null],
  },
  {
    name: "longitude sem latitude",
    check: "chk_pc_item_location",
    sql: appointmentSql,
    values: [null, 20, null, null],
  },
  {
    name: "provider sem identificador",
    check: "chk_pc_item_location_binding",
    sql: appointmentSql,
    values: [null, null, "maps", null],
  },
  {
    name: "identificador sem provider",
    check: "chk_pc_item_location_binding",
    sql: appointmentSql,
    values: [null, null, null, "abc"],
  },
  {
    name: "aniversário sem mês/dia",
    check: "chk_pc_item_shape",
    sql: "INSERT INTO personal_calendar_items (kind, all_day) VALUES ('BIRTHDAY', 1)",
    values: [],
  },
  {
    name: "aniversário sem mês",
    check: "chk_pc_item_shape",
    sql: "INSERT INTO personal_calendar_items (kind, all_day, birthday_day) VALUES ('BIRTHDAY', 1, 10)",
    values: [],
  },
  {
    name: "aniversário sem dia",
    check: "chk_pc_item_shape",
    sql: "INSERT INTO personal_calendar_items (kind, all_day, birthday_month) VALUES ('BIRTHDAY', 1, 2)",
    values: [],
  },
  {
    name: "WEEKLY sem máscara",
    check: "chk_pc_recurrence_weekdays",
    sql: "INSERT INTO personal_calendar_recurrences (frequency, weekdays_mask, termination) VALUES ('WEEKLY', NULL, 'NEVER')",
    values: [],
  },
  {
    name: "COUNT sem quantidade",
    check: "chk_pc_recurrence_termination",
    sql: "INSERT INTO personal_calendar_recurrences (frequency, termination, occurrence_count) VALUES ('DAILY', 'COUNT', NULL)",
    values: [],
  },
  {
    name: "latitude fora do intervalo",
    check: "chk_pc_item_location",
    sql: appointmentSql,
    values: [91, 20, null, null],
  },
  {
    name: "provider vazio",
    check: "chk_pc_item_location_binding",
    sql: appointmentSql,
    values: [null, null, " ", "abc"],
  },
  {
    name: "aniversário fora do mês",
    check: "chk_pc_item_shape",
    sql: "INSERT INTO personal_calendar_items (kind, all_day, birthday_month, birthday_day) VALUES ('BIRTHDAY', 1, 2, 30)",
    values: [],
  },
  {
    name: "WEEKLY com máscara vazia",
    check: "chk_pc_recurrence_weekdays",
    sql: "INSERT INTO personal_calendar_recurrences (frequency, weekdays_mask, termination) VALUES ('WEEKLY', 0, 'NEVER')",
    values: [],
  },
  {
    name: "COUNT com quantidade zero",
    check: "chk_pc_recurrence_termination",
    sql: "INSERT INTO personal_calendar_recurrences (frequency, termination, occurrence_count) VALUES ('DAILY', 'COUNT', 0)",
    values: [],
  },
] satisfies {
  name: string;
  check: CheckName;
  sql: string;
  values: (string | number | null)[];
}[];

async function insertValidControls(database: Connection): Promise<void> {
  await database.execute(appointmentSql, [null, null, null, null]);
  await database.execute(appointmentSql, [10, 20, "maps", "abc"]);
  await database.query(`
    INSERT INTO personal_calendar_items
      (kind, all_day, start_local_date, start_local_time, end_local_date, end_local_time)
    VALUES ('APPOINTMENT', 0, '2026-09-10', '08:00', '2026-09-10', '09:00');
    INSERT INTO personal_calendar_items (kind, all_day, start_local_date)
    VALUES ('REMINDER', 1, '2026-09-10');
    INSERT INTO personal_calendar_items (kind, all_day, birthday_month, birthday_day)
    VALUES ('BIRTHDAY', 1, 2, 29);
    INSERT INTO personal_calendar_recurrences (frequency, weekdays_mask, termination)
    VALUES ('WEEKLY', 7, 'NEVER');
    INSERT INTO personal_calendar_recurrences (frequency, termination, occurrence_count)
    VALUES ('DAILY', 'COUNT', 3);
    INSERT INTO personal_calendar_recurrences (frequency, termination, until_local_date)
    VALUES ('MONTHLY', 'UNTIL', '2027-09-10');
  `);
}

async function assertHardened(database: Connection): Promise<void> {
  for (const invalid of invalidCases) {
    await expect(
      database.execute(invalid.sql, invalid.values),
      invalid.name,
    ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
  }
  await insertValidControls(database);
  expect((await catalog(database)).map((row) => row.ENFORCED)).toEqual(
    Array(5).fill("YES"),
  );
}

async function assertRerunNoop(database: Connection): Promise<void> {
  const before = await catalog(database);
  const [itemsBefore] = await database.query(
    "SELECT * FROM personal_calendar_items ORDER BY id",
  );
  const [recurrencesBefore] = await database.query(
    "SELECT * FROM personal_calendar_recurrences ORDER BY id",
  );
  await database.query(migration);
  const [ddl] = await database.query<RowDataPacket[]>(
    "SELECT @pc_item_ddl AS items, @pc_recurrence_ddl AS recurrences",
  );
  expect(ddl[0]).toEqual({ items: "SELECT 1", recurrences: "SELECT 1" });
  expect(await catalog(database)).toEqual(before);
  const [itemsAfter] = await database.query(
    "SELECT * FROM personal_calendar_items ORDER BY id",
  );
  const [recurrencesAfter] = await database.query(
    "SELECT * FROM personal_calendar_recurrences ORDER BY id",
  );
  expect(itemsAfter).toEqual(itemsBefore);
  expect(recurrencesAfter).toEqual(recurrencesBefore);
}

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

describe("hardening dos CHECKs em MySQL isolado", () => {
  let admin: Connection;
  const createdSchemas = new Set<string>();

  beforeAll(async () => {
    if (!server) throw new Error("Servidor MySQL local não configurado.");
    admin = await mysql.createConnection({ ...server, database: "mysql" });
    const [rows] = await admin.query<RowDataPacket[]>(
      "SELECT VERSION() AS version",
    );
    expect(rows[0]?.version).toMatch(/^8\./);
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

  it("corrige o schema totalmente antigo, preserva válidos e reaplica sem DDL", async () => {
    await withSchema(async (database) => {
      await insertValidControls(database);
      await database.query(migration);
      await assertHardened(database);
      await assertRerunNoop(database);
    });
  });

  it("reconhece o contrato completo do schema Drizzle sem reinstalar CHECKs", async () => {
    await withSchema(async (database) => {
      await installCanonicalChecks(database);
      await assertHardened(database);
      await assertRerunNoop(database);
    });
  });

  it("corrige schema misto com shape e termination antigos", async () => {
    await withSchema(async (database) => {
      await replaceCheck(database, "chk_pc_item_location");
      await replaceCheck(database, "chk_pc_item_location_binding");
      await replaceCheck(database, "chk_pc_recurrence_weekdays");
      await database.query(migration);
      await assertHardened(database);
      await assertRerunNoop(database);
    });
  });

  it.each(checkNames)(
    "corrige schema com apenas %s atualizado",
    async (name) => {
      await withSchema(async (database) => {
        await replaceCheck(database, name);
        await database.query(migration);
        await assertHardened(database);
        await assertRerunNoop(database);
      });
    },
  );

  const partialGuards: [CheckName, string][] = [
    ["chk_pc_item_location", "latitude"],
    ["chk_pc_item_location", "longitude"],
    ["chk_pc_item_location_binding", "location_provider"],
    ["chk_pc_item_location_binding", "location_external_id"],
    ["chk_pc_item_shape", "birthday_month"],
    ["chk_pc_item_shape", "birthday_day"],
    ["chk_pc_recurrence_weekdays", "weekdays_mask"],
    ["chk_pc_recurrence_termination", "occurrence_count"],
  ];

  it.each(partialGuards)(
    "corrige %s com guarda parcial em %s",
    async (name, field) => {
      await withSchema(async (database) => {
        await installCanonicalChecks(database);
        const expected = canonicalCheck(name).expression;
        const partial = expected.replace(
          new RegExp(`\`${field}\`\\s+IS NOT NULL\\s+AND\\s*`, "i"),
          "",
        );
        expect(partial).not.toBe(expected);
        await replaceCheck(database, name, partial);
        await database.query(migration);
        await assertHardened(database);
        await assertRerunNoop(database);
      });
    },
  );

  it.each(checkNames)("reativa %s NOT ENFORCED", async (name) => {
    await withSchema(async (database) => {
      await installCanonicalChecks(database);
      const { table } = canonicalCheck(name);
      await database.query(
        `ALTER TABLE \`${table}\` ALTER CHECK \`${name}\` NOT ENFORCED`,
      );
      await database.query(migration);
      await assertHardened(database);
      await assertRerunNoop(database);
    });
  });

  it("não aceita OR TRUE nem alteração de agrupamento como contrato canônico", async () => {
    await withSchema(async (database) => {
      await installCanonicalChecks(database);
      const name = "chk_pc_item_shape";
      await replaceCheck(
        database,
        name,
        `(${canonicalCheck(name).expression}) OR TRUE`,
      );
      await database.query(migration);
      await assertHardened(database);
      await assertRerunNoop(database);
    });
  });

  it.each(checkNames)(
    "postflight recusa %s desabilitado após o DDL",
    async (name) => {
      await withSchema(async (database) => {
        const { table } = canonicalCheck(name);
        const marker = "PREPARE pc_catalog_stmt FROM @pc_catalog_sql;";
        const postflight = migration.lastIndexOf(marker);
        expect(postflight).toBeGreaterThan(migration.indexOf(marker));
        const interrupted =
          migration.slice(0, postflight) +
          `ALTER TABLE \`${table}\` ALTER CHECK \`${name}\` NOT ENFORCED;\n` +
          migration.slice(postflight);
        await expect(database.query(interrupted)).rejects.toMatchObject({
          code: "ER_NO_SUCH_TABLE",
          message: expect.stringContaining(
            "personal_calendar_check_hardening_postflight_failed",
          ),
        });
      });
    },
  );

  it("recusa constraint homônima na tabela errada antes do DDL", async () => {
    await withSchema(async (database) => {
      await database.query(`
        ALTER TABLE personal_calendar_items DROP CHECK chk_pc_item_shape;
        ALTER TABLE personal_calendar_recurrences
          ADD CONSTRAINT chk_pc_item_shape CHECK (1 = 1);
      `);
      const before = await catalog(database);
      await expect(database.query(migration)).rejects.toMatchObject({
        code: "ER_NO_SUCH_TABLE",
        message: expect.stringContaining(
          "personal_calendar_check_hardening_preflight_failed",
        ),
      });
      expect(await catalog(database)).toEqual(before);
    });
  });

  it.each(invalidCases)(
    "aborta antes de qualquer DDL com $name persistido",
    async (invalid) => {
      await withSchema(async (database) => {
        // Inclui valores fora dos intervalos: não basta procurar os cinco NULLs.
        await installCanonicalChecks(database);
        const { table } = canonicalCheck(invalid.check);
        await database.query(
          `ALTER TABLE \`${table}\` ALTER CHECK \`${invalid.check}\` NOT ENFORCED`,
        );
        await database.execute(invalid.sql, invalid.values);
        const before = await catalog(database);
        const [itemsBefore] = await database.query(
          "SELECT * FROM personal_calendar_items ORDER BY id",
        );
        const [recurrencesBefore] = await database.query(
          "SELECT * FROM personal_calendar_recurrences ORDER BY id",
        );
        await expect(database.query(migration)).rejects.toMatchObject({
          code: "ER_NO_SUCH_TABLE",
          message: expect.stringContaining(
            "personal_calendar_check_hardening_preflight_failed",
          ),
        });
        expect(await catalog(database)).toEqual(before);
        const [itemsAfter] = await database.query(
          "SELECT * FROM personal_calendar_items ORDER BY id",
        );
        const [recurrencesAfter] = await database.query(
          "SELECT * FROM personal_calendar_recurrences ORDER BY id",
        );
        expect(itemsAfter).toEqual(itemsBefore);
        expect(recurrencesAfter).toEqual(recurrencesBefore);
      });
    },
  );
});
