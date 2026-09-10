export const SCHEDULE_INVITE_DELIVERY_STATES = [
  "IDLE",
  "PREPARING",
  "PROVIDER_UNKNOWN",
  "PROVIDER_ACCEPTED",
  "ACTIVE",
  "PROVIDER_REJECTED",
  "PROVIDER_ACCEPTED_ACTIVATION_FAILED",
] as const;

export type ScheduleInviteDeliveryState =
  (typeof SCHEDULE_INVITE_DELIVERY_STATES)[number];

export type ScheduleInviteRecoveryPlan =
  | { kind: "WAIT" }
  | { kind: "NEW_GENERATION"; supersedesUncertainGeneration: boolean }
  | { kind: "REPLAY_DELIVERY" }
  | { kind: "RESUME_ACTIVATION" }
  | { kind: "TERMINAL_FAILURE" }
  | { kind: "FAIL_CLOSED" };

export function isScheduleInviteAttemptLive(
  attemptExpiresAt: Date,
  now: Date,
): boolean {
  return attemptExpiresAt.getTime() > now.getTime();
}

export function planScheduleInviteRecovery(input: {
  state: ScheduleInviteDeliveryState;
  now: Date;
  leaseExpiresAt: Date | null;
  attemptExpiresAt: Date | null;
  recipientMatches: boolean | null;
  pepperKeyAvailable: boolean;
  attemptCount: number;
  maxAttempts: number;
  terminalFailure: boolean;
}): ScheduleInviteRecoveryPlan {
  const attemptsAreValid =
    Number.isSafeInteger(input.attemptCount) &&
    Number.isSafeInteger(input.maxAttempts) &&
    input.maxAttempts >= 1 &&
    input.maxAttempts <= 5 &&
    input.attemptCount >= 0 &&
    input.attemptCount <= input.maxAttempts &&
    (input.state === "IDLE"
      ? input.attemptCount === 0
      : input.attemptCount >= 1);
  if (!attemptsAreValid) return { kind: "FAIL_CLOSED" };
  if (input.terminalFailure) return { kind: "TERMINAL_FAILURE" };

  if (input.state === "IDLE" || input.state === "PROVIDER_REJECTED") {
    return { kind: "NEW_GENERATION", supersedesUncertainGeneration: false };
  }

  const wasUncertain =
    input.state === "PREPARING" || input.state === "PROVIDER_UNKNOWN";
  const attemptIsLive = Boolean(
    input.attemptExpiresAt &&
    isScheduleInviteAttemptLive(input.attemptExpiresAt, input.now),
  );
  const leaseIsLive = Boolean(
    input.leaseExpiresAt &&
    input.leaseExpiresAt.getTime() > input.now.getTime(),
  );

  // O teto pertence à geração, não à duração do código. Um crash depois de
  // reservar a última tentativa não pode esperar o TTL e escapar para uma
  // geração nova sem revisão operacional. A tentativa ainda em curso, porém,
  // conserva sua lease: um request concorrente não pode encerrá-la no meio do
  // egress.
  if (wasUncertain && leaseIsLive) return { kind: "WAIT" };
  if (wasUncertain && input.attemptCount >= input.maxAttempts) {
    return { kind: "TERMINAL_FAILURE" };
  }

  // Durante uma tentativa vigente, a identidade do destinatário e a
  // continuidade da geração dependem da chave persistida. Ausência de key-id
  // ou pepper é UNKNOWN e deve bloquear antes de consultar recipientMatches.
  if (attemptIsLive && !input.pepperKeyAvailable) {
    return { kind: "FAIL_CLOSED" };
  }

  if (!attemptIsLive || input.recipientMatches === false) {
    return {
      kind: "NEW_GENERATION",
      supersedesUncertainGeneration: wasUncertain,
    };
  }
  if (input.recipientMatches === null) return { kind: "FAIL_CLOSED" };

  if (input.state === "PREPARING" || input.state === "PROVIDER_UNKNOWN") {
    return { kind: "REPLAY_DELIVERY" };
  }

  if (input.state === "PROVIDER_ACCEPTED") {
    if (
      input.leaseExpiresAt &&
      input.leaseExpiresAt.getTime() > input.now.getTime()
    ) {
      return { kind: "WAIT" };
    }
    return { kind: "RESUME_ACTIVATION" };
  }

  if (input.state === "PROVIDER_ACCEPTED_ACTIVATION_FAILED") {
    return { kind: "RESUME_ACTIVATION" };
  }

  return { kind: "NEW_GENERATION", supersedesUncertainGeneration: false };
}
