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
      "export async function rearmDutyConfirmationsAfterShiftWindowChange",
    );
    expect(lifecycle).toContain("await requireValidDutyConfirmation");
    expect(lifecycle).toContain("requireOriginalAssignmentActive: true");
    expect(lifecycle).toContain("lockForUpdate: true");
    expect(lifecycle).toContain('status: "PENDING"');
    expect(lifecycle).toContain("confirmationToken: randomUUID()");
    expect(lifecycle).toContain("recheckAt: null");
    expect(lifecycle).toContain("notifiedAt: null");
    expect(lifecycle).toContain("replacementProfessionalId: null");
    expect(lifecycle).toContain(
      "eq(dutyConfirmations.status, snapshot.status)",
    );
    expect(lifecycle).toContain("updated.affectedRows !== 1");
    expect(lifecycle).not.toContain("delete(dutyConfirmations)");
  });

  it("persiste a compensação do intervalo antigo antes de rearmar", () => {
    const rewrite = shifts.indexOf("await enqueueDutySyncIntervalRewrite");
    const rearm = shifts.indexOf(
      "await rearmDutyConfirmationsAfterShiftWindowChange",
    );
    expect(rewrite).toBeGreaterThan(-1);
    expect(rearm).toBeGreaterThan(rewrite);
    expect(shifts.slice(rewrite, rearm)).toContain("previousSnapshot");
    expect(shifts).toContain("rearmedConfirmationCount");
    expect(shifts).toContain("if (windowChanged)");
  });

  it("materializa novamente somente quando due e cria nova deduplicação", () => {
    expect(dispatcher).toContain("confirmationId: dutyConfirmations.id");
    expect(dispatcher).toContain("isNull(dutyConfirmations.recheckAt)");
    expect(dispatcher).toContain("if (assignment.confirmationId === null)");
    expect(dispatcher).toContain("const [claimedRearm]");
    expect(dispatcher).toContain(".set({ recheckAt, notifiedAt: null })");
    expect(dispatcher).toContain("claimedRearm.affectedRows !== 1");
    expect(dispatcher).toContain(
      ":request:${confirmationToken}:${current.original.userId}`",
    );
    expect(dispatcher).toContain("confirmationToken,");
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
