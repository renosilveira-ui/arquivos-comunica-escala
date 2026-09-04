/**
 * Tipos canônicos do canal WhatsApp — independentes do SDK Twilio.
 * Nenhum ID interno do Escala+ (userId, institutionId, shift…) vive no envelope.
 */

export const WHATSAPP_INBOUND_PATH = "/api/integrations/twilio/whatsapp";
export const WHATSAPP_INBOUND_PROVIDER = "TWILIO" as const;

export type WhatsAppInboundContentKind =
  | "TEXT"
  | "AUDIO"
  | "UNSUPPORTED_MEDIA";

/**
 * RECEIVED / IDENTIFIED / RETRYABLE = incompletos (retomáveis).
 * Os demais abaixo são terminais (replay 200 / no-op).
 */
export const WhatsAppInboundStatuses = {
  RECEIVED: "RECEIVED",
  IDENTIFIED: "IDENTIFIED",
  RETRYABLE: "RETRYABLE",
  IDENTITY_NOT_FOUND: "IDENTITY_NOT_FOUND",
  IDENTITY_CONFLICT: "IDENTITY_CONFLICT",
  UNSUPPORTED: "UNSUPPORTED",
  READY_FOR_NL: "READY_FOR_NL",
  READY_FOR_TRANSCRIPTION: "READY_FOR_TRANSCRIPTION",
} as const;
export type WhatsAppInboundStatus =
  (typeof WhatsAppInboundStatuses)[keyof typeof WhatsAppInboundStatuses];

export const WHATSAPP_INBOUND_TERMINAL_STATUSES = [
  WhatsAppInboundStatuses.IDENTITY_NOT_FOUND,
  WhatsAppInboundStatuses.IDENTITY_CONFLICT,
  WhatsAppInboundStatuses.UNSUPPORTED,
  WhatsAppInboundStatuses.READY_FOR_NL,
  WhatsAppInboundStatuses.READY_FOR_TRANSCRIPTION,
] as const;

export const WHATSAPP_INBOUND_INCOMPLETE_STATUSES = [
  WhatsAppInboundStatuses.RECEIVED,
  WhatsAppInboundStatuses.IDENTIFIED,
  WhatsAppInboundStatuses.RETRYABLE,
] as const;

export function isWhatsAppInboundTerminalStatus(
  status: string,
): status is (typeof WHATSAPP_INBOUND_TERMINAL_STATUSES)[number] {
  return (WHATSAPP_INBOUND_TERMINAL_STATUSES as readonly string[]).includes(
    status,
  );
}

export function isWhatsAppInboundIncompleteStatus(
  status: string,
): status is (typeof WHATSAPP_INBOUND_INCOMPLETE_STATUSES)[number] {
  return (WHATSAPP_INBOUND_INCOMPLETE_STATUSES as readonly string[]).includes(
    status,
  );
}

export type WhatsAppInboundErrorCode =
  | "TWILIO_WEBHOOK_NOT_CONFIGURED"
  | "TWILIO_SIGNATURE_CANONICAL_URL_UNRESOLVED"
  | "TWILIO_SIGNATURE_MISSING"
  | "TWILIO_SIGNATURE_INVALID"
  | "TWILIO_MESSAGE_SID_MISSING"
  | "TWILIO_FROM_INVALID"
  | "IDENTITY_NOT_FOUND"
  | "IDENTITY_CONFLICT"
  | "UNSUPPORTED_MEDIA"
  | "DB_UNAVAILABLE"
  | "IDENTITY_QUERY_FAILED"
  | "PERSISTENCE_FAILED"
  | "INTERNAL_TRANSIENT";

export type WhatsAppInboundContent =
  | { kind: "TEXT"; text: string; forwarded: boolean }
  | { kind: "AUDIO"; mediaUrl: string; mimeType?: string }
  | { kind: "UNSUPPORTED_MEDIA"; mimeType?: string };

export type WhatsAppInboundEnvelope = {
  provider: "TWILIO";
  providerMessageId: string;
  fromE164: string;
  toE164?: string;
  content: WhatsAppInboundContent;
  receivedAt: Date;
};

export type WhatsAppParseResult =
  | { ok: true; envelope: WhatsAppInboundEnvelope }
  | { ok: false; code: WhatsAppInboundErrorCode };

export type WhatsAppIdentityResult =
  | { ok: true; userId: number }
  | {
      ok: false;
      retryable?: false;
      code: "IDENTITY_NOT_FOUND" | "IDENTITY_CONFLICT";
    }
  | {
      ok: false;
      retryable: true;
      code: "DB_UNAVAILABLE" | "IDENTITY_QUERY_FAILED";
    };

export function isRetryableWhatsAppIdentity(
  result: WhatsAppIdentityResult,
): result is {
  ok: false;
  retryable: true;
  code: "DB_UNAVAILABLE" | "IDENTITY_QUERY_FAILED";
} {
  return !result.ok && result.retryable === true;
}
