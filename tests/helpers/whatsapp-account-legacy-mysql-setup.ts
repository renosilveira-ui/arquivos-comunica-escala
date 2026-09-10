import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import mysql, {
  type Connection,
  type Pool,
  type RowDataPacket,
} from "mysql2/promise";
import { SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { getTableConfig, MySqlDialect } from "drizzle-orm/mysql-core";
import { afterAll, beforeAll, expect, vi } from "vitest";
import {
  institutions,
  professionalAccess,
  professionalInstitutions,
  professionals,
  users,
} from "../../drizzle/schema";

const runtime = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../../server/db", async (original) => ({
  ...(await original<typeof import("../../server/db")>()),
  getDb: async () => runtime.db,
}));

// Apenas scaffolding das tabelas legadas necessárias. As duas migrations reais
// fornecem todos os índices/FKs do contato, desafio e auditoria sob revisão.
const DB_NAME = `escalas_test_wa_legacy_${process.pid}_${randomBytes(6).toString("hex")}`;
let admin: Connection;
let pool: Pool;
let ownsDatabase = false;
beforeAll(async () => {
  expect(DB_NAME).toMatch(/^escalas_test_wa_legacy_[0-9]+_[a-f0-9]{12}$/);
  admin = await mysql.createConnection({
    host: "127.0.0.1",
    user: "root",
    password: "root",
    multipleStatements: true,
  });
  const [version] = await admin.query<RowDataPacket[]>(
    "SELECT VERSION() AS version",
  );
  expect(String(version[0].version)).toMatch(/^8\./);
  await admin.query(`CREATE DATABASE \`${DB_NAME}\``);
  ownsDatabase = true;
  pool = mysql.createPool({
    host: "127.0.0.1",
    user: "root",
    password: "root",
    database: DB_NAME,
    multipleStatements: true,
    timezone: "Z",
  });
  const dialect = new MySqlDialect();
  for (const table of [
    users,
    institutions,
    professionals,
    professionalInstitutions,
    professionalAccess,
  ]) {
    const config = getTableConfig(table);
    const columns = config.columns.map((column) => {
      let definition = `\`${column.name}\` ${column.getSQLType()}${column.notNull ? " NOT NULL" : " NULL"}`;
      if ("autoIncrement" in column && column.autoIncrement)
        definition += " AUTO_INCREMENT";
      if (column.primary) definition += " PRIMARY KEY";
      if (column.default !== undefined) {
        const value =
          column.default instanceof SQL
            ? dialect.sqlToQuery(column.default)
            : null;
        if (value?.params.length)
          throw new Error("Unsupported fixture default");
        definition += ` DEFAULT ${value?.sql ?? mysql.escape(column.default)}`;
      }
      return definition;
    });
    await pool.query(
      `CREATE TABLE \`${config.name}\` (${columns.join(",")}) ENGINE=InnoDB`,
    );
  }
  await pool.query(
    "INSERT INTO institutions (name,cnpj) VALUES ('Test-only','00000000000000')",
  );
  for (const name of [
    "2026-08-31-user-contact-channels.sql",
    "2026-09-09-whatsapp-account-ownership.sql",
    "2026-09-04-whatsapp-inbound-messages.sql",
  ]) {
    await pool.query(readFileSync(`drizzle/migrations/manual/${name}`, "utf8"));
  }
  runtime.db = drizzle(pool);
});
afterAll(async () => {
  runtime.db = null;
  await pool?.end();
  if (ownsDatabase) await admin.query(`DROP DATABASE \`${DB_NAME}\``);
  await admin?.end();
});
