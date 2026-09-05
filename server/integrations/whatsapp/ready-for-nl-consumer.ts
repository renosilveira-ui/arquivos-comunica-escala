/**
 * Consumer B2-C: READY_FOR_NL TEXT autenticado → estado conversacional.
 *
 * Fluxo:
 *   inbound READY_FOR_NL
 *     → create/load pending B1 (só sourceInboundMessageId)
 *     → actor canônico B2-B (userId do inbound/pending)
 *     → parseSwapIntent / resolveSwapIntent (núcleo NL, sem canal)
 *     → classifySwapIntentErrorForConversation + serializers B2-A
 *     → advanceWhatsAppPendingFromParse
 *     → OPEN/CLARIFICATION | OPEN/CONFIRMATION
 *     → clear operational_text
 *     → PARE
 *
 * Não executa swap. Não chama createSwapOffer. Não envia WhatsApp.
 * Não processa AUDIO. Não é route HTTP nem worker: o webhook Twilio
 * continua ACK rápido após persistir o inbound. O driver B2-D
 * (`ready-for-nl-driver.ts`) define QUEM/QUANDO invoca esta primitive.
 *
 * Atomicidade crítica já está em advanceWhatsAppPendingFromParse e
 * cancelWhatsAppPendingOpenParse (OPEN/PARSE → CANCELLED).
 * Cleanup destrutivo do inbound ocorre SOMENTE depois da transição
 * durável comprovada (ou replay que a comprova). Nunca o inverso.
 */
import { logger } from "../../_core/logger";
import { resolveCanonicalOperationalActorForUser } from "../../_core/canonical-operational-actor";
import { parseSwapIntent } from "../../natural-language/swap-intent-parser";
import { resolveSwapIntent } from "../../natural-language/swap-intent-resolver";
import type {
  ShiftCandidate,
  SwapIntentDraft,
  SwapIntentError,
} from "../../natural-language/swap-intent-types";
import {
  projectSectorClarificationFromResolver,
  projectTargetProfessionalClarificationFromResolver,
} from "./ready-for-nl-homonym-projection";
import {
  clearWhatsAppInboundOperationalPayloadForReadyNl,
  isWhatsAppInboundReadyNlClearFailure,
} from "./ready-for-nl-cleanup";
import { loadWhatsAppInboundSourceForReadyNl } from "./ready-for-nl-source";
import type { WhatsAppInboundSourceForNl } from "./ready-for-nl-source";
import type {
  ProcessWhatsAppReadyForNlInboundInput,
  ProcessWhatsAppReadyForNlInboundResult,
  ReadyForNlDurableStage,
  ReadyForNlInfraCode,
} from "./ready-for-nl-types";
import { isWhatsAppInboundPayloadUsable } from "./operational-payload";
import {
  clarificationInvariantsHold,
  confirmationInvariantsHold,
  serializeParsedSwapIntentV1,
  serializeResolvedSwapIntentV1,
  type WhatsAppPendingParseAdvanceOutcome,
} from "./pending-intent-payloads";
import {
  advanceWhatsAppPendingFromParse,
  cancelWhatsAppPendingOpenParse,
  createWhatsAppPendingIntent,
  getWhatsAppPendingIntentBySourceForUser,
} from "./pending-intent-store";
import { classifySwapIntentErrorForConversation } from "./swap-intent-error-classification";
import {
  WhatsAppPendingStages,
  WhatsAppPendingStatuses,
  isWhatsAppPendingTerminalStatus,
  type WhatsAppPendingIntentRecord,
} from "./pending-intent-types";
import {
  WhatsAppInboundStatuses,
  isWhatsAppInboundIncompleteStatus,
} from "./types";

export type {
  ProcessWhatsAppReadyForNlInboundInput,
  ProcessWhatsAppReadyForNlInboundResult,
} from "./ready-for-nl-types";
export { isReadyForNlRetryableInfra } from "./ready-for-nl-types";

type LogCtx = {
  sourceInboundMessageId: number;
  pendingId?: number;
  userId?: number;
  professionalId?: number;
  targetStage?: ReadyForNlDurableStage;
};

function logSafe(payload: Record<string, unknown>): void {
  logger.info(JSON.stringify(payload));
}

function retry(
  code: ReadyForNlInfraCode,
): ProcessWhatsAppReadyForNlInboundResult {
  return { ok: false, kind: "RETRYABLE_INFRA", code };
}

