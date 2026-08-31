import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditTrail,
  hospitals,
  institutions,
  managerScope,
  medicalSpecialties,
  monthlyRosters,
  notifications,
  professionalAccess,
  professionalInstitutions,
  professionals,
  scheduleContextAllowedQualifications,
  scheduleContexts,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  swapRequests,
  swapRequestDismissals,
  users,
  dutyConfirmations,
} from "../drizzle/schema";
import {
  ensureTestAnesthesiaSpecialty,
  openTestScale,
} from "./helpers/open-test-scale";
import { getDb } from "../server/db";
import { swapRouter } from "../server/swap-router";
import { yearMonthBrt } from "../server/local-time";

vi.mock("../server/integrations/comunica-plus", () => ({
  enqueueComunicaSwapApproved: vi.fn(async () => 1),
}));

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Identity = {
  userId: number;
  professionalId: number;
  name: string;
  role: "doctor" | "manager" | "admin";
};

describe("take em um passo: quem assume leva o plantão", () => {
  let db: Db;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let otherSectorId: number;
  let scheduleContextId: number;
  let otherScheduleContextId: number;
  let anesthesiaId: number;
  let clinicaId: number;
  let offerer: Identity;
  let peer: Identity;
  let peerTwo: Identity;
  let gestor: Identity;
  let plus: Identity;
  let globalAdmin: Identity;
  const userIds: number[] = [];
  const professionalIds: number[] = [];
  const stamp = Date.now();

  const at = (dayOffset: number, hour: number): Date => {
    const value = new Date();
    value.setUTCDate(value.getUTCDate() + 700 + dayOffset);
    value.setUTCHours(hour, 0, 0, 0);
    return value;
  };

  const nextMonthAt = (): Date => {
    const now = new Date();
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 15, 12, 0, 0),
    );
  };

  async function moveShiftIntoGestorMedicoWindow(shiftId: number): Promise<void> {
    const startAt = nextMonthAt();
    const endAt = new Date(startAt.getTime() + 6 * 60 * 60_000);
    await db
      .update(shiftInstances)
      .set({ startAt, endAt })
      .where(eq(shiftInstances.id, shiftId));
    await db
      .insert(monthlyRosters)
      .values({
        institutionId,
        hospitalId,
        yearMonth: yearMonthBrt(startAt),
        status: "PUBLISHED",
      })
      .onDuplicateKeyUpdate({ set: { status: "PUBLISHED" } });
  }

  async function createIdentity(
    label: string,
    input: {
      roleInInstitution: "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";
      medicalSpecialtyId: number | null;
      specialty: string | null;
      withAccess?: boolean;
      globalRole?: "doctor" | "manager" | "admin";
    },
  ): Promise<Identity> {
    const name = `one-step-${stamp}-${label}`;
    const role =
      input.globalRole ??
      (input.roleInInstitution === "USER" ? "doctor" : "manager");
    const [user] = await db
      .insert(users)
      .values({
        name,
        email: `${name}@example.test`,
        passwordHash: "not-used",
        role,
        approvalStatus: "APPROVED",
        sessionVersion: 1,
      })
      .$returningId();
    userIds.push(user.id);
    const [professional] = await db
      .insert(professionals)
      .values({
        userId: user.id,
        name,
        role: "Médico",
        specialty: input.specialty,
        medicalSpecialtyId: input.medicalSpecialtyId,
        userRole: input.roleInInstitution,
      })
      .$returningId();
    professionalIds.push(professional.id);
    await db.insert(professionalInstitutions).values({
      professionalId: professional.id,
      userId: user.id,
      institutionId,
      roleInInstitution: input.roleInInstitution,
      active: true,
    });
    if (input.withAccess !== false) {
      await db.insert(professionalAccess).values({
        institutionId,
        professionalId: professional.id,
        hospitalId,
        sectorId,
        canAccess: true,
      });
    }
    return { userId: user.id, professionalId: professional.id, name, role };
  }

  function callerFor(identity: Identity) {
    return swapRouter.createCaller({
      user: {
        id: identity.userId,
        role: identity.role,
        name: identity.name,
        email: `${identity.name}@example.test`,
        sessionVersion: 1,
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as never);
  }

  async function createOccupiedShift(
    owner: Identity,
    dayOffset: number,
    specialty: string,
  ): Promise<{ shiftId: number; assignmentId: number }> {
    const startAt = at(dayOffset, 8);
    await db
      .insert(monthlyRosters)
      .values({
        institutionId,
        hospitalId,
        yearMonth: yearMonthBrt(startAt),
        status: "PUBLISHED",
      })
      .onDuplicateKeyUpdate({ set: { status: "PUBLISHED" } });
    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId,
        sectorId,
        scheduleContextId,
        label: `one-step-${stamp}-shift-${dayOffset}`,
        specialty,
        startAt,
        endAt: at(dayOffset, 14),
        status: "OCUPADO",
      })
      .$returningId();
    const [assignment] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId: shift.id,
        institutionId,
        hospitalId,
        sectorId,
        professionalId: owner.professionalId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
      })
      .$returningId();
    return { shiftId: shift.id, assignmentId: assignment.id };
  }

  async function insertLeftoverAccepted(
    candidate: Identity,
    dayOffset: number,
  ): Promise<{ swapId: number; shiftId: number }> {
    const shift = await createOccupiedShift(offerer, dayOffset, "Clínica Médica");
    const [swap] = await db
      .insert(swapRequests)
      .values({
        type: "CESSAO",
        status: "ACCEPTED",
        fromProfessionalId: offerer.professionalId,
        fromUserId: offerer.userId,
        fromShiftInstanceId: shift.shiftId,
        fromAssignmentId: shift.assignmentId,
        toProfessionalId: candidate.professionalId,
        toUserId: candidate.userId,
        institutionId,
        hospitalId,
        sectorId,
        expiresAt: at(dayOffset + 2, 8),
      })
      .$returningId();
    return { swapId: swap.id, shiftId: shift.shiftId };
  }

  async function insertCrossSectorAccepted(
    candidate: Identity,
    dayOffset: number,
  ): Promise<{ swapId: number; sourceShiftId: number; targetShiftId: number }> {
    const source = await createOccupiedShift(offerer, dayOffset, "Clínica Médica");
    const [targetShift] = await db
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId,
        sectorId: otherSectorId,
        scheduleContextId: otherScheduleContextId,
        label: `one-step-${stamp}-cross-sector-${dayOffset}`,
        specialty: "Anestesiologia",
        startAt: at(dayOffset, 8),
        endAt: at(dayOffset, 14),
        status: "OCUPADO",
      })
      .$returningId();
    const [targetAssignment] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId: targetShift.id,
        institutionId,
        hospitalId,
        sectorId: otherSectorId,
        professionalId: candidate.professionalId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
      })
      .$returningId();
    const [swap] = await db
      .insert(swapRequests)
      .values({
        type: "SWAP",
        status: "ACCEPTED",
        fromProfessionalId: offerer.professionalId,
        fromUserId: offerer.userId,
        fromShiftInstanceId: source.shiftId,
        fromAssignmentId: source.assignmentId,
        toProfessionalId: candidate.professionalId,
        toUserId: candidate.userId,
        toShiftInstanceId: targetShift.id,
        toAssignmentId: targetAssignment.id,
        institutionId,
        hospitalId,
        sectorId,
        expiresAt: at(dayOffset + 2, 8),
      })
      .$returningId();
    return {
      swapId: swap.id,
      sourceShiftId: source.shiftId,
      targetShiftId: targetShift.id,
    };
  }

  async function expectTransferred(
    swapId: number,
    shiftId: number,
    taker: Identity,
  ) {
    const [swap] = await db
      .select({
        status: swapRequests.status,
        toProfessionalId: swapRequests.toProfessionalId,
        toUserId: swapRequests.toUserId,
      })
      .from(swapRequests)
      .where(eq(swapRequests.id, swapId))
      .limit(1);
    expect(swap).toMatchObject({
      status: "APPROVED",
      toProfessionalId: taker.professionalId,
      toUserId: taker.userId,
    });
    const assignments = await db
      .select({
        professionalId: shiftAssignmentsV2.professionalId,
        isActive: shiftAssignmentsV2.isActive,
      })
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.shiftInstanceId, shiftId));
    expect(
      assignments.some(
        (row) => row.professionalId === taker.professionalId && row.isActive,
      ),
    ).toBe(true);
    expect(
      assignments.some(
        (row) =>
          row.professionalId === offerer.professionalId && row.isActive,
      ),
    ).toBe(false);
  }

  beforeAll(async () => {
    const connection = await getDb();
    if (!connection) throw new Error("Database not available");
    db = connection;

    const [institution] = await db
      .insert(institutions)
      .values({
        name: `One Step ${stamp}`,
        cnpj: String(stamp).slice(-14).padStart(14, "7"),
        legalName: `One Step ${stamp}`,
        tradeName: `OS${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = institution.id;
    const [hospital] = await db
      .insert(hospitals)
      .values({ institutionId, name: `One Step Hospital ${stamp}` })
      .$returningId();
    hospitalId = hospital.id;
    const [sector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `Sala de Recuperação ${stamp}`,
        category: "cirurgico",
        color: "#123456",
      })
      .$returningId();
    sectorId = sector.id;
    const [otherSector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `UTI ${stamp}`,
        category: "clinico",
        color: "#654321",
      })
      .$returningId();
    otherSectorId = otherSector.id;
    anesthesiaId = await ensureTestAnesthesiaSpecialty(db);
    const [clinica] = await db
      .insert(medicalSpecialties)
      .values({
        code: `ONE_STEP_CLINICA_${stamp}`,
        name: "Clínica Médica",
        sourceVersion: "TEST",
        active: true,
        sortOrder: 21,
      })
      .$returningId();
    clinicaId = clinica.id;
    scheduleContextId = await openTestScale(db, {
      institutionId,
      hospitalId,
      sectorId,
    });
    otherScheduleContextId = await openTestScale(db, {
      institutionId,
      hospitalId,
      sectorId: otherSectorId,
    });
    await db
      .update(scheduleContexts)
      .set({
        admissionPolicy: "QUALIFICATION_ALLOWLIST",
        medicalSpecialtyId: null,
        operationalProfileCode: null,
      })
      .where(eq(scheduleContexts.id, scheduleContextId));
    await db
      .update(scheduleContexts)
      .set({
        admissionPolicy: "QUALIFICATION_ALLOWLIST",
        medicalSpecialtyId: null,
        operationalProfileCode: null,
      })
      .where(eq(scheduleContexts.id, otherScheduleContextId));
    await db.insert(scheduleContextAllowedQualifications).values([
      { scheduleContextId, medicalSpecialtyId: anesthesiaId },
      { scheduleContextId, medicalSpecialtyId: clinicaId },
      { scheduleContextId: otherScheduleContextId, medicalSpecialtyId: anesthesiaId },
      { scheduleContextId: otherScheduleContextId, medicalSpecialtyId: clinicaId },
    ]);

    offerer = await createIdentity("offerer", {
      roleInInstitution: "USER",
      medicalSpecialtyId: clinicaId,
      specialty: "Clínica Médica",
    });
    peer = await createIdentity("peer", {
      roleInInstitution: "USER",
      medicalSpecialtyId: anesthesiaId,
      specialty: "Anestesiologia",
    });
    await db.insert(professionalAccess).values({
      institutionId,
      professionalId: peer.professionalId,
      hospitalId,
      sectorId: otherSectorId,
      canAccess: true,
    });
    peerTwo = await createIdentity("peer-two", {
      roleInInstitution: "USER",
      medicalSpecialtyId: anesthesiaId,
      specialty: "Anestesiologia",
    });
    gestor = await createIdentity("gestor", {
      roleInInstitution: "GESTOR_MEDICO",
      medicalSpecialtyId: null,
      specialty: null,
      withAccess: false,
    });
    await db.insert(managerScope).values({
      institutionId,
      managerProfessionalId: gestor.professionalId,
      hospitalId,
      sectorId,
      active: true,
    });
    plus = await createIdentity("plus", {
      roleInInstitution: "GESTOR_PLUS",
      medicalSpecialtyId: null,
      specialty: null,
      withAccess: false,
    });
    globalAdmin = await createIdentity("global-admin", {
      roleInInstitution: "USER",
      medicalSpecialtyId: null,
      specialty: null,
      withAccess: false,
      globalRole: "admin",
    });
  });

  beforeEach(async () => {
    await db.delete(notifications).where(eq(notifications.institutionId, institutionId));
    await db
      .delete(swapRequestDismissals)
      .where(eq(swapRequestDismissals.institutionId, institutionId));
    await db.delete(swapRequests).where(eq(swapRequests.institutionId, institutionId));
    await db
      .delete(dutyConfirmations)
      .where(eq(dutyConfirmations.institutionId, institutionId));
    await db
      .delete(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.institutionId, institutionId));
    await db.delete(shiftInstances).where(eq(shiftInstances.institutionId, institutionId));
    await db.delete(monthlyRosters).where(eq(monthlyRosters.institutionId, institutionId));
    await db.delete(auditTrail).where(eq(auditTrail.institutionId, institutionId));
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(auditTrail).where(eq(auditTrail.institutionId, institutionId));
    await db.delete(notifications).where(eq(notifications.institutionId, institutionId));
    await db
      .delete(dutyConfirmations)
      .where(eq(dutyConfirmations.institutionId, institutionId));
    await db
      .delete(swapRequestDismissals)
      .where(eq(swapRequestDismissals.institutionId, institutionId));
    await db.delete(swapRequests).where(eq(swapRequests.institutionId, institutionId));
    await db
      .delete(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.institutionId, institutionId));
    await db.delete(shiftInstances).where(eq(shiftInstances.institutionId, institutionId));
    await db.delete(monthlyRosters).where(eq(monthlyRosters.institutionId, institutionId));
    await db
      .delete(scheduleContextAllowedQualifications)
      .where(
        inArray(scheduleContextAllowedQualifications.scheduleContextId, [
          scheduleContextId,
          otherScheduleContextId,
        ]),
      );
    await db.delete(managerScope).where(eq(managerScope.institutionId, institutionId));
    await db
      .delete(professionalAccess)
      .where(eq(professionalAccess.institutionId, institutionId));
    await db
      .delete(professionalInstitutions)
      .where(eq(professionalInstitutions.institutionId, institutionId));
    await db.delete(professionals).where(inArray(professionals.id, professionalIds));
    await db.delete(users).where(inArray(users.id, userIds));
    await db
      .delete(scheduleContexts)
      .where(inArray(scheduleContexts.id, [scheduleContextId, otherScheduleContextId]));
    await db.delete(sectors).where(inArray(sectors.id, [sectorId, otherSectorId]));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    await db.delete(medicalSpecialties).where(eq(medicalSpecialties.id, clinicaId));
  });

  it("profissional assume oferta aberta e a alocação transfere sem aprovação do dono", async () => {
    const shift = await createOccupiedShift(offerer, 1, "Clínica Médica");
    const created = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: shift.shiftId,
      fromAssignmentId: shift.assignmentId,
    });

    await expect(
      callerFor(peer).accept({ swapRequestId: Number(created.id) }),
    ).resolves.toEqual({ ok: true });

    await expectTransferred(Number(created.id), shift.shiftId, peer);
    const ownerRows = await callerFor(offerer).list({ role: "OFFERER" });
    const row = ownerRows.find((item) => Number(item.id) === Number(created.id));
    expect(row?.awaitingMyApproval).toBe(false);
    expect(row?.status).toBe("APPROVED");
  });

  it("coordenador GESTOR com manager_scope e sem ACL assume sem 500", async () => {
    const shift = await createOccupiedShift(offerer, 2, "Clínica Médica");
    const created = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: shift.shiftId,
      fromAssignmentId: shift.assignmentId,
    });

    await expect(
      callerFor(gestor).accept({ swapRequestId: Number(created.id) }),
    ).resolves.toEqual({ ok: true });
    await expectTransferred(Number(created.id), shift.shiftId, gestor);
    const ownerRows = await callerFor(offerer).list({ role: "OFFERER" });
    expect(
      ownerRows.find((item) => Number(item.id) === Number(created.id))
        ?.awaitingMyApproval,
    ).toBe(false);
  });

  it("segundo profissional recebe CONFLICT em português", async () => {
    const shift = await createOccupiedShift(offerer, 3, "Clínica Médica");
    const created = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: shift.shiftId,
      fromAssignmentId: shift.assignmentId,
    });
    await expect(
      callerFor(peer).accept({ swapRequestId: Number(created.id) }),
    ).resolves.toEqual({ ok: true });
    await expect(
      callerFor(peerTwo).accept({ swapRequestId: Number(created.id) }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Esta solicitação já foi efetivada ou cancelada.",
    });
    await expectTransferred(Number(created.id), shift.shiftId, peer);
  });

  it("oferta direcionada completa no aceite do destinatário", async () => {
    const shift = await createOccupiedShift(offerer, 4, "Clínica Médica");
    const created = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: shift.shiftId,
      fromAssignmentId: shift.assignmentId,
      toProfessionalId: peer.professionalId,
    });
    await expect(
      callerFor(peer).accept({ swapRequestId: Number(created.id) }),
    ).resolves.toEqual({ ok: true });
    await expectTransferred(Number(created.id), shift.shiftId, peer);
  });

  it("enfileira outbox para o dono no mesmo take", async () => {
    const shift = await createOccupiedShift(offerer, 5, "Clínica Médica");
    const created = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: shift.shiftId,
      fromAssignmentId: shift.assignmentId,
    });
    await callerFor(plus).accept({ swapRequestId: Number(created.id) });

    const rows = await db
      .select({
        userId: notifications.userId,
        title: notifications.title,
        dedupKey: notifications.dedupKey,
      })
      .from(notifications)
      .where(eq(notifications.institutionId, institutionId));
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: offerer.userId,
          title: "Plantão assumido",
          dedupKey: `swap-taken:${Number(created.id)}:${offerer.userId}`,
        }),
      ]),
    );
  });

  it("troca efetivada emite WITHDRAW do titular confirmado e não declara o assumidor", async () => {
    const shift = await createOccupiedShift(offerer, 12, "Clínica Médica");
    await db.insert(dutyConfirmations).values({
      institutionId,
      shiftInstanceId: shift.shiftId,
      assignmentId: shift.assignmentId,
      professionalId: offerer.professionalId,
      userId: offerer.userId,
      status: "CONFIRMED",
      notifiedAt: new Date(),
      respondedAt: new Date(),
      confirmationToken: crypto.randomUUID(),
    });
    const created = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: shift.shiftId,
      fromAssignmentId: shift.assignmentId,
    });
    const afterOffer = await db
      .select({ title: notifications.title, body: notifications.body })
      .from(notifications)
      .where(eq(notifications.institutionId, institutionId));
    expect(afterOffer.some((row) => row.title === "Duty roster sync")).toBe(false);

    await callerFor(peer).accept({ swapRequestId: Number(created.id) });
    const dutySync = await db
      .select({
        userId: notifications.userId,
        title: notifications.title,
        body: notifications.body,
      })
      .from(notifications)
      .where(eq(notifications.institutionId, institutionId));
    const withdraws = dutySync.filter((row) => row.title === "Duty roster sync");
    expect(withdraws).toEqual([
      expect.objectContaining({
        userId: offerer.userId,
        title: "Duty roster sync",
        body: "WITHDRAW",
      }),
    ]);
    expect(withdraws.some((row) => row.body === "CONFIRM")).toBe(false);
  });

  it("listar ACCEPTED residual é leitura: não muda swap, alocações, auditoria ou outbox", async () => {
    const leftover = await insertLeftoverAccepted(gestor, 6);
    const [swapBefore] = await db
      .select({
        status: swapRequests.status,
        version: swapRequests.version,
        reviewedByUserId: swapRequests.reviewedByUserId,
        reviewedAt: swapRequests.reviewedAt,
        reviewNote: swapRequests.reviewNote,
      })
      .from(swapRequests)
      .where(eq(swapRequests.id, leftover.swapId));
    const assignmentsBefore = await db
      .select({
        id: shiftAssignmentsV2.id,
        professionalId: shiftAssignmentsV2.professionalId,
        isActive: shiftAssignmentsV2.isActive,
        status: shiftAssignmentsV2.status,
      })
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.shiftInstanceId, leftover.shiftId));
    const auditBefore = await db
      .select({ id: auditTrail.id, action: auditTrail.action })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.institutionId, institutionId),
          eq(auditTrail.entityId, leftover.swapId),
        ),
      );
    const outboxBefore = await db
      .select({
        id: notifications.id,
        userId: notifications.userId,
        dedupKey: notifications.dedupKey,
      })
      .from(notifications)
      .where(eq(notifications.institutionId, institutionId));

    const ownerRows = await callerFor(offerer).list({ role: "OFFERER" });
    const row = ownerRows.find((item) => Number(item.id) === leftover.swapId);
    expect(row).toMatchObject({
      status: "ACCEPTED",
      awaitingMyApproval: false,
      canCancel: true,
    });

    const [swapAfter] = await db
      .select({
        status: swapRequests.status,
        version: swapRequests.version,
        reviewedByUserId: swapRequests.reviewedByUserId,
        reviewedAt: swapRequests.reviewedAt,
        reviewNote: swapRequests.reviewNote,
      })
      .from(swapRequests)
      .where(eq(swapRequests.id, leftover.swapId));
    const assignmentsAfter = await db
      .select({
        id: shiftAssignmentsV2.id,
        professionalId: shiftAssignmentsV2.professionalId,
        isActive: shiftAssignmentsV2.isActive,
        status: shiftAssignmentsV2.status,
      })
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.shiftInstanceId, leftover.shiftId));
    const auditAfter = await db
      .select({ id: auditTrail.id, action: auditTrail.action })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.institutionId, institutionId),
          eq(auditTrail.entityId, leftover.swapId),
        ),
      );
    const outboxAfter = await db
      .select({
        id: notifications.id,
        userId: notifications.userId,
        dedupKey: notifications.dedupKey,
      })
      .from(notifications)
      .where(eq(notifications.institutionId, institutionId));

    expect(swapAfter).toEqual(swapBefore);
    expect(assignmentsAfter).toEqual(assignmentsBefore);
    expect(auditAfter).toEqual(auditBefore);
    expect(outboxAfter).toEqual(outboxBefore);
  });

  it("reconciliação explícita completa ACCEPTED residual para GESTOR com scope sem ACL", async () => {
    const leftover = await insertLeftoverAccepted(gestor, 7);

    await expect(
      callerFor(gestor).reconcileAccepted({ swapRequestId: leftover.swapId }),
    ).resolves.toEqual({ outcome: "APPROVED" });
    await expectTransferred(leftover.swapId, leftover.shiftId, gestor);

    const audits = await db
      .select({
        actorUserId: auditTrail.actorUserId,
        actorRole: auditTrail.actorRole,
      })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.institutionId, institutionId),
          eq(auditTrail.entityId, leftover.swapId),
          eq(auditTrail.action, "CESSAO_ACCEPTED"),
        ),
      );
    expect(audits).toEqual([
      expect.objectContaining({
        actorUserId: gestor.userId,
        actorRole: "GESTOR_MEDICO",
      }),
    ]);
  });

  it("GESTOR_MEDICO não participante reconcilia dentro da competência e audita o papel canônico", async () => {
    const leftover = await insertLeftoverAccepted(peer, 18);
    await moveShiftIntoGestorMedicoWindow(leftover.shiftId);

    await expect(
      callerFor(gestor).reconcileAccepted({ swapRequestId: leftover.swapId }),
    ).resolves.toEqual({ outcome: "APPROVED" });
    await expectTransferred(leftover.swapId, leftover.shiftId, peer);

    const [audit] = await db
      .select({
        actorUserId: auditTrail.actorUserId,
        actorRole: auditTrail.actorRole,
      })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.institutionId, institutionId),
          eq(auditTrail.entityId, leftover.swapId),
          eq(auditTrail.action, "CESSAO_ACCEPTED"),
        ),
      );
    expect(audit).toMatchObject({
      actorUserId: gestor.userId,
      actorRole: "GESTOR_MEDICO",
    });
  });

  it("GESTOR_MEDICO não participante fora da competência não altera swap, auditoria ou outbox", async () => {
    const leftover = await insertLeftoverAccepted(peer, 19);

    await expect(
      callerFor(gestor).reconcileAccepted({ swapRequestId: leftover.swapId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const [swap] = await db
      .select({ status: swapRequests.status })
      .from(swapRequests)
      .where(eq(swapRequests.id, leftover.swapId));
    expect(swap?.status).toBe("ACCEPTED");
    await expectStillOwnedByOfferer(leftover.shiftId);
    const [audits, outbox] = await Promise.all([
      db
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(
          and(
            eq(auditTrail.institutionId, institutionId),
            eq(auditTrail.entityId, leftover.swapId),
          ),
        ),
      db
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.institutionId, institutionId)),
    ]);
    expect(audits).toHaveLength(0);
    expect(outbox).toHaveLength(0);
  });

  it("GESTOR_PLUS não participante reconcilia residual fora da janela do gestor médico", async () => {
    const leftover = await insertLeftoverAccepted(peer, 20);

    await expect(
      callerFor(plus).reconcileAccepted({ swapRequestId: leftover.swapId }),
    ).resolves.toEqual({ outcome: "APPROVED" });
    await expectTransferred(leftover.swapId, leftover.shiftId, peer);
  });

  it("admin global com vínculo USER registra a autoridade efetiva na auditoria", async () => {
    const leftover = await insertLeftoverAccepted(peer, 21);

    await expect(
      callerFor(globalAdmin).reconcileAccepted({
        swapRequestId: leftover.swapId,
      }),
    ).resolves.toEqual({ outcome: "APPROVED" });

    const [audit] = await db
      .select({
        actorUserId: auditTrail.actorUserId,
        actorRole: auditTrail.actorRole,
      })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.institutionId, institutionId),
          eq(auditTrail.entityId, leftover.swapId),
          eq(auditTrail.action, "CESSAO_ACCEPTED"),
        ),
      );
    expect(audit).toMatchObject({
      actorUserId: globalAdmin.userId,
      actorRole: "GESTOR_PLUS",
    });
  });

  it("GESTOR_MEDICO sem scope na contrapartida cross-setor não reconcilia", async () => {
    const leftover = await insertCrossSectorAccepted(peer, 22);
    await moveShiftIntoGestorMedicoWindow(leftover.sourceShiftId);
    await moveShiftIntoGestorMedicoWindow(leftover.targetShiftId);

    await expect(
      callerFor(gestor).reconcileAccepted({ swapRequestId: leftover.swapId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const [swap] = await db
      .select({ status: swapRequests.status })
      .from(swapRequests)
      .where(eq(swapRequests.id, leftover.swapId));
    expect(swap?.status).toBe("ACCEPTED");
    await expectStillOwnedByOfferer(leftover.sourceShiftId);
    const targetAssignments = await db
      .select({
        professionalId: shiftAssignmentsV2.professionalId,
        isActive: shiftAssignmentsV2.isActive,
      })
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.shiftInstanceId, leftover.targetShiftId));
    expect(
      targetAssignments.some(
        (assignment) =>
          assignment.professionalId === peer.professionalId && assignment.isActive,
      ),
    ).toBe(true);
    const [audits, outbox] = await Promise.all([
      db
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(
          and(
            eq(auditTrail.institutionId, institutionId),
            eq(auditTrail.entityId, leftover.swapId),
          ),
        ),
      db
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.institutionId, institutionId)),
    ]);
    expect(audits).toHaveLength(0);
    expect(outbox).toHaveLength(0);
  });

  it("reconciliação rejeita terceiro elegível que não participa nem gere o setor", async () => {
    const leftover = await insertLeftoverAccepted(peer, 16);

    await expect(
      callerFor(peerTwo).reconcileAccepted({ swapRequestId: leftover.swapId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const [swap] = await db
      .select({ status: swapRequests.status })
      .from(swapRequests)
      .where(eq(swapRequests.id, leftover.swapId));
    expect(swap?.status).toBe("ACCEPTED");
    await expectStillOwnedByOfferer(leftover.shiftId);
    const audits = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.institutionId, institutionId),
          eq(auditTrail.entityId, leftover.swapId),
        ),
      );
    expect(audits).toHaveLength(0);
  });

  it("reconciliações concorrentes convergem para uma única transferência auditada", async () => {
    const leftover = await insertLeftoverAccepted(gestor, 17);

    await expect(
      Promise.all([
        callerFor(offerer).reconcileAccepted({ swapRequestId: leftover.swapId }),
        callerFor(gestor).reconcileAccepted({ swapRequestId: leftover.swapId }),
      ]),
    ).resolves.toEqual([
      { outcome: "APPROVED" },
      { outcome: "APPROVED" },
    ]);
    await expectTransferred(leftover.swapId, leftover.shiftId, gestor);

    const audits = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.institutionId, institutionId),
          eq(auditTrail.entityId, leftover.swapId),
          eq(auditTrail.action, "CESSAO_ACCEPTED"),
        ),
      );
    expect(audits).toHaveLength(1);
  });

  it("accept de novo em ACCEPTED residual com GESTOR sem ACL completa sem 500", async () => {
    const leftover = await insertLeftoverAccepted(gestor, 8);
    await expect(
      callerFor(gestor).accept({ swapRequestId: leftover.swapId }),
    ).resolves.toEqual({ ok: true });
    await expectTransferred(leftover.swapId, leftover.shiftId, gestor);
  });

  async function expectStillOwnedByOfferer(shiftId: number) {
    const assignments = await db
      .select({
        professionalId: shiftAssignmentsV2.professionalId,
        isActive: shiftAssignmentsV2.isActive,
      })
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.shiftInstanceId, shiftId));
    expect(
      assignments.some(
        (row) =>
          row.professionalId === offerer.professionalId && row.isActive,
      ),
    ).toBe(true);
  }

  it("list de já APPROVED é no-op e accept devolve CONFLICT em português", async () => {
    const leftover = await insertLeftoverAccepted(gestor, 9);
    await callerFor(offerer).reconcileAccepted({
      swapRequestId: leftover.swapId,
    });
    await expectTransferred(leftover.swapId, leftover.shiftId, gestor);

    const again = await callerFor(offerer).list({ role: "OFFERER" });
    expect(again.find((item) => Number(item.id) === leftover.swapId)?.status).toBe(
      "APPROVED",
    );

    await expect(
      callerFor(gestor).accept({ swapRequestId: leftover.swapId }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Esta solicitação já foi efetivada ou cancelada.",
    });
    await expectTransferred(leftover.swapId, leftover.shiftId, gestor);
  });

  it("reconciliação explícita de ACCEPTED residual expirada cancela e preserva o dono", async () => {
    const leftover = await insertLeftoverAccepted(gestor, 10);
    await db
      .update(swapRequests)
      .set({ expiresAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(swapRequests.id, leftover.swapId));

    const ownerRows = await callerFor(offerer).list({ role: "OFFERER" });
    const row = ownerRows.find((item) => Number(item.id) === leftover.swapId);
    expect(row?.status).toBe("ACCEPTED");
    expect(row?.awaitingMyApproval).toBe(false);
    expect(row?.canCancel).toBe(true);
    expect(row?.reviewNote).toBeNull();

    await expect(
      callerFor(offerer).reconcileAccepted({ swapRequestId: leftover.swapId }),
    ).resolves.toEqual({ outcome: "CANCELLED" });

    const [swap] = await db
      .select({ status: swapRequests.status, reviewNote: swapRequests.reviewNote })
      .from(swapRequests)
      .where(eq(swapRequests.id, leftover.swapId))
      .limit(1);
    expect(swap).toMatchObject({
      status: "CANCELLED",
      reviewNote: expect.stringMatching(/expirou/),
    });
    await expectStillOwnedByOfferer(leftover.shiftId);
  });

  it("reconciliação explícita cancela ACCEPTED residual com mês não publicado", async () => {
    const leftover = await insertLeftoverAccepted(peer, 11);
    const [shift] = await db
      .select({ startAt: shiftInstances.startAt })
      .from(shiftInstances)
      .where(eq(shiftInstances.id, leftover.shiftId))
      .limit(1);
    await db
      .delete(monthlyRosters)
      .where(eq(monthlyRosters.institutionId, institutionId));
    expect(shift).toBeDefined();

    const ownerRows = await callerFor(offerer).list({ role: "OFFERER" });
    const row = ownerRows.find((item) => Number(item.id) === leftover.swapId);
    expect(row).toMatchObject({ status: "ACCEPTED", canCancel: true });
    await expect(
      callerFor(offerer).reconcileAccepted({ swapRequestId: leftover.swapId }),
    ).resolves.toEqual({ outcome: "CANCELLED" });
    const [swap] = await db
      .select({ status: swapRequests.status, reviewNote: swapRequests.reviewNote })
      .from(swapRequests)
      .where(eq(swapRequests.id, leftover.swapId));
    expect(swap).toMatchObject({
      status: "CANCELLED",
      reviewNote: expect.stringMatching(/escala do mês|publicad|trancad|acesso/),
    });
    await expectStillOwnedByOfferer(leftover.shiftId);
  });

  it("reconciliação explícita cancela ACCEPTED residual com conflito de horário", async () => {
    const leftover = await insertLeftoverAccepted(peer, 12);
    await createOccupiedShift(peer, 12, "Anestesiologia");

    const ownerRows = await callerFor(offerer).list({ role: "OFFERER" });
    const row = ownerRows.find((item) => Number(item.id) === leftover.swapId);
    expect(row).toMatchObject({ status: "ACCEPTED", canCancel: true });
    await expect(
      callerFor(offerer).reconcileAccepted({ swapRequestId: leftover.swapId }),
    ).resolves.toEqual({ outcome: "CANCELLED" });
    const [swap] = await db
      .select({ status: swapRequests.status, reviewNote: swapRequests.reviewNote })
      .from(swapRequests)
      .where(eq(swapRequests.id, leftover.swapId));
    expect(swap).toMatchObject({
      status: "CANCELLED",
      reviewNote: expect.stringMatching(/conflito de horário/),
    });
    await expectStillOwnedByOfferer(leftover.shiftId);
  });

  it("dono cancela ACCEPTED residual que ainda não listou", async () => {
    const leftover = await insertLeftoverAccepted(gestor, 13);
    await expect(
      callerFor(offerer).cancel({ swapRequestId: leftover.swapId }),
    ).resolves.toEqual({ ok: true });
    const [swap] = await db
      .select({ status: swapRequests.status })
      .from(swapRequests)
      .where(eq(swapRequests.id, leftover.swapId))
      .limit(1);
    expect(swap?.status).toBe("CANCELLED");
    await expectStillOwnedByOfferer(leftover.shiftId);
  });

  it("candidato cancela ACCEPTED residual que não pode completar", async () => {
    const leftover = await insertLeftoverAccepted(peer, 14);
    await db
      .update(swapRequests)
      .set({ expiresAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(swapRequests.id, leftover.swapId));

    await expect(
      callerFor(peer).cancel({ swapRequestId: leftover.swapId }),
    ).resolves.toEqual({ ok: true });
    const [swap] = await db
      .select({ status: swapRequests.status })
      .from(swapRequests)
      .where(eq(swapRequests.id, leftover.swapId))
      .limit(1);
    expect(swap?.status).toBe("CANCELLED");
    await expectStillOwnedByOfferer(leftover.shiftId);
  });

  it("accept de ACCEPTED residual que não pode completar desfaz e devolve o erro", async () => {
    const leftover = await insertLeftoverAccepted(peer, 15);
    await db
      .update(swapRequests)
      .set({ expiresAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(swapRequests.id, leftover.swapId));

    await expect(
      callerFor(peer).accept({ swapRequestId: leftover.swapId }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/expirad/),
    });
    const [swap] = await db
      .select({ status: swapRequests.status, reviewNote: swapRequests.reviewNote })
      .from(swapRequests)
      .where(eq(swapRequests.id, leftover.swapId))
      .limit(1);
    expect(swap?.status).toBe("CANCELLED");
    expect(swap?.reviewNote).toMatch(/expirou/);
    await expectStillOwnedByOfferer(leftover.shiftId);
  });
});
