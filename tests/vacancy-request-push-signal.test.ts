import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueVacancyRequestDecisionPush,
  enqueueVacancyRequestManagerPushes,
} from "../server/vacancy-request-push-signal";

const enqueueTrackedPushNotification = vi.hoisted(() => vi.fn());
const listResponsibleVacancyManagerUserIds = vi.hoisted(() => vi.fn());

vi.mock("../server/push-delivery", () => ({
  enqueueTrackedPushNotification: (...args: unknown[]) =>
    enqueueTrackedPushNotification(...args),
}));
vi.mock("../server/vacancy-request-push-authority", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../server/vacancy-request-push-authority")
  >()),
  listResponsibleVacancyManagerUserIds: (...args: unknown[]) =>
    listResponsibleVacancyManagerUserIds(...args),
}));

function shiftInput() {
  return {
    id: 44,
    institutionId: 3,
    hospitalId: 8,
    sectorId: 9,
    startAt: new Date("2026-09-02T10:00:00.000-03:00"),
    endAt: new Date("2026-09-02T16:00:00.000-03:00"),
  };
}

function selectDb(sequence: unknown[][]) {
  let call = 0;
  const chain: {
    from: () => unknown;
    innerJoin: () => unknown;
    where: () => unknown;
    limit: () => Promise<unknown[]>;
    then: Promise<unknown[]>["then"];
  } = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: async () => sequence[call++] ?? [],
    then: (resolve, reject) =>
      Promise.resolve(sequence[call++] ?? []).then(resolve, reject),
  };
  return { select: () => chain, insert: vi.fn(), update: vi.fn() };
}

describe("outbox de solicitação de vaga", () => {
  beforeEach(() => {
    enqueueTrackedPushNotification.mockReset();
    listResponsibleVacancyManagerUserIds.mockReset();
    listResponsibleVacancyManagerUserIds.mockResolvedValue([90, 91, 92]);
    enqueueTrackedPushNotification.mockResolvedValue({
      notificationId: 1,
      status: "PENDING",
      phase: "QUEUED",
    });
  });

  it("notifica cada gestor responsável uma vez com autoridade hospitalar exata", async () => {
    const db = selectDb([
      [{ userId: 77, name: "Dra. Ana" }],
      [{ name: "Hospital Sul" }],
      [{ name: "UTI" }],
    ]);

    await expect(
      enqueueVacancyRequestManagerPushes({
        db: db as never,
        assignmentId: 501,
        requesterProfessionalId: 12,
        shift: shiftInput(),
      }),
    ).resolves.toBe(3);

    expect(enqueueTrackedPushNotification).toHaveBeenCalledTimes(3);
    expect(
      enqueueTrackedPushNotification.mock.calls.map(
        ([intent]) => intent.userId,
      ),
    ).toEqual([90, 91, 92]);
    for (const [intent, , receivedDb] of enqueueTrackedPushNotification.mock
      .calls) {
      expect(intent).toMatchObject({
        institutionId: 3,
        shiftInstanceId: 44,
        deepLink: "/(tabs)/pending",
        authority: {
          kind: "VACANCY_REQUEST",
          purpose: "MANAGER_ACTION_REQUIRED",
          assignmentId: 501,
          institutionId: 3,
          hospitalId: 8,
          sectorId: 9,
          shiftInstanceId: 44,
          expectedUserId: intent.userId,
        },
        payload: {
          data: {
            type: "vacancy_request_created",
            institutionId: 3,
            hospitalId: 8,
            sectorId: 9,
            shiftInstanceId: 44,
            assignmentId: 501,
          },
        },
      });
      expect(intent.dedupKey).toBe(
        `vacancy-request:501:manager:${intent.userId}`,
      );
      expect(receivedDb).toBe(db);
    }
  });

  it("notifica o solicitante após aprovação ou rejeição sem expor motivo", async () => {
    for (const purpose of ["REQUEST_APPROVED", "REQUEST_REJECTED"] as const) {
      enqueueTrackedPushNotification.mockClear();
      const db = selectDb([
        [{ userId: 77, name: "Dra. Ana" }],
        [{ name: "Hospital Sul" }],
        [{ name: "UTI" }],
      ]);
      await enqueueVacancyRequestDecisionPush({
        db: db as never,
        purpose,
        assignmentId: 501,
        requesterProfessionalId: 12,
        shift: shiftInput(),
      });
      const [intent] = enqueueTrackedPushNotification.mock.calls[0];
      expect(intent.userId).toBe(77);
      expect(intent.deepLink).toBe("/shift-details?id=44");
      expect(intent.authority).toMatchObject({
        kind: "VACANCY_REQUEST",
        purpose,
        expectedUserId: 77,
      });
      expect(intent.payload.data.type).toBe(
        purpose === "REQUEST_APPROVED"
          ? "vacancy_request_approved"
          : "vacancy_request_rejected",
      );
      expect(intent.payload.data).not.toHaveProperty("reason");
    }
  });

  it("aborta o fluxo quando o solicitante canônico não existe", async () => {
    const db = selectDb([[], [{ name: "Hospital" }], [{ name: "UTI" }]]);
    await expect(
      enqueueVacancyRequestManagerPushes({
        db: db as never,
        assignmentId: 501,
        requesterProfessionalId: 12,
        shift: shiftInput(),
      }),
    ).rejects.toThrow(/Solicitante canônico/);
    expect(enqueueTrackedPushNotification).not.toHaveBeenCalled();
  });

  it("permite rejeitar sem outbox quando o solicitante perdeu o vínculo", async () => {
    const db = selectDb([[]]);
    await expect(
      enqueueVacancyRequestDecisionPush({
        db: db as never,
        purpose: "REQUEST_REJECTED",
        assignmentId: 501,
        requesterProfessionalId: 12,
        shift: shiftInput(),
      }),
    ).resolves.toBe(0);
    expect(enqueueTrackedPushNotification).not.toHaveBeenCalled();
  });

  it("mantém aprovação fail-closed quando o solicitante perdeu o vínculo", async () => {
    const db = selectDb([[]]);
    await expect(
      enqueueVacancyRequestDecisionPush({
        db: db as never,
        purpose: "REQUEST_APPROVED",
        assignmentId: 501,
        requesterProfessionalId: 12,
        shift: shiftInput(),
      }),
    ).rejects.toThrow(/Solicitante canônico/);
    expect(enqueueTrackedPushNotification).not.toHaveBeenCalled();
  });

  it("propaga falha do outbox para a transação de negócio", async () => {
    enqueueTrackedPushNotification.mockRejectedValue(
      new Error("forced outbox failure"),
    );
    const db = selectDb([
      [{ userId: 77, name: "Dra. Ana" }],
      [{ name: "Hospital" }],
      [{ name: "UTI" }],
    ]);
    await expect(
      enqueueVacancyRequestManagerPushes({
        db: db as never,
        assignmentId: 501,
        requesterProfessionalId: 12,
        shift: shiftInput(),
      }),
    ).rejects.toThrow(/forced outbox failure/);
  });
});