function blocked(
  code: Extract<
    ProcessWhatsAppReadyForNlInboundResult,
    { ok: false; kind: "BLOCKED" }
  >["code"],
  nlCode?: Extract<
    ProcessWhatsAppReadyForNlInboundResult,
    { ok: false; kind: "BLOCKED" }
  >["nlCode"],
): ProcessWhatsAppReadyForNlInboundResult {
  return nlCode
    ? { ok: false, kind: "BLOCKED", code, nlCode }
    : { ok: false, kind: "BLOCKED", code };
}

function isSwapIntentError(
  value: SwapIntentDraft | SwapIntentError,
): value is SwapIntentError {
  return "ok" in value && value.ok === false;
}

function isDurableNlPending(row: WhatsAppPendingIntentRecord): boolean {
  if (row.status !== WhatsAppPendingStatuses.OPEN) return false;
  if (row.stage === WhatsAppPendingStages.CONFIRMATION) {
    return confirmationInvariantsHold(row);
  }
  if (row.stage === WhatsAppPendingStages.CLARIFICATION) {
    return clarificationInvariantsHold(row);
  }
  return false;
}

function durableStageOf(
  row: WhatsAppPendingIntentRecord,
): ReadyForNlDurableStage | null {
  if (row.stage === WhatsAppPendingStages.CLARIFICATION) return "CLARIFICATION";
  if (row.stage === WhatsAppPendingStages.CONFIRMATION) return "CONFIRMATION";
  return null;
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
  const candidates = raw.map((item) => ({
    shiftInstanceId: item.shiftInstanceId,
    label: item.label,
    dayKey: item.dayKey,
    timeRange: item.timeRange,
    sectorName: item.sectorName,
    institutionName: item.institutionName,
  }));
  return { ok: true, candidates };
}

function classifySource(
  source: WhatsAppInboundSourceForNl,
): ProcessWhatsAppReadyForNlInboundResult | null {
  const status = source.processingStatus;
  const kind = source.contentKind;

  if (
    kind === "AUDIO" ||
    status === WhatsAppInboundStatuses.READY_FOR_TRANSCRIPTION ||
    source.mediaUrl != null ||
    source.mediaMime != null
  ) {
    return blocked("SOURCE_NOT_TEXT");
  }
  if (
    status === WhatsAppInboundStatuses.IDENTITY_NOT_FOUND ||
    status === WhatsAppInboundStatuses.IDENTITY_CONFLICT ||
    status === WhatsAppInboundStatuses.UNSUPPORTED
  ) {
    return blocked("SOURCE_TERMINAL");
  }
  if (kind !== "TEXT") {
    return blocked("SOURCE_NOT_TEXT");
  }
  if (status !== WhatsAppInboundStatuses.READY_FOR_NL) {
    if (isWhatsAppInboundIncompleteStatus(status)) {
      return blocked("SOURCE_NOT_READY");
    }
    return blocked("SOURCE_NOT_READY");
  }
  if (source.userId == null) {
    return blocked("SOURCE_IDENTITY_MISSING");
  }
  return null;
}

async function cleanupAfterDurable(input: {
  sourceInboundMessageId: number;
  sourceUserId: number;
  pending: WhatsAppPendingIntentRecord;
  kind: "ADVANCED" | "REPLAY";
}): Promise<ProcessWhatsAppReadyForNlInboundResult> {
  const { pending, sourceInboundMessageId, sourceUserId, kind } = input;
  if (
    pending.userId !== sourceUserId ||
    pending.sourceInboundMessageId !== sourceInboundMessageId
  ) {
    return blocked("OWNERSHIP_MISMATCH");
  }
  if (!isDurableNlPending(pending)) {
    if (isWhatsAppPendingTerminalStatus(pending.status)) {
      return pending.status === WhatsAppPendingStatuses.EXPIRED
        ? blocked("PENDING_EXPIRED")
        : blocked("PENDING_TERMINAL");
    }
    return blocked("STATE_CHANGED");
  }
  const stage = durableStageOf(pending);
  if (!stage) return blocked("STATE_CHANGED");

  const cleared = await clearWhatsAppInboundOperationalPayloadForReadyNl({
    sourceInboundMessageId,
    expectedUserId: sourceUserId,
  });
  if (!isWhatsAppInboundReadyNlClearFailure(cleared)) {
    return { ok: true, kind, stage, pendingId: pending.id };
  }
  if (cleared.code === "STATE_CHANGED") {
    return blocked("STATE_CHANGED");
  }
  return retry(cleared.code);
}

