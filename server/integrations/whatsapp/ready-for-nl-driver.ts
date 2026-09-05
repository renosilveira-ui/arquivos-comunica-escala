/**
 * Driver B2-D: despacha READY_FOR_NL TEXT autenticado para B2-C.
 *
 * Quem/quando: poll durável da inbound (fila = DB), não o webhook Twilio.
 * O webhook continua receive → authenticate → persist → ACK.
 *
 * Semântica: at-least-once + consumer B2-C idempotente. Não é exactly-once.
 * Não executa swap. Não envia WhatsApp. Não parseia/resolve.
 */
import { randomBytes } from "node:crypto";
import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import {
  whatsappInboundMessages,
  whatsappPendingIntents,
} from "../../../drizzle/schema";
import * as dbMod from "../../db";
import { logger } from "../../_core/logger";
import { ENV } from "../../_core/env";
import {
  WHATSAPP_INBOUND_PROVIDER,
  WhatsAppInboundStatuses,
} from "./types";
import * as readyForNlConsumer from "./ready-for-nl-consumer";
import {
  classifyWhatsAppNlDriverOutcome,
  formatWhatsAppNlDriverClaimed,
  formatWhatsAppNlDriverPark,
  formatWhatsAppNlDriverRetry,
  formatWhatsAppNlDriverWait,
  nextWhatsAppNlDriverAttempt,
  parseWhatsAppNlDriverOccupancy,
  WHATSAPP_NL_DRIVER_BATCH_SIZE,
  WHATSAPP_NL_DRIVER_CLAIMED_LIKE,
  WHATSAPP_NL_DRIVER_CLAIMED_REGEXP,
  WHATSAPP_NL_DRIVER_INTERVAL_MS,
  WHATSAPP_NL_DRIVER_JITTER_MS,
  WHATSAPP_NL_DRIVER_LEASE_MS,
  WHATSAPP_NL_DRIVER_MALFORMED_PARK_CODE,
  WHATSAPP_NL_DRIVER_RETRY_ATTEMPT_SQL_OFFSET,
  WHATSAPP_NL_DRIVER_RETRY_DELAY_MS,
  WHATSAPP_NL_DRIVER_RETRY_LIKE,
  WHATSAPP_NL_DRIVER_RETRY_REGEXP,
  WHATSAPP_NL_DRIVER_WAIT_ATTEMPT_SQL_OFFSET,
  WHATSAPP_NL_DRIVER_WAIT_DELAY_MS,
  WHATSAPP_NL_DRIVER_WAIT_LIKE,
  WHATSAPP_NL_DRIVER_WAIT_REGEXP,
  type WhatsAppNlDriverDecision,
} from "./ready-for-nl-driver-occupancy";
import { WhatsAppPendingStages, WhatsAppPendingStatuses } from "./pending-intent-types";

type Db = NonNullable<Awaited<ReturnType<typeof dbMod.getDb>>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type WhatsAppNlDriverTickOptions = {
  now?: Date;
  batchSize?: number;
  leaseMs?: number;
  shuttingDown?: () => boolean;
};

export type WhatsAppNlDriverItemOutcome = {
  sourceInboundMessageId: number;
  attempt: number;
  action: WhatsAppNlDriverDecision["action"];
  disposition: WhatsAppNlDriverDecision["disposition"];
  b2cKind: string;
  b2cCode?: string;
  durationMs: number;
  retryAt?: string;
};

export type WhatsAppNlDriverTickSummary = {
  claimed: number;
  completed: number;
  retried: number;
  waited: number;
  parked: number;
  skipped: number;
  durationMs: number;
  items: WhatsAppNlDriverItemOutcome[];
};

export type ClaimedWork = {
  id: number;
  attempt: number;
  claimCode: string;
  payloadExpiresAt: Date | null;
};

function logSafe(payload: Record<string, unknown>): void {
  logger.info(JSON.stringify(payload));
}

function claimToken(): string {
  return randomBytes(6).toString("hex");
}

export function isWhatsAppNlDriverEnabled(): boolean {
  return ENV.whatsappNlDriverEnabled;
}

function backoffSecondsSql(
  delayMs: readonly number[],
  attemptSqlOffset: number,
) {
  const seconds = delayMs.map((ms) => Math.round(ms / 1000));
  const first = seconds[0] ?? 30;
  const last = seconds[seconds.length - 1] ?? 3600;
  const whenClauses = seconds.map(
    (value, index) => sql`WHEN ${index + 1} THEN ${value}`,
  );
  return sql`CASE CAST(
      SUBSTRING(
        ${whatsappInboundMessages.errorCode},
        ${attemptSqlOffset}
      ) AS UNSIGNED
    )
      WHEN 0 THEN ${first}
      ${sql.join(whenClauses, sql` `)}
      ELSE ${last}
    END`;
}

