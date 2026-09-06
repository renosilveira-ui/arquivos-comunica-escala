import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  auditTrail,
  dutyConfirmations,
  hospitals,
  institutions,
  managerScope,
  monthlyRosters,
  notifications,
  professionalAccess,
  professionalInstitutions,
  professionals,
  scheduleContexts,
  scheduleInvites,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../drizzle/schema";
import { confirmationRouter } from "../server/confirmation-router";
import {
  dutyShiftSnapshot,
  requireAuthorizedDutyConfirmationRecipient,
  requireValidDutyConfirmation,
} from "../server/confirmation-integrity";
import { dispatchConfirmations } from "../server/cron/shift-confirmation-dispatcher";
import { getDb } from "../server/db";
import { yearMonthBrt } from "../server/local-time";
import {
  enqueueTrackedPushNotification,
  processPendingPushDeliveries,
} from "../server/push-delivery";
import {
  ensureTestAnesthesiaSpecialty,
  openTestScale,
} from "./helpers/open-test-scale";

vi.mock("../server/notifications-service", async () => {
  const actual = await vi.importActual<
    typeof import("../server/notifications-service")
  >("../server/notifications-service");
  return {
    ...actual,
    sendPushNotification: vi.fn(async () => ({
      status: "NO_REGISTERED_TOKENS" as const,
      message: "no tokens",
      tickets: [],
      acceptedCount: 0,
      rejectedCount: 0,
    })),
  };
});
vi.mock("../server/sso/duty-sync", async () => {
  const actual = await vi.importActual<typeof import("../server/sso/duty-sync")>(
    "../server/sso/duty-sync",
  );
  return {
    ...actual,
    enqueueDutySync: vi.fn(async () => 1),
    processPendingDutySyncs: vi.fn(async () => 0),
  };
});
vi.mock("../server/sso/auto-sso", () => ({
  enqueueAutoSsoPush: vi.fn(async () => null),
  triggerAutoSso: vi.fn(async () => undefined),
}));
vi.mock("../server/sso/org-mapping", () => ({
  getComunicaOrgId: vi.fn(() => null),
  hasMappingFor: vi.fn(() => false),
}));
vi.mock("../server/integrations/comunica-plus", () => ({
  processPendingComunicaPlusOutbox: vi.fn(async () => 0),
}));

const TARDE = {
  notifyHour: 11,
  notifyMinute: 0,
  shiftStartTime: "13:00",
  shiftEndTime: "19:00",
  label: "Tarde",
  shiftNextDay: false,
};

