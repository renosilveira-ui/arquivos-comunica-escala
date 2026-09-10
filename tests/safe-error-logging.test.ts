import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createErrorHandler } from "../server/_core/error-handling";
import {
  findSafeErrorCode,
  safeErrorDiagnostic,
} from "../server/_core/safe-error";

const POISON_PARTS = [
  "password=test-only-password-value",
  "jwt=eyJ-test-header.fake-test-payload.fake-test-signature",
  "medico@example.test",
  "+5585987654321",
  "123.456.789-00",
  "otp=654321",
  "https://media.example.test/private?id=7&token=test-only-media-token",
  "params: [test-only-sql-parameter]",
  "mysql://test-user:test-password@db.example.test:3306/escalas_secret",
] as const;

const POISON = POISON_PARTS.join(" | ");

function poisonedDriverError(code: string = "ATTACKER_CODE") {
  const cause = Object.assign(new Error(POISON), {
    code,
    params: POISON_PARTS,
  });
  return Object.assign(new Error(`Failed query: ${POISON}`), {
    name: "DrizzleQueryError",
    query: `UPDATE users SET password_hash = ? /* ${POISON} */`,
    params: POISON_PARTS,
    cause,
  });
}

function expectNoPoison(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const part of POISON_PARTS) expect(serialized).not.toContain(part);
  expect(serialized).not.toContain("Failed query");
  expect(serialized).not.toContain("password_hash");
  expect(serialized).not.toContain("ATTACKER_CODE");
}

describe("safe error diagnostics", () => {
  it("projects a poisoned Drizzle-style error to a stable category only", () => {
    const first = safeErrorDiagnostic(poisonedDriverError(), "application");
    const second = safeErrorDiagnostic(poisonedDriverError(), "application");

    expect(first).toEqual({ errorCategory: "database" });
    expect(second).toEqual(first);
    expect(first).not.toHaveProperty("fingerprint");
    expectNoPoison(first);
  });

  it("keeps only allowlisted codes, including through a wrapped cause", () => {
    const diagnostic = safeErrorDiagnostic(
      poisonedDriverError("ER_ACCESS_DENIED_ERROR"),
      "application",
    );

    expect(
      findSafeErrorCode(poisonedDriverError("ER_ACCESS_DENIED_ERROR")),
    ).toBe("ER_ACCESS_DENIED_ERROR");
    expect(diagnostic).toEqual({
      errorCategory: "authentication",
      errorCode: "ER_ACCESS_DENIED_ERROR",
    });
    expectNoPoison(diagnostic);
  });

  it("does not invoke hostile getters while classifying an unknown throw", () => {
    const hostile = Object.defineProperties(
      {},
      {
        code: {
          get: () => {
            throw new Error(POISON);
          },
        },
        cause: {
          get: () => {
            throw new Error(POISON);
          },
        },
        message: {
          get: () => {
            throw new Error(POISON);
          },
        },
      },
    );

    expect(safeErrorDiagnostic(hostile, "application")).toEqual({
      errorCategory: "application",
    });

    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(safeErrorDiagnostic(revoked.proxy, "application")).toEqual({
      errorCategory: "application",
    });
  });
});

describe("central Express error logging", () => {
  it("preserves the 500 response and logs no payload, URL value or Error object", () => {
    const logger = { error: vi.fn() };
    const status = vi.fn();
    const json = vi.fn();
    status.mockReturnValue({ json });
    const next = vi.fn();

    createErrorHandler(logger)(
      poisonedDriverError(),
      {
        method: "GET",
        path: "/boom/test-only-url-token",
        originalUrl: "/boom/test-only-url-token?jwt=test-only-query-token",
        route: { path: "/boom/:secret" },
      } as never,
      { headersSent: false, status } as never,
      next,
    );

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      error: "Erro interno no servidor. Tente novamente em instantes.",
    });
    expect(next).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [metadata, message] = logger.error.mock.calls[0];
    expect(metadata).toEqual({
      errorCategory: "database",
      method: "GET",
      routeTemplate: "/boom/:secret",
    });
    expect(message).toBe("unhandled route error");
    expectNoPoison(metadata);
    expect(JSON.stringify(metadata)).not.toContain("test-only-url-token");
    expect(JSON.stringify(metadata)).not.toContain("test-only-query-token");
  });

  it("never forwards the original poisoned error after headers were sent", () => {
    const logger = { error: vi.fn() };
    const next = vi.fn();

    createErrorHandler(logger)(
      poisonedDriverError(),
      { method: "POST", route: { path: "/stream/:id" } } as never,
      { headersSent: true } as never,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    const forwarded = next.mock.calls[0][0] as Error;
    expect(forwarded).toBeInstanceOf(Error);
    expect(forwarded.stack).toBeUndefined();
    expectNoPoison(forwarded.message);
  });
});

describe("sensitive logging source contract", () => {
  const source = (path: string) =>
    readFileSync(join(process.cwd(), path), "utf8");

  it("routes the proven runtime surfaces through the safe projection", () => {
    const trpc = source("server/_core/trpc.ts");
    const handler = source("server/_core/error-handling.ts");
    const db = source("server/db.ts");
    const boot = source("server/_core/index.ts");
    const shutdown = source("server/_core/shutdown.ts");
    const auth = source("server/routes/auth.ts");

    for (const text of [trpc, handler, db, boot, shutdown, auth]) {
      expect(text).toContain("safeErrorDiagnostic");
    }
    expect(trpc).not.toContain("error.message.slice");
    expect(handler).not.toMatch(/\bstack\s*:/);
    expect(db).not.toContain("readErrorDetail");
    expect(db).not.toContain("Failed to connect:");
    expect(boot).not.toContain(".detail");
    expect(shutdown).not.toMatch(/\{\s*err:\s*err\.message/);
    expect(auth).not.toContain("String(error)");
  });
});
