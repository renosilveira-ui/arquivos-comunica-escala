import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTHORIZATION_GATE_STALL_MS,
  REQUEST_DEADLINE_MS,
  isNetInfoOnline,
  withRequestDeadline,
} from "../lib/request-deadline";

describe("prazo de abertura e rede", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("considera online se a conexão não foi negada", () => {
    expect(isNetInfoOnline({ isConnected: true })).toBe(true);
    expect(isNetInfoOnline({ isConnected: null })).toBe(true);
    expect(isNetInfoOnline({ isConnected: false })).toBe(false);
  });

  it("aborta após o prazo e aceita abort do caller", () => {
    const deadline = withRequestDeadline(undefined, 1_000);
    expect(deadline.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1_000);
    expect(deadline.signal.aborted).toBe(true);
    deadline.cleanup();

    const caller = new AbortController();
    const nested = withRequestDeadline(caller.signal, 5_000);
    caller.abort();
    expect(nested.signal.aborted).toBe(true);
    nested.cleanup();
  });

  it("o watchdog do portão é maior que o prazo do pedido", () => {
    expect(AUTHORIZATION_GATE_STALL_MS).toBeGreaterThan(REQUEST_DEADLINE_MS);
  });
});
