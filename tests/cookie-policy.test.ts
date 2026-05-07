import { describe, expect, it } from "vitest";
import type { Request } from "express";
import {
  resolveClearCookieOptions,
  resolveCookiePolicy,
  resolveSetCookieOptions,
} from "../server/_core/cookie-policy";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function buildRequest(opts: {
  protocol?: string;
  forwardedProto?: string | string[];
}): Request {
  return {
    protocol: opts.protocol ?? "http",
    headers:
      opts.forwardedProto !== undefined
        ? { "x-forwarded-proto": opts.forwardedProto }
        : {},
  } as unknown as Request;
}

describe("Frente 2.4 - resolveCookiePolicy (env parsing)", () => {
  it("returns safe defaults when no envs are set", () => {
    expect(resolveCookiePolicy({ env: {} })).toEqual({
      sameSite: "lax",
      maxAgeMs: 30 * ONE_DAY_MS,
      domain: undefined,
    });
  });

  it("accepts COOKIE_SAMESITE=lax|strict|none case-insensitively", () => {
    expect(resolveCookiePolicy({ env: { COOKIE_SAMESITE: "STRICT" } }).sameSite).toBe(
      "strict",
    );
    expect(resolveCookiePolicy({ env: { COOKIE_SAMESITE: "None" } }).sameSite).toBe(
      "none",
    );
    expect(resolveCookiePolicy({ env: { COOKIE_SAMESITE: "lax" } }).sameSite).toBe(
      "lax",
    );
  });

  it("falls back to lax when COOKIE_SAMESITE is invalid", () => {
    expect(
      resolveCookiePolicy({ env: { COOKIE_SAMESITE: "garbage" } }).sameSite,
    ).toBe("lax");
    expect(resolveCookiePolicy({ env: { COOKIE_SAMESITE: "" } }).sameSite).toBe(
      "lax",
    );
  });

  it("clamps COOKIE_MAX_AGE_DAYS to [1, 90] and tolerates garbage", () => {
    expect(resolveCookiePolicy({ env: { COOKIE_MAX_AGE_DAYS: "7" } }).maxAgeMs).toBe(
      7 * ONE_DAY_MS,
    );
    // Below minimum
    expect(resolveCookiePolicy({ env: { COOKIE_MAX_AGE_DAYS: "0" } }).maxAgeMs).toBe(
      1 * ONE_DAY_MS,
    );
    expect(
      resolveCookiePolicy({ env: { COOKIE_MAX_AGE_DAYS: "-99" } }).maxAgeMs,
    ).toBe(1 * ONE_DAY_MS);
    // Above maximum (no more 1-year sessions)
    expect(
      resolveCookiePolicy({ env: { COOKIE_MAX_AGE_DAYS: "365" } }).maxAgeMs,
    ).toBe(90 * ONE_DAY_MS);
    // Garbage falls back to default
    expect(
      resolveCookiePolicy({ env: { COOKIE_MAX_AGE_DAYS: "abc" } }).maxAgeMs,
    ).toBe(30 * ONE_DAY_MS);
  });

  it("trims and exposes COOKIE_DOMAIN, treating empty as undefined", () => {
    expect(
      resolveCookiePolicy({ env: { COOKIE_DOMAIN: "  .escalas.example.com  " } })
        .domain,
    ).toBe(".escalas.example.com");
    expect(resolveCookiePolicy({ env: { COOKIE_DOMAIN: "" } }).domain).toBeUndefined();
    expect(resolveCookiePolicy({ env: { COOKIE_DOMAIN: "   " } }).domain).toBeUndefined();
  });
});

