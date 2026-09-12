import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";

const migrationSql = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-12-unify-table-collation.sql",
    import.meta.url,
  ),
  "utf8",
);

const DB_NAME = `escalas_test_collation_${process.pid}`;

/**
 * Uma collation só no banco — sem perder a binária que é deliberada.
 *
 * 10 tabelas criadas por migrações manuais estavam em `utf8mb4_unicode_ci`,
 * contra `utf8mb4_0900_ai_ci` nas outras 49 e no schema Drizzle. Um JOIN
 * entre as duas famílias devolve erro 1267.
 *
 * O caso que este arquivo existe para travar: `CONVERT TO CHARACTER SET`
 * sobrescreve a collation DE COLUNA. `departure_plans.dedup_key` é
 * `utf8mb4_bin` de propósito — chave de deduplicação distingue maiúscula de
 * minúscula, como o token de push. Uma conversão ingênua a tornaria
 * case-insensitive em silêncio.
 */
describe("migration MySQL — collation única, binária preservada", () => {
  let admin: Connection;
  let db: Connection;

  async function collationDaTabela(nome: string): Promise<string> {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT TABLE_COLLATION AS c FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [DB_NAME, nome],
    );
    return rows[0]?.c;
  }

  async function collationDaColuna(
    tabela: string,
    coluna: string,
  ): Promise<string> {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT COLLATION_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [DB_NAME, tabela, coluna],
    );
    return rows[0]?.c;
  }

  beforeAll(async () => {
    admin = await mysql.createConnection({
      host: "127.0.0.1",
      user: "root",
      password: "root",
      multipleStatements: true,
    });
    await admin.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
    await admin.query(
      `CREATE DATABASE \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
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
    // Reproduz a forma real: tabela na família antiga, com a coluna binária.
    await db.query(`
      CREATE TABLE departure_plans (
        id INT NOT NULL AUTO_INCREMENT,
        label VARCHAR(120) NULL,
        dedup_key VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      CREATE TABLE duty_confirmations (
        id INT NOT NULL AUTO_INCREMENT,
        token VARCHAR(64) NULL,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      CREATE TABLE users (
        id INT NOT NULL AUTO_INCREMENT,
        email VARCHAR(255) NULL,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
      INSERT INTO departure_plans (label, dedup_key) VALUES ('a', 'Chave-A'), ('b', 'chave-a');
      INSERT INTO duty_confirmations (token) VALUES ('t1'), ('t2');
      INSERT INTO users (email) VALUES ('x@y.z');
    `);
  });

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
      await admin.end();
    }
  });

  it("antes: as duas famílias convivem e o JOIN de texto quebra", async () => {
    expect(await collationDaTabela("departure_plans")).toBe(
      "utf8mb4_unicode_ci",
    );
    // O erro 1267 que motivou a migração, reproduzido.
    await expect(
      db.query(
        `SELECT 1 FROM duty_confirmations d JOIN users u ON u.email = d.token`,
      ),
    ).rejects.toThrow(/Illegal mix of collations/i);
  });

  it("converte, preserva linhas e é rerodável", async () => {
    await db.query(migrationSql);

    expect(await collationDaTabela("departure_plans")).toBe(
      "utf8mb4_0900_ai_ci",
    );
    expect(await collationDaTabela("duty_confirmations")).toBe(
      "utf8mb4_0900_ai_ci",
    );

    const [linhas] = await db.query<RowDataPacket[]>(
      `SELECT (SELECT COUNT(*) FROM departure_plans) AS d,
              (SELECT COUNT(*) FROM duty_confirmations) AS c`,
    );
    expect(Number(linhas[0].d)).toBe(2);
    expect(Number(linhas[0].c)).toBe(2);

    await db.query(migrationSql);
    expect(await collationDaTabela("departure_plans")).toBe(
      "utf8mb4_0900_ai_ci",
    );
  });

  /** O ponto central: a conversão em bloco não pode apagar a binária. */
  it("a chave de deduplicação continua binária, e distinguindo caixa", async () => {
    expect(await collationDaColuna("departure_plans", "dedup_key")).toBe(
      "utf8mb4_bin",
    );
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM departure_plans WHERE dedup_key = 'Chave-A'`,
    );
    // Se tivesse virado case-insensitive, 'chave-a' também casaria e daria 2.
    expect(Number(rows[0].n)).toBe(1);
  });

  it("depois dela, o JOIN de texto que antes quebrava funciona", async () => {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM duty_confirmations d JOIN users u ON u.email = d.token`,
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it("recusa aplicar se sobrar tabela na família antiga", async () => {
    await db.query(
      `CREATE TABLE intrusa (id INT PRIMARY KEY, t VARCHAR(10))
         ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    );
    await expect(db.query(migrationSql)).rejects.toThrow();
    await db.query(`DROP TABLE intrusa`);
  });
});
