import type { ExternalCalendarProvider } from "../providers/calendar-provider";
import type { ProviderCallResult } from "../providers/types";
import { runGoogleCalendarImport, type ImportSummary } from "./import";
import { recordGoogleOutcome } from "./link-service";
import type { GoogleOAuthConfig } from "./oauth";
import {
  pullGoogleCalendarChanges,
  runGoogleCalendarExport,
  type SyncSummary,
} from "./sync";

/**
 * O ciclo completo de sincronização de UMA conta com o Google Agenda.
 *
 * Existe para que o botão "Sincronizar agora" e o cron automático façam
 * exatamente a mesma coisa, na mesma ordem. Dois caminhos que "quase" fazem
 * o mesmo é como um bug entra sem ninguém ver.
 *
 * A ordem importa:
 *   1. exportar (Escala+ → Google): plantões viram eventos no calendário
 *      dedicado;
 *   2. ler o calendário dedicado: eventos nossos apagados lá são esquecidos
 *      aqui;
 *   3. importar (Google → Escala+): compromissos do calendário principal.
 * Ler antes de exportar faria o ciclo processar mudanças que ele mesmo está
 * prestes a causar.
 *
 * Exportação falhando interrompe o ciclo: sem access token ou sem calendário
 * não há o que ler nem importar, e o motivo já ficou registrado no vínculo.
 * Importação falhando NÃO desfaz a exportação que já saiu.
 */

type ExportDb = Parameters<typeof runGoogleCalendarExport>[0]["db"];
type PullDb = Parameters<typeof pullGoogleCalendarChanges>[0]["db"];
type ImportDb = Parameters<typeof runGoogleCalendarImport>[0]["db"];

export type GoogleFullSyncDb = ExportDb & PullDb & ImportDb;

export type GoogleFullSyncResult = {
  exported: ProviderCallResult<SyncSummary>;
  pulled: ProviderCallResult<{ forgotten: number; resynced: boolean }> | null;
  imported: ProviderCallResult<ImportSummary> | null;
};

export async function runGoogleFullSync(input: {
  db: GoogleFullSyncDb;
  userId: number;
  expectedSessionVersion: number;
  config: GoogleOAuthConfig;
  provider: ExternalCalendarProvider;
  timeZone: string;
  now?: Date;
}): Promise<GoogleFullSyncResult> {
  const now = input.now ?? new Date();

  const exported = await runGoogleCalendarExport({
    db: input.db,
    userId: input.userId,
    config: input.config,
    provider: input.provider,
    timeZone: input.timeZone,
    now,
  });
  if (!exported.ok) return { exported, pulled: null, imported: null };

  const pulled = await pullGoogleCalendarChanges({
    db: input.db,
    userId: input.userId,
    config: input.config,
    provider: input.provider,
    now,
  });

  const imported = await runGoogleCalendarImport({
    db: input.db,
    userId: input.userId,
    expectedSessionVersion: input.expectedSessionVersion,
    config: input.config,
    provider: input.provider,
    timeZone: input.timeZone,
    now,
  });
  if (!imported.ok) {
    // A exportação acabou de registrar sucesso; sem isto, uma importação que
    // falha todo ciclo pareceria uma conta saudável — e o cron insistiria
    // nela a cada 15 minutos em vez de esperar o backoff.
    await recordGoogleOutcome({
      db: input.db,
      userId: input.userId,
      outcome: imported.outcome,
      reason: imported.reason,
      now,
    });
  }

  return { exported, pulled, imported };
}

/** O que a tela e o log mostram: só contagens, nunca conteúdo. */
export function summarizeGoogleFullSync(result: GoogleFullSyncResult): {
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  considered: number;
  resynced: boolean;
  importedCreated: number;
  importedUpdated: number;
  importedRemoved: number;
  importOk: boolean;
} {
  const exported = result.exported.ok ? result.exported.value : null;
  const imported = result.imported?.ok ? result.imported.value : null;
  return {
    created: exported?.created ?? 0,
    updated: exported?.updated ?? 0,
    deleted: exported?.deleted ?? 0,
    unchanged: exported?.unchanged ?? 0,
    considered: exported?.considered ?? 0,
    resynced: result.pulled?.ok ? result.pulled.value.resynced : false,
    importedCreated: imported?.created ?? 0,
    importedUpdated: imported?.updated ?? 0,
    importedRemoved: imported?.removed ?? 0,
    importOk: result.imported?.ok ?? false,
  };
}
