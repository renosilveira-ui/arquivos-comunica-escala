import bcrypt from "bcryptjs";

export const BCRYPT_WRITE_ROUNDS = 12;
export const BCRYPT_MAX_INPUT_BYTES = 72;
export const DUMMY_PASSWORD_HASH =
  "$2b$12$kbCK0heWrK5N5G57C1OoJeeSGgkmA1E2Nl1qOQOs7fBh.a88y3OES";

/** A casca reivindicável é somente a ausência explícita de material. */
export function isClaimablePasswordShell(
  hash: string | null | undefined,
): hash is null {
  return hash === null;
}

/**
 * Material não nulo, mesmo corrompido, representa uma credencial existente.
 * Isso impede que corrupção de banco seja reinterpretada como conta vazia.
 */
export function hasPasswordCredentialMaterial(
  hash: string | null | undefined,
): hash is string {
  return hash !== null && hash !== undefined;
}

/** Só hashes bcrypt com custo operacionalmente limitado chegam ao compare. */
export function isSafeBcryptHash(hash: unknown): hash is string {
  if (typeof hash !== "string") return false;
  const parsed = /^\$2[ab]\$(\d{2})\$[./A-Za-z0-9]{53}$/.exec(hash);
  if (!parsed) return false;
  const cost = Number(parsed[1]);
  return Number.isInteger(cost) && cost >= 4 && cost <= BCRYPT_WRITE_ROUNDS;
}

export function isBcryptInputWithinLimit(value: string): boolean {
  return Buffer.byteLength(value, "utf8") <= BCRYPT_MAX_INPUT_BYTES;
}

/**
 * Sempre paga um compare seguro. Hash ausente ou inválido usa sentinela e
 * nunca é passado ao bcrypt, evitando tanto exceção quanto amplificação CPU.
 */
export async function safeBcryptCompare(
  plaintext: string,
  storedHash: string | null | undefined,
): Promise<boolean> {
  const safeHash = isSafeBcryptHash(storedHash)
    ? storedHash
    : DUMMY_PASSWORD_HASH;
  const matches = await bcrypt.compare(plaintext, safeHash);
  return isSafeBcryptHash(storedHash) && matches;
}
