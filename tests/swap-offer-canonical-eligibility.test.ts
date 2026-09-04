import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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
import { eligibleRecipientUserIdsForSwapOffer } from "../server/swap-offer-eligibility";
import { swapRouter } from "../server/swap-router";
import { yearMonthBrt } from "../server/local-time";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Identity = {
  userId: number;
  professionalId: number;
  name: string;
  role: "doctor" | "manager";
};

describe("elegibilidade canônica de oferta de plantão", () => {
  let db: Db;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let scheduleContextId: number;
  let anesthesiaId: number;
  let clinicaId: number;
  let offerer: Identity;
  let peer: Identity;
  let ineligible: Identity;
  let gestorClinician: Identity;
  let plusClinician: Identity;
  let gestorAdmin: Identity;
  let plusAdmin: Identity;
  const userIds: number[] = [];
  const professionalIds: number[] = [];
  const stamp = Date.now();

  const at = (dayOffset: number, hour: number): Date => {
    const value = new Date();
    value.setUTCDate(value.getUTCDate() + 600 + dayOffset);
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
    const name = `canon-elig-${stamp}-${label}`;
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

  function callerFor(identity: Identity, tenantId = institutionId) {
    return swapRouter.createCaller({
      user: {
        id: identity.userId,
        role: identity.role,
        name: identity.name,
        email: `${identity.name}@example.test`,
        sessionVersion: 1,
      },
      institutionId: tenantId,
      allowedInstitutionIds: [tenantId],
    } as never);
  }

  async function createOccupiedShift(
    owner: Identity,
    dayOffset: number,
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
        label: `canon-elig-${stamp}-shift-${dayOffset}`,
        specialty: "Clínica Médica",
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

  async function offerCessao(
    owner: Identity,
    dayOffset: number,
    toProfessionalId?: number,
  ) {
    const shift = await createOccupiedShift(owner, dayOffset);
    const created = await callerFor(owner).offer({
      type: "CESSAO",
      fromShiftInstanceId: shift.shiftId,
      fromAssignmentId: shift.assignmentId,
      toProfessionalId,
    });
    return { ...shift, offerId: Number(created.id) };
  }

  async function rowFor(identity: Identity, offerId: number) {
    const rows = await callerFor(identity).listAvailable({});
    return rows.find((item) => Number(item.id) === offerId);
  }

  async function signaledUserIds() {
    const rows = await db
      .select({ userId: notifications.userId })
      .from(notifications)
      .where(eq(notifications.institutionId, institutionId));
    return rows.map((row) => row.userId);
  }

  beforeAll(async () => {
    const connection = await getDb();
    if (!connection) throw new Error("Database not available");
    db = connection;

    const [institution] = await db
      .insert(institutions)
      .values({
        name: `Canon Elig ${stamp}`,
        cnpj: String(stamp).slice(-14).padStart(14, "7"),
        legalName: `Canon Elig ${stamp}`,
        tradeName: `CE${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = institution.id;
    const [hospital] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Canon Elig Hospital ${stamp}` })
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
        code: `CANON_ELIG_CLINICA_${stamp}`,
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
    ineligible = await createIdentity("ineligible", {
      roleInInstitution: "USER",
      medicalSpecialtyId: clinicaId,
      specialty: "Clínica Médica",
      withAccess: false,
    });
    gestorClinician = await createIdentity("gestor-clinician", {
      roleInInstitution: "GESTOR_MEDICO",
      medicalSpecialtyId: anesthesiaId,
      specialty: "Anestesiologia",
    });
    await db.insert(managerScope).values({
      institutionId,
      managerProfessionalId: gestorClinician.professionalId,
      hospitalId,
      sectorId,
      active: true,
    });
    plusClinician = await createIdentity("plus-clinician", {
      roleInInstitution: "GESTOR_PLUS",
      medicalSpecialtyId: clinicaId,
      specialty: "Clínica Médica",
    });
    gestorAdmin = await createIdentity("gestor-admin", {
      roleInInstitution: "GESTOR_MEDICO",
      medicalSpecialtyId: null,
      specialty: null,
      withAccess: false,
    });
    await db.insert(managerScope).values({
      institutionId,
      managerProfessionalId: gestorAdmin.professionalId,
      hospitalId,
      sectorId,
      active: true,
    });
    plusAdmin = await createIdentity("plus-admin", {
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

  it("fonte: receber plantão não usa atalho gerencial; list/push compartilham SQL clínico", () => {
    const receive = readFileSync("server/swap-domain.ts", "utf8");
    const receiveSlice = receive.slice(
      receive.indexOf("export async function requireProfessionalCanReceiveShift"),
      receive.indexOf("export async function requireCanonicalShiftOccupant"),
    );
    expect(receiveSlice).toContain("findProfessionalAccessId");
    expect(receiveSlice).toContain("assertProfessionalQualifiedForShift");
    expect(receiveSlice).not.toContain("findManagerScopeId");
    expect(receiveSlice).not.toContain("GESTOR_PLUS");

    const list = readFileSync("server/swap-router.ts", "utf8");
    const listSlice = list.slice(
      list.indexOf("async function queryListAvailableRows"),
      list.indexOf("async function countActionableSwapOffers"),
    );
    const eligibility = readFileSync("server/swap-offer-eligibility.ts", "utf8");
    const helper = readFileSync("server/plantonista-shift-eligibility.ts", "utf8");
    expect(helper).toContain("export function actorClinicallyCoversOfferedShiftSql");
    expect(listSlice).toContain("actorClinicallyCoversOfferedShiftSql");
    expect(listSlice).toContain("listedOfferIsClinicallyActionable");
    expect(eligibility).toContain("actorClinicallyCoversOfferedShiftSql");
    expect(eligibility).not.toContain("api.role_in_institution = 'GESTOR_PLUS'");
  });

  it("1. USER elegível + aberta → lista, canRespond e push", async () => {
    const { offerId } = await offerCessao(offerer, 1);
    const row = await rowFor(peer, offerId);
    expect(row).toMatchObject({ canRespond: true });
    expect(await signaledUserIds()).toContain(peer.userId);
    await expect(callerFor(peer).countActionable()).resolves.toEqual({
      swapOffers: 1,
    });
    await expect(
      callerFor(peer).accept({ swapRequestId: offerId }),
    ).resolves.toEqual({ ok: true });
  });

  it("2. USER inelegível → nenhum", async () => {
    const { offerId } = await offerCessao(offerer, 2);
    expect(await rowFor(ineligible, offerId)).toBeUndefined();
    expect(await signaledUserIds()).not.toContain(ineligible.userId);
    await expect(callerFor(ineligible).countActionable()).resolves.toEqual({
      swapOffers: 0,
    });
    await expect(
      callerFor(ineligible).accept({ swapRequestId: offerId }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Profissional sem acesso ativo ao hospital/setor do plantão",
    });
  });

  it("3. GESTOR_MEDICO elegível → lista, canRespond e push", async () => {
    const { offerId } = await offerCessao(offerer, 3);
    expect(await rowFor(gestorClinician, offerId)).toMatchObject({
      canRespond: true,
    });
    expect(await signaledUserIds()).toContain(gestorClinician.userId);
  });

  it("4. GESTOR_PLUS elegível → lista, canRespond e push", async () => {
    const { offerId } = await offerCessao(offerer, 4);
    expect(await rowFor(plusClinician, offerId)).toMatchObject({
      canRespond: true,
    });
    expect(await signaledUserIds()).toContain(plusClinician.userId);
  });

  it("5. gestor só manager_scope vê para supervisão, sem responder nem push", async () => {
    const { offerId } = await offerCessao(offerer, 5);
    expect(await rowFor(gestorAdmin, offerId)).toMatchObject({
      canRespond: false,
    });
    expect(await rowFor(plusAdmin, offerId)).toMatchObject({
      canRespond: false,
    });
    const signaled = await signaledUserIds();
    expect(signaled).not.toContain(gestorAdmin.userId);
    expect(signaled).not.toContain(plusAdmin.userId);
    await expect(callerFor(gestorAdmin).countActionable()).resolves.toEqual({
      swapOffers: 0,
    });
    await expect(
      callerFor(gestorAdmin).accept({ swapRequestId: offerId }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Profissional sem acesso ativo ao hospital/setor do plantão",
    });
  });

  it("6. gestor de outro setor não recebe push", async () => {
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
    const otherGestor = await createIdentity("other-sector-gestor", {
      roleInInstitution: "GESTOR_MEDICO",
      medicalSpecialtyId: null,
      specialty: null,
      withAccess: false,
    });
    await db.insert(managerScope).values({
      institutionId,
      managerProfessionalId: otherGestor.professionalId,
      hospitalId,
      sectorId: otherSector.id,
      active: true,
    });
    try {
      const { offerId } = await offerCessao(offerer, 6);
      expect(await rowFor(otherGestor, offerId)).toBeUndefined();
      expect(await signaledUserIds()).not.toContain(otherGestor.userId);
    } finally {
      await db
        .delete(managerScope)
        .where(eq(managerScope.managerProfessionalId, otherGestor.professionalId));
      await db.delete(sectors).where(eq(sectors.id, otherSector.id));
    }
  });

  it("7. mesmo nome de setor em outro tenant não vaza", async () => {
    const [otherInstitution] = await db
      .insert(institutions)
      .values({
        name: `Canon Elig B ${stamp}`,
        cnpj: String(stamp + 1).slice(-14).padStart(14, "6"),
        legalName: `Canon Elig B ${stamp}`,
        tradeName: `CB${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    const [otherHospital] = await db
      .insert(hospitals)
      .values({
        institutionId: otherInstitution.id,
        name: `Canon Elig Hospital ${stamp}`,
      })
      .$returningId();
    const [otherSector] = await db
      .insert(sectors)
      .values({
        institutionId: otherInstitution.id,
        hospitalId: otherHospital.id,
        name: `Sala de Recuperação ${stamp}`,
        category: "cirurgico",
        color: "#123456",
      })
      .$returningId();
    const name = `canon-elig-${stamp}-foreign-gestor`;
    const [foreignUser] = await db
      .insert(users)
      .values({
        name,
        email: `${name}@example.test`,
        passwordHash: "not-used",
        role: "manager",
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
        specialty: null,
        medicalSpecialtyId: null,
        userRole: "GESTOR_PLUS",
      })
      .$returningId();
    professionalIds.push(foreignProfessional.id);
    await db.insert(professionalInstitutions).values({
      professionalId: foreignProfessional.id,
      userId: foreignUser.id,
      institutionId: otherInstitution.id,
      roleInInstitution: "GESTOR_PLUS",
      active: true,
    });
    try {
      await offerCessao(offerer, 7);
      const local = await signaledUserIds();
      expect(local).not.toContain(foreignUser.id);
      const foreign = await db
        .select({ userId: notifications.userId })
        .from(notifications)
        .where(eq(notifications.institutionId, otherInstitution.id));
      expect(foreign).toHaveLength(0);
      const directed = await createOccupiedShift(offerer, 71);
      await expect(
        callerFor(offerer).offer({
          type: "CESSAO",
          fromShiftInstanceId: directed.shiftId,
          fromAssignmentId: directed.assignmentId,
          toProfessionalId: foreignProfessional.id,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await db
        .delete(professionalInstitutions)
        .where(eq(professionalInstitutions.institutionId, otherInstitution.id));
      await db.delete(sectors).where(eq(sectors.id, otherSector.id));
      await db.delete(hospitals).where(eq(hospitals.id, otherHospital.id));
      await db.delete(institutions).where(eq(institutions.id, otherInstitution.id));
    }
  });

  it("8–9. dirigida para B: só B responde e recebe; terceiro elegível não", async () => {
    const { offerId } = await offerCessao(offerer, 8, peer.professionalId);
    expect(await rowFor(peer, offerId)).toMatchObject({ canRespond: true });
    expect(await rowFor(gestorClinician, offerId)).toMatchObject({
      canRespond: false,
    });
    expect(await rowFor(plusClinician, offerId)).toMatchObject({
      canRespond: false,
    });
    expect(await signaledUserIds()).toEqual([peer.userId]);
    await expect(
      callerFor(gestorClinician).accept({ swapRequestId: offerId }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Esta oferta foi direcionada a outro profissional",
    });
  });

  it("10. ofertante nunca recebe a própria oferta", async () => {
    const { offerId } = await offerCessao(offerer, 10);
    expect(
      (await callerFor(offerer).listAvailable({})).map((row) => Number(row.id)),
    ).not.toContain(offerId);
    expect(await signaledUserIds()).not.toContain(offerer.userId);
  });

  it("11. conflito temporal impede resposta e push", async () => {
    const busy = await createIdentity("busy", {
      roleInInstitution: "USER",
      medicalSpecialtyId: clinicaId,
      specialty: "Clínica Médica",
    });
    await createOccupiedShift(busy, 11);
    const { offerId } = await offerCessao(offerer, 11);
    expect(await rowFor(busy, offerId)).toBeUndefined();
    expect(await signaledUserIds()).not.toContain(busy.userId);
    await expect(
      callerFor(busy).accept({ swapRequestId: offerId }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await db
      .update(professionalAccess)
      .set({ canAccess: false })
      .where(eq(professionalAccess.professionalId, busy.professionalId));
  });

  it("12–13. hospital-wide não cobre allowlist; cobre legado ALL_CFM", async () => {
    const [allowSector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `Allow ${stamp}`,
        category: "servico",
        color: "#aaaaaa",
      })
      .$returningId();
    const allowContextId = await openTestScale(db, {
      institutionId,
      hospitalId,
      sectorId: allowSector.id,
    });
    await db
      .update(scheduleContexts)
      .set({
        admissionPolicy: "QUALIFICATION_ALLOWLIST",
        medicalSpecialtyId: null,
        operationalProfileCode: null,
      })
      .where(eq(scheduleContexts.id, allowContextId));
    await db.insert(scheduleContextAllowedQualifications).values({
      scheduleContextId: allowContextId,
      medicalSpecialtyId: clinicaId,
    });
    const [legacySector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `Legado ${stamp}`,
        category: "servico",
        color: "#bbbbbb",
      })
      .$returningId();
    const legacyContextId = await openTestScale(db, {
      institutionId,
      hospitalId,
      sectorId: legacySector.id,
    });
    const wide = await createIdentity("wide", {
      roleInInstitution: "USER",
      medicalSpecialtyId: clinicaId,
      specialty: "Clínica Médica",
      withAccess: false,
    });
    await db.insert(professionalAccess).values({
      institutionId,
      professionalId: wide.professionalId,
      hospitalId,
      sectorId: null,
      canAccess: true,
    });
    await db.insert(professionalAccess).values([
      {
        institutionId,
        professionalId: offerer.professionalId,
        hospitalId,
        sectorId: allowSector.id,
        canAccess: true,
      },
      {
        institutionId,
        professionalId: offerer.professionalId,
        hospitalId,
        sectorId: legacySector.id,
        canAccess: true,
      },
    ]);
    try {
      const allowShift = await createOccupiedShift(offerer, 12, {
        hospitalId,
        sectorId: allowSector.id,
        scheduleContextId: allowContextId,
      });
      await callerFor(offerer).offer({
        type: "CESSAO",
        fromShiftInstanceId: allowShift.shiftId,
        fromAssignmentId: allowShift.assignmentId,
      });
      expect(await signaledUserIds()).not.toContain(wide.userId);

      await db.delete(notifications).where(eq(notifications.institutionId, institutionId));
      const legacyShift = await createOccupiedShift(offerer, 13, {
        hospitalId,
        sectorId: legacySector.id,
        scheduleContextId: legacyContextId,
      });
      await callerFor(offerer).offer({
        type: "CESSAO",
        fromShiftInstanceId: legacyShift.shiftId,
        fromAssignmentId: legacyShift.assignmentId,
      });
      expect(await signaledUserIds()).toContain(wide.userId);
    } finally {
      await db.delete(notifications).where(eq(notifications.institutionId, institutionId));
      await db.delete(swapRequests).where(eq(swapRequests.institutionId, institutionId));
      await db
        .delete(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.sectorId, allowSector.id));
      await db
        .delete(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.sectorId, legacySector.id));
      await db.delete(shiftInstances).where(eq(shiftInstances.sectorId, allowSector.id));
      await db.delete(shiftInstances).where(eq(shiftInstances.sectorId, legacySector.id));
      await db
        .delete(scheduleContextAllowedQualifications)
        .where(
          eq(
            scheduleContextAllowedQualifications.scheduleContextId,
            allowContextId,
          ),
        );
      await db
        .delete(professionalAccess)
        .where(eq(professionalAccess.professionalId, wide.professionalId));
      await db
        .delete(professionalAccess)
        .where(eq(professionalAccess.sectorId, allowSector.id));
      await db
        .delete(professionalAccess)
        .where(eq(professionalAccess.sectorId, legacySector.id));
      await db.delete(scheduleContexts).where(eq(scheduleContexts.id, allowContextId));
      await db.delete(scheduleContexts).where(eq(scheduleContexts.id, legacyContextId));
      await db.delete(sectors).where(eq(sectors.id, allowSector.id));
      await db.delete(sectors).where(eq(sectors.id, legacySector.id));
    }
  });

  it("14. oferta expirada não aparece para ninguém", async () => {
    const { offerId } = await offerCessao(offerer, 14);
    await db
      .update(swapRequests)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(swapRequests.id, offerId));
    expect(await rowFor(peer, offerId)).toBeUndefined();
    expect(await rowFor(gestorAdmin, offerId)).toBeUndefined();
    const recipients = await eligibleRecipientUserIdsForSwapOffer(db, {
      id: offerId,
      fromUserId: offerer.userId,
      toUserId: null,
      toProfessionalId: null,
      institutionId,
    });
    expect(recipients).toEqual([]);
  });

  it("15. plantão já iniciado não aparece para ninguém", async () => {
    const { offerId, shiftId } = await offerCessao(offerer, 15);
    await db
      .update(shiftInstances)
      .set({
        startAt: new Date(Date.now() - 3_600_000),
        endAt: new Date(Date.now() + 3_600_000),
      })
      .where(eq(shiftInstances.id, shiftId));
    expect(await rowFor(peer, offerId)).toBeUndefined();
    const recipients = await eligibleRecipientUserIdsForSwapOffer(db, {
      id: offerId,
      fromUserId: offerer.userId,
      toUserId: null,
      toProfessionalId: null,
      institutionId,
    });
    expect(recipients).toEqual([]);
  });

  it("16. assignment source inválida some da lista e do push", async () => {
    const { offerId, assignmentId } = await offerCessao(offerer, 16);
    await db
      .update(shiftAssignmentsV2)
      .set({ isActive: false })
      .where(eq(shiftAssignmentsV2.id, assignmentId));
    expect(await rowFor(peer, offerId)).toBeUndefined();
    const recipients = await eligibleRecipientUserIdsForSwapOffer(db, {
      id: offerId,
      fromUserId: offerer.userId,
      toUserId: null,
      toProfessionalId: null,
      institutionId,
    });
    expect(recipients).toEqual([]);
  });

  it("17–18. canRespond, push e badge têm a mesma audiência operacional", async () => {
    const { offerId } = await offerCessao(offerer, 17);
    const actors = [
      peer,
      gestorClinician,
      plusClinician,
      gestorAdmin,
      plusAdmin,
      ineligible,
      offerer,
    ];
    const canRespondIds = new Set<number>();
    for (const actor of actors) {
      const row = await rowFor(actor, offerId);
      const badge = await callerFor(actor).countActionable();
      if (actor === offerer || actor === ineligible) {
        expect(row).toBeUndefined();
        expect(badge.swapOffers).toBe(0);
        continue;
      }
      expect(row).toBeDefined();
      if (row?.canRespond) {
        canRespondIds.add(actor.userId);
        expect(badge.swapOffers).toBe(1);
      } else {
        expect(badge.swapOffers).toBe(0);
      }
    }
    const recipients = await eligibleRecipientUserIdsForSwapOffer(db, {
      id: offerId,
      fromUserId: offerer.userId,
      toUserId: null,
      toProfessionalId: null,
      institutionId,
    });
    expect([...recipients].sort((a, b) => a - b)).toEqual(
      [...canRespondIds].sort((a, b) => a - b),
    );
    expect(canRespondIds).toEqual(
      new Set([peer.userId, gestorClinician.userId, plusClinician.userId]),
    );
  });

  it("19. accept revalida estado stale e rejeita", async () => {
    const { offerId } = await offerCessao(offerer, 19);
    expect(await rowFor(peer, offerId)).toMatchObject({ canRespond: true });
    await db
      .update(professionalAccess)
      .set({ canAccess: false })
      .where(eq(professionalAccess.professionalId, peer.professionalId));
    try {
      await expect(
        callerFor(peer).accept({ swapRequestId: offerId }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "Profissional sem acesso ativo ao hospital/setor do plantão",
      });
    } finally {
      await db
        .update(professionalAccess)
        .set({ canAccess: true })
        .where(eq(professionalAccess.professionalId, peer.professionalId));
    }
  });

  it("20. papel de gestor isoladamente nunca concede capacidade clínica", async () => {
    const { offerId } = await offerCessao(offerer, 20);
    for (const actor of [gestorAdmin, plusAdmin]) {
      expect(await rowFor(actor, offerId)).toMatchObject({ canRespond: false });
      await expect(
        callerFor(actor).accept({ swapRequestId: offerId }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "Profissional sem acesso ativo ao hospital/setor do plantão",
      });
      await expect(
        callerFor(actor).reject({ swapRequestId: offerId }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "Profissional sem acesso ativo ao hospital/setor do plantão",
      });
    }
    expect(await signaledUserIds()).not.toContain(gestorAdmin.userId);
    expect(await signaledUserIds()).not.toContain(plusAdmin.userId);
  });
});
