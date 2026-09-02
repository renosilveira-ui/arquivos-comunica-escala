import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";

const rawServerUrl =
  process.env.VACANCY_QUERY_INDEXES_MIGRATION_TEST_SERVER_URL;
const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-02-vacancy-query-indexes.sql",
    import.meta.url,
  ),
  "utf8",
);

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
      "VACANCY_QUERY_INDEXES_MIGRATION_TEST_SERVER_URL deve apontar para mysql:// local e o schema mysql.",
    );
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z0-9_]+$/.test(identifier)) {
    throw new Error("Identificador de teste inválido.");
  }
  return `\`${identifier}\``;
}

const server = parseLocalServer(rawServerUrl);
const describeWithMysql = server ? describe : describe.skip;

const prerequisitesSql = `
  CREATE TABLE professional_access (
    id INT NOT NULL AUTO_INCREMENT,
    institution_id INT NOT NULL,
    professional_id INT NOT NULL,
    hospital_id INT NOT NULL,
    sector_id INT NULL,
    can_access BOOLEAN NOT NULL,
    PRIMARY KEY (id)
  ) ENGINE=InnoDB;
  CREATE TABLE manager_scope (
    id INT NOT NULL AUTO_INCREMENT,
    institution_id INT NOT NULL,
    manager_professional_id INT NOT NULL,
    hospital_id INT NOT NULL,
    sector_id INT NULL,
    active BOOLEAN NOT NULL,
    PRIMARY KEY (id)
  ) ENGINE=InnoDB;
  CREATE TABLE shift_instances (
    id INT NOT NULL AUTO_INCREMENT,
    institution_id INT NOT NULL,
    schedule_context_id INT NULL,
    status VARCHAR(20) NOT NULL,
    start_at TIMESTAMP NOT NULL,
    PRIMARY KEY (id)
  ) ENGINE=InnoDB;
  CREATE TABLE shift_assignments_v2 (
    id INT NOT NULL AUTO_INCREMENT,
    shift_instance_id INT NOT NULL,
    professional_id INT NOT NULL,
    is_active BOOLEAN NOT NULL,
    PRIMARY KEY (id)
  ) ENGINE=InnoDB;
`;

