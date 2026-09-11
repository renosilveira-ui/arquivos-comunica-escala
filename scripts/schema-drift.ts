/**
 * Checagem de drift schema ↔ banco real. Só leitura (INFORMATION_SCHEMA).
 *
 * Uso (operador, antes de declarar um ambiente "em dia"):
 *
 *   # 1) referência: um banco LOCAL vazio recebendo o schema atual
 *   DATABASE_URL='mysql://root:root@127.0.0.1:3306/escalas_ref' pnpm exec drizzle-kit push --force
 *   # 2) comparar com o banco real (só leitura)
 *   SCHEMA_DRIFT_REFERENCE_URL='mysql://root:root@127.0.0.1:3306/escalas_ref' \
 *   DATABASE_URL='mysql://...banco real...' DATABASE_SSL=insecure pnpm schema:drift
 *
 * Sai com código 1 se houver diferença fora da allowlist
 * (`drizzle/schema-drift-allowlist.json`). Nunca escreve em nenhum dos dois.
 *
 * Por que não roda na CI: o banco real não é alcançável da CI, e um banco
 * construído só das migrações manuais não existe — a base nasceu do Drizzle.
 * O que a CI garante é o núcleo (`tests/schema-drift-core.test.ts`).
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import mysql, { type RowDataPacket } from "mysql2/promise";
import { resolveSslConfig } from "../server/_core/db-ssl";
import {
  buildCatalog,
  diffCatalogs,
  formatDrift,
  type AllowlistEntry,
  type RawCatalog,
} from "./schema-drift-core";

function connectionOptions(rawUrl: string, ssl: boolean) {
  const url = new URL(rawUrl);
  if (url.protocol !== "mysql:") throw new Error("URL deve usar mysql://");
  const database = url.pathname.replace(/^\//, "");
  if (!database) throw new Error("URL deve informar o banco");
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    ssl: ssl ? resolveSslConfig(process.env) : undefined,
  };
}

export async function readRawCatalog(
  rawUrl: string,
  ssl: boolean,
): Promise<RawCatalog> {
  const connection = await mysql.createConnection(connectionOptions(rawUrl, ssl));
  try {
    const q = async <T extends RowDataPacket>(sql: string) =>
      (await connection.query<T[]>(sql))[0];
    const tables = await q<RowDataPacket>(
      `SELECT TABLE_NAME AS name, ENGINE AS engine
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'`,
    );
    const columns = await q<RowDataPacket>(
      `SELECT TABLE_NAME AS tbl, COLUMN_NAME AS name, COLUMN_TYPE AS columnType,
              IS_NULLABLE AS nullable, COLUMN_DEFAULT AS columnDefault, EXTRA AS extra,
              COLLATION_NAME AS collation, GENERATION_EXPRESSION AS generation
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()`,
    );
    const indexes = await q<RowDataPacket>(
      `SELECT TABLE_NAME AS tbl, INDEX_NAME AS name, NON_UNIQUE AS nonUnique,
              GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
       FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
       GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE`,
    );
    const checks = await q<RowDataPacket>(
      `SELECT tc.TABLE_NAME AS tbl, tc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS clause
       FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
       JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc
         ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
       WHERE tc.CONSTRAINT_SCHEMA = DATABASE() AND tc.CONSTRAINT_TYPE = 'CHECK'`,
    );
    const foreignKeys = await q<RowDataPacket>(
      `SELECT TABLE_NAME AS tbl, CONSTRAINT_NAME AS name,
              GROUP_CONCAT(CONCAT(COLUMN_NAME, '->', REFERENCED_TABLE_NAME, '.', REFERENCED_COLUMN_NAME) ORDER BY ORDINAL_POSITION) AS refs
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
       GROUP BY TABLE_NAME, CONSTRAINT_NAME`,
    );
    const triggers = await q<RowDataPacket>(
      `SELECT EVENT_OBJECT_TABLE AS tbl, TRIGGER_NAME AS name
       FROM INFORMATION_SCHEMA.TRIGGERS
       WHERE TRIGGER_SCHEMA = DATABASE()`,
    );
    return {
      tables: tables.map((r) => ({ name: String(r.name), engine: r.engine ?? null })),
      columns: columns.map((r) => ({
        table: String(r.tbl),
        name: String(r.name),
        columnType: String(r.columnType),
        nullable: String(r.nullable),
        columnDefault: r.columnDefault ?? null,
        extra: r.extra ?? null,
        collation: r.collation ?? null,
        generation: r.generation ?? null,
      })),
      indexes: indexes.map((r) => ({
        table: String(r.tbl),
        name: String(r.name),
        unique: Number(r.nonUnique) === 0,
        columns: String(r.cols).split(","),
      })),
      checks: checks.map((r) => ({
        table: String(r.tbl),
        name: String(r.name),
        clause: String(r.clause),
      })),
      foreignKeys: foreignKeys.map((r) => ({
        table: String(r.tbl),
        name: String(r.name),
        references: String(r.refs).split(","),
      })),
      triggers: triggers.map((r) => ({
        table: String(r.tbl),
        name: String(r.name),
      })),
    };
  } finally {
    await connection.end();
  }
}

export function loadAllowlist(path: string): AllowlistEntry[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("allowlist deve ser uma lista");
  return parsed.map((entry) => {
    const e = entry as Partial<AllowlistEntry>;
    if (typeof e.pattern !== "string" || typeof e.reason !== "string") {
      throw new Error("entrada da allowlist precisa de pattern e reason");
    }
    return { pattern: e.pattern, reason: e.reason };
  });
}

async function main(): Promise<number> {
  const referenceUrl = process.env.SCHEMA_DRIFT_REFERENCE_URL?.trim();
  const targetUrl = process.env.DATABASE_URL?.trim();
  if (!referenceUrl || !targetUrl) {
    console.error(
      "Uso: SCHEMA_DRIFT_REFERENCE_URL=<banco local com o schema> DATABASE_URL=<banco real> pnpm schema:drift",
    );
    return 2;
  }
  const allowlist = loadAllowlist(
    resolve(process.cwd(), "drizzle/schema-drift-allowlist.json"),
  );
  const [reference, target] = await Promise.all([
    readRawCatalog(referenceUrl, false),
    readRawCatalog(targetUrl, true),
  ]);
  const result = diffCatalogs(
    buildCatalog(reference),
    buildCatalog(target),
    allowlist,
  );
  console.log(formatDrift(result));
  return result.unexpected.length ? 1 : 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(
        "Falha na checagem de drift:",
        error instanceof Error ? error.message : "erro desconhecido",
      );
      process.exitCode = 2;
    });
}
