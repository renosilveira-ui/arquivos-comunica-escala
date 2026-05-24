// server/sso/keys.ts — RSA key pair management + JWKS endpoint
//
// Key loading priority:
// 1. SSO_PRIVATE_KEY_JWK env var (JSON string) — for staging/prod (Render, etc.)
// 2. File at SSO_KEYSTORE_PATH or .sso-keystore.json — for local dev
// 3. Auto-generate new key pair (dev only) — written to file for reuse
import { generateKeyPair, exportJWK, importJWK, type KeyLike } from "jose";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { ENV } from "../_core/env";

const KID = ENV.ssoKid;
const ALG = "RS256";

interface StoredKeyPair {
  kid: string;
  alg: string;
  publicJwk: Record<string, unknown>;
  privateJwk: Record<string, unknown>;
}

let cachedPrivateKey: KeyLike | null = null;
let cachedPublicJwk: Record<string, unknown> | null = null;

function getKeystorePath(): string {
  return ENV.ssoKeystorePath || join(process.cwd(), ".sso-keystore.json");
}

/**
 * Load key pair from SSO_PRIVATE_KEY_JWK env var.
 * Expected format: JSON string containing { publicJwk, privateJwk }.
 */
function loadFromEnv(): StoredKeyPair | null {
  const raw = process.env.SSO_PRIVATE_KEY_JWK;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredKeyPair;
    if (!parsed.privateJwk || !parsed.publicJwk) return null;
    // Ensure kid/alg match current config
    parsed.publicJwk.kid = KID;
    parsed.publicJwk.alg = ALG;
    parsed.publicJwk.use = "sig";
    parsed.privateJwk.kid = KID;
    parsed.privateJwk.alg = ALG;
    parsed.kid = KID;
    parsed.alg = ALG;
    console.log(`[SSO] Loaded RSA key pair from SSO_PRIVATE_KEY_JWK env var (kid=${KID})`);
    return parsed;
  } catch (err) {
    console.error("[SSO] Failed to parse SSO_PRIVATE_KEY_JWK:", err);
    return null;
  }
}

function loadFromFile(): StoredKeyPair | null {
  const path = getKeystorePath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as StoredKeyPair;
    if (parsed.kid !== KID) return null;
    console.log(`[SSO] Loaded RSA key pair from file (kid=${KID})`);
    return parsed;
  } catch {
    return null;
  }
}

async function generateAndStore(): Promise<StoredKeyPair> {
  if (!ENV.isDev) {
    throw new Error(
      "[SSO] No key pair found. In staging/prod, set SSO_PRIVATE_KEY_JWK env var. " +
      "Auto-generation is only allowed in development.",
    );
  }

  const { publicKey, privateKey } = await generateKeyPair(ALG, { modulusLength: 2048 });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);

  publicJwk.kid = KID;
  publicJwk.alg = ALG;
  publicJwk.use = "sig";

  privateJwk.kid = KID;
  privateJwk.alg = ALG;

  const stored: StoredKeyPair = { kid: KID, alg: ALG, publicJwk, privateJwk };

  const path = getKeystorePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(stored, null, 2), { mode: 0o600 });
  console.log(`[SSO] Generated new RSA key pair (kid=${KID}), stored at ${path}`);
  console.log("[SSO] For staging/prod, set SSO_PRIVATE_KEY_JWK with the contents of this file.");

  return stored;
}

async function ensureKeyPair(): Promise<{ privateKey: KeyLike; publicJwk: Record<string, unknown> }> {
  if (cachedPrivateKey && cachedPublicJwk) {
    return { privateKey: cachedPrivateKey, publicJwk: cachedPublicJwk };
  }

  // Priority: env var > file > auto-generate (dev only)
  const stored = loadFromEnv() ?? loadFromFile() ?? await generateAndStore();

  cachedPrivateKey = (await importJWK(stored.privateJwk, ALG)) as KeyLike;
  cachedPublicJwk = stored.publicJwk;

  return { privateKey: cachedPrivateKey, publicJwk: cachedPublicJwk };
}

export async function getPrivateKey(): Promise<KeyLike> {
  const { privateKey } = await ensureKeyPair();
  return privateKey;
}

export async function getJwks(): Promise<{ keys: Record<string, unknown>[] }> {
  const { publicJwk } = await ensureKeyPair();
  return { keys: [publicJwk] };
}

export { KID, ALG };
