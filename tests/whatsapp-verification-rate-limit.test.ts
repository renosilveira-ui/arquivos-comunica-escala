import { afterEach, describe, expect, it } from "vitest";
import {
  consumeWhatsAppVerifyRateLimit,
  resetWhatsAppVerifyRateLimits,
  WHATSAPP_VERIFY_CHECK_USER_LIMIT,
  WHATSAPP_VERIFY_START_USER_LIMIT,
} from "../server/whatsapp-verification-rate-limit";

describe("WhatsApp Verify rate limit", () => {
  afterEach(() => {
    resetWhatsAppVerifyRateLimits();
  });

  it("permite até o limite e depois bloqueia", () => {
    const key = "start:user:1";
    for (let i = 0; i < WHATSAPP_VERIFY_START_USER_LIMIT; i++) {
      expect(
        consumeWhatsAppVerifyRateLimit({ key, limit: WHATSAPP_VERIFY_START_USER_LIMIT }),
      ).toEqual({ limited: false });
    }
    const blocked = consumeWhatsAppVerifyRateLimit({
      key,
      limit: WHATSAPP_VERIFY_START_USER_LIMIT,
    });
    expect(blocked.limited).toBe(true);
    if (blocked.limited) expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("chaves distintas não compartilham cota", () => {
    consumeWhatsAppVerifyRateLimit({ key: "a", limit: 1 });
    expect(consumeWhatsAppVerifyRateLimit({ key: "a", limit: 1 }).limited).toBe(
      true,
    );
    expect(consumeWhatsAppVerifyRateLimit({ key: "b", limit: 1 }).limited).toBe(
      false,
    );
  });

  it("check tem cota própria", () => {
    const key = "check:user:1";
    for (let i = 0; i < WHATSAPP_VERIFY_CHECK_USER_LIMIT; i++) {
      expect(
        consumeWhatsAppVerifyRateLimit({
          key,
          limit: WHATSAPP_VERIFY_CHECK_USER_LIMIT,
        }).limited,
      ).toBe(false);
    }
    expect(
      consumeWhatsAppVerifyRateLimit({
        key,
        limit: WHATSAPP_VERIFY_CHECK_USER_LIMIT,
      }).limited,
    ).toBe(true);
  });
});
