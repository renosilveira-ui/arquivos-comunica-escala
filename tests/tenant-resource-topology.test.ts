import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditTrail,
  dutyConfirmations,
  hospitals,
  institutions,
  managerScope,
  monthlyRosters,
  professionalAccess,
  professionalInstitutions,
  professionals,
  scheduleContexts,
  sectors,
  shiftAuditLog,
  shiftAssignmentsV2,
  shiftInstances,
  shiftTemplates,
  users,
} from "../drizzle/schema";
import {
  ensureTestAnesthesiaSpecialty,
  openTestScale,
} from "./helpers/open-test-scale";
import { calendarRouter } from "../server/calendar";
import {
  dispatchConfirmations,
  notifyManagersConfirmationEscalation,
  processRechecks,
  processShiftStartPushes,
} from "../server/cron/shift-confirmation-dispatcher";
import { confirmationRouter } from "../server/confirmation-router";
import { appRouter } from "../server/routers";
import { assertInstitutionHierarchy, resolveInstitutionForUser } from "../server/_core/tenant";
import { assertManagerScopeAccess, resolveTenantActor } from "../server/_core/policy";
import { getDb } from "../server/db";
import { dayKeyBrt, mondayOfKey } from "../server/local-time";
import {
  getRosterPublicationEmails,
  lockMonth,
  publishMonth,
} from "../server/month-guards";
import { enqueueComunicaRosterPublished } from "../server/integrations/comunica-plus";
import { triggerAutoSso } from "../server/sso/auto-sso";
import { syncDutyToComunica } from "../server/sso/duty-sync";
import { shiftsRouter } from "../server/shifts-crud";

vi.mock("../server/integrations/comunica-plus", () => ({
  enqueueComunicaRosterPublished: vi.fn(async () => 1),
  processPendingComunicaPlusOutbox: vi.fn(async () => 0),
}));
vi.mock("../server/sso/auto-sso", () => ({
  enqueueAutoSsoPush: vi.fn(async () => null),
  triggerAutoSso: vi.fn(async () => undefined),
}));
vi.mock("../server/sso/duty-sync", () => ({
  syncDutyToComunica: vi.fn(async () => undefined),
  enqueueDutySync: vi.fn(async () => 1),
  processPendingDutySyncs: vi.fn(async () => 0),
}));
const trackedPushMock = vi.hoisted(() =>
  vi.fn(async () => ({
    notificationId: 1,
    status: "PENDING" as const,
    phase: "TICKET_ACCEPTED" as const,
    ticketAccepted: true,
    providerAccepted: false,
  })),
);
const queuedPushMock = vi.hoisted(() =>
  vi.fn(async () => ({
    notificationId: 1,
    status: "PENDING" as const,
    phase: "QUEUED" as const,
    ticketAccepted: false,
    providerAccepted: false,
  })),
);
vi.mock("../server/push-delivery", () => ({
  sendTrackedPushNotification: trackedPushMock,
  enqueueTrackedPushNotification: queuedPushMock,
  processPendingPushDeliveries: vi.fn(async () => 0),
}));

type ActorKind = "plus" | "admin";

