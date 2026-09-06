/**
 * Attach CAS: child READY_FOR_NL aponta para o único pending OPEN
 * CLARIFICATION|CONFIRMATION do mesmo usuário.
 *
 * Lock order: pending FOR UPDATE → child inbound FOR UPDATE.
 * Idempotente se já aponta ao mesmo P. Outro P → fail-closed.
 * OPEN/PARSE não anexa (caller WAIT).
 * CONTINUATION_NO_NEW_ATTACH_WITHOUT_PAYLOAD: child sem payload operacional
 * usável não adquire ponteiro novo. Replay com outcome já gravado permanece.
 */
import { and, eq, gt, isNotNull, isNull, or } from "drizzle-orm";
import {
  whatsappInboundMessages,
  whatsappPendingIntents,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import { logger } from "../../_core/logger";
import {
  WhatsAppPendingStages,
  WhatsAppPendingStatuses,
  isWhatsAppPendingTerminalStatus,
  type WhatsAppPendingIntentRecord,
} from "./pending-intent-types";
import { isWhatsAppInboundPayloadUsable } from "./operational-payload";
import { WHATSAPP_INBOUND_PROVIDER, WhatsAppInboundStatuses } from "./types";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export type WhatsAppContinuationAttachResult =
  | {
      ok: true;
      outcome: "attached" | "already_attached";
      pending: WhatsAppPendingIntentRecord;
      continuationOutcome: "APPLIED" | "NOOP" | null;
    }
  | {
      ok: false;
      code:
        | "NOT_ATTACHABLE"
        | "ATTACH_CONFLICT"
        | "EXPIRED"
        | "OWNERSHIP_MISMATCH"
        | "CHILD_NOT_FOUND"
        | "PENDING_NOT_FOUND"
        | "STATE_CHANGED"
        | "PAYLOAD_UNAVAILABLE"
        | "DB_UNAVAILABLE"
        | "PERSISTENCE_FAILED";
      pending?: WhatsAppPendingIntentRecord;
    };

export const continuationAttachTestHooks: {
  throwDuringAttach?: () => Promise<void> | void;
} = {};

function logSafe(payload: Record<string, unknown>): void {
  logger.info(JSON.stringify(payload));
}

function affectedRows(result: unknown): number {
  if (Array.isArray(result)) {
    return Number(
      (result[0] as { affectedRows?: unknown } | undefined)?.affectedRows ?? 0,
    );
  }
  return Number((result as { affectedRows?: unknown } | null)?.affectedRows ?? 0);
}

function toPending(row: {
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
  confirmationDisposition: string | null;
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
    confirmationDisposition: row.confirmationDisposition,
  };
}

function fail(
  code: Extract<WhatsAppContinuationAttachResult, { ok: false }>["code"],
  extra: Record<string, unknown> = {},
  pending?: WhatsAppPendingIntentRecord,
): WhatsAppContinuationAttachResult {
  logSafe({
    event: "whatsapp_continuation_attach_miss",
    code,
    ...extra,
  });
  return pending ? { ok: false, code, pending } : { ok: false, code };
}

export async function attachWhatsAppContinuation(input: {
  pendingId: number;
  childInboundId: number;
  userId: number;
  now?: Date;
}): Promise<WhatsAppContinuationAttachResult> {
  const now = input.now ?? new Date();
  let db: Db | null;
  try {
    db = await getDb();
  } catch {
    return fail("PERSISTENCE_FAILED", {
      pendingId: input.pendingId,
      childInboundId: input.childInboundId,
    });
  }
  if (!db) {
    return fail("DB_UNAVAILABLE", {
      pendingId: input.pendingId,
      childInboundId: input.childInboundId,
    });
  }

  try {
    return await db.transaction(async (tx) => {
      if (continuationAttachTestHooks.throwDuringAttach) {
        await continuationAttachTestHooks.throwDuringAttach();
      }

      const [pendingRow] = await tx
        .select()
        .from(whatsappPendingIntents)
        .where(eq(whatsappPendingIntents.id, input.pendingId))
        .limit(1)
        .for("update");
      if (!pendingRow) return fail("PENDING_NOT_FOUND");
      const pending = toPending(pendingRow);

      const [child] = await tx
        .select({
          id: whatsappInboundMessages.id,
          userId: whatsappInboundMessages.userId,
          processingStatus: whatsappInboundMessages.processingStatus,
          contentKind: whatsappInboundMessages.contentKind,
          operationalText: whatsappInboundMessages.operationalText,
          mediaUrl: whatsappInboundMessages.mediaUrl,
          payloadExpiresAt: whatsappInboundMessages.payloadExpiresAt,
          payloadClearedAt: whatsappInboundMessages.payloadClearedAt,
          continuationPendingId: whatsappInboundMessages.continuationPendingId,
          continuationOutcome: whatsappInboundMessages.continuationOutcome,
        })
        .from(whatsappInboundMessages)
        .where(
          and(
            eq(whatsappInboundMessages.id, input.childInboundId),
            eq(whatsappInboundMessages.provider, WHATSAPP_INBOUND_PROVIDER),
          ),
        )
        .limit(1)
        .for("update");
      if (!child) return fail("CHILD_NOT_FOUND");

      if (pending.userId !== input.userId || child.userId !== input.userId) {
        return fail("OWNERSHIP_MISMATCH", {
          pendingId: pending.id,
          childInboundId: child.id,
        });
      }
      if (child.id === pending.sourceInboundMessageId) {
        return fail("NOT_ATTACHABLE", { pendingId: pending.id }, pending);
      }
      if (isWhatsAppPendingTerminalStatus(pending.status)) {
        return fail(
          pending.status === WhatsAppPendingStatuses.EXPIRED
            ? "EXPIRED"
            : "STATE_CHANGED",
          { pendingId: pending.id },
          pending,
        );
      }
      if (pending.expiresAt.getTime() <= now.getTime()) {
        return fail("EXPIRED", { pendingId: pending.id }, pending);
      }
      if (
        pending.status !== WhatsAppPendingStatuses.OPEN ||
        (pending.stage !== WhatsAppPendingStages.CLARIFICATION &&
          pending.stage !== WhatsAppPendingStages.CONFIRMATION)
      ) {
        return fail("NOT_ATTACHABLE", { pendingId: pending.id }, pending);
      }
      if (
        child.processingStatus !== WhatsAppInboundStatuses.READY_FOR_NL ||
        child.contentKind !== "TEXT"
      ) {
        return fail("STATE_CHANGED", { childInboundId: child.id }, pending);
      }

      if (child.continuationPendingId === pending.id) {
        logSafe({
          event: "whatsapp_continuation_attached",
          pendingId: pending.id,
          childInboundId: child.id,
          outcome: "already_attached",
        });
        return {
          ok: true,
          outcome: "already_attached",
          pending,
          continuationOutcome:
            child.continuationOutcome === "APPLIED" ||
            child.continuationOutcome === "NOOP"
              ? child.continuationOutcome
              : null,
        };
      }
      if (child.continuationPendingId != null) {
        return fail("ATTACH_CONFLICT", {
          pendingId: pending.id,
          childInboundId: child.id,
        });
      }

      // CONTINUATION_NO_NEW_ATTACH_WITHOUT_PAYLOAD
      if (
        !isWhatsAppInboundPayloadUsable(
          {
            contentKind: child.contentKind,
            operationalText: child.operationalText,
            mediaUrl: child.mediaUrl,
            payloadExpiresAt: child.payloadExpiresAt,
            payloadClearedAt: child.payloadClearedAt,
          },
          now,
        )
      ) {
        return fail("PAYLOAD_UNAVAILABLE", {
          pendingId: pending.id,
          childInboundId: child.id,
        });
      }

      const updated = await tx
        .update(whatsappInboundMessages)
        .set({ continuationPendingId: pending.id })
        .where(
          and(
            eq(whatsappInboundMessages.id, child.id),
            eq(whatsappInboundMessages.userId, input.userId),
            eq(
              whatsappInboundMessages.processingStatus,
              WhatsAppInboundStatuses.READY_FOR_NL,
            ),
            eq(whatsappInboundMessages.provider, WHATSAPP_INBOUND_PROVIDER),
            eq(whatsappInboundMessages.contentKind, "TEXT"),
            isNull(whatsappInboundMessages.continuationPendingId),
            isNull(whatsappInboundMessages.payloadClearedAt),
            isNotNull(whatsappInboundMessages.operationalText),
            or(
              isNull(whatsappInboundMessages.payloadExpiresAt),
              gt(whatsappInboundMessages.payloadExpiresAt, now),
            ),
          ),
        );

      if (affectedRows(updated) > 0) {
        logSafe({
          event: "whatsapp_continuation_attached",
          pendingId: pending.id,
          childInboundId: child.id,
          outcome: "attached",
        });
        return {
          ok: true,
          outcome: "attached",
          pending,
          continuationOutcome: null,
        };
      }

      const [latest] = await tx
        .select({
          continuationPendingId: whatsappInboundMessages.continuationPendingId,
          continuationOutcome: whatsappInboundMessages.continuationOutcome,
        })
        .from(whatsappInboundMessages)
        .where(eq(whatsappInboundMessages.id, child.id))
        .limit(1);
      if (latest?.continuationPendingId === pending.id) {
        return {
          ok: true,
          outcome: "already_attached",
          pending,
          continuationOutcome:
            latest.continuationOutcome === "APPLIED" ||
            latest.continuationOutcome === "NOOP"
              ? latest.continuationOutcome
              : null,
        };
      }
      if (latest?.continuationPendingId != null) {
        return fail("ATTACH_CONFLICT", {
          pendingId: pending.id,
          childInboundId: child.id,
        });
      }
      return fail("PERSISTENCE_FAILED", {
        pendingId: pending.id,
        childInboundId: child.id,
      });
    });
  } catch {
    logSafe({
      event: "whatsapp_continuation_attach_failed",
      pendingId: input.pendingId,
      childInboundId: input.childInboundId,
      code: "PERSISTENCE_FAILED",
    });
    return fail("PERSISTENCE_FAILED", {
      pendingId: input.pendingId,
      childInboundId: input.childInboundId,
    });
  }
}
