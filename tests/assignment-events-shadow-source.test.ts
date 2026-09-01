import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const editor = readFileSync("server/editor.ts", "utf8");
const confirmations = readFileSync("server/confirmation-router.ts", "utf8");
const assignmentEvents = readFileSync(
  "server/assignment-operational-events.ts",
  "utf8",
);
const operationalEvents = readFileSync("server/operational-events.ts", "utf8");
const swapRouter = readFileSync("server/swap-router.ts", "utf8");
const shiftsCrud = readFileSync("server/shifts-crud.ts", "utf8");
const legacyRouters = readFileSync("server/routers.ts", "utf8");

function section(source: string, start: string, end?: string): string {
  const startIndex = source.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = end ? source.indexOf(end, startIndex) : -1;
  return source.slice(startIndex, endIndex >= 0 ? endIndex : undefined);
}

describe("wiring dos fatos SHADOW de assignment", () => {
  it("mantém markVacant e swap-router fora da frente", () => {
    const markVacant = section(
      editor,
      "markVacant: protectedProcedure",
      "unassignDirect: protectedProcedure",
    );

    expect(markVacant).not.toContain(
      "captureCanonicalAssignmentShadowRecipient",
    );
    expect(markVacant).not.toContain(
      "recordAssignmentShadowEventInTransaction",
    );
    expect(markVacant).not.toContain("operationalRevision");
    expect(swapRouter).not.toContain("assignment-operational-events");
    expect(swapRouter).not.toContain("operationalRevision");
    expect(shiftsCrud).not.toContain("assignment-operational-events");
    expect(shiftsCrud).not.toContain("operationalRevision");
    expect(legacyRouters).not.toContain("assignment-operational-events");
    expect(legacyRouters).not.toContain("operationalRevision");
  });

  it("cria alocação direta com revisão 1 e emite no mesmo tx", () => {
    const directAssignment = section(
      editor,
      "async function insertDirectAssignment",
      "function assertSameAssignmentTarget",
    );
    const createdRevision = directAssignment.indexOf("operationalRevision: 1");
    const capture = directAssignment.indexOf(
      "captureCanonicalAssignmentShadowRecipient",
    );
    const record = directAssignment.indexOf(
      "recordAssignmentShadowEventInTransaction",
    );

    expect(createdRevision).toBeGreaterThanOrEqual(0);
    expect(capture).toBeGreaterThan(createdRevision);
    expect(record).toBeGreaterThan(capture);
    expect(directAssignment).toContain('operation: "DIRECT_ASSIGNMENT"');
  });

  it("captura o destinatário antes da retirada e incrementa a revisão sob CAS", () => {
    const unassign = section(editor, "unassignDirect: protectedProcedure");
    const capture = unassign.indexOf(
      "captureCanonicalAssignmentShadowRecipient",
    );
    const deactivation = unassign.indexOf(".update(shiftAssignmentsV2)");
    const record = unassign.indexOf("recordAssignmentShadowEventInTransaction");

    expect(capture).toBeGreaterThanOrEqual(0);
    expect(deactivation).toBeGreaterThan(capture);
    expect(unassign).toContain(
      "operationalRevision: lockedAssignment.operationalRevision + 1",
    );
    expect(unassign).toContain(
      "shiftAssignmentsV2.operationalRevision,\n                lockedAssignment.operationalRevision",
    );
    expect(record).toBeGreaterThan(deactivation);
    expect(unassign).toContain('operation: "DIRECT_REMOVAL"');
  });

  it("limita acceptNomination à substituição confirmada, com as duas revisões canônicas", () => {
    const acceptNomination = section(
      confirmations,
      "acceptNomination: protectedProcedure",
      "declineNomination: protectedProcedure",
    );
    const captureOriginal = acceptNomination.indexOf(
      "capturedOriginalRecipient",
    );
    const deactivation = acceptNomination.indexOf(
      ".update(shiftAssignmentsV2)",
    );
    const createReplacement = acceptNomination.indexOf(
      ".insert(shiftAssignmentsV2)",
    );
    const removeEvent = acceptNomination.indexOf(
      'operation: "SUBSTITUTION_REMOVAL"',
    );
    const assignEvent = acceptNomination.indexOf(
      'operation: "SUBSTITUTION_ASSIGNMENT"',
    );

    expect(acceptNomination).toContain('allowedStatuses: ["NOMINATED"]');
    expect(captureOriginal).toBeGreaterThanOrEqual(0);
    expect(deactivation).toBeGreaterThan(captureOriginal);
    expect(acceptNomination).toContain(
      "operationalRevision:\n              capturedOriginalRecipient.operationalRevision + 1",
    );
    expect(createReplacement).toBeGreaterThan(deactivation);
    expect(acceptNomination).toContain("operationalRevision: 1");
    expect(removeEvent).toBeGreaterThan(createReplacement);
    expect(assignEvent).toBeGreaterThan(removeEvent);
  });

  it("só carrega IDs canônicos e não chama transportador ou provider", () => {
    for (const identifier of [
      "institutionId",
      "hospitalId",
      "sectorId",
      "scheduleContextId",
      "shiftInstanceId",
      "assignmentId",
    ]) {
      expect(assignmentEvents).toContain(identifier);
    }
    expect(assignmentEvents).not.toContain("professionals.name");
    expect(assignmentEvents).not.toContain("shiftInstances.label");
    expect(assignmentEvents).not.toContain("push-delivery");
    expect(assignmentEvents).not.toContain("assignment-push-signal");
    expect(assignmentEvents).not.toContain("operational-delivery-worker");
    expect(assignmentEvents).not.toContain("mailer");
    expect(operationalEvents).toContain(
      'contract.recipientMembership === "CANONICAL_ASSIGNMENT_HISTORICAL"',
    );
    expect(operationalEvents).toContain('emissionMode !== "SHADOW"');
    expect(operationalEvents).toContain(
      "Destinatário histórico só é permitido em emissão SHADOW",
    );
  });
});
