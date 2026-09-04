import { normalizeToE164 } from "../../../lib/phone-e164";

const WHATSAPP_CHANNEL_PREFIX = "whatsapp:";

/**
 * Remove o prefixo de canal Twilio de forma explícita (não é replace global).
 * From inbound WhatsApp chega como `whatsapp:+5585…`. Sem o prefixo, fail-closed
 * — um From de SMS/voz não vira identidade WhatsApp.
 */
export function stripWhatsAppChannelPrefix(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length <= WHATSAPP_CHANNEL_PREFIX.length) return null;
  if (
    trimmed.slice(0, WHATSAPP_CHANNEL_PREFIX.length).toLowerCase() !==
    WHATSAPP_CHANNEL_PREFIX
  ) {
    return null;
  }
  const rest = trimmed.slice(WHATSAPP_CHANNEL_PREFIX.length).trim();
  return rest.length > 0 ? rest : null;
}

export function whatsappFromToE164(raw: string): string | null {
  const stripped = stripWhatsAppChannelPrefix(raw);
  if (!stripped) return null;
  const normalized = normalizeToE164(stripped);
  return normalized.ok ? normalized.e164 : null;
}
