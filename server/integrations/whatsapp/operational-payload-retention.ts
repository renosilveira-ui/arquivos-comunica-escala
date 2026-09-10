/**
 * Retenção autônoma do payload operacional temporário do WhatsApp.
 *
 * Este loop não depende do driver de linguagem natural: retenção é uma
 * obrigação de minimização de dados mesmo quando o processamento NL está OFF.
 * Cada tick é limitado e cada lote revalida a expiração antes de limpar.
 */
import { logger } from "../../_core/logger";
import { ENV } from "../../_core/env";
import {
  clearExpiredWhatsAppInboundPayloadBatch,
  WHATSAPP_INBOUND_RETENTION_BATCH_SIZE,
  type WhatsAppInboundPayloadRetentionBatch,
} from "./operational-payload";
import {
  clearExpiredWhatsAppPendingIntentBatch,
  WHATSAPP_PENDING_RETENTION_BATCH_SIZE,
  type WhatsAppPendingRetentionBatchResult,
} from "./pending-intent-store";

export const WHATSAPP_PAYLOAD_RETENTION_MIN_INTERVAL_MS = 5 * 60 * 1000;
export const WHATSAPP_PAYLOAD_RETENTION_JITTER_MS = 10 * 60 * 1000;
export const WHATSAPP_PAYLOAD_RETENTION_MAX_BATCHES_PER_TICK = 4;

export type WhatsAppInboundRetentionSweepSummary = {
  available: boolean;
  batches: number;
  selected: number;
  cleared: number;
  capped: boolean;
};

export type WhatsAppPendingRetentionSweepSummary = {
  available: boolean;
  batches: number;
  selected: number;
  expired: number;
  payloadsCleared: number;
  capped: boolean;
};

export type WhatsAppPayloadRetentionTickSummary = {
  inbound: WhatsAppInboundRetentionSweepSummary;
  pending: WhatsAppPendingRetentionSweepSummary;
  stopped: boolean;
  durationMs: number;
};

export type WhatsAppPayloadRetentionTickOptions = {
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
  shuttingDown?: () => boolean;
  clearInboundBatch?: (input: {
    now?: Date;
    batchSize?: number;
  }) => Promise<WhatsAppInboundPayloadRetentionBatch>;
  clearPendingBatch?: (input: {
    now?: Date;
    batchSize?: number;
  }) => Promise<WhatsAppPendingRetentionBatchResult>;
};

function logSafe(payload: Record<string, unknown>): void {
  logger.info(JSON.stringify(payload));
}

export function whatsappPayloadRetentionDelayMs(
  random: () => number = Math.random,
): number {
  const sample = random();
  const bounded = Number.isFinite(sample)
    ? Math.min(1, Math.max(0, sample))
    : 0;
  return (
    WHATSAPP_PAYLOAD_RETENTION_MIN_INTERVAL_MS +
    Math.floor(bounded * WHATSAPP_PAYLOAD_RETENTION_JITTER_MS)
  );
}

