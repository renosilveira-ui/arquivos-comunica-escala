// tests/session-events.test.ts — sinal de sessão não reconhecida pelo
// servidor (abertura do app a partir do cache, 23/08).

import { describe, expect, it, vi } from "vitest";
import { emitSessionUnauthorized, isUnauthorizedError, onSessionUnauthorized } from "../lib/session-events";

describe("sinal de sessão não autorizada", () => {
  it("reconhece só UNAUTHORIZED do tRPC — FORBIDDEN é falta de permissão, não sessão morta", () => {
    expect(isUnauthorizedError({ data: { code: "UNAUTHORIZED" }, message: "x" })).toBe(true);
    expect(isUnauthorizedError({ data: { code: "FORBIDDEN" } })).toBe(false);
    expect(isUnauthorizedError({ data: { code: "INTERNAL_SERVER_ERROR" } })).toBe(false);
    expect(isUnauthorizedError(new TypeError("Network request failed"))).toBe(false);
    expect(isUnauthorizedError(null)).toBe(false);
    expect(isUnauthorizedError("UNAUTHORIZED")).toBe(false);
  });

  it("entrega o sinal a quem está inscrito e para ao cancelar a inscrição", () => {
    const listener = vi.fn();
    const off = onSessionUnauthorized(listener);
    emitSessionUnauthorized();
    emitSessionUnauthorized();
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    emitSessionUnauthorized();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
