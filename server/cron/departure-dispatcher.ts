import { logger } from "../_core/logger";
import { getDb } from "../db";
import {
  dispatchDueDepartures,
  recomputeDuePlans,
  reconcileEnabledUsers,
  type DepartureSender,
} from "../departure-engine";
import { createGoogleLocationProvider } from "../integrations/google/places-client";
import {
  createWeatherKitProvider,
  readWeatherKitConfig,
} from "../integrations/apple/weatherkit-client";
import { googleMapsConfiguration } from "../integrations/providers/configuration";
import { PROVIDER_CONFIGURATION_STATES } from "../../lib/integration-providers";
import { enqueueTrackedPushNotification } from "../push-delivery";

/**
 * Worker do aviso de "hora de sair".
 *
 * Roda a cada minuto, mas cada tick é barato: só toca planos cujo prazo de
 * recálculo venceu e planos cuja hora de saída chegou. Um médico sem
 * preferência ligada não gera trabalho nenhum.
 *
 * **Plano do Render**: desde 10/09/2026 o staging está em instância sempre
 * ligada (`1c-2g`), e este `setInterval` roda contínuo. Num plano que dorme
 * (free), o processo pararia após 15 minutos sem tráfego e o timer com ele;
 * a fila em `departure_plans` sobreviveria — nada se perde — mas o aviso
 * atrasaria até o próximo acesso acordar a instância. Ver
 * docs/operations/departure-alerts.md.
 */

const DEPARTURE_INTERVAL_MS = 60_000;

/**
 * Com que frequência reconciliar planos com a escala.
 *
 * A escala muda por ação humana, não por segundo. Cinco minutos é folgado
 * diante da antecedência de uma hora do aviso, e mantém a varredura — a única
 * fase que olha usuários, não planos — longe do caminho de cada tick.
 */
const RECONCILE_INTERVAL_MS = 5 * 60_000;

let intervalId: ReturnType<typeof setInterval> | null = null;
let reconcileCursor = 0;
let lastReconcileAtMs = 0;
let activeTick: Promise<void> | null = null;
let acceptingTicks = false;
let dormantForMissingSchema = false;

/**
 * A migração manual é aplicada FORA do deploy (o deploy não roda migração).
 * Entre o merge e a aplicação, este worker consultaria tabelas que ainda não
 * existem — a cada 60 segundos, para sempre, enchendo o log de ruído que
 * esconde erro de verdade.
 *
 * Ao ver `ER_NO_SUCH_TABLE` ele registra UMA vez e adormece. O próximo boot,
 * já com a migração aplicada, volta a trabalhar normalmente.
 */
function isMissingSchema(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "ER_NO_SUCH_TABLE";
}

/** Somente para teste: reabilita o worker adormecido. */
export function resetDepartureDormancy(): void {
  dormantForMissingSchema = false;
  reconcileCursor = 0;
  lastReconcileAtMs = 0;
}

function locationProvider() {
  if (
    googleMapsConfiguration().state !== PROVIDER_CONFIGURATION_STATES.configured
  ) {
    return null;
  }
  return createGoogleLocationProvider(
    (process.env.GOOGLE_MAPS_API_KEY ?? "").trim(),
  );
}

function weatherProvider() {
  const config = readWeatherKitConfig();
  return config ? createWeatherKitProvider(config) : null;
}

/**
 * Envio pelo outbox durável que já existe.
 *
 * Reusar `enqueueTrackedPushNotification` em vez de falar com o Expo direto
 * herda de graça: idempotência por `dedupKey`, retry, receipts e a limpeza de
 * token inválido. Um caminho paralelo de push seria uma segunda chance de
 * errar tudo isso.
 */
const sendDeparture: DepartureSender = async (input) => {
  await enqueueTrackedPushNotification({
    institutionId: input.institutionId,
    userId: input.userId,
    shiftInstanceId: input.shiftInstanceId,
    dedupKey: input.dedupKey,
    deepLink: input.deepLink,
    payload: {
      title: input.title,
      body: input.body,
      data: {
        type: "departure_alert",
        shiftInstanceId: input.shiftInstanceId,
        deepLink: input.deepLink,
      },
    },
  });
};

