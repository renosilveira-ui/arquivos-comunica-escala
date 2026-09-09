import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import {
  auditTrail,
  dutyConfirmations,
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

describe("confirmation holder authority — MySQL", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  const stamp = Date.now();
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let scheduleContextId: number;
  let anesthesiaSpecialtyId: number;
  let titularUserId: number;
  let titularProId: number;
  let plusUserId: number;
  let plusProId: number;
  let peerUserId: number;
  let peerProId: number;
  const userIds: number[] = [];
  const proIds: number[] = [];
  const day = "2036-05-12";
  const start13 = new Date(`${day}T13:00:00-03:00`);
  const end19 = new Date(`${day}T19:00:00-03:00`);
  const dueAt = new Date(`${day}T11:07:00-03:00`);

  const ctx = (userId: number) =>
    ({
      user: {
        id: userId,
        role: "doctor",
        name: "AuthZ",
        email: `${userId}@t.local`,
        sessionVersion: 1,
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    }) as never;

  async function setRoster(status: "DRAFT" | "PUBLISHED" | "LOCKED") {
    await db
      .insert(monthlyRosters)
      .values({
        institutionId,
        hospitalId,
        yearMonth: yearMonthBrt(start13),
        status,
      })
      .onDuplicateKeyUpdate({ set: { status } });
  }

  async function person(
    tag: string,
    opts: { role?: "USER" | "GESTOR_PLUS"; withAccess?: boolean } = {},
  ) {
    const [u] = await db
      .insert(users)
      .values({
        name: `AuthZ ${tag} ${stamp}`,
        email: `authz-${tag}-${stamp}@test.local`,
        passwordHash: "test",
        role: "doctor",
      })
      .$returningId();
    const [p] = await db
      .insert(professionals)
      .values({
        userId: u.id,
        name: `AuthZ ${tag} ${stamp}`,
        role: "Médico",
        userRole: "USER",
        specialty: "Anestesiologia",
        medicalSpecialtyId: anesthesiaSpecialtyId,
      })
      .$returningId();
    await db.insert(professionalInstitutions).values({
      professionalId: p.id,
      userId: u.id,
      institutionId,
      roleInInstitution: opts.role ?? "USER",
      isPrimary: true,
      active: true,
    });
    if (opts.withAccess !== false) {
      await db.insert(professionalAccess).values({
        institutionId,
        professionalId: p.id,
        hospitalId,
        sectorId,
        canAccess: true,
      });
    }
    userIds.push(u.id);
    proIds.push(p.id);
    return { userId: u.id, proId: p.id };
  }

  async function occupy(professionalId: number, createdBy: number) {
    const [s] = await db
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId,
        sectorId,
        scheduleContextId,
        label: `AuthZ ${stamp}`,
        requiredCapacity: null, // Historical overlapping fixtures.
        startAt: start13,
        endAt: end19,
        status: "OCUPADO",
      })
      .$returningId();
    const [a] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId: s.id,
        institutionId,
        hospitalId,
        sectorId,
        professionalId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
        createdBy,
      })
      .$returningId();
    return { shiftId: s.id, assignmentId: a.id };
  }

  async function confirmationFor(assignmentId: number) {
    return db
      .select()
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.assignmentId, assignmentId));
  }

  async function holderPushAuthority(confirmationId: number, userId: number) {
    const valid = await requireValidDutyConfirmation(db, confirmationId, {
      allowedStatuses: ["PENDING", "DECLINED", "CONFIRMED"],
      requireOriginalAccess: false,
    });
    return requireAuthorizedDutyConfirmationRecipient(db, {
      confirmationId,
      allowedStatuses: [valid.confirmation.status],
      recipientKind: "ORIGINAL",
      expectedUserId: userId,
      shiftSnapshot: dutyShiftSnapshot(valid.shift),
    });
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
        name: `AuthZ ${stamp}`,
        cnpj,
        legalName: `AuthZ ${stamp}`,
        tradeName: `AuthZ${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = inst.id;
    const [h] = await db
      .insert(hospitals)
      .values({ institutionId, name: `AuthZ Hosp ${stamp}` })
      .$returningId();
    hospitalId = h.id;
    const [sec] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `AuthZ Setor ${stamp}`,
        category: "cirurgico",
        color: "#2563EB",
      })
      .$returningId();
    sectorId = sec.id;
    scheduleContextId = await openTestScale(db, {
      institutionId,
      hospitalId,
      sectorId,
    });
    const t = await person("titular");
    titularUserId = t.userId;
    titularProId = t.proId;
    const plus = await person("plus", { role: "GESTOR_PLUS", withAccess: false });
    plusUserId = plus.userId;
    plusProId = plus.proId;
    const peer = await person("peer");
    peerUserId = peer.userId;
    peerProId = peer.proId;
  });

  async function wipeShifts() {
    const mine = await db
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(eq(shiftInstances.institutionId, institutionId));
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
      .where(eq(monthlyRosters.institutionId, institutionId));
  }

  beforeEach(async () => {
    await wipeShifts();
    await setRoster("PUBLISHED");
  });

  afterAll(async () => {
    await wipeShifts();
    await db
      .delete(auditTrail)
      .where(eq(auditTrail.institutionId, institutionId));
    await db
      .delete(professionalAccess)
      .where(inArray(professionalAccess.professionalId, proIds));
    await db
      .delete(professionalInstitutions)
      .where(inArray(professionalInstitutions.professionalId, proIds));
    await db.delete(professionals).where(inArray(professionals.id, proIds));
    await db.delete(scheduleContexts).where(eq(scheduleContexts.id, scheduleContextId));
    await db.delete(sectors).where(eq(sectors.id, sectorId));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    await db.delete(users).where(inArray(users.id, userIds));
  });

  it("titular com ACL: push-authority, getPending, confirm, decline e nominate alinhados", async () => {
    const occupied = await occupy(titularProId, titularUserId);
    await dispatchConfirmations(dueAt);
    const [created] = await confirmationFor(occupied.assignmentId);
    expect(created).toBeTruthy();
    await expect(holderPushAuthority(created.id, titularUserId)).resolves.toBeTruthy();
    const caller = confirmationRouter.createCaller(ctx(titularUserId));
    await expect(caller.getPending()).resolves.toMatchObject({ id: created.id });
    await expect(
      caller.confirm({ confirmationToken: created.confirmationToken }),
    ).resolves.toMatchObject({ status: "CONFIRMED" });

    const second = await occupy(titularProId, titularUserId);
    await dispatchConfirmations(dueAt);
    const [pending] = await confirmationFor(second.assignmentId);
    const again = confirmationRouter.createCaller(ctx(titularUserId));
    await expect(
      again.decline({ confirmationToken: pending.confirmationToken }),
    ).resolves.toMatchObject({ status: "DECLINED" });
    await expect(
      again.nominateReplacement({
        confirmationToken: pending.confirmationToken,
        replacementProfessionalId: peerProId,
      }),
    ).resolves.toMatchObject({ status: "NOMINATED" });
    expect(peerUserId).toBeGreaterThan(0);
  });

  it("GESTOR_PLUS OCUPADO sem ACL: discovery zero; sem outbox inicial", async () => {
    const occupied = await occupy(plusProId, plusUserId);
    await dispatchConfirmations(dueAt);
    expect(await confirmationFor(occupied.assignmentId)).toHaveLength(0);
    const queued = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.shiftInstanceId, occupied.shiftId));
    expect(queued).toHaveLength(0);
    const caller = confirmationRouter.createCaller(ctx(plusUserId));
    await expect(caller.getPending()).resolves.toBeNull();
  });

  it("ACL revogada após materialização: retry de push cancela; read/confirm falham; assignment segue OCUPADO", async () => {
    const occupied = await occupy(titularProId, titularUserId);
    await dispatchConfirmations(dueAt);
    const [created] = await confirmationFor(occupied.assignmentId);
    expect(created).toBeTruthy();
    await expect(holderPushAuthority(created.id, titularUserId)).resolves.toBeTruthy();

    await db
      .update(professionalAccess)
      .set({ canAccess: false })
      .where(eq(professionalAccess.professionalId, titularProId));
    try {
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
      const [assignment] = await db
        .select({
          isActive: shiftAssignmentsV2.isActive,
          status: shiftAssignmentsV2.status,
        })
        .from(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.id, occupied.assignmentId));
      expect(assignment).toMatchObject({ isActive: true, status: "OCUPADO" });
    } finally {
      await db
        .update(professionalAccess)
        .set({ canAccess: true })
        .where(eq(professionalAccess.professionalId, titularProId));
    }
  });

  it("assignment inativo revoga ação do titular", async () => {
    const occupied = await occupy(titularProId, titularUserId);
    await dispatchConfirmations(dueAt);
    const [created] = await confirmationFor(occupied.assignmentId);
    await db
      .update(shiftAssignmentsV2)
      .set({ isActive: false })
      .where(eq(shiftAssignmentsV2.id, occupied.assignmentId));
    const caller = confirmationRouter.createCaller(ctx(titularUserId));
    await expect(caller.getPending()).resolves.toBeNull();
    await expect(
      caller.confirm({ confirmationToken: created.confirmationToken }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.decline({ confirmationToken: created.confirmationToken }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("membership inativa revoga ação do titular sem apagar o assignment", async () => {
    const occupied = await occupy(titularProId, titularUserId);
    await dispatchConfirmations(dueAt);
    const [created] = await confirmationFor(occupied.assignmentId);
    await db
      .update(professionalInstitutions)
      .set({ active: false })
      .where(eq(professionalInstitutions.professionalId, titularProId));
    try {
      const caller = confirmationRouter.createCaller(ctx(titularUserId));
      await expect(caller.getPending()).resolves.toBeNull();
      await expect(
        caller.confirm({ confirmationToken: created.confirmationToken }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const [assignment] = await db
        .select({ isActive: shiftAssignmentsV2.isActive })
        .from(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.id, occupied.assignmentId));
      expect(assignment?.isActive).toBe(true);
    } finally {
      await db
        .update(professionalInstitutions)
        .set({ active: true })
        .where(eq(professionalInstitutions.professionalId, titularProId));
    }
  });

  it("conta não APPROVED ou deletedAt revoga read/confirm; assignment permanece OCUPADO", async () => {
    const occupied = await occupy(titularProId, titularUserId);
    await dispatchConfirmations(dueAt);
    const [created] = await confirmationFor(occupied.assignmentId);
    const caller = confirmationRouter.createCaller(ctx(titularUserId));
    await db
      .update(users)
      .set({ approvalStatus: "PENDING" })
      .where(eq(users.id, titularUserId));
    try {
      await expect(caller.getPending()).resolves.toBeNull();
      await expect(
        caller.confirm({ confirmationToken: created.confirmationToken }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await db
        .update(users)
        .set({ approvalStatus: "APPROVED" })
        .where(eq(users.id, titularUserId));
    }

    await db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(eq(users.id, titularUserId));
    try {
      await expect(caller.getPending()).resolves.toBeNull();
      await expect(
        caller.confirm({ confirmationToken: created.confirmationToken }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const [assignment] = await db
        .select({
          isActive: shiftAssignmentsV2.isActive,
          status: shiftAssignmentsV2.status,
        })
        .from(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.id, occupied.assignmentId));
      expect(assignment).toMatchObject({ isActive: true, status: "OCUPADO" });
    } finally {
      await db
        .update(users)
        .set({ deletedAt: null })
        .where(eq(users.id, titularUserId));
    }
  });

  it("mudança de especialidade após OCUPADO não reaplica qualification na confirmação", async () => {
    const occupied = await occupy(titularProId, titularUserId);
    await dispatchConfirmations(dueAt);
    const [created] = await confirmationFor(occupied.assignmentId);
    await db
      .update(professionals)
      .set({ specialty: "Cardiologia" })
      .where(eq(professionals.id, titularProId));
    try {
      const integrity = readFileSync("server/confirmation-integrity.ts", "utf8");
      const router = readFileSync("server/confirmation-router.ts", "utf8");
      const confirmStart = router.indexOf("confirm: protectedProcedure");
      const confirmEnd = router.indexOf("decline: protectedProcedure");
      expect(confirmStart).toBeGreaterThan(-1);
      expect(confirmEnd).toBeGreaterThan(confirmStart);
      const confirmProcedure = router.slice(confirmStart, confirmEnd);
      expect(integrity).not.toContain("qualificationMatches");
      // Readers de candidatos devem filtrar pela mesma qualificação do write,
      // mas confirmar um plantão já OCUPADO continua validando o titular e a
      // alocação persistida — nunca reaplica a qualificação clínica atual.
      expect(confirmProcedure).not.toContain("qualificationMatches");
      await expect(
        confirmationRouter
          .createCaller(ctx(titularUserId))
          .confirm({ confirmationToken: created.confirmationToken }),
      ).resolves.toMatchObject({ status: "CONFIRMED" });
    } finally {
      await db
        .update(professionals)
        .set({ specialty: "Anestesiologia" })
        .where(eq(professionals.id, titularProId));
    }
  });
});
