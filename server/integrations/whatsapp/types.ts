/**
 * Tipos canônicos do canal WhatsApp — independentes do SDK Twilio.
 * Nenhum ID interno do Escala+ (userId, institutionId, shift…) vive no envelope.
 */

export const WHATSAPP_INBOUND_PATH = "/api/integrations/twilio/whatsapp";

export type WhatsAppInboundContentKind =
  | "TEXT"
  | "AUDIO"
  | "UNSUPPORTED_MEDIA";

export const WhatsAppInboundStatuses = {
  RECEIVED: "RECEIVED",
  IDENTIFIED: "IDENTIFIED",
  IDENTITY_NOT_FOUND: "IDENTITY_NOT_FOUND",
  IDENTITY_CONFLICT: "IDENTITY_CONFLICT",
  UNSUPPORTED: "UNSUPPORTED",
  READY_FOR_NL: "READY_FOR_NL",
  READY_FOR_TRANSCRIPTION: "READY_FOR_TRANSCRIPTION",
  FAILED: "FAILED",
} as const;
export type WhatsAppInboundStatus =
  (typeof WhatsAppInboundStatuses)[keyof typeof WhatsAppInboundStatuses];

export type WhatsAppInboundErrorCode =
  | "TWILIO_WEBHOOK_NOT_CONFIGURED"
  | "TWILIO_SIGNATURE_CANONICAL_URL_UNRESOLVED"
  | "TWILIO_SIGNATURE_MISSING"
  | "TWILIO_SIGNATURE_INVALID"
  | "TWILIO_MESSAGE_SID_MISSING"
  | "TWILIO_FROM_INVALID"
  | "IDENTITY_NOT_FOUND"
  | "IDENTITY_CONFLICT"
  | "UNSUPPORTED_MEDIA";

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
      code: "IDENTITY_NOT_FOUND" | "IDENTITY_CONFLICT";
    };
