import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import mysql, { type Connection } from "mysql2/promise";
import { afterAll, beforeAll, expect, it } from "vitest";

let connection: Connection;
const schema = `escalas_capacity_proof_${randomUUID().replaceAll("-", "")}`;
let created = false;
const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-09-schedule-shift-capacity.sql",
    import.meta.url,
  ),
  "utf8",
);

async function withIsolatedSchema(
  run: (database: Connection) => Promise<void>,
): Promise<void> {
  const raw = process.env.CAPACITY_MIGRATION_TEST_URL;
  if (!raw) throw new Error("CAPACITY_MIGRATION_TEST_URL local é obrigatório.");
  const url = new URL(raw);
  const isolated = `escalas_capacity_drift_${randomUUID().replaceAll("-", "")}`;
  const admin = await mysql.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  });
  let database: Connection | undefined;
  try {
    await admin.query(`CREATE DATABASE \`${isolated}\``);
    database = await mysql.createConnection({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: isolated,
      multipleStatements: true,
    });
    await run(database);
  } finally {
    await database?.end();
    if (/^escalas_capacity_drift_[a-f0-9]{32}$/.test(isolated))
      await admin.query(`DROP DATABASE IF EXISTS \`${isolated}\``);
    await admin.end();
  }
}

async function createBaseTables(database: Connection): Promise<void> {
  await database.query(`
    CREATE TABLE schedule_contexts (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB;
    CREATE TABLE shift_instances (
      id INT AUTO_INCREMENT PRIMARY KEY,
      institution_id INT NOT NULL,
      hospital_id INT NOT NULL,
      sector_id INT NOT NULL,
      schedule_context_id INT NULL,
      start_at TIMESTAMP NOT NULL,
      end_at TIMESTAMP NOT NULL,
      label VARCHAR(100)
    ) ENGINE=InnoDB;
  `);
}
beforeAll(async () => {
  const raw = process.env.CAPACITY_MIGRATION_TEST_URL;
  if (!raw) throw new Error("CAPACITY_MIGRATION_TEST_URL local é obrigatório.");
  const url = new URL(raw);
  if (
    url.protocol !== "mysql:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new Error("Prova de migration restrita a MySQL local.");
  connection = await mysql.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    multipleStatements: true,
  });
  await connection.query(`CREATE DATABASE \`${schema}\``);
  created = true;
  await connection.query(`USE \`${schema}\``);
});
afterAll(async () => {
  if (!connection) return;
  try {
    if (created && /^escalas_capacity_proof_[a-f0-9]{32}$/.test(schema))
      await connection.query(`DROP DATABASE \`${schema}\``);
  } finally {
    await connection.end();
  }
});

it("preserves historical duplicate blocks, enforces defaults and uniqueness for new rows, reruns safely", async () => {
  await connection.query(`CREATE TABLE schedule_contexts (id INT PRIMARY KEY);
    INSERT INTO schedule_contexts VALUES (1),(2);
    CREATE TABLE shift_instances (id INT AUTO_INCREMENT PRIMARY KEY, institution_id INT NOT NULL, hospital_id INT NOT NULL, sector_id INT NOT NULL, schedule_context_id INT, start_at TIMESTAMP NOT NULL, end_at TIMESTAMP NOT NULL, label VARCHAR(100), updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP);
    INSERT INTO shift_instances (institution_id,hospital_id,sector_id,schedule_context_id,start_at,end_at,label) VALUES
      (1,1,1,1,'2026-08-03 10:00:00','2026-08-03 16:00:00','Manhã'),
      (1,1,1,1,'2026-08-03 10:00:00','2026-08-03 16:00:00','Sobreaviso');`);
  const [before] = await connection.query(
    "SELECT id,label,start_at,end_at,updated_at FROM shift_instances ORDER BY id",
  );
  await connection.query(migration);
  await connection.query(migration);
  const [after] = await connection.query(
    "SELECT id,label,start_at,end_at,updated_at FROM shift_instances ORDER BY id",
  );
  expect(after).toEqual(before);
  const [legacy] = await connection.query<any[]>(
    "SELECT required_capacity,capacity_context_id FROM shift_instances",
  );
  expect(
    legacy.every(
      (row) =>
        row.required_capacity === null && row.capacity_context_id === null,
    ),
  ).toBe(true);
  const insert =
    "INSERT INTO shift_instances (institution_id,hospital_id,sector_id,schedule_context_id,start_at,end_at,label) VALUES (1,1,1,?,'2027-01-01 10:00:00','2027-01-01 16:00:00',?)";
  await connection.execute(insert, [1, "Manhã"]);
  await expect(
    connection.execute(insert, [1, "Segundo médico"]),
  ).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
  await connection.execute(insert, [2, "Outra escala"]);
  const [rows] = await connection.query<any[]>(
    "SELECT required_capacity FROM shift_instances WHERE id > 2",
  );
  expect(rows.every((row) => row.required_capacity === 1)).toBe(true);
  await expect(
    connection.query(
      "UPDATE shift_instances SET required_capacity=0 WHERE id=3",
    ),
  ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });
  await connection.query(
    "INSERT INTO schedule_capacity_rules(schedule_context_id,start_time,end_time,weekday,required_capacity) VALUES(1,'07:00','13:00',1,3)",
  );
  await expect(
    connection.query(
      "INSERT INTO schedule_capacity_rules(schedule_context_id,start_time,end_time,weekday,required_capacity) VALUES(1,'07:00','13:00',7,3)",
    ),
  ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });

  const [capacityColumns] = await connection.query<any[]>(`
    SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
      EXTRA, GENERATION_EXPRESSION
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'shift_instances'
      AND COLUMN_NAME IN ('required_capacity', 'capacity_context_id')
    ORDER BY COLUMN_NAME
  `);
  expect(capacityColumns).toMatchObject([
    {
      COLUMN_NAME: "capacity_context_id",
      DATA_TYPE: "int",
      IS_NULLABLE: "YES",
      EXTRA: "STORED GENERATED",
    },
    {
      COLUMN_NAME: "required_capacity",
      DATA_TYPE: "int",
      IS_NULLABLE: "YES",
      COLUMN_DEFAULT: "1",
    },
  ]);
  expect(
    String(capacityColumns[0].GENERATION_EXPRESSION),
  ).toContain("required_capacity");
  const [slotIndex] = await connection.query<any[]>(`
    SELECT NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'shift_instances'
      AND INDEX_NAME = 'uniq_shift_capacity_slot'
    ORDER BY SEQ_IN_INDEX
  `);
  expect(slotIndex.map((row) => row.COLUMN_NAME)).toEqual([
    "institution_id",
    "hospital_id",
    "sector_id",
    "capacity_context_id",
    "start_at",
    "end_at",
  ]);
  expect(slotIndex.every((row) => row.NON_UNIQUE === 0)).toBe(true);
});

