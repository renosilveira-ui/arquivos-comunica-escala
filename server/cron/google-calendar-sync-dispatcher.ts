import { and, asc, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";

import {
  professionalInstitutions,
  userExternalCredentials,
  users,
} from "../../drizzle/schema";
import {
  EXTERNAL_LINK_STATES,
  EXTERNAL_PROVIDERS,
} from "../../lib/integration-providers";
import { logger } from "../_core/logger";
import { getDb } from "../db";
import { createGoogleCalendarProvider } from "../integrations/google/calendar-client";
import {
  runGoogleFullSync,
  summarizeGoogleFullSync,
} from "../integrations/google/full-sync";
import {
  readGoogleOAuthConfig,
  type GoogleOAuthConfig,
} from "../integrations/google/oauth";
import {
  GOOGLE_SYNC_INTERVAL_MS,
  isDueForSync,
} from "../integrations/google/sync-policy";
import type { ExternalCalendarProvider } from "../integrations/providers/calendar-provider";
import {
  readInstitutionTimeZone,
  resolveScheduleTimeZone,
} from "../institution-time-zone";

/**
 * Sincronização automática com o Google Agenda.
 *
 * Decisão do PO (12/09/2026): o app é o centro da gestão de tempo do médico,
 * e isso não pode depender de alguém apertar "Sincronizar agora". Este
 * worker faz, para cada conta conectada, exatamente o que o botão faz — o
 * mesmo ciclo, em `runGoogleFullSync` — a cada 15 minutos.
 *
 * ## Como escolhe quem sincroniza
 *
 * Varre `user_external_credentials` pelo índice (estado, última sincronização):
 * só CONNECTED/DEGRADED, os mais atrasados primeiro, em lotes pequenos por
 * tick. Conta que falhou espera dobrando (ver `sync-policy.ts`). Conta em
 * REAUTH_REQUIRED não entra: a resposta para ela é o médico reconectar.
 *
 * ## Isolamento
 *
 * Uma conta por vez, cada uma no seu `try`: a falha de um médico (token
 * revogado, Google fora) não impede o próximo. O motivo fica registrado no
 * vínculo dele pelo próprio ciclo (`recordGoogleOutcome`); aqui só se conta.
 *
 * ## O que este worker NÃO faz
 *
 * Não cria vínculo, não pede permissão, não toca em conta desconectada.
 * Não registra nada além de contagens e o id numérico da conta que falhou.
 *
 * **Plano do Render**: desde 10/09/2026 o staging está em instância sempre
 * ligada (`1c-2g`), e este `setInterval` roda contínuo. Num plano que dorme
 * (free), o processo pararia após 15 minutos sem tráfego e o timer com ele;
 * nada se perderia — o próximo acesso acordaria a instância e a varredura
 * retomaria pelos mais atrasados.
 */

const GOOGLE_SYNC_TICK_MS = 60_000;
const GOOGLE_SYNC_BATCH = 10;

let intervalId: ReturnType<typeof setInterval> | null = null;
let activeTick: Promise<void> | null = null;
let acceptingTicks = false;
let dormantForMissingSchema = false;
let warnedNotConfigured = false;
const lastAttemptAtMs = new Map<number, number>();

function isMissingSchema(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { code?: unknown }).code === "ER_NO_SUCH_TABLE";
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/** Somente para teste: esquece tentativas e reabilita o worker. */
export function resetGoogleCalendarSyncState(): void {
  dormantForMissingSchema = false;
  warnedNotConfigured = false;
  lastAttemptAtMs.clear();
}

export type GoogleCalendarSyncDeps = {
  provider?: ExternalCalendarProvider;
  config?: GoogleOAuthConfig | null;
  batch?: number;
};

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * Candidatas do tick: as mais atrasadas primeiro. O filtro fino (backoff e
 * tentativa recente) é aplicado em memória, por `isDueForSync`.
 */
export async function selectGoogleSyncCandidates(
  db: Db,
  now: Date,
  limit: number,
): Promise<
  {
    userId: number;
    lastSyncedAt: Date | null;
    updatedAt: Date;
    consecutiveFailureCount: number;
  }[]
> {
  const staleBefore = new Date(now.getTime() - GOOGLE_SYNC_INTERVAL_MS);
  return db
    .select({
      userId: userExternalCredentials.userId,
      lastSyncedAt: userExternalCredentials.lastSyncedAt,
      updatedAt: userExternalCredentials.updatedAt,
      consecutiveFailureCount: userExternalCredentials.consecutiveFailureCount,
    })
    .from(userExternalCredentials)
    .where(
      and(
        eq(userExternalCredentials.provider, EXTERNAL_PROVIDERS.googleCalendar),
        inArray(userExternalCredentials.linkState, [
          EXTERNAL_LINK_STATES.connected,
          EXTERNAL_LINK_STATES.degraded,
        ]),
        or(
          isNull(userExternalCredentials.lastSyncedAt),
          lte(userExternalCredentials.lastSyncedAt, staleBefore),
        ),
      ),
    )
    .orderBy(asc(userExternalCredentials.lastSyncedAt))
    .limit(limit);
}

/**
 * Fuso da conta para datas civis dos compromissos: o da instituição
 * principal da pessoa (ou a primeira ativa); sem vínculo, o padrão do
 * sistema. O botão usa o fuso do aparelho; aqui não há aparelho.
 */
async function resolveUserTimeZone(db: Db, userId: number): Promise<string> {
  const [row] = await db
    .select({ institutionId: professionalInstitutions.institutionId })
    .from(professionalInstitutions)
    .where(
      and(
        eq(professionalInstitutions.userId, userId),
        eq(professionalInstitutions.active, true),
      ),
    )
    .orderBy(
      desc(professionalInstitutions.isPrimary),
      asc(professionalInstitutions.id),
    )
    .limit(1);
  if (!row) return resolveScheduleTimeZone({});
  return readInstitutionTimeZone(db, row.institutionId);
}

export async function tickGoogleCalendarSync(
  now = new Date(),
  deps: GoogleCalendarSyncDeps = {},
): Promise<void> {
  if (activeTick) return activeTick;
  if (dormantForMissingSchema) return;

  let tick!: Promise<void>;
  tick = (async () => {
    try {
      const config =
        deps.config !== undefined ? deps.config : readGoogleOAuthConfig();
      if (!config) {
        if (!warnedNotConfigured) {
          warnedNotConfigured = true;
          logger.info(
            { event: "google_sync_not_configured" },
            "google calendar sync idle: provider not configured",
          );
        }
        return;
      }

      const db = await getDb();
      if (!db) return;

      const candidates = await selectGoogleSyncCandidates(
        db,
        now,
        deps.batch ?? GOOGLE_SYNC_BATCH,
      );
      if (!candidates.length) return;

      const provider = deps.provider ?? createGoogleCalendarProvider(config);
      let synced = 0;
      let failed = 0;
      let skipped = 0;
      let importedCreated = 0;
      let exportedCreated = 0;

      for (const candidate of candidates) {
        if (
          !isDueForSync({
            candidate,
            lastAttemptAtMs: lastAttemptAtMs.get(candidate.userId) ?? null,
            now,
          })
        ) {
          skipped += 1;
          continue;
        }
        lastAttemptAtMs.set(candidate.userId, now.getTime());

        try {
          const [user] = await db
            .select({ sessionVersion: users.sessionVersion })
            .from(users)
            .where(eq(users.id, candidate.userId))
            .limit(1);
          if (!user) {
            skipped += 1;
            continue;
          }
          const timeZone = await resolveUserTimeZone(db, candidate.userId);
          const result = await runGoogleFullSync({
            db,
            userId: candidate.userId,
            expectedSessionVersion: user.sessionVersion,
            config,
            provider,
            timeZone,
            now,
          });
          const summary = summarizeGoogleFullSync(result);
          if (result.exported.ok && summary.importOk) {
            synced += 1;
          } else {
            failed += 1;
          }
          importedCreated += summary.importedCreated;
          exportedCreated += summary.created;
        } catch (error) {
          if (isMissingSchema(error)) throw error;
          failed += 1;
          logger.warn(
            {
              event: "google_sync_user_failed",
              userId: candidate.userId,
              errorName: errorName(error),
            },
            "google calendar sync failed for one account",
          );
        }
      }

      if (synced + failed > 0) {
        logger.info(
          {
            event: "google_sync_tick",
            synced,
            failed,
            skipped,
            importedCreated,
            exportedCreated,
          },
          "google calendar sync tick",
        );
      }
    } catch (error) {
      if (isMissingSchema(error)) {
        dormantForMissingSchema = true;
        logger.warn(
          { event: "google_sync_schema_missing" },
          "google sync tables absent; worker dormant until the manual migration runs",
        );
        return;
      }
      logger.warn(
        { event: "google_sync_tick_failed", errorName: errorName(error) },
        "google calendar sync tick failed",
      );
    } finally {
      if (activeTick === tick) activeTick = null;
    }
  })();
  activeTick = tick;
  await tick;
}

export function startGoogleCalendarSyncCron(): void {
  if (intervalId) return;
  acceptingTicks = true;
  void tickGoogleCalendarSync();
  intervalId = setInterval(() => {
    if (acceptingTicks) void tickGoogleCalendarSync();
  }, GOOGLE_SYNC_TICK_MS);
}

export function stopGoogleCalendarSyncCron(): Promise<void> {
  acceptingTicks = false;
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  return activeTick ?? Promise.resolve();
}

export { GOOGLE_SYNC_BATCH, GOOGLE_SYNC_TICK_MS };
