import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routers = readFileSync("server/routers.ts", "utf8");
const operationalEvents = readFileSync("server/operational-events.ts", "utf8");
const vacancyEvents = readFileSync(
  "server/vacancy-request-operational-events.ts",
  "utf8",
);
const editor = readFileSync("server/editor.ts", "utf8");
const swapRouter = readFileSync("server/swap-router.ts", "utf8");
const shiftsCrud = readFileSync("server/shifts-crud.ts", "utf8");

function section(source: string, start: string, end?: string): string {
  const startIndex = source.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = end ? source.indexOf(end, startIndex) : -1;
  return source.slice(startIndex, endIndex >= 0 ? endIndex : undefined);
}

describe("wiring SHADOW de solicitações de vaga", () => {
  it("limita a frente a assumir, aprovar e rejeitar vaga", () => {
    const assume = section(
      routers,
      "  assumeVacancy: protectedProcedure",
      "  // Listar solicitações de vaga",
    );
    const approve = section(
      routers,
      "  approveAssignment: protectedProcedure",
      "  // Rejeitar alocação pendente",
    );
    const reject = section(
      routers,
      "  rejectAssignment: protectedProcedure",
      "  // List vacancies",
    );

    expect(assume).toContain("captureCanonicalVacancyRequest");
    for (const writer of [approve, reject]) {
      expect(writer).toContain("captureVacancyRequestForDecisionOrLegacyAudit");
      expect(writer).toContain("recordVacancyRequestShadowEventInTransaction");
    }
    expect(editor).not.toContain("vacancy-request-operational-events");
    expect(swapRouter).not.toContain("vacancy-request-operational-events");
    expect(shiftsCrud).not.toContain("vacancy-request-operational-events");
  });

  it("cria a solicitação com revisão 1 e fato dentro da mesma transação", () => {
    const assume = section(
      routers,
      "  assumeVacancy: protectedProcedure",
      "  // Listar solicitações de vaga",
    );
    const revision = assume.indexOf("operationalRevision: 1");
    const capture = assume.indexOf("captureCanonicalVacancyRequest");
    const record = assume.indexOf(
      "recordVacancyRequestShadowEventInTransaction",
    );

    expect(assume).toContain("ASSIGNMENT_WRITE_TRANSACTION_CONFIG");
    expect(revision).toBeGreaterThanOrEqual(0);
    expect(capture).toBeGreaterThan(revision);
    expect(record).toBeGreaterThan(capture);
    expect(assume).toContain('operation: "REQUESTED"');
  });

  it("usa captura prévia e CAS de revisão nas duas decisões", () => {
    const approve = section(
      routers,
      "  approveAssignment: protectedProcedure",
      "  // Rejeitar alocação pendente",
    );
    const reject = section(
      routers,
      "  rejectAssignment: protectedProcedure",
      "  // List vacancies",
    );

    for (const [writer, operation] of [
      [approve, "APPROVED"],
      [reject, "REJECTED"],
    ] as const) {
      const capture = writer.indexOf(
        "captureVacancyRequestForDecisionOrLegacyAudit",
      );
      const update = writer.indexOf(".update(shiftAssignmentsV2)");
      const record = writer.indexOf(
        "recordVacancyRequestShadowEventInTransaction",
      );

      expect(writer).toContain(
        "operationalRevision: lockedAssignment.operationalRevision + 1",
      );
      expect(writer).toContain(
        "shiftAssignmentsV2.operationalRevision,\n                lockedAssignment.operationalRevision",
      );
      expect(writer).toContain("ASSIGNMENT_WRITE_TRANSACTION_CONFIG");
      expect(capture).toBeGreaterThanOrEqual(0);
      expect(update).toBeGreaterThan(capture);
      expect(record).toBeGreaterThan(update);
      expect(writer).toContain(`operation: \"${operation}\"`);
    }
  });

  it("preserva decisão legada sem fato SHADOW apenas quando a identidade histórica não é provada", () => {
    const assume = section(
      routers,
      "  assumeVacancy: protectedProcedure",
      "  // Listar solicitações de vaga",
    );
    const approve = section(
      routers,
      "  approveAssignment: protectedProcedure",
      "  // Rejeitar alocação pendente",
    );
    const reject = section(
      routers,
      "  rejectAssignment: protectedProcedure",
      "  // List vacancies",
    );
    const decisionCapture = section(
      vacancyEvents,
      "export async function captureVacancyRequestForDecisionOrLegacyAudit",
      "export type VacancyRequestShadowActor",
    );

    expect(decisionCapture).toContain("isVacancyRequesterIdentityUnproven");
    expect(decisionCapture).toContain('kind: "CANONICAL"');
    expect(decisionCapture).toContain("LEGACY_REQUESTER_IDENTITY_UNPROVEN");
    expect(decisionCapture).toContain("throw error");
    expect(routers).not.toContain("catch (error)");
    expect(assume).not.toContain(
      "captureVacancyRequestForDecisionOrLegacyAudit",
    );
    for (const writer of [approve, reject]) {
      expect(writer).toContain("operationalEventSuppressionReason");
      expect(writer).toContain("LEGACY_REQUESTER_IDENTITY_UNPROVEN");
      expect(writer).toContain(
        'if (vacancyRequestCapture.kind === "CANONICAL")',
      );
      expect(writer.indexOf(".update(shiftAssignmentsV2)")).toBeLessThan(
        writer.indexOf('if (vacancyRequestCapture.kind === "CANONICAL")'),
      );
    }
  });

  it("mantém ator, solicitante, gestores e contexto ancorados em IDs canônicos", () => {
    for (const identifier of [
      "institutionId",
      "hospitalId",
      "sectorId",
      "scheduleContextId",
      "shiftInstanceId",
      "assignmentId",
      "createdByUserId",
      "requesterUserId",
      "operationalRevision",
    ]) {
      expect(vacancyEvents).toContain(identifier);
    }
    expect(vacancyEvents).toContain(
      "Solicitação de vaga sem solicitante canônico",
    );
    expect(vacancyEvents).toContain("LEGACY_REQUESTER_IDENTITY_UNPROVEN");
    expect(operationalEvents).toContain("VACANCY_REQUEST_OPERATIONAL");
    expect(operationalEvents).toContain("VACANCY_REQUEST_RESPONSIBLE_MANAGERS");
    expect(operationalEvents).toContain("NO_RESPONSIBLE_MANAGERS");
  });

  it("rejeita criação retroativa de solicitação fora da revisão inicial", () => {
    expect(vacancyEvents).toContain(
      "isNewRequest && captured.operationalRevision !== 1",
    );
    expect(operationalEvents).toContain(
      "aggregate.version !== 1 || assignment.operationalRevision !== 1",
    );
  });

  it("não chama transporte, provider ou emissor legado", () => {
    for (const forbidden of [
      "push-delivery",
      "assignment-push-signal",
      "operational-delivery-worker",
      "mailer",
      "sendPush",
      "sendEmail",
      "cron",
    ]) {
      expect(vacancyEvents).not.toContain(forbidden);
    }
  });
});
