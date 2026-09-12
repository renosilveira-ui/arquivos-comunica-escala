/**
 * Aplica um arquivo SQL de drizzle/migrations/manual/ no banco apontado por
 * DATABASE_URL. Idempotência depende do próprio arquivo SQL. Cada aplicação
 * bem-sucedida fica registrada em `manual_migration_ledger`.
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
import { recordManualMigration } from "./manual-migration-ledger";

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

const SUPERSEDED_DIRECTIVE = /^\s*--\s*@superseded\s+(\S+)/m;

/**
 * Migração substituída por outra (mesma intenção, versão corrigida) fica no
 * repositório como histórico, mas não pode ser aplicada por engano: o
 * ledger registraria algo que a versão nova já cobre de outro jeito.
 */
export function assertNotSuperseded(sql: string): void {
  const match = SUPERSEDED_DIRECTIVE.exec(sql);
  if (match) {
    throw new Error(`MANUAL_MIGRATION_SUPERSEDED_BY:${match[1]}`);
  }
}

export async function applyManualMigration(sqlPath: string): Promise<void> {
  const absolutePath = resolve(sqlPath);
  const sql = readFileSync(absolutePath, "utf8");
  if (!sql.trim()) throw new Error(`Arquivo SQL vazio: ${absolutePath}`);
  assertGenericManualMigrationAllowed(absolutePath, sql);
  assertNotSuperseded(sql);

  const connection = await mysql.createConnection(buildConnectionOptions());
  try {
    try {
      await connection.query(sql);
    } catch (error) {
      // O ledger continua registrando só sucesso — um ledger que registra
      // tentativa é um ledger que mente, e "aplicada" precisa significar
      // aplicada. O que faltava era o operador SABER o que ficou para trás.
      //
      // DDL no MySQL faz commit implícito: um arquivo com vários passos que
      // falha no meio deixa os anteriores aplicados e nada no ledger. Sem
      // esta mensagem, quem roda vê só um stack trace e não tem como saber
      // que o banco pode estar a meio caminho.
      //
      // A saída é a mesma de sempre: corrigir o arquivo e rodar de novo.
      // Toda migração manual deste repositório é guardada e rerodável por
      // contrato — é exatamente para este momento que essa regra existe.
      console.error(
        [
          "",
          "MIGRAÇÃO FALHOU NO MEIO DO CAMINHO.",
          `Arquivo: ${basename(absolutePath)}`,
          "",
          "O que isso significa:",
          "  - o banco PODE estar parcialmente alterado (DDL no MySQL faz",
          "    commit implícito, então os passos anteriores ao erro já valem);",
          "  - NADA foi gravado no ledger: ele só registra sucesso, de propósito.",
          "",
          "O que fazer:",
          "  1. ler o erro abaixo e corrigir a causa;",
          "  2. rodar o mesmo comando de novo — as migrações deste repositório",
          "     são guardadas e rerodáveis, então repetir é seguro e retoma de",
          "     onde parou;",
          "  3. conferir o resultado com `pnpm schema:drift` antes de mergear.",
          "",
        ].join("\n"),
      );
      throw error;
    }
    // Só depois do sucesso: um ledger que registra tentativa é um ledger
    // que mente. Hash do conteúdo aplicado, para denunciar arquivo editado
    // depois. Ver docs/operations/migrations-ledger-and-drift.md.
    await recordManualMigration(connection, {
      fileName: basename(absolutePath),
      content: sql,
    });
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
