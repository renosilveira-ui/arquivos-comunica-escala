import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";

const migrationSql = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-12-push-token-provenance-v2.sql",
    import.meta.url,
  ),
  "utf8",
);

const DB_NAME = `escalas_test_push_v2_${process.pid}`;

/**
 * Prova com o sql_mode do banco real sobre a forma que o staging tinha em
 * 12/09/2026 (institution_id NOT NULL, token ai_ci, sem UNIQUE, sem CHECK),
 * com dados que a v1 trataria pior: duplicata (fica a mais recente) e token
 * com espaço (sai). Rerodável. Depois: NULL de tenant aceito, duplicata e
 * espaço recusados pelo banco, não só pelo código.
 */
describe("migration MySQL — push_tokens proveniência v2", () => {
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
      CREATE TABLE push_tokens (
        id INT NOT NULL AUTO_INCREMENT,
        institution_id INT NOT NULL,
        user_id INT NOT NULL,
        token VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
        platform VARCHAR(20) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_push_tokens_institution_id (institution_id, id)
      ) ENGINE=InnoDB
    `);
    await db.query(
      `INSERT INTO push_tokens (id, institution_id, user_id, token, platform) VALUES
        (1, 1, 10, 'ExponentPushToken[aaa]', 'ios'),
        (2, 1, 11, 'ExponentPushToken[dup]', 'ios'),
        (3, 1, 12, 'ExponentPushToken[dup]', 'android'),
        (4, 1, 13, 'ExponentPushToken[bad token]', 'ios'),
        (5, 1, 14, 'ExponentPushToken[AAA]', 'ios')`,
    );
  });

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
      await admin.end();
    }
  });

  it("aplica duas vezes: estrutura do schema, duplicata mais recente fica, espaço sai", async () => {
    await db.query(migrationSql);
    await db.query(migrationSql);

    const [cols] = await db.query<RowDataPacket[]>(
      `SELECT COLUMN_NAME AS c, IS_NULLABLE AS n, COLLATION_NAME AS co
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'push_tokens' AND COLUMN_NAME IN ('institution_id','token')`,
      [DB_NAME],
    );
    const byName = Object.fromEntries(cols.map((r) => [r.c, r]));
    expect(byName.institution_id.n).toBe("YES");
    expect(byName.token.co).toBe("utf8mb4_bin");

    const [idx] = await db.query<RowDataPacket[]>(
      `SELECT NON_UNIQUE AS nu FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'push_tokens' AND INDEX_NAME = 'uniq_push_token'`,
      [DB_NAME],
    );
    expect(idx).toHaveLength(1);
    expect(Number(idx[0]?.nu)).toBe(0);

    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT id, token FROM push_tokens ORDER BY id`,
    );
    expect(rows.map((r) => [r.id, r.token])).toEqual([
      [1, "ExponentPushToken[aaa]"],
      [3, "ExponentPushToken[dup]"],
      [5, "ExponentPushToken[AAA]"],
    ]);
  });

  it("depois: tenant NULL aceito; duplicata e espaço recusados pelo banco", async () => {
    await db.query(
      `INSERT INTO push_tokens (institution_id, user_id, token, platform) VALUES (NULL, 20, 'ExponentPushToken[novo]', 'ios')`,
    );
    await expect(
      db.query(
        `INSERT INTO push_tokens (institution_id, user_id, token, platform) VALUES (1, 21, 'ExponentPushToken[novo]', 'ios')`,
      ),
    ).rejects.toThrow(/uniq_push_token|Duplicate/);
    await expect(
      db.query(
        `INSERT INTO push_tokens (institution_id, user_id, token, platform) VALUES (1, 22, 'Exponent PushToken[x]', 'ios')`,
      ),
    ).rejects.toThrow(/chk_push_token_no_whitespace/);
    // Sensível a maiúsculas: 'aaa' e 'AAA' são tokens diferentes.
    const [n] = await db.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM push_tokens WHERE token IN ('ExponentPushToken[aaa]','ExponentPushToken[AAA]')`,
    );
    expect(Number(n[0]?.n)).toBe(2);
  });
});
