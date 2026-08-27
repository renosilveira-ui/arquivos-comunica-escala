import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  hospitals,
  institutions,
  managerScope,
  medicalSpecialties,
  monthlyRosters,
  professionalAccess,
  professionalInstitutions,
  professionals,
  scheduleContextAllowedQualifications,
  scheduleContexts,
  scheduleInvites,
  sectors,
  auditTrail,
  shiftAuditLog,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../drizzle/schema";
import {
  generateScheduleInviteCode,
  hashScheduleInviteCode,
  normalizeScheduleInviteCode,
} from "../lib/schedule-invite-code";
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
  let anesthesiaSpecialtyId: number;
  let scheduleContextId: number;

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

    const [anesthesia] = await db
      .insert(medicalSpecialties)
      .values({
        code: `ASSIGN_DIRECT_ANESTHESIA_${stamp}`,
        name: `Assign Direct Anestesia ${stamp}`,
        sourceVersion: "TEST",
        active: true,
        sortOrder: 1,
      })
      .$returningId();
    anesthesiaSpecialtyId = anesthesia.id;

    const [scheduleContext] = await db
      .insert(scheduleContexts)
      .values({
        institutionId,
        hospitalId,
        sectorId,
        admissionPolicy: "QUALIFICATION_ALLOWLIST",
        active: true,
      })
      .$returningId();
    scheduleContextId = scheduleContext.id;
    await db.insert(scheduleContextAllowedQualifications).values({
      scheduleContextId,
      medicalSpecialtyId: anesthesiaSpecialtyId,
    });

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
        medicalSpecialtyId: anesthesiaSpecialtyId,
        specialty: "Anestesiologia",
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
        scheduleContextId,
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
    if (scheduleContextId) {
      await db
        .delete(scheduleContextAllowedQualifications)
        .where(
          eq(
            scheduleContextAllowedQualifications.scheduleContextId,
            scheduleContextId,
          ),
        );
      await db
        .delete(scheduleContexts)
        .where(eq(scheduleContexts.id, scheduleContextId));
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
    await db.delete(monthlyRosters).where(eq(monthlyRosters.institutionId, institutionId));
    await db.delete(sectors).where(eq(sectors.id, sectorId));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    if (anesthesiaSpecialtyId) {
      await db
        .delete(medicalSpecialties)
        .where(eq(medicalSpecialties.id, anesthesiaSpecialtyId));
    }
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
        sessionVersion: 1,
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

  it("bloqueia duplicidade do mesmo profissional no mesmo plantão", async () => {
    await db.insert(shiftAssignmentsV2).values({
      shiftInstanceId,
      institutionId,
      hospitalId,
      sectorId,
      professionalId: targetProfessionalId,
      assignmentType: "ON_DUTY",
      status: "OCUPADO",
      isActive: true,
      createdBy: managerUserId,
    });

    await db
      .update(shiftInstances)
      .set({ status: "OCUPADO" })
      .where(eq(shiftInstances.id, shiftInstanceId));

    const caller = editorRouter.createCaller({
      user: {
        id: managerUserId,
        role: "manager",
        name: "Assign Direct Manager",
        email: "manager@test.local",
        sessionVersion: 1,
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);

    await expect(
      caller.assignDirect({
        shiftInstanceId,
        professionalId: targetProfessionalId,
        assignmentType: "ON_DUTY",
        reason: "Teste de duplicidade",
      }),
    ).rejects.toThrow(/Conflito de horário/);

    const assignments = await db
      .select()
      .from(shiftAssignmentsV2)
      .where(
        and(
          eq(shiftAssignmentsV2.shiftInstanceId, shiftInstanceId),
          eq(shiftAssignmentsV2.professionalId, targetProfessionalId),
          eq(shiftAssignmentsV2.isActive, true),
        ),
      );
    expect(assignments).toHaveLength(1);
  });

  it("revalida conta aprovada do profissional alvo", async () => {
    const caller = editorRouter.createCaller({
      user: {
        id: managerUserId,
        role: "manager",
        name: "Assign Direct Manager",
        email: "manager@test.local",
        sessionVersion: 1,
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);

    try {
      await db
        .update(users)
        .set({ approvalStatus: "PENDING" })
        .where(eq(users.id, targetUserId));
      await expect(
        caller.assignDirect({
          shiftInstanceId,
          professionalId: targetProfessionalId,
          assignmentType: "ON_DUTY",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      const assignments = await db
        .select({ id: shiftAssignmentsV2.id })
        .from(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.shiftInstanceId, shiftInstanceId));
      expect(assignments).toHaveLength(0);
    } finally {
      await db
        .update(users)
        .set({ approvalStatus: "APPROVED" })
        .where(eq(users.id, targetUserId));
    }
  });

  it("aloca clínico, genética e gestor sem especialidade da allowlist", async () => {
    const stamp = Date.now();
    const caller = editorRouter.createCaller({
      user: {
        id: managerUserId,
        role: "manager",
        name: "Assign Direct Manager",
        email: "manager@test.local",
        sessionVersion: 1,
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);

    const [clinicaSpecialty] = await db
      .insert(medicalSpecialties)
      .values({
        code: `ASSIGN_DIRECT_CLINICA_${stamp}`,
        name: "Clínica Médica",
        sourceVersion: "TEST",
        active: true,
        sortOrder: 20,
      })
      .$returningId();
    const [geneticaSpecialty] = await db
      .insert(medicalSpecialties)
      .values({
        code: `ASSIGN_DIRECT_GENETICA_${stamp}`,
        name: "Genética Médica",
        sourceVersion: "TEST",
        active: true,
        sortOrder: 21,
      })
      .$returningId();

    const [clinicaUser] = await db
      .insert(users)
      .values({
        name: `Assign Clinica ${stamp}`,
        email: `assign-clinica-${stamp}@test.local`,
        passwordHash: "test",
        role: "doctor",
        approvalStatus: "APPROVED",
      })
      .$returningId();
    const [geneticaUser] = await db
      .insert(users)
      .values({
        name: `Assign Genetica ${stamp}`,
        email: `assign-genetica-${stamp}@test.local`,
        passwordHash: "test",
        role: "doctor",
        approvalStatus: "APPROVED",
      })
      .$returningId();

    const [clinicaProfessional] = await db
      .insert(professionals)
      .values({
        userId: clinicaUser.id,
        name: `Assign Clinica ${stamp}`,
        role: "Médico",
        userRole: "USER",
        medicalSpecialtyId: clinicaSpecialty.id,
        specialty: "Clínica Médica",
      })
      .$returningId();
    const [geneticaProfessional] = await db
      .insert(professionals)
      .values({
        userId: geneticaUser.id,
        name: `Assign Genetica ${stamp}`,
        role: "Médico",
        userRole: "USER",
        medicalSpecialtyId: geneticaSpecialty.id,
        specialty: "Genética Médica",
      })
      .$returningId();

    await db.insert(professionalInstitutions).values([
      {
        professionalId: clinicaProfessional.id,
        userId: clinicaUser.id,
        institutionId,
        roleInInstitution: "USER",
        isPrimary: true,
        active: true,
      },
      {
        professionalId: geneticaProfessional.id,
        userId: geneticaUser.id,
        institutionId,
        roleInInstitution: "USER",
        isPrimary: true,
        active: true,
      },
    ]);
    await db.insert(professionalAccess).values([
      {
        institutionId,
        professionalId: clinicaProfessional.id,
        hospitalId,
        sectorId,
        canAccess: true,
      },
      {
        institutionId,
        professionalId: geneticaProfessional.id,
        hospitalId,
        sectorId,
        canAccess: true,
      },
    ]);

    try {
      const clinica = await caller.assignDirect({
        shiftInstanceId,
        professionalId: clinicaProfessional.id,
        assignmentType: "ON_DUTY",
        reason: "Clínica Médica fora da allowlist",
      });
      expect(clinica.ok).toBe(true);

      await caller.unassignDirect({
        assignmentId: clinica.assignmentId,
        reason: "Liberar vaga para genética",
      });

      const genetica = await caller.assignDirect({
        shiftInstanceId,
        professionalId: geneticaProfessional.id,
        assignmentType: "ON_DUTY",
        reason: "Genética fora da allowlist",
      });
      expect(genetica.ok).toBe(true);

      await caller.unassignDirect({
        assignmentId: genetica.assignmentId,
        reason: "Liberar vaga para gestor",
      });

      const gestor = await caller.assignDirect({
        shiftInstanceId,
        professionalId: managerProfessionalId,
        assignmentType: "ON_DUTY",
        reason: "Gestor sem especialidade",
      });
      expect(gestor.ok).toBe(true);
    } finally {
      await db
        .delete(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.shiftInstanceId, shiftInstanceId));
      await db
        .delete(professionalAccess)
        .where(
          inArray(professionalAccess.professionalId, [
            clinicaProfessional.id,
            geneticaProfessional.id,
          ]),
        );
      await db
        .delete(professionalInstitutions)
        .where(
          inArray(professionalInstitutions.professionalId, [
            clinicaProfessional.id,
            geneticaProfessional.id,
          ]),
        );
      await db
        .delete(professionals)
        .where(
          inArray(professionals.id, [
            clinicaProfessional.id,
            geneticaProfessional.id,
          ]),
        );
      await db
        .delete(users)
        .where(inArray(users.id, [clinicaUser.id, geneticaUser.id]));
      await db
        .delete(medicalSpecialties)
        .where(
          inArray(medicalSpecialties.id, [
            clinicaSpecialty.id,
            geneticaSpecialty.id,
          ]),
        );
    }
  });

  it("bloqueia bypass de alocação direta com acesso só hospitalar", async () => {
    const caller = editorRouter.createCaller({
      user: {
        id: managerUserId,
        role: "manager",
        name: "Assign Direct Manager",
        email: "manager@test.local",
        sessionVersion: 1,
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);

    await db
      .delete(professionalAccess)
      .where(eq(professionalAccess.professionalId, targetProfessionalId));
    await db.insert(professionalAccess).values({
      institutionId,
      professionalId: targetProfessionalId,
      hospitalId,
      sectorId: null,
      canAccess: true,
    });

    try {
      await expect(
        caller.assignDirect({
          shiftInstanceId,
          professionalId: targetProfessionalId,
          assignmentType: "ON_DUTY",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await db
        .delete(professionalAccess)
        .where(eq(professionalAccess.professionalId, targetProfessionalId));
      await db.insert(professionalAccess).values({
        institutionId,
        professionalId: targetProfessionalId,
        hospitalId,
        sectorId,
        canAccess: true,
      });
    }
  });

  it("capacidade conta toda alocação ativa, inclusive PENDENTE", async () => {
    await db.insert(shiftAssignmentsV2).values(
      Array.from({ length: 20 }, () => ({
        shiftInstanceId,
        institutionId,
        hospitalId,
        sectorId,
        professionalId: managerProfessionalId,
        assignmentType: "ON_DUTY" as const,
        status: "PENDENTE" as const,
        isActive: true,
        createdBy: managerUserId,
      })),
    );
    await db
      .update(shiftInstances)
      .set({ status: "PENDENTE" })
      .where(eq(shiftInstances.id, shiftInstanceId));

    const caller = editorRouter.createCaller({
      user: {
        id: managerUserId,
        role: "manager",
        name: "Assign Direct Manager",
        email: "manager@test.local",
        sessionVersion: 1,
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);
    await expect(
      caller.assignDirect({
        shiftInstanceId,
        professionalId: targetProfessionalId,
        assignmentType: "ON_DUTY",
      }),
    ).rejects.toThrow(/Limite de 20 profissionais/);

    const active = await db
      .select({ id: shiftAssignmentsV2.id })
      .from(shiftAssignmentsV2)
      .where(
        and(
          eq(shiftAssignmentsV2.shiftInstanceId, shiftInstanceId),
          eq(shiftAssignmentsV2.isActive, true),
        ),
      );
    expect(active).toHaveLength(20);
  });

  it("remove a última alocação e registra auditoria com instituição", async () => {
    const caller = editorRouter.createCaller({
      user: {
        id: managerUserId,
        role: "manager",
        name: "Assign Direct Manager",
        email: "manager@test.local",
        sessionVersion: 1,
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

    await expect(
      caller.unassignDirect({
        assignmentId: assignment.assignmentId,
        reason: "Tela desatualizada",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const auditRowsAfterRetry = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.action, "ASSIGNMENT_REMOVED"),
          eq(auditTrail.entityId, assignment.assignmentId),
        ),
      );
    expect(auditRowsAfterRetry).toHaveLength(1);
  });

  it("aloca o GESTOR_MEDICO da escala pelo manager_scope, sem professional_access", async () => {
    const caller = editorRouter.createCaller({
      user: {
        id: managerUserId,
        role: "manager",
        name: "Assign Direct Manager",
        email: "manager@test.local",
        sessionVersion: 1,
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);

    const result = await caller.assignDirect({
      shiftInstanceId,
      professionalId: managerProfessionalId,
      assignmentType: "ON_DUTY",
      reason: "Gestor no plantão",
    });
    expect(result.ok).toBe(true);

    const assignments = await db
      .select()
      .from(shiftAssignmentsV2)
      .where(
        and(
          eq(shiftAssignmentsV2.shiftInstanceId, shiftInstanceId),
          eq(shiftAssignmentsV2.professionalId, managerProfessionalId),
          eq(shiftAssignmentsV2.isActive, true),
        ),
      );
    expect(assignments).toHaveLength(1);
  });

  it("aloca convidado com e-mail enviado e convite ainda não resgatado", async () => {
    const stamp = Date.now();
    const [inviteeUser] = await db
      .insert(users)
      .values({
        name: `Assign Pending Invitee ${stamp}`,
        email: `assign-pending-invitee-${stamp}@test.local`,
        passwordHash: "test",
        role: "doctor",
        approvalStatus: "APPROVED",
      })
      .$returningId();
    const [inviteeProfessional] = await db
      .insert(professionals)
      .values({
        userId: inviteeUser.id,
        name: `Assign Pending Invitee ${stamp}`,
        role: "Médico",
        userRole: "USER",
        medicalSpecialtyId: anesthesiaSpecialtyId,
        specialty: "Anestesiologia",
      })
      .$returningId();
    await db.insert(scheduleInvites).values({
      institutionId,
      hospitalId,
      sectorId,
      codeHash: hashScheduleInviteCode(
        normalizeScheduleInviteCode(generateScheduleInviteCode()),
      ),
      createdByUserId: managerUserId,
      invitedUserId: inviteeUser.id,
      maxRedemptions: 1,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const caller = editorRouter.createCaller({
      user: {
        id: managerUserId,
        role: "manager",
        name: "Assign Direct Manager",
        email: "manager@test.local",
        sessionVersion: 1,
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as any);

    try {
      const result = await caller.assignDirect({
        shiftInstanceId,
        professionalId: inviteeProfessional.id,
        assignmentType: "ON_DUTY",
        reason: "Convite pendente",
      });
      expect(result.ok).toBe(true);

      const [membership] = await db
        .select({ active: professionalInstitutions.active })
        .from(professionalInstitutions)
        .where(
          eq(professionalInstitutions.professionalId, inviteeProfessional.id),
        );
      expect(membership?.active).toBe(true);
    } finally {
      await db
        .delete(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.professionalId, inviteeProfessional.id));
      await db
        .delete(professionalInstitutions)
        .where(
          eq(professionalInstitutions.professionalId, inviteeProfessional.id),
        );
      await db
        .delete(scheduleInvites)
        .where(eq(scheduleInvites.invitedUserId, inviteeUser.id));
      await db
        .delete(professionals)
        .where(eq(professionals.id, inviteeProfessional.id));
      await db.delete(users).where(eq(users.id, inviteeUser.id));
    }
  });
});
