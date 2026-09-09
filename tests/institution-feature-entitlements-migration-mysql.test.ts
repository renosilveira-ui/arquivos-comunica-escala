import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";

const TEST_SERVER_URL =
  process.env.INSTITUTION_FEATURE_MIGRATION_TEST_SERVER_URL;
const TEMPORARY_DATABASE_PREFIX = "escala_feature_validation_";

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
      "INSTITUTION_FEATURE_MIGRATION_TEST_SERVER_URL deve apontar somente para mysql:// local e o schema mysql.",
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
  if (!/^[a-z0-9_]+$/.test(name))
    throw new Error("Nome de schema de teste inválido.");
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
    "../drizzle/migrations/manual/2026-09-08-institution-feature-entitlements.sql",
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
    CREATE TABLE institutions (
      id INT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB;
    CREATE TABLE audit_trail (
      id INT NOT NULL AUTO_INCREMENT,
      action ENUM('SHIFT_CREATED', 'SECTOR_SERVICE_SPECIALTIES_UPDATED')
        CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
      entity_type ENUM('SHIFT_INSTANCE', 'SECTOR')
        CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB;
  `);
}

describeWithIsolatedMysql(
  "migration de recursos por instituição em MySQL isolado",
  () => {
    let admin: Connection;
    let database: Connection;
    let schemaName: string;

    beforeAll(async () => {
      if (!server) throw new Error("Servidor de migration de teste ausente.");
      schemaName = temporaryDatabaseName();
      admin = await mysql.createConnection({ ...server, database: "mysql" });
      await admin.query(`CREATE DATABASE ${quoteIdentifier(schemaName)}`);
      database = await mysql.createConnection({
        ...server,
        database: schemaName,
        multipleStatements: true,
      });
      await createPrerequisites(database);
      await database.query(`
      INSERT INTO institutions (id, created_at) VALUES
        (1, FROM_UNIXTIME(1788900000)),
        (2, FROM_UNIXTIME(1788910000));
    `);
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

    it("habilita existentes sem corte e reaplica sem desfazer override", async () => {
      await database.query(migration);

      const [initialRows] = await database.query<RowDataPacket[]>(`
      SELECT institution_id, feature_code, enabled, source, version,
        updated_by_user_id
      FROM institution_feature_entitlements
      ORDER BY institution_id
    `);
      expect(initialRows).toEqual([
        {
          institution_id: 1,
          feature_code: "CROSS_SCHEDULE_ROSTER_VIEW",
          enabled: 1,
          source: "LEGACY_COMPATIBILITY",
          version: 1,
          updated_by_user_id: null,
        },
        {
          institution_id: 2,
          feature_code: "CROSS_SCHEDULE_ROSTER_VIEW",
          enabled: 1,
          source: "LEGACY_COMPATIBILITY",
          version: 1,
          updated_by_user_id: null,
        },
      ]);

      await database.query(`
      INSERT INTO users (id) VALUES (50);
      UPDATE institution_feature_entitlements
      SET enabled = 0,
          source = 'ADMIN_OVERRIDE',
          version = 2,
          updated_by_user_id = 50
      WHERE institution_id = 1
        AND feature_code = 'CROSS_SCHEDULE_ROSTER_VIEW';
    `);
      await database.query(migration);

      const [rerunRows] = await database.query<RowDataPacket[]>(`
      SELECT institution_id, enabled, source, version, updated_by_user_id
      FROM institution_feature_entitlements
      ORDER BY institution_id
    `);
      expect(rerunRows).toEqual([
        {
          institution_id: 1,
          enabled: 0,
          source: "ADMIN_OVERRIDE",
          version: 2,
          updated_by_user_id: 50,
        },
        {
          institution_id: 2,
          enabled: 1,
          source: "LEGACY_COMPATIBILITY",
          version: 1,
          updated_by_user_id: null,
        },
      ]);

      await expect(
        database.execute(
          `INSERT INTO institution_feature_entitlements
          (institution_id, feature_code, enabled, source)
         VALUES (?, 'CROSS_SCHEDULE_ROSTER_VIEW', 1, 'ADMIN_OVERRIDE')`,
          [1],
        ),
      ).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });

      const [auditColumns] = await database.query<RowDataPacket[]>(`
      SELECT COLUMN_NAME, COLUMN_TYPE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'audit_trail'
        AND COLUMN_NAME IN ('action', 'entity_type')
      ORDER BY COLUMN_NAME
    `);
      const auditByColumn = Object.fromEntries(
        auditColumns.map((column) => [column.COLUMN_NAME, column.COLUMN_TYPE]),
      );
      expect(auditByColumn.action).toContain("'INSTITUTION_FEATURE_UPDATED'");
      expect(auditByColumn.entity_type).toContain("'INSTITUTION'");
      expect(
        (auditByColumn.action.match(/'INSTITUTION_FEATURE_UPDATED'/g) ?? [])
          .length,
      ).toBe(1);
      expect(
        (auditByColumn.entity_type.match(/'INSTITUTION'/g) ?? []).length,
      ).toBe(1);
    });

    it("recusa tabela parcial sem reinterpretar nem sobrescrever seus dados", async () => {
      if (!server) throw new Error("Servidor de migration de teste ausente.");
      const partialSchemaName = temporaryDatabaseName();
      let partialDatabase: Connection | undefined;

      try {
        await admin.query(
          `CREATE DATABASE ${quoteIdentifier(partialSchemaName)}`,
        );
        partialDatabase = await mysql.createConnection({
          ...server,
          database: partialSchemaName,
          multipleStatements: true,
        });
        await createPrerequisites(partialDatabase);
        await partialDatabase.query(`
          CREATE TABLE institution_feature_entitlements (
            id INT NOT NULL AUTO_INCREMENT,
            institution_id INT NOT NULL,
            feature_code VARCHAR(64) NOT NULL,
            enabled TINYINT(1) NOT NULL DEFAULT 0,
            PRIMARY KEY (id),
            UNIQUE KEY uniq_institution_feature (institution_id)
          ) ENGINE=InnoDB;
          INSERT INTO institution_feature_entitlements
            (institution_id, feature_code, enabled)
          VALUES (77, 'EXISTING_PARTIAL_DATA', 1);
        `);

        await expect(partialDatabase.query(migration)).rejects.toMatchObject({
          code: "ER_NO_SUCH_TABLE",
          message: expect.stringContaining(
            "institution_feature_entitlements_contract_mismatch",
          ),
        });

        const [existingRows] = await partialDatabase.query<RowDataPacket[]>(`
          SELECT institution_id, feature_code, enabled
          FROM institution_feature_entitlements
        `);
        expect(existingRows).toEqual([
          {
            institution_id: 77,
            feature_code: "EXISTING_PARTIAL_DATA",
            enabled: 1,
          },
        ]);

        const [auditColumns] = await partialDatabase.query<RowDataPacket[]>(`
          SELECT COLUMN_NAME, COLUMN_TYPE
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'audit_trail'
            AND COLUMN_NAME IN ('action', 'entity_type')
          ORDER BY COLUMN_NAME
        `);
        expect(
          auditColumns.every(
            (column) =>
              !String(column.COLUMN_TYPE).includes(
                "INSTITUTION_FEATURE_UPDATED",
              ) && !String(column.COLUMN_TYPE).includes("'INSTITUTION'"),
          ),
        ).toBe(true);
      } finally {
        await partialDatabase?.end();
        if (partialSchemaName.startsWith(TEMPORARY_DATABASE_PREFIX)) {
          await admin.query(
            `DROP DATABASE IF EXISTS ${quoteIdentifier(partialSchemaName)}`,
          );
        }
      }
    });
  },
);
