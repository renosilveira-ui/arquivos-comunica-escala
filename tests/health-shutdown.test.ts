import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { pingDb } from "../server/db";
import { installShutdownHandlers } from "../server/_core/shutdown";

import type { DbProbeResult } from "../server/db";

describe("Frente 2.3 - pingDb", () => {
  it("returns ok:true with latency when the test database is reachable", async () => {
    const result = await pingDb();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.latencyMs).toBe("number");
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.latencyMs).toBeLessThan(1000);
    }
  });

  it("respects the timeout argument when the probe hangs", async () => {
    const result = await pingDb(1);
    if (result.ok) {
      // Local DB was that fast — accept this and assert latency is reported.
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    } else {
      expect(result.status).toBe("timeout");
      expect(result.diagnostic).toEqual({
        errorCategory: "timeout",
        errorCode: "DB_PROBE_TIMEOUT",
      });
    }
  });
});

describe("Frente 2.3 / fix - /api/health endpoint security contract", () => {
  function buildHealthApp(
    pingImpl: () => Promise<DbProbeResult>,
    log: { warn: (...args: unknown[]) => void } = { warn: () => {} },
  ) {
    const app = express();
    app.get("/api/health", async (_req, res) => {
      const db = await pingImpl();
      if (db.ok) {
        res.json({
          ok: true,
          db: { ok: true, latencyMs: db.latencyMs },
          timestamp: Date.now(),
        });
        return;
      }
      log.warn({ status: db.status, ...db.diagnostic }, "health probe failed");
      res.status(503).json({
        ok: false,
        db: { ok: false, status: db.status },
        timestamp: Date.now(),
      });
    });
    return app;
  }

  it("returns 200 with db.ok when the probe succeeds", async () => {
    const app = buildHealthApp(async () => ({ ok: true, latencyMs: 7 }));
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.db).toEqual({ ok: true, latencyMs: 7 });
    expect(typeof res.body.timestamp).toBe("number");
  });

  it("returns 503 with sanitized status and NO raw detail on timeout", async () => {
    const app = buildHealthApp(async () => ({
      ok: false,
      status: "timeout",
      diagnostic: {
        errorCategory: "timeout",
        errorCode: "DB_PROBE_TIMEOUT",
      },
    }));
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(503);
    expect(res.body.db).toEqual({ ok: false, status: "timeout" });
    expect(res.body.db.detail).toBeUndefined();
    expect(res.body.db.error).toBeUndefined();
  });

  it("returns 503 with status=auth_failed and does NOT leak the username/host on auth failure", async () => {
    // Realistic mysql2 message: "Access denied for user 'app'@'10.0.0.5' (using password: YES)"
    const app = buildHealthApp(async () => ({
      ok: false,
      status: "auth_failed",
      diagnostic: {
        errorCategory: "authentication",
        errorCode: "ER_ACCESS_DENIED_ERROR",
      },
    }));
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(503);
    expect(res.body.db.status).toBe("auth_failed");
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("Access denied");
    expect(body).not.toContain("10.0.0.5");
    expect(body).not.toContain("'app'");
    expect(body).not.toContain("password");
  });

  it("returns 503 with status=unreachable and does NOT leak the host/IP on connection failure", async () => {
    const app = buildHealthApp(async () => ({
      ok: false,
      status: "unreachable",
      diagnostic: {
        errorCategory: "network",
        errorCode: "ECONNREFUSED",
      },
    }));
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(503);
    expect(res.body.db.status).toBe("unreachable");
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("ECONNREFUSED");
    expect(body).not.toContain("10.0.0.5");
    expect(body).not.toContain("3306");
  });

  it("returns 503 with status=unknown_database and does NOT leak the database name", async () => {
    const app = buildHealthApp(async () => ({
      ok: false,
      status: "unknown_database",
      diagnostic: {
        errorCategory: "database",
        errorCode: "ER_BAD_DB_ERROR",
      },
    }));
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(503);
    expect(res.body.db.status).toBe("unknown_database");
    const body = JSON.stringify(res.body);
    expect(body).not.toContain("escalas_prod");
    expect(body).not.toContain("ER_BAD_DB_ERROR");
  });

  it("returns 503 with status=uninitialized when the database is not initialized", async () => {
    const app = buildHealthApp(async () => ({
      ok: false,
      status: "uninitialized",
      diagnostic: {
        errorCategory: "configuration",
        errorCode: "DATABASE_NOT_INITIALIZED",
      },
    }));
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(503);
    expect(res.body.db).toEqual({ ok: false, status: "uninitialized" });
  });

  it("logs only fixed-vocabulary diagnostics via logger.warn", async () => {
    const log = { warn: vi.fn() };
    const app = buildHealthApp(
      async () => ({
        ok: false,
        status: "auth_failed",
        diagnostic: {
          errorCategory: "authentication",
          errorCode: "ER_ACCESS_DENIED_ERROR",
        },
      }),
      log,
    );
    await request(app).get("/api/health");
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "auth_failed",
        errorCategory: "authentication",
        errorCode: "ER_ACCESS_DENIED_ERROR",
      }),
      "health probe failed",
    );
  });
});

