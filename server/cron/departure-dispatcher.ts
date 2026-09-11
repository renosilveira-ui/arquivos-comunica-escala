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
import {
  TrackedIntentCollisionError,
  enqueueTrackedPushNotification,
} from "../push-delivery";
import { SchemaDormancy, isMissingSchema } from "./schema-dormancy";

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
/** Tabelas ausentes (migração manual ainda não aplicada): pausa e re-tenta. */
const schemaDormancy = new SchemaDormancy();

/** Somente para teste: reabilita o worker adormecido. */
export function resetDepartureDormancy(): void {
  schemaDormancy.reset();
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
 *
 * A mensagem depende do relógio ("saia até 10:00" vira "saia agora"). Numa
 * retentativa, a intenção com a mesma `dedupKey` pode já estar gravada com o
 * texto anterior: isso não é falha, é a prova de que o primeiro
 * enfileiramento chegou ao outbox. Sem este tratamento a retentativa
 * colidiria para sempre e o aviso se perderia em silêncio.
 */
export const sendDeparture: DepartureSender = async (input) => {
  try {
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
  } catch (error) {
    if (error instanceof TrackedIntentCollisionError) return;
    throw error;
  }
};

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/**
 * Falha de uma etapa do tick. Tabela ausente pausa o worker inteiro; o resto
 * é registrado e a etapa devolve `null`, para as outras seguirem — uma falha
 * de rede no cálculo não pode impedir o envio de um plano que já tinha
 * horário.
 */
function stepFailure(
  error: unknown,
  now: Date,
  step: { event: string; level: "warn" | "error"; message: string },
): null {
  if (isMissingSchema(error)) {
    logger.warn(
      {
        event: "departure_schema_missing",
        retryInSeconds: schemaDormancy.markMissing(now),
      },
      "departure tables absent; worker pauses and retries after the manual migration runs",
    );
    return null;
  }
  logger[step.level](
    { event: step.event, errorName: errorName(error) },
    step.message,
  );
  return null;
}

export async function tickDeparture(now = new Date()): Promise<void> {
  if (!acceptingTicks) return;
  if (activeTick) return activeTick;
  if (schemaDormancy.isDormant(now)) return;

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
        }).catch((error) =>
          stepFailure(error, now, {
            event: "departure_reconcile_failed",
            level: "warn",
            message: "departure reconcile tick failed",
          }),
        );
        if (schemaDormancy.isDormant(now)) return;
        if (reconciled) reconcileCursor = reconciled.nextCursor;
      }

      // Recalcular e despachar são independentes de propósito.
      const recomputed = await recomputeDuePlans({
        db,
        locationProvider: locationProvider(),
        weatherProvider: weatherProvider(),
        now,
      }).catch((error) =>
        stepFailure(error, now, {
          event: "departure_recompute_failed",
          level: "warn",
          message: "departure recompute tick failed",
        }),
      );
      if (schemaDormancy.isDormant(now)) return;

      const dispatched = await dispatchDueDepartures({
        db,
        send: sendDeparture,
        now,
      }).catch((error) =>
        stepFailure(error, now, {
          event: "departure_dispatch_failed",
          level: "error",
          message: "departure dispatch tick failed",
        }),
      );

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
        (dispatched &&
          dispatched.sent +
            dispatched.expired +
            dispatched.failed +
            dispatched.cancelled >
            0)
      ) {
        logger.info(
          {
            event: "departure_tick",
            planned: reconciled?.created ?? 0,
            refreshed: reconciled?.refreshed ?? 0,
            cancelled: reconciled?.cancelled ?? 0,
            cancelledDeletedAccount: dispatched?.cancelled ?? 0,
            withTraffic: recomputed?.withTraffic ?? 0,
            withoutTraffic: recomputed?.withoutTraffic ?? 0,
            sent: dispatched?.sent ?? 0,
            failed: dispatched?.failed ?? 0,
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