it("fails closed before DDL when a homonymous capacity column is incompatible", async () => {
  await withIsolatedSchema(async (database) => {
    await createBaseTables(database);
    await database.query(
      "ALTER TABLE shift_instances ADD COLUMN required_capacity VARCHAR(12) NULL",
    );
    await database.query(`
      INSERT INTO shift_instances
        (institution_id,hospital_id,sector_id,schedule_context_id,start_at,end_at,label,required_capacity)
      VALUES (9,8,7,NULL,'2027-02-01 10:00:00','2027-02-01 16:00:00','sentinel','legacy')
    `);

    await expect(database.query(migration)).rejects.toMatchObject({
      code: "ER_NO_SUCH_TABLE",
      message: expect.stringContaining("schedule_shift_capacity_contract_mismatch"),
    });

    const [sentinel] = await database.query<any[]>(
      "SELECT required_capacity FROM shift_instances WHERE label='sentinel'",
    );
    expect(sentinel).toEqual([{ required_capacity: "legacy" }]);
    const [newObjects] = await database.query<any[]>(`
      SELECT TABLE_NAME AS object_name
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'schedule_capacity_rules'
      UNION ALL
      SELECT COLUMN_NAME AS object_name
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'shift_instances'
        AND COLUMN_NAME = 'capacity_context_id'
    `);
    expect(newObjects).toEqual([]);
  });
});

it("rejects a partial rules table without changing shift_instances", async () => {
  await withIsolatedSchema(async (database) => {
    await createBaseTables(database);
    await database.query(`
      CREATE TABLE schedule_capacity_rules (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        schedule_context_id INT NOT NULL,
        required_capacity INT NOT NULL DEFAULT 2
      ) ENGINE=InnoDB;
      INSERT INTO schedule_capacity_rules
        (schedule_context_id, required_capacity) VALUES (91, 7)
    `);

    await expect(database.query(migration)).rejects.toMatchObject({
      code: "ER_NO_SUCH_TABLE",
      message: expect.stringContaining("schedule_shift_capacity_contract_mismatch"),
    });

    const [rows] = await database.query<any[]>(
      "SELECT schedule_context_id,required_capacity FROM schedule_capacity_rules",
    );
    expect(rows).toEqual([{ schedule_context_id: 91, required_capacity: 7 }]);
    const [capacityColumns] = await database.query<any[]>(`
      SELECT COLUMN_NAME
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'shift_instances'
        AND COLUMN_NAME IN ('required_capacity', 'capacity_context_id')
    `);
    expect(capacityColumns).toEqual([]);
  });
});

it("rejects an unreferencable schedule context key before DDL", async () => {
  await withIsolatedSchema(async (database) => {
    await database.query(`
      CREATE TABLE schedule_contexts (id INT NOT NULL) ENGINE=InnoDB;
      CREATE TABLE shift_instances (
        id INT AUTO_INCREMENT PRIMARY KEY,
        institution_id INT NOT NULL,
        hospital_id INT NOT NULL,
        sector_id INT NOT NULL,
        schedule_context_id INT NULL,
        start_at TIMESTAMP NOT NULL,
        end_at TIMESTAMP NOT NULL,
        label VARCHAR(100)
      ) ENGINE=InnoDB
    `);

    await expect(database.query(migration)).rejects.toMatchObject({
      code: "ER_NO_SUCH_TABLE",
      message: expect.stringContaining("schedule_shift_capacity_contract_mismatch"),
    });

    const [capacityColumns] = await database.query<any[]>(`
      SELECT COLUMN_NAME
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'shift_instances'
        AND COLUMN_NAME IN ('required_capacity', 'capacity_context_id')
    `);
    expect(capacityColumns).toEqual([]);
  });
});
