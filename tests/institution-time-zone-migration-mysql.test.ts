import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";

const migrationSql = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-12-institution-time-zone-from-hospitals.sql",
    import.meta.url,
  ),
  "utf8",
);

const DB_NAME = `escalas_test_inst_tz_${process.pid}`;

/**
 * A instituição herda o fuso dos hospitais dela.
 *
 * Regra do PO: registrar a localidade onde ela realmente é, e casar o melhor
 * fuso a ela. No banco real, os quatro hospitais têm endereço e coordenada de
 * Fortaleza e `America/Fortaleza`; as três instituições, todas de Fortaleza,
 * estavam com `America/Sao_Paulo` — o DEFAULT da coluna, que nunca foi
 * corrigido porque o script de provisionamento usou
 * `COALESCE(time_zone, ?)` numa coluna NOT NULL.
 *
 * Os casos abaixo cobrem o que a migração NÃO pode fazer: inventar fuso para
 * instituição sem hospital, ou escolher por ela quando os hospitais discordam.
 */
describe("migration MySQL — fuso da instituição vem dos hospitais", () => {
  let admin: Connection;
  let db: Connection;

  async function fusos() {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT id, time_zone FROM institutions ORDER BY id`,
    );
    return Object.fromEntries(rows.map((r) => [r.id, r.time_zone]));
  }

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
        time_zone VARCHAR(64) NOT NULL DEFAULT 'America/Sao_Paulo',
        PRIMARY KEY (id)
      ) ENGINE=InnoDB;
      CREATE TABLE hospitals (
        id INT NOT NULL AUTO_INCREMENT,
        institution_id INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        time_zone VARCHAR(64) NULL,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB;
      INSERT INTO institutions (id, name) VALUES
        (1, 'Unanime Fortaleza'),
        (2, 'Sem hospital'),
        (3, 'Hospitais discordam'),
        (4, 'Ja correta'),
        (5, 'Hospital sem fuso');
      INSERT INTO hospitals (institution_id, name, time_zone) VALUES
        (1, 'H1', 'America/Fortaleza'),
        (1, 'H2', 'America/Fortaleza'),
        (3, 'H3', 'America/Fortaleza'),
        (3, 'H4', 'America/Manaus'),
        (4, 'H5', 'America/Sao_Paulo'),
        (5, 'H6', NULL);
    `);
  });

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
      await admin.end();
    }
  });

  it("herda quando os hospitais são unânimes, e é rerodável", async () => {
    const antes = await fusos();
    expect(antes[1]).toBe("America/Sao_Paulo");

    await db.query(migrationSql);
    const depois = await fusos();

    // O caso do banco real: hospitais unânimes em Fortaleza.
    expect(depois[1]).toBe("America/Fortaleza");
    // Já correta: continua igual, sem escrita inútil.
    expect(depois[4]).toBe("America/Sao_Paulo");

    await db.query(migrationSql);
    expect(await fusos()).toEqual(depois);
  });

  /**
   * Sem hospital não existe "o fuso da instituição" para deduzir. Inventar um
   * seria gravar uma localidade falsa — exatamente o defeito que a migração
   * veio corrigir.
   */
  it("não inventa fuso para instituição sem hospital", async () => {
    expect((await fusos())[2]).toBe("America/Sao_Paulo");
  });

  it("não escolhe por instituição cujos hospitais discordam", async () => {
    // Fortaleza e Manaus são fusos diferentes de verdade (UTC-3 e UTC-4).
    expect((await fusos())[3]).toBe("America/Sao_Paulo");
  });

  it("ignora hospital sem fuso declarado", async () => {
    expect((await fusos())[5]).toBe("America/Sao_Paulo");
  });

  it("acompanha uma correção posterior no hospital", async () => {
    await db.query(
      `UPDATE hospitals SET time_zone = 'America/Manaus' WHERE institution_id = 1`,
    );
    await db.query(migrationSql);
    expect((await fusos())[1]).toBe("America/Manaus");
  });
});
