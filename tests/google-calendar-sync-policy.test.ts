import { describe, expect, it } from "vitest";

import {
  GOOGLE_SYNC_INTERVAL_MS,
  GOOGLE_SYNC_MAX_BACKOFF_MS,
  backoffForFailures,
  isDueForSync,
} from "../server/integrations/google/sync-policy";

const NOW = new Date("2026-09-12T12:00:00.000Z");
const minutes = (n: number) => n * 60_000;

function candidate(overrides: Partial<Parameters<typeof isDueForSync>[0]["candidate"]> = {}) {
  return {
    lastSyncedAt: null,
    updatedAt: new Date(NOW.getTime() - minutes(60)),
    consecutiveFailureCount: 0,
    ...overrides,
  };
}

describe("cadência da sincronização automática", () => {
  it("a cada 15 minutos por conta; nunca mais que 6 horas de espera", () => {
    expect(GOOGLE_SYNC_INTERVAL_MS).toBe(minutes(15));
    expect(GOOGLE_SYNC_MAX_BACKOFF_MS).toBe(minutes(360));
  });

  it("conta nunca sincronizada está na vez", () => {
    expect(
      isDueForSync({ candidate: candidate(), lastAttemptAtMs: null, now: NOW }),
    ).toBe(true);
  });

  it("sincronizada há pouco espera; há mais de 15 minutos, vai", () => {
    expect(
      isDueForSync({
        candidate: candidate({ lastSyncedAt: new Date(NOW.getTime() - minutes(3)) }),
        lastAttemptAtMs: null,
        now: NOW,
      }),
    ).toBe(false);
    expect(
      isDueForSync({
        candidate: candidate({ lastSyncedAt: new Date(NOW.getTime() - minutes(16)) }),
        lastAttemptAtMs: null,
        now: NOW,
      }),
    ).toBe(true);
  });

  /**
   * Uma falha que estourou antes de o vínculo registrar (rede, banco) não
   * deixa rastro no banco. Só a memória do processo sabe que tentou — e é
   * ela que impede uma conta quebrada de custar uma chamada por tick.
   */
  it("tentativa recente do próprio processo também segura", () => {
    expect(
      isDueForSync({
        candidate: candidate(),
        lastAttemptAtMs: NOW.getTime() - minutes(2),
        now: NOW,
      }),
    ).toBe(false);
  });

  it("falhas dobram a espera: 30 min, 1 h, 2 h… teto de 6 h", () => {
    expect(backoffForFailures(0)).toBe(minutes(15));
    expect(backoffForFailures(1)).toBe(minutes(30));
    expect(backoffForFailures(2)).toBe(minutes(60));
    expect(backoffForFailures(3)).toBe(minutes(120));
    expect(backoffForFailures(5)).toBe(minutes(360));
    expect(backoffForFailures(50)).toBe(minutes(360));
    expect(backoffForFailures(-1)).toBe(minutes(15));
  });

  it("conta que falhou espera o backoff contado da última mudança do vínculo", () => {
    const failed = candidate({
      consecutiveFailureCount: 2,
      updatedAt: new Date(NOW.getTime() - minutes(45)),
    });
    expect(isDueForSync({ candidate: failed, lastAttemptAtMs: null, now: NOW })).toBe(
      false,
    );
    const later = new Date(NOW.getTime() + minutes(20));
    expect(
      isDueForSync({ candidate: failed, lastAttemptAtMs: null, now: later }),
    ).toBe(true);
  });
});