async function persistAndCleanup(input: {
  pending: WhatsAppPendingIntentRecord;
  sourceUserId: number;
  sourceInboundMessageId: number;
  outcome: WhatsAppPendingParseAdvanceOutcome;
  ctx: LogCtx;
}): Promise<ProcessWhatsAppReadyForNlInboundResult> {
  const advanced = await advanceWhatsAppPendingFromParse({
    pendingId: input.pending.id,
    userId: input.sourceUserId,
    expectedSourceInboundMessageId: input.sourceInboundMessageId,
    outcome: input.outcome,
  });

  if (advanced.ok) {
    const row = advanced.row;
    input.ctx.pendingId = row.id;
    input.ctx.targetStage = durableStageOf(row) ?? undefined;
    return cleanupAfterDurable({
      sourceInboundMessageId: input.sourceInboundMessageId,
      sourceUserId: input.sourceUserId,
      pending: row,
      kind: advanced.outcome === "already_advanced" ? "REPLAY" : "ADVANCED",
    });
  }

  if (
    advanced.code === "DB_UNAVAILABLE" ||
    advanced.code === "PERSISTENCE_FAILED"
  ) {
    return retry(advanced.code);
  }
  if (advanced.code === "EXPIRED") {
    return blocked("PENDING_EXPIRED");
  }
  if (advanced.code === "TERMINAL") {
    return blocked("PENDING_TERMINAL");
  }
  if (advanced.code === "INVALID_PAYLOAD") {
    return blocked("INVALID_PAYLOAD");
  }
  if (advanced.code === "NOT_FOUND") {
    return retry("PERSISTENCE_FAILED");
  }

  let latest: WhatsAppPendingIntentRecord | null = advanced.row ?? null;
  if (!latest) {
    const reloaded = await reloadPending(
      input.sourceInboundMessageId,
      input.sourceUserId,
    );
    if (reloaded && "kind" in reloaded) return reloaded;
    latest = reloaded;
  }
  if (!latest) return blocked("STATE_CHANGED");
  if (isDurableNlPending(latest)) {
    return cleanupAfterDurable({
      sourceInboundMessageId: input.sourceInboundMessageId,
      sourceUserId: input.sourceUserId,
      pending: latest,
      kind: "REPLAY",
    });
  }
  return blocked("STATE_CHANGED");
}

async function reloadPending(
  sourceInboundMessageId: number,
  userId: number,
): Promise<
  | WhatsAppPendingIntentRecord
  | null
  | ProcessWhatsAppReadyForNlInboundResult
> {
  const read = await getWhatsAppPendingIntentBySourceForUser(
    sourceInboundMessageId,
    userId,
  );
  if (!read.ok) return retry(read.code);
  return read.row;
}

async function interpretNl(input: {
  pending: WhatsAppPendingIntentRecord;
  source: WhatsAppInboundSourceForNl;
  text: string;
  ctx: LogCtx;
}): Promise<ProcessWhatsAppReadyForNlInboundResult> {
  const userId = input.source.userId;
  if (userId == null || userId !== input.pending.userId) {
    return blocked("OWNERSHIP_MISMATCH");
  }
  if (input.pending.sourceInboundMessageId !== input.source.id) {
    return blocked("OWNERSHIP_MISMATCH");
  }

  const actor = await resolveCanonicalOperationalActorForUser({ userId });
  if (!actor.ok) {
    if (
      actor.code === "DB_UNAVAILABLE" ||
      actor.code === "PERSISTENCE_FAILED"
    ) {
      return retry(actor.code);
    }
    return blocked(actor.code);
  }
  input.ctx.professionalId = actor.actor.professionalId;

  let parsed: SwapIntentDraft | SwapIntentError;
  try {
    parsed = parseSwapIntent(input.text);
  } catch {
    return retry("INTERNAL_FAILURE");
  }

  if (isSwapIntentError(parsed)) {
    return persistFromNlError({
      pending: input.pending,
      sourceUserId: userId,
      sourceInboundMessageId: input.source.id,
      draft: null,
      error: parsed,
      ctx: input.ctx,
    });
  }

  let resolved;
  try {
    resolved = await resolveSwapIntent(parsed, actor.actor);
  } catch {
    return retry("INTERNAL_FAILURE");
  }

  if (!resolved.ok) {
    return persistFromNlError({
      pending: input.pending,
      sourceUserId: userId,
      sourceInboundMessageId: input.source.id,
      draft: parsed,
      error: resolved,
      ctx: input.ctx,
    });
  }

  const parsedV1 = serializeParsedSwapIntentV1(parsed);
  const resolvedV1 = serializeResolvedSwapIntentV1(resolved);
  if (!parsedV1.ok || !resolvedV1.ok) {
    return blocked("INVALID_PAYLOAD");
  }

  input.ctx.targetStage = "CONFIRMATION";
  return persistAndCleanup({
    pending: input.pending,
    sourceUserId: userId,
    sourceInboundMessageId: input.source.id,
    outcome: {
      type: "resolved",
      parsed: parsedV1.value,
      resolved: resolvedV1.value,
    },
    ctx: input.ctx,
  });
}

