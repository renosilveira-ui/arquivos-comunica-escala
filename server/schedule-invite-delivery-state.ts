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
}): ScheduleInviteRecoveryPlan {
  if (input.state === "IDLE" || input.state === "PROVIDER_REJECTED") {
    return { kind: "NEW_GENERATION", supersedesUncertainGeneration: false };
  }

  const wasUncertain =
    input.state === "PREPARING" || input.state === "PROVIDER_UNKNOWN";
  const attemptIsLive = Boolean(
    input.attemptExpiresAt &&
    isScheduleInviteAttemptLive(input.attemptExpiresAt, input.now),
  );

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
    if (
      input.leaseExpiresAt &&
      input.leaseExpiresAt.getTime() > input.now.getTime()
    ) {
      return { kind: "WAIT" };
    }
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
