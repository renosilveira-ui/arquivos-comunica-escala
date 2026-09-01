import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { runUnimedHospitalProvisionPlan } from "../scripts/plan-unimed-hospital-provision";

const TEST_SERVER_URL = process.env.UNIMED_HOSPITAL_PROVISION_TEST_SERVER_URL;
const TEMPORARY_DATABASE_PREFIX = "escala_unimed_plan_";
const NESTED_TEMPORARY_DATABASE_PREFIX = "escala_unimed_partial_";
const FOREIGN_TEMPORARY_DATABASE_PREFIX = "escala_unimed_foreign_";

type TestServer = Readonly<{
  host: string;
  port: number;
  user: string;
  password: string;
}>;

function parseTestServer(raw: string | undefined): TestServer | null {
  if (!raw) return null;
  const url = new URL(raw);
  const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (
    url.protocol !== "mysql:" ||
    !localHosts.has(url.hostname.toLowerCase()) ||
    url.pathname !== "/mysql" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "UNIMED_HOSPITAL_PROVISION_TEST_SERVER_URL deve apontar somente para mysql:// local e o schema mysql.",
    );
  }
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

function temporaryDatabaseName(prefix = TEMPORARY_DATABASE_PREFIX): string {
  const name = `${prefix}${process.pid}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  if (!/^[a-z0-9_]+$/.test(name) || name.length > 64) {
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

function connectionUrl(server: TestServer, database: string): string {
  return `mysql://${encodeURIComponent(server.user)}:${encodeURIComponent(
    server.password,
  )}@${server.host}:${server.port}/${database}`;
}

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-08-31-sector-service-specialties.sql",
    import.meta.url,
  ),
  "utf8",
);
const server = parseTestServer(TEST_SERVER_URL);
const describeWithIsolatedMysql = server ? describe : describe.skip;

async function createPrerequisites(connection: Connection): Promise<void> {
  await connection.query(`
    CREATE TABLE institutions (
      id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      is_active BOOLEAN NOT NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB;
    CREATE TABLE hospitals (
      id INT NOT NULL AUTO_INCREMENT,
      institution_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB;
    CREATE TABLE sectors (
      id INT NOT NULL AUTO_INCREMENT,
      institution_id INT NOT NULL,
      hospital_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      category ENUM('internacao', 'cirurgico', 'servico') NOT NULL,
      color VARCHAR(7) NOT NULL,
      min_staff_count INT NOT NULL DEFAULT 2,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB;
    CREATE TABLE medical_specialties (
      id INT NOT NULL AUTO_INCREMENT,
      code VARCHAR(64) NOT NULL,
      active BOOLEAN NOT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_medical_specialty_code (code)
    ) ENGINE=InnoDB;
    CREATE TABLE audit_trail (
      id INT NOT NULL AUTO_INCREMENT,
      action ENUM('SHIFT_CREATED') CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
      entity_type ENUM('SHIFT_INSTANCE') CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB;
  `);
}

async function createNoInterferenceSentinels(
  connection: Connection,
): Promise<void> {
  await connection.query(`
    CREATE TABLE schedule_contexts (id INT NOT NULL PRIMARY KEY);
    CREATE TABLE professional_access (id INT NOT NULL PRIMARY KEY);
    CREATE TABLE schedule_invites (id INT NOT NULL PRIMARY KEY);
    CREATE TABLE shift_instances (id INT NOT NULL PRIMARY KEY);
    CREATE TABLE shift_assignments_v2 (id INT NOT NULL PRIMARY KEY);
    INSERT INTO schedule_contexts (id) VALUES (1);
    INSERT INTO professional_access (id) VALUES (1);
    INSERT INTO schedule_invites (id) VALUES (1);
    INSERT INTO shift_instances (id) VALUES (1);
    INSERT INTO shift_assignments_v2 (id) VALUES (1);
  `);
}

async function seedUnimed(connection: Connection): Promise<void> {
  await connection.query(`
    INSERT INTO institutions (id, name, is_active) VALUES (1, 'Unimed', TRUE);
    INSERT INTO hospitals (id, institution_id, name) VALUES
      (10, 1, 'Hospital Regional Unimed'),
      (11, 1, 'Hospital Unimed Sul');
    INSERT INTO sectors (id, institution_id, hospital_id, name, category, color) VALUES
      (101, 1, 10, 'Anestesia', 'cirurgico', '#2563EB'),
      (102, 1, 10, 'Cirurgia Geral', 'cirurgico', '#7C3AED'),
      (103, 1, 10, 'UTI', 'internacao', '#DC2626'),
      (104, 1, 10, 'Traumatologia e Ortopedia', 'cirurgico', '#D97706'),
      (105, 1, 10, 'Emergência', 'servico', '#059669'),
      (201, 1, 11, 'Pediatria', 'internacao', '#0EA5E9'),
      (202, 1, 11, 'Anestesia', 'cirurgico', '#2563EB'),
      (203, 1, 11, 'Ginecologia e Obstetrícia', 'internacao', '#DB2777');
    INSERT INTO medical_specialties (id, code, active) VALUES
      (1, 'ANESTESIOLOGIA', TRUE),
      (2, 'CIRURGIA_GERAL', TRUE),
      (3, 'MEDICINA_INTENSIVA', TRUE),
      (4, 'ORTOPEDIA_E_TRAUMATOLOGIA', TRUE),
      (5, 'MEDICINA_DE_EMERGENCIA', TRUE),
      (6, 'PEDIATRIA', TRUE),
      (7, 'GINECOLOGIA_E_OBSTETRICIA', TRUE),
      (8, 'CARDIOLOGIA', TRUE);
    INSERT INTO sector_service_specialties
      (institution_id, hospital_id, sector_id, medical_specialty_id)
    VALUES
      (1, 10, 101, 1),
      (1, 11, 201, 8);
  `);
}

async function tableCounts(
  connection: Connection,
): Promise<Record<string, number>> {
  const names = [
    "hospitals",
    "sectors",
    "sector_service_specialties",
    "schedule_contexts",
    "professional_access",
    "schedule_invites",
    "shift_instances",
    "shift_assignments_v2",
  ];
  const result: Record<string, number> = {};
  for (const name of names) {
    const [rows] = await connection.query<
      (RowDataPacket & { count: number })[]
    >(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`);
    result[name] = Number(rows[0]!.count);
  }
  return result;
}

function testEnv(database: string): NodeJS.ProcessEnv {
  if (!server) throw new Error("Servidor MySQL isolado ausente.");
  return {
    DATABASE_URL: connectionUrl(server, database),
    UNIMED_INSTITUTION_ID: "1",
    UNIMED_INSTITUTION_NAME: "Unimed",
  };
}

describeWithIsolatedMysql("plano Unimed em MySQL isolado", () => {
  let admin: Connection;
  let database: Connection;
  let schemaName: string;

  beforeAll(async () => {
    if (!server) throw new Error("Servidor MySQL isolado ausente.");
    schemaName = temporaryDatabaseName();
    admin = await mysql.createConnection({ ...server, database: "mysql" });
    await admin.query(`CREATE DATABASE ${quoteIdentifier(schemaName)}`);
    database = await mysql.createConnection({
      ...server,
      database: schemaName,
      multipleStatements: true,
    });
    await createPrerequisites(database);
    await database.query(migration);
    await createNoInterferenceSentinels(database);
    await seedUnimed(database);
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

  it("resolve HRU e HUS por IDs e nomes exatos, preservando relações extras", async () => {
    const before = await tableCounts(database);
    const plan = await runUnimedHospitalProvisionPlan([], testEnv(schemaName));
    const after = await tableCounts(database);

    expect(plan).toMatchObject({
      mode: "READ_ONLY_PLAN",
      applyAvailability: "BLOCKED_UNTIL_AUTHENTICATED_MUTATION",
      institution: { institutionId: 1, institutionName: "Unimed" },
    });
    expect(
      plan.hospitals.map((hospital) => [
        hospital.code,
        hospital.id,
        hospital.action,
      ]),
    ).toEqual([
      ["HRU", 10, "EXISTS"],
      ["HUS", 11, "EXISTS"],
    ]);
    expect(plan.hospitals[0]!.sectors.map((sector) => sector.id)).toEqual([
      101, 102, 103, 104, 105,
    ]);
    expect(plan.hospitals[1]!.sectors.map((sector) => sector.id)).toEqual([
      201, 202, 203,
    ]);
    expect(plan.hospitals[0]!.sectors[0]!.specialtyRelations).toEqual([
      { code: "ANESTESIOLOGIA", action: "EXISTS" },
    ]);
    expect(plan.hospitals[1]!.sectors[0]!).toMatchObject({
      name: "Pediatria",
      specialtyRelations: [{ code: "PEDIATRIA", action: "CREATE" }],
      preservedExistingSpecialtyCodes: ["CARDIOLOGIA"],
    });
    expect(
      plan.hospitals
        .flatMap((hospital) => hospital.sectors)
        .flatMap((sector) => sector.specialtyRelations)
        .filter((relation) => relation.action === "CREATE"),
    ).toHaveLength(7);
    expect(after).toEqual(before);
  });

  it("rejeita aliases, duplicidades e configuração setorial incompatível", async () => {
    await database.execute("UPDATE hospitals SET name = ? WHERE id = ?", [
      "Hospital  Unimed Sul",
      11,
    ]);
    try {
      await expect(
        runUnimedHospitalProvisionPlan([], testEnv(schemaName)),
      ).rejects.toThrow(/hospital encontrada como alias/i);
    } finally {
      await database.execute("UPDATE hospitals SET name = ? WHERE id = ?", [
        "Hospital Unimed Sul",
        11,
      ]);
    }

    await database.execute("UPDATE sectors SET name = ? WHERE id = ?", [
      "Cirurgia  Geral",
      102,
    ]);
    try {
      await expect(
        runUnimedHospitalProvisionPlan([], testEnv(schemaName)),
      ).rejects.toThrow(/setor encontrada como alias/i);
    } finally {
      await database.execute("UPDATE sectors SET name = ? WHERE id = ?", [
        "Cirurgia Geral",
        102,
      ]);
    }

    await database.execute(
      "INSERT INTO hospitals (id, institution_id, name) VALUES (?, ?, ?)",
      [12, 1, "Hospital Unimed Sul"],
    );
    try {
      await expect(
        runUnimedHospitalProvisionPlan([], testEnv(schemaName)),
      ).rejects.toThrow(/hospital duplicado/i);
    } finally {
      await database.execute("DELETE FROM hospitals WHERE id = ?", [12]);
    }

    await database.execute("UPDATE sectors SET color = ? WHERE id = ?", [
      "#000000",
      105,
    ]);
    try {
      await expect(
        runUnimedHospitalProvisionPlan([], testEnv(schemaName)),
      ).rejects.toThrow(/categoria\/cor incompatível/i);
    } finally {
      await database.execute("UPDATE sectors SET color = ? WHERE id = ?", [
        "#059669",
        105,
      ]);
    }
  });

  it("rejeita uma tabela N:N parcial sem tocar a topologia", async () => {
    if (!server) throw new Error("Servidor MySQL isolado ausente.");
    const partialSchema = temporaryDatabaseName(
      NESTED_TEMPORARY_DATABASE_PREFIX,
    );
    let partialDatabase: Connection | undefined;
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(partialSchema)}`);
      partialDatabase = await mysql.createConnection({
        ...server,
        database: partialSchema,
        multipleStatements: true,
      });
      await createPrerequisites(partialDatabase);
      await partialDatabase.query(`
        CREATE TABLE sector_service_specialties (
          id INT NOT NULL AUTO_INCREMENT,
          institution_id INT NOT NULL,
          PRIMARY KEY (id)
        ) ENGINE=InnoDB;
      `);
      await expect(
        runUnimedHospitalProvisionPlan([], testEnv(partialSchema)),
      ).rejects.toThrow(/migration N:N incompatível/i);

      const [rows] = await partialDatabase.query<
        (RowDataPacket & { count: number })[]
      >("SELECT COUNT(*) AS count FROM hospitals");
      expect(Number(rows[0]!.count)).toBe(0);
    } finally {
      await partialDatabase?.end();
      if (partialSchema.startsWith(NESTED_TEMPORARY_DATABASE_PREFIX)) {
        await admin.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(partialSchema)}`,
        );
      }
    }
  });

  it("rejeita relação N:N que aponta para uma topologia de outro schema", async () => {
    if (!server) throw new Error("Servidor MySQL isolado ausente.");
    const foreignSchema = temporaryDatabaseName(
      FOREIGN_TEMPORARY_DATABASE_PREFIX,
    );
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(foreignSchema)}`);
      await admin.query(`
        CREATE TABLE ${quoteIdentifier(foreignSchema)}.${quoteIdentifier("institutions")} (
          id INT NOT NULL PRIMARY KEY
        ) ENGINE=InnoDB
      `);
      await admin.query(
        `INSERT INTO ${quoteIdentifier(foreignSchema)}.${quoteIdentifier("institutions")} (id) VALUES (1)`,
      );
      await database.query(`
        ALTER TABLE sector_service_specialties
          DROP FOREIGN KEY fk_sector_service_specialty_institution;
        ALTER TABLE sector_service_specialties
          ADD CONSTRAINT fk_sector_service_specialty_institution
          FOREIGN KEY (institution_id)
          REFERENCES ${quoteIdentifier(foreignSchema)}.${quoteIdentifier("institutions")} (id)
          ON UPDATE RESTRICT
          ON DELETE RESTRICT;
      `);
      await expect(
        runUnimedHospitalProvisionPlan([], testEnv(schemaName)),
      ).rejects.toThrow(/migration N:N incompatível: chaves estrangeiras/i);
    } finally {
      try {
        await database.query(`
          ALTER TABLE sector_service_specialties
            DROP FOREIGN KEY fk_sector_service_specialty_institution;
          ALTER TABLE sector_service_specialties
            ADD CONSTRAINT fk_sector_service_specialty_institution
            FOREIGN KEY (institution_id)
            REFERENCES institutions (id)
            ON UPDATE RESTRICT
            ON DELETE RESTRICT;
        `);
      } catch {
        // A limpeza do schema efêmero no afterAll permanece a última barreira.
      }
      if (foreignSchema.startsWith(FOREIGN_TEMPORARY_DATABASE_PREFIX)) {
        await admin.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(foreignSchema)}`,
        );
      }
    }
  });
});
