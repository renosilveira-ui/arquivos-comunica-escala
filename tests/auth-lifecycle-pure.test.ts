import { describe, expect, it } from "vitest";
import {
  SIGNUP_NEUTRAL_RESPONSE_FLOOR_MS,
  signupNeutralResponseDelayMs,
} from "../server/auth-response-timing";
import {
  authRecoveryEncryptionKeyRing,
  openAuthRecoveryPayload,
  sealAuthRecoveryPayload,
} from "../server/auth-recovery";
import {
  BCRYPT_MAX_INPUT_BYTES,
  hasPasswordCredentialMaterial,
  isBcryptInputWithinLimit,
  isClaimablePasswordShell,
  isSafeBcryptHash,
  safeBcryptCompare,
} from "../server/password-credential";
import {
  InviteProfessionalIdentityError,
  requireSingleInviteProfessionalId,
} from "../server/invite-professional-identity";

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

  it("distingue casca NULL de material inválido e limita bcrypt por bytes", () => {
    expect(isClaimablePasswordShell(null)).toBe(true);
    expect(isClaimablePasswordShell(undefined)).toBe(false);
    expect(isClaimablePasswordShell("")).toBe(false);
    expect(hasPasswordCredentialMaterial("corrompido")).toBe(true);
    expect(isSafeBcryptHash("corrompido")).toBe(false);
    expect(isSafeBcryptHash(`$2x$12$${"A".repeat(53)}`)).toBe(false);
    expect(isSafeBcryptHash(`$2y$12$${"A".repeat(53)}`)).toBe(false);
    expect(isSafeBcryptHash(`$2b$13$${"A".repeat(53)}`)).toBe(false);
    expect(isSafeBcryptHash(`$2b$03$${"A".repeat(53)}`)).toBe(false);
    expect(isBcryptInputWithinLimit("a".repeat(BCRYPT_MAX_INPUT_BYTES))).toBe(
      true,
    );
    expect(isBcryptInputWithinLimit("á".repeat(37))).toBe(false);
  });

  it("compare com material malformado falha fechado sem lançar", async () => {
    await expect(
      safeBcryptCompare("SenhaValida123", "hash-corrompido"),
    ).resolves.toBe(false);
  });

  it("abre payload anterior durante rotação e recusa KID removido", () => {
    const saved = { ...process.env };
    try {
      process.env.AUTH_RECOVERY_ENCRYPTION_CURRENT_KID = "old-key";
      process.env.AUTH_RECOVERY_ENCRYPTION_CURRENT_SECRET = "o".repeat(48);
      delete process.env.AUTH_RECOVERY_ENCRYPTION_PREVIOUS_KID;
      delete process.env.AUTH_RECOVERY_ENCRYPTION_PREVIOUS_SECRET;
      const sealed = sealAuthRecoveryPayload({
        email: "pessoa@example.test",
        token: "b".repeat(64),
      });

      process.env.AUTH_RECOVERY_ENCRYPTION_CURRENT_KID = "new-key";
      process.env.AUTH_RECOVERY_ENCRYPTION_CURRENT_SECRET = "n".repeat(48);
      process.env.AUTH_RECOVERY_ENCRYPTION_PREVIOUS_KID = "old-key";
      process.env.AUTH_RECOVERY_ENCRYPTION_PREVIOUS_SECRET = "o".repeat(48);
      expect(openAuthRecoveryPayload(sealed).token).toBe("b".repeat(64));

      delete process.env.AUTH_RECOVERY_ENCRYPTION_PREVIOUS_KID;
      delete process.env.AUTH_RECOVERY_ENCRYPTION_PREVIOUS_SECRET;
      expect(() => openAuthRecoveryPayload(sealed)).toThrow(
        "AUTH_RECOVERY_PAYLOAD_KEY_UNAVAILABLE",
      );
      expect(authRecoveryEncryptionKeyRing().current.kid).toBe("new-key");
    } finally {
      process.env = saved;
    }
  });

  it("recusa topologia profissional ausente, duplicada ou cruzada no convite", () => {
    expect(() => requireSingleInviteProfessionalId([], 7)).toThrowError(
      expect.objectContaining<Partial<InviteProfessionalIdentityError>>({
        reason: "MISSING",
      }),
    );
    expect(() =>
      requireSingleInviteProfessionalId(
        [
          { id: 10, userId: 7 },
          { id: 11, userId: 7 },
        ],
        7,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<InviteProfessionalIdentityError>>({
        reason: "AMBIGUOUS",
      }),
    );
    expect(() =>
      requireSingleInviteProfessionalId([{ id: 10, userId: 8 }], 7),
    ).toThrowError(
      expect.objectContaining<Partial<InviteProfessionalIdentityError>>({
        reason: "MALFORMED",
      }),
    );
    expect(requireSingleInviteProfessionalId([{ id: 10, userId: 7 }], 7)).toBe(
      10,
    );
  });
});
