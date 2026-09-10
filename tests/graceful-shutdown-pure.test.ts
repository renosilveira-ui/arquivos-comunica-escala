import { afterEach, describe, expect, it, vi } from "vitest";
import { installShutdownHandlers } from "../server/_core/shutdown";

function buildMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("graceful shutdown: orçamento global", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("aguarda o hook em execução quando ele drena dentro do prazo", async () => {
    let release!: () => void;
    const hookGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const exit = vi.fn();
    const close = vi.fn((callback?: (error?: Error) => void) => callback?.());
    const controller = installShutdownHandlers({
      server: { close },
      logger: buildMockLogger(),
      drainTimeoutMs: 1_000,
      onBeforeExit: () => hookGate,
      exit,
      registerSignals: false,
    });

    const shutdown = controller.trigger("test");
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    release();
    await shutdown;
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("força saída se o hook excede o mesmo prazo global do HTTP", async () => {
    vi.useFakeTimers();
    const logger = buildMockLogger();
    const exit = vi.fn();
    const neverFinishes = new Promise<void>(() => {});
    const controller = installShutdownHandlers({
      server: { close: (callback) => callback?.() },
      logger,
      drainTimeoutMs: 50,
      onBeforeExit: () => neverFinishes,
      exit,
      registerSignals: false,
    });

    const shutdown = controller.trigger("hung-auth-worker");
    await vi.advanceTimersByTimeAsync(49);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await shutdown;

    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(logger.warn).toHaveBeenCalledWith(
      { drainTimeoutMs: 50 },
      expect.stringMatching(/drain timeout reached/i),
    );
  });
});
