import twilio from "twilio";
import { whatsappFromToE164 } from "./from-address";
import type { WhatsAppInboundParams, WhatsAppProvider } from "./provider";
import type { WhatsAppInboundContent, WhatsAppParseResult } from "./types";

const AUDIO_MIME_PREFIX = "audio/";

function asParam(
  params: WhatsAppInboundParams,
  key: string,
): string {
  const value = params[key];
  return typeof value === "string" ? value.trim() : "";
}

function parseMediaCount(raw: string): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function isForwarded(params: WhatsAppInboundParams): boolean {
  const raw = asParam(params, "Forwarded").toLowerCase();
  return raw === "true" || raw === "1";
}

function classifyContent(params: WhatsAppInboundParams): WhatsAppInboundContent {
  const mediaCount = parseMediaCount(asParam(params, "NumMedia"));
  const mimeType = asParam(params, "MediaContentType0") || undefined;
  const mediaUrl = asParam(params, "MediaUrl0");
  const text = asParam(params, "Body");
  const forwarded = isForwarded(params);

  if (mediaCount > 0) {
    if (mimeType && mimeType.toLowerCase().startsWith(AUDIO_MIME_PREFIX) && mediaUrl) {
      return { kind: "AUDIO", mediaUrl, mimeType };
    }
    return { kind: "UNSUPPORTED_MEDIA", mimeType };
  }
  return { kind: "TEXT", text, forwarded };
}

export class TwilioWhatsAppProvider implements WhatsAppProvider {
  validateInboundRequest(input: {
    signature: string | undefined;
    authToken: string;
    canonicalUrl: string;
    params: WhatsAppInboundParams;
  }): boolean {
    const signature = (input.signature ?? "").trim();
    if (!signature) return false;
    return twilio.validateRequest(
      input.authToken,
      signature,
      input.canonicalUrl,
      input.params,
    );
  }

  parseInboundEnvelope(params: WhatsAppInboundParams): WhatsAppParseResult {
    const providerMessageId = asParam(params, "MessageSid");
    if (!providerMessageId) {
      return { ok: false, code: "TWILIO_MESSAGE_SID_MISSING" };
    }
    const fromE164 = whatsappFromToE164(asParam(params, "From"));
    if (!fromE164) {
      return { ok: false, code: "TWILIO_FROM_INVALID" };
    }
    const toRaw = asParam(params, "To");
    const toE164 = toRaw ? whatsappFromToE164(toRaw) ?? undefined : undefined;
    return {
      ok: true,
      envelope: {
        provider: "TWILIO",
        providerMessageId,
        fromE164,
        toE164,
        content: classifyContent(params),
        receivedAt: new Date(),
      },
    };
  }

  async sendText(
    _toE164: string,
    _body: string,
  ): Promise<{ ok: false; reason: string }> {
    return { ok: false, reason: "Outbound WhatsApp ainda não está disponível." };
  }
}

export const twilioWhatsAppProvider = new TwilioWhatsAppProvider();
