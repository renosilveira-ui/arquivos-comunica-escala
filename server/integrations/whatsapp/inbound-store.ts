import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { whatsappInboundMessages } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { logger } from "../../_core/logger";
import { resolveVerifiedWhatsAppUser } from "./resolve-identity";
import {
  clearedOperationalPayload,
  hasMaterialForReadyStatus,
  operationalPayloadFromEnvelope,
} from "./operational-payload";
import type { WhatsAppInboundEnvelope } from "./types";
import {
  WHATSAPP_INBOUND_INCOMPLETE_STATUSES,
  WHATSAPP_INBOUND_PROVIDER,
  WhatsAppInboundStatuses,
  isRetryableWhatsAppIdentity,
  isWhatsAppInboundIncompleteStatus,
  isWhatsAppInboundTerminalStatus,
} from "./types";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export type InboundProcessResult =
  | { outcome: "replay"; id: number; status: string }
  | { outcome: "accepted"; id: number; status: string; userId: number | null }
  | {
      outcome: "retryable";
      id: number | null;
      status: string | null;
      code: string;
    };

type InboundRow = {
  id: number;
  processingStatus: string;
  operationalText: string | null;
  mediaUrl: string | null;
};

function messageSidHash(sid: string): string {
  return createHash("sha256").update(sid).digest("hex").slice(0, 16);
}

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

function replayOf(row: InboundRow): InboundProcessResult {
  return {
    outcome: "replay",
    id: row.id,
    status: row.processingStatus,
  };
}

