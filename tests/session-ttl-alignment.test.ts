import { readFileSync } from "node:fs";
import { decodeJwt } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSessionTtlMs } from "../server/_core/cookie-policy";
import { sdk } from "../server/_core/sdk";
import { SESSION_MAX_AGE_MS } from "../shared/const";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function jwtTtlMs(token: string): number {
  const exp = decodeJwt(token).exp;
  if (typeof exp !== "number") throw new Error("JWT sem exp");
  return exp * 1000 - Date.now();
}

async function signDefault(): Promise<string> {
  return sdk.signSession({
    userId: "1",
    name: "TTL",
    sessionVersion: 1,
  });
}

describe("TTL da sessão: cookie e JWT são a mesma autoridade", () => {
  const previousCookieMaxAge = process.env.COOKIE_MAX_AGE_DAYS;

  afterEach(() => {
    if (previousCookieMaxAge === undefined) {
      delete process.env.COOKIE_MAX_AGE_DAYS;
    } else {
      process.env.COOKIE_MAX_AGE_DAYS = previousCookieMaxAge;
    }
  });

  it("emissão default usa 30d da política, não o teto de 90d", async () => {
    const ttl = jwtTtlMs(await signDefault());
    expect(resolveSessionTtlMs({ env: {} })).toBe(30 * ONE_DAY_MS);
    expect(ttl).toBeGreaterThan(29 * ONE_DAY_MS);
    expect(ttl).toBeLessThan(31 * ONE_DAY_MS);
    expect(ttl).toBeLessThan(SESSION_MAX_AGE_MS - ONE_DAY_MS);
  });

  it("COOKIE_MAX_AGE_DAYS curto encurta o Bearer no mesmo instante", async () => {
    process.env.COOKIE_MAX_AGE_DAYS = "7";
    const ttl = jwtTtlMs(await signDefault());
    expect(resolveSessionTtlMs()).toBe(7 * ONE_DAY_MS);
    expect(ttl).toBeGreaterThan(6 * ONE_DAY_MS);
    expect(ttl).toBeLessThan(8 * ONE_DAY_MS);
  });

  it("COOKIE_MAX_AGE_DAYS acima do teto não emite JWT de 1 ano", async () => {
    process.env.COOKIE_MAX_AGE_DAYS = "365";
    const ttl = jwtTtlMs(await signDefault());
    expect(resolveSessionTtlMs()).toBe(SESSION_MAX_AGE_MS);
    expect(ttl).toBeGreaterThan(89 * ONE_DAY_MS);
    expect(ttl).toBeLessThanOrEqual(SESSION_MAX_AGE_MS);
  });

  it("override interno não pode emitir Bearer além do cookie", async () => {
    process.env.COOKIE_MAX_AGE_DAYS = "7";
    const token = await sdk.signSession(
      { userId: "1", name: "TTL", sessionVersion: 1 },
      { expiresInMs: 60 * ONE_DAY_MS },
    );
    const ttl = jwtTtlMs(token);
    expect(ttl).toBeGreaterThan(6 * ONE_DAY_MS);
    expect(ttl).toBeLessThan(8 * ONE_DAY_MS);
  });

  it("JWT expirado é rejeitado mesmo com sessionVersion ainda válida", async () => {
    const expired = await sdk.signSession(
      { userId: "1", name: "TTL", sessionVersion: 1 },
      { expiresInMs: -1_000 },
    );
    expect(await sdk.verifySession(expired)).toBeNull();
  });

  it("signSession e Set-Cookie leem resolveSessionTtlMs; auth não pede exp maior", () => {
    const sdkSource = readFileSync("server/_core/sdk.ts", "utf8");
    const cookieSource = readFileSync("server/_core/cookie-policy.ts", "utf8");
    const authSource = readFileSync("server/routes/auth.ts", "utf8");
    const signStart = sdkSource.indexOf("async signSession(");
    const signEnd = sdkSource.indexOf("async verifySession(", signStart);
    const signSlice = sdkSource.slice(signStart, signEnd);
    expect(signSlice).toContain("resolveSessionTtlMs()");
    expect(signSlice).not.toMatch(/expiresInMs \?\? SESSION_MAX_AGE_MS/);
    expect(cookieSource).toContain("maxAge: resolveSessionTtlMs(options)");
    expect(authSource).not.toMatch(/expiresInMs:\s*SESSION_MAX_AGE_MS/);
    expect(authSource).not.toMatch(/expiresInMs:\s*90/);
  });
});