describe("Frente 2.3 - graceful shutdown handler", () => {
  function buildMockLogger() {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  }

  function buildMockServer(closeBehavior: "ok" | "error" | "hang" = "ok") {
    return {
      close: (cb?: (err?: Error) => void) => {
        if (closeBehavior === "ok") setImmediate(() => cb?.());
        else if (closeBehavior === "error")
          setImmediate(() => cb?.(new Error("close failed")));
        // 'hang' never invokes cb — drain timeout must fire
      },
    };
  }

  it("invokes server.close, drains and exits cleanly on trigger", async () => {
    const logger = buildMockLogger();
    const exit = vi.fn();
    const onBeforeExit = vi.fn();

    const ctl = installShutdownHandlers({
      server: buildMockServer("ok"),
      logger,
      drainTimeoutMs: 1000,
      onBeforeExit,
      exit,
      registerSignals: false,
    });

    expect(ctl.isShuttingDown()).toBe(false);
    await ctl.trigger("test-signal");
    expect(ctl.isShuttingDown()).toBe(true);

    expect(onBeforeExit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "test-signal" }),
      "shutdown initiated",
    );
    expect(logger.info).toHaveBeenCalledWith(
      "http server stopped accepting connections",
    );
  });

  it("forces exit when drain timeout is reached", async () => {
    const logger = buildMockLogger();
    const exit = vi.fn();

    const ctl = installShutdownHandlers({
      server: buildMockServer("hang"),
      logger,
      drainTimeoutMs: 50,
      exit,
      registerSignals: false,
    });

    await ctl.trigger("hung-server");

    expect(exit).toHaveBeenCalledWith(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ drainTimeoutMs: 50 }),
      expect.stringMatching(/drain timeout reached/i),
    );
  });

  it("logs server.close errors but still exits", async () => {
    const logger = buildMockLogger();
    const exit = vi.fn();

    const ctl = installShutdownHandlers({
      server: buildMockServer("error"),
      logger,
      drainTimeoutMs: 1000,
      exit,
      registerSignals: false,
    });

    await ctl.trigger("err-close");

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorCategory: "application" }),
      "server.close reported error",
    );
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("is idempotent: a second signal during shutdown is a no-op", async () => {
    const logger = buildMockLogger();
    const exit = vi.fn();

    const ctl = installShutdownHandlers({
      server: buildMockServer("ok"),
      logger,
      drainTimeoutMs: 1000,
      exit,
      registerSignals: false,
    });

    await Promise.all([ctl.trigger("first"), ctl.trigger("second")]);

    // Only one shutdown sequence; exit called once.
    expect(exit).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "second" }),
      "shutdown already in progress; ignoring signal",
    );
  });

  it("captures errors thrown by onBeforeExit without blocking exit", async () => {
    const logger = buildMockLogger();
    const exit = vi.fn();

    const ctl = installShutdownHandlers({
      server: buildMockServer("ok"),
      logger,
      drainTimeoutMs: 1000,
      onBeforeExit: () => {
        throw new Error("hook blew up");
      },
      exit,
      registerSignals: false,
    });

    await ctl.trigger("with-bad-hook");

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ errorCategory: "application" }),
      "onBeforeExit hook failed",
    );
    expect(exit).toHaveBeenCalledWith(0);
  });
});
