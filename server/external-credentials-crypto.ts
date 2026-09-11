import { createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { randomBytes } from "node:crypto";

import type { SealScope } from "../lib/integration-providers";
import { isSealScope } from "../lib/integration-providers";

/**
 * Criptografia em repouso das credenciais externas (refresh token do Google,
 * origem de deslocamento do usuário).
 *
 * Segue o desenho já revisado de `server/auth-recovery.ts` — AES-256-GCM,
 * key ring `current`/`previous`, chave derivada por contexto — com duas
 * diferenças deliberadas:
 *
 * 1. Contexto próprio. A chave derivada aqui não abre nada selado pela
 *    recuperação de credenciais, e vice-versa. Comprometer um domínio não
 *    entrega o outro.
 * 2. AAD ligada ao dono. O envelope carrega `userId` + `provider` como dado
 *    autenticado: um ciphertext copiado da linha de um usuário para a de
 *    outro falha na abertura em vez de decifrar o token alheio. Sem isso,
 *    quem escrevesse na tabela herdaria o Google de qualquer conta.
 *
 * Nada aqui registra log. O valor em claro só existe no retorno da função.
 */

const PAYLOAD_VERSION = "v1";
const PAYLOAD_CONTEXT = "escala:external-credentials:v1";
const DEVELOPMENT_ENCRYPTION_SECRET =
  "development-only-external-credentials-secret-not-for-production";

const KID_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;
const MIN_SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 1024;
const MAX_PLAINTEXT_BYTES = 8 * 1024;
const DEFAULT_CURRENT_KID = "v1";

export type ExternalCredentialsKey = { kid: string; secret: string };

export type ExternalCredentialsKeyRing = {
  current: ExternalCredentialsKey;
  previous: ExternalCredentialsKey | null;
};

/**
 * A quem o envelope pertence. Faz parte do dado autenticado do AES-GCM, não
 * do texto cifrado: mudar qualquer um dos dois invalida a abertura.
 *
 * `scope` é o domínio do dado — um provedor, ou `TRAVEL_ORIGIN` para a origem
 * de deslocamento, que não pertence a provedor nenhum.
 */
export type ExternalCredentialBinding = {
  userId: number;
  scope: SealScope;
};

export class ExternalCredentialsCryptoError extends Error {
  readonly code:
    | "CONFIG_INVALID"
    | "CONFIG_MISSING"
    | "KEY_UNAVAILABLE"
    | "PAYLOAD_INVALID"
    | "BINDING_INVALID";

  constructor(
    code: ExternalCredentialsCryptoError["code"],
    message = `EXTERNAL_CREDENTIALS_${code}`,
  ) {
    super(message);
    this.name = "ExternalCredentialsCryptoError";
    this.code = code;
  }
}

function parseKey(
  kidValue: string | undefined,
  secretValue: string | undefined,
  fallbackKid: string | null,
): ExternalCredentialsKey | null {
  const secret = (secretValue ?? "").trim();
  const kid =
    (kidValue ?? "").trim() || (secret && fallbackKid ? fallbackKid : "");
  if (!kid && !secret) return null;
  const secretBytes = Buffer.byteLength(secret, "utf8");
  if (
    !KID_PATTERN.test(kid) ||
    secretBytes < MIN_SECRET_BYTES ||
    secretBytes > MAX_SECRET_BYTES
  ) {
    throw new ExternalCredentialsCryptoError("CONFIG_INVALID");
  }
  return { kid, secret };
}

/**
 * Recusa reuso de segredo entre domínios. Uma única variável copiada de um
 * runbook para outro colapsaria dois contextos que deveriam cair separados.
 */
function assertNoCrossDomainReuse(
  ring: ExternalCredentialsKeyRing,
  env: NodeJS.ProcessEnv,
): void {
  const foreignSecrets = [
    env.COOKIE_SECRET,
    env.AUTH_RECOVERY_ENCRYPTION_CURRENT_SECRET,
    env.AUTH_RECOVERY_ENCRYPTION_PREVIOUS_SECRET,
  ]
    .map((value) => (value ?? "").trim())
    .filter(Boolean);
  const own = [ring.current.secret, ring.previous?.secret].filter(
    (value): value is string => Boolean(value),
  );
  if (own.some((secret) => foreignSecrets.includes(secret))) {
    throw new ExternalCredentialsCryptoError(
      "CONFIG_INVALID",
      "EXTERNAL_CREDENTIALS_ENCRYPTION_KEY must not reuse another domain's secret",
    );
  }
}

export function externalCredentialsKeyRing(
  env: NodeJS.ProcessEnv = process.env,
): ExternalCredentialsKeyRing {
  const configuredCurrent = parseKey(
    env.EXTERNAL_CREDENTIALS_ENCRYPTION_KID,
    env.EXTERNAL_CREDENTIALS_ENCRYPTION_KEY,
    DEFAULT_CURRENT_KID,
  );
  if (!configuredCurrent && env.NODE_ENV === "production") {
    throw new ExternalCredentialsCryptoError("CONFIG_MISSING");
  }
  const current = configuredCurrent ?? {
    kid: "development-v1",
    secret: DEVELOPMENT_ENCRYPTION_SECRET,
  };
  const previous = parseKey(
    env.EXTERNAL_CREDENTIALS_ENCRYPTION_PREVIOUS_KID,
    env.EXTERNAL_CREDENTIALS_ENCRYPTION_PREVIOUS_KEY,
    null,
  );
  if (!configuredCurrent && previous) {
    // Uma chave anterior sem chave atual deixaria o sistema abrindo o que já
    // deveria ter sido reescrito, sem nunca concluir a rotação.
    throw new ExternalCredentialsCryptoError("CONFIG_INVALID");
  }
  if (previous && previous.kid === current.kid) {
    throw new ExternalCredentialsCryptoError("CONFIG_INVALID");
  }
  if (previous && previous.secret === current.secret) {
    throw new ExternalCredentialsCryptoError("CONFIG_INVALID");
  }
  const ring = { current, previous };
  assertNoCrossDomainReuse(ring, env);
  return ring;
}

function derivedKey(key: ExternalCredentialsKey): Buffer {
  return createHash("sha256")
    .update(PAYLOAD_CONTEXT)
    .update("\0")
    .update(key.kid)
    .update("\0")
    .update(key.secret)
    .digest();
}

function assertBinding(
  binding: ExternalCredentialBinding,
): asserts binding is ExternalCredentialBinding {
  if (
    !Number.isInteger(binding.userId) ||
    binding.userId <= 0 ||
    !isSealScope(binding.scope)
  ) {
    throw new ExternalCredentialsCryptoError("BINDING_INVALID");
  }
}

function additionalData(
  kid: string,
  binding: ExternalCredentialBinding,
): Buffer {
  return Buffer.from(
    `${PAYLOAD_CONTEXT}:${kid}:${binding.scope}:${binding.userId}`,
    "utf8",
  );
}

/** Qual chave selou este envelope, sem abri-lo. Usado pela rotação. */
export function sealedCredentialKid(sealed: string): string | null {
  const parts = sealed.split(".");
  if (parts.length !== 5 || parts[0] !== PAYLOAD_VERSION) return null;
  return KID_PATTERN.test(parts[1]) ? parts[1] : null;
}

export function sealExternalCredential(
  plaintext: string,
  binding: ExternalCredentialBinding,
  env: NodeJS.ProcessEnv = process.env,
): string {
  assertBinding(binding);
  if (
    !plaintext ||
    Buffer.byteLength(plaintext, "utf8") > MAX_PLAINTEXT_BYTES
  ) {
    throw new ExternalCredentialsCryptoError("PAYLOAD_INVALID");
  }
  const { current } = externalCredentialsKeyRing(env);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derivedKey(current), iv);
  cipher.setAAD(additionalData(current.kid, binding));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    PAYLOAD_VERSION,
    current.kid,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

export function openExternalCredential(
  sealed: string,
  binding: ExternalCredentialBinding,
  env: NodeJS.ProcessEnv = process.env,
): string {
  assertBinding(binding);
  const [version, kid, ivText, ciphertextText, tagText, extra] =
    sealed.split(".");
  if (
    version !== PAYLOAD_VERSION ||
    !kid ||
    !ivText ||
    !ciphertextText ||
    !tagText ||
    extra !== undefined
  ) {
    throw new ExternalCredentialsCryptoError("PAYLOAD_INVALID");
  }
  const iv = Buffer.from(ivText, "base64url");
  const ciphertext = Buffer.from(ciphertextText, "base64url");
  const tag = Buffer.from(tagText, "base64url");
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
    throw new ExternalCredentialsCryptoError("PAYLOAD_INVALID");
  }
  const ring = externalCredentialsKeyRing(env);
  const selected = [ring.current, ring.previous].find(
    (key) => key?.kid === kid,
  );
  if (!selected) {
    throw new ExternalCredentialsCryptoError("KEY_UNAVAILABLE");
  }
  const decipher = createDecipheriv("aes-256-gcm", derivedKey(selected), iv);
  decipher.setAAD(additionalData(kid, binding));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // GCM não distingue chave errada de ciphertext adulterado, e não deve:
    // qualquer detalhe a mais aqui viraria oráculo.
    throw new ExternalCredentialsCryptoError("PAYLOAD_INVALID");
  }
}

/**
 * Reescreve um envelope com a chave atual. Idempotente: um envelope já
 * selado com a chave corrente volta inalterado, então a rotação pode varrer
 * a tabela inteira sem gravar linha à toa.
 */
export function rotateExternalCredential(
  sealed: string,
  binding: ExternalCredentialBinding,
  env: NodeJS.ProcessEnv = process.env,
): { sealed: string; rotated: boolean } {
  const ring = externalCredentialsKeyRing(env);
  if (sealedCredentialKid(sealed) === ring.current.kid) {
    return { sealed, rotated: false };
  }
  const plaintext = openExternalCredential(sealed, binding, env);
  return {
    sealed: sealExternalCredential(plaintext, binding, env),
    rotated: true,
  };
}
