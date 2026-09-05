/**
 * Compare-and-clear atômico do payload inbound para o consumer B2-C.
 *
 * A autoridade (owner, READY_FOR_NL, TEXT, ainda não limpo) entra no
 * UPDATE — não é comprovada só em memória antes de um DELETE/UPDATE
 * frouxo por id. O caller não envia texto/payload; só id + expectedUserId.
 *
 * Zero rows → reload fail-closed. Nunca um segundo UPDATE mais permissivo.
 * Sem schema novo.
 */
import { and, eq, isNull } from "drizzle-orm";
import { whatsappInboundMessages } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { logger } from "../../_core/logger";
import { clearedOperationalPayload } from "./operational-payload";
import { loadWhatsAppInboundSourceForReadyNl } from "./ready-for-nl-source";
import {
  WHATSAPP_INBOUND_PROVIDER,
  WhatsAppInboundStatuses,
} from "./types";

const CONTENT_KIND_TEXT = "TEXT" as const;

export type ClearWhatsAppInboundOperationalPayloadForReadyNlInput = {
  sourceInboundMessageId: number;
  expectedUserId: number;
};

export type WhatsAppInboundReadyNlClearResult =
  | { ok: true; outcome: "cleared" }
  | { ok: true; outcome: "already_cleared" }
  | {
      ok: false;
      code: "STATE_CHANGED" | "DB_UNAVAILABLE" | "PERSISTENCE_FAILED";
    };

export function isWhatsAppInboundReadyNlClearFailure(
  result: WhatsAppInboundReadyNlClearResult,
): result is Extract<WhatsAppInboundReadyNlClearResult, { ok: false }> {
  return result.ok === false;
}

function affectedRows(result: unknown): number {
  if (Array.isArray(result)) {
    return Number(
      (result[0] as { affectedRows?: unknown } | undefined)?.affectedRows ?? 0,
    );
  }
  return Number((result as { affectedRows?: unknown } | null)?.affectedRows ?? 0);
}

function logSafe(payload: Record<string, unknown>): void {
  logger.info(JSON.stringify(payload));
}

function fail(
  sourceInboundMessageId: number,
  expectedUserId: number,
  code: Extract<WhatsAppInboundReadyNlClearResult, { ok: false }>["code"],
  extra: Record<string, unknown> = {},
): WhatsAppInboundReadyNlClearResult {
  logSafe({
    event:
      code === "STATE_CHANGED"
        ? "whatsapp_inbound_ready_nl_clear_miss"
        : "whatsapp_inbound_ready_nl_clear_failed",
    sourceInboundMessageId,
    expectedUserId,
    code,
    ...extra,
  });
  return { ok: false, code };
}

/**
 * Limpa operational_text do inbound TEXT READY_FOR_NL se, atomicamente,
 * o row ainda for do expectedUserId, TWILIO, e ainda não tiver sido limpo.
 */
export async function clearWhatsAppInboundOperationalPayloadForReadyNl(
  input: ClearWhatsAppInboundOperationalPayloadForReadyNlInput,
): Promise<WhatsAppInboundReadyNlClearResult> {
  const { sourceInboundMessageId, expectedUserId } = input;

  let db;
  try {
    db = await getDb();
  } catch {
    return fail(sourceInboundMessageId, expectedUserId, "PERSISTENCE_FAILED");
  }
  if (!db) {
    return fail(sourceInboundMessageId, expectedUserId, "DB_UNAVAILABLE");
  }

  try {
    const result = await db
      .update(whatsappInboundMessages)
      .set(clearedOperationalPayload(new Date()))
      .where(
        and(
          eq(whatsappInboundMessages.id, sourceInboundMessageId),
          eq(whatsappInboundMessages.provider, WHATSAPP_INBOUND_PROVIDER),
          eq(whatsappInboundMessages.userId, expectedUserId),
          eq(
            whatsappInboundMessages.processingStatus,
            WhatsAppInboundStatuses.READY_FOR_NL,
          ),
          eq(whatsappInboundMessages.contentKind, CONTENT_KIND_TEXT),
          isNull(whatsappInboundMessages.payloadClearedAt),
        ),
      );

    if (affectedRows(result) > 0) {
      logSafe({
        event: "whatsapp_inbound_ready_nl_cleared",
        sourceInboundMessageId,
        expectedUserId,
        outcome: "cleared",
      });
      return { ok: true, outcome: "cleared" };
    }
  } catch {
    return fail(sourceInboundMessageId, expectedUserId, "PERSISTENCE_FAILED");
  }

  const reload = await loadWhatsAppInboundSourceForReadyNl(
    sourceInboundMessageId,
  );
  if (!reload.ok) {
    if (reload.code === "SOURCE_NOT_FOUND") {
      return fail(sourceInboundMessageId, expectedUserId, "STATE_CHANGED");
    }
    return fail(sourceInboundMessageId, expectedUserId, reload.code);
  }

  const source = reload.source;
  const sameOwner = source.userId === expectedUserId;
  const sameReadyText =
    source.processingStatus === WhatsAppInboundStatuses.READY_FOR_NL &&
    source.contentKind === CONTENT_KIND_TEXT;
  const alreadyConsumed =
    source.operationalText == null || source.payloadClearedAt != null;

  if (sameOwner && sameReadyText && alreadyConsumed) {
    logSafe({
      event: "whatsapp_inbound_ready_nl_cleared",
      sourceInboundMessageId,
      expectedUserId,
      outcome: "already_cleared",
    });
    return { ok: true, outcome: "already_cleared" };
  }

  return fail(sourceInboundMessageId, expectedUserId, "STATE_CHANGED", {
    sameOwner,
    processingStatus: source.processingStatus,
    contentKind: source.contentKind,
    payloadCleared: source.payloadClearedAt != null,
    hasOperationalText: source.operationalText != null,
  });
}
