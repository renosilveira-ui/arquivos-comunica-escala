// server/_core/shutdown.ts
//
// Graceful shutdown handler. Render (and most container schedulers) send
// SIGTERM N seconds before SIGKILL on every deploy. Without a handler,
// in-flight requests are dropped mid-response, which on the Escala API
// translates to lost auth attempts, partially-applied schedule edits and
// 500-style errors visible to clinical users mid-action.
//
// Behavior:
//   1. Receives SIGTERM/SIGINT.
//   2. Stops accepting NEW connections (server.close).
//   3. Waits up to `drainTimeoutMs` for in-flight to complete.
//   4. Forces process exit when drain finishes (or times out).
//
// The handler is idempotent — repeated signals during shutdown are ignored
// instead of duplicating the drain (which would race the close callback).

import type { Server } from "http";
import type { Logger } from "./logger";

export interface ShutdownOptions {
  server: Pick<Server, "close">;
  logger: Pick<Logger, "info" | "warn" | "error">;
  /** Maximum time to wait for in-flight requests before forcing exit. */
  drainTimeoutMs?: number;
  /** Hooks invoked AFTER the HTTP server stops accepting connections. */
  onBeforeExit?: () => Promise<void> | void;
  /** Test seam: replaces process.exit so tests do not kill the runner. */
  exit?: (code: number) => void;
  /**
   * Register process-level SIGTERM/SIGINT listeners. Defaults to true.
   * Tests pass false to avoid accumulating listeners across runs.
   */
  registerSignals?: boolean;
}

export interface ShutdownController {
  /** Manually trigger the shutdown sequence with a synthetic signal name. */
  trigger(reason: string): Promise<void>;
  /** True after a signal has been received. */
  isShuttingDown(): boolean;
}

export function installShutdownHandlers(
  options: ShutdownOptions,
): ShutdownController {
  const {
    server,
    logger,
    drainTimeoutMs = 25_000,
    onBeforeExit,
    exit = (code) => process.exit(code),
    registerSignals = true,
  } = options;

  let shuttingDown = false;

  async function shutdown(reason: string): Promise<void> {
    if (shuttingDown) {
      logger.info({ reason }, "shutdown already in progress; ignoring signal");
      return;
    }
    shuttingDown = true;
    logger.info({ reason, drainTimeoutMs }, "shutdown initiated");

    const drainPromise = new Promise<void>((resolve) => {
      server.close((err) => {
        if (err) {
          logger.warn({ err: err.message }, "server.close reported error");
        } else {
          logger.info("http server stopped accepting connections");
        }
        resolve();
      });
    });

    const timeoutPromise = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), drainTimeoutMs),
    );

    const result = await Promise.race([drainPromise, timeoutPromise]);
    if (result === "timeout") {
      logger.warn(
        { drainTimeoutMs },
        "drain timeout reached; forcing exit with in-flight requests still open",
      );
    }

    if (onBeforeExit) {
      try {
        await onBeforeExit();
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          "onBeforeExit hook failed",
        );
      }
    }

    exit(0);
  }

  if (registerSignals) {
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  }

  return {
    trigger: shutdown,
    isShuttingDown: () => shuttingDown,
  };
}