describe("confirmation canonical current eligibility — MySQL", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  const stamp = Date.now();
  let institutionId: number;
  let institutionBId: number;
  let hospitalId: number;
  let hospitalBId: number;
  let sectorId: number;
  let sectorBId: number;
  let scheduleContextId: number;
  let scheduleContextBId: number;
  let anesthesiaSpecialtyId: number;
  let titularUserId: number;
  let titularProId: number;
  const userIds: number[] = [];
  const proIds: number[] = [];
  const day = "2036-06-15";
  const start13 = new Date(`${day}T13:00:00-03:00`);
  const end19 = new Date(`${day}T19:00:00-03:00`);
  const dueAt = new Date(`${day}T11:07:00-03:00`);

  const ctx = (userId: number, inst = institutionId) =>
    ({
      user: {
        id: userId,
        role: "doctor",
        name: "AuthZ",
        email: `${userId}@t.local`,
        sessionVersion: 1,
      },
      institutionId: inst,
      allowedInstitutionIds: [inst],
    }) as never;

  async function setRoster(
    status: "DRAFT" | "PUBLISHED" | "LOCKED",
    inst = institutionId,
    hosp = hospitalId,
  ) {
    await db
      .insert(monthlyRosters)
      .values({
        institutionId: inst,
        hospitalId: hosp,
        yearMonth: yearMonthBrt(start13),
        status,
      })
      .onDuplicateKeyUpdate({ set: { status } });
  }

  async function person(
    tag: string,
    opts: {
      institutionId: number;
      hospitalId: number;
      sectorId: number;
      role?: "USER" | "GESTOR_PLUS" | "GESTOR_MEDICO";
      access?: "exact" | "hospital-wide" | "none";
    },
  ) {
    const [u] = await db
      .insert(users)
      .values({
        name: `Canon ${tag} ${stamp}`,
        email: `canon-${tag}-${stamp}@test.local`,
        passwordHash: "test",
        role: "doctor",
      })
      .$returningId();
    const [p] = await db
      .insert(professionals)
      .values({
        userId: u.id,
        name: `Canon ${tag} ${stamp}`,
        role: "Médico",
        userRole: "USER",
        specialty: "Anestesiologia",
        medicalSpecialtyId: anesthesiaSpecialtyId,
      })
      .$returningId();
    await db.insert(professionalInstitutions).values({
      professionalId: p.id,
      userId: u.id,
      institutionId: opts.institutionId,
      roleInInstitution: opts.role ?? "USER",
      isPrimary: true,
      active: true,
    });
    if (opts.access === "exact") {
      await db.insert(professionalAccess).values({
        institutionId: opts.institutionId,
        professionalId: p.id,
        hospitalId: opts.hospitalId,
        sectorId: opts.sectorId,
        canAccess: true,
      });
    } else if (opts.access === "hospital-wide") {
      await db.insert(professionalAccess).values({
        institutionId: opts.institutionId,
        professionalId: p.id,
        hospitalId: opts.hospitalId,
        sectorId: null,
        canAccess: true,
      });
    }
    userIds.push(u.id);
    proIds.push(p.id);
    return { userId: u.id, proId: p.id };
  }

  async function occupy(
    professionalId: number,
    createdBy: number,
    inst = institutionId,
    hosp = hospitalId,
    sec = sectorId,
    ctxId = scheduleContextId,
  ) {
    const [s] = await db
      .insert(shiftInstances)
      .values({
        institutionId: inst,
        hospitalId: hosp,
        sectorId: sec,
        scheduleContextId: ctxId,
        label: `Canon ${stamp}`,
        startAt: start13,
        endAt: end19,
        status: "OCUPADO",
      })
      .$returningId();
    const [a] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId: s.id,
        institutionId: inst,
        hospitalId: hosp,
        sectorId: sec,
        professionalId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
        createdBy,
      })
      .$returningId();
    return { shiftId: s.id, assignmentId: a.id };
  }

  async function confirmationsFor(assignmentId: number) {
    return db
      .select()
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.assignmentId, assignmentId));
  }

  async function dispatch() {
    await dispatchConfirmations(dueAt, TARDE);
  }

  async function setPolicy(
    policy: "ALL_CFM_SPECIALTIES" | "QUALIFICATION_ALLOWLIST",
    contextId = scheduleContextId,
  ) {
    await db
      .update(scheduleContexts)
      .set({ admissionPolicy: policy })
      .where(eq(scheduleContexts.id, contextId));
  }

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;
    anesthesiaSpecialtyId = await ensureTestAnesthesiaSpecialty(db);
    const cnpj = `${stamp}`.slice(-14).padStart(14, "0");
    const [inst] = await db
      .insert(institutions)
      .values({
        name: `Canon A ${stamp}`,
        cnpj,
        legalName: `Canon A ${stamp}`,
        tradeName: `CanA${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = inst.id;
    const [instB] = await db
      .insert(institutions)
      .values({
        name: `Canon B ${stamp}`,
        cnpj: `${Number(cnpj) + 1}`.padStart(14, "0"),
        legalName: `Canon B ${stamp}`,
        tradeName: `CanB${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionBId = instB.id;
    const [h] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Canon Hosp A ${stamp}` })
      .$returningId();
    hospitalId = h.id;
    const [hB] = await db
      .insert(hospitals)
      .values({ institutionId: institutionBId, name: `Canon Hosp B ${stamp}` })
      .$returningId();
    hospitalBId = hB.id;
    const [sec] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `Canon Setor A ${stamp}`,
        category: "cirurgico",
        color: "#2563EB",
      })
      .$returningId();
    sectorId = sec.id;
    const [secB] = await db
      .insert(sectors)
      .values({
        institutionId: institutionBId,
        hospitalId: hospitalBId,
        name: `Canon Setor B ${stamp}`,
        category: "cirurgico",
        color: "#2563EB",
      })
      .$returningId();
    sectorBId = secB.id;
    scheduleContextId = await openTestScale(db, {
      institutionId,
      hospitalId,
      sectorId,
    });
    scheduleContextBId = await openTestScale(db, {
      institutionId: institutionBId,
      hospitalId: hospitalBId,
      sectorId: sectorBId,
    });
    const titular = await person("titular", {
      institutionId,
      hospitalId,
      sectorId,
      access: "exact",
    });
    titularUserId = titular.userId;
    titularProId = titular.proId;
  });

  async function wipeShifts() {
    const mine = await db
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(
        inArray(shiftInstances.institutionId, [institutionId, institutionBId]),
      );
    const ids = mine.map((row) => row.id);
    if (ids.length) {
      await db
        .delete(dutyConfirmations)
        .where(inArray(dutyConfirmations.shiftInstanceId, ids));
      await db
        .delete(notifications)
        .where(inArray(notifications.shiftInstanceId, ids));
      await db
        .delete(shiftAssignmentsV2)
        .where(inArray(shiftAssignmentsV2.shiftInstanceId, ids));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, ids));
    }
    await db
      .delete(monthlyRosters)
      .where(
        inArray(monthlyRosters.institutionId, [institutionId, institutionBId]),
      );
  }

  beforeEach(async () => {
    await wipeShifts();
    await setRoster("PUBLISHED");
    await setRoster("PUBLISHED", institutionBId, hospitalBId);
    await setPolicy("ALL_CFM_SPECIALTIES");
    await db
      .update(professionalAccess)
      .set({ canAccess: true })
      .where(eq(professionalAccess.professionalId, titularProId));
    await db
      .update(professionalInstitutions)
      .set({ active: true })
      .where(eq(professionalInstitutions.professionalId, titularProId));
    await db
      .update(users)
      .set({ approvalStatus: "APPROVED", deletedAt: null })
      .where(eq(users.id, titularUserId));
  });

  afterAll(async () => {
    await wipeShifts();
    await db
      .delete(scheduleInvites)
      .where(inArray(scheduleInvites.institutionId, [institutionId, institutionBId]));
    await db
      .delete(managerScope)
      .where(inArray(managerScope.institutionId, [institutionId, institutionBId]));
    await db
      .delete(professionalAccess)
      .where(inArray(professionalAccess.professionalId, proIds));
    await db
      .delete(professionalInstitutions)
      .where(inArray(professionalInstitutions.professionalId, proIds));
    await db.delete(professionals).where(inArray(professionals.id, proIds));
    await db
      .delete(scheduleContexts)
      .where(inArray(scheduleContexts.id, [scheduleContextId, scheduleContextBId]));
    await db
      .delete(auditTrail)
      .where(inArray(auditTrail.institutionId, [institutionId, institutionBId]));
    await db.delete(sectors).where(inArray(sectors.id, [sectorId, sectorBId]));
    await db.delete(hospitals).where(inArray(hospitals.id, [hospitalId, hospitalBId]));
    await db
      .delete(institutions)
      .where(inArray(institutions.id, [institutionId, institutionBId]));
    await db.delete(users).where(inArray(users.id, userIds));
  });

  it("titular com ACL exata: discovery, read, confirm e decline alinhados", async () => {
    const occupied = await occupy(titularProId, titularUserId);
    await dispatch();
    const [created] = await confirmationsFor(occupied.assignmentId);
    expect(created).toBeTruthy();
    const caller = confirmationRouter.createCaller(ctx(titularUserId));
    await expect(caller.getPending()).resolves.toMatchObject({ id: created.id });
    await expect(
      caller.confirm({ confirmationToken: created.confirmationToken }),
    ).resolves.toMatchObject({ status: "CONFIRMED" });

    const second = await occupy(titularProId, titularUserId);
    await dispatch();
    const [pending] = await confirmationsFor(second.assignmentId);
    const again = confirmationRouter.createCaller(ctx(titularUserId));
    await expect(
      again.decline({ confirmationToken: pending.confirmationToken }),
    ).resolves.toMatchObject({ status: "DECLINED" });
  });

  it("legado ALL_CFM + hospital-wide: confirmação autorizada", async () => {
    const wide = await person("wide-ok", {
      institutionId,
      hospitalId,
      sectorId,
      access: "hospital-wide",
    });
    const occupied = await occupy(wide.proId, wide.userId);
    await dispatch();
    const rows = await confirmationsFor(occupied.assignmentId);
    expect(rows).toHaveLength(1);
    const caller = confirmationRouter.createCaller(ctx(wide.userId));
    await expect(caller.getPending()).resolves.toMatchObject({ id: rows[0]!.id });
    await expect(
      caller.confirm({ confirmationToken: rows[0]!.confirmationToken }),
    ).resolves.toMatchObject({ status: "CONFIRMED" });
  });

  it("QUALIFICATION_ALLOWLIST + só hospital-wide: zero autoridade; exact sector libera", async () => {
    await setPolicy("QUALIFICATION_ALLOWLIST");
    const wide = await person("wide-deny", {
      institutionId,
      hospitalId,
      sectorId,
      access: "hospital-wide",
    });
    const occupied = await occupy(wide.proId, wide.userId);
    await dispatch();
    expect(await confirmationsFor(occupied.assignmentId)).toHaveLength(0);

    await db.insert(professionalAccess).values({
      institutionId,
      professionalId: wide.proId,
      hospitalId,
      sectorId,
      canAccess: true,
    });
    await dispatch();
    const rows = await confirmationsFor(occupied.assignmentId);
    expect(rows).toHaveLength(1);
    const caller = confirmationRouter.createCaller(ctx(wide.userId));
    await expect(caller.getPending()).resolves.toMatchObject({ id: rows[0]!.id });
    await expect(
      caller.confirm({ confirmationToken: rows[0]!.confirmationToken }),
    ).resolves.toMatchObject({ status: "CONFIRMED" });
  });

  it("GESTOR_PLUS sem ACL não materializa nem confirma", async () => {
    const plus = await person("plus", {
      institutionId,
      hospitalId,
      sectorId,
      role: "GESTOR_PLUS",
      access: "none",
    });
    const occupied = await occupy(plus.proId, plus.userId);
    await dispatch();
    expect(await confirmationsFor(occupied.assignmentId)).toHaveLength(0);

    const [phantom] = await db
      .insert(dutyConfirmations)
      .values({
        institutionId,
        shiftInstanceId: occupied.shiftId,
        assignmentId: occupied.assignmentId,
        professionalId: plus.proId,
        userId: plus.userId,
        status: "PENDING",
        confirmationToken: randomUUID(),
      })
      .$returningId();
    const [row] = await db
      .select()
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, phantom.id));
    const caller = confirmationRouter.createCaller(ctx(plus.userId));
    await expect(caller.getPending()).resolves.toBeNull();
    await expect(
      caller.confirm({ confirmationToken: row.confirmationToken }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.decline({ confirmationToken: row.confirmationToken }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [unchanged] = await db
      .select({ status: dutyConfirmations.status })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, phantom.id));
    expect(unchanged.status).toBe("PENDING");
  });

  it("manager_scope sem professional_access não concede confirmação", async () => {
    const manager = await person("scope", {
      institutionId,
      hospitalId,
      sectorId,
      role: "GESTOR_MEDICO",
      access: "none",
    });
    await db.insert(managerScope).values({
      institutionId,
      managerProfessionalId: manager.proId,
      hospitalId,
      sectorId: null,
      active: true,
    });
    const occupied = await occupy(manager.proId, manager.userId);
    await dispatch();
    expect(await confirmationsFor(occupied.assignmentId)).toHaveLength(0);
  });

  it("convite pendente sem access não materializa confirmation", async () => {
    const invitee = await person("invite", {
      institutionId,
      hospitalId,
      sectorId,
      access: "none",
    });
    await db.insert(scheduleInvites).values({
      institutionId,
      hospitalId,
      sectorId,
      codeHash: createHash("sha256").update(`canon-invite-${stamp}`).digest("hex"),
      createdByUserId: titularUserId,
      invitedUserId: invitee.userId,
      invitedEmail: `invitee-${stamp}@test.local`,
      maxRedemptions: 1,
      redeemedCount: 0,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const occupied = await occupy(invitee.proId, titularUserId);
    await dispatch();
    expect(await confirmationsFor(occupied.assignmentId)).toHaveLength(0);
  });

  it("ACL revogada: discovery nova zero; row antiga permanece PENDING e ação falha", async () => {
    const occupied = await occupy(titularProId, titularUserId);
    await dispatch();
    const [created] = await confirmationsFor(occupied.assignmentId);
    expect(created.status).toBe("PENDING");
    await db
      .update(professionalAccess)
      .set({ canAccess: false })
      .where(eq(professionalAccess.professionalId, titularProId));

    await dispatch();
    expect(await confirmationsFor(occupied.assignmentId)).toHaveLength(1);

    const valid = await requireValidDutyConfirmation(db, created.id, {
      allowedStatuses: ["PENDING"],
      requireOriginalAccess: false,
    });
    await enqueueTrackedPushNotification({
      institutionId,
      userId: titularUserId,
      shiftInstanceId: occupied.shiftId,
      dedupKey: `duty-confirmation:${created.id}:request:${titularUserId}:retry-acl`,
      payload: {
        title: "Confirmação de plantão",
        body: "retry",
        data: {
          type: "duty_confirmation",
          confirmationId: created.id,
          confirmationToken: created.confirmationToken,
          institutionId,
          shiftInstanceId: occupied.shiftId,
          assignmentId: occupied.assignmentId,
        },
      },
      authority: {
        kind: "DUTY_CONFIRMATION",
        purpose: "CONFIRMATION_REQUEST",
        confirmationId: created.id,
        allowedStatuses: ["PENDING"],
        recipientKind: "ORIGINAL",
        expectedUserId: titularUserId,
        shiftSnapshot: dutyShiftSnapshot(valid.shift),
      },
    });
    await processPendingPushDeliveries(new Date());
    const [retry] = await db
      .select({
        status: notifications.status,
        errorMessage: notifications.errorMessage,
      })
      .from(notifications)
      .where(
        eq(
          notifications.dedupKey,
          `duty-confirmation:${created.id}:request:${titularUserId}:retry-acl`,
        ),
      );
    expect(retry?.status).toBe("FAILED");
    expect(retry?.errorMessage).toMatch(/Autoridade do destinatário revogada/);

    const caller = confirmationRouter.createCaller(ctx(titularUserId));
    await expect(caller.getPending()).resolves.toBeNull();
    await expect(
      caller.confirm({ confirmationToken: created.confirmationToken }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [row] = await db
      .select({ status: dutyConfirmations.status })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, created.id));
    expect(row.status).toBe("PENDING");
  });

  it("membership inativa, user não APPROVED e assignment inactive revogam ação", async () => {
    const occupied = await occupy(titularProId, titularUserId);
    await dispatch();
    const [created] = await confirmationsFor(occupied.assignmentId);
    const caller = confirmationRouter.createCaller(ctx(titularUserId));

    await db
      .update(professionalInstitutions)
      .set({ active: false })
      .where(eq(professionalInstitutions.professionalId, titularProId));
    await expect(caller.getPending()).resolves.toBeNull();
    await expect(
      caller.confirm({ confirmationToken: created.confirmationToken }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db
      .update(professionalInstitutions)
      .set({ active: true })
      .where(eq(professionalInstitutions.professionalId, titularProId));

    await db
      .update(users)
      .set({ approvalStatus: "PENDING" })
      .where(eq(users.id, titularUserId));
    await expect(caller.getPending()).resolves.toBeNull();
    await expect(
      caller.confirm({ confirmationToken: created.confirmationToken }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await db
      .update(users)
      .set({ approvalStatus: "APPROVED" })
      .where(eq(users.id, titularUserId));

    await db
      .update(shiftAssignmentsV2)
      .set({ isActive: false })
      .where(eq(shiftAssignmentsV2.id, occupied.assignmentId));
    await expect(caller.getPending()).resolves.toBeNull();
    await expect(
      caller.confirm({ confirmationToken: created.confirmationToken }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("especialidade muda após OCUPADO: confirmação continua possível com access atual", async () => {
    const occupied = await occupy(titularProId, titularUserId);
    await dispatch();
    const [created] = await confirmationsFor(occupied.assignmentId);
    await db
      .update(professionals)
      .set({ specialty: "Cardiologia", medicalSpecialtyId: null })
      .where(eq(professionals.id, titularProId));
    try {
      expect(
        readFileSync("server/confirmation-integrity.ts", "utf8"),
      ).not.toContain("qualificationMatches");
      await expect(
        confirmationRouter
          .createCaller(ctx(titularUserId))
          .confirm({ confirmationToken: created.confirmationToken }),
      ).resolves.toMatchObject({ status: "CONFIRMED" });
    } finally {
      await db
        .update(professionals)
        .set({
          specialty: "Anestesiologia",
          medicalSpecialtyId: anesthesiaSpecialtyId,
        })
        .where(eq(professionals.id, titularProId));
    }
  });

  it("access do tenant B não cobre assignment do tenant A", async () => {
    const peerB = await person("tenant-b", {
      institutionId: institutionBId,
      hospitalId: hospitalBId,
      sectorId: sectorBId,
      access: "exact",
    });
    const occupied = await occupy(titularProId, titularUserId);
    await dispatch();
    const [created] = await confirmationsFor(occupied.assignmentId);
    const callerB = confirmationRouter.createCaller(ctx(peerB.userId, institutionBId));
    await expect(callerB.getPending()).resolves.toBeNull();
    await expect(
      callerB.confirm({ confirmationToken: created.confirmationToken }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(peerB.proId).toBeGreaterThan(0);
  });

  it("assignment substituído/inativo não ressuscita autoridade", async () => {
    const occupied = await occupy(titularProId, titularUserId);
    await dispatch();
    const [created] = await confirmationsFor(occupied.assignmentId);
    await db
      .update(shiftAssignmentsV2)
      .set({ isActive: false })
      .where(eq(shiftAssignmentsV2.id, occupied.assignmentId));
    await dispatch();
    expect(await confirmationsFor(occupied.assignmentId)).toHaveLength(1);
    await expect(
      requireAuthorizedDutyConfirmationRecipient(db, {
        confirmationId: created.id,
        allowedStatuses: ["PENDING"],
        recipientKind: "ORIGINAL",
        expectedUserId: titularUserId,
        shiftSnapshot: dutyShiftSnapshot(
          (
            await requireValidDutyConfirmation(db, created.id, {
              allowedStatuses: ["PENDING"],
              requireOriginalAccess: false,
              requireOriginalAssignmentActive: false,
            })
          ).shift,
        ),
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("ACL revoke × confirm usa o estado atual (não confirma)", async () => {
    const occupied = await occupy(titularProId, titularUserId);
    await dispatch();
    const [created] = await confirmationsFor(occupied.assignmentId);
    await db
      .update(professionalAccess)
      .set({ canAccess: false })
      .where(eq(professionalAccess.professionalId, titularProId));
    await expect(
      confirmationRouter
        .createCaller(ctx(titularUserId))
        .confirm({ confirmationToken: created.confirmationToken }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [row] = await db
      .select({ status: dutyConfirmations.status })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, created.id));
    expect(row.status).toBe("PENDING");
  });
});

describe("confirmation canonical access — source mutations", () => {
  it("M1: discovery não usa OR hospital-wide em allowlist", () => {
    const dispatcher = readFileSync(
      "server/cron/shift-confirmation-dispatcher.ts",
      "utf8",
    );
    expect(dispatcher).toContain("plantonistaAccessCoversShiftSql");
    expect(dispatcher).not.toMatch(
      /isNull\(professionalAccess\.sectorId\)[\s\S]{0,80}eq\(professionalAccess\.sectorId/,
    );
  });

  it("M2: discovery exige access canônico, não papel", () => {
    const dispatcher = readFileSync(
      "server/cron/shift-confirmation-dispatcher.ts",
      "utf8",
    );
    const start = dispatcher.indexOf("export async function dispatchConfirmations");
    const end = dispatcher.indexOf("export async function processRechecks");
    const discovery = dispatcher.slice(start, end);
    expect(discovery).toContain("plantonistaAccessCoversShiftSql");
    expect(discovery).toContain("scheduleContexts");
    expect(discovery).not.toContain("GESTOR_PLUS");
    expect(discovery).not.toContain("managerScopeTable");
  });

  it("M3: integrity não reaplica qualificationMatches", () => {
    const integrity = readFileSync("server/confirmation-integrity.ts", "utf8");
    expect(integrity).toContain("findCanonicalConfirmationAccessId");
    expect(integrity).not.toContain("qualificationMatches");
  });
});
