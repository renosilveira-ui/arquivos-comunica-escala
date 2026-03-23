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
  const app = express();
  const server = createServer(app);
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
  const allowedHeaders = [
    "Origin",
    "X-Requested-With",
    "Content-Type",
    "Accept",
    "Authorization",
    "x-tenant-id",
    "x-test-user-id",
  ].join(", ");

  // CORS from env (production) with localhost fallback only in non-production.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.header("Access-Control-Allow-Origin", origin);
      res.header("Vary", "Origin");
    }
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", allowedHeaders);
    res.header("Access-Control-Allow-Credentials", "true");

    // Handle preflight requests
    if (req.method === "OPTIONS") {
      res.sendStatus(200);
      return;
    }
    next();
  });

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  registerOAuthRoutes(app);
  app.use("/api/auth", authRouter);
  app.use("/api/admin", adminRouter);

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, timestamp: Date.now() });
  });

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
