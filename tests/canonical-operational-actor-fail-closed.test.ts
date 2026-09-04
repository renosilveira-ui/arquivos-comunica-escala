import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../server/db";
import { logger } from "../server/_core/logger";
import {
  isCanonicalOperationalActorInfraFailure,
  resolveCanonicalOperationalActorForUser,
  type CanonicalOperationalActorResolution,
} from "../server/_core/canonical-operational-actor";

vi.mock("../server/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/db")>();
  return {
    ...actual,
    getDb: vi.fn(actual.getDb),
  };
});

async function restoreGetDb(): Promise<void> {
  const actual = await vi.importActual<typeof import("../server/db")>(
    "../server/db",
  );
  vi.mocked(getDb).mockReset();
  vi.mocked(getDb).mockImplementation(actual.getDb);
}

function thenable<T>(result: Promise<T>) {
  const query: {
    from: () => unknown;
    leftJoin: () => unknown;
    where: () => unknown;
    then: Promise<T>["then"];
    catch: Promise<T>["catch"];
  } = {
    from: () => query,
    leftJoin: () => query,
    where: () => query,
    then: (onFulfilled, onRejected) => result.then(onFulfilled, onRejected),
    catch: (onRejected) => result.catch(onRejected),
  };
  return query;
}

const SECRET =
  "mysql://root:s3cret@db-host.internal:3306/escalas ECONNREFUSED DATABASE_URL";

function expectInfra(
  result: CanonicalOperationalActorResolution,
  code: "DB_UNAVAILABLE" | "PERSISTENCE_FAILED",
) {
  expect(result).toEqual({ ok: false, code });
  expect(isCanonicalOperationalActorInfraFailure(result)).toBe(true);
  expect(result).not.toHaveProperty("actor");
  expect(result).not.toMatchObject({ code: "ACTOR_NOT_FOUND" });
  expect(result).not.toMatchObject({ code: "ACTOR_PROFESSIONAL_NOT_FOUND" });
  expect(result).not.toMatchObject({
    code: "ACTOR_INSTITUTION_MEMBERSHIP_NOT_FOUND",
  });
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("mysql://");
  expect(serialized).not.toContain("s3cret");
  expect(serialized).not.toContain("db-host");
  expect(serialized).not.toContain("ECONNREFUSED");
  expect(serialized).not.toContain("DATABASE_URL");
  expect(serialized).not.toMatch(/at\s+\S+\s+\(/);
}

describe("Canonical operational actor — fail-closed de infra", () => {
  afterEach(async () => {
    await restoreGetDb();
  });

  it("getDb null → DB_UNAVAILABLE, nunca NOT_FOUND", async () => {
    vi.mocked(getDb).mockResolvedValue(null);
    const result = await resolveCanonicalOperationalActorForUser({ userId: 7 });
    expectInfra(result, "DB_UNAVAILABLE");
  });

  it("getDb throws → PERSISTENCE_FAILED sem vazar erro cru", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(logger, "info").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((value) => String(value)).join(" "));
      return logger;
    });
    vi.mocked(getDb).mockRejectedValue(new Error(SECRET));
    const result = await resolveCanonicalOperationalActorForUser({ userId: 7 });
    spy.mockRestore();
    expectInfra(result, "PERSISTENCE_FAILED");
    const joined = lines.join("\n");
    expect(joined).not.toContain(SECRET);
    expect(joined).not.toContain("s3cret");
    expect(joined).not.toContain("db-host");
    expect(joined).toContain("PERSISTENCE_FAILED");
  });

  it("SELECT throws → PERSISTENCE_FAILED, não ausência de ator", async () => {
    vi.mocked(getDb).mockResolvedValue({
      select() {
        throw new Error(SECRET);
      },
    } as never);
    const result = await resolveCanonicalOperationalActorForUser({ userId: 7 });
    expectInfra(result, "PERSISTENCE_FAILED");
  });

  it("SELECT thenable rejeitado → PERSISTENCE_FAILED sem stack/SQL", async () => {
    vi.mocked(getDb).mockResolvedValue({
      select: () => thenable(Promise.reject(new Error(`Failed query: SELECT 1 ${SECRET}`))),
    } as never);
    const result = await resolveCanonicalOperationalActorForUser({ userId: 7 });
    expectInfra(result, "PERSISTENCE_FAILED");
  });
});
