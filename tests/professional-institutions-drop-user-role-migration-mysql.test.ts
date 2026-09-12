import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";

const migrationSql = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-12-professional-institutions-drop-user-role.sql",
    import.meta.url,
  ),
  "utf8",
);

const DB_NAME = `escalas_test_pi_user_role_${process.pid}`;

async function columns(db: Connection): Promise<string[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'professional_institutions'
     ORDER BY ORDINAL_POSITION`,
    [DB_NAME],
  );
  return rows.map((r) => String(r.c));
}

/**
 * Prova com o sql_mode do banco real: remove a coluna antiga, preserva a
 * canônica e as linhas, é rerodável, e recusa rodar onde a canônica ainda
 * não existe ou onde um trigger ainda usa a antiga.
 */
describe("migration MySQL — remove professional_institutions.user_role", () => {
  let admin: Connection;
  let db: Connection;

  beforeAll(async () => {
    admin = await mysql.createConnection({
      host: "127.0.0.1",
      user: "root",
      password: "root",
      multipleStatements: true,
    });
    await admin.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
    await admin.query(`CREATE DATABASE \`${DB_NAME}\``);
    db = await mysql.createConnection({
      host: "127.0.0.1",
      user: "root",
      password: "root",
      database: DB_NAME,
      multipleStatements: true,
    });
    await db.query(
      `SET SESSION sql_mode = 'ANSI_QUOTES,STRICT_ALL_TABLES,ONLY_FULL_GROUP_BY,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'`,
    );
  });

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
      await admin.end();
    }
  });

  async function createTable(withLegacy: boolean, withCanonical: boolean) {
    await db.query(`DROP TABLE IF EXISTS professional_institutions`);
    await db.query(`
      CREATE TABLE professional_institutions (
        id INT NOT NULL AUTO_INCREMENT,
        user_id INT NOT NULL,
        institution_id INT NOT NULL,
        ${withLegacy ? "user_role ENUM('USER','GESTOR_MEDICO','GESTOR_PLUS') NOT NULL DEFAULT 'USER'," : ""}
        ${withCanonical ? "role_in_institution ENUM('USER','GESTOR_MEDICO','GESTOR_PLUS') NOT NULL DEFAULT 'USER'," : ""}
        active TINYINT(1) NOT NULL DEFAULT 1,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB
    `);
  }

  it("remove a antiga, preserva a canônica e as linhas, e é rerodável", async () => {
    await createTable(true, true);
    await db.query(
      `INSERT INTO professional_institutions (user_id, institution_id, user_role, role_in_institution)
       VALUES (1, 1, 'GESTOR_PLUS', 'USER'), (2, 1, 'USER', 'GESTOR_MEDICO')`,
    );
    await db.query(migrationSql);
    await db.query(migrationSql);
    expect(await columns(db)).toEqual([
      "id",
      "user_id",
      "institution_id",
      "role_in_institution",
      "active",
    ]);
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT user_id, role_in_institution FROM professional_institutions ORDER BY id`,
    );
    expect(rows.map((r) => [r.user_id, r.role_in_institution])).toEqual([
      [1, "USER"],
      [2, "GESTOR_MEDICO"],
    ]);
  });

  it("sem a canônica, recusa antes de tocar em qualquer coisa", async () => {
    await createTable(true, false);
    await expect(db.query(migrationSql)).rejects.toThrow(
      /__professional_institutions_role_in_institution_missing__/,
    );
    expect(await columns(db)).toContain("user_role");
  });

  it("com trigger que ainda usa a antiga, recusa", async () => {
    await createTable(true, true);
    await db.query(
      `CREATE TRIGGER trg_test_user_role BEFORE INSERT ON professional_institutions
       FOR EACH ROW SET NEW.user_role = NEW.role_in_institution`,
    );
    await expect(db.query(migrationSql)).rejects.toThrow(
      /__professional_institutions_user_role_still_referenced__/,
    );
    expect(await columns(db)).toContain("user_role");
    await db.query(`DROP TRIGGER trg_test_user_role`);
  });
});
