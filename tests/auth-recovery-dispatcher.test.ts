import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startAuthRecoveryCron,
  stopAuthRecoveryCron,
  tickAuthRecovery,
} from "../server/cron/auth-recovery-dispatcher";

const processPendingAuthRecoveryEmails = vi.hoisted(() => vi.fn());

vi.mock("../server/auth-recovery", () => ({
  processPendingAuthRecoveryEmails,
}));

describe("auth recovery dispatcher: drain cooperativo", () => {
  beforeEach(async () => {
    await stopAuthRecoveryCron();
    processPendingAuthRecoveryEmails.mockReset();
  });

  afterEach(async () => {
    await stopAuthRecoveryCron();
    vi.restoreAllMocks();
  });

  it("stop impede novos ticks e aguarda o envio que já estava em execução", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    processPendingAuthRecoveryEmails.mockImplementationOnce(() => gate);

    startAuthRecoveryCron();
    await vi.waitFor(() =>
      expect(processPendingAuthRecoveryEmails).toHaveBeenCalledTimes(1),
    );

    let drained = false;
    const drain = stopAuthRecoveryCron().then(() => {
      drained = true;
    });
    await tickAuthRecovery(new Date("2026-09-10T12:00:00.000Z"));

    expect(drained).toBe(false);
    expect(processPendingAuthRecoveryEmails).toHaveBeenCalledTimes(1);
    release();
    await drain;
    expect(drained).toBe(true);
  });

  it("pode reiniciar explicitamente depois de um stop concluído", async () => {
    processPendingAuthRecoveryEmails.mockResolvedValue(undefined);

    startAuthRecoveryCron();
    await vi.waitFor(() =>
      expect(processPendingAuthRecoveryEmails).toHaveBeenCalledTimes(1),
    );
    await stopAuthRecoveryCron();
    startAuthRecoveryCron();
    await vi.waitFor(() =>
      expect(processPendingAuthRecoveryEmails).toHaveBeenCalledTimes(2),
    );
  });
});