async function executeWhatsAppOperationalPayloadRetentionTick(
  options: WhatsAppPayloadRetentionTickOptions,
): Promise<WhatsAppPayloadRetentionTickSummary> {
  const startedAt = Date.now();
  const now = options.now ?? new Date();
  const requestedBatchSize = Math.trunc(
    options.batchSize ?? WHATSAPP_INBOUND_RETENTION_BATCH_SIZE,
  );
  const batchSize = Math.min(
    WHATSAPP_INBOUND_RETENTION_BATCH_SIZE,
    WHATSAPP_PENDING_RETENTION_BATCH_SIZE,
    Math.max(1, Number.isFinite(requestedBatchSize) ? requestedBatchSize : 1),
  );
  const requestedMaxBatches = Math.trunc(
    options.maxBatches ?? WHATSAPP_PAYLOAD_RETENTION_MAX_BATCHES_PER_TICK,
  );
  const maxBatches = Math.min(
    WHATSAPP_PAYLOAD_RETENTION_MAX_BATCHES_PER_TICK,
    Math.max(
      1,
      Number.isFinite(requestedMaxBatches) ? requestedMaxBatches : 1,
    ),
  );
  const clearInboundBatch =
    options.clearInboundBatch ?? clearExpiredWhatsAppInboundPayloadBatch;
  const clearPendingBatch =
    options.clearPendingBatch ?? clearExpiredWhatsAppPendingIntentBatch;
  const inbound: WhatsAppInboundRetentionSweepSummary = {
    available: true,
    batches: 0,
    selected: 0,
    cleared: 0,
    capped: false,
  };
  const pending: WhatsAppPendingRetentionSweepSummary = {
    available: true,
    batches: 0,
    selected: 0,
    expired: 0,
    payloadsCleared: 0,
    capped: false,
  };

  try {
    while (inbound.batches < maxBatches && !options.shuttingDown?.()) {
      const result = await clearInboundBatch({ now, batchSize });
      inbound.available = result.available;
      if (!inbound.available) break;
      inbound.batches += 1;
      inbound.selected += result.selected;
      inbound.cleared += result.cleared;
      if (result.selected < result.batchSize) break;
      inbound.capped = inbound.batches === maxBatches;
    }
  } catch {
    inbound.available = false;
    logSafe({
      event: "whatsapp_inbound_payload_retention_failed",
      code: "PERSISTENCE_FAILED",
      batches: inbound.batches,
    });
  }

  logSafe({
    event: "whatsapp_inbound_payload_retention_tick",
    available: inbound.available,
    batches: inbound.batches,
    selected: inbound.selected,
    cleared: inbound.cleared,
    capped: inbound.capped,
  });

  try {
    while (pending.batches < maxBatches && !options.shuttingDown?.()) {
      const result = await clearPendingBatch({ now, batchSize });
      if (!result.ok) {
        pending.available = false;
        break;
      }
      pending.batches += 1;
      pending.selected += result.selected;
      pending.expired += result.expired;
      pending.payloadsCleared += result.payloadsCleared;
      if (result.selected < result.batchSize) break;
      pending.capped = pending.batches === maxBatches;
    }
  } catch {
    pending.available = false;
    logSafe({
      event: "whatsapp_pending_payload_retention_failed",
      code: "PERSISTENCE_FAILED",
      batches: pending.batches,
    });
  }

  logSafe({
    event: "whatsapp_pending_payload_retention_tick",
    available: pending.available,
    batches: pending.batches,
    selected: pending.selected,
    expired: pending.expired,
    payloadsCleared: pending.payloadsCleared,
    capped: pending.capped,
  });

  const summary: WhatsAppPayloadRetentionTickSummary = {
    inbound,
    pending,
    stopped: Boolean(options.shuttingDown?.()),
    durationMs: Date.now() - startedAt,
  };
  logSafe({
    event: "whatsapp_payload_retention_tick",
    inboundAvailable: summary.inbound.available,
    pendingAvailable: summary.pending.available,
    stopped: summary.stopped,
    durationMs: summary.durationMs,
  });
  return summary;
}

let inFlightTick: Promise<WhatsAppPayloadRetentionTickSummary> | null = null;

/** Chamadas concorrentes compartilham o mesmo tick; não há sweep sobreposto. */
export function runWhatsAppOperationalPayloadRetentionTick(
  options: WhatsAppPayloadRetentionTickOptions = {},
): Promise<WhatsAppPayloadRetentionTickSummary> {
  if (inFlightTick) return inFlightTick;
  const task = executeWhatsAppOperationalPayloadRetentionTick(options).finally(
    () => {
      if (inFlightTick === task) inFlightTick = null;
    },
  );
  inFlightTick = task;
  return task;
}

export type WhatsAppPayloadRetentionLoop = {
  start: () => void;
  stop: () => Promise<void>;
  isRunning: () => boolean;
};

