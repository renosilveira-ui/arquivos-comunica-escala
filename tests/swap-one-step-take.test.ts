import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
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
  role: "doctor" | "manager";
};

describe("take em um passo: quem assume leva o plantão", () => {
  let db: Db;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let scheduleContextId: number;
  let anesthesiaId: number;
  let clinicaId: number;
  let offerer: Identity;
  let peer: Identity;
  let peerTwo: Identity;
  let gestor: Identity;
  let plus: Identity;
  const userIds: number[] = [];
  const professionalIds: number[] = [];
  const stamp = Date.now();

  const at = (dayOffset: number, hour: number): Date => {
    const value = new Date();
    value.setUTCDate(value.getUTCDate() + 700 + dayOffset);
    value.setUTCHours(hour, 0, 0, 0);
    return value;
  };

  async function createIdentity(
    label: string,
    input: {
      roleInInstitution: "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";
      medicalSpecialtyId: number | null;
      specialty: string | null;
      withAccess?: boolean;
    },
  ): Promise<Identity> {
    const name = `one-step-${stamp}-${label}`;
    const role = input.roleInInstitution === "USER" ? "doctor" : "manager";
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
    await db
      .update(scheduleContexts)
      .set({
        admissionPolicy: "QUALIFICATION_ALLOWLIST",
        medicalSpecialtyId: null,
        operationalProfileCode: null,
      })
      .where(eq(scheduleContexts.id, scheduleContextId));
    await db.insert(scheduleContextAllowedQualifications).values([
      { scheduleContextId, medicalSpecialtyId: anesthesiaId },
      { scheduleContextId, medicalSpecialtyId: clinicaId },
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
  });

  beforeEach(async () => {
    await db.delete(notifications).where(eq(notifications.institutionId, institutionId));
    await db
      .delete(swapRequestDismissals)
      .where(eq(swapRequestDismissals.institutionId, institutionId));
    await db.delete(swapRequests).where(eq(swapRequests.institutionId, institutionId));
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
      .where(eq(scheduleContextAllowedQualifications.scheduleContextId, scheduleContextId));
    await db.delete(managerScope).where(eq(managerScope.institutionId, institutionId));
    await db
      .delete(professionalAccess)
      .where(eq(professionalAccess.institutionId, institutionId));
    await db
      .delete(professionalInstitutions)
      .where(eq(professionalInstitutions.institutionId, institutionId));
    await db.delete(professionals).where(inArray(professionals.id, professionalIds));
    await db.delete(users).where(inArray(users.id, userIds));
    await db.delete(scheduleContexts).where(eq(scheduleContexts.id, scheduleContextId));
    await db.delete(sectors).where(eq(sectors.id, sectorId));
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

  it("ACCEPTED residual com GESTOR sem ACL completa ao dono listar Minhas ofertas", async () => {
    const leftover = await insertLeftoverAccepted(gestor, 6);
    const ownerRows = await callerFor(offerer).list({ role: "OFFERER" });
    const row = ownerRows.find((item) => Number(item.id) === leftover.swapId);
    expect(row?.status).toBe("APPROVED");
    expect(row?.awaitingMyApproval).toBe(false);
    await expectTransferred(leftover.swapId, leftover.shiftId, gestor);
  });

  it("ACCEPTED residual com GESTOR sem ACL completa ao candidato listar", async () => {
    const leftover = await insertLeftoverAccepted(gestor, 7);
    const receiverRows = await callerFor(gestor).list({ role: "RECEIVER" });
    const row = receiverRows.find((item) => Number(item.id) === leftover.swapId);
    expect(row?.status).toBe("APPROVED");
    expect(row?.awaitingMyApproval).toBe(false);
    await expectTransferred(leftover.swapId, leftover.shiftId, gestor);
  });

  it("accept de novo em ACCEPTED residual com GESTOR sem ACL completa sem 500", async () => {
    const leftover = await insertLeftoverAccepted(gestor, 8);
    await expect(
      callerFor(gestor).accept({ swapRequestId: leftover.swapId }),
    ).resolves.toEqual({ ok: true });
    await expectTransferred(leftover.swapId, leftover.shiftId, gestor);
  });

  it("list de já APPROVED é no-op e accept devolve CONFLICT em português", async () => {
    const leftover = await insertLeftoverAccepted(gestor, 9);
    await callerFor(offerer).list({ role: "OFFERER" });
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
});
