import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../server/db";
import { logger } from "../server/_core/logger";
import {
  cancelWhatsAppPendingIntent,
  clearExpiredWhatsAppPendingIntents,
  createWhatsAppPendingIntent,
  expireWhatsAppPendingIntent,
  getOpenWhatsAppPendingIntentForUser,
  getWhatsAppPendingIntentByIdForUser,
  getWhatsAppPendingIntentBySourceForUser,
} from "../server/integrations/whatsapp/pending-intent-store";
import { isWhatsAppPendingCleanupFailure } from "../server/integrations/whatsapp/pending-intent-types";

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
    where: () => unknown;
    limit: () => unknown;
    set: () => unknown;
    values: () => unknown;
    $returningId: () => Promise<T>;
    then: Promise<T>["then"];
    catch: Promise<T>["catch"];
  } = {
    from: () => query,
    where: () => query,
    limit: () => query,
    set: () => query,
    values: () => query,
    $returningId: () => result,
    then: (onFulfilled, onRejected) => result.then(onFulfilled, onRejected),
    catch: (onRejected) => result.catch(onRejected),
  };
  return query;
}

function expectInfra(
  result: { ok: boolean; code?: string },
  code: "DB_UNAVAILABLE" | "PERSISTENCE_FAILED",
) {
  expect(result).toEqual({ ok: false, code });
  expect(result).not.toHaveProperty("row");
  expect(result).not.toHaveProperty("expired");
  expect(result).not.toHaveProperty("outcome");
  expect(result).not.toMatchObject({ code: "NOT_FOUND" });
  expect(result).not.toMatchObject({ code: "SOURCE_INBOUND_NOT_FOUND" });
}

async function everyPublicPrimitive() {
  return {
    create: await createWhatsAppPendingIntent({ sourceInboundMessageId: 1 }),
    byId: await getWhatsAppPendingIntentByIdForUser(1, 1),
    bySource: await getWhatsAppPendingIntentBySourceForUser(1, 1),
    open: await getOpenWhatsAppPendingIntentForUser(1),
    expire: await expireWhatsAppPendingIntent(1, 1),
    cancel: await cancelWhatsAppPendingIntent(1, 1),
    cleanup: await clearExpiredWhatsAppPendingIntents(),
  };
}

const inboundReady = {
  id: 10,
  userId: 4,
  processingStatus: "READY_FOR_NL",
};

const dueOpenRow = {
  id: 7,
  userId: 4,
  sourceInboundMessageId: 10,
  institutionId: null,
  status: "OPEN",
  stage: "PARSE",
  intentKind: null,
  parsedPayload: null,
  resolvedPayload: null,
  clarificationPayload: null,
  expiresAt: new Date("2020-01-01T00:00:00.000Z"),
  consumedAt: null,
  payloadClearedAt: null,
};

function scriptedSelect(steps: (unknown[] | "throw")[]) {
  let index = 0;
  return () => {
    const step = steps[index++];
    if (step === "throw" || step === undefined) {
      return thenable(Promise.reject(new Error("select failed")));
    }
    return thenable(Promise.resolve(step));
  };
}