function retryBackoffSecondsSql() {
  return backoffSecondsSql(
    WHATSAPP_NL_DRIVER_RETRY_DELAY_MS,
    WHATSAPP_NL_DRIVER_RETRY_ATTEMPT_SQL_OFFSET,
  );
}

function waitBackoffSecondsSql() {
  return backoffSecondsSql(
    WHATSAPP_NL_DRIVER_WAIT_DELAY_MS,
    WHATSAPP_NL_DRIVER_WAIT_ATTEMPT_SQL_OFFSET,
  );
}

function occupancyEligibleSql(now: Date, leaseMs: number) {
  const nowUnix = Math.floor(now.getTime() / 1000);
  const leaseSeconds = Math.max(1, Math.ceil(leaseMs / 1000));
  return sql`(
    ${whatsappInboundMessages.errorCode} IS NULL
    OR (
      ${whatsappInboundMessages.errorCode} LIKE ${WHATSAPP_NL_DRIVER_CLAIMED_LIKE}
      AND ${whatsappInboundMessages.errorCode} REGEXP ${WHATSAPP_NL_DRIVER_CLAIMED_REGEXP}
      AND UNIX_TIMESTAMP(${whatsappInboundMessages.updatedAt}) + ${leaseSeconds}
        <= ${nowUnix}
    )
    OR (
      ${whatsappInboundMessages.errorCode} LIKE ${WHATSAPP_NL_DRIVER_RETRY_LIKE}
      AND ${whatsappInboundMessages.errorCode} REGEXP ${WHATSAPP_NL_DRIVER_RETRY_REGEXP}
      AND UNIX_TIMESTAMP(${whatsappInboundMessages.updatedAt}) + (
        ${retryBackoffSecondsSql()}
      ) <= ${nowUnix}
    )
    OR (
      ${whatsappInboundMessages.errorCode} LIKE ${WHATSAPP_NL_DRIVER_WAIT_LIKE}
      AND ${whatsappInboundMessages.errorCode} REGEXP ${WHATSAPP_NL_DRIVER_WAIT_REGEXP}
      AND UNIX_TIMESTAMP(${whatsappInboundMessages.updatedAt}) + (
        ${waitBackoffSecondsSql()}
      ) <= ${nowUnix}
    )
  )`;
}

function durablePendingExists(now: Date) {
  return sql`EXISTS (
    SELECT 1
    FROM whatsapp_pending_intents p
    WHERE p.source_inbound_message_id = ${whatsappInboundMessages.id}
      AND p.status = ${WhatsAppPendingStatuses.OPEN}
      AND p.stage IN (
        ${WhatsAppPendingStages.CLARIFICATION},
        ${WhatsAppPendingStages.CONFIRMATION}
      )
      AND p.expires_at > ${now}
  )`;
}

function payloadUsable(now: Date) {
  return and(
    isNotNull(whatsappInboundMessages.operationalText),
    or(
      isNull(whatsappInboundMessages.payloadExpiresAt),
      gt(whatsappInboundMessages.payloadExpiresAt, now),
    ),
  );
}

function eligibilityWhere(now: Date, leaseMs: number) {
  return and(
    eq(whatsappInboundMessages.provider, WHATSAPP_INBOUND_PROVIDER),
    eq(
      whatsappInboundMessages.processingStatus,
      WhatsAppInboundStatuses.READY_FOR_NL,
    ),
    eq(whatsappInboundMessages.contentKind, "TEXT"),
    isNotNull(whatsappInboundMessages.userId),
    isNull(whatsappInboundMessages.payloadClearedAt),
    occupancyEligibleSql(now, leaseMs),
    or(payloadUsable(now), durablePendingExists(now)),
  );
}

export async function claimWhatsAppReadyForNlWork(
  options: WhatsAppNlDriverTickOptions = {},
): Promise<ClaimedWork[]> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? WHATSAPP_NL_DRIVER_BATCH_SIZE;
  const leaseMs = options.leaseMs ?? WHATSAPP_NL_DRIVER_LEASE_MS;
  const db = await dbMod.getDb();
  if (!db) return [];
  return claimBatch(db, now, batchSize, leaseMs);
}

/**
 * Discovery sem claim — mesmo predicado de elegibilidade do poll.
 * Usado para provar gates READY_FOR_NL / TEXT sem depender do UPDATE.
 */
