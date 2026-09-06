/**
 * Orquestra continuação: attach → interpret → apply stage-fenced → cleanup.
 *
 * Replay com continuation_outcome preenchido: skip interpret/apply/TTL.
 * STATE_CHANGED: reload, reclassify against current stage; não grava NOOP
 * prematuro.
 *
 * CONTINUATION_FOUNDING_REQUIRES_PAYLOAD: EXPIRED não funda OPEN/PARSE
 * sem payload operacional usável — libera o open_slot e PARE.
 *
 * Não chama createSwapOffer. Não envia WhatsApp. Não rebinda o source fundador.
 */
import { resolveCanonicalOperationalActorForUser } from "../../_core/canonical-operational-actor";
import { logger } from "../../_core/logger";
import { resolveSwapIntent } from "../../natural-language/swap-intent-resolver";
import type {
  ShiftCandidate,
  SwapIntentDraft,
  SwapIntentError,
} from "../../natural-language/swap-intent-types";
import {
  attachWhatsAppContinuation,
} from "./continuation-attach";
import {
  applyWhatsAppContinuation,
  type WhatsAppContinuationApplyAction,
} from "./continuation-apply";
import {
  interpretWhatsAppContinuation,
  type WhatsAppContinuationInterpretation,
} from "./continuation-interpreter";
import {
  clearWhatsAppInboundOperationalPayloadForReadyNl,
  isWhatsAppInboundReadyNlClearFailure,
} from "./ready-for-nl-cleanup";
import {
  projectSectorClarificationFromResolver,
  projectTargetProfessionalClarificationFromResolver,
} from "./ready-for-nl-homonym-projection";
import type { WhatsAppInboundSourceForNl } from "./ready-for-nl-source";
import type { ProcessWhatsAppReadyForNlInboundResult } from "./ready-for-nl-types";
import {
  draftFromStoredParsedIntent,
  parseStoredClarification,
  parseStoredParsedIntent,
  serializeParsedSwapIntentV1,
  serializeResolvedSwapIntentV1,
  type WhatsAppPendingParseAdvanceOutcome,
} from "./pending-intent-payloads";
import {
  createWhatsAppPendingIntent,
  expireWhatsAppPendingIntent,
  getWhatsAppPendingIntentByIdForUser,
} from "./pending-intent-store";
import { classifySwapIntentErrorForConversation } from "./swap-intent-error-classification";
import {
  WhatsAppPendingStages,
  WhatsAppPendingStatuses,
  isWhatsAppPendingTerminalStatus,
  type WhatsAppPendingIntentRecord,
} from "./pending-intent-types";

const MAX_RECLASSIFY = 3;

export const continuationConsumerTestHooks: {
  afterAttachBeforeInterpret?: () => Promise<void> | void;
  duringInterpret?: () => Promise<void> | void;
  afterCommitBeforeCleanup?: () => Promise<void> | void;
} = {};

function logSafe(payload: Record<string, unknown>): void {
  logger.info(JSON.stringify(payload));
}

function retry(
  code: "DB_UNAVAILABLE" | "PERSISTENCE_FAILED" | "INTERNAL_FAILURE",
): ProcessWhatsAppReadyForNlInboundResult {
  return { ok: false, kind: "RETRYABLE_INFRA", code };
}

function blocked(
  code: Extract<
    ProcessWhatsAppReadyForNlInboundResult,
    { ok: false; kind: "BLOCKED" }
  >["code"],
): ProcessWhatsAppReadyForNlInboundResult {
  return { ok: false, kind: "BLOCKED", code };
}

function mapShiftCandidates(
  raw: readonly ShiftCandidate[] | undefined,
):
  | {
      ok: true;
      candidates: {
        shiftInstanceId: number;
        label: string;
        dayKey: string;
        timeRange: string;
        sectorName: string;
        institutionName: string;
      }[];
    }
  | { ok: false } {
  if (!raw || raw.length === 0) return { ok: false };
  return {
    ok: true,
    candidates: raw.map((item) => ({
      shiftInstanceId: item.shiftInstanceId,
      label: item.label,
      dayKey: item.dayKey,
      timeRange: item.timeRange,
      sectorName: item.sectorName,
      institutionName: item.institutionName,
    })),
  };
}

