/**
 * Apply transacional da continuação WhatsApp.
 *
 * lock/reload → verify child attach → outcome NULL → ownership → OPEN →
 * expected stage → not expired → mutate pending → write outcome → commit.
 *
 * CONTINUATION_STAGE_FENCE e CONTINUATION_USER_OWNERSHIP no WHERE.
 * CONTINUATION_PERSIST_OUTCOME no mesmo commit da mutação do pending.
 * CONTINUATION_NOOP_NOT_ON_STATE_CHANGED: STATE_CHANGED não grava NOOP.
 */
import { and, eq, gt, isNull } from "drizzle-orm";
import {
  whatsappInboundMessages,
  whatsappPendingIntents,
} from "../../../drizzle/schema";
import { getDb } from "../../db";
import { logger } from "../../_core/logger";
import type {
  WhatsAppClarificationV1,
  WhatsAppParsedSwapIntentV1,
  WhatsAppResolvedSwapIntentV1,
} from "./pending-intent-payloads";
import {
  WhatsAppConfirmationDispositions,
  WhatsAppContinuationOutcomes,
  WhatsAppPendingStages,
  WhatsAppPendingStatuses,
  isWhatsAppPendingTerminalStatus,
  pendingExpiresAtFrom,
  type WhatsAppPendingIntentRecord,
} from "./pending-intent-types";
import { WHATSAPP_INBOUND_PROVIDER } from "./types";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export type WhatsAppContinuationApplyAction =
  | {
      type: "CHOICE_CONFIRMATION";
      parsed: WhatsAppParsedSwapIntentV1;
      resolved: WhatsAppResolvedSwapIntentV1;
    }
  | {
      type: "CHOICE_CLARIFICATION";
      parsed: WhatsAppParsedSwapIntentV1 | null;
      clarification: WhatsAppClarificationV1;
    }
  | { type: "AFFIRM" }
  | { type: "CANCEL" }
  | {
      type: "NOOP";
      reason: "UNRESOLVED" | "FRESH_INTENT" | "EXPIRED" | "TERMINAL";
    };

export type WhatsAppContinuationApplyResult =
  | {
      ok: true;
      outcome: "APPLIED" | "NOOP" | "already_reconciled";
      row: WhatsAppPendingIntentRecord;
      childOutcome: "APPLIED" | "NOOP";
    }
  | {
      ok: false;
      code:
        | "STATE_CHANGED"
        | "OWNERSHIP_MISMATCH"
        | "NOT_ATTACHED"
        | "INVALID_PAYLOAD"
        | "DB_UNAVAILABLE"
        | "PERSISTENCE_FAILED";
      row?: WhatsAppPendingIntentRecord;
    };

export const continuationApplyTestHooks: {
  afterPendingMutationBeforeCommit?: () => Promise<void> | void;
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
  code: Extract<WhatsAppContinuationApplyResult, { ok: false }>["code"],
  extra: Record<string, unknown> = {},
  row?: WhatsAppPendingIntentRecord,
): WhatsAppContinuationApplyResult {
  logSafe({
    event: "whatsapp_continuation_apply_miss",
    code,
    ...extra,
  });
  return row ? { ok: false, code, row } : { ok: false, code };
}

function expectedStageForAction(
  action: WhatsAppContinuationApplyAction,
  requested: "CLARIFICATION" | "CONFIRMATION",
): "CLARIFICATION" | "CONFIRMATION" {
  if (action.type === "AFFIRM") return WhatsAppPendingStages.CONFIRMATION;
  if (action.type === "CHOICE_CONFIRMATION" || action.type === "CHOICE_CLARIFICATION") {
    return WhatsAppPendingStages.CLARIFICATION;
  }
  return requested;
}

function slidesTtl(action: WhatsAppContinuationApplyAction): boolean {
  return (
    action.type === "CHOICE_CONFIRMATION" ||
    action.type === "CHOICE_CLARIFICATION" ||
    action.type === "AFFIRM"
  );
}

