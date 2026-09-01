import { describe, expect, it } from "vitest";
import {
  ASSIGNMENT_SHADOW_OPERATIONS,
  assignmentShadowIdempotencyKey,
  recordAssignmentShadowEventInTransaction,
  type CapturedAssignmentShadowRecipient,
} from "../server/assignment-operational-events";
import type { OperationalEventTx } from "../server/operational-events";

type CapturedAssignmentRow = {
  assignmentId: number;
  professionalId: number;
  userId: number;
  operationalRevision: number;
  assignmentStatus: string;
  isActive: boolean;
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  shiftInstanceId: number;
  scheduleContextId: number | null;
};

function assignmentCaptureTransaction(
  row: CapturedAssignmentRow,
): OperationalEventTx {
  const lockedResult = { for: async () => [row] };
  const query = {
    innerJoin() {
      return query;
    },
    where() {
      return query;
    },
    limit() {
      return lockedResult;
    },
  };
  return {
    select() {
      return {
        from() {
          return query;
        },
      };
    },
  } as unknown as OperationalEventTx;
}

const capturedRecipient: CapturedAssignmentShadowRecipient = {
  context: {
    institutionId: 1,
    hospitalId: 10,
    sectorId: 4,
    scheduleContextId: 8,
    shiftInstanceId: 12,
    assignmentId: 44,
  },
  professionalId: 200,
  userId: 20,
  operationalRevision: 1,
  assignmentStatus: "OCUPADO",
  isActive: true,
};

function assignmentCaptureRow(
  overrides: Partial<CapturedAssignmentRow> = {},
): CapturedAssignmentRow {
  return {
    assignmentId: capturedRecipient.context.assignmentId,
    professionalId: capturedRecipient.professionalId,
    userId: capturedRecipient.userId,
    operationalRevision: capturedRecipient.operationalRevision,
    assignmentStatus: capturedRecipient.assignmentStatus,
    isActive: capturedRecipient.isActive,
    institutionId: capturedRecipient.context.institutionId,
    hospitalId: capturedRecipient.context.hospitalId,
    sectorId: capturedRecipient.context.sectorId,
    shiftInstanceId: capturedRecipient.context.shiftInstanceId,
    scheduleContextId: capturedRecipient.context.scheduleContextId,
    ...overrides,
  };
}

describe("idempotência dos fatos SHADOW de assignment", () => {
  it("usa revisão, operação, alocação e ação na chave determinística", () => {
    const key = assignmentShadowIdempotencyKey({
      operation: "DIRECT_REMOVAL",
      assignmentId: 44,
      operationalRevision: 3,
    });

    expect(key).toBe(
      "assignment-shadow:revision:3:operation:DIRECT_REMOVAL:assignment:44:action:REMOVE",
    );
    expect(
      assignmentShadowIdempotencyKey({
        operation: "DIRECT_REMOVAL",
        assignmentId: 44,
        operationalRevision: 3,
      }),
    ).toBe(key);
    expect(
      assignmentShadowIdempotencyKey({
        operation: "DIRECT_REMOVAL",
        assignmentId: 44,
        operationalRevision: 4,
      }),
    ).not.toBe(key);
    expect(
      assignmentShadowIdempotencyKey({
        operation: "SUBSTITUTION_REMOVAL",
        assignmentId: 44,
        operationalRevision: 3,
      }),
    ).not.toBe(key);
  });

  it("mantém o conjunto de operações fechado e recusa IDs ou revisões inválidos", () => {
    expect(ASSIGNMENT_SHADOW_OPERATIONS).toEqual([
      "DIRECT_ASSIGNMENT",
      "DIRECT_REMOVAL",
      "SUBSTITUTION_ASSIGNMENT",
      "SUBSTITUTION_REMOVAL",
    ]);
    expect(() =>
      assignmentShadowIdempotencyKey({
        operation: "DIRECT_ASSIGNMENT",
        assignmentId: 0,
        operationalRevision: 1,
      }),
    ).toThrow("assignmentId deve ser um ID positivo");
    expect(() =>
      assignmentShadowIdempotencyKey({
        operation: "DIRECT_ASSIGNMENT",
        assignmentId: 44,
        operationalRevision: 0,
      }),
    ).toThrow("operationalRevision deve ser uma revisão positiva");
  });

  it("recusa revisão ou snapshot que não provam a transição capturada", async () => {
    await expect(
      recordAssignmentShadowEventInTransaction(
        assignmentCaptureTransaction(
          assignmentCaptureRow({ operationalRevision: 2 }),
        ),
        {
          operation: "DIRECT_ASSIGNMENT",
          capturedRecipient,
          actor: { userId: 7, professionalId: 70 },
        },
      ),
    ).rejects.toThrow(
      "Snapshot ou revisão da alocação não representa a transição SHADOW",
    );

    await expect(
      recordAssignmentShadowEventInTransaction(
        assignmentCaptureTransaction(
          assignmentCaptureRow({
            operationalRevision: 2,
            isActive: false,
          }),
        ),
        {
          operation: "DIRECT_REMOVAL",
          capturedRecipient: { ...capturedRecipient, isActive: false },
          actor: { userId: 7, professionalId: 70 },
        },
      ),
    ).rejects.toThrow(
      "Snapshot ou revisão da alocação não representa a transição SHADOW",
    );
  });
});
