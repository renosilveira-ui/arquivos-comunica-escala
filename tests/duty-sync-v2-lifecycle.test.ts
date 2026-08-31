import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPair } from "jose";
import { and, eq, inArray } from "drizzle-orm";
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
  sectors,
  shiftAssignmentsV2,
  shiftAuditLog,
  shiftInstances,
  users,
} from "../drizzle/schema";
import { confirmationRouter } from "../server/confirmation-router";
import { editorRouter } from "../server/editor";
import { getDb } from "../server/db";
import { addDaysToKey, dayKeyBrt, yearMonthBrt } from "../server/local-time";
import { processPendingDutySyncs } from "../server/sso/duty-sync";
import {
  DUTY_SYNC_LOCAL_STATUS_SCOPE,
  getDutySyncLocalStatusForConfirmation,
} from "../server/sso/duty-sync-status";
import { enqueueDutySyncIntervalRewrite } from "../server/sso/duty-sync-lifecycle";

const keyState = vi.hoisted(() => ({ privateKey: null as CryptoKey | null }));
const orgMappingState = vi.hoisted(() => ({
  organizationId: "00000000-0000-4000-8000-000000000001" as string | null,
}));

vi.mock("../server/push-delivery", () => ({
  enqueueTrackedPushNotification: vi.fn(async () => ({
    notificationId: 1,
    status: "PENDING",
    phase: "QUEUED",
    ticketAccepted: false,
    providerAccepted: false,
  })),
  sendTrackedPushNotification: vi.fn(async () => ({
    notificationId: 1,
    status: "PENDING",
    phase: "TICKET_ACCEPTED",
    ticketAccepted: true,
    providerAccepted: false,
  })),
}));
vi.mock("../server/sso/org-mapping", () => ({
  hasMappingFor: vi.fn(() => orgMappingState.organizationId !== null),
  getComunicaOrgId: vi.fn(() => orgMappingState.organizationId),
}));
vi.mock("../server/sso/keys", () => ({
  getPrivateKey: vi.fn(async () => keyState.privateKey),
  KID: "duty-sync-v2-lifecycle",
  ALG: "RS256",
}));

