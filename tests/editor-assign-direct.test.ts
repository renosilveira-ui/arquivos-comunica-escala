import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  hospitals,
  institutions,
  managerScope,
  professionalAccess,
  professionalInstitutions,
  professionals,
  sectors,
  auditTrail,
  shiftAuditLog,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { editorRouter } from "../server/editor";

describe("editor.assignDirect", () => {
  let db: Awaited<ReturnType<typeof getDb>>;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let managerUserId: number;
  let targetUserId: number;
  let managerProfessionalId: number;
  let targetProfessionalId: number;
  let shiftInstanceId: number;

  beforeAll(async () => {
    db = await getDb();
    if (!db) throw new Error("Database not available");

    const stamp = Date.now();
    const [institution] = await db
      .insert(institutions)
      .values({
        name: `Assign Direct Tenant ${stamp}`,
        cnpj: `${stamp}`.slice(-14).padStart(14, "0"),
        legalName: `Assign Direct Tenant ${stamp}`,
        tradeName: `AD${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = institution.id;

    const [hospital] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Assign Direct Hospital ${stamp}` })
      .$returningId();
    hospitalId = hospital.id;

    const [sector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `Assign Direct Setor ${stamp}`,
        category: "cirurgico",
        color: "#2563EB",
      })
      .$returningId();
    sectorId = sector.id;

    const [managerUser] = await db
      .insert(users)
      .values({
        name: `Assign Direct Manager ${stamp}`,
        email: `assign-direct-manager-${stamp}@test.local`,
        passwordHash: "test",
        role: "manager",
      })
      .$returningId();
    managerUserId = managerUser.id;

    const [managerProfessional] = await db
      .insert(professionals)
      .values({
        userId: managerUserId,
        name: `Assign Direct Manager ${stamp}`,
        role: "Gestor",
        userRole: "GESTOR_MEDICO",
      })
      .$returningId();
    managerProfessionalId = managerProfessional.id;

    const [targetUser] = await db
      .insert(users)
      .values({
        name: `Assign Direct Doctor ${stamp}`,
        email: `assign-direct-doctor-${stamp}@test.local`,
        passwordHash: "test",
        role: "doctor",
      })
      .$returningId();
    targetUserId = targetUser.id;

    const [targetProfessional] = await db
      .insert(professionals)
      .values({
        userId: targetUser.id,
        name: `Assign Direct Doctor ${stamp}`,
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
        userId: targetUser.id,
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

    await db.insert(professionalAccess).values({
      institutionId,
      professionalId: targetProfessionalId,
      hospitalId,
      sectorId,
      canAccess: true,
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
        label: `Assign Direct Shift ${stamp}`,
        startAt,
        endAt,
        status: "VAGO",
      })
      .$returningId();
    shiftInstanceId = shift.id;
  });

  beforeEach(async () => {
    if (!db || !shiftInstanceId) return;
    await db.delete(auditTrail).where(eq(auditTrail.shiftInstanceId, shiftInstanceId));
    await db.delete(shiftAuditLog).where(eq(shiftAuditLog.shiftInstanceId, shiftInstanceId));
    await db
      .delete(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.shiftInstanceId, shiftInstanceId));
    await db
      .update(shiftInstances)
      .set({ status: "VAGO" })
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
    const professionalIds = [managerProfessionalId, targetProfessionalId].filter(
      (id): id is number => typeof id === "number",
    );
    if (professionalIds.length > 0) {
      await db
        .delete(professionalAccess)
        .where(inArray(professionalAccess.professionalId, professionalIds));
      await db
        .delete(professionalInstitutions)
        .where(inArray(professionalInstitutions.professionalId, professionalIds));
      await db.delete(managerScope).where(inArray(managerScope.managerProfessionalId, professionalIds));
      await db.delete(professionals).where(inArray(professionals.id, professionalIds));
    }
    await db.delete(sectors).where(eq(sectors.id, sectorId));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    const userIds = [managerUserId, targetUserId].filter((id): id is number => typeof id === "number");
    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
  });

  it("aloca um profissional habilitado e atualiza o plantão", async () => {
    const caller = editorRouter.createCaller({
      user: {
        id: managerUserId,
        role: "manager",
        name: "Assign Direct Manager",
        email: "manager@test.local",
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);

    const result = await caller.assignDirect({
      shiftInstanceId,
      professionalId: targetProfessionalId,
      assignmentType: "ON_DUTY",
      reason: "Teste de alocação direta",
    });

    expect(result.ok).toBe(true);

    const assignments = await db
      .select()
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.shiftInstanceId, shiftInstanceId));
    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({
      professionalId: targetProfessionalId,
      status: "OCUPADO",
      isActive: true,
    });

    const [shift] = await db
      .select({ status: shiftInstances.status })
      .from(shiftInstances)
      .where(eq(shiftInstances.id, shiftInstanceId));
    expect(shift?.status).toBe("OCUPADO");
  });

  it("remove a última alocação e registra auditoria com instituição", async () => {
    const caller = editorRouter.createCaller({
      user: {
        id: managerUserId,
        role: "manager",
        name: "Assign Direct Manager",
        email: "manager@test.local",
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);

    const assignment = await caller.assignDirect({
      shiftInstanceId,
      professionalId: targetProfessionalId,
      assignmentType: "ON_DUTY",
      reason: "Teste de alocação direta",
    });

    const result = await caller.unassignDirect({
      assignmentId: assignment.assignmentId,
      reason: "Teste de remoção direta",
    });

    expect(result.ok).toBe(true);

    const assignments = await db
      .select()
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.id, assignment.assignmentId));
    expect(assignments[0]).toMatchObject({
      professionalId: targetProfessionalId,
      isActive: false,
    });

    const [shift] = await db
      .select({ status: shiftInstances.status })
      .from(shiftInstances)
      .where(eq(shiftInstances.id, shiftInstanceId));
    expect(shift?.status).toBe("VAGO");

    const auditRows = await db
      .select({
        action: auditTrail.action,
        entityType: auditTrail.entityType,
        entityId: auditTrail.entityId,
        institutionId: auditTrail.institutionId,
        shiftInstanceId: auditTrail.shiftInstanceId,
      })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.action, "ASSIGNMENT_REMOVED"),
          eq(auditTrail.entityId, assignment.assignmentId),
        ),
      );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      action: "ASSIGNMENT_REMOVED",
      entityType: "SHIFT_ASSIGNMENT",
      institutionId,
      shiftInstanceId,
    });
  });
});
