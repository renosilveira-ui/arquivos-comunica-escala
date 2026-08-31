import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function block(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from, `âncora inicial ausente: ${start}`).toBeGreaterThanOrEqual(0);
  expect(to, `âncora final ausente: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

function expectReadOnlyProcedure(source: string, name: string): void {
  expect(source, `${name} deve continuar query`).toContain(".query(async");
  for (const writer of [
    ".transaction(",
    ".update(",
    ".insert(",
    ".delete(",
    "recordAudit(",
    "enqueue",
    "reconcileAcceptedResidualSwap(",
    "completeAcceptedResidualSwap(",
    "cancelAcceptedResidualSwap(",
    "reconcileAcceptedResidualFailure(",
  ]) {
    expect(source, `${name} não pode chamar ${writer}`).not.toContain(writer);
  }
}

describe("swaps: pureza dos caminhos de leitura", () => {
  it("list e getById não podem reconciliar ou escrever", () => {
    const source = readFileSync("server/swap-router.ts", "utf8");
    const list = block(source, "  list: protectedProcedure", "  // ── getById");
    const getById = block(
      source,
      "  getById: protectedProcedure",
      "  // ── listAvailable",
    );

    expectReadOnlyProcedure(list, "swaps.list");
    expectReadOnlyProcedure(getById, "swaps.getById");
    expect(list).toContain("filterReadableSwaps");
    expect(list).not.toContain("ACCEPTED residual: lista tenta");
  });

  it("reconciliação residual é mutation explícita, escopada e autorizada", () => {
    const source = readFileSync("server/swap-router.ts", "utf8");
    const reconcile = block(
      source,
      "  reconcileAccepted: protectedProcedure",
      "  // ── reject (by peer)",
    );

    expect(reconcile).toContain("swapRequestId: z.number().int().positive()");
    expect(reconcile).toContain(".mutation(async");
    expect(reconcile).toContain(
      "eq(swapRequests.institutionId, institutionId)",
    );
    expect(reconcile).toContain("assertActorCanReadSwap(actor, swap)");
    expect(reconcile).toContain("reconcileAcceptedResidualSwap(");
  });

  it("reconciliação conserva a ordem de locks antes de revalidar o ator", () => {
    const source = readFileSync("server/swap-router.ts", "utf8");
    const effectuation = block(
      source,
      "async function effectuateApprovedSwap(",
      "async function completeAcceptedResidualSwap(",
    );
    const assignmentLocks = effectuation.indexOf(
      "await lockAssignmentProfessionalsForUpdate(",
    );
    const actorRevalidation = effectuation.indexOf(
      "await requireAcceptedResidualReconcilerForUpdate(",
    );
    const transfer = effectuation.indexOf("await applySwapAssignmentTransfer(");

    expect(assignmentLocks).toBeGreaterThanOrEqual(0);
    expect(actorRevalidation).toBeGreaterThan(assignmentLocks);
    expect(transfer).toBeGreaterThan(actorRevalidation);
  });

  it("gestor não participante valida todo alvo e registra a autoridade efetiva", () => {
    const source = readFileSync("server/swap-router.ts", "utf8");
    const authorizer = block(
      source,
      "async function requireAcceptedResidualReconcilerForUpdate(",
      "function isLeftoverAlreadyResolvedConflict(",
    );
    const topologyTargets = block(
      source,
      "function acceptedResidualManagerScopeTargetsFromTopology(",
      "async function acceptedResidualManagerScopeTargetsForUpdate(",
    );

    expect(authorizer).toContain("for (const target of managerScopeTargets)");
    expect(authorizer).toContain("target.hospitalId");
    expect(authorizer).toContain("target.sectorId");
    expect(authorizer).toContain("target.dates");
    expect(authorizer).toContain("auditRole: managerRole!");
    expect(topologyTargets).toContain("topology.toTuple");
  });

  it("cancelamento residual bloqueia os turnos em ordem antes de derivar o escopo", () => {
    const source = readFileSync("server/swap-router.ts", "utf8");
    const targetLookup = block(
      source,
      "async function acceptedResidualManagerScopeTargetsForUpdate(",
      "function isLeftoverAlreadyResolvedConflict(",
    );

    expect(targetLookup.indexOf("await lockSwapShiftsForUpdate(")).toBeGreaterThanOrEqual(0);
    expect(targetLookup.indexOf("await requireCanonicalShift(")).toBeGreaterThan(
      targetLookup.indexOf("await lockSwapShiftsForUpdate("),
    );
  });
});
