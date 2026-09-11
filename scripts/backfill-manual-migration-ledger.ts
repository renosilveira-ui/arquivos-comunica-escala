/**
 * Preenche o ledger com migrações que JÁ estavam aplicadas antes de o ledger
 * existir. Não aplica nada: só registra.
 *
 * Uso:
 *   DATABASE_URL='mysql://...' DATABASE_SSL=insecure \
 *     pnpm ledger:backfill "assinatura conferida no catálogo em 12/09/2026" \
 *       2026-08-06-sso-launch-codes.sql 2026-08-18-users-approval-status.sql ...
 *
 * Cada nome precisa existir em drizzle/migrations/manual/. O hash gravado é o
 * do conteúdo ATUAL do arquivo: se ele mudar depois, o ledger denuncia.
 *
 * Só para uso do operador, uma vez por banco, com a lista que a sonda de
 * assinaturas confirmou. Registrar o que não foi aplicado é pior que não
 * ter ledger.
 */
import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import mysql from "mysql2/promise";
import { resolveSslConfig } from "../server/_core/db-ssl";
import { recordManualMigration } from "./manual-migration-ledger";

const MANUAL_DIR = resolve(process.cwd(), "drizzle/migrations/manual");

function connectionOptions() {
  const rawUrl = process.env.DATABASE_URL?.trim();
  if (!rawUrl) throw new Error("DATABASE_URL é obrigatório");
  const url = new URL(rawUrl);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ""),
    ssl: resolveSslConfig(process.env),
  };
}

export async function backfillLedger(
  note: string,
  fileNames: string[],
): Promise<number> {
  if (!note.trim()) throw new Error("a nota (motivo) é obrigatória");
  if (!fileNames.length) throw new Error("informe ao menos um arquivo");
  const files = fileNames.map((name) => {
    const fileName = basename(name);
    const path = resolve(MANUAL_DIR, fileName);
    if (!existsSync(path)) throw new Error(`não existe: ${fileName}`);
    return { fileName, content: readFileSync(path, "utf8") };
  });
  const connection = await mysql.createConnection(connectionOptions());
  try {
    for (const file of files) {
      await recordManualMigration(connection, { ...file, note: note.trim() });
    }
    return files.length;
  } finally {
    await connection.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [note, ...names] = process.argv.slice(2);
  backfillLedger(note ?? "", names)
    .then((count) => {
      console.log(`Ledger: ${count} migração(ões) registrada(s).`);
    })
    .catch((error) => {
      console.error(
        "Falha no backfill do ledger:",
        error instanceof Error ? error.message : "erro desconhecido",
      );
      process.exitCode = 1;
    });
}
