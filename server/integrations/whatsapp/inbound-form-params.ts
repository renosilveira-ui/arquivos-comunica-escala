import type { WhatsAppInboundParams } from "./provider";

/**
 * Chaves de formulário Twilio inbound (MessageSid, MediaUrl0, NumMedia…).
 * Sem underscore — bloqueia `__proto__`. `constructor`/`prototype` passam
 * no charset alfanumérico e são recusados à parte.
 *
 * Sem este filtro, copiar `req.body` para um objeto é property injection
 * (CodeQL js/remote-property-injection): a chave vem do cliente.
 */
const TWILIO_INBOUND_FORM_KEY = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

export function isTwilioInboundFormKey(key: string): boolean {
  if (key === "constructor" || key === "prototype") return false;
  return TWILIO_INBOUND_FORM_KEY.test(key);
}

export function formParamsFromBody(body: unknown): WhatsAppInboundParams {
  if (!body || typeof body !== "object") {
    return Object.create(null) as WhatsAppInboundParams;
  }
  const params = Object.create(null) as WhatsAppInboundParams;
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    // Regex inline: sanitizer local para CodeQL js/remote-property-injection.
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key)) continue;
    if (!isTwilioInboundFormKey(key)) continue;
    if (typeof value === "string") {
      params[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      // qs/urlencoded pode coercer NumMedia etc.; a assinatura Twilio usa string.
      params[key] = String(value);
    }
  }
  return params;
}