describe("Frente 2.4 - resolveSetCookieOptions (per-request)", () => {
  it("always sets httpOnly=true and path=/", () => {
    const opts = resolveSetCookieOptions(buildRequest({}), {
      env: { NODE_ENV: "development" },
    });
    expect(opts.httpOnly).toBe(true);
    expect(opts.path).toBe("/");
  });

  it("sets secure=false on plain HTTP in development", () => {
    const opts = resolveSetCookieOptions(buildRequest({ protocol: "http" }), {
      env: { NODE_ENV: "development" },
    });
    expect(opts.secure).toBe(false);
  });

  it("sets secure=true when the request arrived via HTTPS (req.protocol)", () => {
    const opts = resolveSetCookieOptions(
      buildRequest({ protocol: "https" }),
      { env: { NODE_ENV: "development" } },
    );
    expect(opts.secure).toBe(true);
  });

  it("sets secure=true when X-Forwarded-Proto reports HTTPS (proxy chain)", () => {
    const opts = resolveSetCookieOptions(
      buildRequest({ protocol: "http", forwardedProto: "https" }),
      { env: { NODE_ENV: "development" } },
    );
    expect(opts.secure).toBe(true);
  });

  it("forces secure=true in production even on plain HTTP requests (defence in depth)", () => {
    const opts = resolveSetCookieOptions(buildRequest({ protocol: "http" }), {
      env: { NODE_ENV: "production" },
    });
    expect(opts.secure).toBe(true);
  });

  it("uses 30 days as default maxAge (not 1 year)", () => {
    const opts = resolveSetCookieOptions(buildRequest({}), { env: {} });
    expect(opts.maxAge).toBe(30 * ONE_DAY_MS);
    // Sanity guard: never accept the previous 1-year value as default.
    expect(opts.maxAge).not.toBe(365 * ONE_DAY_MS);
  });

  it("propagates COOKIE_DOMAIN when set, omits the attribute otherwise", () => {
    const withDomain = resolveSetCookieOptions(buildRequest({}), {
      env: { COOKIE_DOMAIN: ".escalas.example.com" },
    });
    expect(withDomain.domain).toBe(".escalas.example.com");

    const withoutDomain = resolveSetCookieOptions(buildRequest({}), { env: {} });
    expect(withoutDomain.domain).toBeUndefined();
  });

  it("propagates COOKIE_SAMESITE", () => {
    const opts = resolveSetCookieOptions(buildRequest({}), {
      env: { COOKIE_SAMESITE: "strict" },
    });
    expect(opts.sameSite).toBe("strict");
  });
});

describe("Frente 2.4 - resolveClearCookieOptions (logout)", () => {
  // Bug histórico (corrigido): a versão anterior retornava só
  // { path, domain } e omitia sameSite/secure. Browsers (Chrome,
  // Safari, Firefox) só invalidam cookies quando o Set-Cookie ...;
  // Max-Age=0 do clearCookie tem **todos** os atributos batendo com
  // o original. Em staging com COOKIE_SAMESITE=none + secure
  // (PR #48), o logout falhava silenciosamente porque o Max-Age=0
  // chegava com sameSite=lax (default Express) e o browser ignorava.
  //
  // Comportamento atual: mirror EXATO de resolveSetCookieOptions
  // exceto maxAge (que clearCookie sobrescreve com 0).

  it("default: path=/, sameSite=lax, httpOnly=true, secure=false (não-prod, sem req)", () => {
    expect(resolveClearCookieOptions({ env: {} })).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
    });
  });

  it("MUST mirror COOKIE_DOMAIN so the browser actually invalidates the original cookie", () => {
    const opts = resolveClearCookieOptions({
      env: { COOKIE_DOMAIN: ".escalas.example.com" },
    });
    expect(opts).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
      domain: ".escalas.example.com",
    });
  });

  it("MUST mirror COOKIE_SAMESITE — sem isso o browser ignora clearCookie em sameSite=none", () => {
    const opts = resolveClearCookieOptions({
      env: { COOKIE_SAMESITE: "none" },
    });
    expect(opts.sameSite).toBe("none");
  });

  it("forces secure=true em production mesmo sem req (early middleware)", () => {
    const opts = resolveClearCookieOptions({
      env: { NODE_ENV: "production" },
    });
    expect(opts.secure).toBe(true);
  });

  it("não inclui maxAge — clearCookie do Express força Max-Age=0", () => {
    const opts = resolveClearCookieOptions({ env: {} });
    expect(opts.maxAge).toBeUndefined();
  });
});
