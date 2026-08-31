import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { TRPCError } from "@trpc/server";
import { getDb } from "../server/db";
import { isExpectedSwapVisibilityDenial, swapRouter } from "../server/swap-router";
import { yearMonthBrt } from "../server/local-time";
import { SWAP_OFFER_PUSH_TITLE } from "../lib/swap-offer-badge-refresh";

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
    place?: { hospitalId: number; sectorId: number; scheduleContextId: number },
  ): Promise<{ shiftId: number; assignmentId: number }> {
    const startAt = at(dayOffset, 8);
    const hid = place?.hospitalId ?? hospitalId;
    const sid = place?.sectorId ?? sectorId;
    const cid = place?.scheduleContextId ?? scheduleContextId;
    await db
      .insert(monthlyRosters)
      .values({
        institutionId,
        hospitalId: hid,
        yearMonth: yearMonthBrt(startAt),
        status: "PUBLISHED",
      })
      .onDuplicateKeyUpdate({ set: { status: "PUBLISHED" } });
    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId: hid,
        sectorId: sid,
        scheduleContextId: cid,
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
        hospitalId: hid,
        sectorId: sid,
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
    const routerSource = readFileSync("server/swap-router.ts", "utf8");
    const offerSource = readFileSync("server/swap-offer-create.ts", "utf8");
    const offerDomain = readFileSync("server/swap-domain.ts", "utf8");
    expect(routerSource).toContain("createSwapOffer");
    expect(offerSource).toContain("enqueueSwapOfferSignals");
    expect(routerSource).toContain("enqueueSwapTakenSignals");
    expect(routerSource).toContain("applySwapAssignmentTransfer");
    const listAvailable = routerSource.slice(
      routerSource.indexOf("async function queryListAvailableRows"),
      routerSource.indexOf("async function countActionableSwapOffers"),
    );
    expect(listAvailable).toContain("manager_scope");
    expect(listAvailable).toContain("GESTOR_PLUS");
    expect(listAvailable).toContain(
      "ap.medical_specialty_id = aq.medical_specialty_id",
    );
    expect(listAvailable).not.toContain(
      "AND fp.medical_specialty_id = aq.medical_specialty_id",
    );
    const receive = offerDomain.slice(
      offerDomain.indexOf("export async function requireProfessionalCanReceiveShift"),
      offerDomain.indexOf("export async function requireCanonicalShiftOccupant"),
    );
    expect(receive).toContain("findManagerScopeId");
    expect(receive).toContain("GESTOR_PLUS");
    expect(receive).toContain("assertProfessionalQualifiedForShift");
    const signal = readFileSync("server/swap-offer-signal.ts", "utf8");
    expect(signal).toContain("SIGNAL_TRACKING_FAILED");
    expect(signal).toContain("throw error");
    expect(signal).toContain("eligibleRecipientUserIdsForSwapOffer");
    expect(signal).not.toContain("listScaleManagerUserIds");
    expect(listAvailable).toContain("actor_directed_scope");
    expect(listAvailable).toContain("canRespond");
    expect(listAvailable).toContain("swap_request_dismissals");
    expect(listAvailable).toContain("source_scope");
    const sourceTuple = offerDomain.slice(
      offerDomain.indexOf("export async function requireCanonicalAssignmentTuple"),
      offerDomain.indexOf("export async function requireProfessionalCanReceiveShift"),
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
    expect(accepted?.status).toBe("APPROVED");
    expect(accepted?.toProfessionalId).toBe(gestor.professionalId);
    expect(accepted?.toUserId).toBe(gestor.userId);

    const ownerRows = await callerFor(offerer).list({ role: "OFFERER" });
    expect(
      ownerRows.find((row) => Number(row.id) === Number(created.id))
        ?.awaitingMyApproval,
    ).toBe(false);

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

  async function listOfferSignals() {
    return db
      .select({
        userId: notifications.userId,
        title: notifications.title,
        body: notifications.body,
        dedupKey: notifications.dedupKey,
        shiftInstanceId: notifications.shiftInstanceId,
      })
      .from(notifications)
      .where(eq(notifications.institutionId, institutionId));
  }

  it("oferta direcionada notifica só o alvo elegível, não gestores", async () => {
    const shift = await createOccupiedShift(offerer, 3, "Clínica Médica");
    const created = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: shift.shiftId,
      fromAssignmentId: shift.assignmentId,
      toProfessionalId: peer.professionalId,
    });

    const rows = await listOfferSignals();
    expect(rows.map((row) => row.userId)).toEqual([peer.userId]);
    expect(rows[0]?.title).toBe(SWAP_OFFER_PUSH_TITLE);
    expect(rows[0]?.body).not.toContain(offerer.name);
    expect(rows[0]?.dedupKey).toBe(`swap-offer:${created.id}:${peer.userId}`);
    expect(rows[0]?.shiftInstanceId).toBe(shift.shiftId);
    expect(rows.some((row) => row.userId === gestor.userId)).toBe(false);
    expect(rows.some((row) => row.userId === plus.userId)).toBe(false);
    expect(rows.some((row) => row.userId === offerer.userId)).toBe(false);
  });

  it("oferta aberta notifica médicos elegíveis e não o gestor só pelo papel", async () => {
    const shift = await createOccupiedShift(offerer, 4, "Clínica Médica");
    const created = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: shift.shiftId,
      fromAssignmentId: shift.assignmentId,
    });

    const rows = await listOfferSignals();
    expect(rows.map((row) => row.userId)).toEqual([peer.userId]);
    expect(rows[0]?.title).toBe(SWAP_OFFER_PUSH_TITLE);
    expect(rows[0]?.dedupKey).toBe(`swap-offer:${created.id}:${peer.userId}`);
    expect(
      rows.filter((row) => row.userId === gestor.userId || row.userId === plus.userId),
    ).toHaveLength(0);
    expect(rows.some((row) => row.userId === offerer.userId)).toBe(false);
    await expect(callerFor(peer).countActionable()).resolves.toEqual({
      swapOffers: 1,
    });
    await expect(callerFor(gestor).countActionable()).resolves.toEqual({
      swapOffers: 1,
    });
  });

  it("oferta direcionada aparece na lista de quem recebeu o sinal", async () => {
    const shift = await createOccupiedShift(offerer, 10, "Clínica Médica");
    const created = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: shift.shiftId,
      fromAssignmentId: shift.assignmentId,
      toProfessionalId: peer.professionalId,
    });

    const signaled = await listOfferSignals();
    expect(signaled.map((row) => row.userId)).toEqual([peer.userId]);

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

  it("countActionable do gestor conta só peer acionável resolvível em Solicitações", async () => {
    const openShift = await createOccupiedShift(offerer, 20, "Clínica Médica");
    const openOffer = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: openShift.shiftId,
      fromAssignmentId: openShift.assignmentId,
    });

    const directedShift = await createOccupiedShift(offerer, 21, "Clínica Médica");
    await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: directedShift.shiftId,
      fromAssignmentId: directedShift.assignmentId,
      toProfessionalId: peer.professionalId,
    });

    await expect(callerFor(gestor).countActionable()).resolves.toEqual({
      swapOffers: 1,
    });
    await expect(callerFor(peer).countActionable()).resolves.toEqual({
      swapOffers: 2,
    });

    const gestorRows = await callerFor(gestor).listAvailable({});
    const gestorOpen = gestorRows.find(
      (item) => Number(item.id) === Number(openOffer.id),
    );
    expect(gestorOpen).toMatchObject({ canRespond: true });
    expect(
      gestorRows.filter((row) => row.canRespond).length,
    ).toBe(1);

    await expect(
      callerFor(gestor).accept({ swapRequestId: Number(openOffer.id) }),
    ).resolves.toEqual({ ok: true });
    await expect(callerFor(gestor).countActionable()).resolves.toEqual({
      swapOffers: 0,
    });
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

  it("plantonista inelegível e de outro setor não recebem sinal", async () => {
    const ineligible = await createIdentity("no-access", {
      roleInInstitution: "USER",
      medicalSpecialtyId: clinicaId,
      specialty: "Clínica Médica",
      withAccess: false,
    });
    const [otherSector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `Outro setor ${stamp}`,
        category: "cirurgico",
        color: "#654321",
      })
      .$returningId();
    const otherSectorPeer = await createIdentity("other-sector", {
      roleInInstitution: "USER",
      medicalSpecialtyId: anesthesiaId,
      specialty: "Anestesiologia",
      withAccess: false,
    });
    await db.insert(professionalAccess).values({
      institutionId,
      professionalId: otherSectorPeer.professionalId,
      hospitalId,
      sectorId: otherSector.id,
      canAccess: true,
    });
    try {
      const shift = await createOccupiedShift(offerer, 30, "Clínica Médica");
      await callerFor(offerer).offer({
        type: "CESSAO",
        fromShiftInstanceId: shift.shiftId,
        fromAssignmentId: shift.assignmentId,
      });
      const signaled = (await listOfferSignals()).map((row) => row.userId);
      expect(signaled).toEqual([peer.userId]);
      expect(signaled).not.toContain(ineligible.userId);
      expect(signaled).not.toContain(otherSectorPeer.userId);
    } finally {
      await db
        .delete(professionalAccess)
        .where(eq(professionalAccess.sectorId, otherSector.id));
      await db.delete(sectors).where(eq(sectors.id, otherSector.id));
    }
  });

  it("outro tenant nunca recebe o sinal", async () => {
    const [otherInstitution] = await db
      .insert(institutions)
      .values({
        name: `Offer Signal Other ${stamp}`,
        cnpj: String(stamp + 1).slice(-14).padStart(14, "7"),
        legalName: `Offer Signal Other ${stamp}`,
        tradeName: `OX${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    const [otherHospital] = await db
      .insert(hospitals)
      .values({ institutionId: otherInstitution.id, name: `Other H ${stamp}` })
      .$returningId();
    const [otherSector] = await db
      .insert(sectors)
      .values({
        institutionId: otherInstitution.id,
        hospitalId: otherHospital.id,
        name: `Other S ${stamp}`,
        category: "cirurgico",
        color: "#000000",
      })
      .$returningId();
    const name = `offer-signal-${stamp}-foreign`;
    const [foreignUser] = await db
      .insert(users)
      .values({
        name,
        email: `${name}@example.test`,
        passwordHash: "not-used",
        role: "doctor",
        approvalStatus: "APPROVED",
        sessionVersion: 1,
      })
      .$returningId();
    userIds.push(foreignUser.id);
    const [foreignProfessional] = await db
      .insert(professionals)
      .values({
        userId: foreignUser.id,
        name,
        role: "Médico",
        specialty: "Anestesiologia",
        medicalSpecialtyId: anesthesiaId,
        userRole: "USER",
      })
      .$returningId();
    professionalIds.push(foreignProfessional.id);
    await db.insert(professionalInstitutions).values({
      professionalId: foreignProfessional.id,
      userId: foreignUser.id,
      institutionId: otherInstitution.id,
      roleInInstitution: "USER",
      active: true,
    });
    await db.insert(professionalAccess).values({
      institutionId: otherInstitution.id,
      professionalId: foreignProfessional.id,
      hospitalId: otherHospital.id,
      sectorId: otherSector.id,
      canAccess: true,
    });
    try {
      const shift = await createOccupiedShift(offerer, 31, "Clínica Médica");
      await callerFor(offerer).offer({
        type: "CESSAO",
        fromShiftInstanceId: shift.shiftId,
        fromAssignmentId: shift.assignmentId,
      });
      const local = await listOfferSignals();
      expect(local.map((row) => row.userId)).toEqual([peer.userId]);
      expect(local.some((row) => row.userId === foreignUser.id)).toBe(false);
      const foreign = await db
        .select({ userId: notifications.userId })
        .from(notifications)
        .where(eq(notifications.institutionId, otherInstitution.id));
      expect(foreign).toHaveLength(0);
    } finally {
      await db
        .delete(professionalAccess)
        .where(eq(professionalAccess.institutionId, otherInstitution.id));
      await db
        .delete(professionalInstitutions)
        .where(eq(professionalInstitutions.institutionId, otherInstitution.id));
      await db.delete(sectors).where(eq(sectors.id, otherSector.id));
      await db.delete(hospitals).where(eq(hospitals.id, otherHospital.id));
      await db.delete(institutions).where(eq(institutions.id, otherInstitution.id));
    }
  });

  it("gestor que também é médico elegível recebe o sinal como plantonista", async () => {
    const gestorPeer = await createIdentity("gestor-peer", {
      roleInInstitution: "GESTOR_MEDICO",
      medicalSpecialtyId: anesthesiaId,
      specialty: "Anestesiologia",
    });
    await db.insert(managerScope).values({
      institutionId,
      managerProfessionalId: gestorPeer.professionalId,
      hospitalId,
      sectorId,
      active: true,
    });
    const shift = await createOccupiedShift(offerer, 32, "Clínica Médica");
    const created = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: shift.shiftId,
      fromAssignmentId: shift.assignmentId,
    });
    const signaled = (await listOfferSignals()).map((row) => row.userId).sort((a, b) => a - b);
    expect(signaled).toEqual([peer.userId, gestorPeer.userId].sort((a, b) => a - b));
    expect(signaled).not.toContain(gestor.userId);
    expect(signaled).not.toContain(plus.userId);
    expect(
      (await listOfferSignals()).map((row) => row.dedupKey),
    ).toEqual(
      expect.arrayContaining([
        `swap-offer:${created.id}:${peer.userId}`,
        `swap-offer:${created.id}:${gestorPeer.userId}`,
      ]),
    );
  });

  it("aceitar oferta reduz countActionable do colega e oferta expirada não conta", async () => {
    const openShift = await createOccupiedShift(offerer, 33, "Clínica Médica");
    const openOffer = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: openShift.shiftId,
      fromAssignmentId: openShift.assignmentId,
    });
    const expiredShift = await createOccupiedShift(offerer, 34, "Clínica Médica");
    const expiredOffer = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: expiredShift.shiftId,
      fromAssignmentId: expiredShift.assignmentId,
    });
    await db
      .update(swapRequests)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(swapRequests.id, Number(expiredOffer.id)));

    await expect(callerFor(peer).countActionable()).resolves.toEqual({
      swapOffers: 1,
    });
    await expect(
      callerFor(peer).accept({ swapRequestId: Number(openOffer.id) }),
    ).resolves.toEqual({ ok: true });
    await expect(callerFor(peer).countActionable()).resolves.toEqual({
      swapOffers: 0,
    });
  });

  it("oferta direcionada a gestor inelegível não gera sinal (fail-closed)", async () => {
    const shift = await createOccupiedShift(offerer, 35, "Clínica Médica");
    const created = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: shift.shiftId,
      fromAssignmentId: shift.assignmentId,
      toProfessionalId: gestor.professionalId,
    });
    expect(Number(created.id)).toBeGreaterThan(0);
    const rows = await listOfferSignals();
    expect(rows).toHaveLength(0);
    const gestorRow = (await callerFor(gestor).listAvailable({})).find(
      (item) => Number(item.id) === Number(created.id),
    );
    expect(gestorRow).toMatchObject({ canRespond: true });
  });

  it("quem recebe o sinal vê a oferta com canRespond; gestor puro vê mas não recebe", async () => {
    const shift = await createOccupiedShift(offerer, 36, "Clínica Médica");
    const created = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: shift.shiftId,
      fromAssignmentId: shift.assignmentId,
    });
    const signaled = new Set((await listOfferSignals()).map((row) => row.userId));
    const peerRow = (await callerFor(peer).listAvailable({})).find(
      (item) => Number(item.id) === Number(created.id),
    );
    expect(peerRow).toMatchObject({ canRespond: true });
    expect(signaled.has(peer.userId)).toBe(true);
    const gestorRow = (await callerFor(gestor).listAvailable({})).find(
      (item) => Number(item.id) === Number(created.id),
    );
    expect(gestorRow).toMatchObject({ canRespond: true });
    expect(signaled.has(gestor.userId)).toBe(false);
    expect(signaled.has(plus.userId)).toBe(false);
    expect(signaled.has(offerer.userId)).toBe(false);
  });

  it("acesso hospital-wide cobre legado ALL_CFM e não cobre allowlist; outro hospital não recebe", async () => {
    const [legacySector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `Legado ${stamp}`,
        category: "servico",
        color: "#abcdef",
      })
      .$returningId();
    const legacyContextId = await openTestScale(db, {
      institutionId,
      hospitalId,
      sectorId: legacySector.id,
    });
    const [otherHospital] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Other Hospital ${stamp}` })
      .$returningId();
    const [otherHospitalSector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId: otherHospital.id,
        name: `OH S ${stamp}`,
        category: "cirurgico",
        color: "#111111",
      })
      .$returningId();
    const widePeer = await createIdentity("wide-peer", {
      roleInInstitution: "USER",
      medicalSpecialtyId: anesthesiaId,
      specialty: "Anestesiologia",
      withAccess: false,
    });
    await db.insert(professionalAccess).values({
      institutionId,
      professionalId: widePeer.professionalId,
      hospitalId,
      sectorId: null,
      canAccess: true,
    });
    const otherHospitalPeer = await createIdentity("other-hospital", {
      roleInInstitution: "USER",
      medicalSpecialtyId: anesthesiaId,
      specialty: "Anestesiologia",
      withAccess: false,
    });
    await db.insert(professionalAccess).values({
      institutionId,
      professionalId: otherHospitalPeer.professionalId,
      hospitalId: otherHospital.id,
      sectorId: otherHospitalSector.id,
      canAccess: true,
    });
    await db.insert(professionalAccess).values({
      institutionId,
      professionalId: offerer.professionalId,
      hospitalId,
      sectorId: legacySector.id,
      canAccess: true,
    });
    try {
      const allowlistShift = await createOccupiedShift(offerer, 37, "Clínica Médica");
      await callerFor(offerer).offer({
        type: "CESSAO",
        fromShiftInstanceId: allowlistShift.shiftId,
        fromAssignmentId: allowlistShift.assignmentId,
      });
      const allowlistSignaled = (await listOfferSignals()).map((row) => row.userId);
      expect(allowlistSignaled).toContain(peer.userId);
      expect(allowlistSignaled).not.toContain(widePeer.userId);
      expect(allowlistSignaled).not.toContain(otherHospitalPeer.userId);

      await db.delete(notifications).where(eq(notifications.institutionId, institutionId));
      const legacyShift = await createOccupiedShift(offerer, 38, "", {
        hospitalId,
        sectorId: legacySector.id,
        scheduleContextId: legacyContextId,
      });
      await callerFor(offerer).offer({
        type: "CESSAO",
        fromShiftInstanceId: legacyShift.shiftId,
        fromAssignmentId: legacyShift.assignmentId,
      });
      const legacySignaled = (await listOfferSignals()).map((row) => row.userId);
      expect(legacySignaled).toContain(widePeer.userId);
      expect(legacySignaled).not.toContain(peer.userId);
      expect(legacySignaled).not.toContain(otherHospitalPeer.userId);
    } finally {
      await db.delete(notifications).where(eq(notifications.institutionId, institutionId));
      await db
        .delete(swapRequests)
        .where(eq(swapRequests.institutionId, institutionId));
      await db
        .delete(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.sectorId, legacySector.id));
      await db
        .delete(shiftInstances)
        .where(eq(shiftInstances.sectorId, legacySector.id));
      await db
        .delete(monthlyRosters)
        .where(eq(monthlyRosters.hospitalId, otherHospital.id));
      await db
        .delete(professionalAccess)
        .where(eq(professionalAccess.sectorId, legacySector.id));
      await db
        .delete(professionalAccess)
        .where(eq(professionalAccess.hospitalId, otherHospital.id));
      await db
        .delete(professionalAccess)
        .where(eq(professionalAccess.professionalId, widePeer.professionalId));
      await db.delete(scheduleContexts).where(eq(scheduleContexts.id, legacyContextId));
      await db.delete(sectors).where(eq(sectors.id, legacySector.id));
      await db.delete(sectors).where(eq(sectors.id, otherHospitalSector.id));
      await db.delete(hospitals).where(eq(hospitals.id, otherHospital.id));
    }
  });
});
