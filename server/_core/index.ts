import "./setup-globals";
import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { existsSync } from "fs";
import { join } from "path";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { hospitalAlertRouter } from "../routes/hospital-alert";
import { authRouter } from "../routes/auth";
import { adminRouter } from "../routes/admin";
import { privacyRouter } from "../routes/privacy";
import { ssoRouter } from "../sso/router";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { sessionInstanceConstraintHttpStatus } from "./trpc";
import { setStaticCacheHeaders } from "./static-cache";
import { assertProductionSecrets } from "./env-validation";
import { logger } from "./logger";
import {
  PAYLOAD_LIMIT,
  createAuthRateLimit,
  createSignupRateLimit,
  createCorsMiddleware,
  createGlobalRateLimit,
  createHelmetMiddleware,
} from "./security";
import { installShutdownHandlers } from "./shutdown";
import {
  createErrorHandler,
  installAsyncRouteForwarding,
  installProcessGuards,
} from "./error-handling";
import { pingDb } from "../db";
import { startConfirmationCron } from "../cron/shift-confirmation-dispatcher";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function startServer() {
  // Erro de rota não pode derrubar o processo (ver error-handling.ts).
  installAsyncRouteForwarding();
  installProcessGuards(logger);
  assertProductionSecrets();

  const app = express();
  const server = createServer(app);

  // Render (and most PaaS) terminate TLS at a proxy and forward via
  // X-Forwarded-For. Without trust proxy, express-rate-limit sees only the
  // proxy IP and the limiter is effectively disabled.
  app.set("trust proxy", 1);

  const defaultDevOrigins = new Set([
    "http://localhost:8081",
    "http://localhost:3000",
    "http://localhost:3001",
  ]);
  const expoApiUrl = (process.env.EXPO_PUBLIC_API_URL ?? "").trim();
  if (expoApiUrl) {
    try {
      const parsed = new URL(expoApiUrl);
      defaultDevOrigins.add(`${parsed.protocol}//${parsed.hostname}:8081`);
    } catch {
      // Ignore invalid URL and keep safe defaults.
    }
  }
  const envOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  const allowedOrigins = new Set(
    envOrigins.length > 0
      ? envOrigins
      : process.env.NODE_ENV === "production"
        ? []
        : Array.from(defaultDevOrigins),
  );

  // Hosts em que a requisição same-origin é confiável (Host é controlável
  // pelo cliente; ver createCorsMiddleware). Render expõe o hostname
  // público em RENDER_EXTERNAL_HOSTNAME; dev usa localhost:PORT.
  const listenPort = process.env.PORT || "3000";
  const trustedHosts = new Set<string>([
    `localhost:${listenPort}`,
    `127.0.0.1:${listenPort}`,
    ...(process.env.RENDER_EXTERNAL_HOSTNAME
      ? [process.env.RENDER_EXTERNAL_HOSTNAME]
      : []),
    ...(process.env.TRUSTED_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
  ]);

  app.use(createHelmetMiddleware());
  app.use(createCorsMiddleware({ allowedOrigins, trustedHosts }));

  // Health check is registered BEFORE rate limiting so probes (Render, uptime
  // monitors) are never throttled. Probes the database with a short timeout
  // and returns 503 if the DB is unreachable, so the orchestrator can route
  // around a half-broken instance instead of declaring it healthy.
  //
  // Security: the response body MUST NOT contain raw driver error messages.
  // mysql2 errors embed internal hostnames, IPs, usernames and database
  // names; exposing them on an unauthenticated endpoint is CWE-209
  // information disclosure. Only a fixed-vocabulary `status` label is
  // returned; the full driver detail is logged server-side.
  app.get("/api/health", async (_req, res) => {
    const db = await pingDb();
    if (db.ok) {
      res.json({
        ok: true,
        db: { ok: true, latencyMs: db.latencyMs },
        timestamp: Date.now(),
      });
      return;
    }
    logger.warn(
      { status: db.status, detail: db.detail },
      "health probe failed",
    );
    res
      .status(503)
      .json({
        ok: false,
        db: { ok: false, status: db.status },
        timestamp: Date.now(),
      });
  });

  app.use(createGlobalRateLimit());

  app.use(express.json({ limit: PAYLOAD_LIMIT }));
  app.use(express.urlencoded({ limit: PAYLOAD_LIMIT, extended: true }));

  registerOAuthRoutes(app);
  app.use("/api/integrations/hospital-alert", hospitalAlertRouter);
  // Rate limit só em mutações (login, register, reset…): GET /api/auth/me
  // roda a cada abertura do app — 20/15min por IP bloqueava clínicas
  // inteiras atrás de NAT (auditoria 22/08 parte 2).
  const authRateLimit = createAuthRateLimit();
  const signupRateLimit = createSignupRateLimit();
  app.use(
    "/api/auth",
    (req, res, next) => {
      if (req.method === "GET") return next();
      if (req.path === "/signup" || req.path === "/signup-institutions") {
        return signupRateLimit(req, res, next);
      }
      return authRateLimit(req, res, next);
    },
    authRouter,
  );
  app.use("/api/admin", adminRouter);
  // Página pública da Política de Privacidade (App Store + LGPD)
  app.use(privacyRouter);
  app.use("/.well-known", ssoRouter);
  app.use("/api/sso", ssoRouter);

  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
      responseMeta({ errors }) {
        const status = sessionInstanceConstraintHttpStatus(errors);
        return status ? { status } : {};
      },
    }),
  );

  // Serve Expo web build from the same origin (eliminates cross-origin
  // cookie issues). In production the `web-build/` directory is created by
  // `pnpm build:web` during the Render build step. API routes are registered
  // above and take priority; the static middleware only handles non-API paths.
  // The catch-all sends index.html for any unmatched route so that Expo
  // Router's client-side routing works (deep links, refresh on /agenda, etc.).
  const webBuildPath = join(process.cwd(), "web-build");
  if (existsSync(webBuildPath)) {
    app.use(
      express.static(webBuildPath, {
        index: false,
        setHeaders: setStaticCacheHeaders,
      }),
    );
    app.get("*", (req, res, next) => {
      // Don't intercept API or tRPC routes
      if (
        req.path.startsWith("/api/") ||
        req.path.startsWith("/.well-known/")
      ) {
        return next();
      }
      res.sendFile(join(webBuildPath, "index.html"), {
        headers: { "Cache-Control": "no-cache" },
      });
    });
    logger.info({ path: webBuildPath }, "serving web build from same origin");
  }

  // Último da cadeia: qualquer erro encaminhado por next(err) vira 500 JSON.
  app.use(createErrorHandler(logger));

  const port = parseInt(process.env.PORT || "3000", 10);
  const portFree = await isPortAvailable(port);
  if (!portFree) {
    throw new Error(
      `Port ${port} is already in use. Stop the conflicting process and retry (fixed API port policy).`,
    );
  }

  // Aquece o pool ANTES de aceitar tráfego. A primeira conexão ao MySQL
  // gerenciado (outra região, TLS) custa de centenas de ms a alguns
  // segundos numa instância free; sem isto quem pagava esse handshake era
  // o primeiro pedido real do app — ou o health check do Render, que com
  // 2 s de timeout respondia 503 e derrubava o deploy. Falha aqui não
  // impede o listen: /api/health continua reportando o estado real.
  // Segurar o bind por até 8 s é seguro: a janela de detecção de porta do
  // Render é de minutos (03:05:38 listening → 03:19:47 timeout, 23/08).
  const warm = await pingDb(8000);
  if (warm.ok) {
    logger.info({ latencyMs: warm.latencyMs }, "db pool warm");
  } else {
    logger.warn(
      { status: warm.status, detail: warm.detail },
      "db warm-up failed; listening anyway",
    );
  }

  server.listen(port, "0.0.0.0", () => {
    logger.info(
      { port, env: process.env.NODE_ENV ?? "unset" },
      "api server listening",
    );
    startConfirmationCron();
  });

  installShutdownHandlers({ server, logger });
}

startServer().catch((err) => {
  logger.fatal(
    { err: err instanceof Error ? err.message : String(err) },
    "server failed to start",
  );
  process.exit(1);
});
