import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  hospitals,
  institutions,
  managerScope,
  monthlyRosters,
  professionalInstitutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftAuditLog,
  shiftInstances,
  users,
  auditTrail,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { editorRouter } from "../server/editor";

const enqueueTrackedPushNotification = vi.hoisted(() => vi.fn());

vi.mock("../server/push-delivery", () => ({
  enqueueTrackedPushNotification: (...args: unknown[]) =>
    enqueueTrackedPushNotification(...args),
}));

describe("unassignDirect e falha do outbox", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let managerUserId: number;
  let managerProfessionalId: number;
  let targetUserId: number;
  let targetProfessionalId: number;
  let shiftInstanceId: number;
  let assignmentId: number;

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;
    const stamp = Date.now();

    const [institution] = await db
      .insert(institutions)
      .values({
        name: `Unassign Outbox Tenant ${stamp}`,
        cnpj: `${stamp}`.slice(-14).padStart(14, "0"),
        legalName: `Unassign Outbox Tenant ${stamp}`,
        tradeName: `UO${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = institution.id;

    const [hospital] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Unassign Outbox Hospital ${stamp}` })
      .$returningId();
    hospitalId = hospital.id;

    const [sector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `Unassign Outbox Setor ${stamp}`,
        category: "cirurgico",
        color: "#2563EB",
      })
      .$returningId();
    sectorId = sector.id;

    const [managerUser] = await db
      .insert(users)
      .values({
        name: `Unassign Outbox Manager ${stamp}`,
        email: `unassign-outbox-manager-${stamp}@test.local`,
        passwordHash: "test",
        role: "manager",
      })
      .$returningId();
    managerUserId = managerUser.id;

    const [managerProfessional] = await db
      .insert(professionals)
      .values({
        userId: managerUserId,
        name: `Unassign Outbox Manager ${stamp}`,
        role: "Gestor",
        userRole: "GESTOR_MEDICO",
      })
      .$returningId();
    managerProfessionalId = managerProfessional.id;

    const [targetUser] = await db
      .insert(users)
      .values({
        name: `Unassign Outbox Doctor ${stamp}`,
        email: `unassign-outbox-doctor-${stamp}@test.local`,
        passwordHash: "test",
        role: "doctor",
      })
      .$returningId();
    targetUserId = targetUser.id;

    const [targetProfessional] = await db
      .insert(professionals)
      .values({
        userId: targetUserId,
        name: `Unassign Outbox Doctor ${stamp}`,
        role: "Médico",
        userRole: "USER",
      })
      .$returningId();
    targetProfessionalId = targetProfessional.id;

    await db.insert(professionalInstitutions).values([
      {
        professionalId: managerProfessionalId,
        userId: managerUserId,
        institutionId,
        roleInInstitution: "GESTOR_MEDICO",
        isPrimary: true,
        active: true,
      },
      {
        professionalId: targetProfessionalId,
        userId: targetUserId,
        institutionId,
        roleInInstitution: "USER",
        isPrimary: true,
        active: true,
      },
    ]);
    await db.insert(managerScope).values({
      institutionId,
      managerProfessionalId,
      hospitalId,
      sectorId,
      active: true,
    });

    const startAt = new Date();
    startAt.setHours(10, 0, 0, 0);
    const endAt = new Date(startAt);
    endAt.setHours(16, 0, 0, 0);
    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId,
        sectorId,
        label: `Unassign Outbox Shift ${stamp}`,
        startAt,
        endAt,
        status: "OCUPADO",
      })
      .$returningId();
    shiftInstanceId = shift.id;
  });

  beforeEach(async () => {
    enqueueTrackedPushNotification.mockReset();
    await db.delete(auditTrail).where(eq(auditTrail.shiftInstanceId, shiftInstanceId));
    await db.delete(shiftAuditLog).where(eq(shiftAuditLog.shiftInstanceId, shiftInstanceId));
    await db
      .delete(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.shiftInstanceId, shiftInstanceId));
    const [assignment] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId,
        institutionId,
        hospitalId,
        sectorId,
        professionalId: targetProfessionalId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
        createdBy: managerUserId,
      })
      .$returningId();
    assignmentId = assignment.id;
    await db
      .update(shiftInstances)
      .set({ status: "OCUPADO" })
      .where(eq(shiftInstances.id, shiftInstanceId));
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(auditTrail).where(eq(auditTrail.shiftInstanceId, shiftInstanceId));
    await db.delete(shiftAuditLog).where(eq(shiftAuditLog.shiftInstanceId, shiftInstanceId));
    await db
      .delete(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.shiftInstanceId, shiftInstanceId));
    if (shiftInstanceId) {
      await db.delete(shiftInstances).where(eq(shiftInstances.id, shiftInstanceId));
    }
    await db
      .delete(professionalInstitutions)
      .where(eq(professionalInstitutions.institutionId, institutionId));
    await db
      .delete(managerScope)
      .where(eq(managerScope.managerProfessionalId, managerProfessionalId));
    await db.delete(professionals).where(eq(professionals.id, managerProfessionalId));
    await db.delete(professionals).where(eq(professionals.id, targetProfessionalId));
    await db.delete(monthlyRosters).where(eq(monthlyRosters.institutionId, institutionId));
    await db.delete(sectors).where(eq(sectors.id, sectorId));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    await db.delete(users).where(eq(users.id, managerUserId));
    await db.delete(users).where(eq(users.id, targetUserId));
  });

  function caller() {
    return editorRouter.createCaller({
      user: {
        id: managerUserId,
        role: "manager",
        name: "Unassign Outbox Manager",
        email: "manager@test.local",
        sessionVersion: 1,
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as never);
  }

  it("falha do outbox aborta a remoção e mantém a alocação ativa", async () => {
    enqueueTrackedPushNotification.mockRejectedValue(
      new Error("forced outbox failure"),
    );

    await expect(
      caller().unassignDirect({
        assignmentId,
        reason: "Falhar o outbox",
      }),
    ).rejects.toThrow(/forced outbox failure/);

    const [row] = await db
      .select({ isActive: shiftAssignmentsV2.isActive })
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.id, assignmentId));
    expect(row?.isActive).toBe(true);
    expect(enqueueTrackedPushNotification).toHaveBeenCalledTimes(1);
    expect(enqueueTrackedPushNotification.mock.calls[0][0].userId).toBe(
      targetUserId,
    );
    expect(enqueueTrackedPushNotification.mock.calls[0][0].userId).not.toBe(
      managerUserId,
    );
  });

  it("ausência de token Expo não impede a remoção", async () => {
    enqueueTrackedPushNotification.mockResolvedValue({
      notificationId: 9,
      status: "PENDING",
      phase: "QUEUED",
    });

    const result = await caller().unassignDirect({
      assignmentId,
      reason: "Remoção sem token",
    });
    expect(result.ok).toBe(true);

    const [row] = await db
      .select({ isActive: shiftAssignmentsV2.isActive })
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.id, assignmentId));
    expect(row?.isActive).toBe(false);
    expect(enqueueTrackedPushNotification).toHaveBeenCalledTimes(1);
    expect(enqueueTrackedPushNotification.mock.calls[0][0].payload.data.type).toBe(
      "shift_unassigned",
    );
  });
});