function pendingMutation(
  action: WhatsAppContinuationApplyAction,
  now: Date,
): Record<string, unknown> | null {
  if (action.type === "NOOP") return null;
  if (action.type === "CANCEL") {
    return {
      status: WhatsAppPendingStatuses.CANCELLED,
      parsedPayload: null,
      resolvedPayload: null,
      clarificationPayload: null,
      confirmationDisposition: null,
      payloadClearedAt: now,
    };
  }
  if (action.type === "AFFIRM") {
    return {
      confirmationDisposition: WhatsAppConfirmationDispositions.AFFIRMED,
      expiresAt: pendingExpiresAtFrom(now),
    };
  }
  if (action.type === "CHOICE_CONFIRMATION") {
    return {
      stage: WhatsAppPendingStages.CONFIRMATION,
      intentKind: action.resolved.kind,
      parsedPayload: action.parsed,
      resolvedPayload: action.resolved,
      clarificationPayload: null,
      institutionId: action.resolved.institutionId,
      confirmationDisposition: null,
      expiresAt: pendingExpiresAtFrom(now),
    };
  }
  return {
    stage: WhatsAppPendingStages.CLARIFICATION,
    intentKind: action.parsed?.kind ?? null,
    parsedPayload: action.parsed,
    resolvedPayload: null,
    clarificationPayload: action.clarification,
    institutionId: null,
    confirmationDisposition: null,
    expiresAt: pendingExpiresAtFrom(now),
  };
}

