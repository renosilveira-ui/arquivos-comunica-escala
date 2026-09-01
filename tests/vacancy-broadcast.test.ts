import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
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
  shiftAuditLog,
  shiftInstances,
  users,
} from "../drizzle/schema";
import {
  ensureTestAnesthesiaSpecialty,
  openTestScale,
} from "./helpers/open-test-scale";
import { TRPCError } from "@trpc/server";
import { getDb } from "../server/db";
import { editorRouter } from "../server/editor";
import { appRouter } from "../server/routers";
import { shiftsRouter } from "../server/shifts-crud";
import {
  addDaysToKey,
  addMonthsYearMonth,
  SCHEDULE_TIME_ZONE_OFFSET,
  yearMonthBrt,
} from "../server/local-time";
import {
  VACANCY_AVAILABLE_DEEP_LINK,
  VACANCY_AVAILABLE_PUSH_TITLE,
  VACANCY_BROADCAST_COOLDOWN_MS,
  vacancyBroadcastDedupPrefix,
} from "../lib/vacancy-broadcast";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Identity = {
  userId: number;
  professionalId: number;
  name: string;
  role: "doctor" | "manager";
};

describe("aviso deliberado de plantão vago", () => {
  let db: Db;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let scheduleContextId: number;
  let anesthesiaId: number;
  let clinicaId: number;
  let manager: Identity;
  let plus: Identity;
  let doctor: Identity;
  let doctorGestor: Identity;
  let ineligible: Identity;
  const userIds: number[] = [];
  const professionalIds: number[] = [];
  const stamp = Date.now();
  const fixtureMonth = addMonthsYearMonth(yearMonthBrt(new Date()), 1);

  const at = (dayOffset: number, hour: number): Date => {
    const day = addDaysToKey(`${fixtureMonth}-01`, dayOffset);
    const wallClockHour = String(hour).padStart(2, "0");
    return new Date(
      `${day}T${wallClockHour}:00:00${SCHEDULE_TIME_ZONE_OFFSET}`,
    );
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
    const name = `vacancy-bc-${stamp}-${label}`;
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
        role: role === "manager" ? "Gestor" : "Médico",
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

  function callerFor(identity: Identity, inst = institutionId) {
    return shiftsRouter.createCaller({
      user: {
        id: identity.userId,
        role: identity.role,
        name: identity.name,
        email: `${identity.name}@example.test`,
        sessionVersion: 1,
      },
      institutionId: inst,
      allowedInstitutionIds: [inst],
    } as never);
  }

  function vacanciesCaller(identity: Identity) {
    return appRouter.createCaller({
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

  function editorCaller(identity: Identity) {
    return editorRouter.createCaller({
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

  async function createVacantShift(
    dayOffset: number,
    place?: { hospitalId: number; sectorId: number; scheduleContextId: number },
  ): Promise<number> {
    const startAt = at(dayOffset, 22);
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
        label: `vacancy-bc-${stamp}-${dayOffset}`,
        specialty: "Anestesiologia",
        startAt,
        endAt: at(dayOffset + 1, 10),
        status: "VAGO",
      })
      .$returningId();
    return shift.id;
  }

  async function listBroadcasts(shiftInstanceId: number) {
    return db
      .select({
        userId: notifications.userId,
        title: notifications.title,
        body: notifications.body,
        deepLink: notifications.deepLink,
        dedupKey: notifications.dedupKey,
      })
      .from(notifications)
      .where(
        like(
          notifications.dedupKey,
          `${vacancyBroadcastDedupPrefix(shiftInstanceId)}%`,
        ),
      );
  }

  beforeAll(async () => {
    const connection = await getDb();
    if (!connection) throw new Error("Database not available");
    db = connection;

    const [institution] = await db
      .insert(institutions)
      .values({
        name: `Vacancy BC ${stamp}`,
        cnpj: String(stamp).slice(-14).padStart(14, "6"),
        legalName: `Vacancy BC ${stamp}`,
        tradeName: `VB${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = institution.id;
    const [hospital] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Vacancy BC Hospital ${stamp}` })
      .$returningId();
    hospitalId = hospital.id;
    const [sector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: "SR",
        category: "cirurgico",
        color: "#123456",
      })
      .$returningId();
    sectorId = sector.id;
    anesthesiaId = await ensureTestAnesthesiaSpecialty(db);
    const [clinica] = await db
      .insert(medicalSpecialties)
      .values({
        code: `VACANCY_BC_CLINICA_${stamp}`,
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
    ]);

    manager = await createIdentity("gestor", {
      roleInInstitution: "GESTOR_MEDICO",
      medicalSpecialtyId: null,
      specialty: null,
      withAccess: false,
    });
    await db.insert(managerScope).values({
      institutionId,
      managerProfessionalId: manager.professionalId,
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
    doctor = await createIdentity("doctor", {
      roleInInstitution: "USER",
      medicalSpecialtyId: anesthesiaId,
      specialty: "Anestesiologia",
    });
    doctorGestor = await createIdentity("doc-gestor", {
      roleInInstitution: "GESTOR_MEDICO",
      medicalSpecialtyId: anesthesiaId,
      specialty: "Anestesiologia",
    });
    await db.insert(managerScope).values({
      institutionId,
      managerProfessionalId: doctorGestor.professionalId,
      hospitalId,
      sectorId,
      active: true,
    });
    ineligible = await createIdentity("ineligible", {
      roleInInstitution: "USER",
      medicalSpecialtyId: clinicaId,
      specialty: "Clínica Médica",
    });
  });

  beforeEach(async () => {
    await db.delete(notifications).where(eq(notifications.institutionId, institutionId));
    await db
      .delete(shiftAuditLog)
      .where(eq(shiftAuditLog.institutionId, institutionId));
    await db.delete(shiftAssignmentsV2).where(eq(shiftAssignmentsV2.institutionId, institutionId));
    await db.delete(shiftInstances).where(eq(shiftInstances.institutionId, institutionId));
    await db.delete(monthlyRosters).where(eq(monthlyRosters.institutionId, institutionId));
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(auditTrail).where(eq(auditTrail.institutionId, institutionId));
    await db.delete(notifications).where(eq(notifications.institutionId, institutionId));
    await db
      .delete(shiftAuditLog)
      .where(eq(shiftAuditLog.institutionId, institutionId));
    await db.delete(shiftAssignmentsV2).where(eq(shiftAssignmentsV2.institutionId, institutionId));
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
    await db.delete(scheduleContexts).where(eq(scheduleContexts.institutionId, institutionId));
    await db.delete(sectors).where(eq(sectors.institutionId, institutionId));
    await db.delete(hospitals).where(eq(hospitals.institutionId, institutionId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    await db.delete(medicalSpecialties).where(eq(medicalSpecialties.id, clinicaId));
  });

  it("gestor autorizado envia e médicos elegíveis recebem", async () => {
    const shiftId = await createVacantShift(1);
    const result = await callerFor(manager).notifyVacancy({ shiftInstanceId: shiftId });
    expect(result.notifiedCount).toBe(2);
    const rows = await listBroadcasts(shiftId);
    const userIdsSignaled = rows.map((row) => row.userId);
    expect(userIdsSignaled).toEqual(
      expect.arrayContaining([doctor.userId, doctorGestor.userId]),
    );
    expect(userIdsSignaled).not.toContain(manager.userId);
    expect(userIdsSignaled).not.toContain(plus.userId);
    expect(userIdsSignaled).not.toContain(ineligible.userId);
    expect(rows[0]?.title).toBe(VACANCY_AVAILABLE_PUSH_TITLE);
    expect(rows[0]?.deepLink).toBe(VACANCY_AVAILABLE_DEEP_LINK);
    expect(rows[0]?.body).toContain("SR ·");
    expect(rows[0]?.body).toMatch(/SR · \d{2}\/\d{2} · /);
    expect(rows[0]?.body).not.toMatch(/saiu|motivo|telefone|\+55/i);
    expect(rows[0]?.title).not.toMatch(manager.name);
    const visible = await vacanciesCaller(doctor).shiftInstances.listVacancies(
      {},
    );
    expect(visible.map((row) => Number(row.shiftInstanceId))).toContain(shiftId);
    const hidden = await vacanciesCaller(ineligible).shiftInstances.listVacancies(
      {},
    );
    expect(hidden.map((row) => Number(row.shiftInstanceId))).not.toContain(
      shiftId,
    );
  });

  it("GESTOR_PLUS autorizado envia", async () => {
    const shiftId = await createVacantShift(2);
    const result = await callerFor(plus).notifyVacancy({ shiftInstanceId: shiftId });
    expect(result.notifiedCount).toBe(2);
  });

  it("médico comum não envia", async () => {
    const shiftId = await createVacantShift(3);
    await expect(
      callerFor(doctor).notifyVacancy({ shiftInstanceId: shiftId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await listBroadcasts(shiftId)).toEqual([]);
  });

  it("gestor sem scope não envia", async () => {
    const shiftId = await createVacantShift(4);
    const outsider = await createIdentity("no-scope", {
      roleInInstitution: "GESTOR_MEDICO",
      medicalSpecialtyId: null,
      specialty: null,
      withAccess: false,
    });
    await expect(
      callerFor(outsider).notifyVacancy({ shiftInstanceId: shiftId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await listBroadcasts(shiftId)).toEqual([]);
  });

  it("shift ocupado não envia; vago envia", async () => {
    const shiftId = await createVacantShift(5);
    await db
      .update(shiftInstances)
      .set({ status: "OCUPADO" })
      .where(eq(shiftInstances.id, shiftId));
    await expect(
      callerFor(manager).notifyVacancy({ shiftInstanceId: shiftId }),
    ).rejects.toBeInstanceOf(TRPCError);
    await expect(
      callerFor(manager).notifyVacancy({ shiftInstanceId: shiftId }),
    ).rejects.toMatchObject({
      message: "Este plantão não está mais vago.",
    });
    await db
      .update(shiftInstances)
      .set({ status: "VAGO" })
      .where(eq(shiftInstances.id, shiftId));
    const result = await callerFor(manager).notifyVacancy({ shiftInstanceId: shiftId });
    expect(result.notifiedCount).toBe(2);
  });

  it("concorrência vaga→ocupada falha fechado", async () => {
    const shiftId = await createVacantShift(6);
    await db
      .update(shiftInstances)
      .set({ status: "PENDENTE" })
      .where(eq(shiftInstances.id, shiftId));
    await expect(
      callerFor(manager).notifyVacancy({ shiftInstanceId: shiftId }),
    ).rejects.toMatchObject({
      message: "Este plantão não está mais vago.",
    });
    expect(await listBroadcasts(shiftId)).toEqual([]);
  });

  it("zero elegíveis devolve count 0 sem outbox", async () => {
    await db
      .delete(professionalAccess)
      .where(
        inArray(professionalAccess.professionalId, [
          doctor.professionalId,
          doctorGestor.professionalId,
          ineligible.professionalId,
        ]),
      );
    try {
      const shiftId = await createVacantShift(7);
      const result = await callerFor(manager).notifyVacancy({
        shiftInstanceId: shiftId,
      });
      expect(result.notifiedCount).toBe(0);
      expect(await listBroadcasts(shiftId)).toEqual([]);
    } finally {
      await db.insert(professionalAccess).values([
        {
          institutionId,
          professionalId: doctor.professionalId,
          hospitalId,
          sectorId,
          canAccess: true,
        },
        {
          institutionId,
          professionalId: doctorGestor.professionalId,
          hospitalId,
          sectorId,
          canAccess: true,
        },
        {
          institutionId,
          professionalId: ineligible.professionalId,
          hospitalId,
          sectorId,
          canAccess: true,
        },
      ]);
    }
  });

  it("cooldown de 15 min bloqueia reenvio", async () => {
    const shiftId = await createVacantShift(8);
    await callerFor(manager).notifyVacancy({ shiftInstanceId: shiftId });
    await expect(
      callerFor(manager).notifyVacancy({ shiftInstanceId: shiftId }),
    ).rejects.toMatchObject({
      message:
        "Este aviso já foi enviado há pouco. Aguarde 15 minutos para enviar de novo.",
    });
  });

  it("virada de bucket em 2s continua em cooldown (elapsed, não época)", async () => {
    const shiftId = await createVacantShift(16);
    await callerFor(manager).notifyVacancy({ shiftInstanceId: shiftId });
    await db
      .update(notifications)
      .set({ createdAt: new Date(Date.now() - 2_000) })
      .where(
        like(
          notifications.dedupKey,
          `${vacancyBroadcastDedupPrefix(shiftId)}%`,
        ),
      );
    await expect(
      callerFor(manager).notifyVacancy({ shiftInstanceId: shiftId }),
    ).rejects.toMatchObject({
      message:
        "Este aviso já foi enviado há pouco. Aguarde 15 minutos para enviar de novo.",
    });
    expect(await listBroadcasts(shiftId)).toHaveLength(2);
  });

  it("libera novo aviso só depois de 15 min elapsed no mesmo plantão", async () => {
    const shiftId = await createVacantShift(17);
    await callerFor(manager).notifyVacancy({ shiftInstanceId: shiftId });
    await db
      .update(notifications)
      .set({
        createdAt: new Date(Date.now() - VACANCY_BROADCAST_COOLDOWN_MS - 1_000),
      })
      .where(
        like(
          notifications.dedupKey,
          `${vacancyBroadcastDedupPrefix(shiftId)}%`,
        ),
      );
    const result = await callerFor(manager).notifyVacancy({
      shiftInstanceId: shiftId,
    });
    expect(result.notifiedCount).toBe(2);
    expect(await listBroadcasts(shiftId)).toHaveLength(4);
  });

  it("double tap concorrente gera um broadcast e um cooldown", async () => {
    const shiftId = await createVacantShift(18);
    const outcomes = await Promise.allSettled([
      callerFor(manager).notifyVacancy({ shiftInstanceId: shiftId }),
      callerFor(manager).notifyVacancy({ shiftInstanceId: shiftId }),
    ]);
    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<{ notifiedCount: number }> =>
        outcome.status === "fulfilled",
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value.notifiedCount).toBe(2);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      message:
        "Este aviso já foi enviado há pouco. Aguarde 15 minutos para enviar de novo.",
    });
    expect(await listBroadcasts(shiftId)).toHaveLength(2);
  });

  it("cooldown é por plantão, não por gestor", async () => {
    const shiftId = await createVacantShift(19);
    await callerFor(manager).notifyVacancy({ shiftInstanceId: shiftId });
    await expect(
      callerFor(plus).notifyVacancy({ shiftInstanceId: shiftId }),
    ).rejects.toMatchObject({
      message:
        "Este aviso já foi enviado há pouco. Aguarde 15 minutos para enviar de novo.",
    });
    expect(await listBroadcasts(shiftId)).toHaveLength(2);
  });

  it("status VAGO envenenado com assignment ativa não dispara aviso", async () => {
    const shiftId = await createVacantShift(20);
    await db.insert(shiftAssignmentsV2).values({
      shiftInstanceId: shiftId,
      institutionId,
      hospitalId,
      sectorId,
      professionalId: doctor.professionalId,
      assignmentType: "ON_DUTY",
      status: "OCUPADO",
      isActive: true,
    });
    await expect(
      callerFor(manager).notifyVacancy({ shiftInstanceId: shiftId }),
    ).rejects.toMatchObject({
      message: "Este plantão não está mais vago.",
    });
    expect(await listBroadcasts(shiftId)).toEqual([]);
  });

  it("outro tenant nunca recebe", async () => {
    const [otherInstitution] = await db
      .insert(institutions)
      .values({
        name: `Vacancy BC Other ${stamp}`,
        cnpj: String(stamp + 2).slice(-14).padStart(14, "5"),
        legalName: `Vacancy BC Other ${stamp}`,
        tradeName: `VO${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    const [otherHospital] = await db
      .insert(hospitals)
      .values({
        institutionId: otherInstitution.id,
        name: `Other H ${stamp}`,
      })
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
    const name = `vacancy-bc-${stamp}-foreign`;
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
      const shiftId = await createVacantShift(9);
      await callerFor(manager).notifyVacancy({ shiftInstanceId: shiftId });
      const rows = await listBroadcasts(shiftId);
      expect(rows.map((row) => row.userId)).not.toContain(foreignUser.id);
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

  it("acesso hospital-wide cobre legado e não cobre allowlist #317", async () => {
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
    const widePeer = await createIdentity("wide", {
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
    try {
      const allowlistShiftId = await createVacantShift(10);
      await callerFor(manager).notifyVacancy({
        shiftInstanceId: allowlistShiftId,
      });
      const allowlist = (await listBroadcasts(allowlistShiftId)).map(
        (row) => row.userId,
      );
      expect(allowlist).toContain(doctor.userId);
      expect(allowlist).not.toContain(widePeer.userId);

      await db
        .delete(notifications)
        .where(eq(notifications.institutionId, institutionId));
      const legacyShiftId = await createVacantShift(11, {
        hospitalId,
        sectorId: legacySector.id,
        scheduleContextId: legacyContextId,
      });
      await callerFor(plus).notifyVacancy({ shiftInstanceId: legacyShiftId });
      const legacy = (await listBroadcasts(legacyShiftId)).map((row) => row.userId);
      expect(legacy).toContain(widePeer.userId);
      expect(legacy).not.toContain(doctor.userId);
    } finally {
      await db
        .delete(professionalAccess)
        .where(eq(professionalAccess.professionalId, widePeer.professionalId));
      await db
        .delete(notifications)
        .where(eq(notifications.institutionId, institutionId));
      await db
        .delete(shiftAuditLog)
        .where(eq(shiftAuditLog.institutionId, institutionId));
      await db.delete(shiftInstances).where(eq(shiftInstances.sectorId, legacySector.id));
      await db.delete(scheduleContexts).where(eq(scheduleContexts.id, legacyContextId));
      await db.delete(sectors).where(eq(sectors.id, legacySector.id));
    }
  });

  it("markVacant não cria aviso automático de equipe", async () => {
    const startAt = at(12, 22);
    await db.insert(monthlyRosters).values({
      institutionId,
      hospitalId,
      yearMonth: yearMonthBrt(startAt),
      status: "PUBLISHED",
    }).onDuplicateKeyUpdate({ set: { status: "PUBLISHED" } });
    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId,
        sectorId,
        scheduleContextId,
        label: `vacancy-bc-occupied-${stamp}`,
        specialty: "Anestesiologia",
        startAt,
        endAt: at(13, 10),
        status: "OCUPADO",
      })
      .$returningId();
    await db.insert(shiftAssignmentsV2).values({
      shiftInstanceId: shift.id,
      institutionId,
      hospitalId,
      sectorId,
      professionalId: doctor.professionalId,
      assignmentType: "ON_DUTY",
      status: "OCUPADO",
      isActive: true,
    });
    await editorCaller(plus).markVacant({
      shiftInstanceId: shift.id,
      reason: "Teste sem broadcast automático",
    });
    expect(await listBroadcasts(shift.id)).toEqual([]);
  });
});
