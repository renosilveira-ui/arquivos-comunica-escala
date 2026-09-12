import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";

const migrationSql = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-12-audit-trail-action-enum.sql",
    import.meta.url,
  ),
  "utf8",
);

const DB_NAME = `escalas_test_audit_enum_${process.pid}`;

/** O enum como estava no banco real em 12/09/2026: 29 valores, sem os 7. */
const STAGING_ENUM = [
  "SHIFT_CREATED",
  "SHIFT_UPDATED",
  "SHIFT_DELETED",
  "ASSIGNMENT_CREATED",
  "ASSIGNMENT_REMOVED",
  "ASSIGNMENT_ASSUMED_VACANCY",
  "ASSIGNMENT_APPROVED",
  "ASSIGNMENT_REJECTED",
  "SWAP_REQUESTED",
  "SWAP_ACCEPTED",
  "SWAP_REJECTED",
  "SWAP_APPROVED_BY_MANAGER",
  "SWAP_CANCELLED",
  "TRANSFER_OFFERED",
  "TRANSFER_ACCEPTED",
  "TRANSFER_REJECTED",
  "TRANSFER_APPROVED_BY_MANAGER",
  "TRANSFER_CANCELLED",
  "ROSTER_PUBLISHED",
  "ROSTER_LOCKED",
  "USER_CREATED",
  "USER_UPDATED",
  "USER_ROLE_CHANGED",
  "SSO_JIT_LINK_CREATED",
  "PUSH_DISPATCHED",
  "CONFLICT_DETECTED",
  "CONFLICT_OVERRIDDEN",
  "INSTITUTION_FEATURE_UPDATED",
  "SECTOR_SERVICE_SPECIALTIES_UPDATED",
];

const enumSql = (values: string[]) =>
  `ENUM(${values.map((v) => `'${v}'`).join(",")})`;

async function columnType(db: Connection): Promise<string> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COLUMN_TYPE AS t FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'audit_trail' AND COLUMN_NAME = 'action'`,
    [DB_NAME],
  );
  return String(rows[0]?.t ?? "");
}

/**
 * Prova com o sql_mode do banco real (ANSI_QUOTES + STRICT_ALL_TABLES):
 * aplica sobre o enum de 29, preserva linhas, aceita os 7 valores novos,
 * é rerodável e recusa um banco cujo enum tenha valor desconhecido.
 */
describe("migration MySQL — enum de ações da auditoria", () => {
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
    await db.query(`
      CREATE TABLE audit_trail (
        id INT NOT NULL AUTO_INCREMENT,
        action ${enumSql(STAGING_ENUM)} NOT NULL,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB
    `);
    await db.query(
      `INSERT INTO audit_trail (action) VALUES ('TRANSFER_ACCEPTED'), ('SECTOR_SERVICE_SPECIALTIES_UPDATED')`,
    );
  });

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
      await admin.end();
    }
  });

  it("aplica duas vezes, preserva as linhas e passa a aceitar os sete valores", async () => {
    await db.query(migrationSql);
    await db.query(migrationSql);

    const type = await columnType(db);
    expect((type.match(/'/g) ?? []).length / 2).toBe(36);
    for (const value of [
      "CESSAO_OFFERED",
      "CESSAO_ACCEPTED",
      "CESSAO_REJECTED",
      "CESSAO_APPROVED_BY_OWNER",
      "CESSAO_CANCELLED",
      "SWAP_APPROVED_BY_OWNER",
      "TRANSFER_APPROVED_BY_OWNER",
    ]) {
      expect(type).toContain(`'${value}'`);
    }

    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT action FROM audit_trail ORDER BY id`,
    );
    expect(rows.map((r) => r.action)).toEqual([
      "TRANSFER_ACCEPTED",
      "SECTOR_SERVICE_SPECIALTIES_UPDATED",
    ]);

    await db.query(
      `INSERT INTO audit_trail (action) VALUES ('CESSAO_OFFERED'), ('TRANSFER_APPROVED_BY_OWNER'), ('SWAP_APPROVED_BY_OWNER')`,
    );
    const [count] = await db.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM audit_trail`,
    );
    expect(Number(count[0]?.n)).toBe(5);
  });

  it("recusa, antes de tocar em qualquer coisa, um enum com valor desconhecido", async () => {
    await db.query(`DELETE FROM audit_trail`);
    await db.query(
      `ALTER TABLE audit_trail MODIFY COLUMN action ${enumSql(["FOO", "SHIFT_CREATED"])} NOT NULL`,
    );
    await expect(db.query(migrationSql)).rejects.toThrow(
      /__audit_trail_action_enum_unknown_value__/,
    );
    expect(await columnType(db)).toBe("enum('FOO','SHIFT_CREATED')");
  });
});
