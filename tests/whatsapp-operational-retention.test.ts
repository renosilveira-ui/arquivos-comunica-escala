import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../server/_core/logger";
import {
  isWhatsAppOperationalPayloadRetentionRunning,
  runWhatsAppOperationalPayloadRetentionTick,
  startWhatsAppOperationalPayloadRetention,
  whatsappPayloadRetentionDelayMs,
  WHATSAPP_PAYLOAD_RETENTION_JITTER_MS,
  WHATSAPP_PAYLOAD_RETENTION_MAX_BATCHES_PER_TICK,
  WHATSAPP_PAYLOAD_RETENTION_MIN_INTERVAL_MS,
} from "../server/integrations/whatsapp/operational-payload-retention";

const retentionSource = readFileSync(
  new URL(
    "../server/integrations/whatsapp/operational-payload-retention.ts",
    import.meta.url,
  ),
  "utf8",
);
const inboundSource = readFileSync(
  new URL(
    "../server/integrations/whatsapp/operational-payload.ts",
    import.meta.url,
  ),
  "utf8",
);
const pendingSource = readFileSync(
  new URL(
    "../server/integrations/whatsapp/pending-intent-store.ts",
    import.meta.url,
  ),
  "utf8",
);
const bootSource = readFileSync(
  new URL("../server/_core/index.ts", import.meta.url),
  "utf8",
);
const contract = readFileSync(
  new URL(
    "../docs/CONTRACT_WHATSAPP_CONVERSATIONAL_OPERATIONS_V1.md",
    import.meta.url,
  ),
  "utf8",
);

const emptyInbound = {
  available: true,
  selected: 0,
  cleared: 0,
  batchSize: 500,
} as const;
const emptyPending = {
  ok: true,
  selected: 0,
  expired: 0,
  payloadsCleared: 0,
  batchSize: 500,
} as const;

