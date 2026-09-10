import { processPendingAuthRecoveryEmails } from "../auth-recovery";

const AUTH_RECOVERY_INTERVAL_MS = 60_000;
let intervalId: ReturnType<typeof setInterval> | null = null;
let running = false;

/** Worker isolado: falha de correio nunca interrompe o tick clínico. */
export async function tickAuthRecovery(now = new Date()): Promise<void> {
  if (running) return;
  running = true;
  try {
    await processPendingAuthRecoveryEmails(now);
  } catch {
    console.error("[AuthRecoveryCron] TICK_FAILED");
  } finally {
    running = false;
  }
}

export function startAuthRecoveryCron(): void {
  if (intervalId) return;
  void tickAuthRecovery();
  intervalId = setInterval(
    () => void tickAuthRecovery(),
    AUTH_RECOVERY_INTERVAL_MS,
  );
}

export function stopAuthRecoveryCron(): void {
  if (!intervalId) return;
  clearInterval(intervalId);
  intervalId = null;
}
