import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../server/db";
import {
  getOpenWhatsAppPendingIntentForUser,
  getWhatsAppPendingIntentByIdForUser,
  getWhatsAppPendingIntentBySourceForUser,
} from "../server/integrations/whatsapp/pending-intent-store";
import {
  isWhatsAppPendingReadFailure,
  type WhatsAppPendingReadResult,
} from "../server/integrations/whatsapp/pending-intent-types";

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

function expectReadFailure(
  result: WhatsAppPendingReadResult,
  code: "DB_UNAVAILABLE" | "PERSISTENCE_FAILED",
) {
  expect(isWhatsAppPendingReadFailure(result)).toBe(true);
  expect(result).toEqual({ ok: false, code });
  expect(result).not.toHaveProperty("row");
  expect(result).not.toEqual({ ok: true, row: null });
}

async function readAllPublic(userId = 1, id = 1, sourceId = 1) {
  return Promise.all([
    getWhatsAppPendingIntentByIdForUser(id, userId),
    getWhatsAppPendingIntentBySourceForUser(sourceId, userId),
    getOpenWhatsAppPendingIntentForUser(userId),
  ]);
}

describe("WhatsApp pending intent — reads fail-closed", () => {
  afterEach(async () => {
    await restoreGetDb();
  });

  it("DB indisponível: os três reads devolvem DB_UNAVAILABLE, nunca row null", async () => {
    vi.mocked(getDb).mockResolvedValue(null);
    const results = await readAllPublic();
    expect(results).toHaveLength(3);
    for (const result of results) {
      expectReadFailure(result, "DB_UNAVAILABLE");
    }
  });

  it("query exception: os três reads devolvem PERSISTENCE_FAILED sem erro cru", async () => {
    vi.mocked(getDb).mockResolvedValue({
      select() {
        throw new Error("connection reset");
      },
    } as never);
    const results = await readAllPublic();
    expect(results).toHaveLength(3);
    for (const result of results) {
      expectReadFailure(result, "PERSISTENCE_FAILED");
    }
  });

  it("getDb rejeitado não vaza erro cru e não parece ausência", async () => {
    vi.mocked(getDb).mockRejectedValue(new Error("pool closed"));
    const results = await readAllPublic();
    for (const result of results) {
      expectReadFailure(result, "PERSISTENCE_FAILED");
    }
  });
});
