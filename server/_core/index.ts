import "./setup-globals";
import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { authRouter } from "../routes/auth";
import { adminRouter } from "../routes/admin";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { assertProductionSecrets } from "./env-validation";
import {
  PAYLOAD_LIMIT,
  createAuthRateLimit,
  createCorsMiddleware,
  createGlobalRateLimit,
  createHelmetMiddleware,
} from "./security";

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

  app.use(createHelmetMiddleware());
  app.use(createCorsMiddleware({ allowedOrigins }));

  // Health check is registered BEFORE rate limiting so probes (Render, uptime
  // monitors) are never throttled.
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, timestamp: Date.now() });
  });

  app.use(createGlobalRateLimit());

  app.use(express.json({ limit: PAYLOAD_LIMIT }));
  app.use(express.urlencoded({ limit: PAYLOAD_LIMIT, extended: true }));

  registerOAuthRoutes(app);
  app.use("/api/auth", createAuthRateLimit(), authRouter);
  app.use("/api/admin", adminRouter);

  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    }),
  );

  const port = parseInt(process.env.PORT || "3000", 10);
  const portFree = await isPortAvailable(port);
  if (!portFree) {
    throw new Error(
      `Port ${port} is already in use. Stop the conflicting process and retry (fixed API port policy).`,
    );
  }

  server.listen(port, "0.0.0.0", () => {
    console.log(`[api] server listening on 0.0.0.0:${port}`);
  });
}

startServer().catch(console.error);