async function loadByProviderMessage(
  db: Db,
  providerMessageId: string,
): Promise<InboundRow | null> {
  const [row] = await db
    .select({
      id: whatsappInboundMessages.id,
      processingStatus: whatsappInboundMessages.processingStatus,
      operationalText: whatsappInboundMessages.operationalText,
      mediaUrl: whatsappInboundMessages.mediaUrl,
    })
    .from(whatsappInboundMessages)
    .where(
      and(
        eq(whatsappInboundMessages.provider, WHATSAPP_INBOUND_PROVIDER),
        eq(whatsappInboundMessages.providerMessageId, providerMessageId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function refreshOperationalPayload(
  db: Db,
  id: number,
  envelope: WhatsAppInboundEnvelope,
): Promise<void> {
  const payload = operationalPayloadFromEnvelope(envelope.content);
  await db
    .update(whatsappInboundMessages)
    .set(payload)
    .where(
      and(
        eq(whatsappInboundMessages.id, id),
        inArray(
          whatsappInboundMessages.processingStatus,
          [...WHATSAPP_INBOUND_INCOMPLETE_STATUSES],
        ),
      ),
    );
}

async function markRetryable(
  db: Db,
  id: number,
  code: string,
): Promise<boolean> {
  const result = await db
    .update(whatsappInboundMessages)
    .set({
      processingStatus: WhatsAppInboundStatuses.RETRYABLE,
      errorCode: code,
      processedAt: null,
    })
    .where(
      and(
        eq(whatsappInboundMessages.id, id),
        inArray(
          whatsappInboundMessages.processingStatus,
          [...WHATSAPP_INBOUND_INCOMPLETE_STATUSES],
        ),
      ),
    );
  return affectedRows(result) > 0;
}

async function commitGuarded(
  db: Db,
  id: number,
  values: Record<string, unknown>,
): Promise<boolean> {
  const result = await db
    .update(whatsappInboundMessages)
    .set(values)
    .where(
      and(
        eq(whatsappInboundMessages.id, id),
        inArray(
          whatsappInboundMessages.processingStatus,
          [...WHATSAPP_INBOUND_INCOMPLETE_STATUSES],
        ),
      ),
    );
  return affectedRows(result) > 0;
}

async function finishExisting(
  db: Db,
  envelope: WhatsAppInboundEnvelope,
  row: InboundRow,
): Promise<InboundProcessResult> {
  if (isWhatsAppInboundTerminalStatus(row.processingStatus)) {
    logSafe({
      event: "whatsapp_inbound_replay",
      messageSidHash: messageSidHash(envelope.providerMessageId),
      status: row.processingStatus,
    });
    return replayOf(row);
  }
  if (isWhatsAppInboundIncompleteStatus(row.processingStatus)) {
    return advanceInbound(db, envelope, row.id);
  }
  logSafe({
    event: "whatsapp_inbound_retryable",
    messageSidHash: messageSidHash(envelope.providerMessageId),
    code: "INTERNAL_TRANSIENT",
    status: row.processingStatus,
  });
  return {
    outcome: "retryable",
    id: row.id,
    status: row.processingStatus,
    code: "INTERNAL_TRANSIENT",
  };
}

async function advanceInbound(
  db: Db,
  envelope: WhatsAppInboundEnvelope,
  inboundId: number,
): Promise<InboundProcessResult> {
  try {
    await refreshOperationalPayload(db, inboundId, envelope);

    const identity = await resolveVerifiedWhatsAppUser(envelope.fromE164);
    if (isRetryableWhatsAppIdentity(identity)) {
      await markRetryable(db, inboundId, identity.code);
      logSafe({
        event: "whatsapp_inbound_retryable",
        messageSidHash: messageSidHash(envelope.providerMessageId),
        code: identity.code,
        status: WhatsAppInboundStatuses.RETRYABLE,
      });
      return {
        outcome: "retryable",
        id: inboundId,
        status: WhatsAppInboundStatuses.RETRYABLE,
        code: identity.code,
      };
    }

    if (!identity.ok) {
      const committed = await commitGuarded(db, inboundId, {
        userId: null,
        processingStatus: identity.code,
        errorCode: identity.code,
        processedAt: new Date(),
        ...clearedOperationalPayload(),
      });
      if (!committed) {
        const latest = await loadByProviderMessage(
          db,
          envelope.providerMessageId,
        );
        if (latest && isWhatsAppInboundTerminalStatus(latest.processingStatus)) {
          return replayOf(latest);
        }
        return {
          outcome: "retryable",
          id: inboundId,
          status: WhatsAppInboundStatuses.RETRYABLE,
          code: "INTERNAL_TRANSIENT",
        };
      }
      logSafe({
        event: "whatsapp_inbound_accepted",
        messageSidHash: messageSidHash(envelope.providerMessageId),
        userId: null,
        contentKind: envelope.content.kind,
        status: identity.code,
        errorCode: identity.code,
      });
      return {
        outcome: "accepted",
        id: inboundId,
        status: identity.code,
        userId: null,
      };
    }

    if (envelope.content.kind === "UNSUPPORTED_MEDIA") {
      const committed = await commitGuarded(db, inboundId, {
        userId: identity.userId,
        processingStatus: WhatsAppInboundStatuses.UNSUPPORTED,
        errorCode: "UNSUPPORTED_MEDIA",
        processedAt: new Date(),
        ...clearedOperationalPayload(),
      });
      if (!committed) {
        const latest = await loadByProviderMessage(
          db,
          envelope.providerMessageId,
        );
        if (latest && isWhatsAppInboundTerminalStatus(latest.processingStatus)) {
          return replayOf(latest);
        }
        return {
          outcome: "retryable",
          id: inboundId,
          status: WhatsAppInboundStatuses.RETRYABLE,
          code: "INTERNAL_TRANSIENT",
        };
      }
      logSafe({
        event: "whatsapp_inbound_accepted",
        messageSidHash: messageSidHash(envelope.providerMessageId),
        userId: identity.userId,
        contentKind: envelope.content.kind,
        status: WhatsAppInboundStatuses.UNSUPPORTED,
        errorCode: "UNSUPPORTED_MEDIA",
      });
      return {
        outcome: "accepted",
        id: inboundId,
        status: WhatsAppInboundStatuses.UNSUPPORTED,
        userId: identity.userId,
      };
    }

    const payload = operationalPayloadFromEnvelope(envelope.content);
    if (!hasMaterialForReadyStatus(envelope.content.kind, payload)) {
      await markRetryable(db, inboundId, "INTERNAL_TRANSIENT");
      return {
        outcome: "retryable",
        id: inboundId,
        status: WhatsAppInboundStatuses.RETRYABLE,
        code: "INTERNAL_TRANSIENT",
      };
    }

    const status =
      envelope.content.kind === "AUDIO"
        ? WhatsAppInboundStatuses.READY_FOR_TRANSCRIPTION
        : WhatsAppInboundStatuses.READY_FOR_NL;

    const committed = await commitGuarded(db, inboundId, {
      userId: identity.userId,
      processingStatus: status,
      errorCode: null,
      processedAt: new Date(),
      ...payload,
    });
    if (!committed) {
      const latest = await loadByProviderMessage(db, envelope.providerMessageId);
      if (latest && isWhatsAppInboundTerminalStatus(latest.processingStatus)) {
        return replayOf(latest);
      }
      return {
        outcome: "retryable",
        id: inboundId,
        status: WhatsAppInboundStatuses.RETRYABLE,
        code: "INTERNAL_TRANSIENT",
      };
    }

    logSafe({
      event: "whatsapp_inbound_accepted",
      messageSidHash: messageSidHash(envelope.providerMessageId),
      userId: identity.userId,
      contentKind: envelope.content.kind,
      status,
      errorCode: null,
    });
    return {
      outcome: "accepted",
      id: inboundId,
      status,
      userId: identity.userId,
    };
  } catch {
    const latest = await loadByProviderMessage(db, envelope.providerMessageId);
    if (latest && isWhatsAppInboundTerminalStatus(latest.processingStatus)) {
      return replayOf(latest);
    }
    await markRetryable(db, inboundId, "INTERNAL_TRANSIENT");
    logSafe({
      event: "whatsapp_inbound_retryable",
      messageSidHash: messageSidHash(envelope.providerMessageId),
      code: "INTERNAL_TRANSIENT",
      status: WhatsAppInboundStatuses.RETRYABLE,
    });
    return {
      outcome: "retryable",
      id: inboundId,
      status: WhatsAppInboundStatuses.RETRYABLE,
      code: "INTERNAL_TRANSIENT",
    };
  }
}

export async function processWhatsAppInbound(
  envelope: WhatsAppInboundEnvelope,
): Promise<InboundProcessResult> {
  const db = await getDb();
  if (!db) {
    logSafe({
      event: "whatsapp_inbound_retryable",
      messageSidHash: messageSidHash(envelope.providerMessageId),
      code: "DB_UNAVAILABLE",
    });
    return {
      outcome: "retryable",
      id: null,
      status: null,
      code: "DB_UNAVAILABLE",
    };
  }

  const existing = await loadByProviderMessage(db, envelope.providerMessageId);
  if (existing) {
    return finishExisting(db, envelope, existing);
  }

  let insertedId: number;
  try {
    const [inserted] = await db
      .insert(whatsappInboundMessages)
      .values({
        provider: WHATSAPP_INBOUND_PROVIDER,
        providerMessageId: envelope.providerMessageId,
        userId: null,
        contentKind: envelope.content.kind,
        forwarded:
          envelope.content.kind === "TEXT" ? envelope.content.forwarded : false,
        processingStatus: WhatsAppInboundStatuses.RECEIVED,
        errorCode: null,
        receivedAt: envelope.receivedAt,
        processedAt: null,
        ...operationalPayloadFromEnvelope(envelope.content),
      })
      .$returningId();
    insertedId = inserted.id;
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const raced = await loadByProviderMessage(db, envelope.providerMessageId);
      if (raced) {
        logSafe({
          event: "whatsapp_inbound_unique_race",
          messageSidHash: messageSidHash(envelope.providerMessageId),
          status: raced.processingStatus,
        });
        return finishExisting(db, envelope, raced);
      }
    }
    logSafe({
      event: "whatsapp_inbound_retryable",
      messageSidHash: messageSidHash(envelope.providerMessageId),
      code: "PERSISTENCE_FAILED",
    });
    return {
      outcome: "retryable",
      id: null,
      status: null,
      code: "PERSISTENCE_FAILED",
    };
  }

  return advanceInbound(db, envelope, insertedId);
}
