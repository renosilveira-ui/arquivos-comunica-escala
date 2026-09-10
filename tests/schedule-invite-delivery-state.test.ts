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
    attemptCount: state === "IDLE" ? 0 : 1,
    maxAttempts: 3,
    terminalFailure: false,
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
          attemptCount: 1,
          maxAttempts: 3,
          terminalFailure: false,
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
        attemptCount: 1,
        maxAttempts: 3,
        terminalFailure: false,
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

  it("encerra a geração ao atingir o limite e não abre outra silenciosamente", () => {
    expect(
      planScheduleInviteRecovery({
        state: "PROVIDER_UNKNOWN",
        now,
        leaseExpiresAt: past,
        attemptExpiresAt: future,
        recipientMatches: true,
        pepperKeyAvailable: true,
        attemptCount: 3,
        maxAttempts: 3,
        terminalFailure: false,
      }),
    ).toEqual({ kind: "TERMINAL_FAILURE" });
    expect(
      planScheduleInviteRecovery({
        state: "PREPARING",
        now,
        leaseExpiresAt: future,
        attemptExpiresAt: future,
        recipientMatches: true,
        pepperKeyAvailable: true,
        attemptCount: 3,
        maxAttempts: 3,
        terminalFailure: false,
      }),
    ).toEqual({ kind: "WAIT" });
    expect(
      planScheduleInviteRecovery({
        state: "PREPARING",
        now,
        leaseExpiresAt: past,
        attemptExpiresAt: past,
        recipientMatches: null,
        pepperKeyAvailable: false,
        attemptCount: 3,
        maxAttempts: 3,
        terminalFailure: false,
      }),
    ).toEqual({ kind: "TERMINAL_FAILURE" });
    expect(
      planScheduleInviteRecovery({
        state: "PROVIDER_REJECTED",
        now,
        leaseExpiresAt: null,
        attemptExpiresAt: future,
        recipientMatches: true,
        pepperKeyAvailable: true,
        attemptCount: 1,
        maxAttempts: 3,
        terminalFailure: true,
      }),
    ).toEqual({ kind: "TERMINAL_FAILURE" });
  });

  it("falha fechado para contadores persistidos impossíveis", () => {
    for (const attempts of [
      { attemptCount: 0, maxAttempts: 3 },
      { attemptCount: 4, maxAttempts: 3 },
      { attemptCount: 1, maxAttempts: 0 },
      { attemptCount: 1, maxAttempts: 6 },
    ]) {
      expect(
        planScheduleInviteRecovery({
          state: "PROVIDER_UNKNOWN",
          now,
          leaseExpiresAt: past,
          attemptExpiresAt: future,
          recipientMatches: true,
          pepperKeyAvailable: true,
          terminalFailure: false,
          ...attempts,
        }),
      ).toEqual({ kind: "FAIL_CLOSED" });
    }
  });
});
