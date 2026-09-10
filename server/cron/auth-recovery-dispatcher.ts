import { processPendingAuthRecoveryEmails } from "../auth-recovery";

const AUTH_RECOVERY_INTERVAL_MS = 60_000;
let intervalId: ReturnType<typeof setInterval> | null = null;
let activeTick: Promise<void> | null = null;
let acceptingTicks = false;

/** Worker isolado: falha de correio nunca interrompe o tick clínico. */
export async function tickAuthRecovery(now = new Date()): Promise<void> {
  if (!acceptingTicks) return;
  if (activeTick) return activeTick;

  let tick!: Promise<void>;
  tick = (async () => {
    try {
      await processPendingAuthRecoveryEmails(now);
    } catch {
      console.error("[AuthRecoveryCron] TICK_FAILED");
    } finally {
      if (activeTick === tick) activeTick = null;
    }
  })();
  activeTick = tick;
  await tick;
}

export function startAuthRecoveryCron(): void {
  if (intervalId) return;
  acceptingTicks = true;
  void tickAuthRecovery();
  intervalId = setInterval(
    () => void tickAuthRecovery(),
    AUTH_RECOVERY_INTERVAL_MS,
  );
}

export function stopAuthRecoveryCron(): Promise<void> {
  acceptingTicks = false;
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  return activeTick ?? Promise.resolve();
}