async function cleanupChild(input: {
  childInboundId: number;
  userId: number;
  pending: WhatsAppPendingIntentRecord;
  kind: "ADVANCED" | "REPLAY";
}): Promise<ProcessWhatsAppReadyForNlInboundResult> {
  const stage =
    input.pending.stage === WhatsAppPendingStages.CLARIFICATION ||
    input.pending.stage === WhatsAppPendingStages.CONFIRMATION
      ? input.pending.stage
      : null;
  const cleared = await clearWhatsAppInboundOperationalPayloadForReadyNl({
    sourceInboundMessageId: input.childInboundId,
    expectedUserId: input.userId,
  });
  if (isWhatsAppInboundReadyNlClearFailure(cleared)) {
    if (cleared.code === "STATE_CHANGED") return blocked("STATE_CHANGED");
    return retry(cleared.code);
  }
  if (!stage) {
    return {
      ok: true,
      kind: input.kind,
      stage: WhatsAppPendingStages.CONFIRMATION,
      pendingId: input.pending.id,
    };
  }
  return {
    ok: true,
    kind: input.kind,
    stage,
    pendingId: input.pending.id,
  };
}

async function clarificationFromError(
  draft: SwapIntentDraft | null,
  error: SwapIntentError,
): Promise<
  | { ok: true; outcome: WhatsAppPendingParseAdvanceOutcome }
  | { ok: false; result: ProcessWhatsAppReadyForNlInboundResult }
> {
  if (error.code === "AMBIGUOUS_INTENT") {
    return {
      ok: true,
      outcome: {
        type: "clarification",
        parsed: null,
        clarification: { version: 1, code: "AMBIGUOUS_INTENT" },
      },
    };
  }
  if (!draft) return { ok: false, result: blocked("INVALID_PAYLOAD") };
  const parsedV1 = serializeParsedSwapIntentV1(draft);
  if (!parsedV1.ok) return { ok: false, result: blocked("INVALID_PAYLOAD") };

  if (error.code === "AMBIGUOUS_TARGET_PROFESSIONAL") {
    const projected = await projectTargetProfessionalClarificationFromResolver(
      error.professionalCandidates ?? [],
    );
    if (!projected.ok) {
      if (projected.code === "INVALID_PAYLOAD") {
        return { ok: false, result: blocked("INVALID_PAYLOAD") };
      }
      return { ok: false, result: retry(projected.code) };
    }
    return {
      ok: true,
      outcome: {
        type: "clarification",
        parsed: parsedV1.value,
        clarification: projected.value,
      },
    };
  }
  if (error.code === "AMBIGUOUS_SECTOR") {
    const projected = await projectSectorClarificationFromResolver(
      error.sectorCandidates ?? [],
    );
    if (!projected.ok) {
      if (projected.code === "INVALID_PAYLOAD") {
        return { ok: false, result: blocked("INVALID_PAYLOAD") };
      }
      return { ok: false, result: retry(projected.code) };
    }
    return {
      ok: true,
      outcome: {
        type: "clarification",
        parsed: parsedV1.value,
        clarification: projected.value,
      },
    };
  }
  if (
    error.code === "AMBIGUOUS_OWN_SHIFT" ||
    error.code === "AMBIGUOUS_TARGET_SHIFT" ||
    error.code === "SWAP_TARGET_SHIFT_REQUIRED"
  ) {
    const shifts = mapShiftCandidates(error.shiftCandidates);
    if (!shifts.ok) return { ok: false, result: blocked("INVALID_PAYLOAD") };
    return {
      ok: true,
      outcome: {
        type: "clarification",
        parsed: parsedV1.value,
        clarification: {
          version: 1,
          code: error.code,
          candidates: shifts.candidates,
        },
      },
    };
  }
  return { ok: false, result: blocked("INVALID_PAYLOAD") };
}

async function actionFromChoice(input: {
  pending: WhatsAppPendingIntentRecord;
  interpretation: Extract<WhatsAppContinuationInterpretation, { category: "CHOICE" }>;
  userId: number;
}): Promise<
  | { ok: true; action: WhatsAppContinuationApplyAction }
  | { ok: false; result: ProcessWhatsAppReadyForNlInboundResult }
