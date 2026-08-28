import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, like, or } from "drizzle-orm";
import { getDb } from "../server/db";
import {
  auditTrail,
  hospitals,
  institutions,
  monthlyRosters,
  notifications,
  professionalAccess,
  professionalInstitutions,
  professionals,
  scheduleContexts,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  swapRequests,
  users,
} from "../drizzle/schema";
import {
  ensureTestAnesthesiaSpecialty,
  openTestScale,
} from "./helpers/open-test-scale";
import { swapRouter } from "../server/swap-router";
import { enqueueComunicaSwapApproved } from "../server/integrations/comunica-plus";
import { actorCapabilities, resolveTenantActor } from "../server/_core/policy";
import {
  assertInstitutionHierarchy,
  listActiveInstitutionIdsForUser,
} from "../server/_core/tenant";
import { yearMonthBrt } from "../server/local-time";

const auditFailure = vi.hoisted(() => ({ enabled: false }));
const notificationFailure = vi.hoisted(() => ({ approved: false }));
const approvedIntentMock = vi.mocked(enqueueComunicaSwapApproved);

vi.mock("../server/audit-trail", async () => {
  const actual = await vi.importActual<typeof import("../server/audit-trail")>(
    "../server/audit-trail",
  );
  return {
    ...actual,
    recordAudit: vi.fn(async (...args: Parameters<typeof actual.recordAudit>) => {
      if (auditFailure.enabled) throw new Error("forced swap strict audit failure");
      return actual.recordAudit(...args);
    }),
  };
});

vi.mock("../server/integrations/comunica-plus", () => ({
  enqueueComunicaSwapApproved: vi.fn(async () => {
    if (notificationFailure.approved) throw new Error("forced approved notification failure");
    return 1;
  }),
}));

const PREFIX = "swap-topology-fc-";
const FOREIGN_CNPJ = "99999999008241";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type Identity = { userId: number; professionalId: number; accessId?: number };
type ShiftFixture = { shiftId: number; assignmentId: number };

