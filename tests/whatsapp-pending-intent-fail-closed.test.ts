import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../server/db";
import { logger } from "../server/_core/logger";
import {
  advanceWhatsAppPendingFromParse,
  cancelWhatsAppPendingIntent,
  cancelWhatsAppPendingOpenParse,
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
    cancelParse: await cancelWhatsAppPendingOpenParse({
      pendingId: 1,
      userId: 1,
      expectedSourceInboundMessageId: 1,
    }),
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

const validAdvanceInput = {
  pendingId: 7,
  userId: 4,
  expectedSourceInboundMessageId: 10,
  outcome: {
    type: "clarification" as const,
    parsed: null,
    clarification: { version: 1 as const, code: "AMBIGUOUS_INTENT" as const },
  },
};

describe("WhatsApp pending intent — fail-closed de persistência", () => {
  afterEach(async () => {
    await restoreGetDb();
  });

  it("DB null: as oito primitives devolvem DB_UNAVAILABLE, nunca negócio/zero/ausência", async () => {
    vi.mocked(getDb).mockResolvedValue(null);
    const results = await everyPublicPrimitive();
    for (const result of Object.values(results)) {
      expectInfra(result, "DB_UNAVAILABLE");
    }
    expect(isWhatsAppPendingCleanupFailure(results.cleanup)).toBe(true);
  });

  it("getDb rejeitado: as oito primitives devolvem PERSISTENCE_FAILED sem erro cru", async () => {
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

  it("advance: DB null → DB_UNAVAILABLE", async () => {
    vi.mocked(getDb).mockResolvedValue(null);
    expectInfra(
      await advanceWhatsAppPendingFromParse(validAdvanceInput),
      "DB_UNAVAILABLE",
    );
  });

  it("advance: UPDATE failure → PERSISTENCE_FAILED", async () => {
    vi.mocked(getDb).mockResolvedValue({
      update: () => thenable(Promise.reject(new Error("update failed"))),
    } as never);
    expectInfra(
      await advanceWhatsAppPendingFromParse(validAdvanceInput),
      "PERSISTENCE_FAILED",
    );
  });

  it("advance: reload failure após UPDATE → PERSISTENCE_FAILED", async () => {
    vi.mocked(getDb).mockResolvedValue({
      update: () => thenable(Promise.resolve({ affectedRows: 1 })),
      select: scriptedSelect(["throw"]),
    } as never);
    expectInfra(
      await advanceWhatsAppPendingFromParse(validAdvanceInput),
      "PERSISTENCE_FAILED",
    );
  });

  it("advance: reload nulo após UPDATE → PERSISTENCE_FAILED", async () => {
    vi.mocked(getDb).mockResolvedValue({
      update: () => thenable(Promise.resolve({ affectedRows: 1 })),
      select: scriptedSelect([[]]),
    } as never);
    expectInfra(
      await advanceWhatsAppPendingFromParse(validAdvanceInput),
      "PERSISTENCE_FAILED",
    );
  });

  it("cancel PARSE: UPDATE falha não vira cancelled nem already_terminal", async () => {
    vi.mocked(getDb).mockResolvedValue({
      update: () => thenable(Promise.reject(new Error("update failed"))),
    } as never);
    expectInfra(
      await cancelWhatsAppPendingOpenParse({
        pendingId: 7,
        userId: 4,
        expectedSourceInboundMessageId: 10,
      }),
      "PERSISTENCE_FAILED",
    );
  });

  it("cancel PARSE: reload após UPDATE não vira cancelled", async () => {
    vi.mocked(getDb).mockResolvedValue({
      update: () => thenable(Promise.resolve({ affectedRows: 1 })),
      select: scriptedSelect(["throw"]),
    } as never);
    expectInfra(
      await cancelWhatsAppPendingOpenParse({
        pendingId: 7,
        userId: 4,
        expectedSourceInboundMessageId: 10,
      }),
      "PERSISTENCE_FAILED",
    );
  });

  it("cancel PARSE: reload nulo após UPDATE → PERSISTENCE_FAILED", async () => {
    vi.mocked(getDb).mockResolvedValue({
      update: () => thenable(Promise.resolve({ affectedRows: 1 })),
      select: scriptedSelect([[]]),
    } as never);
    expectInfra(
      await cancelWhatsAppPendingOpenParse({
        pendingId: 7,
        userId: 4,
        expectedSourceInboundMessageId: 10,
      }),
      "PERSISTENCE_FAILED",
    );
  });

  it("cancel PARSE: miss + SELECT falha não vira NOT_FOUND", async () => {
    vi.mocked(getDb).mockResolvedValue({
      update: () => thenable(Promise.resolve({ affectedRows: 0 })),
      select: scriptedSelect(["throw"]),
    } as never);
    expectInfra(
      await cancelWhatsAppPendingOpenParse({
        pendingId: 7,
        userId: 4,
        expectedSourceInboundMessageId: 10,
      }),
      "PERSISTENCE_FAILED",
    );
  });

  it("cancel PARSE: miss terminal de outro source não vira already_terminal", async () => {
    const foreignTerminal = {
      ...dueOpenRow,
      status: "CANCELLED",
      sourceInboundMessageId: 99,
      payloadClearedAt: new Date("2020-01-02T00:00:00.000Z"),
    };
    vi.mocked(getDb).mockResolvedValue({
      update: () => thenable(Promise.resolve({ affectedRows: 0 })),
      select: scriptedSelect([[foreignTerminal]]),
    } as never);
    const result = await cancelWhatsAppPendingOpenParse({
      pendingId: 7,
      userId: 4,
      expectedSourceInboundMessageId: 10,
    });
    expect(result).toMatchObject({ ok: false, code: "STATE_CHANGED" });
    expect(result).not.toMatchObject({ outcome: "already_terminal" });
    expect(result).not.toMatchObject({ ok: true });
  });

  it("cancel PARSE: ids não positivos → INVALID_PAYLOAD sem tocar DB", async () => {
    vi.mocked(getDb).mockResolvedValue({
      update: () => {
        throw new Error("should not update");
      },
    } as never);
    expect(
      await cancelWhatsAppPendingOpenParse({
        pendingId: 0,
        userId: 4,
        expectedSourceInboundMessageId: 10,
      }),
    ).toEqual({ ok: false, code: "INVALID_PAYLOAD" });
    expect(getDb).not.toHaveBeenCalled();
  });

  it("advance: payload desconhecido → INVALID_PAYLOAD sem tocar DB", async () => {
    vi.mocked(getDb).mockResolvedValue({
      update: () => {
        throw new Error("should not update");
      },
    } as never);
    const result = await advanceWhatsAppPendingFromParse({
      pendingId: 7,
      userId: 4,
      expectedSourceInboundMessageId: 10,
      outcome: {
        type: "resolved",
        parsed: {
          version: 1,
          kind: "SWAP",
          ownShift: {
            date: { kind: "OFFSET", days: 0, said: "hoje" },
            period: null,
            sectorText: null,
          },
          targetProfessional: { name: "Joao" },
          targetShift: { date: null, period: null, sectorText: null },
        },
        resolved: {
          version: 1,
          kind: "CESSAO",
          institutionId: 1,
          fromShiftInstanceId: 10,
          fromAssignmentId: 11,
          toProfessionalId: 20,
          toShiftInstanceId: null,
          targetProfessionalName: "Joao",
          ownShift: {
            label: "A",
            sectorName: "SR",
            dayKey: "2026-09-04",
            timeRange: "19:00–07:00",
          },
          targetShift: null,
        },
      },
    });
    expect(result).toEqual({ ok: false, code: "INVALID_PAYLOAD" });
  });
});