describe("duty-sync V2 lifecycle", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  const stamp = Date.now();
  let institutionId: number;
  let otherInstitutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let managerUserId: number;
  let managerProId: number;
  let titularUserId: number;
  let titularProId: number;
  let subUserId: number;
  let subProId: number;
  const userIds: number[] = [];
  const proIds: number[] = [];
  let shiftSeq = 0;
  const shiftDay = addDaysToKey(dayKeyBrt(new Date()), 1);
  const start = new Date(`${shiftDay}T19:00:00-03:00`);
  const end = new Date(`${addDaysToKey(shiftDay, 1)}T07:00:00-03:00`);
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 204,
    text: async () => "",
  }));

  function doctorCtx(userId: number, institution = institutionId) {
    return {
      user: {
        id: userId,
        role: "doctor",
        name: "Duty V2",
        email: `${userId}@t.local`,
        sessionVersion: 1,
      },
      institutionId: institution,
      allowedInstitutionIds: [institution],
    } as never;
  }

  function managerCtx() {
    return {
      user: {
        id: managerUserId,
        role: "manager",
        name: "Duty V2 Manager",
        email: `duty-v2-manager-${stamp}@test.local`,
        sessionVersion: 1,
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as never;
  }

  async function person(tag: string, role: "doctor" | "manager" = "doctor") {
    const [u] = await db
      .insert(users)
      .values({
        name: `DV2 ${tag} ${stamp}`,
        email: `duty-v2-${tag}-${stamp}@test.local`,
        passwordHash: "test",
        role,
        approvalStatus: "APPROVED",
      })
      .$returningId();
    const [p] = await db
      .insert(professionals)
      .values({
        userId: u.id,
        name: `DV2 ${tag} ${stamp}`,
        role: "Médico",
        userRole: role === "manager" ? "GESTOR_PLUS" : "USER",
      })
      .$returningId();
    await db.insert(professionalInstitutions).values({
      professionalId: p.id,
      userId: u.id,
      institutionId,
      roleInInstitution: role === "manager" ? "GESTOR_PLUS" : "USER",
      isPrimary: true,
      active: true,
    });
    await db.insert(professionalAccess).values({
      institutionId,
      professionalId: p.id,
      hospitalId,
      sectorId,
      canAccess: true,
    });
    userIds.push(u.id);
    proIds.push(p.id);
    return { userId: u.id, proId: p.id };
  }

  async function occupiedShift(professionalId: number) {
    shiftSeq += 1;
    const shiftStart = new Date(start.getTime() + (shiftSeq - 1) * 24 * 60 * 60 * 1000);
    const shiftEnd = new Date(end.getTime() + (shiftSeq - 1) * 24 * 60 * 60 * 1000);
    await db
      .insert(monthlyRosters)
      .values({
        institutionId,
        hospitalId,
        yearMonth: yearMonthBrt(shiftStart),
        status: "PUBLISHED",
      })
      .onDuplicateKeyUpdate({ set: { status: "PUBLISHED" } });
    const [s] = await db
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId,
        sectorId,
        label: `DV2 ${stamp}-${shiftSeq}`,
        startAt: shiftStart,
        endAt: shiftEnd,
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
        createdBy: managerUserId,
      })
      .$returningId();
    return { shiftId: s.id, assignmentId: a.id, startAt: shiftStart, endAt: shiftEnd };
  }

  async function pendingConfirmation(assignmentId: number, shiftId: number) {
    const [c] = await db
      .insert(dutyConfirmations)
      .values({
        institutionId,
        shiftInstanceId: shiftId,
        assignmentId,
        professionalId: titularProId,
        userId: titularUserId,
        status: "PENDING",
        notifiedAt: new Date(),
        recheckAt: new Date(Date.now() + 30 * 60_000),
        confirmationToken: randomUUID(),
      })
      .$returningId();
    const [row] = await db
      .select()
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, c.id));
    return row;
  }

  async function dutySyncRows(confirmationId: number) {
    return db
      .select({
        id: notifications.id,
        userId: notifications.userId,
        status: notifications.status,
        body: notifications.body,
        title: notifications.title,
        dedupKey: notifications.dedupKey,
        errorMessage: notifications.errorMessage,
        providerReceipt: notifications.providerReceipt,
      })
      .from(notifications)
      .where(
        and(
          eq(notifications.institutionId, institutionId),
          eq(notifications.title, "Duty roster sync"),
        ),
      )
      .then((rows) =>
        rows.filter((row) => {
          const receipt = row.providerReceipt as { confirmationId?: number } | null;
          return receipt?.confirmationId === confirmationId;
        }),
      );
  }

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;
    const { privateKey } = await generateKeyPair("RS256", { modulusLength: 2048 });
    keyState.privateKey = privateKey;

    const [institution] = await db
      .insert(institutions)
      .values({
        name: `Duty V2 ${stamp}`,
        cnpj: `${stamp}`.slice(-14).padStart(14, "0"),
        legalName: `Duty V2 ${stamp}`,
        tradeName: `DV2${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = institution.id;
    const [other] = await db
      .insert(institutions)
      .values({
        name: `Duty V2 other ${stamp}`,
        cnpj: `${stamp + 1}`.slice(-14).padStart(14, "0"),
        legalName: `Duty V2 other ${stamp}`,
        tradeName: `DV2O${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    otherInstitutionId = other.id;
    const [hospital] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Duty V2 Hospital ${stamp}` })
      .$returningId();
    hospitalId = hospital.id;
    const [sector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `Duty V2 Setor ${stamp}`,
        category: "cirurgico",
        color: "#2563EB",
      })
      .$returningId();
    sectorId = sector.id;

    const manager = await person("manager", "manager");
    managerUserId = manager.userId;
    managerProId = manager.proId;
    await db.insert(managerScope).values({
      institutionId,
      managerProfessionalId: managerProId,
      hospitalId,
      sectorId,
      active: true,
    });
    const titular = await person("titular");
    titularUserId = titular.userId;
    titularProId = titular.proId;
    const sub = await person("sub");
    subUserId = sub.userId;
    subProId = sub.proId;

    await db
      .insert(monthlyRosters)
      .values({
        institutionId,
        hospitalId,
        yearMonth: yearMonthBrt(start),
        status: "PUBLISHED",
      })
      .onDuplicateKeyUpdate({ set: { status: "PUBLISHED" } });
  });

  beforeEach(async () => {
    orgMappingState.organizationId = "00000000-0000-4000-8000-000000000001";
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 204,
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("SSO_TARGET_URL", "https://comunica.test.example");
    if (institutionId) {
      await db
        .delete(notifications)
        .where(
          and(
            eq(notifications.institutionId, institutionId),
            eq(notifications.title, "Duty roster sync"),
          ),
        );
    }
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (!db) return;
    await db.delete(notifications).where(eq(notifications.institutionId, institutionId));
    await db.delete(auditTrail).where(eq(auditTrail.institutionId, institutionId));
    const shifts = await db
      .select({ id: shiftInstances.id })
      .from(shiftInstances)
      .where(eq(shiftInstances.institutionId, institutionId));
    const ids = shifts.map((row) => row.id);
    if (ids.length) {
      await db.delete(dutyConfirmations).where(inArray(dutyConfirmations.shiftInstanceId, ids));
      await db
        .delete(shiftAssignmentsV2)
        .where(inArray(shiftAssignmentsV2.shiftInstanceId, ids));
      await db.delete(shiftAuditLog).where(inArray(shiftAuditLog.shiftInstanceId, ids));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, ids));
    }
    await db.delete(monthlyRosters).where(eq(monthlyRosters.institutionId, institutionId));
    await db.delete(managerScope).where(eq(managerScope.institutionId, institutionId));
    await db
      .delete(professionalAccess)
      .where(eq(professionalAccess.institutionId, institutionId));
    await db
      .delete(professionalInstitutions)
      .where(eq(professionalInstitutions.institutionId, institutionId));
    if (proIds.length) {
      await db.delete(professionals).where(inArray(professionals.id, proIds));
    }
    if (userIds.length) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
    await db.delete(sectors).where(eq(sectors.id, sectorId));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    await db.delete(institutions).where(eq(institutions.id, otherInstitutionId));
  });

  it("confirma 4h antes com intervalo correto e sem presença local imediata", async () => {
    const { shiftId, assignmentId, startAt, endAt } = await occupiedShift(titularProId);
    const conf = await pendingConfirmation(assignmentId, shiftId);
    const now = Date.now();
    expect(startAt.getTime() - now).toBeGreaterThan(3 * 60 * 60 * 1000);

    const result = await confirmationRouter
      .createCaller(doctorCtx(titularUserId))
      .confirm({ confirmationToken: conf.confirmationToken });
    expect(result.status).toBe("CONFIRMED");
    expect(result.dutySyncLocal?.scope).toBe(DUTY_SYNC_LOCAL_STATUS_SCOPE);
    expect(result.dutySyncLocal?.status).not.toBe("none");
    expect(["pending", "outbox_processed", "failed"]).toContain(
      result.dutySyncLocal?.status,
    );

    const [stored] = await db
      .select({
        status: dutyConfirmations.status,
        ssoTriggeredAt: dutyConfirmations.ssoTriggeredAt,
        startPushSentAt: dutyConfirmations.startPushSentAt,
      })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, conf.id));
    expect(stored.status).toBe("CONFIRMED");
    expect(stored.ssoTriggeredAt).toBeNull();
    expect(stored.startPushSentAt).toBeNull();

    const rows = await dutySyncRows(conf.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe("CONFIRM");
    expect(rows[0]?.providerReceipt).toMatchObject({
      action: "CONFIRM",
      shiftSnapshot: {
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
      },
    });
  });

  it("desistência após CONFIRMED gera WITHDRAW e não reverte a alocação", async () => {
    const { shiftId, assignmentId } = await occupiedShift(titularProId);
    const conf = await pendingConfirmation(assignmentId, shiftId);
    await confirmationRouter
      .createCaller(doctorCtx(titularUserId))
      .confirm({ confirmationToken: conf.confirmationToken });
    const declined = await confirmationRouter
      .createCaller(doctorCtx(titularUserId))
      .decline({
        confirmationToken: conf.confirmationToken,
        reason: "Desistência após confirmar",
      });
    expect(declined.status).toBe("DECLINED");
    const [assignment] = await db
      .select({ isActive: shiftAssignmentsV2.isActive })
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.id, assignmentId));
    expect(assignment.isActive).toBe(true);
    const rows = await dutySyncRows(conf.id);
    expect(rows.map((row) => row.body)).toEqual(
      expect.arrayContaining(["CONFIRM", "WITHDRAW"]),
    );
    const withdraw = rows.find((row) => row.body === "WITHDRAW");
    expect(withdraw?.userId).toBe(titularUserId);
  });

  it("remoção após CONFIRMED gera WITHDRAW e preserva a remoção local", async () => {
    const { shiftId, assignmentId } = await occupiedShift(titularProId);
    const conf = await pendingConfirmation(assignmentId, shiftId);
    await confirmationRouter
      .createCaller(doctorCtx(titularUserId))
      .confirm({ confirmationToken: conf.confirmationToken });
    await editorRouter.createCaller(managerCtx()).unassignDirect({
      assignmentId,
      reason: "Remoção após confirmação",
    });
    const [assignment] = await db
      .select({ isActive: shiftAssignmentsV2.isActive })
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.id, assignmentId));
    expect(assignment.isActive).toBe(false);
    const rows = await dutySyncRows(conf.id);
    expect(rows.some((row) => row.body === "WITHDRAW")).toBe(true);
  });

  it("WITHDRAW duplicado reutiliza a mesma outbox", async () => {
    const { shiftId, assignmentId } = await occupiedShift(titularProId);
    const conf = await pendingConfirmation(assignmentId, shiftId);
    await confirmationRouter
      .createCaller(doctorCtx(titularUserId))
      .confirm({ confirmationToken: conf.confirmationToken });
    await confirmationRouter
      .createCaller(doctorCtx(titularUserId))
      .decline({ confirmationToken: conf.confirmationToken, reason: "saiu" });
    const first = await dutySyncRows(conf.id);
    const withdraws = first.filter((row) => row.body === "WITHDRAW");
    expect(withdraws).toHaveLength(1);
    await editorRouter.createCaller(managerCtx()).unassignDirect({
      assignmentId,
      reason: "Remoção após desistência",
    });
    const second = await dutySyncRows(conf.id);
    expect(second.filter((row) => row.body === "WITHDRAW")).toHaveLength(1);
    expect(second.find((row) => row.body === "WITHDRAW")?.id).toBe(withdraws[0]?.id);
  });

  it("substituição pré-início emite WITHDRAW do titular e depois CONFIRM do substituto", async () => {
    const { shiftId, assignmentId } = await occupiedShift(titularProId);
    const [inserted] = await db
      .insert(dutyConfirmations)
      .values({
        institutionId,
        shiftInstanceId: shiftId,
        assignmentId,
        professionalId: titularProId,
        userId: titularUserId,
        status: "NOMINATED",
        replacementProfessionalId: subProId,
        replacementUserId: subUserId,
        notifiedAt: new Date(),
        recheckAt: new Date(Date.now() + 30 * 60_000),
        confirmationToken: randomUUID(),
      })
      .$returningId();
    await confirmationRouter
      .createCaller(doctorCtx(subUserId))
      .acceptNomination({ confirmationToken: (await db
        .select({ confirmationToken: dutyConfirmations.confirmationToken })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.id, inserted.id)))[0].confirmationToken });
    const rows = await dutySyncRows(inserted.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.body).toBe("WITHDRAW");
    expect(rows[0]?.userId).toBe(titularUserId);
    expect(rows[1]?.body).toBe("CONFIRM");
    expect(rows[1]?.userId).toBe(subUserId);
    expect(rows[0]!.id).toBeLessThan(rows[1]!.id);
  });

  it("predecessor impede CONFIRM do substituto enquanto WITHDRAW do titular está pendente", async () => {
    const { shiftId, assignmentId } = await occupiedShift(titularProId);
    const [inserted] = await db
      .insert(dutyConfirmations)
      .values({
        institutionId,
        shiftInstanceId: shiftId,
        assignmentId,
        professionalId: titularProId,
        userId: titularUserId,
        status: "NOMINATED",
        replacementProfessionalId: subProId,
        replacementUserId: subUserId,
        notifiedAt: new Date(),
        recheckAt: new Date(Date.now() + 30 * 60_000),
        confirmationToken: randomUUID(),
      })
      .$returningId();
    const [conf] = await db
      .select()
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, inserted.id));
    await confirmationRouter
      .createCaller(doctorCtx(subUserId))
      .acceptNomination({ confirmationToken: conf.confirmationToken });

    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 503,
      text: async () => "down",
    }));
    const now = new Date();
    await processPendingDutySyncs(now, { concurrency: 1 });
    const afterBackoff = await dutySyncRows(inserted.id);
    const withdraw = afterBackoff.find((row) => row.body === "WITHDRAW");
    const confirm = afterBackoff.find((row) => row.body === "CONFIRM");
    expect(withdraw?.status).toBe("PENDING");
    expect(confirm?.status).toBe("PENDING");
    const sentKeys = fetchMock.mock.calls.map(
      (call) => (call[1]?.headers as Record<string, string> | undefined)?.["Idempotency-Key"],
    );
    expect(sentKeys).toContain(withdraw?.dedupKey);
    expect(sentKeys).not.toContain(confirm?.dedupKey);
  });

  it("retry tardio do CONFIRM do titular não reativa após WITHDRAW", async () => {
    const { shiftId, assignmentId } = await occupiedShift(titularProId);
    const conf = await pendingConfirmation(assignmentId, shiftId);
    fetchMock.mockImplementationOnce(async () => ({
      ok: false,
      status: 503,
      text: async () => "down",
    }));
    await confirmationRouter
      .createCaller(doctorCtx(titularUserId))
      .confirm({ confirmationToken: conf.confirmationToken });
    await processPendingDutySyncs(new Date(), { concurrency: 1 });
    await confirmationRouter
      .createCaller(doctorCtx(titularUserId))
      .decline({ confirmationToken: conf.confirmationToken, reason: "saiu" });

    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 204,
      text: async () => "",
    }));
    await processPendingDutySyncs(new Date(Date.now() + 10 * 60_000), {
      concurrency: 1,
    });
    await processPendingDutySyncs(new Date(Date.now() + 20 * 60_000), {
      concurrency: 1,
    });

    const rows = await dutySyncRows(conf.id);
    const confirm = rows.find((row) => row.body === "CONFIRM");
    const withdraw = rows.find((row) => row.body === "WITHDRAW");
    expect(confirm?.status).toBe("FAILED");
    expect(withdraw?.status).toBe("SENT");
    const confirmCalls = fetchMock.mock.calls.filter((call) => {
      const headers = call[1]?.headers as Record<string, string> | undefined;
      return headers?.["Idempotency-Key"] === confirm?.dedupKey;
    });
    expect(confirmCalls.length).toBeLessThanOrEqual(1);
  });

  it("alocação normal e convite não geram WITHDRAW", async () => {
    const { assignmentId } = await occupiedShift(titularProId);
    const before = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.institutionId, institutionId),
          eq(notifications.title, "Duty roster sync"),
        ),
      );
    await editorRouter.createCaller(managerCtx()).unassignDirect({
      assignmentId,
      reason: "Remoção sem confirmação",
    });
    const after = await db
      .select({ id: notifications.id, body: notifications.body })
      .from(notifications)
      .where(
        and(
          eq(notifications.institutionId, institutionId),
          eq(notifications.title, "Duty roster sync"),
        ),
      );
    expect(after.length).toBe(before.length);
  });

  it("cross-tenant não enxerga a confirmação de outro hospital", async () => {
    const { assignmentId, shiftId } = await occupiedShift(titularProId);
    const conf = await pendingConfirmation(assignmentId, shiftId);
    await expect(
      confirmationRouter
        .createCaller(doctorCtx(titularUserId, otherInstitutionId))
        .confirm({ confirmationToken: conf.confirmationToken }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const [stored] = await db
      .select({ status: dutyConfirmations.status })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, conf.id));
    expect(stored.status).toBe("PENDING");
  });

  it("org mapping inválido falha fechado sem chamar a rede e preserva CONFIRMED", async () => {
    orgMappingState.organizationId = null;
    const { shiftId, assignmentId } = await occupiedShift(titularProId);
    const conf = await pendingConfirmation(assignmentId, shiftId);
    await confirmationRouter
      .createCaller(doctorCtx(titularUserId))
      .confirm({ confirmationToken: conf.confirmationToken });
    const [stored] = await db
      .select({ status: dutyConfirmations.status })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, conf.id));
    expect(stored.status).toBe("CONFIRMED");
    const rows = await dutySyncRows(conf.id);
    expect(rows[0]?.status).toBe("FAILED");
    expect(rows[0]?.errorMessage).toBe("UNMAPPED_COMUNICA_ORGANIZATION");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("subject externo ausente falha fechado sem chamar a rede", async () => {
    const { shiftId, assignmentId } = await occupiedShift(titularProId);
    const conf = await pendingConfirmation(assignmentId, shiftId);
    await db.update(users).set({ email: null }).where(eq(users.id, titularUserId));
    try {
      await confirmationRouter
        .createCaller(doctorCtx(titularUserId))
        .confirm({ confirmationToken: conf.confirmationToken });
      const rows = await dutySyncRows(conf.id);
      expect(rows[0]?.status).toBe("FAILED");
      expect(rows[0]?.errorMessage).toBe("MISSING_CANONICAL_EXTERNAL_SUBJECT");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await db
        .update(users)
        .set({ email: `duty-v2-titular-${stamp}@test.local` })
        .where(eq(users.id, titularUserId));
    }
  });

  it("Comunica+ indisponível retenta e não reverte a verdade local", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 503,
      text: async () => "down",
    }));
    const { shiftId, assignmentId } = await occupiedShift(titularProId);
    const conf = await pendingConfirmation(assignmentId, shiftId);
    await confirmationRouter
      .createCaller(doctorCtx(titularUserId))
      .confirm({ confirmationToken: conf.confirmationToken });
    await processPendingDutySyncs(new Date(), { concurrency: 1 });
    const [stored] = await db
      .select({ status: dutyConfirmations.status })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, conf.id));
    expect(stored.status).toBe("CONFIRMED");
    const rows = await dutySyncRows(conf.id);
    expect(rows[0]?.status).toBe("PENDING");
    expect(rows[0]?.providerReceipt).toMatchObject({ phase: "QUEUED" });
  });

  it("edição temporal WITHDRAW o intervalo antigo e CONFIRM o novo", async () => {
    const { shiftId, assignmentId, startAt, endAt } = await occupiedShift(titularProId);
    const conf = await pendingConfirmation(assignmentId, shiftId);
    await confirmationRouter
      .createCaller(doctorCtx(titularUserId))
      .confirm({ confirmationToken: conf.confirmationToken });
    const nextStart = new Date(startAt.getTime() + 60 * 60 * 1000);
    const nextEnd = new Date(endAt.getTime() + 60 * 60 * 1000);
    const [shift] = await db
      .select({ label: shiftInstances.label })
      .from(shiftInstances)
      .where(eq(shiftInstances.id, shiftId));
    await db.transaction(async (tx) => {
      await enqueueDutySyncIntervalRewrite(tx, {
        institutionId,
        shiftInstanceId: shiftId,
        previousSnapshot: {
          institutionId,
          hospitalId,
          sectorId,
          label: shift.label,
          startAt: startAt.toISOString(),
          endAt: endAt.toISOString(),
        },
        nextSnapshot: {
          institutionId,
          hospitalId,
          sectorId,
          label: shift.label,
          startAt: nextStart.toISOString(),
          endAt: nextEnd.toISOString(),
        },
        previousDutyType: "PLANTAO",
        nextDutyType: "PLANTAO",
        previousServiceName: null,
        nextServiceName: null,
      });
    });
    const rows = await dutySyncRows(conf.id);
    expect(rows.some((row) => row.body === "WITHDRAW")).toBe(true);
    expect(
      rows.some(
        (row) =>
          row.body === "CONFIRM" &&
          row.dedupKey?.includes(`interval:${nextStart.toISOString()}`),
      ),
    ).toBe(true);
  });

  it("#310 outbox_processed não significa presença ativa", async () => {
    const { shiftId, assignmentId } = await occupiedShift(titularProId);
    const conf = await pendingConfirmation(assignmentId, shiftId);
    await confirmationRouter
      .createCaller(doctorCtx(titularUserId))
      .confirm({ confirmationToken: conf.confirmationToken });
    await processPendingDutySyncs(new Date(), { concurrency: 1 });
    const local = await getDutySyncLocalStatusForConfirmation(db, {
      confirmationId: conf.id,
      institutionId,
      userId: titularUserId,
    });
    expect(local.scope).toBe("escala_outbox");
    expect(local.status).toBe("outbox_processed");
    expect(local.status).not.toBe("none");
    expect(JSON.stringify(local)).not.toMatch(/ativo no Comunica/);
  });
});
