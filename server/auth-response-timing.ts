export const SIGNUP_NEUTRAL_RESPONSE_FLOOR_MS = 1_000;

/**
 * Contrato mensurável de piso de resposta. Um recuo do relógio não pode
 * transformar a mitigação anti-enumeração em espera ilimitada.
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