describe("swaps: topologia e identidade fail-closed", () => {
  let db: Db;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let alternateSectorId: number;
  let foreignInstitutionId: number;
  let foreignHospitalId: number;
  let foreignSectorId: number;
  let anesthesiaId: number;
  let homeScheduleContextId: number;
  let alternateScheduleContextId: number;
  let foreignScheduleContextId: number;
  let source: Identity;
  let otherSource: Identity;
  let recipient: Identity;
  let manager: Identity;
  let malformedTarget: Identity;
  let noAccessTarget: Identity;

  const at = (dayOffset: number, hour: number): Date => {
    const value = new Date();
    value.setDate(value.getDate() + 180 + dayOffset);
    value.setHours(hour, 0, 0, 0);
    return value;
  };

  async function cleanupFixtures(): Promise<void> {
    const oldShifts = await db
      .select({
        id: shiftInstances.id,
        institutionId: shiftInstances.institutionId,
        hospitalId: shiftInstances.hospitalId,
        startAt: shiftInstances.startAt,
      })
      .from(shiftInstances)
      .where(like(shiftInstances.label, `${PREFIX}%`));
    const shiftIds = oldShifts.map(({ id }) => id);
    if (shiftIds.length > 0) {
      const oldSwaps = await db
        .select({ id: swapRequests.id })
        .from(swapRequests)
        .where(
          or(
            inArray(swapRequests.fromShiftInstanceId, shiftIds),
            inArray(swapRequests.toShiftInstanceId, shiftIds),
          ),
        );
      const swapIds = oldSwaps.map(({ id }) => id);
      await db.delete(auditTrail).where(inArray(auditTrail.shiftInstanceId, shiftIds));
      await db
        .delete(notifications)
        .where(inArray(notifications.shiftInstanceId, shiftIds));
      if (swapIds.length > 0) {
        await db.delete(auditTrail).where(inArray(auditTrail.entityId, swapIds));
      }
      await db
        .delete(swapRequests)
        .where(
          or(
            inArray(swapRequests.fromShiftInstanceId, shiftIds),
            inArray(swapRequests.toShiftInstanceId, shiftIds),
          ),
        );
      await db
        .delete(shiftAssignmentsV2)
        .where(inArray(shiftAssignmentsV2.shiftInstanceId, shiftIds));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, shiftIds));
    }
    const rosterTargets = new Map(
      oldShifts.map((shift) => {
        const yearMonth = yearMonthBrt(shift.startAt);
        return [
          `${shift.institutionId}:${shift.hospitalId}:${yearMonth}`,
          { ...shift, yearMonth },
        ] as const;
      }),
    );
    for (const target of rosterTargets.values()) {
      await db.delete(monthlyRosters).where(
        and(
          eq(monthlyRosters.institutionId, target.institutionId),
          eq(monthlyRosters.hospitalId, target.hospitalId),
          eq(monthlyRosters.yearMonth, target.yearMonth),
        ),
      );
    }

    const fixtureUsers = await db
      .select({ id: users.id })
      .from(users)
      .where(like(users.email, `${PREFIX}%`));
    const userIds = fixtureUsers.map(({ id }) => id);
    if (userIds.length > 0) {
      const fixtureProfessionals = await db
        .select({ id: professionals.id })
        .from(professionals)
        .where(inArray(professionals.userId, userIds));
      const professionalIds = fixtureProfessionals.map(({ id }) => id);
      await db.delete(auditTrail).where(inArray(auditTrail.actorUserId, userIds));
      if (professionalIds.length > 0) {
        await db
          .delete(professionalAccess)
          .where(inArray(professionalAccess.professionalId, professionalIds));
        await db
          .delete(professionalInstitutions)
          .where(inArray(professionalInstitutions.professionalId, professionalIds));
        await db.delete(professionals).where(inArray(professionals.id, professionalIds));
      }
      await db.delete(professionalInstitutions).where(inArray(professionalInstitutions.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }

    const baseExtraSectors = await db
      .select({ id: sectors.id })
      .from(sectors)
      .where(
        and(
          eq(sectors.institutionId, institutionId),
          like(sectors.name, `${PREFIX}%`),
        ),
      );
    if (baseExtraSectors.length > 0) {
      await db
        .delete(scheduleContexts)
        .where(inArray(scheduleContexts.sectorId, baseExtraSectors.map(({ id }) => id)));
      await db.delete(sectors).where(inArray(sectors.id, baseExtraSectors.map(({ id }) => id)));
    }

    const [foreignInstitution] = await db
      .select({ id: institutions.id })
      .from(institutions)
      .where(eq(institutions.cnpj, FOREIGN_CNPJ))
      .limit(1);
    if (foreignInstitution) {
      const foreignHospitals = await db
        .select({ id: hospitals.id })
        .from(hospitals)
        .where(eq(hospitals.institutionId, foreignInstitution.id));
      const foreignHospitalIds = foreignHospitals.map(({ id }) => id);
      await db.delete(scheduleContexts).where(eq(scheduleContexts.institutionId, foreignInstitution.id));
      await db.delete(monthlyRosters).where(eq(monthlyRosters.institutionId, foreignInstitution.id));
      if (foreignHospitalIds.length > 0) {
        await db
          .delete(monthlyRosters)
          .where(inArray(monthlyRosters.hospitalId, foreignHospitalIds));
      }
      await db.delete(sectors).where(eq(sectors.institutionId, foreignInstitution.id));
      if (foreignHospitalIds.length > 0) {
        await db.delete(hospitals).where(inArray(hospitals.id, foreignHospitalIds));
      }
      await db.delete(institutions).where(eq(institutions.id, foreignInstitution.id));
    }
  }

  async function createUser(label: string): Promise<number> {
    const [created] = await db
      .insert(users)
      .values({
        name: `${PREFIX}${label}`,
        email: `${PREFIX}${label}@example.test`,
        passwordHash: "not-used-by-router-tests",
        role: "doctor",
        approvalStatus: "APPROVED",
      })
      .$returningId();
    return created.id;
  }

  async function createIdentity(
    label: string,
    options: {
      access?: boolean;
      canonical?: boolean;
      roleInInstitution?: "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";
      tenantId?: number;
      tenantHospitalId?: number;
      tenantSectorId?: number;
    } = {},
  ): Promise<Identity> {
    const identityInstitutionId = options.tenantId ?? institutionId;
    const identityHospitalId = options.tenantHospitalId ?? hospitalId;
    const identitySectorId = options.tenantSectorId ?? sectorId;
    const userId = await createUser(label);
    const [professional] = await db
      .insert(professionals)
      .values({
        userId,
        name: `${PREFIX}${label}`,
        role: "Médico",
        specialty: "Anestesiologia",
        medicalSpecialtyId: anesthesiaId,
        userRole: "USER",
      })
      .$returningId();

    if (options.canonical !== false) {
      await db.insert(professionalInstitutions).values({
        professionalId: professional.id,
        userId,
        institutionId: identityInstitutionId,
        roleInInstitution: options.roleInInstitution ?? "USER",
        active: true,
      });
    }

    let accessId: number | undefined;
    if (options.access !== false) {
      const [access] = await db
        .insert(professionalAccess)
        .values({
          institutionId: identityInstitutionId,
          professionalId: professional.id,
          hospitalId: identityHospitalId,
          sectorId: identitySectorId,
          canAccess: true,
        })
        .$returningId();
      accessId = access.id;
    }
    return { userId, professionalId: professional.id, accessId };
  }

  async function createShift(
    owner: Identity,
    options: {
      dayOffset: number;
      startHour?: number;
      endHour?: number;
      shiftInstitutionId?: number;
      shiftHospitalId?: number;
      shiftSectorId?: number;
      assignmentInstitutionId?: number;
      assignmentHospitalId?: number;
      assignmentSectorId?: number;
      label?: string;
      startAt?: Date;
      endAt?: Date;
    },
  ): Promise<ShiftFixture> {
    const shiftInstitutionId = options.shiftInstitutionId ?? institutionId;
    const shiftHospitalId = options.shiftHospitalId ?? hospitalId;
    const shiftSectorId = options.shiftSectorId ?? sectorId;
    const startAt = options.startAt ?? at(options.dayOffset, options.startHour ?? 8);
    await db
      .insert(monthlyRosters)
      .values({
        institutionId: shiftInstitutionId,
        hospitalId: shiftHospitalId,
        yearMonth: yearMonthBrt(startAt),
        status: "PUBLISHED",
      })
      .onDuplicateKeyUpdate({ set: { status: "PUBLISHED" } });
    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId: shiftInstitutionId,
        hospitalId: shiftHospitalId,
        sectorId: shiftSectorId,
        scheduleContextId:
          shiftInstitutionId === institutionId &&
          shiftHospitalId === hospitalId &&
          shiftSectorId === sectorId
            ? homeScheduleContextId
            : shiftInstitutionId === institutionId &&
                shiftHospitalId === hospitalId &&
                shiftSectorId === alternateSectorId
              ? alternateScheduleContextId
              : shiftInstitutionId === foreignInstitutionId &&
                  shiftHospitalId === foreignHospitalId &&
                  shiftSectorId === foreignSectorId
                ? foreignScheduleContextId
                : null,
        label: `${PREFIX}${options.label ?? options.dayOffset}`,
        specialty: "Anestesiologia",
        startAt,
        endAt: options.endAt ?? at(options.dayOffset, options.endHour ?? 14),
        status: "OCUPADO",
      })
      .$returningId();
    const [assignment] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId: shift.id,
        institutionId: options.assignmentInstitutionId ?? shiftInstitutionId,
        hospitalId: options.assignmentHospitalId ?? shiftHospitalId,
        sectorId: options.assignmentSectorId ?? shiftSectorId,
        professionalId: owner.professionalId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
      })
      .$returningId();
    return { shiftId: shift.id, assignmentId: assignment.id };
  }

  async function insertSwap(input: {
    type?: "SWAP" | "TRANSFER" | "CESSAO";
    status: "PENDING" | "ACCEPTED";
    from: Identity;
    sourceShift: ShiftFixture;
    to?: Identity;
    toShift?: ShiftFixture;
    toAssignmentId?: number;
    institutionContextId?: number;
    hospitalContextId?: number;
    sectorContextId?: number | null;
    reason: string;
  }): Promise<number> {
    const [created] = await db
      .insert(swapRequests)
      .values({
        type: input.type ?? "CESSAO",
        status: input.status,
        fromProfessionalId: input.from.professionalId,
        fromUserId: input.from.userId,
        fromShiftInstanceId: input.sourceShift.shiftId,
        fromAssignmentId: input.sourceShift.assignmentId,
        toProfessionalId: input.to?.professionalId ?? null,
        toUserId: input.to?.userId ?? null,
        toShiftInstanceId: input.toShift?.shiftId ?? null,
        toAssignmentId: input.toAssignmentId ?? null,
        institutionId: input.institutionContextId ?? institutionId,
        hospitalId: input.hospitalContextId ?? hospitalId,
        sectorId: input.sectorContextId === undefined ? sectorId : input.sectorContextId,
        reason: `${PREFIX}${input.reason}`,
      })
      .$returningId();
    return created.id;
  }

  function callerAs(
    identity: Identity,
    globalRole: "doctor" | "admin" = "doctor",
    tenantId = institutionId,
    sessionVersion = 1,
  ) {
    return swapRouter.createCaller({
      user: {
        id: identity.userId,
        role: globalRole,
        name: `${PREFIX}caller`,
        email: `${identity.userId}@example.test`,
        sessionVersion,
      },
      institutionId: tenantId,
      allowedInstitutionIds: [tenantId],
    } as any);
  }

  async function expectSwapStatus(swapId: number, expected: string): Promise<void> {
    const [swap] = await db
      .select({ status: swapRequests.status })
      .from(swapRequests)
      .where(eq(swapRequests.id, swapId));
    expect(swap?.status).toBe(expected);
  }

  async function expectNoAudit(swapId: number, action: typeof auditTrail.$inferSelect.action) {
    const rows = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.institutionId, institutionId),
          eq(auditTrail.entityId, swapId),
          eq(auditTrail.action, action),
        ),
      );
    expect(rows).toHaveLength(0);
  }

  beforeAll(async () => {
    const connection = await getDb();
    if (!connection) throw new Error("Database not available");
    db = connection;

    const [institution] = await db.select({ id: institutions.id }).from(institutions).limit(1);
    if (!institution) throw new Error("Seed institution not found");
    institutionId = institution.id;
    const [hospital] = await db
      .select({ id: hospitals.id })
      .from(hospitals)
      .where(eq(hospitals.institutionId, institutionId))
      .limit(1);
    if (!hospital) throw new Error("Seed hospital not found");
    hospitalId = hospital.id;
    const [sector] = await db
      .select({ id: sectors.id })
      .from(sectors)
      .where(
        and(
          eq(sectors.institutionId, institutionId),
          eq(sectors.hospitalId, hospitalId),
        ),
      )
      .limit(1);
    if (!sector) throw new Error("Seed sector not found");
    sectorId = sector.id;

    await cleanupFixtures();

    const [alternateSector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `${PREFIX}alternate-sector`,
        category: "cirurgico",
        color: "#654321",
      })
      .$returningId();
    alternateSectorId = alternateSector.id;

    const [foreignInstitution] = await db
      .insert(institutions)
      .values({
        name: `${PREFIX}foreign-institution`,
        cnpj: FOREIGN_CNPJ,
      })
      .$returningId();
    foreignInstitutionId = foreignInstitution.id;
    const [foreignHospital] = await db
      .insert(hospitals)
      .values({ institutionId: foreignInstitutionId, name: `${PREFIX}foreign-hospital` })
      .$returningId();
    foreignHospitalId = foreignHospital.id;
    const [foreignSector] = await db
      .insert(sectors)
      .values({
        institutionId: foreignInstitutionId,
        hospitalId: foreignHospitalId,
        name: `${PREFIX}foreign-sector`,
        category: "cirurgico",
        color: "#123456",
      })
      .$returningId();
    foreignSectorId = foreignSector.id;
    anesthesiaId = await ensureTestAnesthesiaSpecialty(db);
    homeScheduleContextId = await openTestScale(db, {
      institutionId,
      hospitalId,
      sectorId,
    });
    alternateScheduleContextId = await openTestScale(db, {
      institutionId,
      hospitalId,
      sectorId: alternateSectorId,
    });
    foreignScheduleContextId = await openTestScale(db, {
      institutionId: foreignInstitutionId,
      hospitalId: foreignHospitalId,
      sectorId: foreignSectorId,
    });

    source = await createIdentity("source");
    otherSource = await createIdentity("other-source");
    recipient = await createIdentity("recipient");
    manager = await createIdentity("manager", { roleInInstitution: "GESTOR_PLUS" });
    noAccessTarget = await createIdentity("no-access-target", { access: false });

    const malformedActualUserId = await createUser("malformed-actual");
    const malformedDecoyUserId = await createUser("malformed-decoy");
    const [malformedProfessional] = await db
      .insert(professionals)
      .values({
        userId: malformedActualUserId,
        name: `${PREFIX}malformed-target`,
        role: "Médico",
        specialty: "Anestesiologia",
        medicalSpecialtyId: anesthesiaId,
        userRole: "USER",
      })
      .$returningId();
    await db.insert(professionalInstitutions).values({
      professionalId: malformedProfessional.id,
      userId: malformedDecoyUserId,
      institutionId,
      roleInInstitution: "USER",
      active: true,
    });
    const [malformedAccess] = await db
      .insert(professionalAccess)
      .values({
        institutionId,
        professionalId: malformedProfessional.id,
        hospitalId,
        sectorId,
        canAccess: true,
      })
      .$returningId();
    malformedTarget = {
      userId: malformedActualUserId,
      professionalId: malformedProfessional.id,
      accessId: malformedAccess.id,
    };
  });

  afterEach(async () => {
    auditFailure.enabled = false;
    notificationFailure.approved = false;
    const canonicalUserIds = [
      source?.userId,
      otherSource?.userId,
      recipient?.userId,
      manager?.userId,
      noAccessTarget?.userId,
    ].filter((id): id is number => typeof id === "number");
    if (canonicalUserIds.length > 0) {
      await db
        .update(users)
        .set({ sessionVersion: 1 })
        .where(inArray(users.id, canonicalUserIds));
    }
    if (foreignInstitutionId) {
      await db
        .update(institutions)
        .set({ isActive: true })
        .where(eq(institutions.id, foreignInstitutionId));
    }
    const canonicalProfessionals = [
      source?.professionalId,
      otherSource?.professionalId,
      recipient?.professionalId,
      manager?.professionalId,
      noAccessTarget?.professionalId,
    ].filter((id): id is number => typeof id === "number");
    if (canonicalProfessionals.length > 0) {
      await db
        .update(professionalInstitutions)
        .set({ active: true })
        .where(inArray(professionalInstitutions.professionalId, canonicalProfessionals));
    }
    if (manager?.professionalId) {
      await db
        .update(professionalInstitutions)
        .set({ roleInInstitution: "GESTOR_PLUS" })
        .where(
          and(
            eq(professionalInstitutions.professionalId, manager.professionalId),
            eq(professionalInstitutions.institutionId, institutionId),
          ),
        );
    }
    const accessIds = [source?.accessId, otherSource?.accessId, recipient?.accessId].filter(
      (id): id is number => typeof id === "number",
    );
    if (accessIds.length > 0) {
      await db
        .update(professionalAccess)
        .set({ canAccess: true })
        .where(inArray(professionalAccess.id, accessIds));
    }
  });

  afterAll(async () => {
    auditFailure.enabled = false;
    if (db && foreignInstitutionId) {
      await db
        .update(institutions)
        .set({ isActive: true })
        .where(eq(institutions.id, foreignInstitutionId));
    }
    if (db) await cleanupFixtures();
  });

  it("offer rejeita shift do tenant com hospital/setor estrangeiros sem swap ou audit", async () => {
    const poisoned = await createShift(source, {
      dayOffset: 1,
      shiftInstitutionId: institutionId,
      shiftHospitalId: foreignHospitalId,
      shiftSectorId: foreignSectorId,
      label: "foreign-topology",
    });

    await expect(
      callerAs(source).offer({
        type: "CESSAO",
        fromShiftInstanceId: poisoned.shiftId,
        fromAssignmentId: poisoned.assignmentId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const swaps = await db
      .select({ id: swapRequests.id })
      .from(swapRequests)
      .where(eq(swapRequests.fromAssignmentId, poisoned.assignmentId));
    const audits = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(eq(auditTrail.shiftInstanceId, poisoned.shiftId));
    expect(swaps).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it("offer rejeita divergência assignment↔shift e identidade professional↔user↔PI", async () => {
    const divergent = await createShift(source, {
      dayOffset: 2,
      assignmentSectorId: alternateSectorId,
      label: "assignment-divergence",
    });
    await expect(
      callerAs(source).offer({
        type: "CESSAO",
        fromShiftInstanceId: divergent.shiftId,
        fromAssignmentId: divergent.assignmentId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const canonical = await createShift(source, { dayOffset: 3, label: "bad-target-identity" });
    await expect(
      callerAs(source).offer({
        type: "CESSAO",
        fromShiftInstanceId: canonical.shiftId,
        fromAssignmentId: canonical.assignmentId,
        toProfessionalId: malformedTarget.professionalId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const rows = await db
      .select({ id: swapRequests.id })
      .from(swapRequests)
      .where(inArray(swapRequests.fromAssignmentId, [divergent.assignmentId, canonical.assignmentId]));
    expect(rows).toHaveLength(0);
  });

  it("offer exige professional_access presente e ativo para origem e destinatário", async () => {
    const revokedSource = await createShift(source, { dayOffset: 4, label: "revoked-source-access" });
    await db
      .update(professionalAccess)
      .set({ canAccess: false })
      .where(eq(professionalAccess.id, source.accessId!));
    await expect(
      callerAs(source).offer({
        type: "CESSAO",
        fromShiftInstanceId: revokedSource.shiftId,
        fromAssignmentId: revokedSource.assignmentId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db
      .update(professionalAccess)
      .set({ canAccess: true })
      .where(eq(professionalAccess.id, source.accessId!));

    const noAccess = await createShift(source, { dayOffset: 5, label: "missing-target-access" });
    await expect(
      callerAs(source).offer({
        type: "CESSAO",
        fromShiftInstanceId: noAccess.shiftId,
        fromAssignmentId: noAccess.assignmentId,
        toProfessionalId: noAccessTarget.professionalId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const rows = await db
      .select({ id: swapRequests.id })
      .from(swapRequests)
      .where(inArray(swapRequests.fromAssignmentId, [revokedSource.assignmentId, noAccess.assignmentId]));
    expect(rows).toHaveLength(0);
  });

  it("accept revalida a tupla SWAP e não aceita assignment com contexto divergente", async () => {
    const from = await createShift(source, { dayOffset: 6, startHour: 8, endHour: 12, label: "accept-from" });
    const to = await createShift(recipient, {
      dayOffset: 6,
      startHour: 14,
      endHour: 18,
      assignmentSectorId: alternateSectorId,
      label: "accept-to-divergent",
    });
    const swapId = await insertSwap({
      type: "SWAP",
      status: "PENDING",
      from: source,
      sourceShift: from,
      to: recipient,
      toShift: to,
      reason: "accept-divergent-tuple",
    });

    try {
      await expect(callerAs(recipient).accept({ swapRequestId: swapId })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expectSwapStatus(swapId, "PENDING");
      await expectNoAudit(swapId, "SWAP_ACCEPTED");
    } finally {
      // A sabotagem cumpriu sua função; não deve contaminar os cenários
      // seguintes, pois o helper global bloqueia qualquer profissional com
      // uma alocação ativa de topologia inválida.
      await db
        .update(shiftAssignmentsV2)
        .set({ isActive: false })
        .where(eq(shiftAssignmentsV2.id, to.assignmentId));
    }
  });

  it("accept recusa tupla ambígua com assignment ativo duplicado no mesmo turno", async () => {
    const from = await createShift(source, {
      dayOffset: 16,
      startHour: 8,
      endHour: 12,
      label: "duplicate-from",
    });
    const to = await createShift(recipient, {
      dayOffset: 16,
      startHour: 14,
      endHour: 18,
      label: "duplicate-to",
    });
    const [duplicate] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId: to.shiftId,
        institutionId,
        hospitalId,
        sectorId,
        professionalId: recipient.professionalId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
      })
      .$returningId();
    const swapId = await insertSwap({
      type: "SWAP",
      status: "PENDING",
      from: source,
      sourceShift: from,
      to: recipient,
      toShift: to,
      reason: "duplicate-to-assignment",
    });

    try {
      await expect(callerAs(recipient).accept({ swapRequestId: swapId })).rejects.toMatchObject({
        code: "CONFLICT",
      });
      await expectSwapStatus(swapId, "PENDING");
      await expectNoAudit(swapId, "SWAP_ACCEPTED");
    } finally {
      await db
        .update(shiftAssignmentsV2)
        .set({ isActive: false })
        .where(eq(shiftAssignmentsV2.id, duplicate.id));
    }
  });

  it.each([
    { kind: "vínculo institucional", dayOffset: 7, revoke: "membership" as const },
    { kind: "professional_access", dayOffset: 8, revoke: "access" as const },
  ])("effectuate falha fechado quando o $kind do receptor é revogado após accept", async ({ dayOffset, revoke }) => {
    const fixture = await createShift(source, { dayOffset, label: `revoked-after-accept-${revoke}` });
    const offered = await callerAs(source).offer({
      type: "CESSAO",
      fromShiftInstanceId: fixture.shiftId,
      fromAssignmentId: fixture.assignmentId,
      toProfessionalId: recipient.professionalId,
    });
    await callerAs(recipient).accept({ swapRequestId: offered.id });

    if (revoke === "membership") {
      await db
        .update(professionalInstitutions)
        .set({ active: false })
        .where(
          and(
            eq(professionalInstitutions.professionalId, recipient.professionalId),
            eq(professionalInstitutions.institutionId, institutionId),
          ),
        );
    } else {
      await db
        .update(professionalAccess)
        .set({ canAccess: false })
        .where(eq(professionalAccess.id, recipient.accessId!));
    }

    await expect(
      callerAs(source).approveByOwner({ swapRequestId: offered.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expectSwapStatus(offered.id, "ACCEPTED");
    const [original] = await db
      .select({ isActive: shiftAssignmentsV2.isActive })
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.id, fixture.assignmentId));
    const replacement = await db
      .select({ id: shiftAssignmentsV2.id })
      .from(shiftAssignmentsV2)
      .where(
        and(
          eq(shiftAssignmentsV2.shiftInstanceId, fixture.shiftId),
          eq(shiftAssignmentsV2.professionalId, recipient.professionalId),
          eq(shiftAssignmentsV2.isActive, true),
        ),
      );
    expect(original?.isActive).toBe(true);
    expect(replacement).toHaveLength(0);
    await expectNoAudit(offered.id, "CESSAO_APPROVED_BY_OWNER");
  });

  it("effectuate rejeita toAssignment fora da tupla toShift e mantém as duas escalas intactas", async () => {
    const from = await createShift(source, { dayOffset: 9, startHour: 8, endHour: 12, label: "tuple-from" });
    const to = await createShift(recipient, { dayOffset: 9, startHour: 14, endHour: 18, label: "tuple-to" });
    const wrong = await createShift(recipient, { dayOffset: 10, startHour: 14, endHour: 18, label: "tuple-wrong" });
    const swapId = await insertSwap({
      type: "SWAP",
      status: "ACCEPTED",
      from: source,
      sourceShift: from,
      to: recipient,
      toShift: to,
      toAssignmentId: wrong.assignmentId,
      reason: "wrong-to-assignment",
    });

    await expect(callerAs(source).approveByOwner({ swapRequestId: swapId })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expectSwapStatus(swapId, "ACCEPTED");
    const originals = await db
      .select({ id: shiftAssignmentsV2.id, isActive: shiftAssignmentsV2.isActive })
      .from(shiftAssignmentsV2)
      .where(inArray(shiftAssignmentsV2.id, [from.assignmentId, to.assignmentId, wrong.assignmentId]));
    expect(originals).toHaveLength(3);
    expect(originals.every(({ isActive }) => isActive)).toBe(true);
    await expectNoAudit(swapId, "SWAP_APPROVED_BY_OWNER");
  });

  it("list/listAvailable/getById omitem ou negam linhas com identidade envenenada e acesso revogado", async () => {
    const fixture = await createShift(source, { dayOffset: 11, label: "list-source" });
    const validId = await insertSwap({
      status: "PENDING",
      from: source,
      sourceShift: fixture,
      reason: "list-valid",
    });
    const poisonedId = await insertSwap({
      status: "PENDING",
      from: { ...source, userId: otherSource.userId },
      sourceShift: fixture,
      reason: "list-poisoned",
    });
    const nullContextId = await insertSwap({
      status: "PENDING",
      from: source,
      sourceShift: fixture,
      sectorContextId: null,
      reason: "list-null-sector-context",
    });

    const available = await callerAs(recipient).listAvailable({ type: "CESSAO" });
    expect(available.map(({ id }) => Number(id))).toContain(validId);
    expect(available.map(({ id }) => Number(id))).not.toContain(poisonedId);
    expect(available.map(({ id }) => Number(id))).not.toContain(nullContextId);

    const ownRows = await callerAs(source).list({ role: "OFFERER" });
    expect(ownRows.map(({ id }) => Number(id))).toContain(validId);
    expect(ownRows.map(({ id }) => Number(id))).not.toContain(poisonedId);
    expect(ownRows.map(({ id }) => Number(id))).not.toContain(nullContextId);
    await expect(callerAs(source).getById({ id: poisonedId })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(callerAs(source).getById({ id: nullContextId })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    await db
      .update(professionalAccess)
      .set({ canAccess: false })
      .where(eq(professionalAccess.id, recipient.accessId!));
    const afterRevocation = await callerAs(recipient).listAvailable({ type: "CESSAO" });
    expect(afterRevocation.map(({ id }) => Number(id))).not.toContain(validId);
  });

  it("auditoria strict é atômica em offer, accept e effectuate", async () => {
    const offerFixture = await createShift(source, { dayOffset: 12, label: "strict-offer" });
    auditFailure.enabled = true;
    await expect(
      callerAs(source).offer({
        type: "CESSAO",
        fromShiftInstanceId: offerFixture.shiftId,
        fromAssignmentId: offerFixture.assignmentId,
      }),
    ).rejects.toThrow("forced swap strict audit failure");
    auditFailure.enabled = false;
    const rolledBackOffers = await db
      .select({ id: swapRequests.id })
      .from(swapRequests)
      .where(eq(swapRequests.fromAssignmentId, offerFixture.assignmentId));
    expect(rolledBackOffers).toHaveLength(0);

    const acceptFixture = await createShift(source, { dayOffset: 13, label: "strict-accept" });
    const pendingId = await insertSwap({
      status: "PENDING",
      from: source,
      sourceShift: acceptFixture,
      to: recipient,
      reason: "strict-accept",
    });
    auditFailure.enabled = true;
    await expect(callerAs(recipient).accept({ swapRequestId: pendingId })).rejects.toThrow(
      "forced swap strict audit failure",
    );
    auditFailure.enabled = false;
    await expectSwapStatus(pendingId, "PENDING");
    await expectNoAudit(pendingId, "CESSAO_ACCEPTED");

    const effectuateFixture = await createShift(source, { dayOffset: 14, label: "strict-effectuate" });
    const acceptedId = await insertSwap({
      status: "ACCEPTED",
      from: source,
      sourceShift: effectuateFixture,
      to: recipient,
      reason: "strict-effectuate",
    });
    auditFailure.enabled = true;
    await expect(
      callerAs(source).approveByOwner({ swapRequestId: acceptedId }),
    ).rejects.toThrow("forced swap strict audit failure");
    auditFailure.enabled = false;
    await expectSwapStatus(acceptedId, "ACCEPTED");
    const [original] = await db
      .select({ isActive: shiftAssignmentsV2.isActive })
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.id, effectuateFixture.assignmentId));
    const replacement = await db
      .select({ id: shiftAssignmentsV2.id })
      .from(shiftAssignmentsV2)
      .where(
        and(
          eq(shiftAssignmentsV2.shiftInstanceId, effectuateFixture.shiftId),
          eq(shiftAssignmentsV2.professionalId, recipient.professionalId),
          eq(shiftAssignmentsV2.isActive, true),
        ),
      );
    expect(original?.isActive).toBe(true);
    expect(replacement).toHaveLength(0);
    await expectNoAudit(acceptedId, "CESSAO_APPROVED_BY_OWNER");
  });

  it("offer devolve o snapshot da transação sem leitura DB pós-commit", async () => {
    const fixture = await createShift(source, { dayOffset: 57, label: "offer-no-post-commit-read" });
    const originalTransaction = db.transaction.bind(db);
    const originalSelect = db.select.bind(db);
    let transactionCommitted = false;
    const transactionSpy = vi.spyOn(db, "transaction").mockImplementation((async (...args: any[]) => {
      const result = await (originalTransaction as any)(...args);
      transactionCommitted = true;
      return result;
    }) as typeof db.transaction);
    const selectSpy = vi.spyOn(db, "select").mockImplementation(((...args: any[]) => {
      if (transactionCommitted) throw new Error("forbidden post-commit select");
      return (originalSelect as any)(...args);
    }) as typeof db.select);

    let created: Awaited<ReturnType<ReturnType<typeof callerAs>["offer"]>> | undefined;
    try {
      created = await callerAs(source).offer({
        type: "CESSAO",
        fromShiftInstanceId: fixture.shiftId,
        fromAssignmentId: fixture.assignmentId,
      });
    } finally {
      selectSpy.mockRestore();
      transactionSpy.mockRestore();
    }

    expect(created).toMatchObject({
      type: "CESSAO",
      status: "PENDING",
      fromAssignmentId: fixture.assignmentId,
      institutionId,
    });
    if (!created) throw new Error("Oferta não retornou snapshot transacional");
    const audits = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.entityId, created.id),
          eq(auditTrail.action, "CESSAO_OFFERED"),
          eq(auditTrail.institutionId, institutionId),
        ),
      );
    expect(audits).toHaveLength(1);
  });

  it("remove outbound de aceite e faz rollback se o intent aprovado não persistir", async () => {
    const approvedCallsBefore = approvedIntentMock.mock.calls.length;
    const acceptFixture = await createShift(source, {
      dayOffset: 58,
      label: "accepted-notify-failure",
    });
    const pendingId = await insertSwap({
      status: "PENDING",
      from: source,
      sourceShift: acceptFixture,
      to: recipient,
      reason: "accepted-notify-failure",
    });
    const approveFixture = await createShift(source, {
      dayOffset: 59,
      label: "approved-notify-failure",
    });
    const acceptedId = await insertSwap({
      status: "ACCEPTED",
      from: source,
      sourceShift: approveFixture,
      to: recipient,
      reason: "approved-notify-failure",
    });

    await expect(callerAs(recipient).accept({ swapRequestId: pendingId })).resolves.toEqual({ ok: true });
    await expectSwapStatus(pendingId, "ACCEPTED");
    expect(approvedIntentMock.mock.calls).toHaveLength(approvedCallsBefore);

    try {
      notificationFailure.approved = true;
      await expect(
        callerAs(source).approveByOwner({ swapRequestId: acceptedId }),
      ).rejects.toThrow("forced approved notification failure");
    } finally {
      notificationFailure.approved = false;
    }
    await expectSwapStatus(acceptedId, "ACCEPTED");
    const activeAfterFailedIntent = await db
      .select({ professionalId: shiftAssignmentsV2.professionalId })
      .from(shiftAssignmentsV2)
      .where(
        and(
          eq(shiftAssignmentsV2.shiftInstanceId, approveFixture.shiftId),
          eq(shiftAssignmentsV2.isActive, true),
        ),
      );
    expect(activeAfterFailedIntent).toEqual([{ professionalId: source.professionalId }]);

    await expect(
      callerAs(source).approveByOwner({ swapRequestId: acceptedId }),
    ).resolves.toEqual({ ok: true });

    await expectSwapStatus(acceptedId, "APPROVED");
    expect(approvedIntentMock.mock.calls).toHaveLength(approvedCallsBefore + 3);
    expect(approvedIntentMock.mock.calls.slice(-2).map(([intent]) => intent)).toEqual([
      expect.objectContaining({
        swapId: acceptedId,
        recipientRole: "FROM",
        targetUserId: source.userId,
        targetEmail: `${PREFIX}source@example.test`,
      }),
      expect.objectContaining({
        swapId: acceptedId,
        recipientRole: "TO",
        targetUserId: recipient.userId,
        targetEmail: `${PREFIX}recipient@example.test`,
      }),
    ]);
    const audits = await db
      .select({ action: auditTrail.action, entityId: auditTrail.entityId })
      .from(auditTrail)
      .where(inArray(auditTrail.entityId, [pendingId, acceptedId]));
    expect(audits.filter(({ entityId, action }) => entityId === pendingId && action === "CESSAO_ACCEPTED")).toHaveLength(1);
    expect(audits.filter(({ entityId, action }) => entityId === acceptedId && action === "CESSAO_APPROVED_BY_OWNER")).toHaveLength(1);
  });

  it("sessão revogada durante a requisição barra os cinco writers sem efeito colateral", async () => {
    const offerFixture = await createShift(source, {
      dayOffset: 120,
      label: "stale-session-offer",
    });
    const acceptFixture = await createShift(source, {
      dayOffset: 121,
      label: "stale-session-accept",
    });
    const rejectFixture = await createShift(source, {
      dayOffset: 122,
      label: "stale-session-reject",
    });
    const approveFixture = await createShift(source, {
      dayOffset: 123,
      label: "stale-session-approve",
    });
    const cancelFixture = await createShift(source, {
      dayOffset: 124,
      label: "stale-session-cancel",
    });
    const acceptId = await insertSwap({
      status: "PENDING",
      from: source,
      sourceShift: acceptFixture,
      to: recipient,
      reason: "stale-session-accept",
    });
    const rejectId = await insertSwap({
      status: "PENDING",
      from: source,
      sourceShift: rejectFixture,
      to: recipient,
      reason: "stale-session-reject",
    });
    const approveId = await insertSwap({
      status: "ACCEPTED",
      from: source,
      sourceShift: approveFixture,
      to: recipient,
      reason: "stale-session-approve",
    });
    const cancelId = await insertSwap({
      status: "PENDING",
      from: source,
      sourceShift: cancelFixture,
      reason: "stale-session-cancel",
    });
    const scenarios: {
      label: string;
      actor: Identity;
      fixture: ShiftFixture;
      mutate: () => Promise<unknown>;
    }[] = [
      {
        label: "offer/source",
        actor: source,
        fixture: offerFixture,
        mutate: () => callerAs(source).offer({
          type: "CESSAO",
          fromShiftInstanceId: offerFixture.shiftId,
          fromAssignmentId: offerFixture.assignmentId,
        }),
      },
      {
        label: "accept/recipient",
        actor: recipient,
        fixture: acceptFixture,
        mutate: () => callerAs(recipient).accept({ swapRequestId: acceptId }),
      },
      {
        label: "reject/recipient",
        actor: recipient,
        fixture: rejectFixture,
        mutate: () => callerAs(recipient).reject({ swapRequestId: rejectId }),
      },
      {
        label: "approveByOwner/owner",
        actor: source,
        fixture: approveFixture,
        mutate: () => callerAs(source).approveByOwner({ swapRequestId: approveId }),
      },
      {
        label: "cancel/owner",
        actor: source,
        fixture: cancelFixture,
        mutate: () => callerAs(source).cancel({ swapRequestId: cancelId }),
      },
    ];

    for (const scenario of scenarios) {
      const readSwaps = () => db
        .select({
          id: swapRequests.id,
          status: swapRequests.status,
          version: swapRequests.version,
          reviewedByUserId: swapRequests.reviewedByUserId,
          reviewedAt: swapRequests.reviewedAt,
          reviewNote: swapRequests.reviewNote,
        })
        .from(swapRequests)
        .where(eq(swapRequests.fromAssignmentId, scenario.fixture.assignmentId))
        .orderBy(swapRequests.id);
      const readAssignments = () => db
        .select({
          id: shiftAssignmentsV2.id,
          professionalId: shiftAssignmentsV2.professionalId,
          isActive: shiftAssignmentsV2.isActive,
        })
        .from(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.shiftInstanceId, scenario.fixture.shiftId))
        .orderBy(shiftAssignmentsV2.id);
      const readActorAudits = () => db
        .select({ id: auditTrail.id, action: auditTrail.action, entityId: auditTrail.entityId })
        .from(auditTrail)
        .where(
          and(
            eq(auditTrail.institutionId, institutionId),
            eq(auditTrail.actorUserId, scenario.actor.userId),
          ),
        )
        .orderBy(auditTrail.id);
      const beforeSwaps = await readSwaps();
      const beforeAssignments = await readAssignments();
      const beforeAudits = await readActorAudits();
      const approvedCallsBefore = approvedIntentMock.mock.calls.length;

      await db
        .update(users)
        .set({ sessionVersion: 2 })
        .where(eq(users.id, scenario.actor.userId));
      try {
        await expect(scenario.mutate(), scenario.label).rejects.toMatchObject({
          code: "CONFLICT",
          message: expect.stringMatching(/sessão.*revogada/i),
        });
      } finally {
        await db
          .update(users)
          .set({ sessionVersion: 1 })
          .where(eq(users.id, scenario.actor.userId));
      }

      expect(await readSwaps(), scenario.label).toEqual(beforeSwaps);
      expect(await readAssignments(), scenario.label).toEqual(beforeAssignments);
      expect(await readActorAudits(), scenario.label).toEqual(beforeAudits);
      expect(approvedIntentMock.mock.calls, scenario.label).toHaveLength(
        approvedCallsBefore,
      );
    }
  });

  it("auditoria strict também faz rollback de reject e cancel", async () => {
    const peerFixture = await createShift(source, {
      dayOffset: 60,
      label: "strict-peer-reject",
    });
    const peerSwapId = await insertSwap({
      status: "PENDING",
      from: source,
      sourceShift: peerFixture,
      to: recipient,
      reason: "strict-peer-reject",
    });
    auditFailure.enabled = true;
    await expect(callerAs(recipient).reject({ swapRequestId: peerSwapId })).rejects.toThrow(
      "forced swap strict audit failure",
    );
    auditFailure.enabled = false;
    const [peerSwap] = await db
      .select({ status: swapRequests.status, version: swapRequests.version })
      .from(swapRequests)
      .where(eq(swapRequests.id, peerSwapId));
    expect(peerSwap).toMatchObject({ status: "PENDING", version: 1 });
    await expectNoAudit(peerSwapId, "CESSAO_REJECTED");

    const cancelFixture = await createShift(source, {
      dayOffset: 62,
      label: "strict-cancel",
    });
    const cancelSwapId = await insertSwap({
      status: "PENDING",
      from: source,
      sourceShift: cancelFixture,
      reason: "strict-cancel",
    });
    auditFailure.enabled = true;
    await expect(callerAs(source).cancel({ swapRequestId: cancelSwapId })).rejects.toThrow(
      "forced swap strict audit failure",
    );
    auditFailure.enabled = false;
    const [cancelSwap] = await db
      .select({ status: swapRequests.status, version: swapRequests.version })
      .from(swapRequests)
      .where(eq(swapRequests.id, cancelSwapId));
    expect(cancelSwap).toMatchObject({ status: "PENDING", version: 1 });
    await expectNoAudit(cancelSwapId, "CESSAO_CANCELLED");
  });

  it("endpoints legados do gestor negam SWAP/TRANSFER/CESSAO sem estado, audit ou outbound", async () => {
    const swapIds: number[] = [];
    const shiftIds: number[] = [];
    for (const [index, type] of (["SWAP", "TRANSFER", "CESSAO"] as const).entries()) {
      const fixture = await createShift(source, {
        dayOffset: 63 + index,
        label: `manager-read-only-${type.toLowerCase()}`,
      });
      shiftIds.push(fixture.shiftId);
      swapIds.push(await insertSwap({
        type,
        status: "ACCEPTED",
        from: source,
        sourceShift: fixture,
        to: recipient,
        reason: `manager-read-only-${type.toLowerCase()}`,
      }));
    }
    const beforeSwaps = await db
      .select({
        id: swapRequests.id,
        status: swapRequests.status,
        version: swapRequests.version,
        reviewedByUserId: swapRequests.reviewedByUserId,
        reviewedAt: swapRequests.reviewedAt,
        reviewNote: swapRequests.reviewNote,
      })
      .from(swapRequests)
      .where(inArray(swapRequests.id, swapIds));
    const beforeAssignments = await db
      .select({
        id: shiftAssignmentsV2.id,
        professionalId: shiftAssignmentsV2.professionalId,
        isActive: shiftAssignmentsV2.isActive,
      })
      .from(shiftAssignmentsV2)
      .where(inArray(shiftAssignmentsV2.shiftInstanceId, shiftIds));
    const auditsBefore = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(eq(auditTrail.actorUserId, manager.userId));
    const outboundCallsBefore = approvedIntentMock.mock.calls.length;

    for (const swapRequestId of swapIds) {
      await expect(callerAs(manager).approve({ swapRequestId })).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringMatching(/somente ao histórico/i),
      });
      await expect(callerAs(manager).rejectByManager({ swapRequestId })).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringMatching(/somente ao histórico/i),
      });
    }

    expect(
      await db
        .select({
          id: swapRequests.id,
          status: swapRequests.status,
          version: swapRequests.version,
          reviewedByUserId: swapRequests.reviewedByUserId,
          reviewedAt: swapRequests.reviewedAt,
          reviewNote: swapRequests.reviewNote,
        })
        .from(swapRequests)
        .where(inArray(swapRequests.id, swapIds)),
    ).toEqual(beforeSwaps);
    expect(
      await db
        .select({
          id: shiftAssignmentsV2.id,
          professionalId: shiftAssignmentsV2.professionalId,
          isActive: shiftAssignmentsV2.isActive,
        })
        .from(shiftAssignmentsV2)
        .where(inArray(shiftAssignmentsV2.shiftInstanceId, shiftIds)),
    ).toEqual(beforeAssignments);
    expect(
      await db
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(eq(auditTrail.actorUserId, manager.userId)),
    ).toEqual(auditsBefore);
    expect(approvedIntentMock.mock.calls).toHaveLength(outboundCallsBefore);
  });

  it("capability de gestor/admin é somente histórico e nunca aprovação", async () => {
    const managerActor = await resolveTenantActor(manager.userId, institutionId, false);
    const globalAdminActor = await resolveTenantActor(source.userId, institutionId, true);
    const userActor = await resolveTenantActor(source.userId, institutionId, false);

    expect(actorCapabilities(managerActor)).toMatchObject({
      canViewSwapHistory: true,
      canApproveSwaps: false,
    });
    expect(actorCapabilities(globalAdminActor)).toMatchObject({
      canViewSwapHistory: true,
      canApproveSwaps: false,
    });
    expect(actorCapabilities(userActor)).toMatchObject({
      canViewSwapHistory: false,
      canApproveSwaps: false,
    });
  });

  it("instituição inativa nega toda mutação de swap sem estado, audit ou outbound", async () => {
    const inactiveSource = await createIdentity("inactive-source", {
      tenantId: foreignInstitutionId,
      tenantHospitalId: foreignHospitalId,
      tenantSectorId: foreignSectorId,
    });
    const inactiveRecipient = await createIdentity("inactive-recipient", {
      tenantId: foreignInstitutionId,
      tenantHospitalId: foreignHospitalId,
      tenantSectorId: foreignSectorId,
    });
    const inactiveManager = await createIdentity("inactive-manager", {
      roleInInstitution: "GESTOR_PLUS",
      tenantId: foreignInstitutionId,
      tenantHospitalId: foreignHospitalId,
      tenantSectorId: foreignSectorId,
    });
    const offerFixture = await createShift(inactiveSource, {
      dayOffset: 110,
      shiftInstitutionId: foreignInstitutionId,
      shiftHospitalId: foreignHospitalId,
      shiftSectorId: foreignSectorId,
      label: "inactive-offer",
    });
    const acceptFixture = await createShift(inactiveSource, {
      dayOffset: 111,
      shiftInstitutionId: foreignInstitutionId,
      shiftHospitalId: foreignHospitalId,
      shiftSectorId: foreignSectorId,
      label: "inactive-accept",
    });
    const rejectFixture = await createShift(inactiveSource, {
      dayOffset: 112,
      shiftInstitutionId: foreignInstitutionId,
      shiftHospitalId: foreignHospitalId,
      shiftSectorId: foreignSectorId,
      label: "inactive-reject",
    });
    const approveFixture = await createShift(inactiveSource, {
      dayOffset: 113,
      shiftInstitutionId: foreignInstitutionId,
      shiftHospitalId: foreignHospitalId,
      shiftSectorId: foreignSectorId,
      label: "inactive-approve",
    });
    const cancelFixture = await createShift(inactiveSource, {
      dayOffset: 114,
      shiftInstitutionId: foreignInstitutionId,
      shiftHospitalId: foreignHospitalId,
      shiftSectorId: foreignSectorId,
      label: "inactive-cancel",
    });
    const pendingAcceptId = await insertSwap({
      status: "PENDING",
      from: inactiveSource,
      sourceShift: acceptFixture,
      to: inactiveRecipient,
      institutionContextId: foreignInstitutionId,
      hospitalContextId: foreignHospitalId,
      sectorContextId: foreignSectorId,
      reason: "inactive-accept",
    });
    const pendingRejectId = await insertSwap({
      status: "PENDING",
      from: inactiveSource,
      sourceShift: rejectFixture,
      to: inactiveRecipient,
      institutionContextId: foreignInstitutionId,
      hospitalContextId: foreignHospitalId,
      sectorContextId: foreignSectorId,
      reason: "inactive-reject",
    });
    const acceptedApproveId = await insertSwap({
      status: "ACCEPTED",
      from: inactiveSource,
      sourceShift: approveFixture,
      to: inactiveRecipient,
      institutionContextId: foreignInstitutionId,
      hospitalContextId: foreignHospitalId,
      sectorContextId: foreignSectorId,
      reason: "inactive-approve",
    });
    const pendingCancelId = await insertSwap({
      status: "PENDING",
      from: inactiveSource,
      sourceShift: cancelFixture,
      institutionContextId: foreignInstitutionId,
      hospitalContextId: foreignHospitalId,
      sectorContextId: foreignSectorId,
      reason: "inactive-cancel",
    });
    const swapIds = [pendingAcceptId, pendingRejectId, acceptedApproveId, pendingCancelId];
    const shiftIds = [
      offerFixture.shiftId,
      acceptFixture.shiftId,
      rejectFixture.shiftId,
      approveFixture.shiftId,
      cancelFixture.shiftId,
    ];
    const actorUserIds = [inactiveSource.userId, inactiveRecipient.userId, inactiveManager.userId];
    const readSwaps = () => db
      .select({
        id: swapRequests.id,
        status: swapRequests.status,
        version: swapRequests.version,
        reviewedByUserId: swapRequests.reviewedByUserId,
        reviewedAt: swapRequests.reviewedAt,
        reviewNote: swapRequests.reviewNote,
      })
      .from(swapRequests)
      .where(inArray(swapRequests.id, swapIds))
      .orderBy(swapRequests.id);
    const readAssignments = () => db
      .select({
        id: shiftAssignmentsV2.id,
        professionalId: shiftAssignmentsV2.professionalId,
        isActive: shiftAssignmentsV2.isActive,
      })
      .from(shiftAssignmentsV2)
      .where(inArray(shiftAssignmentsV2.shiftInstanceId, shiftIds))
      .orderBy(shiftAssignmentsV2.id);
    const readAudits = () => db
      .select({ id: auditTrail.id, action: auditTrail.action, entityId: auditTrail.entityId })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.institutionId, foreignInstitutionId),
          inArray(auditTrail.actorUserId, actorUserIds),
        ),
      )
      .orderBy(auditTrail.id);
    const beforeSwaps = await readSwaps();
    const beforeAssignments = await readAssignments();
    const beforeAudits = await readAudits();
    const beforeOfferRows = await db
      .select({ id: swapRequests.id })
      .from(swapRequests)
      .where(eq(swapRequests.fromAssignmentId, offerFixture.assignmentId));
    const approvedCallsBefore = approvedIntentMock.mock.calls.length;

    await db
      .update(institutions)
      .set({ isActive: false })
      .where(eq(institutions.id, foreignInstitutionId));
    try {
      await expect(listActiveInstitutionIdsForUser(inactiveSource.userId)).resolves.toEqual([]);
      await expect(
        assertInstitutionHierarchy({
          institutionId: foreignInstitutionId,
          hospitalId: foreignHospitalId,
          sectorId: foreignSectorId,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const sourceCaller = callerAs(inactiveSource, "doctor", foreignInstitutionId);
      const recipientCaller = callerAs(inactiveRecipient, "doctor", foreignInstitutionId);
      const managerCaller = callerAs(inactiveManager, "doctor", foreignInstitutionId);
      const mutations = [
        () => sourceCaller.offer({
          type: "CESSAO" as const,
          fromShiftInstanceId: offerFixture.shiftId,
          fromAssignmentId: offerFixture.assignmentId,
        }),
        () => recipientCaller.accept({ swapRequestId: pendingAcceptId }),
        () => recipientCaller.reject({ swapRequestId: pendingRejectId }),
        () => sourceCaller.approveByOwner({ swapRequestId: acceptedApproveId }),
        () => sourceCaller.cancel({ swapRequestId: pendingCancelId }),
        () => managerCaller.approve({ swapRequestId: acceptedApproveId }),
        () => managerCaller.rejectByManager({ swapRequestId: acceptedApproveId }),
      ];
      for (const mutate of mutations) {
        await expect(mutate()).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
    } finally {
      await db
        .update(institutions)
        .set({ isActive: true })
        .where(eq(institutions.id, foreignInstitutionId));
    }

    expect(await readSwaps()).toEqual(beforeSwaps);
    expect(await readAssignments()).toEqual(beforeAssignments);
    expect(await readAudits()).toEqual(beforeAudits);
    expect(
      await db
        .select({ id: swapRequests.id })
        .from(swapRequests)
        .where(eq(swapRequests.fromAssignmentId, offerFixture.assignmentId)),
    ).toEqual(beforeOfferRows);
    expect(approvedIntentMock.mock.calls).toHaveLength(approvedCallsBefore);
  });

  it("reject e cancel concorrentes fazem exatamente uma transição e uma auditoria", async () => {
    for (let round = 0; round < 10; round++) {
      const fixture = await createShift(source, {
        dayOffset: 70 + round,
        label: `reject-cancel-race-${round}`,
      });
      const swapId = await insertSwap({
        status: "PENDING",
        from: source,
        sourceShift: fixture,
        to: recipient,
        reason: `reject-cancel-race-${round}`,
      });
      const operations = [
        callerAs(recipient).reject({ swapRequestId: swapId }),
        callerAs(recipient).reject({ swapRequestId: swapId }),
        callerAs(source).cancel({ swapRequestId: swapId }),
      ];
      if (round % 2 === 1) operations.reverse();

      const results = await Promise.allSettled(operations);
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      const losers = results.filter(({ status }) => status === "rejected");
      expect(losers).toHaveLength(2);
      expect(losers).toEqual([
        expect.objectContaining({ reason: expect.objectContaining({ code: "CONFLICT" }) }),
        expect.objectContaining({ reason: expect.objectContaining({ code: "CONFLICT" }) }),
      ]);

      const [swap] = await db
        .select({ status: swapRequests.status, version: swapRequests.version })
        .from(swapRequests)
        .where(eq(swapRequests.id, swapId));
      expect(["REJECTED_BY_PEER", "CANCELLED"]).toContain(swap?.status);
      expect(swap?.version).toBe(2);
      const audits = await db
        .select({ action: auditTrail.action })
        .from(auditTrail)
        .where(
          and(
            eq(auditTrail.institutionId, institutionId),
            eq(auditTrail.entityId, swapId),
            inArray(auditTrail.action, ["CESSAO_REJECTED", "CESSAO_CANCELLED"]),
          ),
        );
      expect(audits).toHaveLength(1);
    }
  }, 30_000);

  it("nega origem iniciada e contrapartida passada em offer/list/accept/effectuate sem efeito colateral", async () => {
    const now = Date.now();
    const startedSource = await createShift(source, {
      dayOffset: 300,
      label: "started-source",
      startAt: new Date(now - 60 * 60_000),
      endAt: new Date(now + 60 * 60_000),
    });
    const futureSource = await createShift(source, {
      dayOffset: 301,
      label: "future-source-past-counterpart",
      startAt: new Date(now + 48 * 60 * 60_000),
      endAt: new Date(now + 54 * 60 * 60_000),
    });
    const pastCounterpart = await createShift(recipient, {
      dayOffset: 302,
      label: "past-counterpart",
      startAt: new Date(now - 6 * 60 * 60_000),
      endAt: new Date(now - 2 * 60 * 60_000),
    });

    const approvedCallsBefore = approvedIntentMock.mock.calls.length;
    await expect(
      callerAs(source).offer({
        type: "CESSAO",
        fromShiftInstanceId: startedSource.shiftId,
        fromAssignmentId: startedSource.assignmentId,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/iniciou|passou/i) });
    await expect(
      callerAs(source).offer({
        type: "SWAP",
        fromShiftInstanceId: futureSource.shiftId,
        fromAssignmentId: futureSource.assignmentId,
        toShiftInstanceId: pastCounterpart.shiftId,
        toProfessionalId: recipient.professionalId,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringMatching(/iniciou|passou/i) });
    expect(
      await db
        .select({ id: swapRequests.id })
        .from(swapRequests)
        .where(
          inArray(swapRequests.fromAssignmentId, [
            startedSource.assignmentId,
            futureSource.assignmentId,
          ]),
        ),
    ).toHaveLength(0);

    const pendingStartedId = await insertSwap({
      status: "PENDING",
      from: source,
      sourceShift: startedSource,
      to: recipient,
      reason: "pending-started-source",
    });
    const acceptedStartedId = await insertSwap({
      status: "ACCEPTED",
      from: source,
      sourceShift: startedSource,
      to: recipient,
      reason: "accepted-started-source",
    });
    const pendingPastCounterpartId = await insertSwap({
      type: "SWAP",
      status: "PENDING",
      from: source,
      sourceShift: futureSource,
      to: recipient,
      toShift: pastCounterpart,
      reason: "pending-past-counterpart",
    });
    const acceptedPastCounterpartId = await insertSwap({
      type: "SWAP",
      status: "ACCEPTED",
      from: source,
      sourceShift: futureSource,
      to: recipient,
      toShift: pastCounterpart,
      toAssignmentId: pastCounterpart.assignmentId,
      reason: "accepted-past-counterpart",
    });
    const swapIds = [
      pendingStartedId,
      acceptedStartedId,
      pendingPastCounterpartId,
      acceptedPastCounterpartId,
    ];
    const assignmentIds = [
      startedSource.assignmentId,
      futureSource.assignmentId,
      pastCounterpart.assignmentId,
    ];
    const assignmentsBefore = await db
      .select({
        id: shiftAssignmentsV2.id,
        professionalId: shiftAssignmentsV2.professionalId,
        status: shiftAssignmentsV2.status,
        isActive: shiftAssignmentsV2.isActive,
      })
      .from(shiftAssignmentsV2)
      .where(inArray(shiftAssignmentsV2.id, assignmentIds))
      .orderBy(shiftAssignmentsV2.id);

    const available = await callerAs(recipient).listAvailable({});
    expect(available.map(({ id }) => Number(id))).not.toEqual(
      expect.arrayContaining([pendingStartedId, pendingPastCounterpartId]),
    );
    await expect(callerAs(recipient).accept({ swapRequestId: pendingStartedId })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/iniciou|passou/i),
    });
    await expect(
      callerAs(recipient).accept({ swapRequestId: pendingPastCounterpartId }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/iniciou|passou/i),
    });
    await expect(
      callerAs(source).approveByOwner({ swapRequestId: acceptedStartedId }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/iniciou|passou/i),
    });
    await expect(
      callerAs(source).approveByOwner({ swapRequestId: acceptedPastCounterpartId }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringMatching(/iniciou|passou/i),
    });

    const swapsAfter = await db
      .select({ id: swapRequests.id, status: swapRequests.status, version: swapRequests.version })
      .from(swapRequests)
      .where(inArray(swapRequests.id, swapIds))
      .orderBy(swapRequests.id);
    expect(swapsAfter).toEqual([
      { id: pendingStartedId, status: "PENDING", version: 1 },
      { id: acceptedStartedId, status: "ACCEPTED", version: 1 },
      { id: pendingPastCounterpartId, status: "PENDING", version: 1 },
      { id: acceptedPastCounterpartId, status: "ACCEPTED", version: 1 },
    ]);
    expect(
      await db
        .select({
          id: shiftAssignmentsV2.id,
          professionalId: shiftAssignmentsV2.professionalId,
          status: shiftAssignmentsV2.status,
          isActive: shiftAssignmentsV2.isActive,
        })
        .from(shiftAssignmentsV2)
        .where(inArray(shiftAssignmentsV2.id, assignmentIds))
        .orderBy(shiftAssignmentsV2.id),
    ).toEqual(assignmentsBefore);
    expect(
      await db
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(inArray(auditTrail.entityId, swapIds)),
    ).toHaveLength(0);
    expect(approvedIntentMock.mock.calls).toHaveLength(approvedCallsBefore);
  });

  it("revalida o relógio sob lock em offer, accept e effectuate nas duas pontas", async () => {
    const operations = ["offer", "accept", "effectuate"] as const;
    const movedSides = ["source", "counterpart"] as const;
    const realNow = Date.now();
    let scenarioIndex = 0;

    for (const operation of operations) {
      for (const movedSide of movedSides) {
        const logicalNow = realNow + (30 + scenarioIndex * 3) * 24 * 60 * 60_000;
        let clockNow = logicalNow;
        const crossingStart = new Date(logicalNow + 5 * 60_000);
        const futureStart = new Date(logicalNow + 30 * 60_000);
        const sourceStart = movedSide === "source" ? crossingStart : futureStart;
        const counterpartStart = movedSide === "counterpart" ? crossingStart : futureStart;
        const sourceShift = await createShift(source, {
          dayOffset: 500 + scenarioIndex,
          label: `clock-lock-${operation}-${movedSide}-source`,
          startAt: sourceStart,
          endAt: new Date(sourceStart.getTime() + 2 * 60_000),
        });
        const counterpartShift = await createShift(recipient, {
          dayOffset: 500 + scenarioIndex,
          label: `clock-lock-${operation}-${movedSide}-counterpart`,
          startAt: counterpartStart,
          endAt: new Date(counterpartStart.getTime() + 2 * 60_000),
        });
        const storedStarts = await db
          .select({ id: shiftInstances.id, startAt: shiftInstances.startAt })
          .from(shiftInstances)
          .where(inArray(shiftInstances.id, [sourceShift.shiftId, counterpartShift.shiftId]));
        const storedSourceStart = storedStarts.find(({ id }) => id === sourceShift.shiftId)?.startAt;
        const storedCounterpartStart = storedStarts.find(
          ({ id }) => id === counterpartShift.shiftId,
        )?.startAt;
        if (!storedSourceStart || !storedCounterpartStart) {
          throw new Error("Turnos do cenário temporal não foram persistidos");
        }
        const crossingStoredStart =
          movedSide === "source" ? storedSourceStart : storedCounterpartStart;
        const stillFutureStoredStart =
          movedSide === "source" ? storedCounterpartStart : storedSourceStart;
        expect(storedSourceStart.getTime()).toBeGreaterThan(logicalNow);
        expect(storedCounterpartStart.getTime()).toBeGreaterThan(logicalNow);
        let swapId: number | null = null;
        if (operation !== "offer") {
          swapId = await insertSwap({
            type: "SWAP",
            status: operation === "accept" ? "PENDING" : "ACCEPTED",
            from: source,
            sourceShift,
            to: recipient,
            toShift: counterpartShift,
            toAssignmentId:
              operation === "effectuate" ? counterpartShift.assignmentId : undefined,
            reason: `clock-lock-${operation}-${movedSide}`,
          });
        }
        const scenario = `${operation}/${movedSide}`;
        const readSwaps = () =>
          db
            .select({
              id: swapRequests.id,
              status: swapRequests.status,
              version: swapRequests.version,
              toAssignmentId: swapRequests.toAssignmentId,
            })
            .from(swapRequests)
            .where(eq(swapRequests.fromAssignmentId, sourceShift.assignmentId))
            .orderBy(swapRequests.id);
        const readAssignments = () =>
          db
            .select({
              id: shiftAssignmentsV2.id,
              professionalId: shiftAssignmentsV2.professionalId,
              status: shiftAssignmentsV2.status,
              isActive: shiftAssignmentsV2.isActive,
            })
            .from(shiftAssignmentsV2)
            .where(
              inArray(shiftAssignmentsV2.id, [
                sourceShift.assignmentId,
                counterpartShift.assignmentId,
              ]),
            )
            .orderBy(shiftAssignmentsV2.id);
        const readAudits = () =>
          db
            .select({ id: auditTrail.id, action: auditTrail.action })
            .from(auditTrail)
            .where(
              and(
                eq(auditTrail.institutionId, institutionId),
                inArray(auditTrail.shiftInstanceId, [
                  sourceShift.shiftId,
                  counterpartShift.shiftId,
                ]),
              ),
            )
            .orderBy(auditTrail.id);
        const swapsBefore = await readSwaps();
        const assignmentsBefore = await readAssignments();
        const auditsBefore = await readAudits();
        const approvedCallsBefore = approvedIntentMock.mock.calls.length;
        const yearMonth = yearMonthBrt(storedSourceStart);
        expect(yearMonthBrt(storedCounterpartStart), scenario).toBe(yearMonth);

        let releaseMonth!: () => void;
        let monthLocked!: () => void;
        const release = new Promise<void>((resolve) => {
          releaseMonth = resolve;
        });
        const locked = new Promise<void>((resolve) => {
          monthLocked = resolve;
        });
        const originalTransaction = db.transaction.bind(db);
        const monthLocker = db.transaction(async (tx) => {
          await tx
            .update(monthlyRosters)
            .set({ status: "PUBLISHED" })
            .where(
              and(
                eq(monthlyRosters.institutionId, institutionId),
                eq(monthlyRosters.hospitalId, hospitalId),
                eq(monthlyRosters.yearMonth, yearMonth),
              ),
            );
          monthLocked();
          await release;
        });
        await locked;

        let writerTransactionStarted!: () => void;
        const writerEnteredTransaction = new Promise<void>((resolve) => {
          writerTransactionStarted = resolve;
        });
        const transactionSpy = vi
          .spyOn(db, "transaction")
          .mockImplementation((async (...args: any[]) => {
            writerTransactionStarted();
            return (originalTransaction as any)(...args);
          }) as typeof db.transaction);
        const clockSpy = vi.spyOn(Date, "now").mockImplementation(() => clockNow);
        let settled = false;
        const mutation =
          operation === "offer"
            ? callerAs(source).offer({
                type: "SWAP",
                fromShiftInstanceId: sourceShift.shiftId,
                fromAssignmentId: sourceShift.assignmentId,
                toShiftInstanceId: counterpartShift.shiftId,
                toProfessionalId: recipient.professionalId,
              })
            : operation === "accept"
              ? callerAs(recipient).accept({ swapRequestId: swapId! })
              : callerAs(source).approveByOwner({ swapRequestId: swapId! });
        const outcome = mutation
          .then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          )
          .finally(() => {
            settled = true;
          });
        try {
          await writerEnteredTransaction;
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(settled, scenario).toBe(false);
          clockNow = crossingStoredStart.getTime() + 1;
          expect(stillFutureStoredStart.getTime(), scenario).toBeGreaterThan(clockNow);
          releaseMonth();
          await monthLocker;
          await expect(outcome, scenario).resolves.toMatchObject({
            ok: false,
            error: {
              code: "BAD_REQUEST",
              message: expect.stringMatching(/iniciou|passou/i),
            },
          });
        } finally {
          releaseMonth();
          transactionSpy.mockRestore();
          clockSpy.mockRestore();
          await monthLocker;
        }

        expect(await readSwaps(), scenario).toEqual(swapsBefore);
        expect(await readAssignments(), scenario).toEqual(assignmentsBefore);
        expect(await readAudits(), scenario).toEqual(auditsBefore);
        expect(approvedIntentMock.mock.calls, scenario).toHaveLength(
          approvedCallsBefore,
        );
        scenarioIndex += 1;
      }
    }
  }, 30_000);

  it("accept compara snapshots vivos de origem e contrapartida após corrida move-to-DRAFT", async () => {
    for (const [index, movedSide] of (["source", "counterpart"] as const).entries()) {
      const sourceShift = await createShift(source, {
        dayOffset: 400 + index * 10,
        startHour: 8,
        endHour: 12,
        label: `move-draft-${movedSide}-source`,
      });
      const counterpartShift = await createShift(recipient, {
        dayOffset: 400 + index * 10,
        startHour: 14,
        endHour: 18,
        label: `move-draft-${movedSide}-counterpart`,
      });
      const swapId = await insertSwap({
        type: "SWAP",
        status: "PENDING",
        from: source,
        sourceShift,
        to: recipient,
        toShift: counterpartShift,
        reason: `move-draft-${movedSide}`,
      });
      const moved = movedSide === "source" ? sourceShift : counterpartShift;
      const [oldShift] = await db
        .select({ startAt: shiftInstances.startAt, endAt: shiftInstances.endAt })
        .from(shiftInstances)
        .where(eq(shiftInstances.id, moved.shiftId));
      const newStart = new Date(oldShift.startAt);
      newStart.setUTCMonth(newStart.getUTCMonth() + 72 + index * 3);
      const newEnd = new Date(newStart.getTime() + (oldShift.endAt.getTime() - oldShift.startAt.getTime()));
      const oldYearMonth = yearMonthBrt(oldShift.startAt);
      const newYearMonth = yearMonthBrt(newStart);
      expect(newYearMonth).not.toBe(oldYearMonth);
      await db
        .insert(monthlyRosters)
        .values({ institutionId, hospitalId, yearMonth: newYearMonth, status: "DRAFT" })
        .onDuplicateKeyUpdate({ set: { status: "DRAFT" } });

      let releaseMove!: () => void;
      let rosterLocked!: () => void;
      const canMove = new Promise<void>((resolve) => {
        releaseMove = resolve;
      });
      const hasRosterLock = new Promise<void>((resolve) => {
        rosterLocked = resolve;
      });
      const originalTransaction = db.transaction.bind(db);
      const mover = db.transaction(async (tx) => {
        await tx
          .update(monthlyRosters)
          .set({ status: "PUBLISHED" })
          .where(
            and(
              eq(monthlyRosters.institutionId, institutionId),
              eq(monthlyRosters.hospitalId, hospitalId),
              eq(monthlyRosters.yearMonth, oldYearMonth),
            ),
          );
        rosterLocked();
        await canMove;
        await tx
          .update(shiftInstances)
          .set({ startAt: newStart, endAt: newEnd })
          .where(eq(shiftInstances.id, moved.shiftId));
      });
      await hasRosterLock;

      let acceptTransactionStarted!: () => void;
      const acceptEnteredTransaction = new Promise<void>((resolve) => {
        acceptTransactionStarted = resolve;
      });
      const transactionSpy = vi
        .spyOn(db, "transaction")
        .mockImplementation((async (...args: any[]) => {
          acceptTransactionStarted();
          return (originalTransaction as any)(...args);
        }) as typeof db.transaction);
      const approvedCallsBefore = approvedIntentMock.mock.calls.length;
      const assignmentsBefore = await db
        .select({
          id: shiftAssignmentsV2.id,
          professionalId: shiftAssignmentsV2.professionalId,
          status: shiftAssignmentsV2.status,
          isActive: shiftAssignmentsV2.isActive,
        })
        .from(shiftAssignmentsV2)
        .where(inArray(shiftAssignmentsV2.id, [sourceShift.assignmentId, counterpartShift.assignmentId]))
        .orderBy(shiftAssignmentsV2.id);
      let settled = false;
      const acceptance = callerAs(recipient)
        .accept({ swapRequestId: swapId })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        )
        .finally(() => {
          settled = true;
        });
      try {
        await acceptEnteredTransaction;
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(settled, movedSide).toBe(false);
        releaseMove();
        await mover;
        const outcome = await acceptance;
        expect(outcome, movedSide).toMatchObject({
          ok: false,
          error: {
            code: "CONFLICT",
            message: expect.stringMatching(/topologia.*mudou/i),
          },
        });
      } finally {
        releaseMove();
        transactionSpy.mockRestore();
        await mover;
      }

      const [swap] = await db
        .select({ status: swapRequests.status, version: swapRequests.version })
        .from(swapRequests)
        .where(eq(swapRequests.id, swapId));
      expect(swap, movedSide).toEqual({ status: "PENDING", version: 1 });
      expect(
        await db
          .select({
            id: shiftAssignmentsV2.id,
            professionalId: shiftAssignmentsV2.professionalId,
            status: shiftAssignmentsV2.status,
            isActive: shiftAssignmentsV2.isActive,
          })
          .from(shiftAssignmentsV2)
          .where(inArray(shiftAssignmentsV2.id, [sourceShift.assignmentId, counterpartShift.assignmentId]))
          .orderBy(shiftAssignmentsV2.id),
        movedSide,
      ).toEqual(assignmentsBefore);
      await expectNoAudit(swapId, "SWAP_ACCEPTED");
      expect(approvedIntentMock.mock.calls, movedSide).toHaveLength(
        approvedCallsBefore,
      );
      const [destinationRoster] = await db
        .select({ status: monthlyRosters.status })
        .from(monthlyRosters)
        .where(
          and(
            eq(monthlyRosters.institutionId, institutionId),
            eq(monthlyRosters.hospitalId, hospitalId),
            eq(monthlyRosters.yearMonth, newYearMonth),
          ),
        );
      expect(destinationRoster?.status, movedSide).toBe("DRAFT");
    }
  }, 30_000);

  it("corrida cross-month em 20 rodadas alternadas permite exatamente uma efetivação sobreposta", async () => {
    const boundaryAt = (monthOffset: number) => {
      const now = new Date();
      const boundary = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthOffset, 1, 3, 0, 0, 0),
      );
      return {
        firstStart: new Date(boundary.getTime() - 60 * 60_000),
        firstEnd: new Date(boundary.getTime() + 2 * 60 * 60_000),
        secondStart: boundary,
        secondEnd: new Date(boundary.getTime() + 3 * 60 * 60_000),
      };
    };

    const rounds = Array.from(
      { length: 20 },
      (_, round) => [round, round % 2 === 1] as const,
    );
    for (const [round, reverse] of rounds) {
      const window = boundaryAt(18 + round * 2);
      const first = await createShift(source, {
        dayOffset: 15 + round * 2,
        label: `race-cross-month-first-${round}`,
        startAt: window.firstStart,
        endAt: window.firstEnd,
      });
      const second = await createShift(otherSource, {
        dayOffset: 16 + round * 2,
        label: `race-cross-month-second-${round}`,
        startAt: window.secondStart,
        endAt: window.secondEnd,
      });
      const firstSwapId = await insertSwap({
        status: "ACCEPTED",
        from: source,
        sourceShift: first,
        to: recipient,
        reason: `race-cross-month-first-${round}`,
      });
      const secondSwapId = await insertSwap({
        status: "ACCEPTED",
        from: otherSource,
        sourceShift: second,
        to: recipient,
        reason: `race-cross-month-second-${round}`,
      });
      const requests = [
        callerAs(source).approveByOwner({ swapRequestId: firstSwapId }),
        callerAs(otherSource).approveByOwner({ swapRequestId: secondSwapId }),
      ];
      if (reverse) requests.reverse();

      const results = await Promise.allSettled(requests);
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
      expect(results.find(({ status }) => status === "rejected")).toMatchObject({
        reason: { code: "CONFLICT" },
      });

      const swaps = await db
        .select({ status: swapRequests.status })
        .from(swapRequests)
        .where(inArray(swapRequests.id, [firstSwapId, secondSwapId]));
      expect(swaps.filter(({ status }) => status === "APPROVED")).toHaveLength(1);
      expect(swaps.filter(({ status }) => status === "ACCEPTED")).toHaveLength(1);
      const recipientAssignments = await db
        .select({ id: shiftAssignmentsV2.id })
        .from(shiftAssignmentsV2)
        .where(
          and(
            inArray(shiftAssignmentsV2.shiftInstanceId, [first.shiftId, second.shiftId]),
            eq(shiftAssignmentsV2.professionalId, recipient.professionalId),
            eq(shiftAssignmentsV2.isActive, true),
          ),
        );
      expect(recipientAssignments).toHaveLength(1);
      const approvalAudits = await db
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(
          and(
            eq(auditTrail.institutionId, institutionId),
            inArray(auditTrail.entityId, [firstSwapId, secondSwapId]),
            eq(auditTrail.action, "CESSAO_APPROVED_BY_OWNER"),
          ),
        );
      expect(approvalAudits).toHaveLength(1);
    }
  }, 60_000);
});
