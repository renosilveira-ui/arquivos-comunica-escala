import { describe, expect, it } from "vitest";
import {
  assertDutyConfirmationCycleToken,
  assertDutyConfirmationRecheckEpoch,
  canonicalDutyConfirmationEpoch,
  isCanonicalDutyConfirmationEpoch,
} from "../server/confirmation-integrity";
import { transitionDutyConfirmation } from "../server/confirmation-state";

describe("epoch da notificação de nomeação", () => {
  const current = new Date("2026-09-10T12:30:00.000Z");
  const currentToken = "33333333-3333-4333-8333-333333333333";
  const staleToken = "44444444-4444-4444-8444-444444444444";

  it("normaliza a precisão para os segundos persistidos pelo MySQL", () => {
    const canonical = canonicalDutyConfirmationEpoch(
      new Date("2026-09-10T12:30:00.987Z"),
    );
    expect(canonical.getUTCMilliseconds()).toBe(0);
    expect(canonical.toISOString()).toBe("2026-09-10T12:30:00.000Z");
    expect(isCanonicalDutyConfirmationEpoch(canonical.toISOString())).toBe(
      true,
    );
    expect(
      isCanonicalDutyConfirmationEpoch("2026-09-10T12:30:00.987Z"),
    ).toBe(false);
  });

  it("aceita somente a epoch ISO exatamente persistida", () => {
    expect(() =>
      assertDutyConfirmationRecheckEpoch(current, current.toISOString()),
    ).not.toThrow();
  });

  it("rejeita intenção de ciclo anterior e epoch malformada", () => {
    expect(() =>
      assertDutyConfirmationRecheckEpoch(
        current,
        "2026-09-10T12:00:00.000Z",
      ),
    ).toThrow("A indicação mudou depois que a intenção foi criada");
    expect(() =>
      assertDutyConfirmationRecheckEpoch(current, "nao-e-iso"),
    ).toThrow("A indicação mudou depois que a intenção foi criada");
  });

  it("distingue duas indicações mesmo quando recaem no mesmo segundo", () => {
    expect(() =>
      assertDutyConfirmationCycleToken(currentToken, currentToken),
    ).not.toThrow();
    expect(() =>
      assertDutyConfirmationCycleToken(currentToken, staleToken),
    ).toThrow("A indicação mudou depois que a intenção foi criada");
    expect(() =>
      assertDutyConfirmationCycleToken(currentToken, "token-malformado"),
    ).toThrow("A indicação mudou depois que a intenção foi criada");
  });

  it.each(["ACCEPT_NOMINATION", "DECLINE_NOMINATION"] as const)(
    "%s falha antes do banco quando o token do ciclo é inválido",
    async (kind) => {
      const txThatMustNotBeReached = {
        update: () => {
          throw new Error("UPDATE não deveria ser alcançado");
        },
      };
      const base = {
        kind,
        confirmationId: 10,
        expectedInstitutionId: 20,
        expectedShiftInstanceId: 30,
        expectedAssignmentId: 40,
        expectedProfessionalId: 50,
        expectedOriginalUserId: 60,
        expectedStatus: "NOMINATED" as const,
        expectedConfirmationToken: "token-malformado",
        expectedReplacementProfessionalId: 70,
        expectedReplacementUserId: 80,
        respondedAt: current,
      };

      await expect(
        transitionDutyConfirmation(
          txThatMustNotBeReached as never,
          kind === "DECLINE_NOMINATION"
            ? { ...base, kind, recheckAt: current }
            : base,
        ),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "A indicação exige um identificador de ciclo válido",
      });
    },
  );
});
