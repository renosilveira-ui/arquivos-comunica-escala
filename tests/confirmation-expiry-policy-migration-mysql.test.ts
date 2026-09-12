import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";

const migrationSql = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-12-confirmation-expiry-and-escalation-policy.sql",
    import.meta.url,
  ),
  "utf8",
);

const DB_NAME = `escalas_test_conf_policy_${process.pid}`;

async function column(
  db: Connection,
  table: string,
  name: string,
): Promise<RowDataPacket | undefined> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COLUMN_TYPE AS t, IS_NULLABLE AS n, COLUMN_DEFAULT AS d
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [DB_NAME, table, name],
  );
  return rows[0];
}

/**
 * Prova com o sql_mode do banco real sobre a forma que o staging tinha em
 * 12/09/2026: aplica 2x, preserva linhas (inclusive uma PENDING escalada),
 * aceita EXPIRED, e recusa um enum com valor desconhecido antes de tocar.
 */
describe("migration MySQL — confirmações: EXPIRED e política do aviso ao gestor", () => {
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
      CREATE TABLE institutions (
        id INT NOT NULL AUTO_INCREMENT,
        name VARCHAR(255) NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB;
      CREATE TABLE duty_confirmations (
        id INT NOT NULL AUTO_INCREMENT,
        status ENUM('PENDING','CONFIRMED','DECLINED','NOMINATED','REPLACEMENT_CONFIRMED','REPLACEMENT_DECLINED','AUTO_CONFIRMED') NOT NULL DEFAULT 'PENDING',
        recheck_at TIMESTAMP NULL,
        manager_notified TINYINT(1) NOT NULL DEFAULT 0,
        start_push_sent_at TIMESTAMP NULL,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB;
      INSERT INTO institutions (name) VALUES ('Hospital A');
      INSERT INTO duty_confirmations (status, manager_notified) VALUES ('PENDING', 1), ('AUTO_CONFIRMED', 0);
    `);
  });

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
      await admin.end();
    }
  });

  it("aplica duas vezes, preserva linhas, liga o aviso por padrão e aceita EXPIRED", async () => {
    await db.query(migrationSql);
    await db.query(migrationSql);

    const flag = await column(db, "institutions", "notify_manager_on_unconfirmed");
    expect(flag?.n).toBe("NO");
    expect(String(flag?.d)).toBe("1");
    const [inst] = await db.query<RowDataPacket[]>(
      `SELECT notify_manager_on_unconfirmed AS v FROM institutions`,
    );
    expect(Number(inst[0]?.v)).toBe(1);

    const status = await column(db, "duty_confirmations", "status");
    expect(String(status?.t)).toBe(
      "enum('PENDING','CONFIRMED','DECLINED','NOMINATED','REPLACEMENT_CONFIRMED','REPLACEMENT_DECLINED','AUTO_CONFIRMED','EXPIRED')",
    );
    expect((await column(db, "duty_confirmations", "expired_at"))?.n).toBe("YES");
    expect(
      (await column(db, "duty_confirmations", "escalation_suppressed_at"))?.n,
    ).toBe("YES");

    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT status, manager_notified FROM duty_confirmations ORDER BY id`,
    );
    expect(rows.map((r) => [r.status, Number(r.manager_notified)])).toEqual([
      ["PENDING", 1],
      ["AUTO_CONFIRMED", 0],
    ]);

    await db.query(
      `UPDATE duty_confirmations SET status = 'EXPIRED', expired_at = NOW() WHERE id = 1`,
    );
    const [expired] = await db.query<RowDataPacket[]>(
      `SELECT status FROM duty_confirmations WHERE id = 1`,
    );
    expect(expired[0]?.status).toBe("EXPIRED");
  });

  it("recusa um enum com valor desconhecido antes de tocar em qualquer coisa", async () => {
    await db.query(`DELETE FROM duty_confirmations`);
    await db.query(
      `ALTER TABLE duty_confirmations MODIFY COLUMN status ENUM('FOO','PENDING') NOT NULL DEFAULT 'PENDING'`,
    );
    await expect(db.query(migrationSql)).rejects.toThrow(
      /__duty_confirmations_status_unknown_value__/,
    );
    expect(String((await column(db, "duty_confirmations", "status"))?.t)).toBe(
      "enum('FOO','PENDING')",
    );
  });
});
