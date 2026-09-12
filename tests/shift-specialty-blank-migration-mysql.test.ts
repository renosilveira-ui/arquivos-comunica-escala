import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";

const migrationSql = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-12-shift-instances-specialty-blank.sql",
    import.meta.url,
  ),
  "utf8",
);

const DB_NAME = `escalas_test_specialty_blank_${process.pid}`;

/**
 * Prova com o sql_mode do banco real sobre a forma que o staging tinha em
 * 12/09/2026.
 *
 * O defeito: 76 de 453 plantões com `specialty = ''` (string vazia, não
 * NULL), 44 deles no futuro. O envelope do duty-sync recusava esse branco e
 * a confirmação do plantão caía inteira — o médico tocava "Sim, confirmo" e
 * lia "Envelope imutável inválido no duty-sync".
 */
describe("migration MySQL — especialidade em branco vira ausência", () => {
  let admin: Connection;
  let db: Connection;

  async function contagens() {
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT
         COUNT(*) AS total,
         SUM(specialty IS NULL) AS nulas,
         SUM(specialty IS NOT NULL AND TRIM(specialty) = '') AS brancas,
         SUM(specialty = 'Anestesiologia') AS anestesio,
         SUM(specialty = '  Cirurgia geral  ') AS com_espacos
       FROM shift_instances`,
    );
    return rows[0];
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
      CREATE TABLE shift_instances (
        id INT NOT NULL AUTO_INCREMENT,
        start_at TIMESTAMP NULL,
        modality VARCHAR(32) NOT NULL DEFAULT 'PLANTAO',
        specialty VARCHAR(100) NULL,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB;
      INSERT INTO shift_instances (specialty) VALUES
        (''),
        ('   '),
        (NULL),
        ('Anestesiologia'),
        ('  Cirurgia geral  ');
    `);
  });

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
      await admin.end();
    }
  });

  it("aplica duas vezes: branco vira NULL, preenchida fica intacta", async () => {
    const antes = await contagens();
    expect(Number(antes.total)).toBe(5);
    expect(Number(antes.brancas)).toBe(2);
    expect(Number(antes.nulas)).toBe(1);

    await db.query(migrationSql);
    const depois = await contagens();
    expect(Number(depois.total)).toBe(5, "nenhuma linha pode sumir");
    expect(Number(depois.brancas)).toBe(0);
    expect(Number(depois.nulas)).toBe(3);
    // Especialidade de verdade não é tocada, nem a que tem espaço nas pontas.
    expect(Number(depois.anestesio)).toBe(1);
    expect(Number(depois.com_espacos)).toBe(1);

    // Rerodável: a segunda execução não encontra branco e o CHECK já existe.
    await db.query(migrationSql);
    const rerun = await contagens();
    expect(rerun).toEqual(depois);
  });

  it("depois dela, o banco recusa especialidade em branco", async () => {
    await expect(
      db.query(`INSERT INTO shift_instances (specialty) VALUES ('')`),
    ).rejects.toThrow();
    await expect(
      db.query(`INSERT INTO shift_instances (specialty) VALUES ('   ')`),
    ).rejects.toThrow();
    await expect(
      db.query(
        `UPDATE shift_instances SET specialty = '' WHERE specialty = 'Anestesiologia'`,
      ),
    ).rejects.toThrow();
  });

  it("ausência e nome de verdade continuam aceitos", async () => {
    await db.query(`INSERT INTO shift_instances (specialty) VALUES (NULL)`);
    await db.query(
      `INSERT INTO shift_instances (specialty) VALUES ('Ortopedia e traumatologia')`,
    );
    const [rows] = await db.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS n FROM shift_instances`,
    );
    expect(Number(rows[0].n)).toBe(7);
  });

  it("recusa aplicar se a coluna não aceitar NULL", async () => {
    const outro = `${DB_NAME}_notnull`;
    await admin.query(`DROP DATABASE IF EXISTS \`${outro}\``);
    await admin.query(`CREATE DATABASE \`${outro}\``);
    const alt = await mysql.createConnection({
      host: "127.0.0.1",
      user: "root",
      password: "root",
      database: outro,
      multipleStatements: true,
    });
    try {
      await alt.query(
        `CREATE TABLE shift_instances (
           id INT NOT NULL AUTO_INCREMENT,
           specialty VARCHAR(100) NOT NULL DEFAULT '',
           PRIMARY KEY (id)
         ) ENGINE=InnoDB`,
      );
      await expect(alt.query(migrationSql)).rejects.toThrow();
    } finally {
      await alt.end();
      await admin.query(`DROP DATABASE IF EXISTS \`${outro}\``);
    }
  });
});
