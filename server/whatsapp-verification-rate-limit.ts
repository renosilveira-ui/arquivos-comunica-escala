/**
 * Rate limit in-process para start/check de Twilio Verify.
 * Complementa (não substitui) os limites do próprio Verify (60202/60203/60003)
 * nem o global Express (200/min/IP).
 *
 * Política L2:
 * - start: 5/user/15min e 20/IP/15min (custo Twilio + OTP spam)
 * - check: 8/user/15min e 40/IP/15min (brute-force do OTP)
 * Por replica de processo; Twilio permanece autoridade do OTP.
 */
export const WHATSAPP_VERIFY_START_USER_LIMIT = 5;
export const WHATSAPP_VERIFY_CHECK_USER_LIMIT = 8;
export const WHATSAPP_VERIFY_START_IP_LIMIT = 20;
export const WHATSAPP_VERIFY_CHECK_IP_LIMIT = 40;
export const WHATSAPP_VERIFY_WINDOW_MS = 15 * 60 * 1000;

const attempts = new Map<string, number[]>();

export type WhatsAppVerifyRateLimitResult =
  | { limited: false }
  | { limited: true; retryAfterSeconds: number };

export function resetWhatsAppVerifyRateLimits(): void {
  attempts.clear();
}

export function consumeWhatsAppVerifyRateLimit(input: {
  key: string;
  limit: number;
  windowMs?: number;
  now?: number;
}): WhatsAppVerifyRateLimitResult {
  const now = input.now ?? Date.now();
  const windowMs = input.windowMs ?? WHATSAPP_VERIFY_WINDOW_MS;
  const recent = (attempts.get(input.key) ?? []).filter(
    (ts) => now - ts < windowMs,
  );
  if (recent.length >= input.limit) {
    attempts.set(input.key, recent);
    const oldest = recent[0] ?? now;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((oldest + windowMs - now) / 1000),
    );
    return { limited: true, retryAfterSeconds };
  }
  recent.push(now);
  attempts.set(input.key, recent);
  if (attempts.size > 8000) {
    for (const [key, stamps] of attempts) {
      if (!stamps.some((ts) => now - ts < windowMs)) {
        attempts.delete(key);
      }
    }
  }
  return { limited: false };
}

export function whatsappVerifyStartUserKey(userId: number): string {
  return `start:user:${userId}`;
}

export function whatsappVerifyCheckUserKey(userId: number): string {
  return `check:user:${userId}`;
}

export function whatsappVerifyStartIpKey(ip: string): string {
  return `start:ip:${ip}`;
}

export function whatsappVerifyCheckIpKey(ip: string): string {
  return `check:ip:${ip}`;
}