> {
  const storedParsed = parseStoredParsedIntent(input.pending.parsedPayload);
  if (!storedParsed.ok) return { ok: false, result: blocked("INVALID_PAYLOAD") };
  let draft = draftFromStoredParsedIntent(storedParsed.value);
  const choice = input.interpretation.choice;
  if (choice.kind === "SECTOR") {
    draft = {
      ...draft,
      ownShift: { ...draft.ownShift, sectorText: choice.label },
    };
  }

  const actor = await resolveCanonicalOperationalActorForUser({
    userId: input.userId,
  });
  if (!actor.ok) {
    if (
      actor.code === "DB_UNAVAILABLE" ||
      actor.code === "PERSISTENCE_FAILED"
    ) {
      return { ok: false, result: retry(actor.code) };
    }
    return { ok: false, result: blocked(actor.code) };
  }

  const options =
    choice.kind === "OWN_SHIFT"
      ? { chosenOwnShiftInstanceId: choice.shiftInstanceId }
      : choice.kind === "TARGET_SHIFT"
        ? { chosenTargetShiftInstanceId: choice.shiftInstanceId }
        : choice.kind === "TARGET_PROFESSIONAL"
          ? { chosenTargetProfessionalId: choice.professionalId }
          : {};

  let resolved;
  try {
    resolved = await resolveSwapIntent(draft, actor.actor, options);
  } catch {
    return { ok: false, result: retry("INTERNAL_FAILURE") };
  }

  if (resolved.ok) {
    const parsedV1 = serializeParsedSwapIntentV1(draft);
    const resolvedV1 = serializeResolvedSwapIntentV1(resolved);
    if (!parsedV1.ok || !resolvedV1.ok) {
      return { ok: false, result: blocked("INVALID_PAYLOAD") };
    }
    return {
      ok: true,
      action: {
        type: "CHOICE_CONFIRMATION",
        parsed: parsedV1.value,
        resolved: resolvedV1.value,
      },
    };
  }

  const classification = classifySwapIntentErrorForConversation(resolved.code);
  if (classification.class === "INTERNAL_FAILURE") {
    return { ok: false, result: retry("INTERNAL_FAILURE") };
  }
  if (
    classification.class === "NEEDS_REFORMULATION" ||
    classification.class === "TERMINAL_DOMAIN_CONFLICT"
  ) {
    return { ok: true, action: { type: "NOOP", reason: "UNRESOLVED" } };
  }
  const outcome = await clarificationFromError(draft, resolved);
  if (!outcome.ok) return outcome;
  if (outcome.outcome.type !== "clarification" || outcome.outcome.parsed === null) {
    return { ok: true, action: { type: "NOOP", reason: "UNRESOLVED" } };
  }
  return {
    ok: true,
    action: {
      type: "CHOICE_CLARIFICATION",
      parsed: outcome.outcome.parsed,
      clarification: outcome.outcome.clarification,
    },
  };
}

async function actionFromInterpretation(input: {
  pending: WhatsAppPendingIntentRecord;
  interpretation: WhatsAppContinuationInterpretation;
  userId: number;
}): Promise<
  | { ok: true; action: WhatsAppContinuationApplyAction }
  | { ok: false; result: ProcessWhatsAppReadyForNlInboundResult }
> {
  const { interpretation, pending, userId } = input;
  if (interpretation.category === "CHOICE") {
    return actionFromChoice({ pending, interpretation, userId });
  }
  if (interpretation.category === "CANCEL" || interpretation.category === "DENY") {
    return { ok: true, action: { type: "CANCEL" } };
  }
  if (interpretation.category === "AFFIRM") {
    return { ok: true, action: { type: "AFFIRM" } };
  }
  if (interpretation.category === "FRESH_INTENT") {
    return { ok: true, action: { type: "NOOP", reason: "FRESH_INTENT" } };
  }
  return { ok: true, action: { type: "NOOP", reason: "UNRESOLVED" } };
}

async function reloadPending(
  pendingId: number,
  userId: number,
): Promise<
  | { ok: true; row: WhatsAppPendingIntentRecord | null }
  | { ok: false; result: ProcessWhatsAppReadyForNlInboundResult }
> {
  const read = await getWhatsAppPendingIntentByIdForUser(pendingId, userId);
  if (!read.ok) return { ok: false, result: retry(read.code) };
  return { ok: true, row: read.row };
}

