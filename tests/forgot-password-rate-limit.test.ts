import { describe, expect, it } from "vitest";
import {
  FORGOT_PASSWORD_RATE_LIMIT_CAPACITY,
  ForgotPasswordRateLimitCache,
} from "../server/forgot-password-rate-limit";

describe("forgot password rate limit: TTL/LRU limitado", () => {
  it("preserva três pedidos por chave na janela deslizante", () => {
    const hour = 60 * 60 * 1_000;
    const cache = new ForgotPasswordRateLimitCache(3, hour);

    expect(cache.checkAndRecord("user@example.test", 0)).toBe(false);
    expect(cache.checkAndRecord("user@example.test", 1)).toBe(false);
    expect(cache.checkAndRecord("user@example.test", 2)).toBe(false);
    expect(cache.checkAndRecord("user@example.test", 3)).toBe(true);

    // O primeiro timestamp vence; a quarta tentativa volta a ser admitida.
    expect(cache.checkAndRecord("user@example.test", hour)).toBe(false);
    expect(cache.size).toBe(1);
  });

  it("nunca excede 5000 chaves e preserva a chave recentemente tocada", () => {
    const cache = new ForgotPasswordRateLimitCache(
      3,
      60 * 60 * 1_000,
      FORGOT_PASSWORD_RATE_LIMIT_CAPACITY,
    );

    for (let index = 0; index < FORGOT_PASSWORD_RATE_LIMIT_CAPACITY; index += 1) {
      expect(cache.checkAndRecord(`user-${index}@example.test`, 1_000)).toBe(
        false,
      );
      expect(cache.size).toBeLessThanOrEqual(
        FORGOT_PASSWORD_RATE_LIMIT_CAPACITY,
      );
    }

    // user-0 deixa de ser LRU; a inserção seguinte remove user-1.
    expect(cache.checkAndRecord("user-0@example.test", 1_001)).toBe(false);
    expect(cache.checkAndRecord("user-5000@example.test", 1_002)).toBe(false);

    expect(cache.size).toBe(FORGOT_PASSWORD_RATE_LIMIT_CAPACITY);
    expect(cache.has("user-0@example.test")).toBe(true);
    expect(cache.has("user-1@example.test")).toBe(false);
    expect(cache.has("user-5000@example.test")).toBe(true);
  });

  it("expira a chave acessada sem afetar uma chave recente", () => {
    const cache = new ForgotPasswordRateLimitCache(1, 100, 2);
    expect(cache.checkAndRecord("expired", 0)).toBe(false);
    expect(cache.checkAndRecord("recent", 99)).toBe(false);

    expect(cache.checkAndRecord("expired", 100)).toBe(false);
    expect(cache.size).toBe(2);
    expect(cache.has("recent")).toBe(true);
    expect(cache.checkAndRecord("recent", 100)).toBe(true);
  });
});
