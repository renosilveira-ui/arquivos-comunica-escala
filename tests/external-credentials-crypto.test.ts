import { describe, expect, it } from "vitest";

import {
  EXTERNAL_PROVIDERS,
  TRAVEL_ORIGIN_SEAL_SCOPE,
} from "../lib/integration-providers";
import {
  ExternalCredentialsCryptoError,
  externalCredentialsKeyRing,
  openExternalCredential,
  rotateExternalCredential,
  sealExternalCredential,
  sealedCredentialKid,
} from "../server/external-credentials-crypto";

const SECRET_A = "a".repeat(48);
const SECRET_B = "b".repeat(48);

function env(
  extra: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    EXTERNAL_CREDENTIALS_ENCRYPTION_KEY: SECRET_A,
    EXTERNAL_CREDENTIALS_ENCRYPTION_KID: "k1",
    ...extra,
  } as NodeJS.ProcessEnv;
}

const owner = { userId: 7, scope: EXTERNAL_PROVIDERS.googleCalendar };

describe("credenciais externas — selagem em repouso", () => {
  it("abre o que selou e não deixa o segredo aparecer no envelope", () => {
    const sealed = sealExternalCredential(
      "refresh-token-secreto",
      owner,
      env(),
    );
    expect(sealed).not.toContain("refresh-token-secreto");
    expect(sealed.startsWith("v1.k1.")).toBe(true);
    expect(openExternalCredential(sealed, owner, env())).toBe(
      "refresh-token-secreto",
    );
  });

  it("recusa envelope copiado para outro usuário", () => {
    const sealed = sealExternalCredential("token-do-7", owner, env());
    expect(() =>
      openExternalCredential(
        sealed,
        { userId: 8, scope: EXTERNAL_PROVIDERS.googleCalendar },
        env(),
      ),
    ).toThrow(ExternalCredentialsCryptoError);
  });

  it("recusa envelope reaproveitado em outro provedor", () => {
    const sealed = sealExternalCredential("token", owner, env());
    expect(() =>
      openExternalCredential(
        sealed,
        { userId: 7, scope: EXTERNAL_PROVIDERS.weatherKit },
        env(),
      ),
    ).toThrow(ExternalCredentialsCryptoError);
  });

  /**
   * A origem de deslocamento não pertence a provedor nenhum. Sem escopo
   * próprio, o writer teria de escolher um provedor arbitrário para selá-la e
   * o leitor teria de adivinhar a mesma escolha — falha na PR seguinte, longe
   * da causa.
   */
  it("origem de deslocamento tem escopo próprio, separado dos provedores", () => {
    const origin = { userId: 7, scope: TRAVEL_ORIGIN_SEAL_SCOPE };
    const sealed = sealExternalCredential("Rua X, 123", origin, env());
    expect(openExternalCredential(sealed, origin, env())).toBe("Rua X, 123");
    expect(() => openExternalCredential(sealed, owner, env())).toThrow(
      ExternalCredentialsCryptoError,
    );
    const providerSealed = sealExternalCredential("token", owner, env());
    expect(() => openExternalCredential(providerSealed, origin, env())).toThrow(
      ExternalCredentialsCryptoError,
    );
  });

  it("recusa escopo desconhecido", () => {
    expect(() =>
      sealExternalCredential(
        "x",
        { userId: 7, scope: "INVENTADO" as never },
        env(),
      ),
    ).toThrow(/BINDING_INVALID/);
  });

  it("recusa ciphertext adulterado", () => {
    const sealed = sealExternalCredential("token", owner, env());
    const parts = sealed.split(".");
    const flipped = Buffer.from(parts[3], "base64url");
    flipped[0] ^= 0xff;
    parts[3] = flipped.toString("base64url");
    expect(() => openExternalCredential(parts.join("."), owner, env())).toThrow(
      ExternalCredentialsCryptoError,
    );
  });

  it("não abre com chave de outro domínio", () => {
    const sealed = sealExternalCredential("token", owner, env());
    expect(() =>
      openExternalCredential(
        sealed,
        owner,
        env({ EXTERNAL_CREDENTIALS_ENCRYPTION_KEY: SECRET_B }),
      ),
    ).toThrow(ExternalCredentialsCryptoError);
  });
});

