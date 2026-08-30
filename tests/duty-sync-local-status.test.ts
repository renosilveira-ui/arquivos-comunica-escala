import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  dutyConfirmations,
  notifications,
  professionals,
  shiftAssignmentsV2,
} from "../drizzle/schema";
import { confirmationRouter } from "../server/confirmation-router";
import { getDb } from "../server/db";
import { enqueueDutySync } from "../server/sso/duty-sync";
import {
  getDutySyncLocalStatusForConfirmation,
  mapDutySyncNotificationRow,
} from "../server/sso/duty-sync-status";

vi.mock("../server/sso/org-mapping", () => ({
  getComunicaOrgId: vi.fn(
    () => "393c32d0-3be6-4239-82dd-f9a30dce1f82",
  ),
  hasMappingFor: vi.fn(() => true),
}));

describe("mapDutySyncNotificationRow", () => {
  it("mapeia pending, delivered e failed sem consultar Comunica+", () => {
    expect(
      mapDutySyncNotificationRow({
        id: 1,
        title: "Duty roster sync",
        status: "PENDING",
        body: "CONFIRM",
        errorMessage: null,
        sentAt: null,
        createdAt: new Date("2033-07-01T09:00:00.000Z"),
        providerReceipt: {
          dutySyncVersion: 1,
          confirmationId: 42,
          phase: "QUEUED",
        },
      }),
    ).toMatchObject({
      status: "pending",
      action: "CONFIRM",
      confirmationId: 42,
      notificationId: 1,
      errorMessage: null,
    });

    expect(
      mapDutySyncNotificationRow({
        id: 2,
        title: "Duty roster sync",
        status: "SENT",
        body: "CONFIRM",
        errorMessage: null,
        sentAt: new Date("2033-07-01T09:05:00.000Z"),
        createdAt: new Date("2033-07-01T09:00:00.000Z"),
        providerReceipt: {
          dutySyncVersion: 1,
          confirmationId: 42,
          phase: "SENT",
          terminalAt: "2033-07-01T09:05:00.000Z",
        },
      }),
    ).toMatchObject({
      status: "delivered",
      action: "CONFIRM",
      updatedAt: "2033-07-01T09:05:00.000Z",
    });

    expect(
      mapDutySyncNotificationRow({
        id: 3,
        title: "Duty roster sync",
        status: "FAILED",
        body: "WITHDRAW",
        errorMessage: "UNMAPPED_COMUNICA_ORGANIZATION",
        sentAt: null,
        createdAt: new Date("2033-07-01T09:00:00.000Z"),
        providerReceipt: {
          dutySyncVersion: 1,
          confirmationId: 42,
          phase: "FAILED",
          terminalAt: "2033-07-01T09:01:00.000Z",
        },
      }),
    ).toMatchObject({
      status: "failed",
      action: "WITHDRAW",
      errorMessage: "UNMAPPED_COMUNICA_ORGANIZATION",
    });

    expect(mapDutySyncNotificationRow(undefined)).toMatchObject({ status: "none" });
  });
});

describe("duty-sync local status outbox", () => {
  const dbPromise = getDb();
  let db: NonNullable<Awaited<typeof dbPromise>>;
  const runId = Date.now();
  let institutionId = 0;
  let userId = 0;
  let shiftInstanceId = 0;
  let confirmationId = 0;
  let notificationId = 0;

  beforeAll(async () => {
    db = (await dbPromise)!;
    const [assignment] = await db
      .select({
        id: shiftAssignmentsV2.id,
        institutionId: shiftAssignmentsV2.institutionId,
        shiftInstanceId: shiftAssignmentsV2.shiftInstanceId,
        professionalId: shiftAssignmentsV2.professionalId,
      })
      .from(shiftAssignmentsV2)
      .limit(1);
    if (!assignment) {
      throw new Error("Seed sem shift_assignments_v2 para teste de status local");
    }
    const [professional] = await db
      .select({ userId: professionals.userId })
      .from(professionals)
      .where(eq(professionals.id, assignment.professionalId))
      .limit(1);
    if (!professional) {
      throw new Error("Seed sem professional para teste de status local");
    }

    institutionId = assignment.institutionId;
    shiftInstanceId = assignment.shiftInstanceId;
    userId = professional.userId;

    const [inserted] = await db
      .insert(dutyConfirmations)
      .values({
        institutionId,
        shiftInstanceId,
        assignmentId: assignment.id,
        professionalId: assignment.professionalId,
        userId,
        status: "CONFIRMED",
        confirmationToken: randomUUID(),
      })
      .$returningId();
    confirmationId = inserted.id;

    notificationId = await enqueueDutySync(
      {
        confirmationId,
        institutionId,
        shiftInstanceId,
        targetUserId: userId,
        externalSubject: `duty-sync-status-${runId}@test.local`,
        shiftSnapshot: {
          institutionId,
          hospitalId: 1,
          sectorId: 1,
          label: "Manhã",
          startAt: "2033-07-01T10:00:00.000Z",
          endAt: "2033-07-01T16:00:00.000Z",
        },
        action: "CONFIRM",
        confirmationStatus: "CONFIRMED",
        expectedStatuses: ["CONFIRMED"],
        dutyType: "PLANTAO",
        dedupKey: `duty-confirmation:${confirmationId}:duty-sync:status-test:${runId}`,
      },
      new Date("2033-07-01T09:00:00.000Z"),
      db,
    );
  });

  afterAll(async () => {
    if (notificationId > 0) {
      await db.delete(notifications).where(eq(notifications.id, notificationId));
    }
    if (confirmationId > 0) {
      await db
        .delete(dutyConfirmations)
        .where(eq(dutyConfirmations.id, confirmationId));
    }
  });

  it("lê o outbox local mais recente da confirmação", async () => {
    const status = await getDutySyncLocalStatusForConfirmation(db, {
      confirmationId,
      institutionId,
      userId,
    });

    expect(status).toMatchObject({
      status: "pending",
      action: "CONFIRM",
      confirmationId,
      notificationId,
    });
    expect(status.updatedAt).toBeTruthy();
  });

  it("expõe status via tRPC apenas para o ator da confirmação", async () => {
    const caller = confirmationRouter.createCaller({
      user: {
        id: userId,
        role: "USER",
        name: "Test",
        sessionVersion: 1,
      },
      institutionId,
    } as any);

    await expect(
      caller.getDutySyncLocalStatus({ confirmationId }),
    ).resolves.toMatchObject({
      status: "pending",
      action: "CONFIRM",
      confirmationId,
    });

    const outsider = confirmationRouter.createCaller({
      user: {
        id: userId + 9_999,
        role: "USER",
        name: "Outsider",
        sessionVersion: 1,
      },
      institutionId,
    } as any);

    await expect(
      outsider.getDutySyncLocalStatus({ confirmationId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
