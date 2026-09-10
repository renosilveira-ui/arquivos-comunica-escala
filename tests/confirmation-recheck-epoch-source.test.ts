import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("cerca ponta a ponta da epoch de confirmação", () => {
  it("exige par dirigido completo e recusa ambiguidade no lookup manual", () => {
    const router = readFileSync("server/confirmation-router.ts", "utf8");

    expect(router).toContain("nominationDirectedInputSchema.optional()");
    expect(router).toContain("if (!input && candidates.length > 1)");
    expect(router).toContain(".input(nominationDirectedInputSchema)");
    expect(router.match(/\.input\(nominationDirectedInputSchema\)/g)).toHaveLength(
      2,
    );
    expect(
      router.match(/assertDutyConfirmationRecheckEpoch\(/g)?.length,
    ).toBeGreaterThanOrEqual(4);
    expect(
      router.match(/canonicalDutyConfirmationEpoch\(/g)?.length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("propaga epoch gerencial nos dois motivos e faz CAS no receipt", () => {
    const dispatcher = readFileSync(
      "server/cron/shift-confirmation-dispatcher.ts",
      "utf8",
    );
    const delivery = readFileSync("server/push-delivery.ts", "utf8");

    expect(dispatcher).toContain(
      'export type ConfirmationEscalationReason = "PUSH_UNCONFIRMED" | "NO_RESPONSE"',
    );
    expect(dispatcher).toContain("recheckEpoch,");
    expect(dispatcher).toContain("confirmationToken,");
    expect(dispatcher).toContain("${recheckRevision}:${confirmationToken}");
    expect(dispatcher).toContain(
      "const recheckEpoch = valid.confirmation.recheckAt?.toISOString()",
    );
    expect(delivery).toContain(
      'authority.purpose === "MANAGER_ESCALATION"',
    );
    expect(delivery).toContain("dutyConfirmations.recheckAt,");
    expect(delivery).toContain("claimed.authority.recheckEpoch");
    expect(delivery).toContain("claimed.authority.confirmationToken");
    expect(delivery).toContain(
      "eq(dutyConfirmations.confirmationToken, confirmationToken)",
    );
    expect(delivery).toContain("consumedCurrentCycle.affectedRows !== 1");
  });

  it("rotaciona UUID e inclui o ciclo na autoridade e deduplicação da nomeação", () => {
    const router = readFileSync("server/confirmation-router.ts", "utf8");
    const state = readFileSync("server/confirmation-state.ts", "utf8");

    expect(router).toContain("const nominationToken = randomUUID()");
    expect(router).toContain("nextConfirmationToken: nominationToken");
    expect(router).toContain(
      "nomination:${nominationToken}:${candidate.userId}",
    );
    expect(router.match(/confirmationToken: nominationToken/g)).toHaveLength(2);
    expect(state).toContain("confirmationToken: command.nextConfirmationToken");
    expect(state).toContain(
      "command.expectedConfirmationToken === command.nextConfirmationToken",
    );
    expect(
      state.match(/dutyConfirmations\.confirmationToken/g)?.length,
    ).toBeGreaterThanOrEqual(4);
    expect(
      state.match(/command\.expectedConfirmationToken/g)?.length,
    ).toBeGreaterThanOrEqual(6);
  });

  it("revalida o token depois de toda reconstrução canônica dirigida", () => {
    const router = readFileSync("server/confirmation-router.ts", "utf8");

    const canonicalReadCount =
      router.match(/requireValidDutyConfirmation\(/g)?.length ?? 0;
    const cycleAssertionCount =
      router.match(/assertDutyConfirmationCycleToken\(/g)?.length ?? 0;
    expect(canonicalReadCount).toBeGreaterThan(0);
    expect(cycleAssertionCount).toBe(canonicalReadCount);
    expect(router).toContain(
      "current.confirmation.confirmationToken,\n          input.confirmationToken",
    );
    expect(router).toContain(
      "valid.confirmation.confirmationToken,\n        input.confirmationToken",
    );
  });

  it("vincula a recusa do substituto ao ciclo exato no payload, autoridade e dedupe", () => {
    const router = readFileSync("server/confirmation-router.ts", "utf8");
    const delivery = readFileSync("server/push-delivery.ts", "utf8");

    expect(router).toContain(
      "replacement-declined:${current.confirmation.confirmationToken}",
    );
    expect(router).toContain(
      'purpose: "REPLACEMENT_DECLINED_NOTICE"',
    );
    expect(router.match(/confirmationToken: current\.confirmation\.confirmationToken/g))
      .toHaveLength(2);
    expect(delivery).toContain(
      'purpose === "REPLACEMENT_DECLINED_NOTICE"',
    );
    expect(delivery).toContain(
      "dutyConfirmationPurposeRequiresCycleToken(state.authority.purpose)",
    );
  });

  it("não consulta nomeação dirigida sem token e epoch válidos", () => {
    const screen = readFileSync("app/confirm-duty.tsx", "utf8");

    expect(screen).toContain("const malformedDirectedRoute =");
    expect(screen).toContain("directedToken && directedNominationEpoch");
    expect(screen).toContain(
      "!hasDirectedToken || directedNominationInput !== undefined",
    );
  });
});