async function releaseParseSlotForReformulation(input: {
  pending: WhatsAppPendingIntentRecord;
  sourceUserId: number;
  sourceInboundMessageId: number;
  nlCode?: SwapIntentError["code"];
}): Promise<ProcessWhatsAppReadyForNlInboundResult> {
  const cancelled = await cancelWhatsAppPendingOpenParse({
    pendingId: input.pending.id,
    userId: input.sourceUserId,
    expectedSourceInboundMessageId: input.sourceInboundMessageId,
  });
  if (!cancelled.ok) {
    if (
      cancelled.code === "DB_UNAVAILABLE" ||
      cancelled.code === "PERSISTENCE_FAILED"
    ) {
      return retry(cancelled.code);
    }
    if (cancelled.code === "STATE_CHANGED") {
      return blocked("STATE_CHANGED");
    }
    return retry("PERSISTENCE_FAILED");
  }
  return blocked("NEEDS_REFORMULATION", input.nlCode);
}

async function persistFromNlError(input: {
  pending: WhatsAppPendingIntentRecord;
  sourceUserId: number;
  sourceInboundMessageId: number;
  draft: SwapIntentDraft | null;
  error: SwapIntentError;
  ctx: LogCtx;
}): Promise<ProcessWhatsAppReadyForNlInboundResult> {
  const classification = classifySwapIntentErrorForConversation(
    input.error.code,
  );

  if (classification.class === "INTERNAL_FAILURE") {
    return retry("INTERNAL_FAILURE");
  }
  if (classification.class === "NEEDS_REFORMULATION") {
    return releaseParseSlotForReformulation({
      pending: input.pending,
      sourceUserId: input.sourceUserId,
      sourceInboundMessageId: input.sourceInboundMessageId,
      nlCode: input.error.code,
    });
  }
  if (classification.class === "TERMINAL_DOMAIN_CONFLICT") {
    return blocked("TERMINAL_DOMAIN_CONFLICT", input.error.code);
  }

  const outcome = await clarificationOutcomeFromError(input.draft, input.error);
  if (!outcome.ok) {
    return outcome.result;
  }

  input.ctx.targetStage = "CLARIFICATION";
  return persistAndCleanup({
    pending: input.pending,
    sourceUserId: input.sourceUserId,
    sourceInboundMessageId: input.sourceInboundMessageId,
    outcome: outcome.outcome,
    ctx: input.ctx,
  });
}

