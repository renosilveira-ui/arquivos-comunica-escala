// server/_core/cookie-policy.ts
//
// Centralized session-cookie policy. Replaces the previous inline
// COOKIE_OPTIONS in server/routes/auth.ts so that cookie attributes are:
//
//   - derived per request (so `secure` reflects the actual transport),
//   - configurable via environment for staging vs production vs custom
//     domain setups (Render subdomain → custom domain transitions),
//   - bounded with safe defaults so a missing/invalid env never produces
//     an absurd value (1-year sessions, sameSite=invalid, negative maxAge).

import type { CookieOptions, Request } from "express";
import { isSecureRequest } from "./cookies";

export type CookieSameSite = "lax" | "strict" | "none";

const VALID_SAMESITE: readonly CookieSameSite[] = ["lax", "strict", "none"];

const DEFAULT_MAX_AGE_DAYS = 30;
const MIN_MAX_AGE_DAYS = 1;
const MAX_MAX_AGE_DAYS = 90;

export interface CookiePolicyOptions {
  /** Test seam: override `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface ResolvedCookiePolicy {
  sameSite: CookieSameSite;
  maxAgeMs: number;
  domain?: string;
}

export function resolveCookiePolicy(
  options: CookiePolicyOptions = {},
): ResolvedCookiePolicy {
  const env = options.env ?? process.env;

  const requested = (env.COOKIE_SAMESITE ?? "lax").trim().toLowerCase();
  const sameSite: CookieSameSite = VALID_SAMESITE.includes(
    requested as CookieSameSite,
  )
    ? (requested as CookieSameSite)
    : "lax";

  const rawDays = env.COOKIE_MAX_AGE_DAYS;
  const parsed = rawDays !== undefined ? Number(rawDays) : DEFAULT_MAX_AGE_DAYS;
  const days = Number.isFinite(parsed)
    ? Math.min(Math.max(parsed, MIN_MAX_AGE_DAYS), MAX_MAX_AGE_DAYS)
    : DEFAULT_MAX_AGE_DAYS;

  const domain = env.COOKIE_DOMAIN?.trim() || undefined;

  return { sameSite, maxAgeMs: days * 24 * 60 * 60 * 1000, domain };
}

/**
 * Cookie options for `res.cookie(name, value, options)` at session creation.
 * `secure` is forced when the request arrived over HTTPS OR when running in
 * production — both conditions are honored independently so that a
 * misconfigured proxy chain (where x-forwarded-proto is missing) does not
 * silently downgrade prod cookies to insecure.
 *
 * Modern browsers reject `sameSite=none` without `secure`, so the policy is
 * self-consistent even if a developer sets `COOKIE_SAMESITE=none` in dev.
 */
export function resolveSetCookieOptions(
  req: Request,
  options: CookiePolicyOptions = {},
): CookieOptions {
  const env = options.env ?? process.env;
  const policy = resolveCookiePolicy(options);
  const secure = isSecureRequest(req) || env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure,
    sameSite: policy.sameSite,
    maxAge: policy.maxAgeMs,
    path: "/",
    ...(policy.domain ? { domain: policy.domain } : {}),
  };
}

/**
 * Options for `res.clearCookie(name, options)`. Browsers only invalidate a
 * cookie when **all attributes** (path, domain, sameSite, secure) match the
 * original Set-Cookie. The previous version returned only path+domain,
 * which silently failed on cookies set with `sameSite=none, secure=true`
 * (the staging config since PR #48): Chrome/Safari/Firefox ignored the
 * Set-Cookie ...; Max-Age=0 because the new attributes didn't match the
 * original — and the user kept logged in despite the server saying "ok".
 *
 * Mirror everything from `resolveSetCookieOptions` except `maxAge`/
 * `httpOnly` (handled by Express's clearCookie internally).
 */
export interface ClearCookieOptions extends CookiePolicyOptions {
  /** Request context para determinar `secure` (HTTPS atual). Se ausente,
   *  cai pra `NODE_ENV === "production"`. */
  req?: Request;
}

export function resolveClearCookieOptions(
  options: ClearCookieOptions = {},
): CookieOptions {
  const env = options.env ?? process.env;
  const policy = resolveCookiePolicy(options);
  // When called from a request context, mirror exactly. Otherwise (no req,
  // e.g. early middleware error handler) fall back to env-only secure
  // determination — production always treated as secure.
  const secure = options.req
    ? isSecureRequest(options.req) || env.NODE_ENV === "production"
    : env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure,
    sameSite: policy.sameSite,
    path: "/",
    ...(policy.domain ? { domain: policy.domain } : {}),
  };
}