describe("WhatsApp pending intent — fail-closed de persistência", () => {
  afterEach(async () => {
    await restoreGetDb();
  });

  it("DB null: as sete primitives devolvem DB_UNAVAILABLE, nunca negócio/zero/ausência", async () => {
    vi.mocked(getDb).mockResolvedValue(null);
    const results = await everyPublicPrimitive();
    for (const result of Object.values(results)) {
      expectInfra(result, "DB_UNAVAILABLE");
    }
    expect(isWhatsAppPendingCleanupFailure(results.cleanup)).toBe(true);
  });

  it("getDb rejeitado: as sete primitives devolvem PERSISTENCE_FAILED sem erro cru", async () => {
    vi.mocked(getDb).mockRejectedValue(new Error("pool closed"));
    const results = await everyPublicPrimitive();
    for (const result of Object.values(results)) {
      expectInfra(result, "PERSISTENCE_FAILED");
    }
  });

  it("create: SELECT inbound falha não vira SOURCE_INBOUND_NOT_FOUND", async () => {
    vi.mocked(getDb).mockResolvedValue({
      select: scriptedSelect(["throw"]),
    } as never);
    const result = await createWhatsAppPendingIntent({
      sourceInboundMessageId: 1,
    });
    expectInfra(result, "PERSISTENCE_FAILED");
  });

  it("create: SELECT source existente falha não vira replay", async () => {
    vi.mocked(getDb).mockResolvedValue({
      select: scriptedSelect([[inboundReady], "throw"]),
    } as never);
    const result = await createWhatsAppPendingIntent({
      sourceInboundMessageId: 10,
    });
    expectInfra(result, "PERSISTENCE_FAILED");
  });

  it("create: SELECT OPEN falha não vira already_open", async () => {
    vi.mocked(getDb).mockResolvedValue({
      select: scriptedSelect([[inboundReady], [], "throw"]),
    } as never);
    const result = await createWhatsAppPendingIntent({
      sourceInboundMessageId: 10,
    });
    expectInfra(result, "PERSISTENCE_FAILED");
  });

  it("create: INSERT falha não vira created", async () => {
    vi.mocked(getDb).mockResolvedValue({
      select: scriptedSelect([[inboundReady], [], []]),
      insert: () => ({
        values: () => ({
          $returningId: () => Promise.reject(new Error("insert failed")),
        }),
      }),
    } as never);
    const result = await createWhatsAppPendingIntent({
      sourceInboundMessageId: 10,
    });
    expectInfra(result, "PERSISTENCE_FAILED");
  });

  it("create: reload pós-INSERT vazio é PERSISTENCE_FAILED", async () => {
    vi.mocked(getDb).mockResolvedValue({
      select: scriptedSelect([[inboundReady], [], [], []]),
      insert: () => ({
        values: () => ({
          $returningId: () => Promise.resolve([{ id: 99 }]),
        }),
      }),
    } as never);
    const result = await createWhatsAppPendingIntent({
      sourceInboundMessageId: 10,
    });
    expectInfra(result, "PERSISTENCE_FAILED");
  });

  it("create: duplicate-key recovery que falha não vira replay", async () => {
    vi.mocked(getDb).mockResolvedValue({
      select: scriptedSelect([[inboundReady], [], [], "throw"]),
      insert: () => ({
        values: () => ({
          $returningId: () =>
            Promise.reject(
              Object.assign(new Error("Duplicate entry"), {
                code: "ER_DUP_ENTRY",
              }),
            ),
        }),
      }),
    } as never);
    const result = await createWhatsAppPendingIntent({
      sourceInboundMessageId: 10,
    });
    expectInfra(result, "PERSISTENCE_FAILED");
  });

  it("expire/cancel: SELECT falha não vira NOT_FOUND", async () => {
    vi.mocked(getDb).mockResolvedValue({
      select: () => thenable(Promise.reject(new Error("select failed"))),
    } as never);
    expectInfra(await expireWhatsAppPendingIntent(7, 4), "PERSISTENCE_FAILED");
    expectInfra(await cancelWhatsAppPendingIntent(7, 4), "PERSISTENCE_FAILED");
  });

  it("expire/cancel: UPDATE falha não vira already_terminal", async () => {
    vi.mocked(getDb).mockResolvedValue({
      select: () => thenable(Promise.resolve([dueOpenRow])),
      update: () => thenable(Promise.reject(new Error("update failed"))),
    } as never);
    expectInfra(await expireWhatsAppPendingIntent(7, 4), "PERSISTENCE_FAILED");
    expectInfra(await cancelWhatsAppPendingIntent(7, 4), "PERSISTENCE_FAILED");
  });

  it("expire: reload falha não vira NOT_FOUND", async () => {
    vi.mocked(getDb).mockResolvedValue({
      select: scriptedSelect([[dueOpenRow], "throw"]),
      update: () => thenable(Promise.resolve({ affectedRows: 1 })),
    } as never);
    expectInfra(await expireWhatsAppPendingIntent(7, 4), "PERSISTENCE_FAILED");
  });

  it("cancel: reload falha não vira NOT_FOUND", async () => {
    vi.mocked(getDb).mockResolvedValue({
      select: scriptedSelect([[dueOpenRow], "throw"]),
      update: () => thenable(Promise.resolve({ affectedRows: 1 })),
    } as never);
    expectInfra(await cancelWhatsAppPendingIntent(7, 4), "PERSISTENCE_FAILED");
  });

  it("cleanup: primeiro UPDATE falha → PERSISTENCE_FAILED", async () => {
    vi.mocked(getDb).mockResolvedValue({
      update: () => thenable(Promise.reject(new Error("expire update"))),
    } as never);
    expectInfra(
      await clearExpiredWhatsAppPendingIntents(),
      "PERSISTENCE_FAILED",
    );
  });

  it("cleanup: segundo UPDATE falha após o primeiro → PERSISTENCE_FAILED", async () => {
    let updates = 0;
    vi.mocked(getDb).mockResolvedValue({
      update: () => {
        updates += 1;
        if (updates === 1) {
          return thenable(Promise.resolve({ affectedRows: 3 }));
        }
        return thenable(Promise.reject(new Error("leftover update")));
      },
    } as never);
    const result = await clearExpiredWhatsAppPendingIntents();
    expectInfra(result, "PERSISTENCE_FAILED");
    expect(updates).toBe(2);
  });

  it("cleanup: outage loga cleanup_failed, nunca só expired=0", async () => {
    const lines: string[] = [];
    const spy = vi
      .spyOn(logger, "info")
      .mockImplementation((...args: unknown[]) => {
        lines.push(args.map((item) => String(item)).join(" "));
        return logger;
      });
    vi.mocked(getDb).mockResolvedValue(null);
    const result = await clearExpiredWhatsAppPendingIntents();
    spy.mockRestore();
    expectInfra(result, "DB_UNAVAILABLE");
    const joined = lines.join("\n");
    expect(joined).toContain("whatsapp_pending_cleanup_failed");
    expect(joined).toContain("DB_UNAVAILABLE");
    expect(joined).not.toMatch(/"expired":0/);
    expect(joined).not.toMatch(/mysql:|DATABASE_URL|operational_text|\+55/);
  });
});
