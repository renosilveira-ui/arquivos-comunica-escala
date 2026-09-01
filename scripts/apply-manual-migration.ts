/**
 * Aplica um arquivo SQL de drizzle/migrations/manual/ no banco apontado por
 * DATABASE_URL. Idempotência depende do próprio arquivo SQL.
 *
 * Uso:
 *   DATABASE_URL='mysql://...' DATABASE_SSL=insecure \
 *     pnpm apply:migration drizzle/migrations/manual/2026-08-27-professional-institutions-role.sql
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import mysql from "mysql2/promise";
import { pathToFileURL } from "node:url";
import { resolveSslConfig } from "../server/_core/db-ssl";

const READINESS_FENCE_V1_MIGRATION_BASENAME =
  "2026-09-01-readiness-fence-v1-clean.sql";
const READINESS_FENCE_V1_DEDICATED_DIRECTIVE = "@readiness-fence-trigger";
const READINESS_FENCE_V1_STRUCTURAL_IDENTIFIERS =
  /\b(?:institution_readiness_fence_events|institution_readiness_fences|institution_readiness_fence_installations|trg_rdf_[a-z0-9_]+)\b/i;

function requireNonEmpty(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} é obrigatório`);
  return value;
}

function buildConnectionOptions() {
  const rawUrl = requireNonEmpty("DATABASE_URL");
  const url = new URL(rawUrl);
  if (url.protocol !== "mysql:") {
    throw new Error("DATABASE_URL deve usar protocolo mysql://");
  }
  const database = url.pathname.replace(/^\//, "");
  if (!database) throw new Error("DATABASE_URL deve informar o banco");
  const sslMode = url.searchParams.get("ssl-mode")?.toUpperCase() ?? null;
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    multipleStatements: true,
    ssl:
      sslMode === "REQUIRED"
        ? { rejectUnauthorized: true }
        : resolveSslConfig(process.env),
  };
}

/**
 * A readiness fence não pode passar pelo executor genérico: ela precisa de
 * preflight do catálogo, lock de instalação e classificação PREPARED antes
 * de qualquer DDL. Também bloqueamos cópias com a diretiva dedicada, para
 * que renomear o arquivo ou remover o comentário de diretiva não remova essa
 * proteção. Esses identificadores pertencem exclusivamente à fence V1; uma
 * evolução futura deve ter seu próprio instalador dedicado.
 */
export function assertGenericManualMigrationAllowed(
  absolutePath: string,
  sql: string,
): void {
  if (
    basename(absolutePath) === READINESS_FENCE_V1_MIGRATION_BASENAME ||
    sql.includes(READINESS_FENCE_V1_DEDICATED_DIRECTIVE) ||
    READINESS_FENCE_V1_STRUCTURAL_IDENTIFIERS.test(sql)
  ) {
    throw new Error("READINESS_FENCE_V1_DEDICATED_INSTALLER_REQUIRED");
  }
}

export async function applyManualMigration(sqlPath: string): Promise<void> {
  const absolutePath = resolve(sqlPath);
  const sql = readFileSync(absolutePath, "utf8");
  if (!sql.trim()) throw new Error(`Arquivo SQL vazio: ${absolutePath}`);
  assertGenericManualMigrationAllowed(absolutePath, sql);

  const connection = await mysql.createConnection(buildConnectionOptions());
  try {
    await connection.query(sql);
    console.log(`Migração aplicada: ${absolutePath}`);
  } finally {
    await connection.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const sqlPath = process.argv[2];
  if (!sqlPath) {
    console.error(
      "Uso: pnpm apply:migration drizzle/migrations/manual/<arquivo>.sql",
    );
    process.exitCode = 1;
  } else {
    applyManualMigration(sqlPath).catch((error) => {
      console.error(
        "Falha ao aplicar migração:",
        error instanceof Error ? error.message : "erro desconhecido",
      );
      process.exitCode = 1;
    });
  }
}
