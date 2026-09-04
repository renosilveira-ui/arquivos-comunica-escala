import { WHATSAPP_PENDING_INTENT_TTL_MS } from "./pending-intent-types";

const FORBIDDEN_SLOT_KEYS =
  /^(id|phone|e164|from|telefone|body|signature|authToken|token|mediaUrl|media_url|normalizedAddress)$/i;

export function assertSemanticParsedPayload(
  value: unknown,
  path = "$",
): asserts value is Record<string, unknown> | null {
  if (value == null) return;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PARSED_PAYLOAD_INVALID");
  }
  walkSlots(value as Record<string, unknown>, path);
}

function walkSlots(value: unknown, path: string): void {
  if (value == null) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkSlots(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/Id$/.test(key) || /_id$/i.test(key) || FORBIDDEN_SLOT_KEYS.test(key)) {
      throw new Error("PARSED_PAYLOAD_INVALID");
    }
    walkSlots(nested, `${path}.${key}`);
  }
}

export function pendingExpiresAtFrom(now: Date = new Date()): Date {
  return new Date(now.getTime() + WHATSAPP_PENDING_INTENT_TTL_MS);
}