describe("credenciais externas — key ring", () => {
  it("aceita kid padrão quando só a chave é informada", () => {
    const ring = externalCredentialsKeyRing(
      env({ EXTERNAL_CREDENTIALS_ENCRYPTION_KID: undefined }),
    );
    expect(ring.current.kid).toBe("v1");
  });

  it("recusa segredo curto demais", () => {
    expect(() =>
      externalCredentialsKeyRing(
        env({ EXTERNAL_CREDENTIALS_ENCRYPTION_KEY: "curto" }),
      ),
    ).toThrow(ExternalCredentialsCryptoError);
  });

  it("recusa kid repetido entre atual e anterior", () => {
    expect(() =>
      externalCredentialsKeyRing(
        env({
          EXTERNAL_CREDENTIALS_ENCRYPTION_PREVIOUS_KEY: SECRET_B,
          EXTERNAL_CREDENTIALS_ENCRYPTION_PREVIOUS_KID: "k1",
        }),
      ),
    ).toThrow(ExternalCredentialsCryptoError);
  });

  it("recusa o mesmo segredo nas duas posições", () => {
    expect(() =>
      externalCredentialsKeyRing(
        env({
          EXTERNAL_CREDENTIALS_ENCRYPTION_PREVIOUS_KEY: SECRET_A,
          EXTERNAL_CREDENTIALS_ENCRYPTION_PREVIOUS_KID: "k0",
        }),
      ),
    ).toThrow(ExternalCredentialsCryptoError);
  });

  it("recusa reuso do COOKIE_SECRET", () => {
    expect(() =>
      externalCredentialsKeyRing(env({ COOKIE_SECRET: SECRET_A })),
    ).toThrow(ExternalCredentialsCryptoError);
  });

  it("recusa reuso do segredo de recuperação de credenciais", () => {
    expect(() =>
      externalCredentialsKeyRing(
        env({ AUTH_RECOVERY_ENCRYPTION_CURRENT_SECRET: SECRET_A }),
      ),
    ).toThrow(ExternalCredentialsCryptoError);
  });

  it("recusa chave anterior sem chave atual", () => {
    expect(() =>
      externalCredentialsKeyRing({
        NODE_ENV: "test",
        EXTERNAL_CREDENTIALS_ENCRYPTION_PREVIOUS_KEY: SECRET_B,
        EXTERNAL_CREDENTIALS_ENCRYPTION_PREVIOUS_KID: "k0",
      } as NodeJS.ProcessEnv),
    ).toThrow(ExternalCredentialsCryptoError);
  });

  it("em produção exige chave configurada; fora dela usa a de desenvolvimento", () => {
    expect(() =>
      externalCredentialsKeyRing({
        NODE_ENV: "production",
      } as NodeJS.ProcessEnv),
    ).toThrow(ExternalCredentialsCryptoError);
    expect(
      externalCredentialsKeyRing({
        NODE_ENV: "development",
      } as NodeJS.ProcessEnv).current.kid,
    ).toBe("development-v1");
  });
});

describe("credenciais externas — rotação", () => {
  const rotated = env({
    EXTERNAL_CREDENTIALS_ENCRYPTION_KEY: SECRET_B,
    EXTERNAL_CREDENTIALS_ENCRYPTION_KID: "k2",
    EXTERNAL_CREDENTIALS_ENCRYPTION_PREVIOUS_KEY: SECRET_A,
    EXTERNAL_CREDENTIALS_ENCRYPTION_PREVIOUS_KID: "k1",
  });

  it("abre envelope da chave anterior durante a transição", () => {
    const sealed = sealExternalCredential("token", owner, env());
    expect(openExternalCredential(sealed, owner, rotated)).toBe("token");
  });

  it("reescreve para a chave atual preservando o conteúdo", () => {
    const sealed = sealExternalCredential("token", owner, env());
    const result = rotateExternalCredential(sealed, owner, rotated);
    expect(result.rotated).toBe(true);
    expect(sealedCredentialKid(result.sealed)).toBe("k2");
    expect(openExternalCredential(result.sealed, owner, rotated)).toBe("token");
  });

  it("é idempotente: envelope já atual não é reescrito", () => {
    const sealed = sealExternalCredential("token", owner, rotated);
    const first = rotateExternalCredential(sealed, owner, rotated);
    expect(first.rotated).toBe(false);
    expect(first.sealed).toBe(sealed);
  });

  it("falha fechado quando a chave que selou não está mais no ring", () => {
    const sealed = sealExternalCredential("token", owner, env());
    expect(() =>
      openExternalCredential(
        sealed,
        owner,
        env({
          EXTERNAL_CREDENTIALS_ENCRYPTION_KEY: SECRET_B,
          EXTERNAL_CREDENTIALS_ENCRYPTION_KID: "k2",
        }),
      ),
    ).toThrow(/KEY_UNAVAILABLE/);
  });
});