describe("hierarquia institution → hospital → sector", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionAId: number;
  let institutionBId: number;
  let hospitalAId: number;
  let hospitalBId: number;
  let sectorAId: number;
  let sectorA2Id: number;
  let sectorBId: number;
  let scheduleContextAId: number;
  let scheduleContextA2Id: number;
  let scheduleContextBId: number;
  let anesthesiaId: number;
  let templateAId: number;
  let plusUserId: number;
  let plusProfessionalId: number;
  let adminUserId: number;
  let recipientAUserId: number;
  let recipientA2UserId: number;
  let recipientBUserId: number;
  let poisonLinkUserId: number;
  let exactManagerUserId: number;
  let hospitalManagerUserId: number;
  let hospitalManagerProfessionalId: number;
  let otherSectorManagerUserId: number;
  let recipientAProfessionalId: number;
  let recipientA2ProfessionalId: number;
  let recipientBProfessionalId: number;
  let publicationShiftAId: number;
  let publicationShiftBId: number;
  let corruptNotificationShiftId: number;
  let membershipSourceShiftId: number;
  let validAssignmentAId: number;
  let validAssignmentA2Id: number;
  let validAssignmentBId: number;
  let mismatchedInstitutionAssignmentId: number;
  let mismatchedHospitalAssignmentId: number;
  let mismatchedSectorAssignmentId: number;
  let foreignProfessionalAssignmentId: number;
  let corruptShiftAssignmentId: number;
  const topologyAssignmentIds: number[] = [];

  const userIds: number[] = [];
  const professionalIds: number[] = [];
  const runId = randomUUID().replaceAll("-", "");
  const cnpjBase = BigInt(`0x${runId.slice(0, 12)}`).toString().slice(-12).padStart(12, "0");
  const publicationYearMonth = "2030-02";
  const publishYearMonth = publicationYearMonth;
  const lockYearMonth = "2030-04";
  const deepPublishYearMonth = "2030-05";
  const managerFuturePublishYearMonth = "2031-10";
  const managerFutureLockYearMonth = "2031-11";
  const membershipSourceYearMonth = "2030-08";
  const membershipTargetYearMonth = "2030-09";
  const publicationStart = new Date(`${publicationYearMonth}-10T07:00:00-03:00`);
  const publicationEnd = new Date(`${publicationYearMonth}-10T13:00:00-03:00`);

  const ctxFor = (kind: ActorKind) => {
    const isAdmin = kind === "admin";
    const userId = isAdmin ? adminUserId : plusUserId;
    return {
      user: {
        id: userId,
        role: isAdmin ? "admin" : "manager",
        name: isAdmin ? "Admin topology" : "Gestor+ topology",
        email: `${kind}-${runId}@test.local`,
        sessionVersion: 1,
      },
      institutionId: institutionAId,
      allowedInstitutionIds: [institutionAId],
    } as any;
  };

  const shiftsAs = (kind: ActorKind) => shiftsRouter.createCaller(ctxFor(kind));
  const calendarAs = (kind: ActorKind) => calendarRouter.createCaller(ctxFor(kind));
  const appAs = (userId: number, role: "doctor" | "manager" | "admin" = "doctor") =>
    appRouter.createCaller({
      user: {
        id: userId,
        role,
        name: `Topology reader ${userId}`,
        email: `topology-reader-${userId}-${runId}@test.local`,
        sessionVersion: 1,
      },
      institutionId: institutionAId,
      allowedInstitutionIds: [institutionAId],
    } as any);
  const shiftsAsUser = (userId: number) => shiftsRouter.createCaller({
    user: {
      id: userId,
      role: "doctor",
      name: `Topology reader ${userId}`,
      email: `topology-reader-${userId}-${runId}@test.local`,
      sessionVersion: 1,
    },
    institutionId: institutionAId,
    allowedInstitutionIds: [institutionAId],
  } as any);

  async function createPerson(
    tag: string,
    institutionId: number,
    globalRole: "admin" | "manager" | "doctor",
    roleInInstitution: "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS",
  ): Promise<{ userId: number; professionalId: number; email: string }> {
    const email = `topology-${tag}-${runId}@test.local`;
    const [user] = await db
      .insert(users)
      .values({ name: `Topology ${tag}`, email, passwordHash: "test", role: globalRole })
      .$returningId();
    const [professional] = await db
      .insert(professionals)
      .values({
        userId: user.id,
        name: `Topology ${tag}`,
        role: "Médico",
        userRole: roleInInstitution,
        medicalSpecialtyId: anesthesiaId,
        specialty: "Anestesiologia",
      })
      .$returningId();
    await db.insert(professionalInstitutions).values({
      professionalId: professional.id,
      userId: user.id,
      institutionId,
      roleInInstitution,
      isPrimary: true,
      active: true,
    });
    userIds.push(user.id);
    professionalIds.push(professional.id);
    return { userId: user.id, professionalId: professional.id, email };
  }

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;

    const [institutionA] = await db
      .insert(institutions)
      .values({
        name: `Topology A ${runId}`,
        cnpj: `${cnpjBase}01`,
        legalName: `Topology A ${runId}`,
        tradeName: `TA${runId}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionAId = institutionA.id;
    const [institutionB] = await db
      .insert(institutions)
      .values({
        name: `Topology B ${runId}`,
        cnpj: `${cnpjBase}02`,
        legalName: `Topology B ${runId}`,
        tradeName: `TB${runId}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionBId = institutionB.id;

    const [hospitalA] = await db
      .insert(hospitals)
      .values({ institutionId: institutionAId, name: `Topology Hospital A ${runId}` })
      .$returningId();
    hospitalAId = hospitalA.id;
    const [hospitalB] = await db
      .insert(hospitals)
      .values({ institutionId: institutionBId, name: `Topology Hospital B ${runId}` })
      .$returningId();
    hospitalBId = hospitalB.id;

    const [sectorA] = await db
      .insert(sectors)
      .values({
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        name: `Topology Sector A ${runId}`,
        category: "cirurgico",
        color: "#2563EB",
      })
      .$returningId();
    sectorAId = sectorA.id;
    const [sectorA2] = await db
      .insert(sectors)
      .values({
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        name: `Topology Sector A2 ${runId}`,
        category: "cirurgico",
        color: "#7C3AED",
      })
      .$returningId();
    sectorA2Id = sectorA2.id;
    const [sectorB] = await db
      .insert(sectors)
      .values({
        institutionId: institutionBId,
        hospitalId: hospitalBId,
        name: `Topology Sector B ${runId}`,
        category: "cirurgico",
        color: "#16A34A",
      })
      .$returningId();
    sectorBId = sectorB.id;
    anesthesiaId = await ensureTestAnesthesiaSpecialty(db);
    scheduleContextAId = await openTestScale(db, {
      institutionId: institutionAId,
      hospitalId: hospitalAId,
      sectorId: sectorAId,
    });
    scheduleContextA2Id = await openTestScale(db, {
      institutionId: institutionAId,
      hospitalId: hospitalAId,
      sectorId: sectorA2Id,
    });
    scheduleContextBId = await openTestScale(db, {
      institutionId: institutionBId,
      hospitalId: hospitalBId,
      sectorId: sectorBId,
    });

    const [templateA] = await db
      .insert(shiftTemplates)
      .values({
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        name: "Manhã",
        startTime: "07:00:00",
        endTime: "13:00:00",
      })
      .$returningId();
    templateAId = templateA.id;

    const plus = await createPerson("plus", institutionAId, "manager", "GESTOR_PLUS");
    plusUserId = plus.userId;
    plusProfessionalId = plus.professionalId;
    const admin = await createPerson("admin", institutionAId, "admin", "USER");
    adminUserId = admin.userId;
    const recipientA = await createPerson("recipient-a", institutionAId, "doctor", "USER");
    recipientAUserId = recipientA.userId;
    recipientAProfessionalId = recipientA.professionalId;
    const recipientA2 = await createPerson("recipient-a2", institutionAId, "doctor", "USER");
    recipientA2UserId = recipientA2.userId;
    recipientA2ProfessionalId = recipientA2.professionalId;
    const recipientB = await createPerson("recipient-b", institutionBId, "doctor", "USER");
    recipientBUserId = recipientB.userId;
    recipientBProfessionalId = recipientB.professionalId;
    await db.insert(professionalAccess).values([
      {
        institutionId: institutionAId,
        professionalId: recipientAProfessionalId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        canAccess: true,
      },
      {
        institutionId: institutionAId,
        professionalId: recipientA2ProfessionalId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        canAccess: true,
      },
      {
        institutionId: institutionBId,
        professionalId: recipientBProfessionalId,
        hospitalId: hospitalBId,
        sectorId: sectorBId,
        canAccess: true,
      },
    ]);
    const [poisonLinkUser] = await db
      .insert(users)
      .values({
        name: "Topology poison link",
        email: `topology-poison-link-${runId}@test.local`,
        passwordHash: "test",
        role: "doctor",
      })
      .$returningId();
    poisonLinkUserId = poisonLinkUser.id;
    userIds.push(poisonLinkUser.id);
    await db.insert(professionalInstitutions).values({
      professionalId: recipientBProfessionalId,
      userId: poisonLinkUser.id,
      institutionId: institutionAId,
      roleInInstitution: "USER",
      isPrimary: false,
      active: true,
    });
    const exactManager = await createPerson("manager-exact", institutionAId, "manager", "GESTOR_MEDICO");
    exactManagerUserId = exactManager.userId;
    const hospitalManager = await createPerson("manager-hospital", institutionAId, "manager", "GESTOR_MEDICO");
    hospitalManagerUserId = hospitalManager.userId;
    hospitalManagerProfessionalId = hospitalManager.professionalId;
    const otherSectorManager = await createPerson("manager-other", institutionAId, "manager", "GESTOR_MEDICO");
    otherSectorManagerUserId = otherSectorManager.userId;

    await db.insert(managerScope).values([
      {
        institutionId: institutionAId,
        managerProfessionalId: exactManager.professionalId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        active: true,
      },
      {
        institutionId: institutionAId,
        managerProfessionalId: hospitalManager.professionalId,
        hospitalId: hospitalAId,
        sectorId: null,
        active: true,
      },
      {
        institutionId: institutionAId,
        managerProfessionalId: otherSectorManager.professionalId,
        hospitalId: hospitalAId,
        sectorId: sectorA2Id,
        active: true,
      },
    ]);

    const [shiftA] = await db
      .insert(shiftInstances)
      .values({
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        scheduleContextId: scheduleContextAId,
        label: "Topology publication A",
        startAt: publicationStart,
        endAt: publicationEnd,
        status: "OCUPADO",
      })
      .$returningId();
    publicationShiftAId = shiftA.id;
    const [shiftB] = await db
      .insert(shiftInstances)
      .values({
        institutionId: institutionBId,
        hospitalId: hospitalBId,
        sectorId: sectorBId,
        scheduleContextId: scheduleContextBId,
        label: "Topology publication B",
        startAt: publicationStart,
        endAt: publicationEnd,
        status: "OCUPADO",
      })
      .$returningId();
    publicationShiftBId = shiftB.id;
    const [corruptShift] = await db
      .insert(shiftInstances)
      .values({
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        sectorId: sectorBId,
        label: "Topology corrupt notification",
        startAt: publicationStart,
        endAt: publicationEnd,
        status: "VAGO",
      })
      .$returningId();
    corruptNotificationShiftId = corruptShift.id;
    const [membershipSourceShift] = await db
      .insert(shiftInstances)
      .values({
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        scheduleContextId: scheduleContextAId,
        label: "Topology membership source",
        startAt: new Date(`${membershipSourceYearMonth}-10T07:00:00-03:00`),
        endAt: new Date(`${membershipSourceYearMonth}-10T13:00:00-03:00`),
        status: "OCUPADO",
      })
      .$returningId();
    membershipSourceShiftId = membershipSourceShift.id;

    const insertedAssignments = await db.insert(shiftAssignmentsV2).values([
      {
        shiftInstanceId: publicationShiftAId,
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        professionalId: recipientAProfessionalId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
      },
      {
        shiftInstanceId: publicationShiftBId,
        institutionId: institutionBId,
        hospitalId: hospitalBId,
        sectorId: sectorBId,
        professionalId: recipientBProfessionalId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
      },
      // Rows adversariais: as três primeiras divergem da tupla do shift A
      // em uma dimensão, mas usam profissional A válido para que o join de
      // vínculo não mascare a comparação sa↔si. A quarta repete A/A/A com
      // profissional só de B.
      {
        shiftInstanceId: publicationShiftAId,
        institutionId: institutionBId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        professionalId: recipientA2ProfessionalId,
        assignmentType: "BACKUP",
        status: "OCUPADO",
        isActive: true,
      },
      {
        shiftInstanceId: publicationShiftAId,
        institutionId: institutionAId,
        hospitalId: hospitalBId,
        sectorId: sectorAId,
        professionalId: recipientA2ProfessionalId,
        assignmentType: "ON_CALL",
        status: "OCUPADO",
        isActive: true,
      },
      {
        shiftInstanceId: publicationShiftAId,
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        sectorId: sectorBId,
        professionalId: recipientA2ProfessionalId,
        assignmentType: "BACKUP",
        status: "OCUPADO",
        isActive: true,
      },
      {
        shiftInstanceId: publicationShiftAId,
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        professionalId: recipientBProfessionalId,
        assignmentType: "ON_CALL",
        status: "OCUPADO",
        isActive: true,
      },
      // O próprio shift cruza A/hospitalA/sectorB, e a assignment repete
      // essa tupla. Só a validação canônica h/s consegue excluí-la.
      {
        shiftInstanceId: corruptNotificationShiftId,
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        sectorId: sectorBId,
        professionalId: recipientA2ProfessionalId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
      },
      // Origem isolada: tupla A válida e apenas o vínculo do profissional
      // é estrangeiro, tornando a checagem de PI load-bearing na réplica.
      {
        shiftInstanceId: membershipSourceShiftId,
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        professionalId: recipientBProfessionalId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
      },
      {
        shiftInstanceId: membershipSourceShiftId,
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        professionalId: recipientA2ProfessionalId,
        assignmentType: "BACKUP",
        status: "OCUPADO",
        isActive: true,
      },
    ]).$returningId();
    topologyAssignmentIds.push(...insertedAssignments.map((row) => row.id));
    validAssignmentAId = insertedAssignments[0].id;
    validAssignmentBId = insertedAssignments[1].id;
    mismatchedInstitutionAssignmentId = insertedAssignments[2].id;
    mismatchedHospitalAssignmentId = insertedAssignments[3].id;
    mismatchedSectorAssignmentId = insertedAssignments[4].id;
    foreignProfessionalAssignmentId = insertedAssignments[5].id;
    corruptShiftAssignmentId = insertedAssignments[6].id;
    validAssignmentA2Id = insertedAssignments[8].id;

    // Tupla deliberadamente envenenada: as FKs individuais aceitam A+B.
    // O lock deve falhar fechado sem modificar este registro.
    await db.insert(monthlyRosters).values({
      institutionId: institutionAId,
      hospitalId: hospitalBId,
      yearMonth: lockYearMonth,
      status: "PUBLISHED",
    });
    await db.insert(monthlyRosters).values({
      institutionId: institutionAId,
      hospitalId: hospitalAId,
      yearMonth: membershipTargetYearMonth,
      status: "PUBLISHED",
    });
  });

  afterAll(async () => {
    if (!db) return;
    const fixtureShifts = await db
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(inArray(shiftInstances.institutionId, [institutionAId, institutionBId]));
    const fixtureShiftIds = fixtureShifts.map((shift) => shift.id);
    await db
      .delete(dutyConfirmations)
      .where(inArray(dutyConfirmations.institutionId, [institutionAId, institutionBId]));
    await db.delete(auditTrail).where(inArray(auditTrail.institutionId, [institutionAId, institutionBId]));
    await db.delete(monthlyRosters).where(inArray(monthlyRosters.institutionId, [institutionAId, institutionBId]));
    if (fixtureShiftIds.length > 0) {
      await db.delete(shiftAuditLog).where(inArray(shiftAuditLog.shiftInstanceId, fixtureShiftIds));
      await db.delete(shiftAssignmentsV2).where(inArray(shiftAssignmentsV2.shiftInstanceId, fixtureShiftIds));
    }
    await db.delete(shiftInstances).where(inArray(shiftInstances.institutionId, [institutionAId, institutionBId]));
    await db.delete(shiftTemplates).where(eq(shiftTemplates.id, templateAId));
    await db.delete(managerScope).where(inArray(managerScope.institutionId, [institutionAId, institutionBId]));
    await db
      .delete(professionalAccess)
      .where(inArray(professionalAccess.professionalId, professionalIds));
    await db
      .delete(professionalInstitutions)
      .where(inArray(professionalInstitutions.institutionId, [institutionAId, institutionBId]));
    await db.delete(professionals).where(inArray(professionals.id, professionalIds));
    await db.delete(scheduleContexts).where(inArray(scheduleContexts.id, [scheduleContextAId, scheduleContextA2Id, scheduleContextBId]));
    await db.delete(sectors).where(inArray(sectors.id, [sectorAId, sectorA2Id, sectorBId]));
    await db.delete(hospitals).where(inArray(hospitals.id, [hospitalAId, hospitalBId]));
    await db.delete(institutions).where(inArray(institutions.id, [institutionAId, institutionBId]));
    await db.delete(users).where(inArray(users.id, userIds));
  });

  it("aceita somente tuplas coerentes, inclusive antes dos overrides de Gestor+ e admin", async () => {
    await expect(
      assertInstitutionHierarchy({
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
      }),
    ).resolves.toBeUndefined();

    for (const kind of ["plus", "admin"] as const) {
      const actor = await resolveTenantActor(
        kind === "admin" ? adminUserId : plusUserId,
        institutionAId,
        kind === "admin",
      );
      await expect(assertManagerScopeAccess(actor, hospitalAId, sectorAId)).resolves.toBeUndefined();
      await expect(assertManagerScopeAccess(actor, hospitalBId, sectorBId)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(assertManagerScopeAccess(actor, hospitalAId, sectorBId)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
  });

  it("listMyInstitutions retorna só vínculo, profissional, usuário e instituição canônicos", async () => {
    const listFor = (userId: number, role: "doctor" | "manager" = "doctor") =>
      appAs(userId, role).professionals.listMyInstitutions();

    const validBefore = await listFor(plusUserId, "manager");
    expect(validBefore.map((row) => row.id)).toContain(institutionAId);

    // PI aponta para o usuário poison, mas o profissional pertence a outro
    // usuário. A paridade professional.userId ↔ PI.userId é obrigatória.
    expect(await listFor(poisonLinkUserId)).toEqual([]);

    try {
      await db
        .update(institutions)
        .set({ isActive: false })
        .where(eq(institutions.id, institutionAId));
      expect(await listFor(plusUserId, "manager")).toEqual([]);
    } finally {
      await db
        .update(institutions)
        .set({ isActive: true })
        .where(eq(institutions.id, institutionAId));
    }

    try {
      await db
        .update(users)
        .set({ approvalStatus: "PENDING" })
        .where(eq(users.id, plusUserId));
      expect(await listFor(plusUserId, "manager")).toEqual([]);
    } finally {
      await db
        .update(users)
        .set({ approvalStatus: "APPROVED" })
        .where(eq(users.id, plusUserId));
    }

    try {
      await db
        .update(users)
        .set({ deletedAt: new Date() })
        .where(eq(users.id, plusUserId));
      expect(await listFor(plusUserId, "manager")).toEqual([]);
    } finally {
      await db
        .update(users)
        .set({ deletedAt: null })
        .where(eq(users.id, plusUserId));
    }

    const validAfter = await listFor(plusUserId, "manager");
    expect(validAfter.map((row) => row.id)).toContain(institutionAId);
  });

  for (const kind of ["plus", "admin"] as const) {
    describe(kind === "plus" ? "GESTOR_PLUS" : "admin global", () => {
      it("não abre nem auto-cria calendário com hospital/setor de outro tenant", async () => {
        const before = await db
          .select({ id: shiftInstances.id })
          .from(shiftInstances)
          .where(
            and(
              eq(shiftInstances.institutionId, institutionAId),
              eq(shiftInstances.hospitalId, hospitalBId),
              eq(shiftInstances.sectorId, sectorBId),
            ),
          );
        await expect(
          calendarAs(kind).getDay({
            institutionId: institutionAId,
            hospitalId: hospitalBId,
            sectorId: sectorBId,
            date: dayKeyBrt(new Date()),
          }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        const after = await db
          .select({ id: shiftInstances.id })
          .from(shiftInstances)
          .where(
            and(
              eq(shiftInstances.institutionId, institutionAId),
              eq(shiftInstances.hospitalId, hospitalBId),
              eq(shiftInstances.sectorId, sectorBId),
            ),
          );
        expect(after).toHaveLength(before.length);
      });

      it("não grava o override de setor estrangeiro em shifts.create", async () => {
        const before = await db
          .select({ id: shiftInstances.id })
          .from(shiftInstances)
          .where(
            and(
              eq(shiftInstances.institutionId, institutionAId),
              eq(shiftInstances.hospitalId, hospitalAId),
              eq(shiftInstances.sectorId, sectorBId),
            ),
          );
        await expect(
          shiftsAs(kind).create({
            date: dayKeyBrt(new Date()),
            shiftTemplateId: templateAId,
            sectorId: sectorBId,
          }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        const after = await db
          .select({ id: shiftInstances.id })
          .from(shiftInstances)
          .where(
            and(
              eq(shiftInstances.institutionId, institutionAId),
              eq(shiftInstances.hospitalId, hospitalAId),
              eq(shiftInstances.sectorId, sectorBId),
            ),
          );
        expect(after).toHaveLength(before.length);
      });

      it("não apresenta hospital estrangeiro como roster DRAFT", async () => {
        await expect(
          shiftsAs(kind).rosterStatus({ hospitalId: hospitalBId, yearMonth: publishYearMonth }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
      });

      it("não publica roster A+B", async () => {
        await expect(
          shiftsAs(kind).publish({
            institutionId: institutionAId,
            hospitalId: hospitalBId,
            yearMonth: publishYearMonth,
          }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        const rows = await db
          .select({ id: monthlyRosters.id })
          .from(monthlyRosters)
          .where(
            and(
              eq(monthlyRosters.institutionId, institutionAId),
              eq(monthlyRosters.hospitalId, hospitalBId),
              eq(monthlyRosters.yearMonth, publishYearMonth),
            ),
          );
        expect(rows).toHaveLength(0);
      });

      it("não tranca roster A+B previamente contaminado", async () => {
        const [before] = await db
          .select()
          .from(monthlyRosters)
          .where(
            and(
              eq(monthlyRosters.institutionId, institutionAId),
              eq(monthlyRosters.hospitalId, hospitalBId),
              eq(monthlyRosters.yearMonth, lockYearMonth),
            ),
          );
        await expect(
          shiftsAs(kind).lock({
            institutionId: institutionAId,
            hospitalId: hospitalBId,
            yearMonth: lockYearMonth,
          }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        const [after] = await db
          .select()
          .from(monthlyRosters)
          .where(eq(monthlyRosters.id, before.id));
        expect(after.status).toBe("PUBLISHED");
        expect(after.version).toBe(before.version);
        expect(after.lockedAt).toEqual(before.lockedAt);
        expect(after.lockedByUserId).toBe(before.lockedByUserId);
      });
    });
  }

  it("revalida a hierarquia nas fronteiras profundas de publish/lock", async () => {
    const plusActor = await resolveTenantActor(plusUserId, institutionAId, false);
    const adminActor = await resolveTenantActor(adminUserId, institutionAId, true);
    await expect(
      publishMonth(institutionAId, hospitalBId, deepPublishYearMonth, plusActor, 1),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      lockMonth(institutionAId, hospitalBId, lockYearMonth, adminActor, 1),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      publishMonth(institutionAId, hospitalAId, deepPublishYearMonth, adminActor, 1),
    ).resolves.toBeUndefined();
    await expect(
      lockMonth(institutionAId, hospitalAId, deepPublishYearMonth, adminActor, 1),
    ).resolves.toBeUndefined();

    const directPublishRows = await db
      .select({ id: monthlyRosters.id })
      .from(monthlyRosters)
      .where(
        and(
          eq(monthlyRosters.institutionId, institutionAId),
          eq(monthlyRosters.hospitalId, hospitalBId),
          eq(monthlyRosters.yearMonth, deepPublishYearMonth),
        ),
      );
    expect(directPublishRows).toHaveLength(0);
  });

  it("impede GESTOR_MEDICO de publicar ou trancar mês fora da janela autorizada", async () => {
    const managerActor = await resolveTenantActor(
      hospitalManagerUserId,
      institutionAId,
      false,
    );
    const [futureRoster] = await db
      .insert(monthlyRosters)
      .values({
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        yearMonth: managerFutureLockYearMonth,
        status: "PUBLISHED",
      })
      .$returningId();

    await expect(
      publishMonth(
        institutionAId,
        hospitalAId,
        managerFuturePublishYearMonth,
        managerActor,
        1,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      lockMonth(
        institutionAId,
        hospitalAId,
        managerFutureLockYearMonth,
        managerActor,
        1,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const publishRows = await db
      .select({ id: monthlyRosters.id })
      .from(monthlyRosters)
      .where(
        and(
          eq(monthlyRosters.institutionId, institutionAId),
          eq(monthlyRosters.hospitalId, hospitalAId),
          eq(monthlyRosters.yearMonth, managerFuturePublishYearMonth),
        ),
      );
    const [lockedCandidate] = await db
      .select({ status: monthlyRosters.status, lockedAt: monthlyRosters.lockedAt })
      .from(monthlyRosters)
      .where(eq(monthlyRosters.id, futureRoster.id));
    const lockAudits = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.entityId, futureRoster.id),
          eq(auditTrail.action, "ROSTER_LOCKED"),
        ),
      );
    expect(publishRows).toHaveLength(0);
    expect(lockedCandidate).toMatchObject({ status: "PUBLISHED", lockedAt: null });
    expect(lockAudits).toHaveLength(0);
  });

  it("não replica shift nem assignment de origem com topologia contaminada", async () => {
    await expect(
      shiftsAs("plus").replicateRange({
        hospitalId: hospitalAId,
        from: { start: `${publicationYearMonth}-01`, granularity: "month" },
        to: { start: "2030-06-01" },
        dryRun: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(
      shiftsAs("plus").replicateRange({
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        from: { start: `${publicationYearMonth}-01`, granularity: "month" },
        to: { start: "2030-07-01" },
        includeAssignments: true,
        dryRun: true,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const auditBefore = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.institutionId, institutionAId),
          eq(auditTrail.action, "CONFLICT_OVERRIDDEN"),
        ),
      );
    await expect(
      shiftsAs("plus").replicateRange({
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        from: { start: `${membershipSourceYearMonth}-01`, granularity: "month" },
        to: { start: `${membershipTargetYearMonth}-01` },
        includeAssignments: true,
        dryRun: false,
        reason: "Validação adversarial de topologia",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const auditAfter = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.institutionId, institutionAId),
          eq(auditTrail.action, "CONFLICT_OVERRIDDEN"),
        ),
      );
    const targetShifts = await db
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.institutionId, institutionAId),
          eq(shiftInstances.hospitalId, hospitalAId),
          eq(shiftInstances.sectorId, sectorAId),
          eq(shiftInstances.label, "Topology membership source"),
          eq(shiftInstances.startAt, new Date(`${membershipTargetYearMonth}-10T07:00:00-03:00`)),
        ),
      );
    expect(auditAfter).toEqual(auditBefore);
    expect(targetShifts).toHaveLength(0);
  });

  it("não assume vaga de shift contaminado nem deixa writes ou auditoria", async () => {
    const caller = appRouter.createCaller({
      user: {
        id: recipientAUserId,
        role: "doctor",
        name: "Topology recipient A",
        email: `topology-recipient-a-${runId}@test.local`,
        sessionVersion: 1,
      },
      institutionId: institutionAId,
      allowedInstitutionIds: [institutionAId],
    } as any);
    const [shiftBefore] = await db
      .select({ status: shiftInstances.status })
      .from(shiftInstances)
      .where(eq(shiftInstances.id, corruptNotificationShiftId));
    const assignmentsBefore = await db
      .select({ id: shiftAssignmentsV2.id })
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.shiftInstanceId, corruptNotificationShiftId));
    const auditsBefore = await db
      .select({ id: shiftAuditLog.id })
      .from(shiftAuditLog)
      .where(eq(shiftAuditLog.shiftInstanceId, corruptNotificationShiftId));

    await expect(
      caller.shiftAssignments.assumeVacancy({ shiftInstanceId: corruptNotificationShiftId }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const [shiftAfter] = await db
      .select({ status: shiftInstances.status })
      .from(shiftInstances)
      .where(eq(shiftInstances.id, corruptNotificationShiftId));
    const assignmentsAfter = await db
      .select({ id: shiftAssignmentsV2.id })
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.shiftInstanceId, corruptNotificationShiftId));
    const auditsAfter = await db
      .select({ id: shiftAuditLog.id })
      .from(shiftAuditLog)
      .where(eq(shiftAuditLog.shiftInstanceId, corruptNotificationShiftId));
    expect(shiftAfter).toEqual(shiftBefore);
    expect(assignmentsAfter).toEqual(assignmentsBefore);
    expect(auditsAfter).toEqual(auditsBefore);
  });

  it("listVacancies omite shift cuja instituição não corresponde ao hospital/setor exibido", async () => {
    const rows = await appAs(recipientAUserId).shiftInstances.listVacancies({});
    expect(rows.some((row) => row.shiftInstanceId === corruptNotificationShiftId)).toBe(false);
  });

  it("listMyVacancyRequests não atravessa assignment A para shift B", async () => {
    const [poisoned] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId: publicationShiftBId,
        institutionId: institutionAId,
        hospitalId: hospitalBId,
        sectorId: sectorBId,
        professionalId: recipientAProfessionalId,
        assignmentType: "ON_DUTY",
        status: "PENDENTE",
        isActive: true,
        createdBy: recipientAUserId,
      })
      .$returningId();
    try {
      const rows = await appAs(recipientAUserId).shiftAssignments.listMyVacancyRequests();
      expect(rows.some((row) => row.assignmentId === poisoned.id)).toBe(false);
    } finally {
      await db.delete(shiftAssignmentsV2).where(eq(shiftAssignmentsV2.id, poisoned.id));
    }
  });

  it("listPending não expõe candidato quando assignment e shift divergem de tenant", async () => {
    const [poisoned] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId: publicationShiftBId,
        institutionId: institutionAId,
        hospitalId: hospitalBId,
        sectorId: sectorBId,
        professionalId: recipientAProfessionalId,
        assignmentType: "BACKUP",
        status: "PENDENTE",
        isActive: true,
        createdBy: recipientAUserId,
      })
      .$returningId();
    try {
      const rows = await appAs(plusUserId, "manager").shiftAssignments.listPending({});
      expect(rows.some((row) => row.assignmentId === poisoned.id)).toBe(false);
    } finally {
      await db.delete(shiftAssignmentsV2).where(eq(shiftAssignmentsV2.id, poisoned.id));
    }
  });

  it("shifts.get recusa shift contaminado e retorna só assignments com tupla e PI canônicas", async () => {
    await expect(
      shiftsAs("plus").get({ id: corruptNotificationShiftId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const valid = await shiftsAs("plus").get({ id: publicationShiftAId });
    expect(valid.assignments.map((assignment) => assignment.id)).toEqual([validAssignmentAId]);
  });

  it("shifts.listByPeriod omite shift contaminado e assignments sem tupla/PI canônicas", async () => {
    const rows = await shiftsAs("plus").listByPeriod({
      startDate: new Date(publicationStart.getTime() - 1).toISOString(),
      endDate: new Date(publicationEnd.getTime() + 1).toISOString(),
    });
    expect(rows.map((row) => row.id)).toEqual([publicationShiftAId]);
    expect(rows[0].assignments.map((assignment) => assignment.id)).toEqual([validAssignmentAId]);
  });

  it("shifts.listAgenda omite topologia contaminada nos grupos e nos nomes profissionais", async () => {
    const result = await shiftsAs("plus").listAgenda({
      startDate: mondayOfKey(`${publicationYearMonth}-10`),
      weeks: 1,
      scope: "geral",
    });
    const rows = result.weeks.flatMap((week) =>
      week.days.flatMap((day) => day.groups.flatMap((group) => group.shifts)),
    );
    expect(rows.map((row) => row.id)).toEqual([publicationShiftAId]);
    expect(rows[0].professionalNames).toEqual([`Topology recipient-a`]);

    const mine = await shiftsAsUser(recipientAUserId).listAgenda({
      startDate: mondayOfKey(`${publicationYearMonth}-10`),
      weeks: 1,
      scope: "minha",
    });
    const myRows = mine.weeks.flatMap((week) =>
      week.days.flatMap((day) => day.groups.flatMap((group) => group.shifts)),
    );
    expect(myRows.map((row) => row.id)).toEqual([publicationShiftAId]);
    expect(myRows[0]).toMatchObject({
      professionalNames: [`Topology recipient-a`],
      isMine: true,
    });
  });

  it("getActiveShift/getNextShift não usam assignment ligado a shift de hierarquia contaminada", async () => {
    const reader = await createPerson("read-current", institutionAId, "doctor", "USER");
    const now = Date.now();
    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        sectorId: sectorBId,
        label: `Topology active poison ${runId}`,
        startAt: new Date(now - 60 * 60_000),
        endAt: new Date(now + 60 * 60_000),
        status: "OCUPADO",
      })
      .$returningId();
    const [assignment] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId: shift.id,
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        sectorId: sectorBId,
        professionalId: reader.professionalId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
        createdBy: reader.userId,
      })
      .$returningId();
    try {
      const caller = shiftsAsUser(reader.userId);
      await expect(caller.getActiveShift()).resolves.toBeNull();
      await expect(caller.getNextShift()).resolves.toBeNull();
    } finally {
      await db.delete(shiftAssignmentsV2).where(eq(shiftAssignmentsV2.id, assignment.id));
      await db.delete(shiftInstances).where(eq(shiftInstances.id, shift.id));
    }
  });

  it("calendário válido não expõe assignments estrangeiras ligadas ao shift", async () => {
    const day = await calendarAs("plus").getDay({
      institutionId: institutionAId,
      hospitalId: hospitalAId,
      sectorId: sectorAId,
      date: `${publicationYearMonth}-10`,
    });
    const professionalIds = day.shifts.flatMap((shift) =>
      shift.slots.flatMap((slot) =>
        "professionalId" in slot && typeof slot.professionalId === "number"
          ? [slot.professionalId]
          : [],
      ),
    );
    expect(professionalIds).toEqual([recipientAProfessionalId]);
  });

  it("seleciona destinatários somente quando assignment e shift compartilham a tupla", async () => {
    const emailsA = await getRosterPublicationEmails(
      institutionAId,
      hospitalAId,
      publicationYearMonth,
    );
    const emailsB = await getRosterPublicationEmails(
      institutionBId,
      hospitalBId,
      publicationYearMonth,
    );
    const crossTenantEmails = await getRosterPublicationEmails(
      institutionAId,
      hospitalBId,
      publicationYearMonth,
    );

    expect(emailsA).toEqual([`topology-recipient-a-${runId}@test.local`]);
    expect(emailsB).toEqual([`topology-recipient-b-${runId}@test.local`]);
    expect(crossTenantEmails).toEqual([]);
  });

  it("publicação persiste intent somente para o destinatário institucional filtrado", async () => {
    const notifyMock = vi.mocked(enqueueComunicaRosterPublished);
    notifyMock.mockClear();

    const plusActor = await resolveTenantActor(plusUserId, institutionAId, false);
    await publishMonth(institutionAId, hospitalAId, publicationYearMonth, plusActor, 1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hospitalId: hospitalAId,
        yearMonth: publicationYearMonth,
        targetUserId: recipientAUserId,
        targetEmail: `topology-recipient-a-${runId}@test.local`,
      }),
    );
  });

  it("dispatcher recusa assignment incoerente e recheck preserva o handoff gerencial sem PI original", async () => {
    await db
      .insert(monthlyRosters)
      .values([
        {
          institutionId: institutionAId,
          hospitalId: hospitalAId,
          yearMonth: publicationYearMonth,
          status: "PUBLISHED",
        },
        {
          institutionId: institutionBId,
          hospitalId: hospitalBId,
          yearMonth: publicationYearMonth,
          status: "PUBLISHED",
        },
      ])
      .onDuplicateKeyUpdate({ set: { status: "PUBLISHED" } });
    const autoSsoMock = vi.mocked(triggerAutoSso);
    const dutySyncMock = vi.mocked(syncDutyToComunica);
    trackedPushMock.mockClear();
    queuedPushMock.mockClear();
    autoSsoMock.mockClear();
    dutySyncMock.mockClear();

    try {
      await dispatchConfirmations(
        new Date("2030-02-09T22:00:00-03:00"),
        {
          notifyHour: 22,
          notifyMinute: 0,
          shiftStartTime: "07:00",
          shiftEndTime: "13:00",
          label: "Manhã",
          shiftNextDay: true,
        },
      );
      const dispatched = await db
        .select({ assignmentId: dutyConfirmations.assignmentId })
        .from(dutyConfirmations)
        .where(inArray(dutyConfirmations.assignmentId, topologyAssignmentIds));
      expect(new Set(dispatched.map((row) => row.assignmentId))).toEqual(
        new Set([validAssignmentAId, validAssignmentBId]),
      );
      expect(trackedPushMock).toHaveBeenCalledTimes(2);
      expect(queuedPushMock).toHaveBeenCalledTimes(2);
      expect(new Set(trackedPushMock.mock.calls.map(([input]) => input.userId))).toEqual(
        new Set([recipientAUserId, recipientBUserId]),
      );
      expect(trackedPushMock.mock.calls.some(([input]) => input.userId === recipientA2UserId)).toBe(false);

      await db
        .delete(dutyConfirmations)
        .where(inArray(dutyConfirmations.assignmentId, topologyAssignmentIds));
      trackedPushMock.mockClear();
      queuedPushMock.mockClear();

      const recheckNow = new Date("2030-02-10T12:00:00-03:00");
      const poisonedToken = randomUUID();
      const [poisoned] = await db
        .insert(dutyConfirmations)
        .values({
          institutionId: institutionAId,
          shiftInstanceId: publicationShiftAId,
          assignmentId: foreignProfessionalAssignmentId,
          professionalId: recipientBProfessionalId,
          userId: recipientBUserId,
          status: "PENDING",
          notifiedAt: new Date(recheckNow.getTime() - 60 * 60_000),
          recheckAt: new Date(recheckNow.getTime() - 1_000),
          confirmationToken: poisonedToken,
        })
        .$returningId();

      await processRechecks(recheckNow);
      const [after] = await db
        .select({
          status: dutyConfirmations.status,
          recheckAt: dutyConfirmations.recheckAt,
          managerNotified: dutyConfirmations.managerNotified,
        })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.id, poisoned.id));
      expect(after.status).toBe("PENDING");
      expect(after.recheckAt?.toISOString()).toBe(
        new Date(recheckNow.getTime() - 1_000).toISOString(),
      );
      expect(after.managerNotified).toBe(false);
      expect(trackedPushMock).not.toHaveBeenCalled();
      expect(new Set(queuedPushMock.mock.calls.map(([input]) => input.userId))).toEqual(
        new Set([plusUserId, exactManagerUserId, hospitalManagerUserId, adminUserId]),
      );
      expect(autoSsoMock).not.toHaveBeenCalled();
      expect(dutySyncMock).not.toHaveBeenCalled();

      const recipientCtx = (activeInstitutionId: number) => ({
        user: {
          id: recipientBUserId,
          role: "doctor",
          name: "Topology recipient B",
          email: `topology-recipient-b-${runId}@test.local`,
        },
        institutionId: activeInstitutionId,
        allowedInstitutionIds: [activeInstitutionId],
      }) as any;
      await expect(
        confirmationRouter.createCaller(recipientCtx(institutionBId)).getPending(),
      ).resolves.toBeNull();
      await expect(
        confirmationRouter.createCaller(recipientCtx(institutionBId)).confirm({
          confirmationToken: poisonedToken,
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        confirmationRouter.createCaller(recipientCtx(institutionAId)).getPending(),
      ).resolves.toBeNull();
      await expect(
        confirmationRouter.createCaller(recipientCtx(institutionAId)).confirm({
          confirmationToken: poisonedToken,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      await db
        .insert(monthlyRosters)
        .values({
          institutionId: institutionAId,
          hospitalId: hospitalAId,
          yearMonth: membershipSourceYearMonth,
          status: "PUBLISHED",
        })
        .onDuplicateKeyUpdate({ set: { status: "PUBLISHED" } });
      const pendingPair = await db
        .insert(dutyConfirmations)
        .values([
          {
            institutionId: institutionAId,
            shiftInstanceId: publicationShiftAId,
            assignmentId: mismatchedHospitalAssignmentId,
            professionalId: recipientA2ProfessionalId,
            userId: recipientA2UserId,
            status: "PENDING",
            notifiedAt: new Date(),
            confirmationToken: randomUUID(),
          },
          {
            institutionId: institutionAId,
            shiftInstanceId: membershipSourceShiftId,
            assignmentId: validAssignmentA2Id,
            professionalId: recipientA2ProfessionalId,
            userId: recipientA2UserId,
            status: "PENDING",
            notifiedAt: new Date(),
            confirmationToken: randomUUID(),
          },
        ])
        .$returningId();
      const pendingA2 = await confirmationRouter.createCaller({
        user: {
          id: recipientA2UserId,
          role: "doctor",
          name: "Topology recipient A2",
          email: `topology-recipient-a2-${runId}@test.local`,
        },
        institutionId: institutionAId,
        allowedInstitutionIds: [institutionAId],
      } as any).getPending();
      expect(pendingA2?.id).toBe(pendingPair[1].id);

      await db.delete(dutyConfirmations).where(eq(dutyConfirmations.id, poisoned.id));
      queuedPushMock.mockClear();
      const [startPoisoned] = await db
        .insert(dutyConfirmations)
        .values({
          institutionId: institutionAId,
          shiftInstanceId: publicationShiftAId,
          assignmentId: foreignProfessionalAssignmentId,
          professionalId: recipientBProfessionalId,
          userId: recipientBUserId,
          status: "CONFIRMED",
          notifiedAt: new Date(publicationStart.getTime() - 60 * 60_000),
          confirmationToken: `topology-start-${runId}`,
        })
        .$returningId();
      await processShiftStartPushes(new Date(publicationStart.getTime() + 2 * 60_000));
      const [startAfter] = await db
        .select({ startPushSentAt: dutyConfirmations.startPushSentAt })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.id, startPoisoned.id));
      expect(startAfter.startPushSentAt).toBeNull();
      expect(trackedPushMock).not.toHaveBeenCalled();
      expect(queuedPushMock).not.toHaveBeenCalled();
    } finally {
      await db
        .delete(dutyConfirmations)
        .where(inArray(dutyConfirmations.assignmentId, topologyAssignmentIds));
      trackedPushMock.mockClear();
    }
  });

  it("notifica apenas gestor do setor, gestor hospitalar e Gestor+ do tenant do turno", async () => {
    trackedPushMock.mockClear();
    queuedPushMock.mockClear();
    const confirmationIds: number[] = [];
    try {
      const [validConfirmation] = await db
        .insert(dutyConfirmations)
        .values({
          institutionId: institutionAId,
          shiftInstanceId: publicationShiftAId,
          assignmentId: validAssignmentAId,
          professionalId: recipientAProfessionalId,
          userId: recipientAUserId,
          status: "PENDING",
          notifiedAt: new Date(),
          confirmationToken: randomUUID(),
        })
        .$returningId();
      confirmationIds.push(validConfirmation.id);

      await notifyManagersConfirmationEscalation(validConfirmation.id, "NO_RESPONSE");
      const notified = new Set(queuedPushMock.mock.calls.map(([input]) => input.userId));
      expect(notified).toEqual(
        new Set([plusUserId, exactManagerUserId, hospitalManagerUserId, adminUserId]),
      );
      expect(notified.has(otherSectorManagerUserId)).toBe(false);
      expect(notified.has(adminUserId)).toBe(true);

      await db
        .update(professionalInstitutions)
        .set({ roleInInstitution: "USER" })
        .where(
          and(
            eq(professionalInstitutions.userId, exactManagerUserId),
            eq(professionalInstitutions.institutionId, institutionAId),
          ),
        );
      queuedPushMock.mockClear();
      await notifyManagersConfirmationEscalation(validConfirmation.id, "NO_RESPONSE");
      expect(new Set(queuedPushMock.mock.calls.map(([input]) => input.userId))).toEqual(
        new Set([plusUserId, hospitalManagerUserId, adminUserId]),
      );

      await db
        .update(professionalInstitutions)
        .set({ roleInInstitution: "GESTOR_MEDICO" })
        .where(
          and(
            eq(professionalInstitutions.userId, exactManagerUserId),
            eq(professionalInstitutions.institutionId, institutionAId),
          ),
        );
      await db
        .update(professionalInstitutions)
        .set({ userId: recipientBUserId })
        .where(
          and(
            eq(professionalInstitutions.professionalId, hospitalManagerProfessionalId),
            eq(professionalInstitutions.institutionId, institutionAId),
          ),
        );
      await expect(
        resolveTenantActor(recipientBUserId, institutionAId, false),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        resolveInstitutionForUser(recipientBUserId, institutionAId),
      ).rejects.toThrow("Tenant inválido para o usuário autenticado");
      queuedPushMock.mockClear();
      await notifyManagersConfirmationEscalation(validConfirmation.id, "NO_RESPONSE");
      expect(new Set(queuedPushMock.mock.calls.map(([input]) => input.userId))).toEqual(
        new Set([plusUserId, exactManagerUserId, adminUserId]),
      );
      expect(queuedPushMock.mock.calls.some(([input]) => input.userId === recipientBUserId)).toBe(false);
      await db
        .update(professionalInstitutions)
        .set({ userId: hospitalManagerUserId })
        .where(
          and(
            eq(professionalInstitutions.professionalId, hospitalManagerProfessionalId),
            eq(professionalInstitutions.institutionId, institutionAId),
          ),
        );

      await db
        .update(professionalInstitutions)
        .set({ userId: recipientBUserId })
        .where(
          and(
            eq(professionalInstitutions.professionalId, plusProfessionalId),
            eq(professionalInstitutions.institutionId, institutionAId),
          ),
        );
      queuedPushMock.mockClear();
      await notifyManagersConfirmationEscalation(validConfirmation.id, "NO_RESPONSE");
      expect(new Set(queuedPushMock.mock.calls.map(([input]) => input.userId))).toEqual(
        new Set([exactManagerUserId, hospitalManagerUserId, adminUserId]),
      );
      expect(queuedPushMock.mock.calls.some(([input]) => input.userId === recipientBUserId)).toBe(false);
      await db
        .update(professionalInstitutions)
        .set({ userId: plusUserId })
        .where(
          and(
            eq(professionalInstitutions.professionalId, plusProfessionalId),
            eq(professionalInstitutions.institutionId, institutionAId),
          ),
        );

      const poisonedValues = [
        {
          institutionId: institutionAId,
          shiftInstanceId: publicationShiftAId,
          assignmentId: mismatchedInstitutionAssignmentId,
          professionalId: recipientA2ProfessionalId,
          userId: recipientA2UserId,
        },
        {
          institutionId: institutionAId,
          shiftInstanceId: publicationShiftAId,
          assignmentId: mismatchedHospitalAssignmentId,
          professionalId: recipientA2ProfessionalId,
          userId: recipientA2UserId,
        },
        {
          institutionId: institutionAId,
          shiftInstanceId: publicationShiftAId,
          assignmentId: mismatchedSectorAssignmentId,
          professionalId: recipientA2ProfessionalId,
          userId: recipientA2UserId,
        },
        {
          institutionId: institutionAId,
          shiftInstanceId: publicationShiftBId,
          assignmentId: validAssignmentBId,
          professionalId: recipientBProfessionalId,
          userId: recipientBUserId,
        },
        {
          institutionId: institutionAId,
          shiftInstanceId: corruptNotificationShiftId,
          assignmentId: corruptShiftAssignmentId,
          professionalId: recipientA2ProfessionalId,
          userId: recipientA2UserId,
        },
        {
          institutionId: institutionAId,
          shiftInstanceId: publicationShiftAId,
          assignmentId: foreignProfessionalAssignmentId,
          professionalId: recipientBProfessionalId,
          userId: recipientBUserId,
        },
      ];
      for (const poisoned of poisonedValues) {
        const [inserted] = await db
          .insert(dutyConfirmations)
          .values({
            ...poisoned,
            status: "PENDING",
            notifiedAt: new Date(),
            confirmationToken: randomUUID(),
          })
          .$returningId();
        confirmationIds.push(inserted.id);
      }

      queuedPushMock.mockClear();
      for (const confirmationId of confirmationIds.slice(1, -1)) {
        await expect(
          notifyManagersConfirmationEscalation(confirmationId, "NO_RESPONSE"),
        ).rejects.toMatchObject({
          code: "FORBIDDEN",
        });
      }
      expect(queuedPushMock).not.toHaveBeenCalled();

      const confirmationWithoutOriginalMembership = confirmationIds.at(-1)!;
      await expect(
        notifyManagersConfirmationEscalation(
          confirmationWithoutOriginalMembership,
          "NO_RESPONSE",
        ),
      ).resolves.toEqual({ managerCount: 4, intentCount: 4 });
      expect(new Set(queuedPushMock.mock.calls.map(([input]) => input.userId))).toEqual(
        new Set([plusUserId, exactManagerUserId, hospitalManagerUserId, adminUserId]),
      );
    } finally {
      if (confirmationIds.length > 0) {
        await db.delete(dutyConfirmations).where(inArray(dutyConfirmations.id, confirmationIds));
      }
      await db
        .update(professionalInstitutions)
        .set({ userId: plusUserId })
        .where(
          and(
            eq(professionalInstitutions.professionalId, plusProfessionalId),
            eq(professionalInstitutions.institutionId, institutionAId),
          ),
        );
      await db
        .update(professionalInstitutions)
        .set({ userId: hospitalManagerUserId })
        .where(
          and(
            eq(professionalInstitutions.professionalId, hospitalManagerProfessionalId),
            eq(professionalInstitutions.institutionId, institutionAId),
          ),
        );
      await db
        .update(professionalInstitutions)
        .set({ roleInInstitution: "GESTOR_MEDICO" })
        .where(
          and(
            eq(professionalInstitutions.userId, exactManagerUserId),
            eq(professionalInstitutions.institutionId, institutionAId),
          ),
        );
      trackedPushMock.mockClear();
      queuedPushMock.mockClear();
    }
  });
});
