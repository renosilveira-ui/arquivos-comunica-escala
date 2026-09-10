import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("server/swap-router.ts", "utf8");

function sliceBetween(start: string, end: string): string {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  expect(startAt).toBeGreaterThanOrEqual(0);
  expect(endAt).toBeGreaterThan(startAt);
  return source.slice(startAt, endAt);
}

describe("swap — guarda canônica de capacidade no fonte", () => {
  it("valida uma vez cada turno, em ordem estável e com delta zero", () => {
    const guard = sliceBetween(
      "async function assertSwapAssignmentCapacityForUpdate",
      "async function deactivateActiveAssignment",
    );

    expect(guard).toContain("topology.source.shift");
    expect(guard).toContain("topology.toTuple?.shift");
    expect(guard).toContain("new Map(");
    expect(guard).toContain("left.id - right.id");
    expect(guard).toContain("assertShiftAssignmentCapacityForUpdate(tx");
    expect(guard).toContain("shiftInstanceId: shift.id");
    expect(guard).toContain("institutionId: shift.institutionId");
    expect(guard).toContain("hospitalId: shift.hospitalId");
    expect(guard).toContain("sectorId: shift.sectorId");
    expect(guard).toContain("activeDelta: 0");
  });

  it("protege o writer compartilhado antes de qualquer transferência", () => {
    const transfer = sliceBetween(
      "async function applySwapAssignmentTransfer",
      "const conflictMessage",
    );
    const capacity = transfer.indexOf(
      "await assertSwapAssignmentCapacityForUpdate(tx, topology)",
    );
    const write = transfer.indexOf("await writeTransferredAssignments(");

    expect(capacity).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(capacity);
  });

  it("approveByOwner residual chega ao writer protegido depois dos locks", () => {
    const ownerFlow = sliceBetween(
      "async function effectuateApprovedSwap",
      "// ─── router",
    );
    const shiftsLock = ownerFlow.indexOf("lockSwapShiftsForUpdate");
    const assignmentsLock = ownerFlow.indexOf("lockSwapAssignmentsForUpdate");
    const transfer = ownerFlow.indexOf("applySwapAssignmentTransfer");

    expect(shiftsLock).toBeGreaterThan(-1);
    expect(assignmentsLock).toBeGreaterThan(shiftsLock);
    expect(transfer).toBeGreaterThan(assignmentsLock);
  });

  it("accept canônico chega ao mesmo writer protegido depois dos locks", () => {
    const acceptFlow = sliceBetween(
      "accept: protectedProcedure",
      "reject: protectedProcedure",
    );
    const shiftsLock = acceptFlow.indexOf("lockSwapShiftsForUpdate");
    const assignmentsLock = acceptFlow.indexOf("lockSwapAssignmentsForUpdate");
    const transfer = acceptFlow.indexOf("applySwapAssignmentTransfer");

    expect(shiftsLock).toBeGreaterThan(-1);
    expect(assignmentsLock).toBeGreaterThan(shiftsLock);
    expect(transfer).toBeGreaterThan(assignmentsLock);
  });
});
