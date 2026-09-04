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
import { getDb } from "../server/db";
import { swapRouter } from "../server/swap-router";
import { yearMonthBrt } from "../server/local-time";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Identity = {
  userId: number;
  professionalId: number;
  name: string;
  role: "doctor" | "manager";
};

describe("swaps.listEligibleRecipients", () => {
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
  let noAcl: Identity;
  let gestorClinician: Identity;
  let plusClinician: Identity;
  let gestorAdmin: Identity;
  let plusAdmin: Identity;
  const userIds: number[] = [];
  const professionalIds: number[] = [];
  const stamp = Date.now();

  const at = (dayOffset: number, hour: number): Date => {
    const value = new Date();
    value.setUTCDate(value.getUTCDate() + 640 + dayOffset);
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
      name?: string;
      tenantId?: number;
      hospitalId?: number;
      sectorId?: number | null;
    },
  ): Promise<Identity> {
    const name = input.name ?? `recip-${stamp}-${label}`;
    const tenantId = input.tenantId ?? institutionId;
    const role =
      input.roleInInstitution === "USER" ? "doctor" : "manager";
    const [user] = await db
      .insert(users)
      .values({
        name,
        email: `recip.${stamp}.${label.replace(/\s+/g, ".")}@example.test`,
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
      institutionId: tenantId,
      roleInInstitution: input.roleInInstitution,
      active: true,
    });
    if (input.withAccess !== false) {
      await db.insert(professionalAccess).values({
        institutionId: tenantId,
        professionalId: professional.id,
        hospitalId: input.hospitalId ?? hospitalId,
        sectorId: input.sectorId === undefined ? sectorId : input.sectorId,
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
        email: `recip.${stamp}.${identity.name}@example.test`,
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
        label: `recip-${stamp}-shift-${dayOffset}`,
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

  async function listRecipients(owner: Identity, shiftId: number) {
    return callerFor(owner).listEligibleRecipients({
      fromShiftInstanceId: shiftId,
    });
  }

  function listedIds(
    result: { recipients: { professionalId: number }[] },
  ): Set<number> {
    return new Set(result.recipients.map((row) => row.professionalId));
  }

  async function provisionAllowlistSector(
    label: string,
    specialtyIds: number[],
  ): Promise<{ sectorId: number; scheduleContextId: number }> {
    const [sector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `Allow ${label} ${stamp}`,
        category: "servico",
        color: "#aaaaaa",
      })
      .$returningId();
    const contextId = await openTestScale(db, {
      institutionId,
      hospitalId,
      sectorId: sector.id,
    });
    await db
      .update(scheduleContexts)
      .set({
        admissionPolicy: "QUALIFICATION_ALLOWLIST",
        medicalSpecialtyId: null,
        operationalProfileCode: null,
      })
      .where(eq(scheduleContexts.id, contextId));
    if (specialtyIds.length > 0) {
      await db.insert(scheduleContextAllowedQualifications).values(
        specialtyIds.map((medicalSpecialtyId) => ({
          scheduleContextId: contextId,
          medicalSpecialtyId,
        })),
      );
    }
    return { sectorId: sector.id, scheduleContextId: contextId };
  }

  async function grantExactAccess(
    professionalId: number,
    targetSectorId: number,
  ) {
    await db.insert(professionalAccess).values({
      institutionId,
      professionalId,
      hospitalId,
      sectorId: targetSectorId,
      canAccess: true,
    });
  }

  async function cleanupAllowlistSector(target: {
    sectorId: number;
    scheduleContextId: number;
  }) {
    await db
      .delete(notifications)
      .where(eq(notifications.institutionId, institutionId));
    await db
      .delete(swapRequestDismissals)
      .where(eq(swapRequestDismissals.institutionId, institutionId));
    await db.delete(swapRequests).where(eq(swapRequests.institutionId, institutionId));
    await db
      .delete(scheduleContextAllowedQualifications)
      .where(
        eq(
          scheduleContextAllowedQualifications.scheduleContextId,
          target.scheduleContextId,
        ),
      );
    await db
      .delete(professionalAccess)
      .where(eq(professionalAccess.sectorId, target.sectorId));
    await db
      .delete(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.sectorId, target.sectorId));
    await db.delete(shiftInstances).where(eq(shiftInstances.sectorId, target.sectorId));
    await db
      .delete(scheduleContexts)
      .where(eq(scheduleContexts.id, target.scheduleContextId));
    await db.delete(sectors).where(eq(sectors.id, target.sectorId));
  }

  beforeAll(async () => {
    const connection = await getDb();
    if (!connection) throw new Error("Database not available");
    db = connection;

    const [institution] = await db
      .insert(institutions)
      .values({
        name: `Recip ${stamp}`,
        cnpj: String(stamp).slice(-14).padStart(14, "8"),
        legalName: `Recip ${stamp}`,
        tradeName: `RP${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = institution.id;
    const [hospital] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Recip Hospital ${stamp}` })
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
        name: `Setor Y ${stamp}`,
        category: "internacao",
        color: "#654321",
      })
      .$returningId();
    otherSectorId = otherSector.id;
    anesthesiaId = await ensureTestAnesthesiaSpecialty(db);
    const [clinica] = await db
      .insert(medicalSpecialties)
      .values({
        code: `RECIP_CLINICA_${stamp}`,
        name: "Clínica Médica",
        sourceVersion: "TEST",
        active: true,
        sortOrder: 22,
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
    noAcl = await createIdentity("no-acl", {
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
      medicalSpecialtyId: clinicaId,
      specialty: "Clínica Médica",
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
      medicalSpecialtyId: clinicaId,
      specialty: "Clínica Médica",
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
    const leftoverContexts = await db
      .select({ id: scheduleContexts.id })
      .from(scheduleContexts)
      .where(eq(scheduleContexts.institutionId, institutionId));
    if (leftoverContexts.length > 0) {
      await db
        .delete(scheduleContextAllowedQualifications)
        .where(
          inArray(
            scheduleContextAllowedQualifications.scheduleContextId,
            leftoverContexts.map((row) => row.id),
          ),
        );
    }
    await db
      .delete(scheduleContexts)
      .where(eq(scheduleContexts.institutionId, institutionId));
    await db.delete(sectors).where(eq(sectors.institutionId, institutionId));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    await db.delete(medicalSpecialties).where(eq(medicalSpecialties.id, clinicaId));
  });

  it("1. actor dono/autorizado consulta destinatários", async () => {
    const shift = await createOccupiedShift(offerer, 1);
    const rows = await listRecipients(offerer, shift.shiftId);
    expect(listedIds(rows).has(peer.professionalId)).toBe(true);
  });

  it("2. usuário arbitrário não enumera o plantão de outro", async () => {
    const shift = await createOccupiedShift(offerer, 2);
    await expect(listRecipients(peer, shift.shiftId)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("3–4. outro tenant e plantão inexistente usam o erro canônico de topologia", async () => {
    const [otherInstitution] = await db
      .insert(institutions)
      .values({
        name: `Recip Other ${stamp}`,
        cnpj: String(stamp + 1).slice(-14).padStart(14, "9"),
        legalName: `Recip Other ${stamp}`,
        tradeName: `RO${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    const [otherHospital] = await db
      .insert(hospitals)
      .values({
        institutionId: otherInstitution.id,
        name: `Recip Other Hospital ${stamp}`,
      })
      .$returningId();
    const [otherSector] = await db
      .insert(sectors)
      .values({
        institutionId: otherInstitution.id,
        hospitalId: otherHospital.id,
        name: `Sala de Recuperação ${stamp}`,
        category: "cirurgico",
        color: "#111111",
      })
      .$returningId();
    const otherContextId = await openTestScale(db, {
      institutionId: otherInstitution.id,
      hospitalId: otherHospital.id,
      sectorId: otherSector.id,
    });
    const foreign = await createIdentity("foreign-owner", {
      roleInInstitution: "USER",
      medicalSpecialtyId: clinicaId,
      specialty: "Clínica Médica",
      tenantId: otherInstitution.id,
      hospitalId: otherHospital.id,
      sectorId: otherSector.id,
    });
    const startAt = at(3, 8);
    await db.insert(monthlyRosters).values({
      institutionId: otherInstitution.id,
      hospitalId: otherHospital.id,
      yearMonth: yearMonthBrt(startAt),
      status: "PUBLISHED",
    });
    const [foreignShift] = await db
      .insert(shiftInstances)
      .values({
        institutionId: otherInstitution.id,
        hospitalId: otherHospital.id,
        sectorId: otherSector.id,
        scheduleContextId: otherContextId,
        label: `recip-foreign-${stamp}`,
        specialty: "Clínica Médica",
        startAt,
        endAt: at(3, 14),
        status: "OCUPADO",
      })
      .$returningId();
    await db.insert(shiftAssignmentsV2).values({
      shiftInstanceId: foreignShift.id,
      institutionId: otherInstitution.id,
      hospitalId: otherHospital.id,
      sectorId: otherSector.id,
      professionalId: foreign.professionalId,
      assignmentType: "ON_DUTY",
      status: "OCUPADO",
      isActive: true,
    });
    try {
      await expect(
        listRecipients(offerer, foreignShift.id),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "Turno fora da topologia canônica do tenant",
      });
      await expect(
        listRecipients(offerer, 2_147_000_000),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "Turno fora da topologia canônica do tenant",
      });
    } finally {
      await db
        .delete(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.institutionId, otherInstitution.id));
      await db
        .delete(shiftInstances)
        .where(eq(shiftInstances.institutionId, otherInstitution.id));
      await db
        .delete(monthlyRosters)
        .where(eq(monthlyRosters.institutionId, otherInstitution.id));
      await db
        .delete(professionalAccess)
        .where(eq(professionalAccess.institutionId, otherInstitution.id));
      await db
        .delete(professionalInstitutions)
        .where(eq(professionalInstitutions.institutionId, otherInstitution.id));
      await db
        .delete(scheduleContexts)
        .where(eq(scheduleContexts.institutionId, otherInstitution.id));
      await db.delete(sectors).where(eq(sectors.institutionId, otherInstitution.id));
      await db.delete(hospitals).where(eq(hospitals.id, otherHospital.id));
      await db.delete(institutions).where(eq(institutions.id, otherInstitution.id));
    }
  });

  it("5–11. USER/gestor clínico aparecem; admin, sem ACL e o ofertante não", async () => {
    const shift = await createOccupiedShift(offerer, 5);
    const rows = await listRecipients(offerer, shift.shiftId);
    const ids = listedIds(rows);
    expect(ids.has(peer.professionalId)).toBe(true);
    expect(ids.has(gestorClinician.professionalId)).toBe(true);
    expect(ids.has(plusClinician.professionalId)).toBe(true);
    expect(ids.has(noAcl.professionalId)).toBe(false);
    expect(ids.has(gestorAdmin.professionalId)).toBe(false);
    expect(ids.has(plusAdmin.professionalId)).toBe(false);
    expect(ids.has(offerer.professionalId)).toBe(false);
  });

  it("12–13. conta não APPROVED, deletada ou membership inativa não aparece", async () => {
    const pending = await createIdentity("pending", {
      roleInInstitution: "USER",
      medicalSpecialtyId: clinicaId,
      specialty: "Clínica Médica",
    });
    const deleted = await createIdentity("deleted", {
      roleInInstitution: "USER",
      medicalSpecialtyId: clinicaId,
      specialty: "Clínica Médica",
    });
    const inactive = await createIdentity("inactive", {
      roleInInstitution: "USER",
      medicalSpecialtyId: clinicaId,
      specialty: "Clínica Médica",
    });
    await db
      .update(users)
      .set({ approvalStatus: "PENDING" })
      .where(eq(users.id, pending.userId));
    await db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(eq(users.id, deleted.userId));
    await db
      .update(professionalInstitutions)
      .set({ active: false })
      .where(eq(professionalInstitutions.professionalId, inactive.professionalId));

    const shift = await createOccupiedShift(offerer, 12);
    const ids = listedIds(await listRecipients(offerer, shift.shiftId));
    expect(ids.has(pending.professionalId)).toBe(false);
    expect(ids.has(deleted.professionalId)).toBe(false);
    expect(ids.has(inactive.professionalId)).toBe(false);
    expect(ids.has(peer.professionalId)).toBe(true);
  });

  it("14–15. ACL do setor certo aparece; setor errado não", async () => {
    const sectorYOnly = await createIdentity("sector-y", {
      roleInInstitution: "USER",
      medicalSpecialtyId: clinicaId,
      specialty: "Clínica Médica",
      withAccess: false,
    });
    await grantExactAccess(sectorYOnly.professionalId, otherSectorId);
    await grantExactAccess(offerer.professionalId, otherSectorId);

    const shiftX = await createOccupiedShift(offerer, 14);
    const idsX = listedIds(await listRecipients(offerer, shiftX.shiftId));
    expect(idsX.has(peer.professionalId)).toBe(true);
    expect(idsX.has(sectorYOnly.professionalId)).toBe(false);

    const shiftY = await createOccupiedShift(offerer, 15, {
      hospitalId,
      sectorId: otherSectorId,
      scheduleContextId: otherScheduleContextId,
    });
    const idsY = listedIds(await listRecipients(offerer, shiftY.shiftId));
    expect(idsY.has(sectorYOnly.professionalId)).toBe(true);
    expect(idsY.has(peer.professionalId)).toBe(false);
  });

  it("16. professional_access / membership de outro tenant não aparece", async () => {
    const [otherInstitution] = await db
      .insert(institutions)
      .values({
        name: `Recip Access ${stamp}`,
        cnpj: String(stamp + 2).slice(-14).padStart(14, "6"),
        legalName: `Recip Access ${stamp}`,
        tradeName: `RA${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    const [otherHospital] = await db
      .insert(hospitals)
      .values({
        institutionId: otherInstitution.id,
        name: `Recip Access Hospital ${stamp}`,
      })
      .$returningId();
    const [otherSector] = await db
      .insert(sectors)
      .values({
        institutionId: otherInstitution.id,
        hospitalId: otherHospital.id,
        name: `Sala de Recuperação ${stamp}`,
        category: "cirurgico",
        color: "#222222",
      })
      .$returningId();
    await openTestScale(db, {
      institutionId: otherInstitution.id,
      hospitalId: otherHospital.id,
      sectorId: otherSector.id,
    });
    const foreignMember = await createIdentity("foreign-acl", {
      roleInInstitution: "USER",
      medicalSpecialtyId: clinicaId,
      specialty: "Clínica Médica",
      withAccess: false,
    });
    await db.insert(professionalAccess).values({
      institutionId: otherInstitution.id,
      professionalId: foreignMember.professionalId,
      hospitalId: otherHospital.id,
      sectorId: otherSector.id,
      canAccess: true,
    });
    await db.insert(managerScope).values({
      institutionId: otherInstitution.id,
      managerProfessionalId: foreignMember.professionalId,
      hospitalId: otherHospital.id,
      sectorId: otherSector.id,
      active: true,
    });
    try {
      const shift = await createOccupiedShift(offerer, 16);
      const ids = listedIds(await listRecipients(offerer, shift.shiftId));
      expect(ids.has(foreignMember.professionalId)).toBe(false);
      expect(ids.has(peer.professionalId)).toBe(true);
    } finally {
      await db
        .delete(managerScope)
        .where(eq(managerScope.institutionId, otherInstitution.id));
      await db
        .delete(professionalAccess)
        .where(eq(professionalAccess.institutionId, otherInstitution.id));
      await db
        .delete(scheduleContexts)
        .where(eq(scheduleContexts.institutionId, otherInstitution.id));
      await db.delete(sectors).where(eq(sectors.institutionId, otherInstitution.id));
      await db.delete(hospitals).where(eq(hospitals.id, otherHospital.id));
      await db.delete(institutions).where(eq(institutions.id, otherInstitution.id));
    }
  });

  it("17. hospital-wide legado cobre ALL_CFM; 18. allowlist exige setor exato e qualificação", async () => {
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

    const legacyShift = await createOccupiedShift(offerer, 17);
    const legacyIds = listedIds(await listRecipients(offerer, legacyShift.shiftId));
    expect(legacyIds.has(wide.professionalId)).toBe(true);

    const allow = await provisionAllowlistSector("recip-allow", [clinicaId]);
    const mismatched = await createIdentity("mismatch-qual", {
      roleInInstitution: "USER",
      medicalSpecialtyId: anesthesiaId,
      specialty: "Anestesiologia",
      withAccess: false,
    });
    const matched = await createIdentity("match-qual", {
      roleInInstitution: "USER",
      medicalSpecialtyId: clinicaId,
      specialty: "Clínica Médica",
      withAccess: false,
    });
    await grantExactAccess(offerer.professionalId, allow.sectorId);
    await grantExactAccess(mismatched.professionalId, allow.sectorId);
    await grantExactAccess(matched.professionalId, allow.sectorId);
    try {
      const allowShift = await createOccupiedShift(offerer, 18, {
        hospitalId,
        sectorId: allow.sectorId,
        scheduleContextId: allow.scheduleContextId,
      });
      const allowIds = listedIds(await listRecipients(offerer, allowShift.shiftId));
      expect(allowIds.has(wide.professionalId)).toBe(false);
      expect(allowIds.has(mismatched.professionalId)).toBe(false);
      expect(allowIds.has(matched.professionalId)).toBe(true);
    } finally {
      await cleanupAllowlistSector(allow);
    }
  });

  it("19–20. resposta só com campos aprovados; sem PII", async () => {
    const shift = await createOccupiedShift(offerer, 19);
    const rows = await listRecipients(offerer, shift.shiftId);
    expect(rows.recipients.length).toBeGreaterThan(0);
    expect(rows.unresolvedHomonymGroups).toEqual([]);
    for (const row of rows.recipients) {
      expect(Object.keys(row).sort()).toEqual(["displayName", "professionalId"]);
      expect(row).not.toHaveProperty("userId");
      expect(row).not.toHaveProperty("email");
      expect(row).not.toHaveProperty("phone");
      expect(row.displayName).not.toMatch(/@/);
    }
    const payload = JSON.stringify(rows);
    expect(payload).not.toMatch(/@example\.test/);
    expect(payload).not.toContain("passwordHash");
    expect(payload).not.toMatch(/"userId"/);
  });

  it("22. ordenação determinística por nome e professionalId", async () => {
    const carlos = await createIdentity("sort-c", {
      roleInInstitution: "USER",
      medicalSpecialtyId: clinicaId,
      specialty: "Clínica Médica",
      name: `Carlos Recip ${stamp}`,
    });
    const ana = await createIdentity("sort-a", {
      roleInInstitution: "USER",
      medicalSpecialtyId: clinicaId,
      specialty: "Clínica Médica",
      name: `Ana Recip ${stamp}`,
    });
    const bruno = await createIdentity("sort-b", {
      roleInInstitution: "USER",
      medicalSpecialtyId: clinicaId,
      specialty: "Clínica Médica",
      name: `Bruno Recip ${stamp}`,
    });
    const shift = await createOccupiedShift(offerer, 22);
    const names = (await listRecipients(offerer, shift.shiftId)).recipients
      .filter((row) =>
        [carlos.professionalId, ana.professionalId, bruno.professionalId].includes(
          row.professionalId,
        ),
      )
      .map((row) => row.displayName);
    expect(names).toEqual([
      ana.name,
      bruno.name,
      carlos.name,
    ]);
  });

  it("input extra institutionId/sectorId é rejeitado e não vira autoridade", async () => {
    const shift = await createOccupiedShift(offerer, 23);
    await expect(
      callerFor(offerer).listEligibleRecipients({
        fromShiftInstanceId: shift.shiftId,
        institutionId: 999_999,
        sectorId: 999_999,
      } as never),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("SUCCESS + [] quando ninguém mais é estruturalmente elegível", async () => {
    const lonely = await provisionAllowlistSector("lonely", [clinicaId]);
    await grantExactAccess(offerer.professionalId, lonely.sectorId);
    try {
      const shift = await createOccupiedShift(offerer, 24, {
        hospitalId,
        sectorId: lonely.sectorId,
        scheduleContextId: lonely.scheduleContextId,
      });
      await expect(listRecipients(offerer, shift.shiftId)).resolves.toEqual({
        recipients: [],
        unresolvedHomonymGroups: [],
      });
    } finally {
      await cleanupAllowlistSector(lonely);
    }
  });

  it("24. B listado e ainda elegível: create dirigido aceita, sinaliza só B e impede terceiro", async () => {
    const shift = await createOccupiedShift(offerer, 25);
    const rows = await listRecipients(offerer, shift.shiftId);
    expect(listedIds(rows).has(peer.professionalId)).toBe(true);

    const created = await callerFor(offerer).offer({
      type: "CESSAO",
      fromShiftInstanceId: shift.shiftId,
      fromAssignmentId: shift.assignmentId,
      toProfessionalId: peer.professionalId,
    });
    expect(created.toProfessionalId).toBe(peer.professionalId);
    expect(created.toUserId).toBe(peer.userId);

    const signaled = await db
      .select({ userId: notifications.userId })
      .from(notifications)
      .where(eq(notifications.institutionId, institutionId));
    expect(signaled.map((row) => row.userId)).toEqual([peer.userId]);

    const third = await callerFor(gestorClinician).listAvailable({});
    const visible = third.find((row) => Number(row.id) === Number(created.id));
    expect(visible).toMatchObject({ canRespond: false });
    await expect(
      callerFor(gestorClinician).accept({ swapRequestId: Number(created.id) }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Esta oferta foi direcionada a outro profissional",
    });
  });

  it("24b. TRANSFER dirigido para B listado também grava o destinatário", async () => {
    const shift = await createOccupiedShift(offerer, 26);
    expect(
      listedIds(await listRecipients(offerer, shift.shiftId)).has(peer.professionalId),
    ).toBe(true);
    const created = await callerFor(offerer).offer({
      type: "TRANSFER",
      fromShiftInstanceId: shift.shiftId,
      fromAssignmentId: shift.assignmentId,
      toProfessionalId: peer.professionalId,
    });
    expect(created.type).toBe("TRANSFER");
    expect(created.toProfessionalId).toBe(peer.professionalId);
  });

  it("25. B perde elegibilidade depois da listagem: create dirigido rejeita", async () => {
    const shift = await createOccupiedShift(offerer, 27);
    expect(
      listedIds(await listRecipients(offerer, shift.shiftId)).has(peer.professionalId),
    ).toBe(true);
    await db
      .update(professionalAccess)
      .set({ canAccess: false })
      .where(eq(professionalAccess.professionalId, peer.professionalId));
    try {
      await expect(
        callerFor(offerer).offer({
          type: "CESSAO",
          fromShiftInstanceId: shift.shiftId,
          fromAssignmentId: shift.assignmentId,
          toProfessionalId: peer.professionalId,
        }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "Profissional sem acesso ativo ao hospital/setor do plantão",
      });
      await expect(
        callerFor(offerer).offer({
          type: "CESSAO",
          fromShiftInstanceId: shift.shiftId,
          fromAssignmentId: shift.assignmentId,
          toProfessionalId: gestorAdmin.professionalId,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await db
        .update(professionalAccess)
        .set({ canAccess: true })
        .where(eq(professionalAccess.professionalId, peer.professionalId));
    }
  });

  it("homônimos com qualificação canônica distinta são selecionáveis; iguais não", async () => {
    const sameName = `Ana Homônima ${stamp}`;
    const clinicaTwin = await createIdentity("homonym-clinica", {
      roleInInstitution: "USER",
      medicalSpecialtyId: clinicaId,
      specialty: "rótulo legado irrelevante",
      name: sameName,
    });
    const anesthesiaTwin = await createIdentity("homonym-anest", {
      roleInInstitution: "USER",
      medicalSpecialtyId: anesthesiaId,
      specialty: "rótulo legado irrelevante",
      name: sameName,
    });
    const collideA = await createIdentity("homonym-collide-a", {
      roleInInstitution: "USER",
      medicalSpecialtyId: clinicaId,
      specialty: "Clínica Médica",
      name: `Bruno Homônimo ${stamp}`,
    });
    const collideB = await createIdentity("homonym-collide-b", {
      roleInInstitution: "USER",
      medicalSpecialtyId: clinicaId,
      specialty: "Clínica Médica",
      name: `Bruno Homônimo ${stamp}`,
    });
    const shift = await createOccupiedShift(offerer, 40);
    const listed = await listRecipients(offerer, shift.shiftId);
    const ids = listedIds(listed);

    expect(ids.has(clinicaTwin.professionalId)).toBe(true);
    expect(ids.has(anesthesiaTwin.professionalId)).toBe(true);
    const anaRows = listed.recipients.filter(
      (item) => item.professionalId === clinicaTwin.professionalId
        || item.professionalId === anesthesiaTwin.professionalId,
    );
    expect(anaRows.map((item) => item.qualification).sort()).toEqual([
      "Anestesiologia",
      "Clínica Médica",
    ]);

    expect(ids.has(collideA.professionalId)).toBe(false);
    expect(ids.has(collideB.professionalId)).toBe(false);
    expect(listed.unresolvedHomonymGroups).toEqual(
      expect.arrayContaining([
        {
          code: "UNRESOLVED_HOMONYM",
          displayName: `Bruno Homônimo ${stamp}`,
          qualification: "Clínica Médica",
          count: 2,
          reason:
            "Há mais de um profissional com este nome e a mesma qualificação. Não é possível direcionar a oferta com segurança.",
        },
      ]),
    );
    expect(JSON.stringify(listed.unresolvedHomonymGroups)).not.toContain(
      "professionalId",
    );
  });
});