export async function tickDeparture(now = new Date()): Promise<void> {
  if (!acceptingTicks) return;
  if (activeTick) return activeTick;

  if (dormantForMissingSchema) return;

  let tick!: Promise<void>;
  tick = (async () => {
    try {
      const db = await getDb();
      if (!db) return;

      // Reconciliar primeiro: sem isto o aviso só existiria para plantões
      // que já estavam na escala quando o médico ligou a preferência.
      let reconciled: Awaited<ReturnType<typeof reconcileEnabledUsers>> | null =
        null;
      if (now.getTime() - lastReconcileAtMs >= RECONCILE_INTERVAL_MS) {
        lastReconcileAtMs = now.getTime();
        reconciled = await reconcileEnabledUsers({
          db,
          now,
          afterUserId: reconcileCursor,
        }).catch((error) => {
          if (isMissingSchema(error)) {
            dormantForMissingSchema = true;
            logger.warn(
              { event: "departure_schema_missing" },
              "departure tables absent; worker dormant until the manual migration runs",
            );
            return null;
          }
          logger.warn(
            {
              event: "departure_reconcile_failed",
              errorName: errorName(error),
            },
            "departure reconcile tick failed",
          );
          return null;
        });
        if (dormantForMissingSchema) return;
        if (reconciled) reconcileCursor = reconciled.nextCursor;
      }

      // Recalcular e despachar são independentes de propósito: uma falha de
      // rede no cálculo não pode impedir o envio de um plano que já tinha
      // horário.
      const recomputed = await recomputeDuePlans({
        db,
        locationProvider: locationProvider(),
        weatherProvider: weatherProvider(),
        now,
      }).catch((error) => {
        if (isMissingSchema(error)) {
          dormantForMissingSchema = true;
          logger.warn(
            { event: "departure_schema_missing" },
            "departure tables absent; worker dormant until the manual migration runs",
          );
          return null;
        }
        logger.warn(
          { event: "departure_recompute_failed", errorName: errorName(error) },
          "departure recompute tick failed",
        );
        return null;
      });

      if (dormantForMissingSchema) return;

      const dispatched = await dispatchDueDepartures({
        db,
        send: sendDeparture,
        now,
      }).catch((error) => {
        if (isMissingSchema(error)) {
          dormantForMissingSchema = true;
          logger.warn(
            { event: "departure_schema_missing" },
            "departure tables absent; worker dormant until the manual migration runs",
          );
          return null;
        }
        logger.error(
          { event: "departure_dispatch_failed", errorName: errorName(error) },
          "departure dispatch tick failed",
        );
        return null;
      });

      const reconciledChanges = reconciled
        ? reconciled.created + reconciled.refreshed + reconciled.cancelled
        : 0;
      if (
        reconciledChanges > 0 ||
        (recomputed &&
          recomputed.withTraffic +
            recomputed.withoutTraffic +
            recomputed.expired >
            0) ||
        (dispatched && dispatched.sent + dispatched.expired > 0)
      ) {
        logger.info(
          {
            event: "departure_tick",
            planned: reconciled?.created ?? 0,
            refreshed: reconciled?.refreshed ?? 0,
            cancelled: reconciled?.cancelled ?? 0,
            withTraffic: recomputed?.withTraffic ?? 0,
            withoutTraffic: recomputed?.withoutTraffic ?? 0,
            sent: dispatched?.sent ?? 0,
            expired: (recomputed?.expired ?? 0) + (dispatched?.expired ?? 0),
          },
          "departure tick",
        );
      }
    } finally {
      if (activeTick === tick) activeTick = null;
    }
  })();
  activeTick = tick;
  await tick;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

export function startDepartureCron(): void {
  if (intervalId) return;
  acceptingTicks = true;
  void tickDeparture();
  intervalId = setInterval(() => void tickDeparture(), DEPARTURE_INTERVAL_MS);
}

export function stopDepartureCron(): Promise<void> {
  acceptingTicks = false;
  lastReconcileAtMs = 0;
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  return activeTick ?? Promise.resolve();
}

export { DEPARTURE_INTERVAL_MS, RECONCILE_INTERVAL_MS };
