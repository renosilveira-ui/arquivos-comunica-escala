import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
} from "../drizzle/schema";
import {
  ensureTestAnesthesiaSpecialty,
  openTestScale,
} from "./helpers/open-test-scale";
import { TRPCError } from "@trpc/server";
import { getDb } from "../server/db";
import { isExpectedSwapVisibilityDenial, swapRouter } from "../server/swap-router";
import { yearMonthBrt } from "../server/local-time";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Identity = {
  userId: number;
  professionalId: number;
  name: string;
  role: "doctor" | "manager";
};

describe("sinal de oferta de plantão", () => {
  let db: Db;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let scheduleContextId: number;
  let anesthesiaId: number;
  let clinicaId: number;
  let offerer: Identity;
  let peer: Identity;
  let gestor: Identity;
  let plus: Identity;
  const userIds: number[] = [];
  const professionalIds: number[] = [];
  const stamp = Date.now();

  const at = (dayOffset: number, hour: number): Date => {
    const value = new Date();
    value.setUTCDate(value.getUTCDate() + 500 + dayOffset);
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
    const name = `offer-signal-${stamp}-${label}`;
    const role =
      input.roleInInstitution === "USER" ? "doctor" : "manager";
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
        label: `offer-signal-${stamp}-shift-${dayOffset}`,
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

  beforeAll(async () => {
    const connection = await getDb();
    if (!connection) throw new Error("Database not available");
    db = connection;

    const [institution] = await db
      .insert(institutions)
      .values({
        name: `Offer Signal ${stamp}`,
        cnpj: String(stamp).slice(-14).padStart(14, "8"),
        legalName: `Offer Signal ${stamp}`,
        tradeName: `OS${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = institution.id;
    const [hospital] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Offer Signal Hospital ${stamp}` })
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
        code: `OFFER_SIGNAL_CLINICA_${stamp}`,
        name: "Clínica Médica",
        sourceVersion: "TEST",
        active: true,
        sortOrder: 20,
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
    await db
      .delete(medicalSpecialties)
      .where(eq(medicalSpecialties.id, clinicaId));
  });

  it("liga a criação da oferta ao dispatcher de sinal", () => {
    const source = readFileSync("server/swap-router.ts", "utf8");
    expect(source).toContain("enqueueSwapOfferSignals");
    const listAvailable = source.slice(source.indexOf("listAvailable:"));
    expect(listAvailable).toContain("manager_scope");
    expect(listAvailable).toContain("GESTOR_PLUS");
    expect(listAvailable).toContain(
      "ap.medical_specialty_id = aq.medical_specialty_id",
    );
    expect(listAvailable).not.toContain(
      "AND fp.medical_specialty_id = aq.medical_specialty_id",
    );
    const receive = source.slice(
      source.indexOf("async function requireProfessionalCanReceiveShift"),
      source.indexOf("async function requireCanonicalShiftOccupant"),
    );
    expect(receive).toContain("findManagerScopeId");
    expect(receive).toContain("GESTOR_PLUS");
    expect(receive).toContain("assertProfessionalQualifiedForShift");
    const signal = readFileSync("server/swap-offer-signal.ts", "utf8");
    expect(signal).toContain("SIGNAL_TRACKING_FAILED");
    expect(signal).toContain("throw error");
    expect(listAvailable).toContain("actor_directed_scope");
    expect(listAvailable).toContain("canRespond");
    expect(listAvailable).toContain("swap_request_dismissals");
    expect(listAvailable).toContain("source_scope");
    const sourceTuple = source.slice(
      source.indexOf("async function requireCanonicalAssignmentTuple"),
      source.indexOf("async function requireProfessionalCanReceiveShift"),
    );
    expect(sourceTuple).toContain("findManagerScopeId");
    expect(sourceTuple).toContain("GESTOR_PLUS");
    expect(sourceTuple).toContain("assertProfessionalQualifiedForShift");
  });

  it("mostra a cessão ao colega com outra especialidade da allowlist", async () => {
    const shift = await createOccupiedShift(offerer, 1, "Clínica Médica");
    const created = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: shift.shiftId,
      fromAssignmentId: shift.assignmentId,
    });

    const available = await callerFor(peer).listAvailable({ type: "CESSAO" });
    const row = available.find((item) => Number(item.id) === Number(created.id));
    expect(row).toMatchObject({ canRespond: true });
  });

  it("mostra a cessão ao GESTOR_MEDICO da escala sem professional_access", async () => {
    const shift = await createOccupiedShift(offerer, 2, "Clínica Médica");
    const created = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: shift.shiftId,
      fromAssignmentId: shift.assignmentId,
    });

    const available = await callerFor(gestor).listAvailable({});
    const row = available.find((item) => Number(item.id) === Number(created.id));
    expect(row).toMatchObject({ canRespond: true });
  });

  it("GESTOR_MEDICO sem professional_access aceita e o dono efetua a cessão", async () => {
    const shift = await createOccupiedShift(offerer, 5, "Clínica Médica");
    const created = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: shift.shiftId,
      fromAssignmentId: shift.assignmentId,
    });

    await expect(
      callerFor(gestor).accept({ swapRequestId: Number(created.id) }),
    ).resolves.toEqual({ ok: true });

    const [accepted] = await db
      .select({
        status: swapRequests.status,
        toProfessionalId: swapRequests.toProfessionalId,
        toUserId: swapRequests.toUserId,
      })
      .from(swapRequests)
      .where(eq(swapRequests.id, Number(created.id)))
      .limit(1);
    expect(accepted?.status).toBe("ACCEPTED");
    expect(accepted?.toProfessionalId).toBe(gestor.professionalId);
    expect(accepted?.toUserId).toBe(gestor.userId);

    await expect(
      callerFor(offerer).approveByOwner({ swapRequestId: Number(created.id) }),
    ).resolves.toEqual({ ok: true });

    const assignments = await db
      .select({
        professionalId: shiftAssignmentsV2.professionalId,
        isActive: shiftAssignmentsV2.isActive,
      })
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.shiftInstanceId, shift.shiftId));
    expect(
      assignments.some(
        (row) => row.professionalId === gestor.professionalId && row.isActive,
      ),
    ).toBe(true);
    expect(
      assignments.some(
        (row) => row.professionalId === offerer.professionalId && row.isActive,
      ),
    ).toBe(false);
  });

  it("GESTOR_MEDICO sem professional_access recusa a cessão visível sem fechar para os pares", async () => {
    const shift = await createOccupiedShift(offerer, 6, "Clínica Médica");
    const created = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: shift.shiftId,
      fromAssignmentId: shift.assignmentId,
    });

    await expect(
      callerFor(gestor).reject({ swapRequestId: Number(created.id) }),
    ).resolves.toEqual({ ok: true });

    const [open] = await db
      .select({ status: swapRequests.status })
      .from(swapRequests)
      .where(eq(swapRequests.id, Number(created.id)))
      .limit(1);
    expect(open?.status).toBe("PENDING");
    expect(
      (await callerFor(gestor).listAvailable({})).map((row) => Number(row.id)),
    ).not.toContain(Number(created.id));
    const peerRow = (await callerFor(peer).listAvailable({})).find(
      (item) => Number(item.id) === Number(created.id),
    );
    expect(peerRow).toMatchObject({ canRespond: true });
  });

  it("GESTOR_PLUS sem professional_access nem manager_scope aceita a cessão visível", async () => {
    const shift = await createOccupiedShift(offerer, 7, "Clínica Médica");
    const created = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: shift.shiftId,
      fromAssignmentId: shift.assignmentId,
    });

    const available = await callerFor(plus).listAvailable({});
    const row = available.find((item) => Number(item.id) === Number(created.id));
    expect(row).toMatchObject({ canRespond: true });
    await expect(
      callerFor(plus).accept({ swapRequestId: Number(created.id) }),
    ).resolves.toEqual({ ok: true });

    await expect(
      callerFor(offerer).approveByOwner({ swapRequestId: Number(created.id) }),
    ).resolves.toEqual({ ok: true });
    const assignments = await db
      .select({
        professionalId: shiftAssignmentsV2.professionalId,
        isActive: shiftAssignmentsV2.isActive,
      })
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.shiftInstanceId, shift.shiftId));
    expect(
      assignments.some(
        (item) => item.professionalId === plus.professionalId && item.isActive,
      ),
    ).toBe(true);
  });

  it("plantonista sem professional_access não aceita a cessão", async () => {
    const outsider = await createIdentity("outsider", {
      roleInInstitution: "USER",
      medicalSpecialtyId: clinicaId,
      specialty: "Clínica Médica",
      withAccess: false,
    });
    const shift = await createOccupiedShift(offerer, 8, "Clínica Médica");
    const created = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: shift.shiftId,
      fromAssignmentId: shift.assignmentId,
    });

    await expect(
      callerFor(outsider).accept({ swapRequestId: Number(created.id) }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Profissional sem acesso ativo ao hospital/setor do plantão",
    });
  });

  it("GESTOR_MEDICO sem manager_scope nem professional_access não aceita", async () => {
    const unscope = await createIdentity("unscope", {
      roleInInstitution: "GESTOR_MEDICO",
      medicalSpecialtyId: null,
      specialty: null,
      withAccess: false,
    });
    const shift = await createOccupiedShift(offerer, 9, "Clínica Médica");
    const created = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: shift.shiftId,
      fromAssignmentId: shift.assignmentId,
    });

    const available = await callerFor(unscope).listAvailable({});
    expect(available.map((row) => Number(row.id))).not.toContain(Number(created.id));
    await expect(
      callerFor(unscope).accept({ swapRequestId: Number(created.id) }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Gestor sem jurisdição para o hospital/setor do plantão",
    });
  });

  it("grava sinal para o destinatário direcionado e para o gestor da escala", async () => {
    const shift = await createOccupiedShift(offerer, 3, "Clínica Médica");
    const created = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: shift.shiftId,
      fromAssignmentId: shift.assignmentId,
      toProfessionalId: peer.professionalId,
    });

    const rows = await db
      .select({
        userId: notifications.userId,
        title: notifications.title,
        dedupKey: notifications.dedupKey,
      })
      .from(notifications)
      .where(eq(notifications.institutionId, institutionId));

    const userIdsSignaled = rows.map((row) => row.userId).sort((a, b) => a - b);
    expect(userIdsSignaled).toEqual(
      [peer.userId, gestor.userId, plus.userId].sort((a, b) => a - b),
    );
    expect(rows.every((row) => row.title === "Oferta de plantão")).toBe(true);
    expect(rows.map((row) => row.dedupKey)).toEqual(
      expect.arrayContaining([
        `swap-offer:${created.id}:${peer.userId}`,
        `swap-offer:${created.id}:${gestor.userId}`,
        `swap-offer:${created.id}:${plus.userId}`,
      ]),
    );
    expect(rows.some((row) => row.userId === offerer.userId)).toBe(false);
  });

  it("grava sinal para o gestor quando a oferta é aberta", async () => {
    const shift = await createOccupiedShift(offerer, 4, "Clínica Médica");
    const created = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: shift.shiftId,
      fromAssignmentId: shift.assignmentId,
    });

    const rows = await db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.institutionId, institutionId),
          eq(notifications.userId, gestor.userId),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dedupKey).toBe(`swap-offer:${created.id}:${gestor.userId}`);
    expect(rows[0]?.shiftInstanceId).toBe(shift.shiftId);
  });

  it("oferta direcionada aparece na lista de quem recebeu o sinal", async () => {
    const shift = await createOccupiedShift(offerer, 10, "Clínica Médica");
    const created = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: shift.shiftId,
      fromAssignmentId: shift.assignmentId,
      toProfessionalId: peer.professionalId,
    });

    const signaled = await db
      .select({ userId: notifications.userId })
      .from(notifications)
      .where(eq(notifications.institutionId, institutionId));
    expect(signaled.map((row) => row.userId).sort((a, b) => a - b)).toEqual(
      [peer.userId, gestor.userId, plus.userId].sort((a, b) => a - b),
    );

    const peerRow = (await callerFor(peer).listAvailable({})).find(
      (item) => Number(item.id) === Number(created.id),
    );
    expect(peerRow).toMatchObject({ canRespond: true });

    const gestorRow = (await callerFor(gestor).listAvailable({})).find(
      (item) => Number(item.id) === Number(created.id),
    );
    expect(gestorRow).toMatchObject({ canRespond: false });

    const plusRow = (await callerFor(plus).listAvailable({})).find(
      (item) => Number(item.id) === Number(created.id),
    );
    expect(plusRow).toMatchObject({ canRespond: false });

    await expect(
      callerFor(gestor).accept({ swapRequestId: Number(created.id) }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Esta oferta foi direcionada a outro profissional",
    });
    await expect(
      callerFor(peer).accept({ swapRequestId: Number(created.id) }),
    ).resolves.toEqual({ ok: true });
  });

  it("A recusa cessão ABERTA e B ainda lista e aceita", async () => {
    const shift = await createOccupiedShift(offerer, 12, "Clínica Médica");
    const created = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: shift.shiftId,
      fromAssignmentId: shift.assignmentId,
    });

    await expect(
      callerFor(peer).reject({ swapRequestId: Number(created.id) }),
    ).resolves.toEqual({ ok: true });
    await expect(
      callerFor(peer).reject({ swapRequestId: Number(created.id) }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Você já recusou esta oferta.",
    });

    const [open] = await db
      .select({ status: swapRequests.status })
      .from(swapRequests)
      .where(eq(swapRequests.id, Number(created.id)))
      .limit(1);
    expect(open?.status).toBe("PENDING");
    expect(
      (await callerFor(peer).listAvailable({})).map((row) => Number(row.id)),
    ).not.toContain(Number(created.id));

    const gestorRow = (await callerFor(gestor).listAvailable({})).find(
      (item) => Number(item.id) === Number(created.id),
    );
    expect(gestorRow).toMatchObject({ canRespond: true });
    await expect(
      callerFor(gestor).accept({ swapRequestId: Number(created.id) }),
    ).resolves.toEqual({ ok: true });
  });

  it("recusar oferta direcionada fecha para o destinatário", async () => {
    const shift = await createOccupiedShift(offerer, 13, "Clínica Médica");
    const created = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: shift.shiftId,
      fromAssignmentId: shift.assignmentId,
      toProfessionalId: peer.professionalId,
    });

    await expect(
      callerFor(peer).reject({ swapRequestId: Number(created.id) }),
    ).resolves.toEqual({ ok: true });

    const [closed] = await db
      .select({ status: swapRequests.status })
      .from(swapRequests)
      .where(eq(swapRequests.id, Number(created.id)))
      .limit(1);
    expect(closed?.status).toBe("REJECTED_BY_PEER");
    expect(
      (await callerFor(peer).listAvailable({})).map((row) => Number(row.id)),
    ).not.toContain(Number(created.id));
    expect(
      (await callerFor(gestor).listAvailable({})).map((row) => Number(row.id)),
    ).not.toContain(Number(created.id));
  });

  it("GESTOR_MEDICO com manager_scope oferta o próprio plantão", async () => {
    const shift = await createOccupiedShift(gestor, 14, "Clínica Médica");
    const created = await callerFor(gestor).offer({
      type: "CESSAO",
      fromShiftInstanceId: shift.shiftId,
      fromAssignmentId: shift.assignmentId,
    });
    expect(Number(created.id)).toBeGreaterThan(0);

    const peerRow = (await callerFor(peer).listAvailable({})).find(
      (item) => Number(item.id) === Number(created.id),
    );
    expect(peerRow).toMatchObject({ canRespond: true });
  });

  it("USER e gestor sem alocação não ofertam o plantão alheio", async () => {
    const shift = await createOccupiedShift(offerer, 15, "Clínica Médica");
    await expect(
      callerFor(peer).offer({
        type: "CESSAO",
        fromShiftInstanceId: shift.shiftId,
        fromAssignmentId: shift.assignmentId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor(gestor).offer({
        type: "CESSAO",
        fromShiftInstanceId: shift.shiftId,
        fromAssignmentId: shift.assignmentId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor(plus).offer({
        type: "CESSAO",
        fromShiftInstanceId: shift.shiftId,
        fromAssignmentId: shift.assignmentId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("filterReadableSwaps só omite FORBIDDEN/NOT_FOUND", () => {
    expect(
      isExpectedSwapVisibilityDenial(
        new TRPCError({ code: "FORBIDDEN", message: "sem acesso" }),
      ),
    ).toBe(true);
    expect(
      isExpectedSwapVisibilityDenial(
        new TRPCError({ code: "NOT_FOUND", message: "sumiu" }),
      ),
    ).toBe(true);
    expect(
      isExpectedSwapVisibilityDenial(
        new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "DB unavailable",
        }),
      ),
    ).toBe(false);
    expect(
      isExpectedSwapVisibilityDenial(
        new TRPCError({
          code: "CONFLICT",
          message: "Esta oferta já foi respondida por outra pessoa.",
        }),
      ),
    ).toBe(false);
    expect(isExpectedSwapVisibilityDenial(new Error("boom"))).toBe(false);
  });
});
