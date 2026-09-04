import { resolveTrustedPublicBaseUrl } from "../../_core/public-url";
import { WHATSAPP_INBOUND_PATH } from "./types";

export type CanonicalWebhookUrlResult =
  | { ok: true; url: string }
  | { ok: false; code: "TWILIO_SIGNATURE_CANONICAL_URL_UNRESOLVED" };

/**
 * URL usada na assinatura Twilio. Nunca deriva de Host / X-Forwarded-*.
 */
export function resolveTwilioWhatsAppCanonicalUrl(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CanonicalWebhookUrlResult {
  const base = resolveTrustedPublicBaseUrl(env);
  if (!base) {
    return { ok: false, code: "TWILIO_SIGNATURE_CANONICAL_URL_UNRESOLVED" };
  }
  return { ok: true, url: `${base}${WHATSAPP_INBOUND_PATH}` };
}

export function readTwilioAuthToken(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const token = (env.TWILIO_AUTH_TOKEN ?? "").trim();
  return token.length > 0 ? token : null;
}