describe("WhatsApp — retenção operacional autônoma", () => {
  beforeEach(() => {
    vi.spyOn(logger, "info").mockImplementation(() => logger);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("varre inbound e pending no mesmo tick, com métricas separadas", async () => {
    const clearInboundBatch = vi
      .fn()
      .mockResolvedValueOnce({
        available: true,
        selected: 500,
        cleared: 498,
        batchSize: 500,
      })
      .mockResolvedValueOnce({
        available: true,
        selected: 2,
        cleared: 2,
        batchSize: 500,
      });
    const clearPendingBatch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        selected: 500,
        expired: 100,
        payloadsCleared: 500,
        batchSize: 500,
      })
      .mockResolvedValueOnce({
        ok: true,
        selected: 1,
        expired: 1,
        payloadsCleared: 1,
        batchSize: 500,
      });

    const summary = await runWhatsAppOperationalPayloadRetentionTick({
      now: new Date("2026-09-10T12:00:00.000Z"),
      clearInboundBatch,
      clearPendingBatch,
    });

    expect(summary.inbound).toEqual({
      available: true,
      batches: 2,
      selected: 502,
      cleared: 500,
      capped: false,
    });
    expect(summary.pending).toEqual({
      available: true,
      batches: 2,
      selected: 501,
      expired: 101,
      payloadsCleared: 501,
      capped: false,
    });
  });

  it("impõe teto absoluto de quatro lotes por tabela", async () => {
    const clearInboundBatch = vi.fn().mockResolvedValue({
      available: true,
      selected: 500,
      cleared: 500,
      batchSize: 500,
    });
    const clearPendingBatch = vi.fn().mockResolvedValue({
      ok: true,
      selected: 500,
      expired: 500,
      payloadsCleared: 500,
      batchSize: 500,
    });

    const summary = await runWhatsAppOperationalPayloadRetentionTick({
      maxBatches: 99,
      batchSize: 99_999,
      clearInboundBatch,
      clearPendingBatch,
    });

    expect(clearInboundBatch).toHaveBeenCalledTimes(
      WHATSAPP_PAYLOAD_RETENTION_MAX_BATCHES_PER_TICK,
    );
    expect(clearPendingBatch).toHaveBeenCalledTimes(
      WHATSAPP_PAYLOAD_RETENTION_MAX_BATCHES_PER_TICK,
    );
    expect(clearInboundBatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ batchSize: 500 }),
    );
    expect(summary.inbound.capped).toBe(true);
    expect(summary.pending.capped).toBe(true);
  });

  it("falha de um sweep não derruba nem impede o outro", async () => {
    const clearPendingBatch = vi.fn().mockResolvedValue(emptyPending);
    const summary = await runWhatsAppOperationalPayloadRetentionTick({
      clearInboundBatch: vi.fn().mockRejectedValue(new Error("poison")),
      clearPendingBatch,
    });

    expect(summary.inbound.available).toBe(false);
    expect(summary.pending.available).toBe(true);
    expect(clearPendingBatch).toHaveBeenCalledTimes(1);
  });

  it("indisponibilidade do pending não desfaz o sweep inbound", async () => {
    const clearInboundBatch = vi.fn().mockResolvedValue(emptyInbound);
    const summary = await runWhatsAppOperationalPayloadRetentionTick({
      clearInboundBatch,
      clearPendingBatch: vi.fn().mockResolvedValue({
        ok: false,
        code: "DB_UNAVAILABLE",
      }),
    });

    expect(summary.inbound.available).toBe(true);
    expect(summary.pending.available).toBe(false);
    expect(clearInboundBatch).toHaveBeenCalledTimes(1);
  });

  it("não sobrepõe chamadas concorrentes do tick", async () => {
    let release: ((value: typeof emptyInbound) => void) | undefined;
    const blocked = new Promise<typeof emptyInbound>((resolve) => {
      release = resolve;
    });
    const clearInboundBatch = vi.fn().mockReturnValue(blocked);
    const clearPendingBatch = vi.fn().mockResolvedValue(emptyPending);

    const first = runWhatsAppOperationalPayloadRetentionTick({
      clearInboundBatch,
      clearPendingBatch,
    });
    const second = runWhatsAppOperationalPayloadRetentionTick({
      clearInboundBatch: vi.fn(),
      clearPendingBatch: vi.fn(),
    });
    expect(second).toBe(first);
    release?.(emptyInbound);
    await Promise.all([first, second]);
    expect(clearInboundBatch).toHaveBeenCalledTimes(1);
    expect(clearPendingBatch).toHaveBeenCalledTimes(1);
  });

  it("respeita stop cooperativo sem consultar persistência", async () => {
    const clearInboundBatch = vi.fn().mockResolvedValue(emptyInbound);
    const clearPendingBatch = vi.fn().mockResolvedValue(emptyPending);
    const summary = await runWhatsAppOperationalPayloadRetentionTick({
      shuttingDown: () => true,
      clearInboundBatch,
      clearPendingBatch,
    });

    expect(summary.stopped).toBe(true);
    expect(clearInboundBatch).not.toHaveBeenCalled();
    expect(clearPendingBatch).not.toHaveBeenCalled();
  });

  it("agenda entre cinco e quinze minutos e boot não depende do driver NL", () => {
    expect(whatsappPayloadRetentionDelayMs(() => 0)).toBe(
      WHATSAPP_PAYLOAD_RETENTION_MIN_INTERVAL_MS,
    );
    expect(whatsappPayloadRetentionDelayMs(() => 1)).toBe(
      WHATSAPP_PAYLOAD_RETENTION_MIN_INTERVAL_MS +
        WHATSAPP_PAYLOAD_RETENTION_JITTER_MS,
    );
    expect(retentionSource).not.toMatch(
      /WHATSAPP_NL_DRIVER_ENABLED|whatsappNlDriverEnabled|isWhatsAppNlDriverEnabled/,
    );
    expect(isWhatsAppOperationalPayloadRetentionRunning()).toBe(false);
    startWhatsAppOperationalPayloadRetention();
    expect(isWhatsAppOperationalPayloadRetentionRunning()).toBe(false);
  });

  it("wiring inicia após listen e encerra no shutdown", () => {
    const listen = bootSource.indexOf('server.listen(port, "0.0.0.0"');
    const start = bootSource.indexOf(
      "startWhatsAppOperationalPayloadRetention();",
    );
    const shutdown = bootSource.indexOf("onBeforeExit");
    const stop = bootSource.indexOf(
      "stopWhatsAppOperationalPayloadRetention();",
    );
    expect(listen).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(listen);
    expect(stop).toBeGreaterThan(shutdown);
    expect(bootSource).toContain(
      "whatsappRetentionDrain = stopWhatsAppOperationalPayloadRetention()",
    );
    expect(bootSource).toContain("await whatsappRetentionDrain");
    expect(retentionSource.indexOf("runWhatsAppOperationalPayloadRetentionTick"))
      .toBeLessThan(retentionSource.indexOf("whatsappPayloadRetentionDelayMs()"));
  });

  it("helpers fazem SELECT ordenado, limite e UPDATE com CAS", () => {
    for (const source of [inboundSource, pendingSource]) {
      expect(source).toContain(".orderBy(");
      expect(source).toContain(".limit(batchSize)");
      expect(source).toContain("inArray(");
      expect(source).toContain("payloadClearedAt");
    }
    expect(inboundSource).toContain("payloadExpiresAt, now");
    expect(pendingSource).toContain("expiresAt, now");
    expect(contract).toContain("Durante sleep/suspensão do Render");
    expect(contract).toContain("tick imediato");
  });

  it("logs próprios não carregam conteúdo, URL, telefone ou identidade", () => {
    expect(retentionSource).toContain("function logSafe");
    expect(retentionSource).not.toMatch(
      /userId|operationalText|mediaUrl|Body|phone|email|cpf|https?:\/\//i,
    );
  });
});