export async function listWhatsAppReadyForNlEligibleIds(
  options: WhatsAppNlDriverTickOptions = {},
): Promise<number[]> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? WHATSAPP_NL_DRIVER_BATCH_SIZE;
  const leaseMs = options.leaseMs ?? WHATSAPP_NL_DRIVER_LEASE_MS;
  const db = await dbMod.getDb();
  if (!db) return [];
  const rows = await db
    .select({ id: whatsappInboundMessages.id })
    .from(whatsappInboundMessages)
    .where(eligibilityWhere(now, leaseMs))
    .orderBy(whatsappInboundMessages.receivedAt, whatsappInboundMessages.id)
    .limit(batchSize);
  return rows.map((row) => row.id);
}

async function parkMalformedOccupancy(
  tx: Tx,
  row: { id: number; errorCode: string | null },
  now: Date,
): Promise<number> {
  if (row.errorCode == null || row.errorCode === "") return 0;
  const updated = await tx
    .update(whatsappInboundMessages)
    .set({
      errorCode: formatWhatsAppNlDriverPark(
        WHATSAPP_NL_DRIVER_MALFORMED_PARK_CODE,
      ),
      updatedAt: now,
    })
    .where(
      and(
        eq(whatsappInboundMessages.id, row.id),
        eq(whatsappInboundMessages.errorCode, row.errorCode),
        eq(
          whatsappInboundMessages.processingStatus,
          WhatsAppInboundStatuses.READY_FOR_NL,
        ),
        isNull(whatsappInboundMessages.payloadClearedAt),
      ),
    );
  return affectedRows(updated);
}

async function claimPass(
  tx: Tx,
  now: Date,
  batchSize: number,
  leaseMs: number,
): Promise<{ claimed: ClaimedWork[]; repaired: number }> {
  const rows = await tx
    .select({
      id: whatsappInboundMessages.id,
      errorCode: whatsappInboundMessages.errorCode,
      payloadExpiresAt: whatsappInboundMessages.payloadExpiresAt,
    })
    .from(whatsappInboundMessages)
    .where(eligibilityWhere(now, leaseMs))
    .orderBy(whatsappInboundMessages.receivedAt, whatsappInboundMessages.id)
    .limit(batchSize)
    .for("update", { skipLocked: true });

  const claimed: ClaimedWork[] = [];
  let repaired = 0;
  for (const row of rows) {
    const occupancy = parseWhatsAppNlDriverOccupancy(row.errorCode);
    if (occupancy.kind === "park") continue;
    if (occupancy.kind === "foreign") {
      repaired += await parkMalformedOccupancy(tx, row, now);
      continue;
    }
    const attempt = nextWhatsAppNlDriverAttempt(occupancy);
    const claimCode = formatWhatsAppNlDriverClaimed(attempt, claimToken());
    const updated = await tx
      .update(whatsappInboundMessages)
      .set({
        errorCode: claimCode,
        updatedAt: now,
      })
      .where(
        and(
          eq(whatsappInboundMessages.id, row.id),
          eq(
            whatsappInboundMessages.processingStatus,
            WhatsAppInboundStatuses.READY_FOR_NL,
          ),
          isNull(whatsappInboundMessages.payloadClearedAt),
        ),
      );
    if (affectedRows(updated) < 1) continue;
    claimed.push({
      id: row.id,
      attempt,
      claimCode,
      payloadExpiresAt: row.payloadExpiresAt,
    });
  }
  return { claimed, repaired };
}

async function claimBatch(
  db: Db,
  now: Date,
  batchSize: number,
  leaseMs: number,
): Promise<ClaimedWork[]> {
  return db.transaction(async (tx) => {
    const first = await claimPass(tx, now, batchSize, leaseMs);
    if (first.claimed.length > 0 || first.repaired === 0) {
      return first.claimed;
    }
    return (await claimPass(tx, now, batchSize, leaseMs)).claimed;
  });
}

function affectedRows(result: unknown): number {
  if (Array.isArray(result)) {
    return Number(
      (result[0] as { affectedRows?: unknown } | undefined)?.affectedRows ?? 0,
    );
  }
  return Number((result as { affectedRows?: unknown } | null)?.affectedRows ?? 0);
}

