import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import {
  PAYLOAD_LIMIT,
  createAuthRateLimit,
  createCorsMiddleware,
  createGlobalRateLimit,
  createHelmetMiddleware,
} from "../server/_core/security";

function buildApp(allowedOrigins: string[]) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(createHelmetMiddleware());
  app.use(createCorsMiddleware({ allowedOrigins: new Set(allowedOrigins) }));
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.use(express.json({ limit: PAYLOAD_LIMIT }));
  app.post("/echo", (req, res) => res.json({ body: req.body }));
  return app;
}

describe("Frente 2.2 - helmet", () => {
  it("sets standard helmet security headers", async () => {
    const app = buildApp(["https://app.example.com"]);
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-dns-prefetch-control"]).toBe("off");
    expect(res.headers["strict-transport-security"]).toBeDefined();
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
    // CSP intentionally disabled on the JSON API (belongs on the frontend).
    expect(res.headers["content-security-policy"]).toBeUndefined();
  });

  it("does not leak the X-Powered-By: Express header", async () => {
    const app = buildApp(["https://app.example.com"]);
    const res = await request(app).get("/api/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});

describe("Frente 2.2 - CORS hardening", () => {
  it("echoes Access-Control-Allow-Origin and Allow-Credentials for an allowed origin", async () => {
    const app = buildApp(["https://app.example.com"]);
    const res = await request(app)
      .get("/api/health")
      .set("Origin", "https://app.example.com");
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://app.example.com",
    );
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers["vary"]).toContain("Origin");
  });

  it("does NOT set Allow-Origin or Allow-Credentials for a disallowed origin", async () => {
    const app = buildApp(["https://app.example.com"]);
    const res = await request(app)
      .get("/api/health")
      .set("Origin", "https://evil.example.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("does NOT set Allow-Credentials when no Origin header is present", async () => {
    const app = buildApp(["https://app.example.com"]);
    const res = await request(app).get("/api/health");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("answers OPTIONS preflight with 204 for an allowed origin", async () => {
    const app = buildApp(["https://app.example.com"]);
    const res = await request(app)
      .options("/api/health")
      .set("Origin", "https://app.example.com")
      .set("Access-Control-Request-Method", "GET");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://app.example.com",
    );
  });

  it("REJECTS OPTIONS preflight with 403 from a disallowed origin", async () => {
    const app = buildApp(["https://app.example.com"]);
    const res = await request(app)
      .options("/api/health")
      .set("Origin", "https://evil.example.com")
      .set("Access-Control-Request-Method", "POST");
    expect(res.status).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects an empty allow-list (production with no CORS_ALLOWED_ORIGINS)", async () => {
    const app = buildApp([]);
    const res = await request(app)
      .get("/api/health")
      .set("Origin", "https://app.example.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });
});

describe("Frente 2.2 - payload size limit", () => {
  it("accepts a small JSON body", async () => {
    const app = buildApp(["https://app.example.com"]);
    const res = await request(app)
      .post("/echo")
      .set("Content-Type", "application/json")
      .send({ hello: "world" });
    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({ hello: "world" });
  });

  it("rejects a JSON body larger than the configured limit", async () => {
    const app = buildApp(["https://app.example.com"]);
    // 2 MB string — well above the 1mb default.
    const oversized = { payload: "x".repeat(2 * 1024 * 1024) };
    const res = await request(app)
      .post("/echo")
      .set("Content-Type", "application/json")
      .send(oversized);
    expect(res.status).toBe(413);
  });

  it("PAYLOAD_LIMIT default is 1mb (regression guard)", () => {
    expect(PAYLOAD_LIMIT).toBe("1mb");
  });
});

describe("Frente 2.2 - rate limiting", () => {
  it("authRateLimit returns 429 after the configured threshold", async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.use("/api/auth", createAuthRateLimit({ windowMs: 60_000, max: 3 }));
    app.post("/api/auth/login", (_req, res) => res.json({ ok: true }));

    // 3 allowed
    for (let i = 0; i < 3; i++) {
      const res = await request(app).post("/api/auth/login").send({});
      expect(res.status).toBe(200);
    }
    // 4th blocked
    const blocked = await request(app).post("/api/auth/login").send({});
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/tentativas de autenticação/i);
  });

  it("authRateLimit emits standard RateLimit-* headers", async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.use("/api/auth", createAuthRateLimit({ windowMs: 60_000, max: 5 }));
    app.post("/api/auth/login", (_req, res) => res.json({ ok: true }));

    const res = await request(app).post("/api/auth/login").send({});
    expect(res.status).toBe(200);
    expect(res.headers["ratelimit-limit"]).toBe("5");
    expect(res.headers["ratelimit-remaining"]).toBe("4");
  });

  it("globalRateLimit returns 429 after the configured threshold", async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.use(createGlobalRateLimit({ windowMs: 60_000, max: 5 }));
    app.get("/anything", (_req, res) => res.json({ ok: true }));

    for (let i = 0; i < 5; i++) {
      const res = await request(app).get("/anything");
      expect(res.status).toBe(200);
    }
    const blocked = await request(app).get("/anything");
    expect(blocked.status).toBe(429);
  });

  it("disabled rate limit is a no-op", async () => {
    const app = express();
    app.use(createGlobalRateLimit({ disabled: true, max: 1 }));
    app.get("/anything", (_req, res) => res.json({ ok: true }));

    for (let i = 0; i < 5; i++) {
      const res = await request(app).get("/anything");
      expect(res.status).toBe(200);
    }
  });
});

describe("Frente 2.2 - integration order (health bypasses rate limit)", () => {
  it("health check is reachable even after exceeding global rate limit", async () => {
    const app = express();
    app.set("trust proxy", 1);
    // Health BEFORE rate limit, mirroring index.ts order.
    app.get("/api/health", (_req, res) => res.json({ ok: true }));
    app.use(createGlobalRateLimit({ windowMs: 60_000, max: 2 }));
    app.get("/anything", (_req, res) => res.json({ ok: true }));

    // Burn the budget on /anything
    await request(app).get("/anything");
    await request(app).get("/anything");
    const blocked = await request(app).get("/anything");
    expect(blocked.status).toBe(429);

    // Health still 200
    const health = await request(app).get("/api/health");
    expect(health.status).toBe(200);
  });
});
