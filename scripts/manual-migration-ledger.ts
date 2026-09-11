import { createHash } from "node:crypto";
import type { Connection, RowDataPacket } from "mysql2/promise";

/**
 * Ledger de migrações manuais aplicadas.
 *
 * Até 12/09/2026 não existia registro de QUAIS migrações manuais tinham sido
 * aplicadas em cada banco; a idempotência era responsabilidade de cada
 * arquivo e a verificação era por inferência (procurar a assinatura de cada
 * uma no catálogo). Foi assim que `2026-08-24-push-token-provenance.sql`
 * ficou 18 dias sem aplicar sem ninguém ver.
 *
 * O executor grava aqui depois de cada aplicação bem-sucedida: nome do
 * arquivo, hash do conteúdo, primeira/última aplicação e quantas vezes.
 * O hash denuncia arquivo editado depois de aplicado — que é exatamente o
 * caso em que "está no ledger" deixa de significar "o banco tem isto".
 *
 * A tabela é criada pelo próprio executor (idempotente) e também declarada
 * em `drizzle/schema.ts`, para a checagem de drift não a apontar.
 */

export const MANUAL_MIGRATION_LEDGER_TABLE = "manual_migration_ledger";

export const MANUAL_MIGRATION_LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS ${MANUAL_MIGRATION_LEDGER_TABLE} (
  id INT NOT NULL AUTO_INCREMENT,
  file_name VARCHAR(160) NOT NULL,
  content_sha256 CHAR(64) NOT NULL,
  first_applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  apply_count INT NOT NULL DEFAULT 1,
  note VARCHAR(255) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_manual_migration_ledger_file (file_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`.trim();

export function sha256Of(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function ensureManualMigrationLedger(
  connection: Connection,
): Promise<void> {
  await connection.query(MANUAL_MIGRATION_LEDGER_DDL);
}

export async function recordManualMigration(
  connection: Connection,
  input: { fileName: string; content: string; note?: string | null },
): Promise<void> {
  await ensureManualMigrationLedger(connection);
  await connection.query(
    `INSERT INTO ${MANUAL_MIGRATION_LEDGER_TABLE}
       (file_name, content_sha256, note)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       content_sha256 = VALUES(content_sha256),
       last_applied_at = CURRENT_TIMESTAMP,
       apply_count = apply_count + 1,
       note = COALESCE(VALUES(note), note)`,
    [input.fileName, sha256Of(input.content), input.note ?? null],
  );
}

export type ManualMigrationLedgerRow = {
  fileName: string;
  contentSha256: string;
  firstAppliedAt: Date;
  lastAppliedAt: Date;
  applyCount: number;
  note: string | null;
};

export async function listManualMigrationLedger(
  connection: Connection,
): Promise<ManualMigrationLedgerRow[]> {
  await ensureManualMigrationLedger(connection);
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT file_name, content_sha256, first_applied_at, last_applied_at, apply_count, note
     FROM ${MANUAL_MIGRATION_LEDGER_TABLE}
     ORDER BY file_name`,
  );
  return rows.map((row) => ({
    fileName: String(row.file_name),
    contentSha256: String(row.content_sha256),
    firstAppliedAt: row.first_applied_at as Date,
    lastAppliedAt: row.last_applied_at as Date,
    applyCount: Number(row.apply_count),
    note: row.note == null ? null : String(row.note),
  }));
}
