/**
 * Leitura fail-closed do inbound para o consumer B2-C.
 *
 * Distingue ausência de row de outage de DB. Inclui userId — a identidade
 * nasce do inbound identificado, nunca do caller.
 *
 * Não limpa payload. Não cria pending. Sem schema novo.
 */
import { and, eq } from "drizzle-orm";
import { whatsappInboundMessages } from "../../../drizzle/schema";
import { getDb } from "../../db";
import { logger } from "../../_core/logger";
import { WHATSAPP_INBOUND_PROVIDER } from "./types";

export type WhatsAppInboundSourceForNl = {
  id: number;
  userId: number | null;
  processingStatus: string;
  contentKind: string;
  operationalText: string | null;
  mediaUrl: string | null;
  mediaMime: string | null;
  payloadExpiresAt: Date | null;
  payloadClearedAt: Date | null;
};

export type WhatsAppInboundSourceLoadResult =
  | { ok: true; source: WhatsAppInboundSourceForNl }
  | {
      ok: false;
      code: "DB_UNAVAILABLE" | "SOURCE_NOT_FOUND" | "PERSISTENCE_FAILED";
    };

function logSafe(payload: Record<string, unknown>): void {
  logger.info(JSON.stringify(payload));
}

export async function loadWhatsAppInboundSourceForReadyNl(
  sourceInboundMessageId: number,
): Promise<WhatsAppInboundSourceLoadResult> {
  let db;
  try {
    db = await getDb();
  } catch {
    logSafe({
      event: "whatsapp_ready_for_nl_source_failed",
      sourceInboundMessageId,
      code: "PERSISTENCE_FAILED",
    });
    return { ok: false, code: "PERSISTENCE_FAILED" };
  }
  if (!db) {
    logSafe({
      event: "whatsapp_ready_for_nl_source_unavailable",
      sourceInboundMessageId,
      code: "DB_UNAVAILABLE",
    });
    return { ok: false, code: "DB_UNAVAILABLE" };
  }

  try {
    const rows = await db
      .select({
        id: whatsappInboundMessages.id,
        userId: whatsappInboundMessages.userId,
        processingStatus: whatsappInboundMessages.processingStatus,
        contentKind: whatsappInboundMessages.contentKind,
        operationalText: whatsappInboundMessages.operationalText,
        mediaUrl: whatsappInboundMessages.mediaUrl,
        mediaMime: whatsappInboundMessages.mediaMime,
        payloadExpiresAt: whatsappInboundMessages.payloadExpiresAt,
        payloadClearedAt: whatsappInboundMessages.payloadClearedAt,
      })
      .from(whatsappInboundMessages)
      .where(
        and(
          eq(whatsappInboundMessages.id, sourceInboundMessageId),
          eq(whatsappInboundMessages.provider, WHATSAPP_INBOUND_PROVIDER),
        ),
      )
      .limit(1);
    const source = rows[0];
    if (!source) {
      return { ok: false, code: "SOURCE_NOT_FOUND" };
    }
    return { ok: true, source };
  } catch {
    logSafe({
      event: "whatsapp_ready_for_nl_source_failed",
      sourceInboundMessageId,
      code: "PERSISTENCE_FAILED",
    });
    return { ok: false, code: "PERSISTENCE_FAILED" };
  }
}