export async function applyWhatsAppContinuation(input: {
  pendingId: number;
  userId: number;
  childInboundId: number;
  expectedSourceInboundMessageId: number;
  expectedStage: "CLARIFICATION" | "CONFIRMATION";
  action: WhatsAppContinuationApplyAction;
  now?: Date;
}): Promise<WhatsAppContinuationApplyResult> {
  const now = input.now ?? new Date();
  const expectedStage = expectedStageForAction(
    input.action,
    input.expectedStage,
  );

  let db: Db | null;
  try {
    db = await getDb();
  } catch {
    return fail("PERSISTENCE_FAILED", { pendingId: input.pendingId });
  }
  if (!db) return fail("DB_UNAVAILABLE", { pendingId: input.pendingId });

  try {
    return await db.transaction(async (tx) => {
      const [pendingRow] = await tx
        .select()
        .from(whatsappPendingIntents)
        .where(eq(whatsappPendingIntents.id, input.pendingId))
        .limit(1)
        .for("update");
      if (!pendingRow) return fail("PERSISTENCE_FAILED");
      let pending = toPending(pendingRow);

      const [child] = await tx
        .select({
          id: whatsappInboundMessages.id,
          userId: whatsappInboundMessages.userId,
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
      if (!child) return fail("NOT_ATTACHED");

      if (
        pending.userId !== input.userId ||
        child.userId !== input.userId
      ) {
        return fail("OWNERSHIP_MISMATCH", { pendingId: pending.id }, pending);
      }
      if (child.continuationPendingId !== pending.id) {
        return fail("NOT_ATTACHED", { childInboundId: child.id }, pending);
      }
      if (
        child.continuationOutcome === "APPLIED" ||
        child.continuationOutcome === "NOOP"
      ) {
        return {
          ok: true,
          outcome: "already_reconciled",
          row: pending,
          childOutcome: child.continuationOutcome,
        };
      }

      const expired =
        pending.status === WhatsAppPendingStatuses.OPEN &&
        pending.expiresAt.getTime() <= now.getTime();
      if (expired || isWhatsAppPendingTerminalStatus(pending.status)) {
        if (expired) {
          await tx
            .update(whatsappPendingIntents)
            .set({
              status: WhatsAppPendingStatuses.EXPIRED,
              parsedPayload: null,
              resolvedPayload: null,
              clarificationPayload: null,
              confirmationDisposition: null,
              payloadClearedAt: now,
            })
            .where(
              and(
                eq(whatsappPendingIntents.id, pending.id),
                eq(whatsappPendingIntents.userId, input.userId),
                eq(whatsappPendingIntents.status, WhatsAppPendingStatuses.OPEN),
              ),
            );
        }
        requireOutcomeWrite(
          await writeOutcome(tx, {
            childId: child.id,
            pendingId: pending.id,
            userId: input.userId,
            outcome: WhatsAppContinuationOutcomes.NOOP,
          }),
        );
        const latest = await reloadPending(tx, pending.id, input.userId);
        if (continuationApplyTestHooks.afterPendingMutationBeforeCommit) {
          await continuationApplyTestHooks.afterPendingMutationBeforeCommit();
        }
        return {
          ok: true,
          outcome: "NOOP",
          row: latest ?? pending,
          childOutcome: "NOOP",
        };
      }

      if (
        pending.status !== WhatsAppPendingStatuses.OPEN ||
        pending.stage !== expectedStage ||
        pending.sourceInboundMessageId !== input.expectedSourceInboundMessageId
      ) {
        // CONTINUATION_NOOP_NOT_ON_STATE_CHANGED
        return fail("STATE_CHANGED", { pendingId: pending.id }, pending);
      }

      if (
        input.action.type === "AFFIRM" &&
        pending.confirmationDisposition ===
          WhatsAppConfirmationDispositions.AFFIRMED
      ) {
        requireOutcomeWrite(
          await writeOutcome(tx, {
            childId: child.id,
            pendingId: pending.id,
            userId: input.userId,
            outcome: WhatsAppContinuationOutcomes.NOOP,
          }),
        );
        if (continuationApplyTestHooks.afterPendingMutationBeforeCommit) {
          await continuationApplyTestHooks.afterPendingMutationBeforeCommit();
        }
        return {
          ok: true,
          outcome: "NOOP",
          row: pending,
          childOutcome: "NOOP",
        };
      }

      const mutation = pendingMutation(input.action, now);
      if (mutation) {
        const fence = and(
          eq(whatsappPendingIntents.id, pending.id),
          eq(whatsappPendingIntents.userId, input.userId), // CONTINUATION_USER_OWNERSHIP
          eq(
            whatsappPendingIntents.sourceInboundMessageId,
            input.expectedSourceInboundMessageId,
          ),
          eq(whatsappPendingIntents.status, WhatsAppPendingStatuses.OPEN),
          eq(whatsappPendingIntents.stage, expectedStage), // CONTINUATION_STAGE_FENCE
          gt(whatsappPendingIntents.expiresAt, now),
        );
        const updated = await tx
          .update(whatsappPendingIntents)
          .set(mutation)
          .where(fence);
        if (affectedRows(updated) === 0) {
          const latest = await reloadPending(tx, pending.id, input.userId);
          return fail("STATE_CHANGED", { pendingId: pending.id }, latest ?? pending);
        }
      }

      const childOutcome =
        input.action.type === "NOOP"
          ? WhatsAppContinuationOutcomes.NOOP
          : WhatsAppContinuationOutcomes.APPLIED;
      requireOutcomeWrite(
        await writeOutcome(tx, {
          childId: child.id,
          pendingId: pending.id,
          userId: input.userId,
          outcome: childOutcome,
        }),
      );

      if (continuationApplyTestHooks.afterPendingMutationBeforeCommit) {
        await continuationApplyTestHooks.afterPendingMutationBeforeCommit();
      }

      const latest = await reloadPending(tx, pending.id, input.userId);
      if (!latest) return fail("PERSISTENCE_FAILED", {}, pending);
      logSafe({
        event: "whatsapp_continuation_applied",
        pendingId: pending.id,
        childInboundId: child.id,
        action: input.action.type,
        outcome: childOutcome,
        ttlSlid: slidesTtl(input.action) && childOutcome === "APPLIED",
      });
      return {
        ok: true,
        outcome: childOutcome,
        row: latest,
        childOutcome,
      };
    });
  } catch {
    logSafe({
      event: "whatsapp_continuation_apply_failed",
      pendingId: input.pendingId,
      childInboundId: input.childInboundId,
      code: "PERSISTENCE_FAILED",
    });
    return fail("PERSISTENCE_FAILED", { pendingId: input.pendingId });
  }
}

async function reloadPending(
  tx: {
    select: Db["select"];
  },
  pendingId: number,
  userId: number,
): Promise<WhatsAppPendingIntentRecord | null> {
  const [row] = await tx
    .select()
    .from(whatsappPendingIntents)
    .where(
      and(
        eq(whatsappPendingIntents.id, pendingId),
        eq(whatsappPendingIntents.userId, userId),
      ),
    )
    .limit(1);
  return row ? toPending(row) : null;
}

function requireOutcomeWrite(wrote: boolean): void {
  if (!wrote) {
    throw new Error("whatsapp_continuation_outcome_write_failed");
  }
}

async function writeOutcome(
  tx: {
    update: Db["update"];
  },
  input: {
    childId: number;
    pendingId: number;
    userId: number;
    outcome: "APPLIED" | "NOOP";
  },
): Promise<boolean> {
  // CONTINUATION_PERSIST_OUTCOME
  const updated = await tx
    .update(whatsappInboundMessages)
    .set({ continuationOutcome: input.outcome })
    .where(
      and(
        eq(whatsappInboundMessages.id, input.childId),
        eq(whatsappInboundMessages.userId, input.userId),
        eq(whatsappInboundMessages.continuationPendingId, input.pendingId),
        isNull(whatsappInboundMessages.continuationOutcome),
      ),
    );
  return affectedRows(updated) > 0;
}
