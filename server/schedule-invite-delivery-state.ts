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

export function planScheduleInviteRecovery(input: {
  state: ScheduleInviteDeliveryState;
  now: Date;
  leaseExpiresAt: Date | null;
  attemptExpiresAt: Date | null;
  recipientMatches: boolean;
  pepperKeyAvailable: boolean;
}): ScheduleInviteRecoveryPlan {
  if (input.state === "IDLE" || input.state === "PROVIDER_REJECTED") {
    return { kind: "NEW_GENERATION", supersedesUncertainGeneration: false };
  }

  const wasUncertain =
    input.state === "PREPARING" || input.state === "PROVIDER_UNKNOWN";
  if (
    !input.attemptExpiresAt ||
    input.attemptExpiresAt.getTime() <= input.now.getTime() ||
    !input.recipientMatches
  ) {
    return {
      kind: "NEW_GENERATION",
      supersedesUncertainGeneration: wasUncertain,
    };
  }
  if (!input.pepperKeyAvailable) return { kind: "FAIL_CLOSED" };

  if (
    input.state === "PREPARING" ||
    input.state === "PROVIDER_UNKNOWN" ||
    input.state === "PROVIDER_ACCEPTED"
  ) {
    if (
      input.leaseExpiresAt &&
      input.leaseExpiresAt.getTime() > input.now.getTime()
    ) {
      return { kind: "WAIT" };
    }
    return input.state === "PROVIDER_ACCEPTED"
      ? { kind: "RESUME_ACTIVATION" }
      : { kind: "REPLAY_DELIVERY" };
  }

  if (input.state === "PROVIDER_ACCEPTED_ACTIVATION_FAILED") {
    return { kind: "RESUME_ACTIVATION" };
  }

  return { kind: "NEW_GENERATION", supersedesUncertainGeneration: false };
}
