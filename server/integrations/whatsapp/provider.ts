import type { WhatsAppInboundEnvelope, WhatsAppParseResult } from "./types";

/**
 * Transporte WhatsApp. O domínio não importa o SDK Twilio.
 * Outbound real (sendText) fica para incremento posterior — só o contrato.
 */
export type WhatsAppInboundParams = Record<string, string>;

export interface WhatsAppProvider {
  validateInboundRequest(input: {
    signature: string | undefined;
    authToken: string;
    canonicalUrl: string;
    params: WhatsAppInboundParams;
  }): boolean;
  parseInboundEnvelope(params: WhatsAppInboundParams): WhatsAppParseResult;
  sendText(_toE164: string, _body: string): Promise<{ ok: false; reason: string }>;
}

export type { WhatsAppInboundEnvelope };
