import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql, {
  type Connection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";

const TEST_SERVER_URL = process.env.PERSONAL_CALENDAR_MIGRATION_TEST_SERVER_URL;
const TEMPORARY_DATABASE_PREFIX = "escala_pc_validation_";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const drizzleKitPath = resolve(
  repositoryRoot,
  "node_modules/drizzle-kit/bin.cjs",
);

type MigrationTestServer = {
  host: string;
  port: number;
  user: string;
  password: string;
};

function parseMigrationTestServer(
  raw: string | undefined,
): MigrationTestServer | null {
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

function temporaryDatabaseName(): string {
  const suffix = `${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const name = `${TEMPORARY_DATABASE_PREFIX}${suffix}`;
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error("Nome de schema de teste inválido.");
  }
  return name;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z0-9_]+$/.test(identifier)) {
    throw new Error("Identificador SQL de teste inválido.");
  }
  return `\`${identifier}\``;
}

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-09-personal-calendar-foundation.sql",
    import.meta.url,
  ),
  "utf8",
);
const checkHardeningMigration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-09-personal-calendar-check-hardening.sql",
    import.meta.url,
  ),
  "utf8",
);
const server = parseMigrationTestServer(TEST_SERVER_URL);
const describeWithIsolatedMysql = server ? describe : describe.skip;

async function createPrerequisites(connection: Connection) {
  await connection.query(`
    CREATE TABLE users (
      id INT NOT NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB;
    INSERT INTO users (id) VALUES (1), (2);
  `);
}

async function createTemporaryDatabase(admin: Connection) {
  if (!server) throw new Error("Servidor de migration de teste ausente.");
  const schemaName = temporaryDatabaseName();
  await admin.query(`CREATE DATABASE ${quoteIdentifier(schemaName)}`);
  const connection = await mysql.createConnection({
    ...server,
    database: schemaName,
    multipleStatements: true,
  });
  await createPrerequisites(connection);
  return { schemaName, connection };
}

function databaseUrlFor(schemaName: string): string {
  if (!server) throw new Error("Servidor de migration de teste ausente.");
  const host = server.host.includes(":") ? `[${server.host}]` : server.host;
  return `mysql://${encodeURIComponent(server.user)}:${encodeURIComponent(server.password)}@${host}:${server.port}/${schemaName}`;
}

function runFreshSchemaPush(schemaName: string) {
  const result = spawnSync(
    process.execPath,
    [drizzleKitPath, "push", "--force"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DATABASE_URL: databaseUrlFor(schemaName),
        DATABASE_SSL: "false",
        NODE_ENV: "test",
      },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal) {
    const diagnostic = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
      .replace(/mysql:\/\/[^:\s/]+:[^@\s/]+@/giu, "mysql://***:***@")
      .trim()
      .slice(-4_000);
    throw new Error(
      `drizzle-kit push falhou no schema descartável da Agenda (status ${String(result.status)}, sinal ${String(result.signal)})${diagnostic ? `\n${diagnostic}` : ""}`,
    );
  }
}

async function runFoundationHardeningRerunSequence(
  connection: Connection,
  afterFoundation: () => Promise<void>,
): Promise<void> {
  await connection.query(migration);
  await afterFoundation();
  await connection.query(checkHardeningMigration);
  await connection.query(migration);
  await connection.query(checkHardeningMigration);
}