async function applyInterpreted(input: {
  pending: WhatsAppPendingIntentRecord;
  source: WhatsAppInboundSourceForNl;
  text: string;
  userId: number;
}): Promise<ProcessWhatsAppReadyForNlInboundResult> {
  let pending = input.pending;
  for (let attempt = 0; attempt < MAX_RECLASSIFY; attempt += 1) {
    if (
      pending.stage !== WhatsAppPendingStages.CLARIFICATION &&
      pending.stage !== WhatsAppPendingStages.CONFIRMATION
    ) {
      return blocked("STATE_CHANGED");
    }
    if (continuationConsumerTestHooks.duringInterpret) {
      await continuationConsumerTestHooks.duringInterpret();
    }
    const clarification = parseStoredClarification(pending.clarificationPayload);
    const interpretation = interpretWhatsAppContinuation({
      text: input.text,
      stage: pending.stage,
      clarification: clarification.ok ? clarification.value : null,
    });
    const mapped = await actionFromInterpretation({
      pending,
      interpretation,
      userId: input.userId,
    });
    if (!mapped.ok) return mapped.result;

    const applied = await applyWhatsAppContinuation({
      pendingId: pending.id,
      userId: input.userId,
      childInboundId: input.source.id,
      expectedSourceInboundMessageId: pending.sourceInboundMessageId,
      expectedStage: pending.stage,
      action: mapped.action,
      generation: {
        parsedPayload: pending.parsedPayload,
        clarificationPayload: pending.clarificationPayload,
      },
    });
    if (!applied.ok) {
      if (
        applied.code === "DB_UNAVAILABLE" ||
        applied.code === "PERSISTENCE_FAILED"
      ) {
        return retry(applied.code);
      }
      if (applied.code === "OWNERSHIP_MISMATCH") {
        return blocked("OWNERSHIP_MISMATCH");
      }
      if (applied.code !== "STATE_CHANGED") {
        return blocked("STATE_CHANGED");
      }
      const reloaded = await reloadPending(pending.id, input.userId);
      if (!reloaded.ok) return reloaded.result;
      if (!reloaded.row) return blocked("STATE_CHANGED");
      pending = reloaded.row;
      if (isWhatsAppPendingTerminalStatus(pending.status)) {
        const terminal = await applyWhatsAppContinuation({
          pendingId: pending.id,
          userId: input.userId,
          childInboundId: input.source.id,
          expectedSourceInboundMessageId: pending.sourceInboundMessageId,
          expectedStage:
            pending.stage === WhatsAppPendingStages.CONFIRMATION
              ? WhatsAppPendingStages.CONFIRMATION
              : WhatsAppPendingStages.CLARIFICATION,
          action: { type: "NOOP", reason: "TERMINAL" },
          generation: {
            parsedPayload: pending.parsedPayload,
            clarificationPayload: pending.clarificationPayload,
          },
        });
        if (!terminal.ok) {
          if (
            terminal.code === "DB_UNAVAILABLE" ||
            terminal.code === "PERSISTENCE_FAILED"
          ) {
            return retry(terminal.code);
          }
          return blocked("STATE_CHANGED");
        }
        return finish(terminal.row, input.source.id, input.userId, "ADVANCED");
      }
      continue;
    }
    return finish(
      applied.row,
      input.source.id,
      input.userId,
      applied.outcome === "already_reconciled" ? "REPLAY" : "ADVANCED",
    );
  }
  return blocked("STATE_CHANGED");
}

async function finish(
  pending: WhatsAppPendingIntentRecord,
  childInboundId: number,
  userId: number,
  kind: "ADVANCED" | "REPLAY",
): Promise<ProcessWhatsAppReadyForNlInboundResult> {
  if (continuationConsumerTestHooks.afterCommitBeforeCleanup) {
    await continuationConsumerTestHooks.afterCommitBeforeCleanup();
  }
  return cleanupChild({ childInboundId, userId, pending, kind });
}

