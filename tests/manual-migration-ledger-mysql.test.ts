import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql, { type Connection } from "mysql2/promise";

import {
  MANUAL_MIGRATION_LEDGER_TABLE,
  listManualMigrationLedger,
  recordManualMigration,
  sha256Of,
} from "../scripts/manual-migration-ledger";

const DB_NAME = `escalas_test_ledger_${process.pid}`;

/**
 * O ledger só vale se for verdadeiro: cria-se sozinho, registra uma vez por
 * arquivo, conta reaplicações e denuncia conteúdo alterado pelo hash.
 */
describe("ledger de migrações manuais", () => {
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

  it("cria a tabela sozinho e registra a primeira aplicação", async () => {
    await recordManualMigration(db, {
      fileName: "2026-09-12-exemplo.sql",
      content: "SELECT 1;",
    });
    const rows = await listManualMigrationLedger(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fileName: "2026-09-12-exemplo.sql",
      contentSha256: sha256Of("SELECT 1;"),
      applyCount: 1,
      note: null,
    });
  });

  it("reaplicar conta, mantém a primeira data e atualiza o hash se o arquivo mudou", async () => {
    const [before] = await listManualMigrationLedger(db);
    await recordManualMigration(db, {
      fileName: "2026-09-12-exemplo.sql",
      content: "SELECT 2;",
      note: "reaplicação de prova",
    });
    const [after] = await listManualMigrationLedger(db);
    expect(after.applyCount).toBe(2);
    expect(after.contentSha256).toBe(sha256Of("SELECT 2;"));
    expect(after.firstAppliedAt.getTime()).toBe(before.firstAppliedAt.getTime());
    expect(after.note).toBe("reaplicação de prova");
  });

  it("nome de arquivo é único: um registro por migração", async () => {
    await recordManualMigration(db, {
      fileName: "2026-09-12-outra.sql",
      content: "SELECT 3;",
    });
    const rows = await listManualMigrationLedger(db);
    expect(rows.map((r) => r.fileName)).toEqual([
      "2026-09-12-exemplo.sql",
      "2026-09-12-outra.sql",
    ]);
    const [count] = await db.query<[{ n: number }] & unknown[]>(
      `SELECT COUNT(*) AS n FROM ${MANUAL_MIGRATION_LEDGER_TABLE}`,
    );
    expect(Number((count as unknown as { n: number }[])[0]?.n)).toBe(2);
  });
});
