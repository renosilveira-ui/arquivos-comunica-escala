import { describe, expect, it } from "vitest";
import {
  SIGNUP_NEUTRAL_RESPONSE_FLOOR_MS,
  signupNeutralResponseDelayMs,
} from "../server/auth-response-timing";
import {
  openAuthRecoveryPayload,
  sealAuthRecoveryPayload,
} from "../server/auth-recovery";

describe("auth lifecycle: contratos puros", () => {
  it("calcula o piso neutro sem sleeps e limita recuo do relógio", () => {
    expect(signupNeutralResponseDelayMs(10_000, 10_000)).toBe(
      SIGNUP_NEUTRAL_RESPONSE_FLOOR_MS,
    );
    expect(signupNeutralResponseDelayMs(10_000, 10_400)).toBe(600);
    expect(signupNeutralResponseDelayMs(10_000, 11_000)).toBe(0);
    expect(signupNeutralResponseDelayMs(10_000, 12_000)).toBe(0);
    expect(signupNeutralResponseDelayMs(10_000, 9_000)).toBe(
      SIGNUP_NEUTRAL_RESPONSE_FLOOR_MS,
    );
  });

  it("sela e recupera payload sem persistir e-mail ou token em claro", () => {
    const payload = {
      email: "pessoa@example.test",
      token: "a".repeat(64),
    };
    const sealed = sealAuthRecoveryPayload(payload);
    expect(sealed).not.toContain(payload.email);
    expect(sealed).not.toContain(payload.token);
    expect(openAuthRecoveryPayload(sealed)).toEqual(payload);
  });

  it("rejeita adulteração autenticada do payload", () => {
    const sealed = sealAuthRecoveryPayload({ email: "pessoa@example.test" });
    const parts = sealed.split(".");
    parts[2] = `${parts[2]![0] === "A" ? "B" : "A"}${parts[2]!.slice(1)}`;
    expect(() => openAuthRecoveryPayload(parts.join("."))).toThrow();
  });
});