async function releaseExpiredToFounding(input: {
  pending: WhatsAppPendingIntentRecord;
  source: WhatsAppInboundSourceForNl;
  payloadUsable: boolean;
  text: string;
  onFoundingSlot: (
    pending: WhatsAppPendingIntentRecord,
  ) => Promise<ProcessWhatsAppReadyForNlInboundResult>;
}): Promise<ProcessWhatsAppReadyForNlInboundResult> {
  const expired = await expireWhatsAppPendingIntent(
    input.pending.id,
    input.pending.userId,
  );
  if (!expired.ok) {
    if (
      expired.code === "DB_UNAVAILABLE" ||
      expired.code === "PERSISTENCE_FAILED"
    ) {
      return retry(expired.code);
    }
    return retry("PERSISTENCE_FAILED");
  }
  // CONTINUATION_FOUNDING_REQUIRES_PAYLOAD
  if (!input.payloadUsable || !input.text) {
    return blocked("SOURCE_OPERATIONAL_PAYLOAD_UNAVAILABLE");
  }
  const created = await createWhatsAppPendingIntent({
    sourceInboundMessageId: input.source.id,
  });
  if (!created.ok) {
    if (
      created.code === "DB_UNAVAILABLE" ||
      created.code === "PERSISTENCE_FAILED"
    ) {
      return retry(created.code);
    }
    return blocked("SOURCE_NOT_READY");
  }
  if (created.outcome === "created" || created.outcome === "replay") {
    return input.onFoundingSlot(created.row);
  }
  if (created.outcome === "already_open") {
    if (created.row.stage === WhatsAppPendingStages.PARSE) {
      return blocked("ALREADY_OPEN");
    }
    return blocked("STATE_CHANGED");
  }
  return created.row.status === WhatsAppPendingStatuses.EXPIRED
    ? blocked("PENDING_EXPIRED")
    : blocked("PENDING_TERMINAL");
}

export async function processWhatsAppContinuation(input: {
  pending: WhatsAppPendingIntentRecord;
  source: WhatsAppInboundSourceForNl;
  payloadUsable: boolean;
  text: string;
  onFoundingSlot: (
    pending: WhatsAppPendingIntentRecord,
  ) => Promise<ProcessWhatsAppReadyForNlInboundResult>;
}): Promise<ProcessWhatsAppReadyForNlInboundResult> {
  const userId = input.source.userId;
  if (userId == null || userId !== input.pending.userId) {
    return blocked("OWNERSHIP_MISMATCH");
  }

  const attached = await attachWhatsAppContinuation({
    pendingId: input.pending.id,
    childInboundId: input.source.id,
    userId,
  });
  if (!attached.ok) {
    if (
      attached.code === "DB_UNAVAILABLE" ||
      attached.code === "PERSISTENCE_FAILED"
    ) {
      return retry(attached.code);
    }
    if (attached.code === "EXPIRED") {
      return releaseExpiredToFounding({
        pending: attached.pending ?? input.pending,
        source: input.source,
        payloadUsable: input.payloadUsable,
        text: input.text,
        onFoundingSlot: input.onFoundingSlot,
      });
    }
    if (attached.code === "OWNERSHIP_MISMATCH") {
      return blocked("OWNERSHIP_MISMATCH");
    }
    if (attached.code === "ATTACH_CONFLICT") {
      return blocked("STATE_CHANGED");
    }
    if (attached.code === "PAYLOAD_UNAVAILABLE") {
      return blocked("SOURCE_OPERATIONAL_PAYLOAD_UNAVAILABLE");
    }
    if (attached.code === "NOT_ATTACHABLE") {
      return blocked("ALREADY_OPEN");
    }
    return blocked("STATE_CHANGED");
  }

  try {
    if (continuationConsumerTestHooks.afterAttachBeforeInterpret) {
      await continuationConsumerTestHooks.afterAttachBeforeInterpret();
    }

    if (attached.continuationOutcome != null) {
      return await finish(attached.pending, input.source.id, userId, "REPLAY");
    }
    if (!input.payloadUsable || !input.text) {
      return blocked("SOURCE_OPERATIONAL_PAYLOAD_UNAVAILABLE");
    }

    logSafe({
      event: "whatsapp_continuation_started",
      pendingId: attached.pending.id,
      childInboundId: input.source.id,
      stage: attached.pending.stage,
    });

    return await applyInterpreted({
      pending: attached.pending,
      source: input.source,
      text: input.text,
      userId,
    });
  } catch {
    return retry("INTERNAL_FAILURE");
  }
}
