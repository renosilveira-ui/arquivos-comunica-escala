import { logger } from "../_core/logger";
import { getDb } from "../db";
import {
  dispatchDueDepartures,
  recomputeDuePlans,
  type DepartureSender,
} from "../departure-engine";
import { createGoogleLocationProvider } from "../integrations/google/places-client";
import { createWeatherKitProvider } from "../integrations/apple/weatherkit-client";
import { readWeatherKitConfig } from "../integrations/apple/weatherkit-client";
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
 * **Limite operacional conhecido**: no plano free do Render o processo dorme
 * após 15 minutos sem tráfego, e com ele some este `setInterval`. A fila em
 * `departure_plans` sobrevive — nada se perde — mas o aviso pode atrasar até
 * o próximo acesso acordar a instância. Cobertura 24/7 exige instância
 * sempre-on ou Cron do Render, que são decisões de custo do PO. Ver
 * docs/operations/departure-alerts.md.
 */

const DEPARTURE_INTERVAL_MS = 60_000;
let intervalId: ReturnType<typeof setInterval> | null = null;
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

      if (
        (recomputed && recomputed.computed + recomputed.fallback > 0) ||
        (dispatched && dispatched.sent + dispatched.expired > 0)
      ) {
        logger.info(
          {
            event: "departure_tick",
            computed: recomputed?.computed ?? 0,
            fallback: recomputed?.fallback ?? 0,
            sent: dispatched?.sent ?? 0,
            expired: dispatched?.expired ?? 0,
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
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  return activeTick ?? Promise.resolve();
}

export { DEPARTURE_INTERVAL_MS };
