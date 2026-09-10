import { describe, expect, it } from "vitest";
import { planScheduleInviteRecovery } from "../server/schedule-invite-delivery-state";

const now = new Date("2026-09-10T12:00:00.000Z");
const future = new Date("2026-09-10T12:05:00.000Z");
const past = new Date("2026-09-10T11:59:00.000Z");

function plan(
  state:
    | "IDLE"
    | "PREPARING"
    | "PROVIDER_UNKNOWN"
    | "PROVIDER_ACCEPTED"
    | "ACTIVE"
    | "PROVIDER_REJECTED"
    | "PROVIDER_ACCEPTED_ACTIVATION_FAILED",
  leaseExpiresAt: Date | null,
) {
  return planScheduleInviteRecovery({
    state,
    now,
    leaseExpiresAt,
    attemptExpiresAt: future,
    recipientMatches: true,
    pepperKeyAvailable: true,
  });
}

describe("recuperação da outbox de convite", () => {
  it("resposta perdida mantém a geração e espera a lease", () => {
    expect(plan("PROVIDER_UNKNOWN", future)).toEqual({ kind: "WAIT" });
    expect(plan("PROVIDER_UNKNOWN", past)).toEqual({
      kind: "REPLAY_DELIVERY",
    });
  });

  it("crash pós-envio em PREPARING repete a mesma geração após a lease", () => {
    expect(plan("PREPARING", future)).toEqual({ kind: "WAIT" });
    expect(plan("PREPARING", past)).toEqual({
      kind: "REPLAY_DELIVERY",
    });
  });

  it("aceite persistido nunca reenvia e retoma somente a ativação", () => {
    expect(plan("PROVIDER_ACCEPTED", past)).toEqual({
      kind: "RESUME_ACTIVATION",
    });
    expect(plan("PROVIDER_ACCEPTED_ACTIVATION_FAILED", null)).toEqual({
      kind: "RESUME_ACTIVATION",
    });
  });

  it("rejeição definitiva libera uma nova geração", () => {
    expect(plan("PROVIDER_REJECTED", null)).toEqual({
      kind: "NEW_GENERATION",
      supersedesUncertainGeneration: false,
    });
  });

  it("pepper rotacionado ausente falha fechado durante tentativa vigente", () => {
    expect(
      planScheduleInviteRecovery({
        state: "PROVIDER_UNKNOWN",
        now,
        leaseExpiresAt: past,
        attemptExpiresAt: future,
        recipientMatches: true,
        pepperKeyAvailable: false,
      }),
    ).toEqual({ kind: "FAIL_CLOSED" });
  });

  it("expiração invalida a incerteza antes de abrir geração nova", () => {
    expect(
      planScheduleInviteRecovery({
        state: "PROVIDER_UNKNOWN",
        now,
        leaseExpiresAt: past,
        attemptExpiresAt: past,
        recipientMatches: true,
        pepperKeyAvailable: true,
      }),
    ).toEqual({
      kind: "NEW_GENERATION",
      supersedesUncertainGeneration: true,
    });
  });
});