describeWithMysql("migration dos índices de Vagas em MySQL isolado", () => {
  let admin: Connection;
  let database: Connection;
  let mismatchDatabase: Connection;
  let postflightMismatchDatabase: Connection;
  let schemaName: string;
  let mismatchSchemaName: string;
  let postflightMismatchSchemaName: string;

  beforeAll(async () => {
    if (!server) throw new Error("Servidor local ausente.");
    schemaName = `escala_vacancy_indexes_${process.pid}_${Date.now()}`;
    mismatchSchemaName = `${schemaName}_mismatch`;
    postflightMismatchSchemaName = `${schemaName}_postflight_mismatch`;
    admin = await mysql.createConnection({ ...server, database: "mysql" });
    await admin.query(`CREATE DATABASE ${quoteIdentifier(schemaName)}`);
    await admin.query(`CREATE DATABASE ${quoteIdentifier(mismatchSchemaName)}`);
    await admin.query(
      `CREATE DATABASE ${quoteIdentifier(postflightMismatchSchemaName)}`,
    );
    database = await mysql.createConnection({
      ...server,
      database: schemaName,
      multipleStatements: true,
    });
    mismatchDatabase = await mysql.createConnection({
      ...server,
      database: mismatchSchemaName,
      multipleStatements: true,
    });
    postflightMismatchDatabase = await mysql.createConnection({
      ...server,
      database: postflightMismatchSchemaName,
      multipleStatements: true,
    });
    await database.query(prerequisitesSql);
    await mismatchDatabase.query(prerequisitesSql);
    await postflightMismatchDatabase.query(prerequisitesSql);
  });

  afterAll(async () => {
    try {
      await database?.end();
      await mismatchDatabase?.end();
      await postflightMismatchDatabase?.end();
    } finally {
      try {
        if (schemaName?.startsWith("escala_vacancy_indexes_")) {
          await admin?.query(
            `DROP DATABASE IF EXISTS ${quoteIdentifier(schemaName)}`,
          );
        }
        if (mismatchSchemaName?.startsWith("escala_vacancy_indexes_")) {
          await admin?.query(
            `DROP DATABASE IF EXISTS ${quoteIdentifier(mismatchSchemaName)}`,
          );
        }
        if (
          postflightMismatchSchemaName?.startsWith("escala_vacancy_indexes_")
        ) {
          await admin?.query(
            `DROP DATABASE IF EXISTS ${quoteIdentifier(postflightMismatchSchemaName)}`,
          );
        }
      } finally {
        await admin?.end();
      }
    }
  });

  it("aplica e reaplica mantendo as cinco coberturas exatas", async () => {
    await database.query(migration);
    await database.query(migration);

    const [rows] = await database.query<RowDataPacket[]>(`
      SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND INDEX_NAME IN (
          'idx_prof_access_actor_active',
          'idx_manager_scope_actor_active',
          'idx_shift_instances_vacancy_lookup',
          'idx_shift_assignments_shift_active',
          'idx_shift_assignments_prof_active'
        )
      ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
    `);

    expect(rows).toHaveLength(19);
    expect(
      rows.map((row) => ({
        tableName: String(row.TABLE_NAME),
        indexName: String(row.INDEX_NAME),
        sequence: Number(row.SEQ_IN_INDEX),
        columnName: String(row.COLUMN_NAME),
      })),
    ).toEqual([
      {
        tableName: "manager_scope",
        indexName: "idx_manager_scope_actor_active",
        sequence: 1,
        columnName: "institution_id",
      },
      {
        tableName: "manager_scope",
        indexName: "idx_manager_scope_actor_active",
        sequence: 2,
        columnName: "manager_professional_id",
      },
      {
        tableName: "manager_scope",
        indexName: "idx_manager_scope_actor_active",
        sequence: 3,
        columnName: "active",
      },
      {
        tableName: "manager_scope",
        indexName: "idx_manager_scope_actor_active",
        sequence: 4,
        columnName: "hospital_id",
      },
      {
        tableName: "manager_scope",
        indexName: "idx_manager_scope_actor_active",
        sequence: 5,
        columnName: "sector_id",
      },
      {
        tableName: "professional_access",
        indexName: "idx_prof_access_actor_active",
        sequence: 1,
        columnName: "institution_id",
      },
      {
        tableName: "professional_access",
        indexName: "idx_prof_access_actor_active",
        sequence: 2,
        columnName: "professional_id",
      },
      {
        tableName: "professional_access",
        indexName: "idx_prof_access_actor_active",
        sequence: 3,
        columnName: "can_access",
      },
      {
        tableName: "professional_access",
        indexName: "idx_prof_access_actor_active",
        sequence: 4,
        columnName: "hospital_id",
      },
      {
        tableName: "professional_access",
        indexName: "idx_prof_access_actor_active",
        sequence: 5,
        columnName: "sector_id",
      },
      {
        tableName: "shift_assignments_v2",
        indexName: "idx_shift_assignments_prof_active",
        sequence: 1,
        columnName: "professional_id",
      },
      {
        tableName: "shift_assignments_v2",
        indexName: "idx_shift_assignments_prof_active",
        sequence: 2,
        columnName: "is_active",
      },
      {
        tableName: "shift_assignments_v2",
        indexName: "idx_shift_assignments_prof_active",
        sequence: 3,
        columnName: "shift_instance_id",
      },
      {
        tableName: "shift_assignments_v2",
        indexName: "idx_shift_assignments_shift_active",
        sequence: 1,
        columnName: "shift_instance_id",
      },
      {
        tableName: "shift_assignments_v2",
        indexName: "idx_shift_assignments_shift_active",
        sequence: 2,
        columnName: "is_active",
      },
      {
        tableName: "shift_instances",
        indexName: "idx_shift_instances_vacancy_lookup",
        sequence: 1,
        columnName: "institution_id",
      },
      {
        tableName: "shift_instances",
        indexName: "idx_shift_instances_vacancy_lookup",
        sequence: 2,
        columnName: "status",
      },
      {
        tableName: "shift_instances",
        indexName: "idx_shift_instances_vacancy_lookup",
        sequence: 3,
        columnName: "schedule_context_id",
      },
      {
        tableName: "shift_instances",
        indexName: "idx_shift_instances_vacancy_lookup",
        sequence: 4,
        columnName: "start_at",
      },
    ]);
  });

  it("recusa contrato homônimo incompatível antes de qualquer outro DDL", async () => {
    await mismatchDatabase.query(`
      CREATE TABLE vacancy_query_indexes_contract_mismatch (id INT);
      CREATE TABLE vacancy_query_indexes_postflight_mismatch (id INT);
    `);
    await mismatchDatabase.query(
      "CREATE INDEX idx_shift_assignments_prof_active ON shift_assignments_v2 (professional_id)",
    );

    await expect(mismatchDatabase.query(migration)).rejects.toThrow();

    const [rows] = await mismatchDatabase.query<RowDataPacket[]>(`
      SELECT INDEX_NAME
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND INDEX_NAME IN (
          'idx_prof_access_actor_active',
          'idx_manager_scope_actor_active',
          'idx_shift_instances_vacancy_lookup',
          'idx_shift_assignments_shift_active'
        )
    `);
    expect(rows).toEqual([]);
  });

  it("faz o postflight falhar mesmo quando tabelas sentinela existem", async () => {
    await postflightMismatchDatabase.query(`
      CREATE TABLE vacancy_query_indexes_contract_mismatch (id INT);
      CREATE TABLE vacancy_query_indexes_postflight_mismatch (id INT);
    `);
    const expectedDdl =
      "ALTER TABLE shift_assignments_v2 ADD INDEX idx_shift_assignments_prof_active (professional_id, is_active, shift_instance_id)";
    const migrationWithoutOneIndex = migration.replace(expectedDdl, "SELECT 1");
    expect(migrationWithoutOneIndex).not.toBe(migration);

    await expect(
      postflightMismatchDatabase.query(migrationWithoutOneIndex),
    ).rejects.toThrow();

    const [rows] = await postflightMismatchDatabase.query<RowDataPacket[]>(`
      SELECT INDEX_NAME
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND INDEX_NAME = 'idx_shift_assignments_prof_active'
    `);
    expect(rows).toEqual([]);
  });
});
