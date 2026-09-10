export const SIGNUP_NEUTRAL_RESPONSE_FLOOR_MS = 1_000;

/**
 * Piso uniforme de resposta para reduzir atalhos grosseiros. Um segundo não
 * prova indistinguibilidade temporal nem substitui rate limiting, forma HTTP
 * uniforme e monitoramento; um recuo do relógio também não pode gerar espera
 * ilimitada.
 */
export function signupNeutralResponseDelayMs(
  startedAtMs: number,
  nowMs: number,
): number {
  const elapsedMs = Math.max(0, nowMs - startedAtMs);
  return Math.max(0, SIGNUP_NEUTRAL_RESPONSE_FLOOR_MS - elapsedMs);
}

export async function waitForSignupNeutralResponseFloor(
  startedAtMs: number,
): Promise<void> {
  const delay = signupNeutralResponseDelayMs(startedAtMs, Date.now());
  if (delay > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
}
