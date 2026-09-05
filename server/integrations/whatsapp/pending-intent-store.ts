/**
 * Memória persistente da conversa WhatsApp pendente (Incremento B1).
 *
 * Não é autoridade de acesso, elegibilidade, instituição ou swap.
 * Não importa parser, resolver, autoridade de swap nem SDK de transporte.
 * Create recebe só sourceInboundMessageId; userId nasce do inbound
 * READY_FOR_NL. institution/intent/payloads nascem null.
 * B2-A: advanceWhatsAppPendingFromParse recebe payload já serializado;
 * não chama parser, resolver, createSwapOffer nem inbound consume.
 */

import { and, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import {
  whatsappInboundMessages,
  whatsappPendingIntents,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import { logger } from "../../_core/logger";
import {
  clarificationInvariantsHold,
  confirmationInvariantsHold,
  parseAdvanceWhatsAppPendingFromParseInput,
  payloadsCanonicalEqual,
  type AdvanceWhatsAppPendingFromParseInput,
} from "./pending-intent-payloads";
import {
  WhatsAppPendingStatuses,
  WhatsAppPendingStages,
  isWhatsAppPendingTerminalStatus,
  pendingExpiresAtFrom,
  type CreateWhatsAppPendingIntentInput,
  type WhatsAppPendingAdvanceResult,
  type WhatsAppPendingCleanupResult,
  type WhatsAppPendingIntentRecord,
  type WhatsAppPendingMutationResult,
  type WhatsAppPendingParseCancelResult,
  type WhatsAppPendingReadResult,
  type WhatsAppPendingStoreResult,
  type CancelWhatsAppPendingOpenParseInput,
} from "./pending-intent-types";

type PendingOp =
  | "by_id"
  | "by_source"
  | "open"
  | "create"
  | "expire"
  | "cancel"
  | "cancel_parse"
  | "cleanup"
  | "advance";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

const READY_FOR_NL = "READY_FOR_NL";

function affectedRows(result: unknown): number {
  if (Array.isArray(result)) {
    return Number(
      (result[0] as { affectedRows?: unknown } | undefined)?.affectedRows ?? 0,
    );
  }
  return Number((result as { affectedRows?: unknown } | null)?.affectedRows ?? 0);
}

function isDuplicateKeyError(error: unknown): boolean {
  const candidates: unknown[] = [error];
  const err = error as { cause?: unknown };
  if (err?.cause) candidates.push(err.cause);
  return candidates.some((item) => {
    const e = item as { code?: string; errno?: number; message?: string };
    return (
      e?.code === "ER_DUP_ENTRY" ||
      e?.errno === 1062 ||
      /Duplicate entry/i.test(e?.message ?? "")
    );
  });
}

function logSafe(payload: Record<string, unknown>): void {
  logger.info(JSON.stringify(payload));
}

function toRecord(row: {
  id: number;
  userId: number;
  sourceInboundMessageId: number;
  institutionId: number | null;
  status: string;
  stage: string;
  intentKind: string | null;
  parsedPayload: unknown;
  resolvedPayload: unknown;
  clarificationPayload: unknown;
  expiresAt: Date;
  consumedAt: Date | null;
  payloadClearedAt: Date | null;
}): WhatsAppPendingIntentRecord {
  return {
    id: row.id,
    userId: row.userId,
    sourceInboundMessageId: row.sourceInboundMessageId,
    institutionId: row.institutionId,
    status: row.status,
    stage: row.stage,
    intentKind: row.intentKind,
    parsedPayload: row.parsedPayload,
    resolvedPayload: row.resolvedPayload,
    clarificationPayload: row.clarificationPayload,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    payloadClearedAt: row.payloadClearedAt,
  };
}

function technicalLogFields(row: WhatsAppPendingIntentRecord) {
  return {
    pendingId: row.id,
    userId: row.userId,
    stage: row.stage,
    status: row.status,
    sourceInboundId: row.sourceInboundMessageId,
  };
}

function clearedConversationPayload(now: Date) {
  return {
    parsedPayload: null,
    resolvedPayload: null,
    clarificationPayload: null,
    payloadClearedAt: now,
  };
}

function emptyFoundationInsert(
  userId: number,
  sourceInboundMessageId: number,
  now: Date,
) {
  return {
    userId,
    sourceInboundMessageId,
    institutionId: null,
    status: WhatsAppPendingStatuses.OPEN,
    stage: WhatsAppPendingStages.PARSE,
    intentKind: null,
    parsedPayload: null,
    resolvedPayload: null,
    clarificationPayload: null,
    expiresAt: pendingExpiresAtFrom(now),
    consumedAt: null,
    payloadClearedAt: null,
  };
}

function isPastExpiry(row: WhatsAppPendingIntentRecord, now: Date): boolean {
  return row.expiresAt.getTime() <= now.getTime();
}

function outcomeForExistingOpen(
  row: WhatsAppPendingIntentRecord,
  sourceInboundMessageId: number,
): "replay" | "already_open" {
  return row.sourceInboundMessageId === sourceInboundMessageId
    ? "replay"
    : "already_open";
}

async function loadByIdForUser(
  db: Db,
  id: number,
  userId: number,
): Promise<WhatsAppPendingIntentRecord | null> {
  const [row] = await db
    .select()
    .from(whatsappPendingIntents)
    .where(
      and(
        eq(whatsappPendingIntents.id, id),
        eq(whatsappPendingIntents.userId, userId),
      ),
    )
    .limit(1);
  return row ? toRecord(row) : null;
}

async function loadBySource(
  db: Db,
  sourceInboundMessageId: number,
): Promise<WhatsAppPendingIntentRecord | null> {
  const [row] = await db
    .select()
    .from(whatsappPendingIntents)
    .where(
      eq(whatsappPendingIntents.sourceInboundMessageId, sourceInboundMessageId),
    )
    .limit(1);
  return row ? toRecord(row) : null;
}

async function loadBySourceForUser(
  db: Db,
  sourceInboundMessageId: number,
  userId: number,
): Promise<WhatsAppPendingIntentRecord | null> {
  const [row] = await db
    .select()
    .from(whatsappPendingIntents)
    .where(
      and(
        eq(
          whatsappPendingIntents.sourceInboundMessageId,
          sourceInboundMessageId,
        ),
        eq(whatsappPendingIntents.userId, userId),
      ),
    )
    .limit(1);
  return row ? toRecord(row) : null;
}

async function loadOpenForUser(
  db: Db,
  userId: number,
): Promise<WhatsAppPendingIntentRecord | null> {
  const [row] = await db
    .select()
    .from(whatsappPendingIntents)
    .where(
      and(
        eq(whatsappPendingIntents.userId, userId),
        eq(whatsappPendingIntents.status, WhatsAppPendingStatuses.OPEN),
      ),
    )
    .limit(1);
  return row ? toRecord(row) : null;
}

async function expireOpenRow(
  db: Db,
  id: number,
  userId: number,
  now: Date,
): Promise<boolean> {
  const result = await db
    .update(whatsappPendingIntents)
    .set({
      status: WhatsAppPendingStatuses.EXPIRED,
      ...clearedConversationPayload(now),
    })
    .where(
      and(
        eq(whatsappPendingIntents.id, id),
        eq(whatsappPendingIntents.userId, userId),
        eq(whatsappPendingIntents.status, WhatsAppPendingStatuses.OPEN),
        lte(whatsappPendingIntents.expiresAt, now),
      ),
    );
  return affectedRows(result) > 0;
}

async function cancelOpenRow(
  db: Db,
  id: number,
  userId: number,
  now: Date,
): Promise<boolean> {
  const result = await db
    .update(whatsappPendingIntents)
    .set({
      status: WhatsAppPendingStatuses.CANCELLED,
      ...clearedConversationPayload(now),
    })
    .where(
      and(
        eq(whatsappPendingIntents.id, id),
        eq(whatsappPendingIntents.userId, userId),
        eq(whatsappPendingIntents.status, WhatsAppPendingStatuses.OPEN),
      ),
    );
  return affectedRows(result) > 0;
}

async function expireIfDue(
  db: Db,
  row: WhatsAppPendingIntentRecord,
  now: Date,
): Promise<WhatsAppPendingIntentRecord> {
  if (
    row.status !== WhatsAppPendingStatuses.OPEN ||
    !isPastExpiry(row, now)
  ) {
    return row;
  }
  await expireOpenRow(db, row.id, row.userId, now);
  const latest = await loadByIdForUser(db, row.id, row.userId);
  if (!latest) {
    throw new Error("pending_reload_failed");
  }
  if (latest.status === WhatsAppPendingStatuses.EXPIRED) {
    logSafe({
      event: "whatsapp_pending_expired",
      ...technicalLogFields(latest),
    });
  }
  return latest;
}

async function acquireDb(
  op: PendingOp,
): Promise<
  | { ok: true; db: Db }
  | { ok: false; code: "DB_UNAVAILABLE" | "PERSISTENCE_FAILED" }
> {
  try {
    const db = await getDb();
    if (!db) {
      logSafe({
        event:
          op === "cleanup"
            ? "whatsapp_pending_cleanup_failed"
            : "whatsapp_pending_unavailable",
        op,
        code: "DB_UNAVAILABLE",
      });
      return { ok: false, code: "DB_UNAVAILABLE" };
    }
    return { ok: true, db };
  } catch {
    logSafe({
      event:
        op === "cleanup"
          ? "whatsapp_pending_cleanup_failed"
          : "whatsapp_pending_failed",
      op,
      code: "PERSISTENCE_FAILED",
    });
    return { ok: false, code: "PERSISTENCE_FAILED" };
  }
}

function persistenceFailed(
  op: PendingOp,
  extra: Record<string, unknown> = {},
): { ok: false; code: "PERSISTENCE_FAILED" } {
  logSafe({
    event:
      op === "cleanup"
        ? "whatsapp_pending_cleanup_failed"
        : "whatsapp_pending_failed",
    op,
    code: "PERSISTENCE_FAILED",
    ...extra,
  });
  return { ok: false, code: "PERSISTENCE_FAILED" };
}

async function readWithDb(
  op: PendingOp,
  run: (db: Db) => Promise<WhatsAppPendingIntentRecord | null>,
): Promise<WhatsAppPendingReadResult> {
  const acquired = await acquireDb(op);
  if (!acquired.ok) return acquired;
  try {
    return { ok: true, row: await run(acquired.db) };
  } catch {
    return persistenceFailed(op);
  }
}

export async function getWhatsAppPendingIntentByIdForUser(
  id: number,
  userId: number,
  now: Date = new Date(),
): Promise<WhatsAppPendingReadResult> {
  return readWithDb("by_id", async (db) => {
    const row = await loadByIdForUser(db, id, userId);
    if (!row) return null;
    return expireIfDue(db, row, now);
  });
}

export async function getWhatsAppPendingIntentBySourceForUser(
  sourceInboundMessageId: number,
  userId: number,
  now: Date = new Date(),
): Promise<WhatsAppPendingReadResult> {
  return readWithDb("by_source", async (db) => {
    const row = await loadBySourceForUser(db, sourceInboundMessageId, userId);
    if (!row) return null;
    return expireIfDue(db, row, now);
  });
}

export async function getOpenWhatsAppPendingIntentForUser(
  userId: number,
  now: Date = new Date(),
): Promise<WhatsAppPendingReadResult> {
  return readWithDb("open", async (db) => {
    const row = await loadOpenForUser(db, userId);
    if (!row) return null;
    const latest = await expireIfDue(db, row, now);
    if (latest.status !== WhatsAppPendingStatuses.OPEN) return null;
    return latest;
  });
}

export async function createWhatsAppPendingIntent(
  input: CreateWhatsAppPendingIntentInput,
  now: Date = new Date(),
): Promise<WhatsAppPendingStoreResult> {
  const sourceInboundMessageId = input.sourceInboundMessageId;

  const acquired = await acquireDb("create");
  if (!acquired.ok) return acquired;
  const db = acquired.db;

  try {
    return await createPendingWithDb(db, sourceInboundMessageId, now);
  } catch {
    return persistenceFailed("create", {
      sourceInboundId: sourceInboundMessageId,
    });
  }
}

async function createPendingWithDb(
  db: Db,
  sourceInboundMessageId: number,
  now: Date,
): Promise<WhatsAppPendingStoreResult> {
  const [source] = await db
    .select({
      id: whatsappInboundMessages.id,
      userId: whatsappInboundMessages.userId,
      processingStatus: whatsappInboundMessages.processingStatus,
    })
    .from(whatsappInboundMessages)
    .where(eq(whatsappInboundMessages.id, sourceInboundMessageId))
    .limit(1);

  if (!source) {
    return { ok: false, code: "SOURCE_INBOUND_NOT_FOUND" };
  }
  if (source.processingStatus !== READY_FOR_NL) {
    return { ok: false, code: "SOURCE_INBOUND_NOT_READY" };
  }
  if (source.userId == null) {
    return { ok: false, code: "SOURCE_INBOUND_IDENTITY_MISSING" };
  }
  const userId = source.userId;

  const existingSource = await loadBySource(db, sourceInboundMessageId);
  if (existingSource) {
    const latest = await expireIfDue(db, existingSource, now);
    if (isWhatsAppPendingTerminalStatus(latest.status)) {
      logSafe({
        event: "whatsapp_pending_already_terminal",
        ...technicalLogFields(latest),
      });
      return { ok: true, outcome: "already_terminal", row: latest };
    }
    logSafe({
      event: "whatsapp_pending_replay",
      ...technicalLogFields(latest),
    });
    return { ok: true, outcome: "replay", row: latest };
  }

  const open = await loadOpenForUser(db, userId);
  if (open) {
    const latest = await expireIfDue(db, open, now);
    if (latest.status === WhatsAppPendingStatuses.OPEN) {
      const outcome = outcomeForExistingOpen(
        latest,
        sourceInboundMessageId,
      );
      logSafe({
        event:
          outcome === "replay"
            ? "whatsapp_pending_replay"
            : "whatsapp_pending_already_open",
        ...technicalLogFields(latest),
      });
      return { ok: true, outcome, row: latest };
    }
  }

  try {
    const [inserted] = await db
      .insert(whatsappPendingIntents)
      .values(emptyFoundationInsert(userId, sourceInboundMessageId, now))
      .$returningId();

    if (inserted?.id == null) {
      return persistenceFailed("create", {
        userId,
        sourceInboundId: sourceInboundMessageId,
      });
    }
    const row = await loadByIdForUser(db, inserted.id, userId);
    if (!row) {
      return persistenceFailed("create", {
        userId,
        sourceInboundId: sourceInboundMessageId,
      });
    }
    logSafe({
      event: "whatsapp_pending_created",
      ...technicalLogFields(row),
    });
    return { ok: true, outcome: "created", row };
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const racedSource = await loadBySource(db, sourceInboundMessageId);
      if (racedSource) {
        const latest = await expireIfDue(db, racedSource, now);
        if (isWhatsAppPendingTerminalStatus(latest.status)) {
          return { ok: true, outcome: "already_terminal", row: latest };
        }
        logSafe({
          event: "whatsapp_pending_replay",
          ...technicalLogFields(latest),
        });
        return { ok: true, outcome: "replay", row: latest };
      }
      const racedOpen = await loadOpenForUser(db, userId);
      if (racedOpen) {
        const latest = await expireIfDue(db, racedOpen, now);
        if (latest.status === WhatsAppPendingStatuses.OPEN) {
          const outcome = outcomeForExistingOpen(
            latest,
            sourceInboundMessageId,
          );
          logSafe({
            event:
              outcome === "replay"
                ? "whatsapp_pending_replay"
                : "whatsapp_pending_already_open",
            ...technicalLogFields(latest),
          });
          return { ok: true, outcome, row: latest };
        }
      }
    }
    logSafe({
      event: "whatsapp_pending_failed",
      op: "create",
      userId,
      sourceInboundId: sourceInboundMessageId,
      code: "PERSISTENCE_FAILED",
    });
    return { ok: false, code: "PERSISTENCE_FAILED" };
  }
}

export async function expireWhatsAppPendingIntent(
  id: number,
  userId: number,
  now: Date = new Date(),
): Promise<WhatsAppPendingMutationResult> {
  const acquired = await acquireDb("expire");
  if (!acquired.ok) return acquired;

  try {
    const row = await loadByIdForUser(acquired.db, id, userId);
    if (!row) return { ok: false, code: "NOT_FOUND" };
    if (isWhatsAppPendingTerminalStatus(row.status)) {
      return { ok: true, outcome: "already_terminal", row };
    }
    if (!isPastExpiry(row, now)) {
      return { ok: true, outcome: "not_due", row };
    }

    const updated = await expireOpenRow(acquired.db, id, userId, now);
    const latest = await loadByIdForUser(acquired.db, id, userId);
    if (!latest) {
      return persistenceFailed("expire", { pendingId: id, userId });
    }
    if (!updated) {
      if (isWhatsAppPendingTerminalStatus(latest.status)) {
        return { ok: true, outcome: "already_terminal", row: latest };
      }
      if (!isPastExpiry(latest, now)) {
        return { ok: true, outcome: "not_due", row: latest };
      }
      return persistenceFailed("expire", { pendingId: id, userId });
    }
    logSafe({
      event: "whatsapp_pending_expired",
      ...technicalLogFields(latest),
    });
    return { ok: true, outcome: "updated", row: latest };
  } catch {
    return persistenceFailed("expire", { pendingId: id, userId });
  }
}

export async function cancelWhatsAppPendingIntent(
  id: number,
  userId: number,
  now: Date = new Date(),
): Promise<WhatsAppPendingMutationResult> {
  const acquired = await acquireDb("cancel");
  if (!acquired.ok) return acquired;

  try {
    const row = await loadByIdForUser(acquired.db, id, userId);
    if (!row) return { ok: false, code: "NOT_FOUND" };
    if (isWhatsAppPendingTerminalStatus(row.status)) {
      return { ok: true, outcome: "already_terminal", row };
    }

    const updated = await cancelOpenRow(acquired.db, id, userId, now);
    const latest = await loadByIdForUser(acquired.db, id, userId);
    if (!latest) {
      return persistenceFailed("cancel", { pendingId: id, userId });
    }
    if (!updated) {
      if (isWhatsAppPendingTerminalStatus(latest.status)) {
        return { ok: true, outcome: "already_terminal", row: latest };
      }
      return persistenceFailed("cancel", { pendingId: id, userId });
    }
    logSafe({
      event: "whatsapp_pending_cancelled",
      ...technicalLogFields(latest),
    });
    return { ok: true, outcome: "updated", row: latest };
  } catch {
    return persistenceFailed("cancel", { pendingId: id, userId });
  }
}

function isPositiveInt(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * Terminaliza OPEN/PARSE do source informado. Compare-and-set: se o
 * pending já avançou para CLARIFICATION/CONFIRMATION, devolve
 * STATE_CHANGED e não sobrescreve. Reusa a limpeza de payload de cancel.
 */
export async function cancelWhatsAppPendingOpenParse(
  input: CancelWhatsAppPendingOpenParseInput,
  now: Date = new Date(),
): Promise<WhatsAppPendingParseCancelResult> {
  const { pendingId, userId, expectedSourceInboundMessageId } = input;
  if (
    !isPositiveInt(pendingId) ||
    !isPositiveInt(userId) ||
    !isPositiveInt(expectedSourceInboundMessageId)
  ) {
    return { ok: false, code: "INVALID_PAYLOAD" };
  }

  const acquired = await acquireDb("cancel_parse");
  if (!acquired.ok) return acquired;

  try {
    const updated = await acquired.db
      .update(whatsappPendingIntents)
      .set({
        status: WhatsAppPendingStatuses.CANCELLED,
        ...clearedConversationPayload(now),
      })
      .where(
        and(
          eq(whatsappPendingIntents.id, pendingId),
          eq(whatsappPendingIntents.userId, userId),
          eq(
            whatsappPendingIntents.sourceInboundMessageId,
            expectedSourceInboundMessageId,
          ),
          eq(whatsappPendingIntents.status, WhatsAppPendingStatuses.OPEN),
          eq(whatsappPendingIntents.stage, WhatsAppPendingStages.PARSE),
        ),
      );

    if (affectedRows(updated) > 0) {
      const latest = await loadByIdForUser(acquired.db, pendingId, userId);
      if (!latest || latest.status !== WhatsAppPendingStatuses.CANCELLED) {
        return persistenceFailed("cancel_parse", { pendingId, userId });
      }
      logSafe({
        event: "whatsapp_pending_cancelled",
        ...technicalLogFields(latest),
        outcome: "cancelled",
        expectedStage: WhatsAppPendingStages.PARSE,
      });
      return { ok: true, outcome: "cancelled", row: latest };
    }

    const current = await loadByIdForUser(acquired.db, pendingId, userId);
    if (!current) {
      logSafe({
        event: "whatsapp_pending_parse_cancel_miss",
        pendingId,
        userId,
        sourceInboundId: expectedSourceInboundMessageId,
        outcome: "NOT_FOUND",
      });
      return { ok: false, code: "NOT_FOUND" };
    }
    if (isWhatsAppPendingTerminalStatus(current.status)) {
      logSafe({
        event: "whatsapp_pending_parse_cancel_miss",
        ...technicalLogFields(current),
        outcome: "already_terminal",
      });
      return { ok: true, outcome: "already_terminal", row: current };
    }
    logSafe({
      event: "whatsapp_pending_parse_cancel_miss",
      ...technicalLogFields(current),
      sourceInboundId: expectedSourceInboundMessageId,
      outcome: "STATE_CHANGED",
    });
    return { ok: false, code: "STATE_CHANGED", row: current };
  } catch {
    return persistenceFailed("cancel_parse", { pendingId, userId });
  }
}

export async function clearExpiredWhatsAppPendingIntents(
  now: Date = new Date(),
): Promise<WhatsAppPendingCleanupResult> {
  const acquired = await acquireDb("cleanup");
  if (!acquired.ok) return acquired;

  try {
    const expiredResult = await acquired.db
      .update(whatsappPendingIntents)
      .set({
        status: WhatsAppPendingStatuses.EXPIRED,
        ...clearedConversationPayload(now),
      })
      .where(
        and(
          eq(whatsappPendingIntents.status, WhatsAppPendingStatuses.OPEN),
          lte(whatsappPendingIntents.expiresAt, now),
        ),
      );
    const expired = affectedRows(expiredResult);

    const leftoverResult = await acquired.db
      .update(whatsappPendingIntents)
      .set(clearedConversationPayload(now))
      .where(
        and(
          inArray(whatsappPendingIntents.status, [
            WhatsAppPendingStatuses.CANCELLED,
            WhatsAppPendingStatuses.EXPIRED,
            WhatsAppPendingStatuses.CONSUMED,
          ]),
          isNull(whatsappPendingIntents.payloadClearedAt),
        ),
      );
    const leftover = affectedRows(leftoverResult);
    const payloadsCleared = expired + leftover;

    logSafe({
      event: "whatsapp_pending_cleanup",
      expired,
      payloadsCleared,
    });
    return { ok: true, expired, payloadsCleared };
  } catch {
    return persistenceFailed("cleanup");
  }
}

type IntendedAdvanceFields = {
  stage: "CLARIFICATION" | "CONFIRMATION";
  intentKind: "SWAP" | "CESSAO" | null;
  parsedPayload: unknown;
  resolvedPayload: unknown;
  clarificationPayload: unknown;
  institutionId: number | null;
};

function intendedAdvanceFields(
  outcome: AdvanceWhatsAppPendingFromParseInput["outcome"],
): IntendedAdvanceFields {
  if (outcome.type === "resolved") {
    return {
      stage: WhatsAppPendingStages.CONFIRMATION,
      intentKind: outcome.resolved.kind,
      parsedPayload: outcome.parsed,
      resolvedPayload: outcome.resolved,
      clarificationPayload: null,
      institutionId: outcome.resolved.institutionId,
    };
  }
  if (outcome.parsed === null) {
    return {
      stage: WhatsAppPendingStages.CLARIFICATION,
      intentKind: null,
      parsedPayload: null,
      resolvedPayload: null,
      clarificationPayload: outcome.clarification,
      institutionId: null,
    };
  }
  return {
    stage: WhatsAppPendingStages.CLARIFICATION,
    intentKind: outcome.parsed.kind,
    parsedPayload: outcome.parsed,
    resolvedPayload: null,
    clarificationPayload: outcome.clarification,
    institutionId: null,
  };
}

function rowMatchesIntended(
  row: WhatsAppPendingIntentRecord,
  intended: IntendedAdvanceFields,
): boolean {
  return (
    row.status === WhatsAppPendingStatuses.OPEN &&
    row.stage === intended.stage &&
    row.intentKind === intended.intentKind &&
    row.institutionId === intended.institutionId &&
    payloadsCanonicalEqual(row.parsedPayload, intended.parsedPayload) &&
    payloadsCanonicalEqual(row.resolvedPayload, intended.resolvedPayload) &&
    payloadsCanonicalEqual(
      row.clarificationPayload,
      intended.clarificationPayload,
    )
  );
}

function advanceInvariantsHold(
  intended: IntendedAdvanceFields,
  row: WhatsAppPendingIntentRecord,
): boolean {
  if (intended.stage === WhatsAppPendingStages.CONFIRMATION) {
    return confirmationInvariantsHold(row);
  }
  return clarificationInvariantsHold(row);
}

/**
 * Transição guardada OPEN/PARSE → OPEN/CLARIFICATION|CONFIRMATION.
 * Recebe payload já validado/serializado. Não recebe texto. Não chama
 * parser, resolver, createSwapOffer nem limpa inbound.
 */
export async function advanceWhatsAppPendingFromParse(
  input: AdvanceWhatsAppPendingFromParseInput,
  now: Date = new Date(),
): Promise<WhatsAppPendingAdvanceResult> {
  const parsedInput = parseAdvanceWhatsAppPendingFromParseInput(input);
  if (!parsedInput.ok) {
    return { ok: false, code: "INVALID_PAYLOAD" };
  }
  const {
    pendingId,
    userId,
    expectedSourceInboundMessageId,
    outcome,
  } = parsedInput.value;
  const intended = intendedAdvanceFields(outcome);

  const acquired = await acquireDb("advance");
  if (!acquired.ok) return acquired;
  const db = acquired.db;

  try {
    const updated = await db
      .update(whatsappPendingIntents)
      .set({
        stage: intended.stage,
        intentKind: intended.intentKind,
        parsedPayload: intended.parsedPayload,
        resolvedPayload: intended.resolvedPayload,
        clarificationPayload: intended.clarificationPayload,
        institutionId: intended.institutionId,
      })
      .where(
        and(
          eq(whatsappPendingIntents.id, pendingId),
          eq(whatsappPendingIntents.userId, userId),
          eq(
            whatsappPendingIntents.sourceInboundMessageId,
            expectedSourceInboundMessageId,
          ),
          eq(whatsappPendingIntents.status, WhatsAppPendingStatuses.OPEN),
          eq(whatsappPendingIntents.stage, WhatsAppPendingStages.PARSE),
          gt(whatsappPendingIntents.expiresAt, now),
        ),
      );

    if (affectedRows(updated) > 0) {
      const latest = await loadByIdForUser(db, pendingId, userId);
      if (!latest || !advanceInvariantsHold(intended, latest)) {
        return persistenceFailed("advance", { pendingId, userId });
      }
      logSafe({
        event: "whatsapp_pending_advanced",
        pendingId,
        userId,
        sourceInboundId: expectedSourceInboundMessageId,
        oldStage: WhatsAppPendingStages.PARSE,
        newStage: latest.stage,
        outcome: "advanced",
      });
      return { ok: true, outcome: "advanced", row: latest };
    }

    const current = await loadByIdForUser(db, pendingId, userId);
    if (!current) {
      logSafe({
        event: "whatsapp_pending_advance_miss",
        pendingId,
        userId,
        sourceInboundId: expectedSourceInboundMessageId,
        oldStage: WhatsAppPendingStages.PARSE,
        newStage: null,
        outcome: "NOT_FOUND",
      });
      return { ok: false, code: "NOT_FOUND" };
    }

    if (
      current.sourceInboundMessageId !== expectedSourceInboundMessageId
    ) {
      logSafe({
        event: "whatsapp_pending_advance_miss",
        pendingId,
        userId,
        sourceInboundId: expectedSourceInboundMessageId,
        oldStage: current.stage,
        newStage: current.stage,
        outcome: "STATE_CHANGED",
      });
      return { ok: false, code: "STATE_CHANGED", row: current };
    }

    if (current.status === WhatsAppPendingStatuses.EXPIRED) {
      logSafe({
        event: "whatsapp_pending_advance_miss",
        pendingId,
        userId,
        sourceInboundId: expectedSourceInboundMessageId,
        oldStage: current.stage,
        newStage: current.stage,
        outcome: "EXPIRED",
      });
      return { ok: false, code: "EXPIRED", row: current };
    }

    if (isWhatsAppPendingTerminalStatus(current.status)) {
      logSafe({
        event: "whatsapp_pending_advance_miss",
        pendingId,
        userId,
        sourceInboundId: expectedSourceInboundMessageId,
        oldStage: current.stage,
        newStage: current.stage,
        outcome: "TERMINAL",
      });
      return { ok: false, code: "TERMINAL", row: current };
    }

    if (
      current.status === WhatsAppPendingStatuses.OPEN &&
      isPastExpiry(current, now)
    ) {
      await expireOpenRow(db, pendingId, userId, now);
      const latest = await loadByIdForUser(db, pendingId, userId);
      if (!latest) {
        return persistenceFailed("advance", { pendingId, userId });
      }
      logSafe({
        event: "whatsapp_pending_advance_miss",
        pendingId,
        userId,
        sourceInboundId: expectedSourceInboundMessageId,
        oldStage: WhatsAppPendingStages.PARSE,
        newStage: latest.stage,
        outcome: "EXPIRED",
      });
      return { ok: false, code: "EXPIRED", row: latest };
    }

    if (rowMatchesIntended(current, intended)) {
      logSafe({
        event: "whatsapp_pending_advanced",
        pendingId,
        userId,
        sourceInboundId: expectedSourceInboundMessageId,
        oldStage: intended.stage,
        newStage: current.stage,
        outcome: "already_advanced",
      });
      return { ok: true, outcome: "already_advanced", row: current };
    }

    logSafe({
      event: "whatsapp_pending_advance_miss",
      pendingId,
      userId,
      sourceInboundId: expectedSourceInboundMessageId,
      oldStage: current.stage,
      newStage: current.stage,
      outcome: "STATE_CHANGED",
    });
    return { ok: false, code: "STATE_CHANGED", row: current };
  } catch {
    return persistenceFailed("advance", { pendingId, userId });
  }
}
