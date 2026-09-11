/**
 * Política de cadência da sincronização automática com o Google Agenda.
 *
 * Pura de propósito: sem banco e sem relógio próprio, para o teste dizer
 * exatamente quando uma conta está "na vez" e quando não está.
 *
 * ## As três perguntas que ela responde
 *
 * 1. **Com que frequência?** A cada 15 minutos por conta. A agenda muda por
 *    ação humana, não por segundo; 15 minutos é folgado para "o compromisso
 *    que marquei no Google já está no app" e mantém a conta dentro da cota
 *    do Google mesmo com centenas de médicos conectados.
 *
 * 2. **E quando falha?** Espera dobrando: 30 min, 1 h, 2 h… até 6 h. Uma
 *    conta cuja autorização caiu não pode custar uma chamada a cada tick
 *    para sempre — e a resposta certa para ela é o médico reconectar, não o
 *    servidor insistir.
 *
 * 3. **O que conta como "última tentativa"?** Sucesso grava `lastSyncedAt`.
 *    Falha registrada grava `updatedAt` (o vínculo muda de versão). Falha
 *    que estourou antes de registrar (rede, banco) só o processo sabe — por
 *    isso o cron guarda, em memória, quando tentou cada conta. Perde-se no
 *    reinício, o que custa no máximo uma tentativa extra por conta.
 */

export const GOOGLE_SYNC_INTERVAL_MS = 15 * 60_000;
export const GOOGLE_SYNC_MAX_BACKOFF_MS = 6 * 3_600_000;

export function backoffForFailures(consecutiveFailureCount: number): number {
  const n = Math.max(0, Math.floor(consecutiveFailureCount));
  if (n === 0) return GOOGLE_SYNC_INTERVAL_MS;
  const exponent = Math.min(n, 8);
  return Math.min(
    GOOGLE_SYNC_INTERVAL_MS * 2 ** exponent,
    GOOGLE_SYNC_MAX_BACKOFF_MS,
  );
}

export type SyncCandidate = {
  lastSyncedAt: Date | null;
  updatedAt: Date;
  consecutiveFailureCount: number;
};

export function isDueForSync(input: {
  candidate: SyncCandidate;
  lastAttemptAtMs: number | null;
  now: Date;
}): boolean {
  const nowMs = input.now.getTime();
  const { candidate } = input;

  if (
    input.lastAttemptAtMs !== null &&
    nowMs - input.lastAttemptAtMs < GOOGLE_SYNC_INTERVAL_MS
  ) {
    return false;
  }

  if (
    candidate.lastSyncedAt &&
    nowMs - candidate.lastSyncedAt.getTime() < GOOGLE_SYNC_INTERVAL_MS
  ) {
    return false;
  }

  if (candidate.consecutiveFailureCount > 0) {
    const wait = backoffForFailures(candidate.consecutiveFailureCount);
    if (nowMs - candidate.updatedAt.getTime() < wait) return false;
  }

  return true;
}