async function hasReconcileablePending(
  db: Db,
  sourceInboundMessageId: number,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .select({ id: whatsappPendingIntents.id })
    .from(whatsappPendingIntents)
    .where(
      and(
        eq(
          whatsappPendingIntents.sourceInboundMessageId,
          sourceInboundMessageId,
        ),
        eq(whatsappPendingIntents.status, WhatsAppPendingStatuses.OPEN),
        inArray(whatsappPendingIntents.stage, [
          WhatsAppPendingStages.CLARIFICATION,
          WhatsAppPendingStages.CONFIRMATION,
        ]),
        gt(whatsappPendingIntents.expiresAt, now),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export async function applyWhatsAppNlDriverDecision(
  db: Db,
  work: ClaimedWork,
  decision: WhatsAppNlDriverDecision,
  now: Date,
): Promise<number> {
  if (decision.action === "complete") {
    const updated = await db
      .update(whatsappInboundMessages)
      .set({
        errorCode: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(whatsappInboundMessages.id, work.id),
          eq(whatsappInboundMessages.errorCode, work.claimCode),
        ),
      );
    return affectedRows(updated);
  }
  if (decision.action === "retry") {
    const updated = await db
      .update(whatsappInboundMessages)
      .set({
        errorCode: formatWhatsAppNlDriverRetry(decision.nextAttempt),
        updatedAt: now,
      })
      .where(
        and(
          eq(whatsappInboundMessages.id, work.id),
          eq(whatsappInboundMessages.errorCode, work.claimCode),
          eq(
            whatsappInboundMessages.processingStatus,
            WhatsAppInboundStatuses.READY_FOR_NL,
          ),
        ),
      );
    return affectedRows(updated);
  }
  if (decision.action === "wait") {
    const updated = await db
      .update(whatsappInboundMessages)
      .set({
        errorCode: formatWhatsAppNlDriverWait(decision.nextAttempt),
        updatedAt: now,
      })
      .where(
        and(
          eq(whatsappInboundMessages.id, work.id),
          eq(whatsappInboundMessages.errorCode, work.claimCode),
          eq(
            whatsappInboundMessages.processingStatus,
            WhatsAppInboundStatuses.READY_FOR_NL,
          ),
        ),
      );
    return affectedRows(updated);
  }
  const updated = await db
    .update(whatsappInboundMessages)
    .set({
      errorCode: formatWhatsAppNlDriverPark(decision.code),
      updatedAt: now,
    })
    .where(
      and(
        eq(whatsappInboundMessages.id, work.id),
        eq(whatsappInboundMessages.errorCode, work.claimCode),
        eq(
          whatsappInboundMessages.processingStatus,
          WhatsAppInboundStatuses.READY_FOR_NL,
        ),
      ),
    );
  return affectedRows(updated);
}

async function processClaimed(
  db: Db,
  work: ClaimedWork,
  now: Date,
): Promise<WhatsAppNlDriverItemOutcome> {
  const started = Date.now();
  let result: Awaited<
    ReturnType<typeof readyForNlConsumer.processWhatsAppReadyForNlInbound>
  >;
  try {
    result = await readyForNlConsumer.processWhatsAppReadyForNlInbound({
      sourceInboundMessageId: work.id,
    });
  } catch {
    result = { ok: false, kind: "RETRYABLE_INFRA", code: "INTERNAL_FAILURE" };
  }

  const reconcileable = result.ok
    ? false
    : await hasReconcileablePending(db, work.id, now);
  const decision = classifyWhatsAppNlDriverOutcome({
    result,
    attempt: work.attempt,
    now,
    payloadExpiresAt: work.payloadExpiresAt,
    hasReconcileablePending: reconcileable,
  });

  try {
    await applyWhatsAppNlDriverDecision(db, work, decision, now);
  } catch {
    logSafe({
      event: "whatsapp_nl_driver_bookkeeping_failed",
      sourceInboundMessageId: work.id,
      attempt: work.attempt,
      action: decision.action,
      disposition: decision.disposition,
    });
  }

  const durationMs = Date.now() - started;
  const retryAt =
    decision.action === "retry" || decision.action === "wait"
      ? new Date(now.getTime() + decision.delayMs).toISOString()
      : undefined;
  const b2cKind = result.kind;
  const b2cCode = result.ok ? result.stage : result.code;
  const item: WhatsAppNlDriverItemOutcome = {
    sourceInboundMessageId: work.id,
    attempt: work.attempt,
    action: decision.action,
    disposition: decision.disposition,
    b2cKind,
    b2cCode,
    durationMs,
    retryAt,
  };
  logSafe({
    event: "whatsapp_nl_driver_item",
    sourceInboundMessageId: item.sourceInboundMessageId,
    attempt: item.attempt,
    action: item.action,
    disposition: item.disposition,
    b2cKind: item.b2cKind,
    b2cCode: item.b2cCode,
    durationMs: item.durationMs,
    retryAt: item.retryAt ?? null,
  });
  return item;
}

export async function runWhatsAppNlDriverTick(
  options: WhatsAppNlDriverTickOptions = {},
): Promise<WhatsAppNlDriverTickSummary> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? WHATSAPP_NL_DRIVER_BATCH_SIZE;
  const leaseMs = options.leaseMs ?? WHATSAPP_NL_DRIVER_LEASE_MS;
  const started = Date.now();
  const empty = (): WhatsAppNlDriverTickSummary => ({
    claimed: 0,
    completed: 0,
    retried: 0,
    waited: 0,
    parked: 0,
    skipped: 0,
    durationMs: Date.now() - started,
    items: [],
  });

  if (options.shuttingDown?.()) {
    return empty();
  }

  let db: Db | null;
  try {
    db = await dbMod.getDb();
  } catch {
    logSafe({
      event: "whatsapp_nl_driver_tick_unavailable",
      code: "PERSISTENCE_FAILED",
    });
    return empty();
  }
  if (!db) {
    logSafe({
      event: "whatsapp_nl_driver_tick_unavailable",
      code: "DB_UNAVAILABLE",
    });
    return empty();
  }

  let claimedCount = 0;
  const items: WhatsAppNlDriverItemOutcome[] = [];
  try {
    for (let i = 0; i < batchSize; i += 1) {
      if (options.shuttingDown?.()) break;
      const batch = await claimBatch(db, now, 1, leaseMs);
      if (batch.length === 0) break;
      const work = batch[0]!;
      claimedCount += 1;
      try {
        items.push(await processClaimed(db, work, now));
      } catch {
        logSafe({
          event: "whatsapp_nl_driver_item_failed",
          sourceInboundMessageId: work.id,
          attempt: work.attempt,
          code: "INTERNAL_FAILURE",
        });
        try {
          await applyWhatsAppNlDriverDecision(
            db,
            work,
            classifyWhatsAppNlDriverOutcome({
              result: {
                ok: false,
                kind: "RETRYABLE_INFRA",
                code: "INTERNAL_FAILURE",
              },
              attempt: work.attempt,
              now,
              payloadExpiresAt: work.payloadExpiresAt,
            }),
            now,
          );
        } catch {
          /* lease recovers */
        }
      }
    }
  } catch {
    logSafe({
      event: "whatsapp_nl_driver_claim_failed",
      code: "PERSISTENCE_FAILED",
      batchSize,
    });
    if (claimedCount === 0) return empty();
  }

  const summary: WhatsAppNlDriverTickSummary = {
    claimed: claimedCount,
    completed: items.filter((item) => item.action === "complete").length,
    retried: items.filter((item) => item.action === "retry").length,
    waited: items.filter((item) => item.action === "wait").length,
    parked: items.filter((item) => item.action === "park").length,
    skipped: 0,
    durationMs: Date.now() - started,
    items,
  };
  logSafe({
    event: "whatsapp_nl_driver_tick",
    claimed: summary.claimed,
    completed: summary.completed,
    retried: summary.retried,
    waited: summary.waited,
    parked: summary.parked,
    durationMs: summary.durationMs,
    batchSize,
    stopped: Boolean(options.shuttingDown?.()),
  });
  return summary;
}

let loopGeneration = 0;
let loopStarted = false;

function jitterMs(): number {
  return Math.floor(Math.random() * (WHATSAPP_NL_DRIVER_JITTER_MS + 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runLoop(generation: number): Promise<void> {
  logSafe({
    event: "whatsapp_nl_driver_started",
    intervalMs: WHATSAPP_NL_DRIVER_INTERVAL_MS,
    batchSize: WHATSAPP_NL_DRIVER_BATCH_SIZE,
  });
  while (loopStarted && loopGeneration === generation) {
    try {
      await runWhatsAppNlDriverTick({
        shuttingDown: () => !loopStarted || loopGeneration !== generation,
      });
    } catch {
      logSafe({
        event: "whatsapp_nl_driver_tick_failed",
        code: "INTERNAL_FAILURE",
      });
    }
    if (!loopStarted || loopGeneration !== generation) return;
    await sleep(WHATSAPP_NL_DRIVER_INTERVAL_MS + jitterMs());
  }
}

export function startWhatsAppNlDriver(): void {
  if (ENV.nodeEnv === "test") return;
  if (!isWhatsAppNlDriverEnabled()) return;
  if (loopStarted) return;
  loopStarted = true;
  const generation = ++loopGeneration;
  void runLoop(generation);
}

export function stopWhatsAppNlDriver(): void {
  if (!loopStarted && loopGeneration === 0) return;
  loopStarted = false;
  loopGeneration += 1;
  logSafe({ event: "whatsapp_nl_driver_stopped" });
}

export function isWhatsAppNlDriverLoopRunning(): boolean {
  return loopStarted;
}
