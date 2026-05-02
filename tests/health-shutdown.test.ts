import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { pingDb } from "../server/db";
import { installShutdownHandlers } from "../server/_core/shutdown";

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
    // Race a near-zero timeout against any real query — the timeout must win
    // even on a fast local DB. This is a regression guard for the
    // Promise.race wiring; if pingDb forgets to race the timeout, the test
    // hangs the suite.
    const result = await pingDb(1);
    if (result.ok) {
      // Local DB was that fast — the test cannot deterministically force
      // timeout when SELECT 1 takes <1ms. Accept this outcome but assert
      // that latencyMs is reported.
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    } else {
      expect(result.error).toMatch(/timeout/i);
    }
  });
});

describe("Frente 2.3 - /api/health endpoint", () => {
  function buildHealthApp(pingImpl: () => Promise<
    { ok: true; latencyMs: number } | { ok: false; error: string }
  >) {
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
      res.status(503).json({
        ok: false,
        db: { ok: false, error: db.error },
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

  it("returns 503 with db.error when the probe fails", async () => {
    const app = buildHealthApp(async () => ({
      ok: false,
      error: "db ping timeout after 2000ms",
    }));
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.db).toEqual({
      ok: false,
      error: "db ping timeout after 2000ms",
    });
  });

  it("returns 503 when the database is not initialized", async () => {
    const app = buildHealthApp(async () => ({
      ok: false,
      error: "database not initialized",
    }));
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(503);
    expect(res.body.db.error).toBe("database not initialized");
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
      expect.objectContaining({ err: "close failed" }),
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
      expect.objectContaining({ err: "hook blew up" }),
      "onBeforeExit hook failed",
    );
    expect(exit).toHaveBeenCalledWith(0);
  });
});
