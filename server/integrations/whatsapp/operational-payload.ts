/**
 * Payload operacional temporário do Incremento A.
 *
 * READY_FOR_* significa: há material persistido suficiente para o próximo
 * estágio. Não é dump Twilio. Nunca persiste signature/Auth Token/From.
 *
 * Retenção curta + limpeza após consumo. B2-C TEXT usa o
 * compare-and-clear `clearWhatsAppInboundOperationalPayloadForReadyNl`.
 * Incremento D pode chamar `clearWhatsAppInboundOperationalPayload`
 * depois de obter a mídia.
 */

import { and, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { getDb } from "../../db";
import { whatsappInboundMessages } from "../../../drizzle/schema";
import type { WhatsAppInboundEnvelope } from "./types";
import {
  WHATSAPP_INBOUND_PROVIDER,
  WhatsAppInboundStatuses,
} from "./types";

export const WHATSAPP_INBOUND_PAYLOAD_TTL_MS = 24 * 60 * 60 * 1000;

export type WhatsAppInboundOperationalMaterial = {
  processingStatus: string;
  contentKind: string;
  operationalText: string | null;
  mediaUrl: string | null;
  mediaMime: string | null;
  payloadExpiresAt: Date | null;
  payloadClearedAt: Date | null;
};

export type OperationalPayloadFields = {
  operationalText: string | null;
  mediaUrl: string | null;
  mediaMime: string | null;
  payloadExpiresAt: Date | null;
  payloadClearedAt: Date | null;
};

export function payloadExpiresAtFrom(now: Date = new Date()): Date {
  return new Date(now.getTime() + WHATSAPP_INBOUND_PAYLOAD_TTL_MS);
}

export function operationalPayloadFromEnvelope(
  content: WhatsAppInboundEnvelope["content"],
  now: Date = new Date(),
): OperationalPayloadFields {
  if (content.kind === "TEXT") {
    return {
      operationalText: content.text,
      mediaUrl: null,
      mediaMime: null,
      payloadExpiresAt: payloadExpiresAtFrom(now),
      payloadClearedAt: null,
    };
  }
  if (content.kind === "AUDIO") {
    const safeUrl = isHttpsMediaUrl(content.mediaUrl) ? content.mediaUrl : null;
    return {
      operationalText: null,
      mediaUrl: safeUrl,
      mediaMime: safeUrl ? (content.mimeType ?? null) : null,
      payloadExpiresAt: safeUrl ? payloadExpiresAtFrom(now) : null,
      payloadClearedAt: null,
    };
  }
  return {
    operationalText: null,
    mediaUrl: null,
    mediaMime: null,
    payloadExpiresAt: null,
    payloadClearedAt: null,
  };
}

export function clearedOperationalPayload(
  now: Date = new Date(),
): OperationalPayloadFields {
  return {
    operationalText: null,
    mediaUrl: null,
    mediaMime: null,
    payloadExpiresAt: null,
    payloadClearedAt: now,
  };
}

export function isHttpsMediaUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function hasMaterialForReadyStatus(
  contentKind: string,
  material: Pick<OperationalPayloadFields, "operationalText" | "mediaUrl">,
): boolean {
  if (contentKind === "TEXT") {
    return material.operationalText !== null;
  }
  if (contentKind === "AUDIO") {
    return Boolean(material.mediaUrl && isHttpsMediaUrl(material.mediaUrl));
  }
  return true;
}

/** Incremento B/D: só consumir se ainda não expirou/limpou e o material bate o kind. */
export function isWhatsAppInboundPayloadUsable(
  material: Pick<
    WhatsAppInboundOperationalMaterial,
    | "contentKind"
    | "operationalText"
    | "mediaUrl"
    | "payloadExpiresAt"
    | "payloadClearedAt"
  >,
  now: Date = new Date(),
): boolean {
  if (material.payloadClearedAt) return false;
  if (
    material.payloadExpiresAt &&
    material.payloadExpiresAt.getTime() <= now.getTime()
  ) {
    return false;
  }
  return hasMaterialForReadyStatus(material.contentKind, material);
}

function affectedRows(result: unknown): number {
  if (Array.isArray(result)) {
    return Number(
      (result[0] as { affectedRows?: unknown } | undefined)?.affectedRows ?? 0,
    );
  }
  return Number((result as { affectedRows?: unknown } | null)?.affectedRows ?? 0);
}

export async function readWhatsAppInboundOperationalMaterial(
  id: number,
): Promise<WhatsAppInboundOperationalMaterial | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select({
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
        eq(whatsappInboundMessages.id, id),
        eq(whatsappInboundMessages.provider, WHATSAPP_INBOUND_PROVIDER),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Incremento B/D: limpar após consumir o material do próximo estágio. */
export async function clearWhatsAppInboundOperationalPayload(
  id: number,
): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const now = new Date();
  const result = await db
    .update(whatsappInboundMessages)
    .set(clearedOperationalPayload(now))
    .where(
      and(
        eq(whatsappInboundMessages.id, id),
        eq(whatsappInboundMessages.provider, WHATSAPP_INBOUND_PROVIDER),
        isNull(whatsappInboundMessages.payloadClearedAt),
        inArray(whatsappInboundMessages.processingStatus, [
          WhatsAppInboundStatuses.READY_FOR_NL,
          WhatsAppInboundStatuses.READY_FOR_TRANSCRIPTION,
        ]),
      ),
    );
  return affectedRows(result) > 0;
}

/** Varredura de expiração (job futuro / Incremento B). */
export async function clearExpiredWhatsAppInboundPayloads(
  now: Date = new Date(),
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const result = await db
    .update(whatsappInboundMessages)
    .set(clearedOperationalPayload(now))
    .where(
      and(
        eq(whatsappInboundMessages.provider, WHATSAPP_INBOUND_PROVIDER),
        isNull(whatsappInboundMessages.payloadClearedAt),
        isNotNull(whatsappInboundMessages.payloadExpiresAt),
        lte(whatsappInboundMessages.payloadExpiresAt, now),
      ),
    );
  return affectedRows(result);
}
