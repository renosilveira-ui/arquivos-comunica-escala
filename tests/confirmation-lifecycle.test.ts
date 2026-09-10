import { beforeEach, describe, expect, it, vi } from "vitest";
import { rearmDutyConfirmationsAfterShiftChange } from "../server/confirmation-lifecycle";

const { requireValidDutyConfirmation } = vi.hoisted(() => ({
  requireValidDutyConfirmation: vi.fn(),
}));

vi.mock("../server/confirmation-integrity", () => ({
  requireValidDutyConfirmation,
}));

type Snapshot = {
  id: number;
  assignmentId: number;
  status: "CONFIRMED" | "REPLACEMENT_CONFIRMED";
  confirmationToken: string;
  replacementProfessionalId: number | null;
  replacementUserId: number | null;
};

function fakeTx(snapshots: Snapshot[]) {
  const written: Record<string, unknown>[] = [];
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        orderBy: vi.fn(async () => snapshots),
      })),
    })),
  }));
  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      written.push(values);
      return {
        where: vi.fn(async () => [{ affectedRows: 1 }]),
      };
    }),
  }));

  return { tx: { select, update }, written };
}

describe("rearme de confirmação pela identidade efetiva", () => {
  beforeEach(() => {
    requireValidDutyConfirmation.mockReset();
  });

  it("titular recusa, substituto aceita e a edição rearma a mesma linha para a assignment efetiva", async () => {
    const snapshot: Snapshot = {
      id: 31,
      assignmentId: 10,
      status: "REPLACEMENT_CONFIRMED",
      confirmationToken: "old-confirmation-token",
      replacementProfessionalId: 202,
      replacementUserId: 302,
    };
    const { tx, written } = fakeTx([snapshot]);
    requireValidDutyConfirmation.mockResolvedValue({
      effective: {
        assignmentId: 44,
        professionalId: 202,
        userId: 302,
      },
    });

    await expect(
      rearmDutyConfirmationsAfterShiftChange(tx as never, {
        institutionId: 7,
        shiftInstanceId: 8,
        activeAssignments: [{ id: 44, professionalId: 202 }],
      }),
    ).resolves.toBe(1);

    expect(requireValidDutyConfirmation).toHaveBeenCalledWith(tx, 31, {
      allowedStatuses: ["REPLACEMENT_CONFIRMED"],
      expectedInstitutionId: 7,
      requireOriginalAssignmentActive: false,
      requireEffectiveAssignment: true,
      lockForUpdate: true,
    });
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      assignmentId: 44,
      professionalId: 202,
      userId: 302,
      status: "PENDING",
      replacementProfessionalId: null,
      replacementUserId: null,
      recheckAt: null,
      notifiedAt: null,
    });
    expect(written[0]?.confirmationToken).not.toBe(snapshot.confirmationToken);

    // O JOIN direto do dispatcher passa a encontrar exatamente o mesmo ciclo;
    // não depende mais dos campos replacement*, que foram encerrados.
    const matchingConfirmations = written.filter(
      (row) => row.assignmentId === 44 && row.status === "PENDING",
    );
    expect(matchingConfirmations).toHaveLength(1);
  });

  it("mantém o titular como identidade efetiva quando não houve substituição", async () => {
    const { tx, written } = fakeTx([
      {
        id: 32,
        assignmentId: 11,
        status: "CONFIRMED",
        confirmationToken: "original-cycle-token",
        replacementProfessionalId: null,
        replacementUserId: null,
      },
    ]);
    requireValidDutyConfirmation.mockResolvedValue({
      effective: { assignmentId: 11, professionalId: 203, userId: 303 },
    });

    await rearmDutyConfirmationsAfterShiftChange(tx as never, {
      institutionId: 7,
      shiftInstanceId: 8,
      activeAssignments: [{ id: 11, professionalId: 203 }],
    });

    expect(requireValidDutyConfirmation).toHaveBeenCalledWith(tx, 32, {
      allowedStatuses: ["CONFIRMED"],
      expectedInstitutionId: 7,
      requireOriginalAssignmentActive: true,
      requireEffectiveAssignment: false,
      lockForUpdate: true,
    });
    expect(written[0]).toMatchObject({
      assignmentId: 11,
      professionalId: 203,
      userId: 303,
      status: "PENDING",
    });
  });

  it("falha fechado se a validação não resolver uma assignment efetiva", async () => {
    const { tx, written } = fakeTx([
      {
        id: 33,
        assignmentId: 12,
        status: "REPLACEMENT_CONFIRMED",
        confirmationToken: "replacement-cycle-token",
        replacementProfessionalId: 204,
        replacementUserId: 304,
      },
    ]);
    requireValidDutyConfirmation.mockResolvedValue({
      effective: { assignmentId: null, professionalId: 204, userId: 304 },
    });

    await expect(
      rearmDutyConfirmationsAfterShiftChange(tx as never, {
        institutionId: 7,
        shiftInstanceId: 8,
        activeAssignments: [{ id: 45, professionalId: 204 }],
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(written).toHaveLength(0);
  });
});
