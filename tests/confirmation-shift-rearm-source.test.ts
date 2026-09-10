import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const lifecycle = readFileSync("server/confirmation-lifecycle.ts", "utf8");
const shifts = readFileSync("server/shifts-crud.ts", "utf8");
const dispatcher = readFileSync(
  "server/cron/shift-confirmation-dispatcher.ts",
  "utf8",
);
const delivery = readFileSync("server/push-delivery.ts", "utf8");
const router = readFileSync("server/confirmation-router.ts", "utf8");

describe("rearme de confirmação após mudança de horário", () => {
  it("revoga o ciclo anterior sob validação e CAS sem apagar histórico", () => {
    expect(lifecycle).toContain(
      "export async function rearmDutyConfirmationsAfterShiftChange",
    );
    expect(lifecycle).toContain("await requireValidDutyConfirmation");
    expect(lifecycle).toContain(
      "requireOriginalAssignmentActive: !replacementCycle",
    );
    expect(lifecycle).toContain("requireEffectiveAssignment: replacementCycle");
    expect(lifecycle).toContain('snapshot.status === "REPLACEMENT_CONFIRMED"');
    expect(lifecycle).toContain(
      "activeProfessionalIds.has(snapshot.replacementProfessionalId)",
    );
    expect(lifecycle).toContain("lockForUpdate: true");
    expect(lifecycle).toContain('status: "PENDING"');
    expect(lifecycle).toContain("confirmationToken: randomUUID()");
    expect(lifecycle).toContain("recheckAt: null");
    expect(lifecycle).toContain("notifiedAt: null");
    expect(lifecycle).toContain("replacementProfessionalId: null");
    expect(lifecycle).toContain("assignmentId: effective.assignmentId");
    expect(lifecycle).toContain("professionalId: effective.professionalId");
    expect(lifecycle).toContain("userId: effective.userId");
    expect(lifecycle).toContain(
      "replacementUserId: dutyConfirmations.replacementUserId",
    );
    expect(lifecycle).toContain(
      "eq(dutyConfirmations.status, snapshot.status)",
    );
    expect(lifecycle).toContain("updated.affectedRows !== 1");
    expect(lifecycle).not.toContain("delete(dutyConfirmations)");
  });

  it("persiste a compensação do intervalo antigo antes de rearmar", () => {
    const rewrite = shifts.indexOf("await enqueueDutySyncIntervalRewrite");
    const rearm = shifts.indexOf(
      "await rearmDutyConfirmationsAfterShiftChange",
    );
    expect(rewrite).toBeGreaterThan(-1);
    expect(rearm).toBeGreaterThan(rewrite);
    expect(shifts.slice(rewrite, rearm)).toContain("previousSnapshot");
    expect(shifts.slice(rewrite, rearm)).toContain(
      "reconfirmRequired: confirmationCycleChanged",
    );
    expect(shifts).toContain("rearmedConfirmationCount");
    expect(shifts).toContain("if (confirmationCycleChanged)");
    expect(shifts).toContain(
      "windowChanged || nextDutyType !== previousDutyType",
    );
    expect(shifts).toContain(
      "const activeAssignments = confirmationCycleChanged",
    );
  });

  it("não redeclara automaticamente e versiona o duty-sync pela confirmação", () => {
    const lifecycleSync = readFileSync(
      "server/sso/duty-sync-lifecycle.ts",
      "utf8",
    );

    expect(lifecycleSync).toContain("!input.reconfirmRequired");
    expect(lifecycleSync).toContain(":cycle:${confirmationToken}");
    expect(lifecycleSync).toContain(
      "confirmationToken: dutyConfirmations.confirmationToken",
    );
    expect(lifecycleSync).toContain(
      "input.previousSnapshot.startAt,\n          row.confirmationToken",
    );
    expect(lifecycleSync).toContain(
      "input.nextSnapshot.startAt,\n            row.confirmationToken",
    );
    expect(
      router.match(
        /dedupKey: dutySync(?:Confirm|Withdraw|ReplacementConfirm)DedupKey\([\s\S]*?current\.confirmation\.confirmationToken,\n\s*\)/g,
      ),
    ).toHaveLength(4);
  });

  it("materializa novamente somente quando due e cria nova deduplicação", () => {
    expect(dispatcher).toContain("confirmationId: dutyConfirmations.id");
    expect(dispatcher).toContain("isNull(dutyConfirmations.recheckAt)");
    expect(dispatcher).toContain(
      "eq(dutyConfirmations.managerNotified, false)",
    );
    expect(dispatcher).toContain("if (assignment.confirmationId === null)");
    expect(dispatcher).toContain("const [claimedRearm]");
    expect(dispatcher).toContain(".set({ recheckAt, notifiedAt: null })");
    expect(dispatcher).toContain("claimedRearm.affectedRows !== 1");
    expect(
      dispatcher.match(/eq\(dutyConfirmations\.managerNotified, false\)/g),
    ).toHaveLength(3);
    expect(dispatcher).toContain(
      ":request:${confirmationToken}:${current.original.userId}`",
    );
    expect(dispatcher).toContain("confirmationToken,");
  });

  it("não cria segunda confirmação para o assignment efetivo do substituto", () => {
    expect(lifecycle).toContain(
      "const current = await requireValidDutyConfirmation",
    );
    expect(lifecycle).toContain("const effective = current.effective");
    expect(dispatcher).toContain(
      'eq(dutyConfirmations.status, "REPLACEMENT_CONFIRMED")',
    );
    expect(dispatcher).toContain(
      "dutyConfirmations.replacementProfessionalId,\n              shiftAssignmentsV2.professionalId",
    );
    expect(dispatcher).toContain(
      "eq(dutyConfirmations.replacementUserId, professionals.userId)",
    );
    expect(dispatcher).toContain(
      "eq(dutyConfirmations.institutionId, shiftAssignmentsV2.institutionId)",
    );
    expect(dispatcher).toContain(
      "eq(dutyConfirmations.assignmentId, shiftAssignmentsV2.id)",
    );
  });

  it("prende novos pushes ao token e oculta ciclo ainda não materializado", () => {
    expect(delivery).toContain(
      'state.authority.purpose === "CONFIRMATION_REQUEST" &&',
    );
    expect(delivery).toContain(
      "isConfirmationRouteToken(state.payloadData.confirmationToken)",
    );
    expect(delivery).toContain(
      "dutyConfirmations.confirmationToken,\n              claimed.payloadData.confirmationToken",
    );
    expect(router).toContain("isNotNull(dutyConfirmations.recheckAt)");
  });
});
