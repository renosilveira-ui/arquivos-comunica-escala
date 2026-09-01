import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("wiring transacional do ciclo de troca em SHADOW", () => {
  it("emite oferta antes do sinal legado, na mesma transação", () => {
    const source = readFileSync("server/swap-offer-create.ts", "utf8");
    const eventIndex = source.indexOf(
      'recordSwapLifecycleShadowEventInTransaction(tx, {\n      eventType: "SWAP_OFFERED"',
    );
    const legacySignalIndex = source.indexOf("await enqueueSwapOfferSignals");
    expect(eventIndex).toBeGreaterThan(-1);
    expect(legacySignalIndex).toBeGreaterThan(eventIndex);
    const eventSource = readFileSync(
      "server/swap-lifecycle-operational-events.ts",
      "utf8",
    );
    expect(eventSource).toContain("eligibleRecipientUserIdsForSwapOffer");
    expect(eventSource).not.toContain('from "./specialty"');
    expect(eventSource).not.toContain("assertSpecialtyCompatible");
    expect(eventSource).toContain(
      "eq(shiftAssignmentsV2.professionalId, swap.fromProfessionalId)",
    );
    expect(eventSource).toContain(
      "eq(professionals.userId, swap.fromUserId)",
    );
  });

  it("registra conclusão antes das filas legadas e inclui origem residual", () => {
    const source = readFileSync("server/swap-router.ts", "utf8");
    const transfer = source.slice(
      source.indexOf("async function applySwapAssignmentTransfer"),
      source.indexOf("function leftoverHealReviewer"),
    );
    expect(transfer).toContain('eventType: "SWAP_ACCEPTED"');
    expect(transfer).toContain("previousStatus: input.expectedStatus");
    expect(transfer.indexOf('eventType: "SWAP_ACCEPTED"')).toBeLessThan(
      transfer.indexOf("await enqueueSwapCompletionNotifications"),
    );
  });

  it("separa rejeição dirigida da dismiss individual e não toca no auto-unwind", () => {
    const source = readFileSync("server/swap-router.ts", "utf8");
    const reject = source.slice(
      source.indexOf("  reject: protectedProcedure"),
      source.indexOf("  // ── approveByOwner"),
    );
    expect(reject).toContain("if (!isOpenSwapOffer(current))");
    expect(reject).toContain('eventType: "SWAP_REJECTED"');

    const unwind = source.slice(
      source.indexOf("async function unwindLeftoverAcceptedSwap"),
      source.indexOf("async function applyLeftoverHealDenial"),
    );
    expect(unwind).not.toContain("recordSwapLifecycleShadowEventInTransaction");
  });

  it("faz cancelamento explícito registrar fato após o CAS e antes do commit", () => {
    const source = readFileSync("server/swap-router.ts", "utf8");
    const cancel = source.slice(
      source.indexOf("  cancel: protectedProcedure"),
      source.indexOf("  // ── list"),
    );
    expect(cancel).toContain('eventType: "SWAP_CANCELLED"');
    expect(cancel.indexOf("transitionSwapStatusForUpdate")).toBeLessThan(
      cancel.indexOf('eventType: "SWAP_CANCELLED"'),
    );
    expect(cancel).toContain("ASSIGNMENT_WRITE_TRANSACTION_CONFIG");
  });
});
