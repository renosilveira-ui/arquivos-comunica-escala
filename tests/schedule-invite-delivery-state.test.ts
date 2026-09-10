import { describe, expect, it } from "vitest";
import {
  isScheduleInviteAttemptLive,
  planScheduleInviteRecovery,
} from "../server/schedule-invite-delivery-state";

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

  it("crash pós-envio só permite replay após a lease", () => {
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

  it.each([
    "PREPARING",
    "PROVIDER_UNKNOWN",
    "PROVIDER_ACCEPTED",
    "ACTIVE",
    "PROVIDER_ACCEPTED_ACTIVATION_FAILED",
  ] as const)(
    "pepper/key-id ausente em tentativa vigente falha antes do match em %s",
    (state) => {
      expect(
        planScheduleInviteRecovery({
          state,
          now,
          leaseExpiresAt: past,
          attemptExpiresAt: future,
          // Sem pepper não há combinação válida capaz de calcular o match.
          recipientMatches: null,
          pepperKeyAvailable: false,
        }),
      ).toEqual({ kind: "FAIL_CLOSED" });
    },
  );

  it("IDLE abre a primeira geração quando a política de escrita está disponível", () => {
    expect(plan("IDLE", null)).toEqual({
      kind: "NEW_GENERATION",
      supersedesUncertainGeneration: false,
    });
  });

  it("expiração invalida a incerteza antes de abrir geração nova", () => {
    expect(
      planScheduleInviteRecovery({
        state: "PROVIDER_UNKNOWN",
        now,
        leaseExpiresAt: past,
        attemptExpiresAt: past,
        // Expirada, a geração antiga pode ser substituída sem resolver a chave.
        recipientMatches: null,
        pepperKeyAvailable: false,
      }),
    ).toEqual({
      kind: "NEW_GENERATION",
      supersedesUncertainGeneration: true,
    });
  });

  it("considera o instante exato de expiração como vencido", () => {
    expect(isScheduleInviteAttemptLive(future, now)).toBe(true);
    expect(isScheduleInviteAttemptLive(now, now)).toBe(false);
    expect(isScheduleInviteAttemptLive(past, now)).toBe(false);
  });
});
