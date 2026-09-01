import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql, {
  type Connection,
  type RowDataPacket,
} from "mysql2/promise";

const MIGRATION_TEST_SERVER_URL =
  process.env.SECTOR_SERVICE_SPECIALTIES_MIGRATION_TEST_SERVER_URL;
const TEMPORARY_DATABASE_PREFIX = "escala_sss_validation_";

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
  const host = url.hostname.toLowerCase();
  const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (
    url.protocol !== "mysql:" ||
    !localHosts.has(host) ||
    url.pathname !== "/mysql" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "SECTOR_SERVICE_SPECIALTIES_MIGRATION_TEST_SERVER_URL deve apontar somente para mysql:// local e o schema mysql.",
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
  const suffix = `${process.pid}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
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
    "../drizzle/migrations/manual/2026-08-31-sector-service-specialties.sql",
    import.meta.url,
  ),
  "utf8",
);
const server = parseMigrationTestServer(MIGRATION_TEST_SERVER_URL);
const describeWithIsolatedMysql = server ? describe : describe.skip;

async function createMigrationPrerequisites(connection: Connection) {
  await connection.query(`
    CREATE TABLE institutions (
      id INT NOT NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB;
    CREATE TABLE hospitals (
      id INT NOT NULL,
      institution_id INT NOT NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB;
    CREATE TABLE sectors (
      id INT NOT NULL,
      institution_id INT NOT NULL,
      hospital_id INT NOT NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB;
    CREATE TABLE medical_specialties (
      id INT NOT NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB;
    CREATE TABLE audit_trail (
      id INT NOT NULL AUTO_INCREMENT,
      action ENUM('SHIFT_CREATED', 'ASSIGNMENT_CREATED')
        CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
      entity_type ENUM('SHIFT_INSTANCE', 'SHIFT_ASSIGNMENT')
        CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB;
  `);
}

describeWithIsolatedMysql(
  "migration de especialidades assistenciais em MySQL isolado",
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

      await createMigrationPrerequisites(database);
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

    it("aplica e reaplica sem alterar o contrato, preservando FKs e índices", async () => {
      await database.query(migration);
      await database.query(migration);

      const [tableRows] = await database.query<RowDataPacket[]>(
        `
          SELECT TABLE_NAME
          FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'sector_service_specialties'
        `,
      );
      expect(tableRows).toEqual([{ TABLE_NAME: "sector_service_specialties" }]);

      const [indexRows] = await database.query<RowDataPacket[]>(
        `
          SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
          FROM INFORMATION_SCHEMA.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'sector_service_specialties'
            AND INDEX_NAME IN (
              'uniq_sector_service_specialty',
              'idx_sector_service_specialty_specialty'
            )
          ORDER BY INDEX_NAME, SEQ_IN_INDEX
        `,
      );
      expect(
        indexRows.map((row) => [
          row.INDEX_NAME,
          Number(row.NON_UNIQUE),
          Number(row.SEQ_IN_INDEX),
          row.COLUMN_NAME,
        ]),
      ).toEqual([
        ["idx_sector_service_specialty_specialty", 1, 1, "medical_specialty_id"],
        ["idx_sector_service_specialty_specialty", 1, 2, "institution_id"],
        ["uniq_sector_service_specialty", 0, 1, "institution_id"],
        ["uniq_sector_service_specialty", 0, 2, "hospital_id"],
        ["uniq_sector_service_specialty", 0, 3, "sector_id"],
        ["uniq_sector_service_specialty", 0, 4, "medical_specialty_id"],
      ]);

      const [foreignKeyRows] = await database.query<RowDataPacket[]>(
        `
          SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME,
            REFERENCED_COLUMN_NAME, ORDINAL_POSITION
          FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'sector_service_specialties'
            AND REFERENCED_TABLE_NAME IS NOT NULL
          ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION
        `,
      );
      expect(
        foreignKeyRows.map((row) => [
          row.CONSTRAINT_NAME,
          row.COLUMN_NAME,
          row.REFERENCED_TABLE_NAME,
          row.REFERENCED_COLUMN_NAME,
        ]),
      ).toEqual([
        ["fk_sector_service_specialty_hospital", "hospital_id", "hospitals", "id"],
        ["fk_sector_service_specialty_institution", "institution_id", "institutions", "id"],
        [
          "fk_sector_service_specialty_medical_specialty",
          "medical_specialty_id",
          "medical_specialties",
          "id",
        ],
        ["fk_sector_service_specialty_sector", "sector_id", "sectors", "id"],
        [
          "fk_sector_service_specialty_topology",
          "institution_id",
          "sectors",
          "institution_id",
        ],
        [
          "fk_sector_service_specialty_topology",
          "hospital_id",
          "sectors",
          "hospital_id",
        ],
        [
          "fk_sector_service_specialty_topology",
          "sector_id",
          "sectors",
          "id",
        ],
      ]);

      const [auditColumns] = await database.query<RowDataPacket[]>(
        `
          SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
            COLUMN_COMMENT
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'audit_trail'
            AND COLUMN_NAME IN ('action', 'entity_type')
          ORDER BY COLUMN_NAME
        `,
      );
      const auditByColumn = Object.fromEntries(
        auditColumns.map((column) => [column.COLUMN_NAME, column]),
      );
      expect(auditByColumn.action).toMatchObject({
        IS_NULLABLE: "NO",
        COLUMN_DEFAULT: null,
        COLUMN_COMMENT: "",
      });
      expect(auditByColumn.entity_type).toMatchObject({
        IS_NULLABLE: "NO",
        COLUMN_DEFAULT: null,
        COLUMN_COMMENT: "",
      });
      expect(auditByColumn.action.COLUMN_TYPE).toContain(
        "'SECTOR_SERVICE_SPECIALTIES_UPDATED'",
      );
      expect(auditByColumn.entity_type.COLUMN_TYPE).toContain("'SECTOR'");
      expect(
        (auditByColumn.action.COLUMN_TYPE.match(
          /'SECTOR_SERVICE_SPECIALTIES_UPDATED'/g,
        ) ?? []).length,
      ).toBe(1);
      expect(
        (auditByColumn.entity_type.COLUMN_TYPE.match(/'SECTOR'/g) ?? []).length,
      ).toBe(1);

      await database.query(
        "INSERT INTO institutions (id) VALUES (1); INSERT INTO hospitals (id, institution_id) VALUES (10, 1), (11, 1); INSERT INTO sectors (id, institution_id, hospital_id) VALUES (20, 1, 10); INSERT INTO medical_specialties (id) VALUES (30)",
      );
      await database.execute(
        "INSERT INTO sector_service_specialties (institution_id, hospital_id, sector_id, medical_specialty_id) VALUES (?, ?, ?, ?)",
        [1, 10, 20, 30],
      );
      await expect(
        database.execute(
          "INSERT INTO sector_service_specialties (institution_id, hospital_id, sector_id, medical_specialty_id) VALUES (?, ?, ?, ?)",
          [1, 10, 20, 30],
        ),
      ).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
      await expect(
        database.execute(
          "INSERT INTO sector_service_specialties (institution_id, hospital_id, sector_id, medical_specialty_id) VALUES (?, ?, ?, ?)",
          [1, 11, 20, 30],
        ),
      ).rejects.toMatchObject({ code: "ER_NO_REFERENCED_ROW_2" });
    });

    it("falha antes de reinterpretar uma tabela parcial preexistente", async () => {
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
        await createMigrationPrerequisites(partialDatabase);
        await partialDatabase.query(`
          CREATE TABLE sector_service_specialties (
            id INT NOT NULL AUTO_INCREMENT,
            institution_id INT NOT NULL,
            hospital_id INT NOT NULL,
            sector_id INT NOT NULL,
            medical_specialty_id INT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (id),
            UNIQUE KEY uniq_sector_service_specialty (institution_id)
          ) ENGINE=InnoDB;
          INSERT INTO sector_service_specialties
            (institution_id, hospital_id, sector_id, medical_specialty_id)
          VALUES (1, 10, 20, 30);
        `);

        await expect(partialDatabase.query(migration)).rejects.toMatchObject({
          code: "ER_NO_SUCH_TABLE",
          message: expect.stringContaining(
            "sector_service_specialties_existing_table_contract_mismatch",
          ),
        });

        const [wrongIndexRows] = await partialDatabase.query<RowDataPacket[]>(
          `
            SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
            FROM INFORMATION_SCHEMA.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'sector_service_specialties'
              AND INDEX_NAME = 'uniq_sector_service_specialty'
            ORDER BY SEQ_IN_INDEX
          `,
        );
        expect(
          wrongIndexRows.map((row) => [
            row.INDEX_NAME,
            Number(row.NON_UNIQUE),
            Number(row.SEQ_IN_INDEX),
            row.COLUMN_NAME,
          ]),
        ).toEqual([["uniq_sector_service_specialty", 0, 1, "institution_id"]]);

        const [existingRows] = await partialDatabase.query<RowDataPacket[]>(
          `
            SELECT institution_id, hospital_id, sector_id, medical_specialty_id
            FROM sector_service_specialties
          `,
        );
        expect(existingRows).toEqual([
          {
            institution_id: 1,
            hospital_id: 10,
            sector_id: 20,
            medical_specialty_id: 30,
          },
        ]);

        const [foreignKeyRows] = await partialDatabase.query<RowDataPacket[]>(
          `
            SELECT CONSTRAINT_NAME
            FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
            WHERE CONSTRAINT_SCHEMA = DATABASE()
              AND TABLE_NAME = 'sector_service_specialties'
              AND CONSTRAINT_TYPE = 'FOREIGN KEY'
          `,
        );
        expect(foreignKeyRows).toEqual([]);
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