export function createWhatsAppPayloadRetentionLoop(input: {
  runTick?: typeof runWhatsAppOperationalPayloadRetentionTick;
  delayMs?: () => number;
  log?: (payload: Record<string, unknown>) => void;
} = {}): WhatsAppPayloadRetentionLoop {
  const runTick =
    input.runTick ?? runWhatsAppOperationalPayloadRetentionTick;
  const delayMs = input.delayMs ?? whatsappPayloadRetentionDelayMs;
  const log = input.log ?? logSafe;
  const emit = (payload: Record<string, unknown>) => {
    try {
      log(payload);
    } catch {
      // Observabilidade não pode derrubar nem reter o loop de minimização.
    }
  };
  let loopGeneration = 0;
  let loopStarted = false;
  let activeLoop: Promise<void> | null = null;
  let activeSleep: {
    generation: number;
    timer: ReturnType<typeof setTimeout>;
    resolve: () => void;
  } | null = null;

  function cancelSleep(): void {
    const sleeping = activeSleep;
    if (!sleeping) return;
    activeSleep = null;
    clearTimeout(sleeping.timer);
    sleeping.resolve();
  }

  function sleep(generation: number): Promise<void> {
    if (!loopStarted || loopGeneration !== generation) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (
          activeSleep?.generation === generation &&
          activeSleep.timer === timer
        ) {
          activeSleep = null;
        }
        resolve();
      };
      const timer = setTimeout(finish, delayMs());
      activeSleep = { generation, timer, resolve: finish };
    });
  }

  async function runLoop(generation: number): Promise<void> {
    emit({
      event: "whatsapp_payload_retention_started",
      minIntervalMs: WHATSAPP_PAYLOAD_RETENTION_MIN_INTERVAL_MS,
      jitterMs: WHATSAPP_PAYLOAD_RETENTION_JITTER_MS,
      batchSize: WHATSAPP_INBOUND_RETENTION_BATCH_SIZE,
      pendingBatchSize: WHATSAPP_PENDING_RETENTION_BATCH_SIZE,
      maxBatchesPerTick: WHATSAPP_PAYLOAD_RETENTION_MAX_BATCHES_PER_TICK,
    });
    while (loopStarted && loopGeneration === generation) {
      try {
        await runTick({
          shuttingDown: () =>
            !loopStarted || loopGeneration !== generation,
        });
      } catch {
        emit({
          event: "whatsapp_payload_retention_loop_failed",
          code: "INTERNAL_FAILURE",
        });
      }
      if (!loopStarted || loopGeneration !== generation) return;
      await sleep(generation);
    }
  }

  return {
    start: () => {
      if (loopStarted || activeLoop) return;
      loopStarted = true;
      const generation = ++loopGeneration;
      const task = runLoop(generation)
        .catch(() => {
          emit({
            event: "whatsapp_payload_retention_loop_failed",
            code: "INTERNAL_FAILURE",
          });
        })
        .finally(() => {
          if (activeLoop === task) activeLoop = null;
          if (loopGeneration === generation) loopStarted = false;
        });
      activeLoop = task;
    },
    stop: () => {
      const drainingLoop = activeLoop;
      if (loopStarted) {
        loopStarted = false;
        loopGeneration += 1;
        cancelSleep();
        emit({ event: "whatsapp_payload_retention_stopped" });
      }
      return (drainingLoop ?? Promise.resolve()).then(() => undefined);
    },
    isRunning: () => loopStarted,
  };
}

const runtimeRetentionLoop = createWhatsAppPayloadRetentionLoop();

export function startWhatsAppOperationalPayloadRetention(): void {
  if (ENV.nodeEnv === "test") return;
  runtimeRetentionLoop.start();
}

export function stopWhatsAppOperationalPayloadRetention(): Promise<void> {
  return runtimeRetentionLoop.stop();
}

export function isWhatsAppOperationalPayloadRetentionRunning(): boolean {
  return runtimeRetentionLoop.isRunning();
}