describeWithIsolatedMysql(
  "migration da fundação da agenda pessoal em MySQL isolado",
  () => {
    let admin: Connection;
    let database: Connection;
    let schemaName: string;

    beforeAll(async () => {
      if (!server) throw new Error("Servidor de migration de teste ausente.");
      admin = await mysql.createConnection({ ...server, database: "mysql" });
      const temporary = await createTemporaryDatabase(admin);
      schemaName = temporary.schemaName;
      database = temporary.connection;
      await database.query(migration);
    });

    afterAll(async () => {
      try {
        await database?.end();
      } finally {
        try {
          if (schemaName?.startsWith(TEMPORARY_DATABASE_PREFIX)) {
            await admin?.query(
              `DROP DATABASE IF EXISTS ${quoteIdentifier(schemaName)}`,
            );
          }
        } finally {
          await admin?.end();
        }
      }
    });

    it("cria o contrato integral e pode ser reaplicada sem duplicar estrutura", async () => {
      await database.query(migration);

      const [tables] = await database.query<RowDataPacket[]>(`
        SELECT TABLE_NAME
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME LIKE 'personal_calendar_%'
        ORDER BY TABLE_NAME
      `);
      expect(tables.map((row) => row.TABLE_NAME)).toEqual([
        "personal_calendar_alert_rules",
        "personal_calendar_items",
        "personal_calendar_occurrence_exceptions",
        "personal_calendar_occurrences",
        "personal_calendar_recurrences",
      ]);

      const [binaryColumns] = await database.query<RowDataPacket[]>(`
        SELECT TABLE_NAME, COLUMN_NAME, COLLATION_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND (
            (TABLE_NAME = 'personal_calendar_items'
              AND COLUMN_NAME = 'client_mutation_id')
            OR
            (TABLE_NAME IN (
              'personal_calendar_occurrences',
              'personal_calendar_occurrence_exceptions'
            ) AND COLUMN_NAME = 'occurrence_key')
          )
        ORDER BY TABLE_NAME, COLUMN_NAME
      `);
      expect(binaryColumns).toHaveLength(3);
      expect(
        binaryColumns.every((row) => row.COLLATION_NAME === "utf8mb4_bin"),
      ).toBe(true);

      const [foreignKeys] = await database.query<RowDataPacket[]>(`
        SELECT
          kcu.TABLE_NAME,
          kcu.CONSTRAINT_NAME,
          kcu.ORDINAL_POSITION,
          kcu.COLUMN_NAME,
          kcu.REFERENCED_TABLE_NAME,
          kcu.REFERENCED_COLUMN_NAME,
          rc.DELETE_RULE
        FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE AS kcu
        INNER JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS AS rc
          ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
          AND rc.TABLE_NAME = kcu.TABLE_NAME
          AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
        WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
          AND kcu.TABLE_NAME LIKE 'personal_calendar_%'
          AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
      `);
      expect(
        foreignKeys.map((row) => ({
          table: row.TABLE_NAME,
          constraint: row.CONSTRAINT_NAME,
          position: Number(row.ORDINAL_POSITION),
          column: row.COLUMN_NAME,
          referencedTable: row.REFERENCED_TABLE_NAME,
          referencedColumn: row.REFERENCED_COLUMN_NAME,
          deleteRule: row.DELETE_RULE,
        })),
      ).toEqual([
        {
          table: "personal_calendar_alert_rules",
          constraint: "fk_pc_alert_item_owner",
          position: 1,
          column: "item_id",
          referencedTable: "personal_calendar_items",
          referencedColumn: "id",
          deleteRule: "CASCADE",
        },
        {
          table: "personal_calendar_alert_rules",
          constraint: "fk_pc_alert_item_owner",
          position: 2,
          column: "owner_user_id",
          referencedTable: "personal_calendar_items",
          referencedColumn: "owner_user_id",
          deleteRule: "CASCADE",
        },
        {
          table: "personal_calendar_items",
          constraint: "fk_pc_item_owner",
          position: 1,
          column: "owner_user_id",
          referencedTable: "users",
          referencedColumn: "id",
          deleteRule: "CASCADE",
        },
        {
          table: "personal_calendar_occurrence_exceptions",
          constraint: "fk_pc_exception_replacement_owner",
          position: 1,
          column: "replacement_item_id",
          referencedTable: "personal_calendar_items",
          referencedColumn: "id",
          deleteRule: "CASCADE",
        },
        {
          table: "personal_calendar_occurrence_exceptions",
          constraint: "fk_pc_exception_replacement_owner",
          position: 2,
          column: "owner_user_id",
          referencedTable: "personal_calendar_items",
          referencedColumn: "owner_user_id",
          deleteRule: "CASCADE",
        },
        {
          table: "personal_calendar_occurrence_exceptions",
          constraint: "fk_pc_exception_series_owner",
          position: 1,
          column: "series_item_id",
          referencedTable: "personal_calendar_items",
          referencedColumn: "id",
          deleteRule: "CASCADE",
        },
        {
          table: "personal_calendar_occurrence_exceptions",
          constraint: "fk_pc_exception_series_owner",
          position: 2,
          column: "owner_user_id",
          referencedTable: "personal_calendar_items",
          referencedColumn: "owner_user_id",
          deleteRule: "CASCADE",
        },
        {
          table: "personal_calendar_occurrences",
          constraint: "fk_pc_occurrence_item_owner",
          position: 1,
          column: "item_id",
          referencedTable: "personal_calendar_items",
          referencedColumn: "id",
          deleteRule: "CASCADE",
        },
        {
          table: "personal_calendar_occurrences",
          constraint: "fk_pc_occurrence_item_owner",
          position: 2,
          column: "owner_user_id",
          referencedTable: "personal_calendar_items",
          referencedColumn: "owner_user_id",
          deleteRule: "CASCADE",
        },
        {
          table: "personal_calendar_recurrences",
          constraint: "fk_pc_recurrence_item_owner",
          position: 1,
          column: "item_id",
          referencedTable: "personal_calendar_items",
          referencedColumn: "id",
          deleteRule: "CASCADE",
        },
        {
          table: "personal_calendar_recurrences",
          constraint: "fk_pc_recurrence_item_owner",
          position: 2,
          column: "owner_user_id",
          referencedTable: "personal_calendar_items",
          referencedColumn: "owner_user_id",
          deleteRule: "CASCADE",
        },
      ]);
    });

    it("aceita somente os três formatos válidos de item pessoal", async () => {
      await database.execute(
        `INSERT INTO personal_calendar_items (
          owner_user_id, client_mutation_id, kind, title,
          start_local_date, start_local_time, end_local_date, end_local_time,
          all_day, availability, time_zone
        ) VALUES (?, ?, 'APPOINTMENT', ?, ?, ?, ?, ?, 0, 'BUSY', ?)`,
        [
          1,
          "appointment-1",
          "Consulta",
          "2026-09-10",
          "09:00:00",
          "2026-09-10",
          "10:00:00",
          "America/Fortaleza",
        ],
      );
      await database.execute(
        `INSERT INTO personal_calendar_items (
          owner_user_id, client_mutation_id, kind, title,
          start_local_date, start_local_time, all_day, availability, time_zone
        ) VALUES (?, ?, 'REMINDER', ?, ?, ?, 0, 'FREE', ?)`,
        [
          1,
          "reminder-1",
          "Ligar para a clínica",
          "2026-09-10",
          "08:30:00",
          "America/Fortaleza",
        ],
      );
      await database.execute(
        `INSERT INTO personal_calendar_items (
          owner_user_id, client_mutation_id, kind, title,
          birthday_month, birthday_day, all_day, availability, time_zone
        ) VALUES (?, ?, 'BIRTHDAY', ?, 2, 29, 1, 'FREE', ?)`,
        [1, "birthday-1", "Aniversário de Ana", "America/Fortaleza"],
      );

      await database.execute(
        `INSERT INTO personal_calendar_items (
          owner_user_id, client_mutation_id, kind, title,
          start_local_date, all_day, availability, time_zone
        ) VALUES (1, 'Appointment-1', 'REMINDER', 'Case-sensitive',
          '2026-09-10', 1, 'FREE', 'America/Fortaleza')`,
      );
      await database.execute(
        `INSERT INTO personal_calendar_items (
          owner_user_id, client_mutation_id, kind, title,
          start_local_date, all_day, availability, time_zone
        ) VALUES (2, 'appointment-1', 'REMINDER', 'Outro owner',
          '2026-09-10', 1, 'FREE', 'America/Fortaleza')`,
      );
      await expect(
        database.execute(
          `INSERT INTO personal_calendar_items (
            owner_user_id, client_mutation_id, kind, title,
            start_local_date, all_day, availability, time_zone
          ) VALUES (1, 'appointment-1', 'REMINDER', 'Duplicado',
            '2026-09-10', 1, 'FREE', 'America/Fortaleza')`,
        ),
      ).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });

      await expect(
        database.execute(
          `INSERT INTO personal_calendar_items (
            owner_user_id, client_mutation_id, kind, title,
            start_local_date, all_day, availability, time_zone
          ) VALUES (1, '', 'REMINDER', 'Sem chave',
            '2026-09-10', 1, 'FREE', 'America/Fortaleza')`,
        ),
      ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });

      await expect(
        database.execute(
          `INSERT INTO personal_calendar_items (
            owner_user_id, client_mutation_id, kind, title,
            start_local_date, all_day, time_zone
          ) VALUES (1, 'missing-availability', 'REMINDER', 'Sem semântica',
            '2026-09-10', 1, 'America/Fortaleza')`,
        ),
      ).rejects.toMatchObject({ code: "ER_NO_DEFAULT_FOR_FIELD" });

      await expect(
        database.execute(
          `INSERT INTO personal_calendar_items (
            owner_user_id, client_mutation_id, kind, title,
            start_local_date, all_day, availability, time_zone, version
          ) VALUES (1, 'bad-version', 'REMINDER', 'Versão inválida',
            '2026-09-10', 1, 'FREE', 'America/Fortaleza', 0)`,
        ),
      ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });

      await expect(
        database.execute(
          `INSERT INTO personal_calendar_items (
            owner_user_id, client_mutation_id, kind, title,
            start_local_date, start_local_time, end_local_date, end_local_time,
            all_day, availability, time_zone
          ) VALUES (1, 'bad-range', 'APPOINTMENT', 'Inválido',
            '2026-09-10', '10:00:00', '2026-09-10', '09:00:00',
            0, 'BUSY', 'America/Fortaleza')`,
        ),
      ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });

      await expect(
        database.execute(
          `INSERT INTO personal_calendar_items (
            owner_user_id, client_mutation_id, kind, title,
            birthday_month, birthday_day, all_day, availability, time_zone
          ) VALUES (1, 'bad-birthday', 'BIRTHDAY', 'Inválido',
            2, 30, 1, 'FREE', 'America/Fortaleza')`,
        ),
      ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });

      await expect(
        database.execute(
          `INSERT INTO personal_calendar_items (
            owner_user_id, client_mutation_id, kind, title,
            start_local_date, all_day, availability, time_zone
          ) VALUES (1, 'busy-reminder', 'REMINDER', 'Inválido',
            '2026-09-10', 1, 'BUSY', 'America/Fortaleza')`,
        ),
      ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
    });

    it("preserva ownership em recorrência, ocorrência e exceção", async () => {
      const [appointmentRows] = await database.query<RowDataPacket[]>(`
        SELECT id FROM personal_calendar_items
        WHERE owner_user_id = 1 AND client_mutation_id = 'appointment-1'
      `);
      const appointmentId = Number(appointmentRows[0].id);
      const [reminderRows] = await database.query<RowDataPacket[]>(`
        SELECT id FROM personal_calendar_items
        WHERE owner_user_id = 1 AND client_mutation_id = 'reminder-1'
      `);
      const reminderId = Number(reminderRows[0].id);

      await database.execute(
        `INSERT INTO personal_calendar_recurrences (
          item_id, owner_user_id, frequency, interval_count, weekdays_mask,
          invalid_date_policy, termination
        ) VALUES (?, 1, 'WEEKLY', 1, 42, 'SKIP', 'NEVER')`,
        [appointmentId],
      );
      await expect(
        database.execute(
          `INSERT INTO personal_calendar_recurrences (
            item_id, owner_user_id, frequency, interval_count, weekdays_mask,
            invalid_date_policy, termination
          ) VALUES (?, 1, 'MONTHLY', 1, 2, 'SKIP', 'NEVER')`,
          [reminderId],
        ),
      ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });

      await database.execute(
        `INSERT INTO personal_calendar_alert_rules (
          item_id, owner_user_id, minutes_before
        ) VALUES (?, 1, 10080), (?, 1, 30)`,
        [appointmentId, appointmentId],
      );
      await expect(
        database.execute(
          `INSERT INTO personal_calendar_alert_rules (
            item_id, owner_user_id, minutes_before
          ) VALUES (?, 2, 60)`,
          [appointmentId],
        ),
      ).rejects.toMatchObject({ code: "ER_NO_REFERENCED_ROW_2" });
      await expect(
        database.execute(
          `INSERT INTO personal_calendar_alert_rules (
            item_id, owner_user_id, minutes_before
          ) VALUES (?, 1, 525601)`,
          [appointmentId],
        ),
      ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
      await expect(
        database.execute(
          `INSERT INTO personal_calendar_recurrences (
            item_id, owner_user_id, frequency, interval_count, weekdays_mask,
            invalid_date_policy, termination
          ) VALUES (?, 2, 'WEEKLY', 1, 42, 'SKIP', 'NEVER')`,
          [reminderId],
        ),
      ).rejects.toMatchObject({ code: "ER_NO_REFERENCED_ROW_2" });

      await expect(
        database.execute(
          `INSERT INTO personal_calendar_occurrences (
            item_id, owner_user_id, occurrence_key, original_local_date,
            starts_at_utc, ends_at_utc, source_version
          ) VALUES (?, 1, '', '2026-09-10',
            '2026-09-10 12:00:00', '2026-09-10 13:00:00', 1)`,
          [appointmentId],
        ),
      ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });

      await database.execute(
        `INSERT INTO personal_calendar_occurrences (
          item_id, owner_user_id, occurrence_key, original_local_date,
          original_local_time, starts_at_utc, ends_at_utc, source_version
        ) VALUES (?, 1, 'occurrence-1', '2026-09-10', '09:00:00',
          '2026-09-10 12:00:00', '2026-09-10 13:00:00', 1)`,
        [appointmentId],
      );
      await expect(
        database.execute(
          `INSERT INTO personal_calendar_occurrences (
            item_id, owner_user_id, occurrence_key, original_local_date,
            starts_at_utc, ends_at_utc, source_version
          ) VALUES (?, 2, 'foreign-owner', '2026-09-10',
            '2026-09-10 12:00:00', '2026-09-10 13:00:00', 1)`,
          [appointmentId],
        ),
      ).rejects.toMatchObject({ code: "ER_NO_REFERENCED_ROW_2" });

      const [replacementResult] = await database.execute<ResultSetHeader>(
        `INSERT INTO personal_calendar_items (
          owner_user_id, client_mutation_id, kind, title,
          start_local_date, start_local_time, end_local_date, end_local_time,
          all_day, availability, time_zone
        ) VALUES (1, 'replacement-1', 'APPOINTMENT', 'Consulta alterada',
          '2026-09-10', '11:00:00', '2026-09-10', '12:00:00',
          0, 'BUSY', 'America/Fortaleza')`,
      );
      await database.execute(
        `INSERT INTO personal_calendar_occurrence_exceptions (
          series_item_id, owner_user_id, occurrence_key, action,
          replacement_item_id
        ) VALUES (?, 1, 'occurrence-1', 'REPLACED', ?)`,
        [appointmentId, Number(replacementResult.insertId)],
      );

      await expect(
        database.execute(
          `INSERT INTO personal_calendar_occurrence_exceptions (
            series_item_id, owner_user_id, occurrence_key, action,
            replacement_item_id
          ) VALUES (?, 1, 'bad-cancel', 'CANCELLED', ?)`,
          [appointmentId, Number(replacementResult.insertId)],
        ),
      ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });

      await expect(
        database.execute(
          `INSERT INTO personal_calendar_occurrence_exceptions (
            series_item_id, owner_user_id, occurrence_key, action
          ) VALUES (?, 1, '', 'CANCELLED')`,
          [appointmentId],
        ),
      ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
    });

    it("cascateia o grafo completo somente na remoção física da conta", async () => {
      await database.execute("DELETE FROM users WHERE id IN (1, 2)");
      for (const table of [
        "personal_calendar_alert_rules",
        "personal_calendar_recurrences",
        "personal_calendar_occurrences",
        "personal_calendar_occurrence_exceptions",
        "personal_calendar_items",
      ]) {
        const [rows] = await database.query<RowDataPacket[]>(
          `SELECT COUNT(*) AS total FROM ${quoteIdentifier(table)}`,
        );
        expect(Number(rows[0].total), table).toBe(0);
      }
    });

    it("recusa estado parcial antes de criar as tabelas restantes", async () => {
      const temporary = await createTemporaryDatabase(admin);
      try {
        await temporary.connection.query(`
          CREATE TABLE personal_calendar_items (
            id INT NOT NULL AUTO_INCREMENT,
            PRIMARY KEY (id)
          ) ENGINE=InnoDB;
        `);
        await expect(
          temporary.connection.query(migration),
        ).rejects.toMatchObject({
          code: "ER_INVALID_JSON_TEXT_IN_PARAM",
          sql: expect.stringContaining("PERSONAL_CALENDAR_PARTIAL_SCHEMA"),
        });
        const [tables] = await temporary.connection.query<RowDataPacket[]>(`
          SELECT TABLE_NAME
          FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME LIKE 'personal_calendar_%'
        `);
        expect(tables.map((row) => row.TABLE_NAME)).toEqual([
          "personal_calendar_items",
        ]);
      } finally {
        await temporary.connection.end();
        await admin.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(temporary.schemaName)}`,
        );
      }
    });

    it("recusa contrato homônimo alterado e preserva os dados", async () => {
      const temporary = await createTemporaryDatabase(admin);
      try {
        await temporary.connection.query(migration);
        await temporary.connection.execute(
          `INSERT INTO personal_calendar_items (
            owner_user_id, client_mutation_id, kind, title,
            start_local_date, all_day, availability, time_zone
          ) VALUES (1, 'sentinel', 'REMINDER', 'Não apagar',
            '2026-09-12', 1, 'FREE', 'America/Fortaleza')`,
        );
        await temporary.connection.query(
          "ALTER TABLE personal_calendar_items MODIFY time_zone VARCHAR(63) NOT NULL",
        );

        await expect(
          temporary.connection.query(migration),
        ).rejects.toMatchObject({
          code: "ER_INVALID_JSON_TEXT_IN_PARAM",
          sql: expect.stringContaining(
            "PERSONAL_CALENDAR_SCHEMA_CONTRACT_MISMATCH",
          ),
        });
        const [sentinel] = await temporary.connection.query<RowDataPacket[]>(`
          SELECT title FROM personal_calendar_items
          WHERE client_mutation_id = 'sentinel'
        `);
        expect(sentinel).toEqual([{ title: "Não apagar" }]);
      } finally {
        await temporary.connection.end();
        await admin.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(temporary.schemaName)}`,
        );
      }
    });

    it("preserva dados na sequência foundation → hardening → reruns", async () => {
      const temporary = await createTemporaryDatabase(admin);
      try {
        await runFoundationHardeningRerunSequence(
          temporary.connection,
          async () => {
            await temporary.connection.execute(
              `INSERT INTO personal_calendar_items (
                owner_user_id, client_mutation_id, kind, title,
                start_local_date, all_day, availability, time_zone
              ) VALUES (1, 'sequence-sentinel', 'REMINDER', 'Preservar',
                '2026-09-12', 1, 'FREE', 'America/Fortaleza')`,
            );
          },
        );

        const [sentinel] = await temporary.connection.query<RowDataPacket[]>(`
          SELECT title FROM personal_calendar_items
          WHERE client_mutation_id = 'sequence-sentinel'
        `);
        expect(sentinel).toEqual([{ title: "Preservar" }]);
      } finally {
        await temporary.connection.end();
        await admin.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(temporary.schemaName)}`,
        );
      }
    });

    it("mantém o schema Drizzle fisicamente compatível com a migration manual", async () => {
      const freshSchemaName = temporaryDatabaseName();
      await admin.query(`CREATE DATABASE ${quoteIdentifier(freshSchemaName)}`);
      try {
        runFreshSchemaPush(freshSchemaName);
        const freshConnection = await mysql.createConnection({
          ...server!,
          database: freshSchemaName,
          multipleStatements: true,
        });
        try {
          await freshConnection.query(migration);
          await freshConnection.query(migration);
        } finally {
          await freshConnection.end();
        }
      } finally {
        await admin.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(freshSchemaName)}`,
        );
      }
    }, 120_000);
  },
);
