// server/_core/security.ts
//
// Centralized security middleware: helmet headers, CORS hardening,
// auth/global rate limits and payload-size policy.
//
// Designed to be testable in isolation — every primitive is exported so the
// test suite can mount it on a minimal Express app without booting the full
// server.

import type { NextFunction, Request, RequestHandler, Response } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

// Maximum body size accepted by express.json / express.urlencoded.
// Sized for typical tRPC payloads (a few KB) plus generous headroom.
// The previous 50mb default was a DoS amplifier with no legitimate use case
// in this API surface.
export const PAYLOAD_LIMIT = "1mb";

const ALLOWED_HEADERS = [
  "Origin",
  "X-Requested-With",
  "Content-Type",
  "Accept",
  "Authorization",
  "x-tenant-id",
  "x-test-user-id",
] as const;

const ALLOWED_METHODS = ["GET", "POST", "PUT", "DELETE", "OPTIONS"] as const;

export interface CorsOptions {
  /** Origins explicitly authorized to send credentialed requests. */
  allowedOrigins: ReadonlySet<string>;
}

/**
 * CORS middleware that:
 * - only echoes Access-Control-Allow-Origin / Allow-Credentials when the
 *   request origin is on the explicit allow-list (no wildcard credentials).
 * - rejects preflight (OPTIONS) requests from disallowed origins with 403
 *   instead of silently 200ing them.
 * - serves the standard preflight 204 for allowed origins.
 */
export function createCorsMiddleware(options: CorsOptions): RequestHandler {
  const { allowedOrigins } = options;
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    const isAllowed = typeof origin === "string" && allowedOrigins.has(origin);

    if (isAllowed) {
      res.header("Access-Control-Allow-Origin", origin);
      res.header("Vary", "Origin");
      res.header("Access-Control-Allow-Credentials", "true");
    }

    res.header("Access-Control-Allow-Methods", ALLOWED_METHODS.join(", "));
    res.header("Access-Control-Allow-Headers", ALLOWED_HEADERS.join(", "));

    if (req.method === "OPTIONS") {
      res.sendStatus(isAllowed ? 204 : 403);
      return;
    }
    next();
  };
}

/**
 * Strict helmet defaults. We disable contentSecurityPolicy because the API
 * does not serve HTML — CSP belongs on the frontend host (Expo web / static
 * site), not on the JSON API.
 */
export function createHelmetMiddleware(): RequestHandler {
  return helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  });
}

export interface RateLimitOptions {
  windowMs?: number;
  max?: number;
  /** When true, the middleware is a no-op. Useful in tests that do not need limit semantics. */
  disabled?: boolean;
}

/**
 * Stricter limit for authentication endpoints. bcrypt.compare is CPU-bound,
 * so unrestricted login attempts can both brute-force passwords and DoS the
 * event loop.
 *
 * Default: 20 attempts per 15 minutes per IP.
 */
export function createAuthRateLimit(options: RateLimitOptions = {}): RequestHandler {
  if (options.disabled) return (_req, _res, next) => next();
  return rateLimit({
    windowMs: options.windowMs ?? 15 * 60 * 1000,
    max: options.max ?? 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: "Muitas tentativas de autenticação. Tente novamente mais tarde.",
    },
  });
}

/**
 * Soft global limit applied to all routes except health checks. Designed to
 * absorb burst traffic and block scrapers without affecting normal usage.
 *
 * Default: 200 requests per minute per IP.
 */
export function createGlobalRateLimit(options: RateLimitOptions = {}): RequestHandler {
  if (options.disabled) return (_req, _res, next) => next();
  return rateLimit({
    windowMs: options.windowMs ?? 60 * 1000,
    max: options.max ?? 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Muitas requisições. Reduza a frequência." },
  });
}