async function clarificationOutcomeFromError(
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

  if (!draft) {
    return { ok: false, result: blocked("INVALID_PAYLOAD") };
  }
  const parsedV1 = serializeParsedSwapIntentV1(draft);
  if (!parsedV1.ok) {
    return { ok: false, result: blocked("INVALID_PAYLOAD") };
  }

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
    if (!shifts.ok) {
      return { ok: false, result: blocked("INVALID_PAYLOAD") };
    }
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

async function handleExistingPending(input: {
  pending: WhatsAppPendingIntentRecord;
  source: WhatsAppInboundSourceForNl;
  payloadUsable: boolean;
  text: string;
  ctx: LogCtx;
}): Promise<ProcessWhatsAppReadyForNlInboundResult> {
  const sourceUserId = input.source.userId;
  if (sourceUserId == null) return blocked("SOURCE_IDENTITY_MISSING");
  input.ctx.pendingId = input.pending.id;
  input.ctx.userId = sourceUserId;

  if (
    input.pending.userId !== sourceUserId ||
    input.pending.sourceInboundMessageId !== input.source.id
  ) {
    return blocked("OWNERSHIP_MISMATCH");
  }

  if (isDurableNlPending(input.pending)) {
    return cleanupAfterDurable({
      sourceInboundMessageId: input.source.id,
      sourceUserId,
      pending: input.pending,
      kind: "REPLAY",
    });
  }

  if (isWhatsAppPendingTerminalStatus(input.pending.status)) {
    return input.pending.status === WhatsAppPendingStatuses.EXPIRED
      ? blocked("PENDING_EXPIRED")
      : blocked("PENDING_TERMINAL");
  }

  if (
    input.pending.status !== WhatsAppPendingStatuses.OPEN ||
    input.pending.stage !== WhatsAppPendingStages.PARSE
  ) {
    return blocked("STATE_CHANGED");
  }

  if (!input.payloadUsable) {
    return blocked("SOURCE_OPERATIONAL_PAYLOAD_UNAVAILABLE");
  }
  if (!input.text) {
    return releaseParseSlotForReformulation({
      pending: input.pending,
      sourceUserId,
      sourceInboundMessageId: input.source.id,
      nlCode: "UNSUPPORTED_INTENT",
    });
  }

  return interpretNl({
    pending: input.pending,
    source: input.source,
    text: input.text,
    ctx: input.ctx,
  });
}

/**
 * Interpreta TEXT inbound já autenticado em READY_FOR_NL.
 * Input: somente o id do inbound. Identidade, texto e tenant nascem das
 * autoridades persistidas — o caller não pode overridá-los.
 */
export async function processWhatsAppReadyForNlInbound(
  input: ProcessWhatsAppReadyForNlInboundInput,
): Promise<ProcessWhatsAppReadyForNlInboundResult> {
  const startedAt = Date.now();
  const sourceInboundMessageId = input.sourceInboundMessageId;
  const ctx: LogCtx = { sourceInboundMessageId };
  const result = await run(sourceInboundMessageId, ctx);
  logSafe({
    event: "whatsapp_ready_for_nl_processed",
    sourceInboundMessageId,
    pendingId: ctx.pendingId ?? null,
    userId: ctx.userId ?? null,
    professionalId: ctx.professionalId ?? null,
    resultKind: result.kind,
    resultCode: result.ok ? result.stage : result.code,
    nlCode:
      !result.ok && result.kind === "BLOCKED" ? (result.nlCode ?? null) : null,
    targetStage: ctx.targetStage ?? (result.ok ? result.stage : null),
    durationMs: Date.now() - startedAt,
  });
  return result;
}

async function run(
  sourceInboundMessageId: number,
  ctx: LogCtx,
): Promise<ProcessWhatsAppReadyForNlInboundResult> {
  const loaded = await loadWhatsAppInboundSourceForReadyNl(
    sourceInboundMessageId,
  );
  if (!loaded.ok) {
    if (loaded.code === "SOURCE_NOT_FOUND") return blocked("SOURCE_NOT_FOUND");
    return retry(loaded.code);
  }
  const source = loaded.source;
  if (source.userId != null) ctx.userId = source.userId;

  const sourceGate = classifySource(source);
  if (sourceGate) return sourceGate;

  const sourceUserId = source.userId;
  if (sourceUserId == null) return blocked("SOURCE_IDENTITY_MISSING");

  const payloadUsable = isWhatsAppInboundPayloadUsable(source);
  const text = (source.operationalText ?? "").trim();

  if (!payloadUsable) {
    const existing = await getWhatsAppPendingIntentBySourceForUser(
      sourceInboundMessageId,
      sourceUserId,
    );
    if (!existing.ok) return retry(existing.code);
    if (existing.row) {
      return handleExistingPending({
        pending: existing.row,
        source,
        payloadUsable: false,
        text,
        ctx,
      });
    }
    return blocked("SOURCE_OPERATIONAL_PAYLOAD_UNAVAILABLE");
  }

  const created = await createWhatsAppPendingIntent({
    sourceInboundMessageId,
  });
  if (!created.ok) {
    if (
      created.code === "DB_UNAVAILABLE" ||
      created.code === "PERSISTENCE_FAILED"
    ) {
      return retry(created.code);
    }
    if (created.code === "SOURCE_INBOUND_NOT_FOUND") {
      return blocked("SOURCE_NOT_FOUND");
    }
    if (created.code === "SOURCE_INBOUND_NOT_READY") {
      return blocked("SOURCE_NOT_READY");
    }
    if (created.code === "SOURCE_INBOUND_IDENTITY_MISSING") {
      return blocked("SOURCE_IDENTITY_MISSING");
    }
    return retry("PERSISTENCE_FAILED");
  }

  ctx.pendingId = created.row.id;
  ctx.userId = created.row.userId;

  if (created.outcome === "already_open") {
    return blocked("ALREADY_OPEN");
  }
  if (created.outcome === "already_terminal") {
    return created.row.status === WhatsAppPendingStatuses.EXPIRED
      ? blocked("PENDING_EXPIRED")
      : blocked("PENDING_TERMINAL");
  }

  return handleExistingPending({
    pending: created.row,
    source,
    payloadUsable: true,
    text,
    ctx,
  });
}
