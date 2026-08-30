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
import expressRateLimit from "express-rate-limit";

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
  "x-client-expected-user-id",
  "x-client-session-instance",
  "x-client-session-protocol",
  "x-test-user-id",
] as const;

const ALLOWED_METHODS = ["GET", "POST", "PUT", "DELETE", "OPTIONS"] as const;

export interface CorsOptions {
  /** Origins explicitly authorized to send credentialed requests. */
  allowedOrigins: ReadonlySet<string>;
  /**
   * Hosts (host[:port]) for which a same-origin request (Origin === the
   * server's own origin) is trusted. Defaults to the hosts of
   * `allowedOrigins`. The Host header is client-controlled, so without
   * this list `Origin: https://evil` + `Host: evil` would be echoed back
   * WITH credentials (CodeQL js/cors-misconfiguration-for-credentials).
   */
  trustedHosts?: ReadonlySet<string>;
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
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
  const trustedHosts = new Set<string>();
  for (const o of allowedOrigins) {
    const h = hostOf(o);
    if (h) trustedHosts.add(h);
  }
  for (const h of options.trustedHosts ?? []) trustedHosts.add(h.toLowerCase());

  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;

    // Same-origin: browser sends Origin on credentialed POST even when
    // frontend and API share the same domain (Express serves web-build).
    // Only trust it when the Host header is one of OUR hosts — Host is
    // client-controlled, so it cannot be the sole source of truth.
    const host = String(req.headers.host ?? "").toLowerCase();
    const proto =
      req.protocol === "https" ||
      String(req.headers["x-forwarded-proto"]).includes("https")
        ? "https"
        : "http";

    // Allow-list EFETIVA desta requisição: origens configuradas + a
    // própria origem do servidor (só quando o Host é confiável). O eco em
    // Access-Control-Allow-Origin só acontece se `origin` passar pelo
    // `.has()` dessa allow-list — forma que a análise estática (CodeQL
    // js/cors-misconfiguration-for-credentials) reconhece como validação.
    const selfOrigin = trustedHosts.has(host) ? `${proto}://${host}` : null;
    const effectiveAllowed = selfOrigin
      ? new Set([...allowedOrigins, selfOrigin])
      : allowedOrigins;
    const isAllowed =
      typeof origin === "string" && effectiveAllowed.has(origin);

    if (typeof origin === "string" && effectiveAllowed.has(origin)) {
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
 * Helmet defaults + Content-Security-Policy.
 *
 * A CSP era desligada porque "a API não serve HTML" — mas desde o fix de
 * cookies o Express serve o web-build do app (mesmo domínio) e a página
 * /privacidade, então a CSP passou a importar. Fase 1: REPORT-ONLY —
 * o navegador registra violações no console sem bloquear nada (zero
 * risco de quebrar o app em produção). Quando o console ficar limpo,
 * trocar reportOnly para false.
 *
 * 'unsafe-inline' em script/style: o bootstrap do Expo web e o Metro
 * injetam inline; restringir exige nonce no HTML exportado (fase 2).
 */
export function createHelmetMiddleware(): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      reportOnly: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'", "'unsafe-inline'"],
        "style-src": [
          "'self'",
          "'unsafe-inline'",
          "https://fonts.googleapis.com",
        ],
        "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
        "img-src": ["'self'", "data:", "blob:", "https:"],
        "connect-src": ["'self'", "https:", "wss:"],
        "frame-ancestors": ["'none'"],
        "object-src": ["'none'"],
        "base-uri": ["'self'"],
        "form-action": ["'self'"],
        // Default do Helmet; o navegador avisa que é ignorada em
        // report-only. Volta quando a política virar enforce.
        "upgrade-insecure-requests": null,
      },
    },
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
export function createAuthRateLimit(
  options: RateLimitOptions = {},
): RequestHandler {
  if (options.disabled) return (_req, _res, next) => next();
  return expressRateLimit({
    windowMs: options.windowMs ?? 15 * 60 * 1000,
    max: options.max ?? 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: "Muitas tentativas de autenticação. Tente novamente mais tarde.",
    },
  });
}

export function createSignupRateLimit(
  options: RateLimitOptions = {},
): RequestHandler {
  if (options.disabled) return (_req, _res, next) => next();
  return expressRateLimit({
    windowMs: options.windowMs ?? 15 * 60 * 1000,
    max: options.max ?? 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: "Muitas tentativas de cadastro. Tente novamente mais tarde.",
    },
  });
}

/**
 * absorb burst traffic and block scrapers without affecting normal usage.
 *
 * Default: 200 requests per minute per IP.
 */
export function createGlobalRateLimit(
  options: RateLimitOptions = {},
): RequestHandler {
  if (options.disabled) return (_req, _res, next) => next();
  return expressRateLimit({
    windowMs: options.windowMs ?? 60 * 1000,
    max: options.max ?? 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Muitas requisições. Reduza a frequência." },
  });
}
