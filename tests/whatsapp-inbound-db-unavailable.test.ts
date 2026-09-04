import { afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../server/db";
import { processWhatsAppInbound } from "../server/integrations/whatsapp/inbound-store";
import { resolveVerifiedWhatsAppUser } from "../server/integrations/whatsapp/resolve-identity";

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

describe("WhatsApp inbound — DB indisponível", () => {
  afterEach(async () => {
    await restoreGetDb();
  });

  it("resolveVerifiedWhatsAppUser nunca mapeia DB ausente para IDENTITY_NOT_FOUND", async () => {
    vi.mocked(getDb).mockResolvedValue(null);
    await expect(resolveVerifiedWhatsAppUser("+5585999000000")).resolves.toEqual({
      ok: false,
      retryable: true,
      code: "DB_UNAVAILABLE",
    });
  });

  it("falha transitória de query de identidade é retryable", async () => {
    vi.mocked(getDb).mockResolvedValue({
      select() {
        throw new Error("connection reset");
      },
    } as never);
    await expect(resolveVerifiedWhatsAppUser("+5585999000000")).resolves.toEqual({
      ok: false,
      retryable: true,
      code: "IDENTITY_QUERY_FAILED",
    });
  });

  it("processWhatsAppInbound sem DB é retryable, não identidade", async () => {
    vi.mocked(getDb).mockResolvedValue(null);
    const result = await processWhatsAppInbound({
      provider: "TWILIO",
      providerMessageId: "SMdbdown1",
      fromE164: "+5585999000000",
      content: {
        kind: "TEXT",
        text: "não deve virar identidade",
        forwarded: false,
      },
      receivedAt: new Date(),
    });
    expect(result).toMatchObject({
      outcome: "retryable",
      id: null,
      status: null,
      code: "DB_UNAVAILABLE",
    });
    expect(result).not.toMatchObject({ status: "IDENTITY_NOT_FOUND" });
  });
});
