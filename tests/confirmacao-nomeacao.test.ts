// tests/confirmacao-nomeacao.test.ts — auditoria 22/08 (parte 2), cron de
// confirmação pré-plantão e indicação de substituto.
//
// - acceptNomination: transação, origem ainda ativa, mês não trancado,
//   status do turno derivado, tipo preservado.
// - rechecagem: ausência de resposta preserva estado/alocação e escala a
//   decisão humana; nunca produz confirmação, SSO ou duty-sync.
// - confirm em alocação removida → erro claro.
// - push token: reatribuído ao usuário atual; desregistro remove.
// - cron: gatilho dispara dentro da janela (não só no minuto exato) e é
//   idempotente.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
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
  pushTokens,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../drizzle/schema";
import { confirmationRouter } from "../server/confirmation-router";
import {
  dispatchConfirmations,
  processRechecks,
  processShiftStartPushes,
} from "../server/cron/shift-confirmation-dispatcher";
import { getDb } from "../server/db";
import { addDaysToKey, dayKeyBrt, yearMonthBrt } from "../server/local-time";
import * as pushService from "../server/notifications-service";
import {
  dutyConfirmationCasIdentity,
  isAllowedDutyConfirmationTransition,
  transitionDutyConfirmation,
} from "../server/confirmation-state";
import { enqueueAutoSsoPush, triggerAutoSso } from "../server/sso/auto-sso";
import { enqueueDutySync, processPendingDutySyncs } from "../server/sso/duty-sync";

const dutySyncMockState = vi.hoisted(() => ({ useReal: false }));
const orgMappingState = vi.hoisted(() => ({ organizationId: null as string | null }));

vi.mock("../server/sso/auto-sso", () => ({
  enqueueAutoSsoPush: vi.fn(async () => null),
  triggerAutoSso: vi.fn(async () => undefined),
}));
vi.mock("../server/sso/org-mapping", () => ({
  getComunicaOrgId: vi.fn(() => orgMappingState.organizationId),
  hasMappingFor: vi.fn(() => orgMappingState.organizationId !== null),
}));
vi.mock("../server/sso/duty-sync", async () => {
  const actual = await vi.importActual<typeof import("../server/sso/duty-sync")>(
    "../server/sso/duty-sync",
  );
  return {
    ...actual,
    enqueueDutySync: vi.fn((...args: Parameters<typeof actual.enqueueDutySync>) =>
      dutySyncMockState.useReal
        ? actual.enqueueDutySync(...args)
        : Promise.resolve(1)),
    processPendingDutySyncs: vi.fn((...args: Parameters<typeof actual.processPendingDutySyncs>) =>
      dutySyncMockState.useReal
        ? actual.processPendingDutySyncs(...args)
        : Promise.resolve(0)),
  };
});
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

describe("confirmação pré-plantão e indicação de substituto", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  const stamp = Date.now();
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let titularUserId: number;
  let titularProId: number;
  let subUserId: number;
  let subProId: number;
  const userIds: number[] = [];
  const proIds: number[] = [];
  let pushSpy: ReturnType<typeof vi.spyOn>;

  // Plantão daqui a 2 dias, 13:00–19:00 (Tarde) no relógio do HOSPITAL
  // (-03:00 explícito: em CI o processo roda em UTC e setHours(13) seria
  // 10h no Brasil — fora da janela do gatilho "Tarde").
  const shiftDay = addDaysToKey(dayKeyBrt(new Date()), 2);
  const start = new Date(`${shiftDay}T13:00:00-03:00`);
  const end = new Date(`${shiftDay}T19:00:00-03:00`);

  const ctx = (userId: number) =>
    ({ user: { id: userId, role: "doctor", name: "T", email: `${userId}@t.local`, sessionVersion: 1 }, institutionId, allowedInstitutionIds: [institutionId] }) as any;

  async function setRosterStatus(
    date: Date,
    status: "DRAFT" | "PUBLISHED" | "LOCKED",
  ) {
    await db
      .insert(monthlyRosters)
      .values({ institutionId, hospitalId, yearMonth: yearMonthBrt(date), status })
      .onDuplicateKeyUpdate({ set: { status } });
  }

  async function person(tag: string) {
    const [u] = await db.insert(users).values({ name: `CN ${tag} ${stamp}`, email: `cn-${tag}-${stamp}@test.local`, passwordHash: "test", role: "doctor" }).$returningId();
    const [p] = await db.insert(professionals).values({ userId: u.id, name: `CN ${tag} ${stamp}`, role: "Médico", userRole: "USER" }).$returningId();
    await db.insert(professionalInstitutions).values({ professionalId: p.id, userId: u.id, institutionId, roleInInstitution: "USER", isPrimary: true, active: true });
    await db.insert(professionalAccess).values({ institutionId, professionalId: p.id, hospitalId, sectorId, canAccess: true });
    userIds.push(u.id);
    proIds.push(p.id);
    return { userId: u.id, proId: p.id };
  }

  async function shiftWithTitular(type: "ON_DUTY" | "ON_CALL" = "ON_DUTY") {
    const [s] = await db
      .insert(shiftInstances)
      .values({ institutionId, hospitalId, sectorId, label: `CN ${stamp}`, startAt: start, endAt: end, status: "OCUPADO" })
      .$returningId();
    const [a] = await db
      .insert(shiftAssignmentsV2)
      .values({ shiftInstanceId: s.id, institutionId, hospitalId, sectorId, professionalId: titularProId, assignmentType: type, status: "OCUPADO", isActive: true, createdBy: titularUserId })
      .$returningId();
    return { shiftId: s.id, assignmentId: a.id };
  }

  async function nominated(assignmentId: number, shiftId: number, recheckAt = new Date(Date.now() - 60_000)) {
    const [c] = await db
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
        recheckAt,
        confirmationToken: crypto.randomUUID(),
      })
      .$returningId();
    const [row] = await db.select().from(dutyConfirmations).where(eq(dutyConfirmations.id, c.id));
    return row;
  }

  async function pending(assignmentId: number, shiftId: number) {
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
        confirmationToken: crypto.randomUUID(),
      })
      .$returningId();
    const [row] = await db.select().from(dutyConfirmations).where(eq(dutyConfirmations.id, c.id));
    return row;
  }

  async function declined(assignmentId: number, shiftId: number) {
    const [inserted] = await db
      .insert(dutyConfirmations)
      .values({
        institutionId,
        shiftInstanceId: shiftId,
        assignmentId,
        professionalId: titularProId,
        userId: titularUserId,
        status: "DECLINED",
        notifiedAt: new Date(),
        recheckAt: new Date(Date.now() + 30 * 60_000),
        confirmationToken: crypto.randomUUID(),
      })
      .$returningId();
    const [row] = await db
      .select()
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, inserted.id));
    return row;
  }

  async function expectSuppressedDutySyncEvidence(input: {
    dedupKey: string;
    confirmationId: number;
    targetUserId: number;
    action: "CONFIRM" | "WITHDRAW";
    reason:
      | "UNMAPPED_COMUNICA_ORGANIZATION"
      | "MISSING_CANONICAL_EXTERNAL_SUBJECT";
    organizationId?: string;
    externalSubject?: string;
  }) {
    const [outbox] = await db
      .select({
        status: notifications.status,
        errorMessage: notifications.errorMessage,
        providerReceipt: notifications.providerReceipt,
      })
      .from(notifications)
      .where(eq(notifications.dedupKey, input.dedupKey));
    expect(outbox).toBeDefined();
    expect(outbox.status).toBe("FAILED");
    expect(outbox.errorMessage).toBe(input.reason);
    expect(outbox.providerReceipt).toMatchObject({
      dutySyncVersion: 1,
      phase: "FAILED",
      confirmationId: input.confirmationId,
      targetUserId: input.targetUserId,
      action: input.action,
      attemptCount: 0,
      evidence: { reason: input.reason },
    });
    if (input.organizationId) {
      expect(outbox.providerReceipt).toHaveProperty(
        "organizationId",
        input.organizationId,
      );
    } else {
      expect(outbox.providerReceipt).not.toHaveProperty("organizationId");
    }
    if (input.externalSubject) {
      expect(outbox.providerReceipt).toHaveProperty(
        "externalSubject",
        input.externalSubject,
      );
    } else {
      expect(outbox.providerReceipt).not.toHaveProperty("externalSubject");
    }
    await expect(processPendingDutySyncs()).resolves.toBe(0);
  }

  async function expectAuditEvidence(
    action: (typeof auditTrail.$inferSelect)["action"],
    assignmentId: number,
  ) {
    const rows = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.institutionId, institutionId),
          eq(auditTrail.action, action),
          eq(auditTrail.entityId, assignmentId),
        ),
      );
    expect(rows).toHaveLength(1);
  }

  async function expectNominationRejectedWithoutEffects(input: {
    confirmationId: number;
    confirmationToken: string;
    assignmentId: number;
    shiftInstanceId: number;
    replacementProfessionalId: number;
    code: "BAD_REQUEST" | "FORBIDDEN";
    message?: string;
  }) {
    const [beforeConfirmation] = await db
      .select({
        status: dutyConfirmations.status,
        replacementProfessionalId: dutyConfirmations.replacementProfessionalId,
        replacementUserId: dutyConfirmations.replacementUserId,
        recheckAt: dutyConfirmations.recheckAt,
        updatedAt: dutyConfirmations.updatedAt,
      })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, input.confirmationId));
    const beforeAssignments = await db
      .select({
        id: shiftAssignmentsV2.id,
        professionalId: shiftAssignmentsV2.professionalId,
        isActive: shiftAssignmentsV2.isActive,
      })
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.shiftInstanceId, input.shiftInstanceId));
    const beforeAudit = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.action, "TRANSFER_OFFERED"),
          eq(auditTrail.entityId, input.assignmentId),
        ),
      );

    await expect(
      confirmationRouter
        .createCaller(ctx(titularUserId))
        .nominateReplacement({
          confirmationToken: input.confirmationToken,
          replacementProfessionalId: input.replacementProfessionalId,
        }),
    ).rejects.toMatchObject({
      code: input.code,
      ...(input.message ? { message: input.message } : {}),
    });

    const [afterConfirmation] = await db
      .select({
        status: dutyConfirmations.status,
        replacementProfessionalId: dutyConfirmations.replacementProfessionalId,
        replacementUserId: dutyConfirmations.replacementUserId,
        recheckAt: dutyConfirmations.recheckAt,
        updatedAt: dutyConfirmations.updatedAt,
      })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, input.confirmationId));
    const afterAssignments = await db
      .select({
        id: shiftAssignmentsV2.id,
        professionalId: shiftAssignmentsV2.professionalId,
        isActive: shiftAssignmentsV2.isActive,
      })
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.shiftInstanceId, input.shiftInstanceId));
    const afterAudit = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.action, "TRANSFER_OFFERED"),
          eq(auditTrail.entityId, input.assignmentId),
        ),
      );
    const outbox = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.institutionId, institutionId));

    expect(afterConfirmation).toEqual(beforeConfirmation);
    expect(afterAssignments).toEqual(beforeAssignments);
    expect(afterAudit).toEqual(beforeAudit);
    expect(outbox).toHaveLength(0);
    expect(queuedPushMock).not.toHaveBeenCalled();
    expect(trackedPushMock).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueDutySync)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueAutoSsoPush)).not.toHaveBeenCalled();
    expect(vi.mocked(triggerAutoSso)).not.toHaveBeenCalled();
  }

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;
    const mockedPushResult: pushService.PushSendResult = {
      status: "TICKETS_ACCEPTED",
      message: "Ticket mock aceito; receipt pendente",
      tickets: [{ state: "TICKET_ACCEPTED", pushTokenId: 1, ticketId: "mock-ticket" }],
      acceptedCount: 1,
      rejectedCount: 0,
    };
    pushSpy = vi
      .spyOn(pushService, "sendPushNotification")
      .mockResolvedValue(mockedPushResult);
    const [inst] = await db
      .insert(institutions)
      .values({ name: `CN Tenant ${stamp}`, cnpj: `${stamp}`.slice(-14).padStart(14, "0"), legalName: `CN ${stamp}`, tradeName: `CN${stamp}`.slice(0, 20), isActive: true })
      .$returningId();
    institutionId = inst.id;
    const [h] = await db.insert(hospitals).values({ institutionId, name: `CN Hospital ${stamp}` }).$returningId();
    hospitalId = h.id;
    const [sec] = await db.insert(sectors).values({ institutionId, hospitalId, name: `CN Setor ${stamp}`, category: "cirurgico", color: "#2563EB" }).$returningId();
    sectorId = sec.id;
    const t = await person("titular");
    titularUserId = t.userId;
    titularProId = t.proId;
    const s = await person("sub");
    subUserId = s.userId;
    subProId = s.proId;
  });

  beforeEach(async () => {
    dutySyncMockState.useReal = false;
    orgMappingState.organizationId = null;
    await db.delete(notifications).where(eq(notifications.institutionId, institutionId));
    const mine = await db.select({ id: shiftInstances.id }).from(shiftInstances).where(eq(shiftInstances.institutionId, institutionId));
    const ids = mine.map((s) => s.id);
    if (ids.length) {
      await db.delete(dutyConfirmations).where(inArray(dutyConfirmations.shiftInstanceId, ids));
      await db.delete(shiftAssignmentsV2).where(inArray(shiftAssignmentsV2.shiftInstanceId, ids));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, ids));
    }
    await db.delete(monthlyRosters).where(eq(monthlyRosters.institutionId, institutionId));
    await setRosterStatus(start, "PUBLISHED");
    await db.delete(pushTokens).where(inArray(pushTokens.userId, userIds));
    await db
      .update(users)
      .set({ sessionVersion: 1 })
      .where(inArray(users.id, [titularUserId, subUserId]));
    pushSpy.mockClear();
    trackedPushMock.mockReset();
    trackedPushMock.mockResolvedValue({
      notificationId: 1,
      status: "PENDING",
      phase: "TICKET_ACCEPTED",
      ticketAccepted: true,
      providerAccepted: false,
    });
    queuedPushMock.mockReset();
    queuedPushMock.mockResolvedValue({
      notificationId: 1,
      status: "PENDING",
      phase: "QUEUED",
      ticketAccepted: false,
      providerAccepted: false,
    });
    vi.mocked(triggerAutoSso).mockClear();
    vi.mocked(enqueueAutoSsoPush).mockClear();
    vi.mocked(enqueueDutySync).mockClear();
  });

  afterAll(async () => {
    await db.delete(notifications).where(eq(notifications.institutionId, institutionId));
    const mine = await db.select({ id: shiftInstances.id }).from(shiftInstances).where(eq(shiftInstances.institutionId, institutionId));
    const ids = mine.map((s) => s.id);
    if (ids.length) {
      await db.delete(dutyConfirmations).where(inArray(dutyConfirmations.shiftInstanceId, ids));
      await db.delete(shiftAssignmentsV2).where(inArray(shiftAssignmentsV2.shiftInstanceId, ids));
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, ids));
    }
    await db.delete(pushTokens).where(inArray(pushTokens.userId, userIds));
    await db.delete(auditTrail).where(eq(auditTrail.institutionId, institutionId));
    await db.delete(monthlyRosters).where(eq(monthlyRosters.institutionId, institutionId));
    await db.delete(professionalAccess).where(inArray(professionalAccess.professionalId, proIds));
    await db.delete(professionalInstitutions).where(inArray(professionalInstitutions.professionalId, proIds));
    await db.delete(professionals).where(inArray(professionals.id, proIds));
    await db.delete(sectors).where(eq(sectors.id, sectorId));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    await db.delete(users).where(inArray(users.id, userIds));
    pushSpy.mockRestore();
  });

  it("acceptNomination: substituto assume com tipo preservado e turno OCUPADO; segunda tentativa → CONFLICT", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular("ON_CALL");
    const conf = await nominated(assignmentId, shiftId);
    const sub = confirmationRouter.createCaller(ctx(subUserId));
    const nom = await sub.getNomination({ confirmationToken: conf.confirmationToken });
    expect(nom?.shiftInstanceId).toBe(shiftId);

    const r = await sub.acceptNomination({ confirmationToken: conf.confirmationToken });
    expect(r.status).toBe("REPLACEMENT_CONFIRMED");
    expect(vi.mocked(enqueueAutoSsoPush)).toHaveBeenCalledWith(
      conf.id,
      expect.any(Date),
      expect.anything(),
    );
    expect(queuedPushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          data: expect.objectContaining({
            type: "replacement_accepted",
            institutionId,
          }),
        }),
      }),
      expect.any(Date),
      expect.anything(),
    );
    const active = await db
      .select({ professionalId: shiftAssignmentsV2.professionalId, assignmentType: shiftAssignmentsV2.assignmentType })
      .from(shiftAssignmentsV2)
      .where(and(eq(shiftAssignmentsV2.shiftInstanceId, shiftId), eq(shiftAssignmentsV2.isActive, true)));
    expect(active).toEqual([{ professionalId: subProId, assignmentType: "ON_CALL" }]);
    const [shift] = await db.select({ status: shiftInstances.status }).from(shiftInstances).where(eq(shiftInstances.id, shiftId));
    expect(shift.status).toBe("OCUPADO");
    await expect(sub.acceptNomination({ confirmationToken: conf.confirmationToken })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("confirm preserva verdade local e auditoria quando o tenant não tem organização Comunica+", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const conf = await pending(assignmentId, shiftId);
    const dedupKey =
      `duty-confirmation:${conf.id}:duty-sync:confirmed:${titularUserId}`;
    dutySyncMockState.useReal = true;
    orgMappingState.organizationId = null;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    try {
      await expect(
        confirmationRouter
          .createCaller(ctx(titularUserId))
          .confirm({ confirmationToken: conf.confirmationToken }),
      ).resolves.toMatchObject({
        ok: true,
        status: "CONFIRMED",
        dutySyncLocal: expect.objectContaining({ scope: "escala_outbox" }),
      });
      const [stored] = await db
        .select({ status: dutyConfirmations.status })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.id, conf.id));
      expect(stored.status).toBe("CONFIRMED");
      await expectAuditEvidence("ASSIGNMENT_APPROVED", assignmentId);
      await expectSuppressedDutySyncEvidence({
        dedupKey,
        confirmationId: conf.id,
        targetUserId: titularUserId,
        action: "CONFIRM",
        reason: "UNMAPPED_COMUNICA_ORGANIZATION",
        externalSubject: `cn-titular-${stamp}@test.local`,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("decline preserva verdade local e auditoria quando o mapa Comunica+ é inválido", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const conf = await pending(assignmentId, shiftId);
    const dedupKey =
      `duty-confirmation:${conf.id}:duty-sync:withdraw:${titularUserId}`;
    dutySyncMockState.useReal = true;
    orgMappingState.organizationId = "not-a-canonical-uuid";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    try {
      await expect(
        confirmationRouter
          .createCaller(ctx(titularUserId))
          .decline({
            confirmationToken: conf.confirmationToken,
            reason: "Indisponível",
          }),
      ).resolves.toMatchObject({
        ok: true,
        status: "DECLINED",
        dutySyncLocal: expect.objectContaining({ scope: "escala_outbox" }),
      });
      const [stored] = await db
        .select({ status: dutyConfirmations.status })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.id, conf.id));
      expect(stored.status).toBe("DECLINED");
      await expectAuditEvidence("ASSIGNMENT_REJECTED", assignmentId);
      await expectSuppressedDutySyncEvidence({
        dedupKey,
        confirmationId: conf.id,
        targetUserId: titularUserId,
        action: "WITHDRAW",
        reason: "UNMAPPED_COMUNICA_ORGANIZATION",
        externalSubject: `cn-titular-${stamp}@test.local`,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("acceptNomination preserva troca local e auditoria sem organização Comunica+", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular("ON_CALL");
    const conf = await nominated(assignmentId, shiftId);
    const dedupKey =
      `duty-confirmation:${conf.id}:duty-sync:replacement-confirmed:${subUserId}`;
    dutySyncMockState.useReal = true;
    orgMappingState.organizationId = null;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    try {
      await expect(
        confirmationRouter
          .createCaller(ctx(subUserId))
          .acceptNomination({ confirmationToken: conf.confirmationToken }),
      ).resolves.toMatchObject({
        ok: true,
        status: "REPLACEMENT_CONFIRMED",
        dutySyncLocal: expect.objectContaining({ scope: "escala_outbox" }),
      });
      const [stored] = await db
        .select({ status: dutyConfirmations.status })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.id, conf.id));
      expect(stored.status).toBe("REPLACEMENT_CONFIRMED");
      const active = await db
        .select({ professionalId: shiftAssignmentsV2.professionalId })
        .from(shiftAssignmentsV2)
        .where(
          and(
            eq(shiftAssignmentsV2.shiftInstanceId, shiftId),
            eq(shiftAssignmentsV2.isActive, true),
          ),
        );
      expect(active).toEqual([{ professionalId: subProId }]);
      await expectAuditEvidence("TRANSFER_ACCEPTED", assignmentId);
      await expectSuppressedDutySyncEvidence({
        dedupKey,
        confirmationId: conf.id,
        targetUserId: subUserId,
        action: "CONFIRM",
        reason: "UNMAPPED_COMUNICA_ORGANIZATION",
        externalSubject: `cn-sub-${stamp}@test.local`,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("confirm preserva decisão local quando o titular não tem email canônico", async () => {
    const organizationId = "00000000-0000-4000-8000-000000000001";
    const { shiftId, assignmentId } = await shiftWithTitular();
    const conf = await pending(assignmentId, shiftId);
    const dedupKey =
      `duty-confirmation:${conf.id}:duty-sync:confirmed:${titularUserId}`;
    dutySyncMockState.useReal = true;
    orgMappingState.organizationId = organizationId;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    await db.update(users).set({ email: null }).where(eq(users.id, titularUserId));
    try {
      await expect(
        confirmationRouter
          .createCaller(ctx(titularUserId))
          .confirm({ confirmationToken: conf.confirmationToken }),
      ).resolves.toMatchObject({
        ok: true,
        status: "CONFIRMED",
        dutySyncLocal: expect.objectContaining({ scope: "escala_outbox" }),
      });
      const [stored] = await db
        .select({ status: dutyConfirmations.status })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.id, conf.id));
      expect(stored.status).toBe("CONFIRMED");
      await expectAuditEvidence("ASSIGNMENT_APPROVED", assignmentId);
      await expectSuppressedDutySyncEvidence({
        dedupKey,
        confirmationId: conf.id,
        targetUserId: titularUserId,
        action: "CONFIRM",
        reason: "MISSING_CANONICAL_EXTERNAL_SUBJECT",
        organizationId,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await db
        .update(users)
        .set({ email: `cn-titular-${stamp}@test.local` })
        .where(eq(users.id, titularUserId));
      fetchSpy.mockRestore();
    }
  });

  it("decline preserva decisão local quando o email do titular está vazio", async () => {
    const organizationId = "00000000-0000-4000-8000-000000000001";
    const { shiftId, assignmentId } = await shiftWithTitular();
    const conf = await pending(assignmentId, shiftId);
    const dedupKey =
      `duty-confirmation:${conf.id}:duty-sync:withdraw:${titularUserId}`;
    dutySyncMockState.useReal = true;
    orgMappingState.organizationId = organizationId;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    await db.update(users).set({ email: "   " }).where(eq(users.id, titularUserId));
    try {
      await expect(
        confirmationRouter
          .createCaller(ctx(titularUserId))
          .decline({
            confirmationToken: conf.confirmationToken,
            reason: "Indisponível",
          }),
      ).resolves.toMatchObject({
        ok: true,
        status: "DECLINED",
        dutySyncLocal: expect.objectContaining({ scope: "escala_outbox" }),
      });
      const [stored] = await db
        .select({ status: dutyConfirmations.status })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.id, conf.id));
      expect(stored.status).toBe("DECLINED");
      await expectAuditEvidence("ASSIGNMENT_REJECTED", assignmentId);
      await expectSuppressedDutySyncEvidence({
        dedupKey,
        confirmationId: conf.id,
        targetUserId: titularUserId,
        action: "WITHDRAW",
        reason: "MISSING_CANONICAL_EXTERNAL_SUBJECT",
        organizationId,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await db
        .update(users)
        .set({ email: `cn-titular-${stamp}@test.local` })
        .where(eq(users.id, titularUserId));
      fetchSpy.mockRestore();
    }
  });

  it("acceptNomination preserva a troca local quando o email excede o contrato Comunica+", async () => {
    const organizationId = "00000000-0000-4000-8000-000000000001";
    const { shiftId, assignmentId } = await shiftWithTitular("ON_CALL");
    const conf = await nominated(assignmentId, shiftId);
    const dedupKey =
      `duty-confirmation:${conf.id}:duty-sync:replacement-confirmed:${subUserId}`;
    dutySyncMockState.useReal = true;
    orgMappingState.organizationId = organizationId;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    await db
      .update(users)
      .set({ email: `${"a".repeat(150)}@example.com` })
      .where(eq(users.id, subUserId));
    try {
      await expect(
        confirmationRouter
          .createCaller(ctx(subUserId))
          .acceptNomination({ confirmationToken: conf.confirmationToken }),
      ).resolves.toMatchObject({
        ok: true,
        status: "REPLACEMENT_CONFIRMED",
        dutySyncLocal: expect.objectContaining({ scope: "escala_outbox" }),
      });
      const [stored] = await db
        .select({ status: dutyConfirmations.status })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.id, conf.id));
      expect(stored.status).toBe("REPLACEMENT_CONFIRMED");
      const active = await db
        .select({ professionalId: shiftAssignmentsV2.professionalId })
        .from(shiftAssignmentsV2)
        .where(
          and(
            eq(shiftAssignmentsV2.shiftInstanceId, shiftId),
            eq(shiftAssignmentsV2.isActive, true),
          ),
        );
      expect(active).toEqual([{ professionalId: subProId }]);
      await expectAuditEvidence("TRANSFER_ACCEPTED", assignmentId);
      await expectSuppressedDutySyncEvidence({
        dedupKey,
        confirmationId: conf.id,
        targetUserId: subUserId,
        action: "CONFIRM",
        reason: "MISSING_CANONICAL_EXTERNAL_SUBJECT",
        organizationId,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await db
        .update(users)
        .set({ email: `cn-sub-${stamp}@test.local` })
        .where(eq(users.id, subUserId));
      fetchSpy.mockRestore();
    }
  });

  it("nominateReplacement rejeita o próprio profissional sob lock e sem efeitos", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const conf = await declined(assignmentId, shiftId);

    await expectNominationRejectedWithoutEffects({
      confirmationId: conf.id,
      confirmationToken: conf.confirmationToken,
      assignmentId,
      shiftInstanceId: shiftId,
      replacementProfessionalId: titularProId,
      code: "BAD_REQUEST",
      message: "O titular não pode indicar a si próprio como substituto",
    });
  });

  it("nominateReplacement falha fechado para alias sem paridade institucional", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const conf = await declined(assignmentId, shiftId);
    const [alias] = await db
      .insert(professionals)
      .values({
        userId: titularUserId,
        name: `CN alias ${stamp}`,
        role: "Médico",
        userRole: "USER",
      })
      .$returningId();
    await db.insert(professionalAccess).values({
      institutionId,
      professionalId: alias.id,
      hospitalId,
      sectorId,
      canAccess: true,
    });

    try {
      await expectNominationRejectedWithoutEffects({
        confirmationId: conf.id,
        confirmationToken: conf.confirmationToken,
        assignmentId,
        shiftInstanceId: shiftId,
        replacementProfessionalId: alias.id,
        code: "FORBIDDEN",
      });
    } finally {
      await db
        .delete(professionalAccess)
        .where(eq(professionalAccess.professionalId, alias.id));
      await db.delete(professionals).where(eq(professionals.id, alias.id));
    }
  });

  it("nominateReplacement mantém controle positivo para candidato distinto", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const conf = await declined(assignmentId, shiftId);

    await expect(
      confirmationRouter
        .createCaller(ctx(titularUserId))
        .nominateReplacement({
          confirmationToken: conf.confirmationToken,
          replacementProfessionalId: subProId,
        }),
    ).resolves.toMatchObject({ status: "NOMINATED" });
    const [stored] = await db
      .select({
        status: dutyConfirmations.status,
        replacementProfessionalId: dutyConfirmations.replacementProfessionalId,
        replacementUserId: dutyConfirmations.replacementUserId,
      })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, conf.id));
    expect(stored).toEqual({
      status: "NOMINATED",
      replacementProfessionalId: subProId,
      replacementUserId: subUserId,
    });
    await expectAuditEvidence("TRANSFER_OFFERED", assignmentId);
    expect(queuedPushMock).toHaveBeenCalledTimes(1);
  });

  it("acceptNomination: origem já removida → CONFLICT sem criar alocação; mês LOCKED → FORBIDDEN", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const conf = await nominated(assignmentId, shiftId);
    await db.update(shiftAssignmentsV2).set({ isActive: false }).where(eq(shiftAssignmentsV2.id, assignmentId));
    const sub = confirmationRouter.createCaller(ctx(subUserId));
    await expect(sub.acceptNomination({ confirmationToken: conf.confirmationToken })).rejects.toMatchObject({ code: "CONFLICT" });
    const rows = await db.select({ id: shiftAssignmentsV2.id }).from(shiftAssignmentsV2).where(and(eq(shiftAssignmentsV2.shiftInstanceId, shiftId), eq(shiftAssignmentsV2.isActive, true)));
    expect(rows).toHaveLength(0);
    const [rolledBack] = await db
      .select({ status: dutyConfirmations.status })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, conf.id));
    expect(rolledBack.status).toBe("NOMINATED");
    expect(vi.mocked(triggerAutoSso)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueDutySync)).not.toHaveBeenCalled();
    expect(pushSpy).not.toHaveBeenCalled();

    const s2 = await shiftWithTitular();
    const conf2 = await nominated(s2.assignmentId, s2.shiftId);
    await setRosterStatus(start, "LOCKED");
    await expect(sub.acceptNomination({ confirmationToken: conf2.confirmationToken })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("acceptNomination não transforma escala DRAFT em troca operacional", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const conf = await nominated(assignmentId, shiftId);
    await setRosterStatus(start, "DRAFT");

    await expect(
      confirmationRouter
        .createCaller(ctx(subUserId))
        .acceptNomination({ confirmationToken: conf.confirmationToken }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const [after] = await db
      .select({ status: dutyConfirmations.status })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, conf.id));
    const active = await db
      .select({ professionalId: shiftAssignmentsV2.professionalId })
      .from(shiftAssignmentsV2)
      .where(
        and(
          eq(shiftAssignmentsV2.shiftInstanceId, shiftId),
          eq(shiftAssignmentsV2.isActive, true),
        ),
      );
    expect(after.status).toBe("NOMINATED");
    expect(active).toEqual([{ professionalId: titularProId }]);
    expect(queuedPushMock).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueDutySync)).not.toHaveBeenCalled();
  });

  it("acceptNomination revalida duplicata ativa no plantão dentro da transação", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const conf = await nominated(assignmentId, shiftId);
    await db.insert(shiftAssignmentsV2).values({
      shiftInstanceId: shiftId,
      institutionId,
      hospitalId,
      sectorId,
      professionalId: subProId,
      assignmentType: "ON_DUTY",
      status: "OCUPADO",
      isActive: true,
      createdBy: titularUserId,
    });

    await expect(
      confirmationRouter
        .createCaller(ctx(subUserId))
        .acceptNomination({ confirmationToken: conf.confirmationToken }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const [after] = await db
      .select({ status: dutyConfirmations.status })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, conf.id));
    expect(after.status).toBe("NOMINATED");
    expect(queuedPushMock).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueDutySync)).not.toHaveBeenCalled();
  });

  it("acceptNomination revalida overlap global do substituto dentro da transação", async () => {
    const target = await shiftWithTitular();
    const conf = await nominated(target.assignmentId, target.shiftId);
    const [otherShift] = await db
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId,
        sectorId,
        label: `CN overlap ${stamp}`,
        startAt: new Date(start.getTime() + 60 * 60_000),
        endAt: new Date(end.getTime() + 60 * 60_000),
        status: "OCUPADO",
      })
      .$returningId();
    await db.insert(shiftAssignmentsV2).values({
      shiftInstanceId: otherShift.id,
      institutionId,
      hospitalId,
      sectorId,
      professionalId: subProId,
      assignmentType: "ON_CALL",
      status: "OCUPADO",
      isActive: true,
      createdBy: titularUserId,
    });

    await expect(
      confirmationRouter
        .createCaller(ctx(subUserId))
        .acceptNomination({ confirmationToken: conf.confirmationToken }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const [after] = await db
      .select({ status: dutyConfirmations.status })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, conf.id));
    expect(after.status).toBe("NOMINATED");
    expect(queuedPushMock).not.toHaveBeenCalled();
  });

  it("acceptNomination falha fechado se o turno já excedeu o limite operacional", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const conf = await nominated(assignmentId, shiftId);
    await db.insert(shiftAssignmentsV2).values(
      Array.from({ length: 20 }, () => ({
        shiftInstanceId: shiftId,
        institutionId,
        hospitalId,
        sectorId,
        professionalId: titularProId,
        assignmentType: "BACKUP" as const,
        status: "OCUPADO",
        isActive: true,
        createdBy: titularUserId,
      })),
    );

    await expect(
      confirmationRouter
        .createCaller(ctx(subUserId))
        .acceptNomination({ confirmationToken: conf.confirmationToken }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const [after] = await db
      .select({ status: dutyConfirmations.status })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, conf.id));
    expect(after.status).toBe("NOMINATED");
    expect(queuedPushMock).not.toHaveBeenCalled();
  });

  it("duas aceitações sobrepostas do mesmo substituto têm um único vencedor", async () => {
    const first = await shiftWithTitular();
    const second = await shiftWithTitular();
    const firstConf = await nominated(first.assignmentId, first.shiftId);
    const secondConf = await nominated(second.assignmentId, second.shiftId);
    const sub = confirmationRouter.createCaller(ctx(subUserId));

    const results = await Promise.allSettled([
      sub.acceptNomination({ confirmationToken: firstConf.confirmationToken }),
      sub.acceptNomination({ confirmationToken: secondConf.confirmationToken }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const activeReplacementAssignments = await db
      .select({ id: shiftAssignmentsV2.id })
      .from(shiftAssignmentsV2)
      .where(
        and(
          eq(shiftAssignmentsV2.professionalId, subProId),
          eq(shiftAssignmentsV2.isActive, true),
          inArray(shiftAssignmentsV2.shiftInstanceId, [first.shiftId, second.shiftId]),
        ),
      );
    expect(activeReplacementAssignments).toHaveLength(1);
    expect(queuedPushMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueDutySync)).toHaveBeenCalledTimes(1);
  });

  it("aceites em meses distintos do mesmo hospital não fazem upgrade S→X na topologia", async () => {
    const createAt = async (startAt: Date, endAt: Date) => {
      await setRosterStatus(startAt, "PUBLISHED");
      const [shift] = await db.insert(shiftInstances).values({
        institutionId,
        hospitalId,
        sectorId,
        label: `CN cross-month ${startAt.toISOString()} ${stamp}`,
        startAt,
        endAt,
        status: "OCUPADO",
      }).$returningId();
      const [assignment] = await db.insert(shiftAssignmentsV2).values({
        shiftInstanceId: shift.id,
        institutionId,
        hospitalId,
        sectorId,
        professionalId: titularProId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
        createdBy: titularUserId,
      }).$returningId();
      return nominated(assignment.id, shift.id, new Date(Date.now() + 30 * 60_000));
    };
    const january = await createAt(
      new Date("2034-01-10T13:00:00-03:00"),
      new Date("2034-01-10T19:00:00-03:00"),
    );
    const february = await createAt(
      new Date("2034-02-10T13:00:00-03:00"),
      new Date("2034-02-10T19:00:00-03:00"),
    );
    const sub = confirmationRouter.createCaller(ctx(subUserId));

    const results = await Promise.allSettled([
      sub.acceptNomination({ confirmationToken: january.confirmationToken }),
      sub.acceptNomination({ confirmationToken: february.confirmationToken }),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ status: "fulfilled" }),
      expect.objectContaining({ status: "fulfilled" }),
    ]);
    const confirmations = await db
      .select({ status: dutyConfirmations.status })
      .from(dutyConfirmations)
      .where(inArray(dutyConfirmations.id, [january.id, february.id]));
    expect(confirmations.map((row) => row.status).sort()).toEqual([
      "REPLACEMENT_CONFIRMED",
      "REPLACEMENT_CONFIRMED",
    ]);
  });

  it("corrida cross-month sobreposta vê o commit após conquistar o mutex profissional", async () => {
    const createAt = async (startAt: Date, endAt: Date) => {
      await setRosterStatus(startAt, "PUBLISHED");
      const [shift] = await db.insert(shiftInstances).values({
        institutionId,
        hospitalId,
        sectorId,
        label: `CN RC overlap ${startAt.toISOString()} ${stamp}`,
        startAt,
        endAt,
        status: "OCUPADO",
      }).$returningId();
      const [assignment] = await db.insert(shiftAssignmentsV2).values({
        shiftInstanceId: shift.id,
        institutionId,
        hospitalId,
        sectorId,
        professionalId: titularProId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
        createdBy: titularUserId,
      }).$returningId();
      return {
        shiftId: shift.id,
        confirmation: await nominated(
          assignment.id,
          shift.id,
          new Date(Date.now() + 30 * 60_000),
        ),
      };
    };
    const january = await createAt(
      new Date("2034-01-31T22:00:00-03:00"),
      new Date("2034-02-01T08:00:00-03:00"),
    );
    const february = await createAt(
      new Date("2034-02-01T00:00:00-03:00"),
      new Date("2034-02-01T06:00:00-03:00"),
    );
    const sub = confirmationRouter.createCaller(ctx(subUserId));

    const results = await Promise.allSettled([
      sub.acceptNomination({
        confirmationToken: january.confirmation.confirmationToken,
      }),
      sub.acceptNomination({
        confirmationToken: february.confirmation.confirmationToken,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const activeReplacementAssignments = await db
      .select({ id: shiftAssignmentsV2.id })
      .from(shiftAssignmentsV2)
      .where(
        and(
          eq(shiftAssignmentsV2.professionalId, subProId),
          eq(shiftAssignmentsV2.isActive, true),
          inArray(shiftAssignmentsV2.shiftInstanceId, [january.shiftId, february.shiftId]),
        ),
      );
    expect(activeReplacementAssignments).toHaveLength(1);
  });

  it("acceptNomination serializa com lockMonth e não realoca depois do LOCKED", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const conf = await nominated(assignmentId, shiftId, new Date(Date.now() + 30 * 60_000));
    await setRosterStatus(start, "PUBLISHED");

    let releaseLock!: () => void;
    let rowLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const locked = new Promise<void>((resolve) => { rowLocked = resolve; });
    const locker = db.transaction(async (tx) => {
      await tx
        .update(monthlyRosters)
        .set({ status: "LOCKED" })
        .where(
          and(
            eq(monthlyRosters.institutionId, institutionId),
            eq(monthlyRosters.hospitalId, hospitalId),
            eq(monthlyRosters.yearMonth, yearMonthBrt(start)),
          ),
        );
      rowLocked();
      await release;
    });

    await locked;
    let settled = false;
    const decision = confirmationRouter
      .createCaller(ctx(subUserId))
      .acceptNomination({ confirmationToken: conf.confirmationToken })
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      .finally(() => { settled = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(false);
    } finally {
      releaseLock();
    }
    await locker;
    await expect(decision).resolves.toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });

    const [after] = await db
      .select({ status: dutyConfirmations.status })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, conf.id));
    const active = await db
      .select({ professionalId: shiftAssignmentsV2.professionalId })
      .from(shiftAssignmentsV2)
      .where(
        and(
          eq(shiftAssignmentsV2.shiftInstanceId, shiftId),
          eq(shiftAssignmentsV2.isActive, true),
        ),
      );
    expect(after.status).toBe("NOMINATED");
    expect(active).toEqual([{ professionalId: titularProId }]);
    expect(vi.mocked(triggerAutoSso)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueDutySync)).not.toHaveBeenCalled();
  });

  it("acceptNomination revalida vínculo dentro da transação após esperar o lock mensal", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const conf = await nominated(assignmentId, shiftId, new Date(Date.now() + 30 * 60_000));
    await setRosterStatus(start, "PUBLISHED");

    let releaseLock!: () => void;
    let rowLocked!: () => void;
    const release = new Promise<void>((resolve) => { releaseLock = resolve; });
    const locked = new Promise<void>((resolve) => { rowLocked = resolve; });
    const locker = db.transaction(async (tx) => {
      await tx
        .select({ id: monthlyRosters.id })
        .from(monthlyRosters)
        .where(
          and(
            eq(monthlyRosters.institutionId, institutionId),
            eq(monthlyRosters.hospitalId, hospitalId),
            eq(monthlyRosters.yearMonth, yearMonthBrt(start)),
          ),
        )
        .for("update");
      rowLocked();
      await release;
    });

    await locked;
    const decision = confirmationRouter
      .createCaller(ctx(subUserId))
      .acceptNomination({ confirmationToken: conf.confirmationToken });
    // A validação externa já ocorreu; a mutação de vínculo acontece enquanto
    // a decisão espera o roster. Sem revalidação dentro da tx, ela venceria.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await db
      .update(professionalInstitutions)
      .set({ active: false })
      .where(
        and(
          eq(professionalInstitutions.professionalId, subProId),
          eq(professionalInstitutions.institutionId, institutionId),
        ),
      );
    releaseLock();
    await locker;

    try {
      await expect(decision).rejects.toMatchObject({ code: "FORBIDDEN" });
      const [after] = await db
        .select({ status: dutyConfirmations.status })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.id, conf.id));
      expect(after.status).toBe("NOMINATED");
      expect(queuedPushMock).not.toHaveBeenCalled();
      expect(vi.mocked(enqueueDutySync)).not.toHaveBeenCalled();
    } finally {
      await db
        .update(professionalInstitutions)
        .set({ active: true })
        .where(
          and(
            eq(professionalInstitutions.professionalId, subProId),
            eq(professionalInstitutions.institutionId, institutionId),
          ),
        );
    }
  });

  it("máquina de estados: grafo é fechado e affectedRows=0 falha com CONFLICT", async () => {
    expect(isAllowedDutyConfirmationTransition("PENDING", "CONFIRMED")).toBe(true);
    expect(isAllowedDutyConfirmationTransition("PENDING", "AUTO_CONFIRMED")).toBe(false);
    expect(isAllowedDutyConfirmationTransition("PENDING", "REPLACEMENT_CONFIRMED")).toBe(false);
    expect(isAllowedDutyConfirmationTransition("CONFIRMED", "DECLINED")).toBe(false);

    const { shiftId, assignmentId } = await shiftWithTitular();
    const conf = await pending(assignmentId, shiftId);
    await db.transaction((tx) =>
      transitionDutyConfirmation(tx, {
        kind: "CONFIRM",
        ...dutyConfirmationCasIdentity(conf),
        expectedStatus: "PENDING",
        respondedAt: new Date(),
      }),
    );

    await expect(
      db.transaction((tx) =>
        transitionDutyConfirmation(tx, {
          kind: "DECLINE",
          ...dutyConfirmationCasIdentity(conf),
          expectedStatus: "PENDING",
          respondedAt: new Date(),
          declineReason: null,
          recheckAt: new Date(Date.now() + 30 * 60_000),
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("cada novo prazo reabre a escalação gerencial nas três transições", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const conf = await pending(assignmentId, shiftId);
    const identity = dutyConfirmationCasIdentity(conf);
    const rechecks = [
      new Date("2032-03-04T10:30:00.000Z"),
      new Date("2032-03-04T11:00:00.000Z"),
      new Date("2032-03-04T11:30:00.000Z"),
    ] as const;

    const markPreviousWindowAsNotified = async () => {
      await db
        .update(dutyConfirmations)
        .set({ managerNotified: true })
        .where(eq(dutyConfirmations.id, conf.id));
      const [before] = await db
        .select({ managerNotified: dutyConfirmations.managerNotified })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.id, conf.id));
      expect(before.managerNotified).toBe(true);
    };
    const expectReopenedWindow = async (
      status: "DECLINED" | "NOMINATED" | "REPLACEMENT_DECLINED",
      recheckAt: Date,
    ) => {
      const [after] = await db
        .select({
          status: dutyConfirmations.status,
          managerNotified: dutyConfirmations.managerNotified,
          recheckAt: dutyConfirmations.recheckAt,
        })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.id, conf.id));
      expect(after.status).toBe(status);
      expect(after.managerNotified).toBe(false);
      expect(after.recheckAt?.toISOString()).toBe(recheckAt.toISOString());
    };

    await markPreviousWindowAsNotified();
    await db.transaction((tx) =>
      transitionDutyConfirmation(tx, {
        kind: "DECLINE",
        ...identity,
        expectedStatus: "PENDING",
        respondedAt: new Date("2032-03-04T10:00:00.000Z"),
        declineReason: "Indisponível",
        recheckAt: rechecks[0],
      }),
    );
    await expectReopenedWindow("DECLINED", rechecks[0]);

    await markPreviousWindowAsNotified();
    await db.transaction((tx) =>
      transitionDutyConfirmation(tx, {
        kind: "NOMINATE",
        ...identity,
        expectedStatus: "DECLINED",
        replacementProfessionalId: subProId,
        replacementUserId: subUserId,
        recheckAt: rechecks[1],
      }),
    );
    await expectReopenedWindow("NOMINATED", rechecks[1]);

    await markPreviousWindowAsNotified();
    await db.transaction((tx) =>
      transitionDutyConfirmation(tx, {
        kind: "DECLINE_NOMINATION",
        ...identity,
        expectedStatus: "NOMINATED",
        expectedReplacementProfessionalId: subProId,
        expectedReplacementUserId: subUserId,
        respondedAt: new Date("2032-03-04T11:05:00.000Z"),
        recheckAt: rechecks[2],
      }),
    );
    await expectReopenedWindow("REPLACEMENT_DECLINED", rechecks[2]);
  });

  it.each([
    "confirm",
    "decline",
    "nominateReplacement",
    "acceptNomination",
    "declineNomination",
  ] as const)("%s revalida a versão da sessão após esperar o mutex operacional", async (operation) => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const conf = operation === "nominateReplacement"
      ? await declined(assignmentId, shiftId)
      : operation === "acceptNomination" || operation === "declineNomination"
        ? await nominated(assignmentId, shiftId)
        : await pending(assignmentId, shiftId);
    const actorUserId = operation === "acceptNomination" || operation === "declineNomination"
      ? subUserId
      : titularUserId;
    const caller = confirmationRouter.createCaller(ctx(actorUserId));

    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    let releaseShift!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseShift = resolve;
    });
    let released = false;
    const blocker = db.transaction(async (tx) => {
      await tx
        .select({ id: shiftInstances.id })
        .from(shiftInstances)
        .where(eq(shiftInstances.id, shiftId))
        .limit(1)
        .for("update");
      signalLocked();
      await release;
    });
    await locked;

    try {
      const decision = operation === "confirm"
        ? caller.confirm({ confirmationToken: conf.confirmationToken })
        : operation === "decline"
          ? caller.decline({ confirmationToken: conf.confirmationToken, reason: "Sessão revogada" })
          : operation === "nominateReplacement"
            ? caller.nominateReplacement({
                confirmationToken: conf.confirmationToken,
                replacementProfessionalId: subProId,
              })
            : operation === "acceptNomination"
              ? caller.acceptNomination({ confirmationToken: conf.confirmationToken })
              : caller.declineNomination({ confirmationToken: conf.confirmationToken });
      let settled = false;
      const outcome = decision.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      ).finally(() => {
        settled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(settled).toBe(false);
      await db
        .update(users)
        .set({ sessionVersion: 2 })
        .where(eq(users.id, actorUserId));

      released = true;
      releaseShift();
      await blocker;
      const result = await outcome;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatchObject({ code: "FORBIDDEN" });

      const [unchanged] = await db
        .select({ status: dutyConfirmations.status })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.id, conf.id));
      expect(unchanged.status).toBe(conf.status);
      expect(queuedPushMock).not.toHaveBeenCalled();
      expect(vi.mocked(enqueueDutySync)).not.toHaveBeenCalled();
      expect(vi.mocked(enqueueAutoSsoPush)).not.toHaveBeenCalled();
      expect(vi.mocked(triggerAutoSso)).not.toHaveBeenCalled();
    } finally {
      if (!released) releaseShift();
      await blocker;
      await db
        .update(users)
        .set({ sessionVersion: 1 })
        .where(eq(users.id, actorUserId));
    }
  });

  it("corrida confirm × decline: um único estado e somente efeitos do vencedor", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const conf = await pending(assignmentId, shiftId);
    const titular = confirmationRouter.createCaller(ctx(titularUserId));

    const results = await Promise.allSettled([
      titular.confirm({ confirmationToken: conf.confirmationToken }),
      titular.decline({ confirmationToken: conf.confirmationToken, reason: "Indisponível" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    const [after] = await db
      .select({ status: dutyConfirmations.status })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, conf.id));
    if (after.status === "CONFIRMED") {
      expect(vi.mocked(triggerAutoSso)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(enqueueAutoSsoPush)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(enqueueDutySync)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(enqueueDutySync)).toHaveBeenCalledWith(
        expect.objectContaining({ confirmationId: conf.id, action: "CONFIRM" }),
        expect.any(Date),
        expect.anything(),
      );
    } else {
      expect(after.status).toBe("DECLINED");
      expect(vi.mocked(triggerAutoSso)).not.toHaveBeenCalled();
      expect(vi.mocked(enqueueAutoSsoPush)).not.toHaveBeenCalled();
      expect(vi.mocked(enqueueDutySync)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(enqueueDutySync)).toHaveBeenCalledWith(
        expect.objectContaining({ confirmationId: conf.id, action: "WITHDRAW" }),
        expect.any(Date),
        expect.anything(),
      );
    }
  });

  it("duas indicações concorrentes: apenas o CAS vencedor envia push", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const [inserted] = await db
      .insert(dutyConfirmations)
      .values({
        institutionId,
        shiftInstanceId: shiftId,
        assignmentId,
        professionalId: titularProId,
        userId: titularUserId,
        status: "DECLINED",
        notifiedAt: new Date(),
        recheckAt: new Date(Date.now() + 30 * 60_000),
        confirmationToken: crypto.randomUUID(),
      })
      .$returningId();
    const [conf] = await db
      .select()
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, inserted.id));
    const titular = confirmationRouter.createCaller(ctx(titularUserId));

    const results = await Promise.allSettled([
      titular.nominateReplacement({
        confirmationToken: conf.confirmationToken,
        replacementProfessionalId: subProId,
      }),
      titular.nominateReplacement({
        confirmationToken: conf.confirmationToken,
        replacementProfessionalId: subProId,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(pushSpy).not.toHaveBeenCalled();
    expect(queuedPushMock).toHaveBeenCalledTimes(1);
    expect(queuedPushMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: subUserId }),
      expect.any(Date),
      expect.anything(),
    );
    expect(trackedPushMock).toHaveBeenCalledTimes(1);

    const [after] = await db
      .select({
        status: dutyConfirmations.status,
        replacementProfessionalId: dutyConfirmations.replacementProfessionalId,
        replacementUserId: dutyConfirmations.replacementUserId,
      })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, conf.id));
    expect(after).toMatchObject({
      status: "NOMINATED",
      replacementProfessionalId: subProId,
      replacementUserId: subUserId,
    });
  });

  it("corrida accept × declineNomination nunca separa confirmação e alocação", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const conf = await nominated(assignmentId, shiftId, new Date(Date.now() + 30 * 60_000));
    const sub = confirmationRouter.createCaller(ctx(subUserId));

    const results = await Promise.allSettled([
      sub.acceptNomination({ confirmationToken: conf.confirmationToken }),
      sub.declineNomination({ confirmationToken: conf.confirmationToken }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    const [after] = await db
      .select({ status: dutyConfirmations.status })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, conf.id));
    const active = await db
      .select({ professionalId: shiftAssignmentsV2.professionalId })
      .from(shiftAssignmentsV2)
      .where(
        and(
          eq(shiftAssignmentsV2.shiftInstanceId, shiftId),
          eq(shiftAssignmentsV2.isActive, true),
        ),
      );

    expect(pushSpy).not.toHaveBeenCalled();
    expect(queuedPushMock).toHaveBeenCalledTimes(1);
    expect(trackedPushMock).toHaveBeenCalledTimes(1);
    if (after.status === "REPLACEMENT_CONFIRMED") {
      expect(active).toEqual([{ professionalId: subProId }]);
      expect(vi.mocked(triggerAutoSso)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(enqueueAutoSsoPush)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(enqueueDutySync)).toHaveBeenCalledWith(
        expect.objectContaining({ confirmationId: conf.id, action: "CONFIRM" }),
        expect.any(Date),
        expect.anything(),
      );
    } else {
      expect(after.status).toBe("REPLACEMENT_DECLINED");
      expect(active).toEqual([{ professionalId: titularProId }]);
      expect(vi.mocked(triggerAutoSso)).not.toHaveBeenCalled();
      expect(vi.mocked(enqueueAutoSsoPush)).not.toHaveBeenCalled();
      expect(vi.mocked(enqueueDutySync)).not.toHaveBeenCalled();
    }
  });

  it("recusa do substituto preserva linhagem, respondedAt e auditoria canônica", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const previousResponse = new Date("2026-01-01T10:00:00.000Z");
    const conf = await nominated(assignmentId, shiftId, new Date(Date.now() + 30 * 60_000));
    await db
      .update(dutyConfirmations)
      .set({ respondedAt: previousResponse })
      .where(eq(dutyConfirmations.id, conf.id));

    await confirmationRouter
      .createCaller(ctx(subUserId))
      .declineNomination({ confirmationToken: conf.confirmationToken });

    const [after] = await db
      .select({
        status: dutyConfirmations.status,
        replacementProfessionalId: dutyConfirmations.replacementProfessionalId,
        replacementUserId: dutyConfirmations.replacementUserId,
        respondedAt: dutyConfirmations.respondedAt,
      })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, conf.id));
    expect(after).toMatchObject({
      status: "REPLACEMENT_DECLINED",
      replacementProfessionalId: subProId,
      replacementUserId: subUserId,
    });
    expect(after.respondedAt?.getTime()).toBeGreaterThan(previousResponse.getTime());

    const [audit] = await db
      .select({
        action: auditTrail.action,
        fromProfessionalId: auditTrail.fromProfessionalId,
        fromUserId: auditTrail.fromUserId,
        toProfessionalId: auditTrail.toProfessionalId,
        toUserId: auditTrail.toUserId,
      })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.action, "TRANSFER_REJECTED"),
          eq(auditTrail.entityId, assignmentId),
        ),
      )
      .orderBy(auditTrail.id);
    expect(audit).toEqual({
      action: "TRANSFER_REJECTED",
      fromProfessionalId: titularProId,
      fromUserId: titularUserId,
      toProfessionalId: subProId,
      toUserId: subUserId,
    });
    expect(queuedPushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          data: expect.objectContaining({
            type: "replacement_declined",
            institutionId,
          }),
        }),
      }),
      expect.any(Date),
      expect.anything(),
    );
  });

  it("indicação com vínculo revogado falha antes de leitura, mutação ou push", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const conf = await nominated(assignmentId, shiftId);
    await db
      .update(professionalInstitutions)
      .set({ active: false })
      .where(
        and(
          eq(professionalInstitutions.professionalId, subProId),
          eq(professionalInstitutions.institutionId, institutionId),
        ),
      );
    const sub = confirmationRouter.createCaller(ctx(subUserId));
    try {
      await expect(
        sub.getNomination({ confirmationToken: conf.confirmationToken }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        sub.acceptNomination({ confirmationToken: conf.confirmationToken }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        sub.declineNomination({ confirmationToken: conf.confirmationToken }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const [after] = await db
        .select({ status: dutyConfirmations.status })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.id, conf.id));
      expect(after.status).toBe("NOMINATED");
      expect(pushSpy).not.toHaveBeenCalled();
    } finally {
      await db
        .update(professionalInstitutions)
        .set({ active: true })
        .where(
          and(
            eq(professionalInstitutions.professionalId, subProId),
            eq(professionalInstitutions.institutionId, institutionId),
          ),
        );
    }
  });

  it("decline e nominateReplacement validam o fluxo público e o vínculo atual do indicado", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const token = crypto.randomUUID();
    const [inserted] = await db
      .insert(dutyConfirmations)
      .values({
        institutionId,
        shiftInstanceId: shiftId,
        assignmentId,
        professionalId: titularProId,
        userId: titularUserId,
        status: "PENDING",
        notifiedAt: new Date(),
        confirmationToken: token,
      })
      .$returningId();
    const titular = confirmationRouter.createCaller(ctx(titularUserId));

    await expect(titular.decline({ confirmationToken: token, reason: "Indisponível" })).resolves.toMatchObject({
      status: "DECLINED",
    });
    expect(vi.mocked(enqueueDutySync)).toHaveBeenCalledWith(
      expect.objectContaining({ confirmationId: inserted.id, action: "WITHDRAW" }),
      expect.any(Date),
      expect.anything(),
    );

    await db
      .update(professionalInstitutions)
      .set({ active: false })
      .where(
        and(
          eq(professionalInstitutions.professionalId, subProId),
          eq(professionalInstitutions.institutionId, institutionId),
        ),
      );
    try {
      await expect(
        titular.nominateReplacement({
          confirmationToken: token,
          replacementProfessionalId: subProId,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(pushSpy).not.toHaveBeenCalled();
      const [unchanged] = await db
        .select({ status: dutyConfirmations.status })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.id, inserted.id));
      expect(unchanged.status).toBe("DECLINED");
    } finally {
      await db
        .update(professionalInstitutions)
        .set({ active: true })
        .where(
          and(
            eq(professionalInstitutions.professionalId, subProId),
            eq(professionalInstitutions.institutionId, institutionId),
          ),
        );
    }

    await db
      .update(professionalAccess)
      .set({ canAccess: false })
      .where(eq(professionalAccess.professionalId, subProId));
    try {
      await expect(
        titular.nominateReplacement({
          confirmationToken: token,
          replacementProfessionalId: subProId,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(pushSpy).not.toHaveBeenCalled();
    } finally {
      await db
        .update(professionalAccess)
        .set({ canAccess: true })
        .where(eq(professionalAccess.professionalId, subProId));
    }

    const [poisonLinkUser] = await db
      .insert(users)
      .values({
        name: `CN poison link ${stamp}`,
        email: `cn-poison-link-${stamp}@test.local`,
        passwordHash: "test",
        role: "doctor",
      })
      .$returningId();
    userIds.push(poisonLinkUser.id);
    await db
      .update(professionalInstitutions)
      .set({ userId: poisonLinkUser.id })
      .where(
        and(
          eq(professionalInstitutions.professionalId, subProId),
          eq(professionalInstitutions.institutionId, institutionId),
        ),
      );
    try {
      await expect(
        titular.nominateReplacement({
          confirmationToken: token,
          replacementProfessionalId: subProId,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(pushSpy).not.toHaveBeenCalled();
    } finally {
      await db
        .update(professionalInstitutions)
        .set({ userId: subUserId })
        .where(
          and(
            eq(professionalInstitutions.professionalId, subProId),
            eq(professionalInstitutions.institutionId, institutionId),
          ),
        );
    }

    await expect(
      titular.nominateReplacement({
        confirmationToken: token,
        replacementProfessionalId: subProId,
      }),
    ).resolves.toMatchObject({ status: "NOMINATED" });
    expect(queuedPushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: subUserId,
        payload: expect.objectContaining({
          data: expect.objectContaining({
            confirmationToken: token,
            institutionId,
            type: "duty_nomination",
          }),
        }),
      }),
      expect.any(Date),
      expect.anything(),
    );
  });

  it("decline e nominateReplacement recusam confirmação cuja identidade diverge da alocação", async () => {
    const sub = confirmationRouter.createCaller(ctx(subUserId));

    const first = await shiftWithTitular();
    const declineToken = crypto.randomUUID();
    const [declinePoisoned] = await db
      .insert(dutyConfirmations)
      .values({
        institutionId,
        shiftInstanceId: first.shiftId,
        assignmentId: first.assignmentId,
        professionalId: subProId,
        userId: subUserId,
        status: "PENDING",
        notifiedAt: new Date(),
        confirmationToken: declineToken,
      })
      .$returningId();
    await expect(
      sub.decline({ confirmationToken: declineToken, reason: "Não deveria alterar" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const second = await shiftWithTitular();
    const nominateToken = crypto.randomUUID();
    const [nominatePoisoned] = await db
      .insert(dutyConfirmations)
      .values({
        institutionId,
        shiftInstanceId: second.shiftId,
        assignmentId: second.assignmentId,
        professionalId: subProId,
        userId: subUserId,
        status: "DECLINED",
        notifiedAt: new Date(),
        confirmationToken: nominateToken,
      })
      .$returningId();
    await expect(
      sub.nominateReplacement({
        confirmationToken: nominateToken,
        replacementProfessionalId: titularProId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const rows = await db
      .select({ id: dutyConfirmations.id, status: dutyConfirmations.status })
      .from(dutyConfirmations)
      .where(inArray(dutyConfirmations.id, [declinePoisoned.id, nominatePoisoned.id]));
    expect(new Map(rows.map((row) => [row.id, row.status]))).toEqual(
      new Map([
        [declinePoisoned.id, "PENDING"],
        [nominatePoisoned.id, "DECLINED"],
      ]),
    );
    expect(pushSpy).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueDutySync)).not.toHaveBeenCalled();
  });

  it("rechecagem: NOMINATED sem aceite preserva estado e alocação, sem efeitos de confirmação", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const conf = await nominated(assignmentId, shiftId);
    await processRechecks(new Date());
    const [row] = await db.select().from(dutyConfirmations).where(eq(dutyConfirmations.id, conf.id));
    expect(row.status).toBe("NOMINATED");
    expect(row.replacementUserId).toBe(subUserId);
    expect(row.replacementProfessionalId).toBe(subProId);
    // Sem gestor elegível não há destino seguro para o alerta; o prazo
    // permanece devido para retry em vez de ser consumido silenciosamente.
    expect(row.recheckAt).not.toBeNull();
    expect(pushSpy).not.toHaveBeenCalled();
    expect(trackedPushMock).not.toHaveBeenCalled();
    expect(queuedPushMock).not.toHaveBeenCalled();
    expect(vi.mocked(triggerAutoSso)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueDutySync)).not.toHaveBeenCalled();
    // Titular continua sendo o alocado.
    const active = await db.select({ professionalId: shiftAssignmentsV2.professionalId }).from(shiftAssignmentsV2).where(and(eq(shiftAssignmentsV2.shiftInstanceId, shiftId), eq(shiftAssignmentsV2.isActive, true)));
    expect(active).toEqual([{ professionalId: titularProId }]);
  });

  it("rechecagem não consome o prazo quando a intenção gerencial falha", async () => {
    const manager = await person("manager-recheck");
    await db
      .update(professionalInstitutions)
      .set({ roleInInstitution: "GESTOR_PLUS" })
      .where(
        and(
          eq(professionalInstitutions.professionalId, manager.proId),
          eq(professionalInstitutions.institutionId, institutionId),
        ),
      );
    const { shiftId, assignmentId } = await shiftWithTitular();
    const [inserted] = await db
      .insert(dutyConfirmations)
      .values({
        institutionId,
        shiftInstanceId: shiftId,
        assignmentId,
        professionalId: titularProId,
        userId: titularUserId,
        status: "PENDING",
        confirmationToken: crypto.randomUUID(),
        recheckAt: new Date(Date.now() - 60_000),
      })
      .$returningId();
    queuedPushMock.mockRejectedValueOnce(new Error("outbox indisponível"));

    await processRechecks(new Date());

    const [after] = await db
      .select({ status: dutyConfirmations.status, recheckAt: dutyConfirmations.recheckAt })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, inserted.id));
    expect(after.status).toBe("PENDING");
    expect(after.recheckAt).not.toBeNull();
    expect(trackedPushMock).not.toHaveBeenCalled();
    expect(queuedPushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          data: expect.objectContaining({
            type: "manager_confirmation_escalation",
            institutionId,
          }),
        }),
      }),
    );
  });

  it("rechecagem preserva o prazo quando a validação falha por infraestrutura", async () => {
    const sentinel = "DRIZZLE_RECHECK_CONFIRMATION_TOKEN_SENTINEL";
    const { shiftId, assignmentId } = await shiftWithTitular();
    const recheckAt = new Date(Date.now() - 60_000);
    const [inserted] = await db
      .insert(dutyConfirmations)
      .values({
        institutionId,
        shiftInstanceId: shiftId,
        assignmentId,
        professionalId: titularProId,
        userId: titularUserId,
        status: "PENDING",
        confirmationToken: crypto.randomUUID(),
        recheckAt,
      })
      .$returningId();
    const [before] = await db
      .select({ recheckAt: dutyConfirmations.recheckAt })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, inserted.id));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const transactionSpy = vi
      .spyOn(db as any, "transaction")
      .mockImplementationOnce(async (callback: any) => callback({
        select: () => {
          throw new DrizzleQueryError(
            "select duty_confirmations where confirmation_token = ?",
            [sentinel],
            new Error(sentinel),
          );
        },
      }));

    try {
      try {
        await processRechecks(new Date());
      } finally {
        transactionSpy.mockRestore();
      }

      const [after] = await db
        .select({ status: dutyConfirmations.status, recheckAt: dutyConfirmations.recheckAt })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.id, inserted.id));
      expect(after.status).toBe("PENDING");
      expect(after.recheckAt?.toISOString()).toBe(before.recheckAt?.toISOString());
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain(sentinel);
      expect(queuedPushMock).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  it("rechecagem: alocação removida → encerra sem auto-confirmar; confirm manual → erro claro", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const [c] = await db
      .insert(dutyConfirmations)
      .values({ institutionId, shiftInstanceId: shiftId, assignmentId, professionalId: titularProId, userId: titularUserId, status: "PENDING", notifiedAt: new Date(), recheckAt: new Date(Date.now() - 60_000), confirmationToken: crypto.randomUUID() })
      .$returningId();
    await db.update(shiftAssignmentsV2).set({ isActive: false }).where(eq(shiftAssignmentsV2.id, assignmentId));
    const [conf] = await db.select().from(dutyConfirmations).where(eq(dutyConfirmations.id, c.id));

    await expect(confirmationRouter.createCaller(ctx(titularUserId)).confirm({ confirmationToken: conf.confirmationToken })).rejects.toMatchObject({ code: "BAD_REQUEST" });

    await processRechecks(new Date());
    const [row] = await db.select().from(dutyConfirmations).where(eq(dutyConfirmations.id, c.id));
    expect(row.status).toBe("PENDING");
    expect(row.recheckAt).toBeNull();
    expect(pushSpy).not.toHaveBeenCalled();
  });

  it("não confirma candidatura PENDENTE nem titular sem acesso ao setor", async () => {
    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId,
        sectorId,
        label: `CN gate ${stamp}`,
        startAt: start,
        endAt: end,
        status: "PENDENTE",
      })
      .$returningId();
    const [assignment] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId: shift.id,
        institutionId,
        hospitalId,
        sectorId,
        professionalId: titularProId,
        assignmentType: "ON_DUTY",
        status: "PENDENTE",
        isActive: true,
        createdBy: titularUserId,
      })
      .$returningId();
    const trigger = {
      notifyHour: 11,
      notifyMinute: 0,
      shiftStartTime: "13:00",
      shiftEndTime: "19:00",
      label: "Tarde",
      shiftNextDay: false,
    };
    const dispatchAt = new Date(`${shiftDay}T11:07:00-03:00`);

    await dispatchConfirmations(dispatchAt, trigger);
    expect(
      await db
        .select({ id: dutyConfirmations.id })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.assignmentId, assignment.id)),
    ).toHaveLength(0);
    expect(pushSpy).not.toHaveBeenCalled();
    expect(trackedPushMock).not.toHaveBeenCalled();

    const pendingToken = crypto.randomUUID();
    const [pending] = await db
      .insert(dutyConfirmations)
      .values({
        institutionId,
        shiftInstanceId: shift.id,
        assignmentId: assignment.id,
        professionalId: titularProId,
        userId: titularUserId,
        status: "PENDING",
        notifiedAt: new Date(),
        confirmationToken: pendingToken,
      })
      .$returningId();
    await expect(
      confirmationRouter.createCaller(ctx(titularUserId)).confirm({ confirmationToken: pendingToken }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await db.delete(dutyConfirmations).where(eq(dutyConfirmations.id, pending.id));

    await db
      .update(shiftAssignmentsV2)
      .set({ status: "OCUPADO" })
      .where(eq(shiftAssignmentsV2.id, assignment.id));
    await db.update(shiftInstances).set({ status: "OCUPADO" }).where(eq(shiftInstances.id, shift.id));
    await db
      .update(professionalAccess)
      .set({ canAccess: false })
      .where(eq(professionalAccess.professionalId, titularProId));
    try {
      await dispatchConfirmations(dispatchAt, trigger);
      expect(
        await db
          .select({ id: dutyConfirmations.id })
          .from(dutyConfirmations)
          .where(eq(dutyConfirmations.assignmentId, assignment.id)),
      ).toHaveLength(0);

      const noAccessToken = crypto.randomUUID();
      const [noAccess] = await db
        .insert(dutyConfirmations)
        .values({
          institutionId,
          shiftInstanceId: shift.id,
          assignmentId: assignment.id,
          professionalId: titularProId,
          userId: titularUserId,
          status: "PENDING",
          notifiedAt: new Date(),
          confirmationToken: noAccessToken,
        })
        .$returningId();
      await expect(
        confirmationRouter.createCaller(ctx(titularUserId)).confirm({
          confirmationToken: noAccessToken,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const [unchanged] = await db
        .select({ status: dutyConfirmations.status })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.id, noAccess.id));
      expect(unchanged.status).toBe("PENDING");
      expect(pushSpy).not.toHaveBeenCalled();
      expect(trackedPushMock).not.toHaveBeenCalled();
    } finally {
      await db
        .update(professionalAccess)
        .set({ canAccess: true })
        .where(eq(professionalAccess.professionalId, titularProId));
    }
  });

  it("cron: disparo dentro da janela é idempotente (uma confirmação por alocação)", async () => {
    const { assignmentId } = await shiftWithTitular();
    // Gatilho "Tarde" (11:00 → plantão 13:00 do mesmo dia), simulando 11:07 no dia do plantão.
    const trigger = { notifyHour: 11, notifyMinute: 0, shiftStartTime: "13:00", shiftEndTime: "19:00", label: "Tarde", shiftNextDay: false };
    const at1107 = new Date(`${shiftDay}T11:07:00-03:00`);
    await dispatchConfirmations(at1107, trigger);
    await dispatchConfirmations(new Date(at1107.getTime() + 60_000), trigger);
    const rows = await db.select({ id: dutyConfirmations.id }).from(dutyConfirmations).where(eq(dutyConfirmations.assignmentId, assignmentId));
    expect(rows).toHaveLength(1);
    expect(trackedPushMock).toHaveBeenCalledTimes(1);
    expect(queuedPushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          data: expect.objectContaining({
            type: "duty_confirmation",
            institutionId,
          }),
        }),
      }),
      expect.any(Date),
      expect.anything(),
    );
  });

  it("cron materializa todos os intents antes da rede e limita submissões concorrentes", async () => {
    const { shiftId } = await shiftWithTitular();
    const additional = [
      { userId: subUserId, proId: subProId },
      await person("batch-2"),
      await person("batch-3"),
      await person("batch-4"),
      await person("batch-5"),
    ];
    await db.insert(shiftAssignmentsV2).values(additional.map((personRow) => ({
      shiftInstanceId: shiftId,
      institutionId,
      hospitalId,
      sectorId,
      professionalId: personRow.proId,
      assignmentType: "ON_DUTY" as const,
      status: "OCUPADO" as const,
      isActive: true,
      createdBy: titularUserId,
    })));
    const trigger = {
      notifyHour: 11,
      notifyMinute: 0,
      shiftStartTime: "13:00",
      shiftEndTime: "19:00",
      label: "Tarde",
      shiftNextDay: false,
    };
    const dispatchAt = new Date(`${shiftDay}T11:07:00-03:00`);
    let inFlight = 0;
    let maxInFlight = 0;
    let firstSubmission = true;
    trackedPushMock.mockImplementation(async () => {
      if (firstSubmission) {
        firstSubmission = false;
        const materialized = await db
          .select({ id: dutyConfirmations.id })
          .from(dutyConfirmations)
          .where(eq(dutyConfirmations.shiftInstanceId, shiftId));
        expect(materialized).toHaveLength(6);
        expect(queuedPushMock).toHaveBeenCalledTimes(6);
      }
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
      return {
        notificationId: 1,
        status: "PENDING" as const,
        phase: "TICKET_ACCEPTED" as const,
        ticketAccepted: true,
        providerAccepted: false,
      };
    });

    await dispatchConfirmations(dispatchAt, trigger);

    expect(queuedPushMock).toHaveBeenCalledTimes(6);
    expect(trackedPushMock).toHaveBeenCalledTimes(6);
    expect(maxInFlight).toBe(5);
  });

  it("cron revalida conta APPROVED depois de aguardar o lock operacional", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const trigger = {
      notifyHour: 11,
      notifyMinute: 0,
      shiftStartTime: "13:00",
      shiftEndTime: "19:00",
      label: "Tarde",
      shiftNextDay: false,
    };
    const dispatchAt = new Date(`${shiftDay}T11:07:00-03:00`);
    let releaseShift!: () => void;
    const holdShift = new Promise<void>((resolve) => {
      releaseShift = resolve;
    });
    let signalShiftLocked!: () => void;
    const shiftLocked = new Promise<void>((resolve) => {
      signalShiftLocked = resolve;
    });
    const blocker = db.transaction(async (tx) => {
      await tx
        .select({ id: shiftInstances.id })
        .from(shiftInstances)
        .where(eq(shiftInstances.id, shiftId))
        .limit(1)
        .for("update");
      signalShiftLocked();
      await holdShift;
    });
    await shiftLocked;

    const originalTransaction = db.transaction.bind(db);
    let signalInnerStarted!: () => void;
    const innerStarted = new Promise<void>((resolve) => {
      signalInnerStarted = resolve;
    });
    const transactionSpy = vi.spyOn(db as any, "transaction");
    transactionSpy.mockImplementation((...args: any[]) => {
      signalInnerStarted();
      return (originalTransaction as any)(...args);
    });

    try {
      const dispatch = dispatchConfirmations(dispatchAt, trigger);
      await innerStarted;
      await db
        .update(users)
        .set({ approvalStatus: "PENDING" })
        .where(eq(users.id, titularUserId));
      releaseShift();
      await blocker;
      await dispatch;

      expect(
        await db
          .select({ id: dutyConfirmations.id })
          .from(dutyConfirmations)
          .where(eq(dutyConfirmations.assignmentId, assignmentId)),
      ).toHaveLength(0);
      expect(queuedPushMock).not.toHaveBeenCalled();
      expect(trackedPushMock).not.toHaveBeenCalled();
    } finally {
      releaseShift();
      await blocker.catch(() => undefined);
      transactionSpy.mockRestore();
      await db
        .update(users)
        .set({ approvalStatus: "APPROVED", deletedAt: null })
        .where(eq(users.id, titularUserId));
    }
  });

  it("cron não cria confirmação para roster ausente/DRAFT e libera somente PUBLISHED", async () => {
    const { assignmentId } = await shiftWithTitular();
    const trigger = { notifyHour: 11, notifyMinute: 0, shiftStartTime: "13:00", shiftEndTime: "19:00", label: "Tarde", shiftNextDay: false };
    const dispatchAt = new Date(`${shiftDay}T11:07:00-03:00`);

    await db.delete(monthlyRosters).where(
      and(
        eq(monthlyRosters.institutionId, institutionId),
        eq(monthlyRosters.hospitalId, hospitalId),
        eq(monthlyRosters.yearMonth, yearMonthBrt(start)),
      ),
    );
    await dispatchConfirmations(dispatchAt, trigger);
    expect(
      await db
        .select({ id: dutyConfirmations.id })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.assignmentId, assignmentId)),
    ).toHaveLength(0);
    expect(queuedPushMock).not.toHaveBeenCalled();
    expect(trackedPushMock).not.toHaveBeenCalled();

    await setRosterStatus(start, "DRAFT");
    await dispatchConfirmations(dispatchAt, trigger);
    expect(
      await db
        .select({ id: dutyConfirmations.id })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.assignmentId, assignmentId)),
    ).toHaveLength(0);
    expect(queuedPushMock).not.toHaveBeenCalled();
    expect(trackedPushMock).not.toHaveBeenCalled();

    await setRosterStatus(start, "PUBLISHED");
    await dispatchConfirmations(dispatchAt, trigger);
    expect(
      await db
        .select({ id: dutyConfirmations.id })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.assignmentId, assignmentId)),
    ).toHaveLength(1);
    expect(queuedPushMock).toHaveBeenCalledTimes(1);
    expect(trackedPushMock).toHaveBeenCalledTimes(1);
  });

  it("leitura e confirmação falham em DRAFT, mas confirmação permanece válida em LOCKED", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const conf = await pending(assignmentId, shiftId);
    const titular = confirmationRouter.createCaller(ctx(titularUserId));

    await setRosterStatus(start, "DRAFT");
    await expect(titular.getPending()).resolves.toBeNull();
    await expect(
      titular.confirm({ confirmationToken: conf.confirmationToken }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [unchanged] = await db
      .select({ status: dutyConfirmations.status })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, conf.id));
    expect(unchanged.status).toBe("PENDING");
    expect(vi.mocked(enqueueDutySync)).not.toHaveBeenCalled();
    expect(vi.mocked(enqueueAutoSsoPush)).not.toHaveBeenCalled();

    await setRosterStatus(start, "PUBLISHED");
    await expect(titular.getPending()).resolves.toMatchObject({ id: conf.id });
    await setRosterStatus(start, "LOCKED");
    await expect(
      titular.confirm({ confirmationToken: conf.confirmationToken }),
    ).resolves.toMatchObject({ status: "CONFIRMED" });
    const [confirmed] = await db
      .select({ status: dutyConfirmations.status })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, conf.id));
    expect(confirmed.status).toBe("CONFIRMED");
    expect(vi.mocked(enqueueDutySync)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueAutoSsoPush)).toHaveBeenCalledTimes(1);
  });

  it("getPending dirigido usa exatamente o token do push e nunca substitui por outra pendência", async () => {
    const firstShift = await shiftWithTitular();
    const secondShift = await shiftWithTitular();
    const first = await pending(firstShift.assignmentId, firstShift.shiftId);
    const second = await pending(secondShift.assignmentId, secondShift.shiftId);
    const titular = confirmationRouter.createCaller(ctx(titularUserId));

    await expect(titular.getPending()).resolves.toMatchObject({ id: first.id });
    await expect(
      titular.getPending({ confirmationToken: second.confirmationToken }),
    ).resolves.toMatchObject({
      id: second.id,
      confirmationToken: second.confirmationToken,
      shiftInstanceId: secondShift.shiftId,
    });
    await expect(
      confirmationRouter.createCaller(ctx(subUserId)).getPending({
        confirmationToken: second.confirmationToken,
      }),
    ).resolves.toBeNull();
    await expect(
      titular.getPending({ confirmationToken: crypto.randomUUID() }),
    ).resolves.toBeNull();
    await expect(
      titular.getPending({ confirmationToken: "token-malformado" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("cron reverte a confirmação quando não consegue persistir o outbox", async () => {
    const { assignmentId } = await shiftWithTitular();
    const trigger = { notifyHour: 11, notifyMinute: 0, shiftStartTime: "13:00", shiftEndTime: "19:00", label: "Tarde", shiftNextDay: false };
    const dispatchAt = new Date(`${shiftDay}T11:07:00-03:00`);
    queuedPushMock.mockRejectedValueOnce(new Error("outbox indisponível"));

    await expect(dispatchConfirmations(dispatchAt, trigger)).rejects.toThrow("outbox indisponível");
    expect(
      await db
        .select({ id: dutyConfirmations.id })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.assignmentId, assignmentId)),
    ).toHaveLength(0);
    expect(trackedPushMock).not.toHaveBeenCalled();
  });

  it("início do plantão não produz sso_ready quando o destino SSO é inválido", async () => {
    const { shiftId, assignmentId } = await shiftWithTitular();
    const [confirmation] = await db
      .insert(dutyConfirmations)
      .values({
        institutionId,
        shiftInstanceId: shiftId,
        assignmentId,
        professionalId: titularProId,
        userId: titularUserId,
        status: "CONFIRMED",
        notifiedAt: new Date(start.getTime() - 60 * 60_000),
        confirmationToken: crypto.randomUUID(),
      })
      .$returningId();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SSO_TARGET_URL", "https://user:secret@comunica.example");
    try {
      await processShiftStartPushes(new Date(start.getTime() + 2 * 60_000));
      expect(trackedPushMock).not.toHaveBeenCalled();
      const [after] = await db
        .select({ startPushSentAt: dutyConfirmations.startPushSentAt })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.id, confirmation.id));
      expect(after.startPushSentAt).toBeNull();
    } finally {
      warning.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("push token: troca de conta reatribui; desregistro remove", async () => {
    const token = `ExponentPushToken[cn-${stamp}]`;
    await confirmationRouter.createCaller(ctx(titularUserId)).registerPushToken({
      token,
      platform: "ios",
      expectedUserId: titularUserId,
    });
    await confirmationRouter.createCaller(ctx(subUserId)).registerPushToken({
      token,
      platform: "ios",
      expectedUserId: subUserId,
    });
    const [row] = await db.select({ userId: pushTokens.userId }).from(pushTokens).where(eq(pushTokens.token, token));
    expect(row.userId).toBe(subUserId);
    await confirmationRouter.createCaller(ctx(subUserId)).unregisterPushToken({
      token,
      expectedUserId: subUserId,
    });
    const left = await db.select({ id: pushTokens.id }).from(pushTokens).where(eq(pushTokens.token, token));
    expect(left).toHaveLength(0);
  });

  it("push token: registra pela sessão mesmo antes da hidratação do tenant", async () => {
    const token = `ExponentPushToken[cn-account-scoped-${stamp}]`;
    const accountOnlyContext = {
      ...ctx(titularUserId),
      institutionId: null,
      allowedInstitutionIds: [],
    };

    try {
      await expect(
        confirmationRouter.createCaller(accountOnlyContext).registerPushToken({
          token,
          platform: "ios",
          expectedUserId: titularUserId,
        }),
      ).resolves.toEqual({ success: true, message: "Token registrado com sucesso" });
      const rows = await db
        .select({ userId: pushTokens.userId, institutionId: pushTokens.institutionId })
        .from(pushTokens)
        .where(eq(pushTokens.token, token));
      expect(rows).toEqual([{ userId: titularUserId, institutionId: null }]);
    } finally {
      await db.delete(pushTokens).where(eq(pushTokens.token, token));
    }
  });

  it("push token: replacement nunca apaga previousToken de outro usuário", async () => {
    const previousToken = `ExponentPushToken[cn-wrong-owner-previous-${stamp}]`;
    const currentToken = `ExponentPushToken[cn-wrong-owner-current-${stamp}]`;
    try {
      await confirmationRouter.createCaller(ctx(subUserId)).registerPushToken({
        token: previousToken,
        platform: "android",
        expectedUserId: subUserId,
      });
      await expect(
        confirmationRouter.createCaller(ctx(titularUserId)).registerPushToken({
          token: currentToken,
          previousToken,
          platform: "ios",
          expectedUserId: titularUserId,
        }),
      ).resolves.toMatchObject({ success: true });

      const rows = await db
        .select({ token: pushTokens.token, userId: pushTokens.userId })
        .from(pushTokens)
        .where(inArray(pushTokens.token, [previousToken, currentToken]));
      expect(rows).toEqual(expect.arrayContaining([
        { token: previousToken, userId: subUserId },
        { token: currentToken, userId: titularUserId },
      ]));
      expect(rows).toHaveLength(2);
    } finally {
      await db.delete(pushTokens).where(inArray(pushTokens.token, [previousToken, currentToken]));
    }
  });

  it("push token: previousToken desconhecido não remove outro aparelho da conta", async () => {
    const unknownPrevious = `ExponentPushToken[cn-unknown-previous-${stamp}]`;
    const otherDevice = `ExponentPushToken[cn-other-device-${stamp}]`;
    const currentToken = `ExponentPushToken[cn-unknown-current-${stamp}]`;
    try {
      await confirmationRouter.createCaller(ctx(titularUserId)).registerPushToken({
        token: otherDevice,
        platform: "android",
        expectedUserId: titularUserId,
      });
      await expect(
        confirmationRouter.createCaller(ctx(titularUserId)).registerPushToken({
          token: currentToken,
          previousToken: unknownPrevious,
          platform: "ios",
          expectedUserId: titularUserId,
        }),
      ).resolves.toMatchObject({ success: true });

      const rows = await db
        .select({ token: pushTokens.token })
        .from(pushTokens)
        .where(inArray(pushTokens.token, [unknownPrevious, otherDevice, currentToken]));
      expect(rows.map((row) => row.token).sort()).toEqual([currentToken, otherDevice].sort());
    } finally {
      await db
        .delete(pushTokens)
        .where(inArray(pushTokens.token, [unknownPrevious, otherDevice, currentToken]));
    }
  });

  it("push token: dois rollovers substituem só a cadeia citada e preservam multi-device", async () => {
    const tokenT1 = `ExponentPushToken[cn-rollover-t1-${stamp}]`;
    const tokenT2 = `ExponentPushToken[cn-rollover-t2-${stamp}]`;
    const tokenT3 = `ExponentPushToken[cn-rollover-t3-${stamp}]`;
    const otherDevice = `ExponentPushToken[cn-rollover-other-${stamp}]`;
    const tokens = [tokenT1, tokenT2, tokenT3, otherDevice];
    try {
      await confirmationRouter.createCaller(ctx(titularUserId)).registerPushToken({
        token: tokenT1,
        platform: "ios",
        expectedUserId: titularUserId,
      });
      await confirmationRouter.createCaller(ctx(titularUserId)).registerPushToken({
        token: otherDevice,
        platform: "android",
        expectedUserId: titularUserId,
      });
      await confirmationRouter.createCaller(ctx(titularUserId)).registerPushToken({
        token: tokenT2,
        previousToken: tokenT1,
        platform: "ios",
        expectedUserId: titularUserId,
      });
      await confirmationRouter.createCaller(ctx(titularUserId)).registerPushToken({
        token: tokenT3,
        previousToken: tokenT2,
        platform: "ios",
        expectedUserId: titularUserId,
      });

      const rows = await db
        .select({ token: pushTokens.token, userId: pushTokens.userId })
        .from(pushTokens)
        .where(inArray(pushTokens.token, tokens));
      expect(rows).toEqual(expect.arrayContaining([
        { token: tokenT3, userId: titularUserId },
        { token: otherDevice, userId: titularUserId },
      ]));
      expect(rows).toHaveLength(2);
    } finally {
      await db.delete(pushTokens).where(inArray(pushTokens.token, tokens));
    }
  });

  it("push token: schema rejeita 513 caracteres antes de serviço, DB ou mutex", async () => {
    const token = "x".repeat(513);
    const validToken = `ExponentPushToken[cn-valid-${stamp}]`;
    const registerSpy = vi.spyOn(pushService, "registerPushToken");
    const unregisterSpy = vi.spyOn(pushService, "unregisterPushToken");
    try {
      await expect(
        confirmationRouter.createCaller(ctx(titularUserId)).registerPushToken({
          token,
          platform: "ios",
          expectedUserId: titularUserId,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        confirmationRouter.createCaller(ctx(titularUserId)).unregisterPushToken({
          token,
          expectedUserId: titularUserId,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        confirmationRouter.createCaller(ctx(titularUserId)).registerPushToken({
          token: validToken,
          previousToken: token,
          platform: "ios",
          expectedUserId: titularUserId,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(registerSpy).not.toHaveBeenCalled();
      expect(unregisterSpy).not.toHaveBeenCalled();
    } finally {
      registerSpy.mockRestore();
      unregisterSpy.mockRestore();
    }
  });

  it("push token: expectedUserId divergente nunca alcança serviço nem ownership", async () => {
    const token = `ExponentPushToken[wrong-user-${stamp}]`;
    const registerSpy = vi.spyOn(pushService, "registerPushToken");
    const unregisterSpy = vi.spyOn(pushService, "unregisterPushToken");
    try {
      await expect(
        confirmationRouter.createCaller(ctx(titularUserId)).registerPushToken({
          token,
          platform: "ios",
          expectedUserId: subUserId,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        confirmationRouter.createCaller(ctx(titularUserId)).unregisterPushToken({
          token,
          expectedUserId: subUserId,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(registerSpy).not.toHaveBeenCalled();
      expect(unregisterSpy).not.toHaveBeenCalled();
      await expect(
        db.select({ id: pushTokens.id }).from(pushTokens).where(eq(pushTokens.token, token)),
      ).resolves.toHaveLength(0);
    } finally {
      registerSpy.mockRestore();
      unregisterSpy.mockRestore();
    }
  });

  it("push token: sessão revogada não registra nem reassocia ownership", async () => {
    const token = `ExponentPushToken[cn-stale-session-${stamp}]`;
    await db
      .update(users)
      .set({ sessionVersion: 2 })
      .where(eq(users.id, titularUserId));
    try {
      await expect(
        confirmationRouter
          .createCaller(ctx(titularUserId))
          .registerPushToken({ token, platform: "ios", expectedUserId: titularUserId }),
      ).resolves.toMatchObject({ success: false, message: "Sessão revogada" });
      await expect(
        db.select({ id: pushTokens.id }).from(pushTokens).where(eq(pushTokens.token, token)),
      ).resolves.toHaveLength(0);
    } finally {
      await db
        .update(users)
        .set({ sessionVersion: 1 })
        .where(eq(users.id, titularUserId));
    }
  });

  it("push token: registros concorrentes mantêm ownership único", async () => {
    const token = `ExponentPushToken[cn-race-${stamp}]`;
    const attempts = Array.from({ length: 8 }, (_, index) => {
      const targetUserId = index % 2 === 0 ? titularUserId : subUserId;
      return confirmationRouter
        .createCaller(ctx(targetUserId))
        .registerPushToken({
          token,
          platform: index % 2 === 0 ? "ios" : "android",
          expectedUserId: targetUserId,
        });
    });

    const results = await Promise.all(attempts);
    expect(results.every((result) => result.success)).toBe(true);
    const rows = await db
      .select({ userId: pushTokens.userId })
      .from(pushTokens)
      .where(eq(pushTokens.token, token));
    expect(rows).toHaveLength(1);
    expect([titularUserId, subUserId]).toContain(rows[0].userId);

    await confirmationRouter
      .createCaller(ctx(subUserId))
      .registerPushToken({ token, platform: "android", expectedUserId: subUserId });
    const [canonical] = await db
      .select({ userId: pushTokens.userId })
      .from(pushTokens)
      .where(eq(pushTokens.token, token));
    expect(canonical.userId).toBe(subUserId);
    await confirmationRouter.createCaller(ctx(subUserId)).unregisterPushToken({
      token,
      expectedUserId: subUserId,
    });
  });

  it("push token: igualdade é binária e whitespace falha antes de DB/mutex", async () => {
    const upper = `ExponentPushToken[Case-${stamp}]`;
    const lower = `ExponentPushToken[case-${stamp}]`;
    const serviceSpy = vi.spyOn(pushService, "registerPushToken");
    try {
      await expect(
        confirmationRouter.createCaller(ctx(titularUserId)).registerPushToken({
          token: `${upper} `,
          platform: "ios",
          expectedUserId: titularUserId,
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(serviceSpy).not.toHaveBeenCalled();

      await confirmationRouter.createCaller(ctx(titularUserId)).registerPushToken({
        token: upper,
        platform: "ios",
        expectedUserId: titularUserId,
      });
      await confirmationRouter.createCaller(ctx(titularUserId)).registerPushToken({
        token: lower,
        platform: "ios",
        expectedUserId: titularUserId,
      });
      const rows = await db
        .select({ token: pushTokens.token })
        .from(pushTokens)
        .where(inArray(pushTokens.token, [upper, lower]));
      expect(rows.map((row) => row.token).sort()).toEqual([upper, lower].sort());
    } finally {
      serviceSpy.mockRestore();
      await db.delete(pushTokens).where(inArray(pushTokens.token, [upper, lower]));
    }
  });

  it("migração push-token executa quarentena e instala contrato binário no MySQL", async () => {
    const suffix = `${process.pid}_${stamp}`;
    const fixture = `pt_mig_${suffix}`;
    const duplicateIds = `pt_dup_ids_${suffix}`;
    const checkName = `chk_pt_ws_${suffix}`;
    const connection = await db.$client.promise().getConnection();
    try {
      await connection.query(`DROP TABLE IF EXISTS \`${fixture}\``);
      await connection.query(`
        CREATE TABLE \`${fixture}\` (
          id INT AUTO_INCREMENT PRIMARY KEY,
          institution_id INT NOT NULL,
          user_id INT NOT NULL,
          token VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci NOT NULL
        ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
      `);
      await connection.query(
        `INSERT INTO \`${fixture}\` (institution_id, user_id, token)
         VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)`,
        [
          institutionId, 101, "CaseAlias",
          institutionId, 202, "casealias",
          institutionId, 303, "DuplicateToken",
          institutionId, 404, "DuplicateToken",
          institutionId, 505, "WhitespaceToken ",
        ],
      );

      await connection.query(`LOCK TABLES \`${fixture}\` WRITE`);
      await connection.query(`
        CREATE TEMPORARY TABLE \`${duplicateIds}\` (
          id INT NOT NULL PRIMARY KEY
        ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
      `);
      await connection.query(`
        INSERT INTO \`${duplicateIds}\` (id)
        SELECT duplicate_rows.id
        FROM (
          SELECT id, COUNT(*) OVER (PARTITION BY token) AS duplicate_count
          FROM \`${fixture}\`
        ) AS duplicate_rows
        WHERE duplicate_rows.duplicate_count > 1
      `);
      await connection.query(`
        DELETE \`${fixture}\` FROM \`${fixture}\`
        INNER JOIN \`${duplicateIds}\` AS duplicated ON duplicated.id = \`${fixture}\`.id
      `);
      await connection.query(`DROP TEMPORARY TABLE \`${duplicateIds}\``);
      await connection.query(`DELETE FROM \`${fixture}\` WHERE token REGEXP '[[:space:]]'`);
      await connection.query(`
        ALTER TABLE \`${fixture}\`
          MODIFY COLUMN institution_id INT NULL,
          MODIFY COLUMN token VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
          ADD UNIQUE INDEX uniq_push_token (token),
          ADD CONSTRAINT \`${checkName}\` CHECK (token NOT REGEXP '[[:space:]]')
      `);
      await connection.query(`UNLOCK TABLES`);

      const [quarantined] = await connection.query(
        `SELECT COUNT(*) AS total FROM \`${fixture}\``,
      );
      expect(Number((quarantined as { total: number }[])[0]?.total)).toBe(0);

      await connection.query(
        `INSERT INTO \`${fixture}\` (institution_id, user_id, token) VALUES (NULL, ?, ?), (?, ?, ?)`,
        [606, "CaseToken", institutionId, 707, "casetoken"],
      );
      const [binaryRows] = await connection.query(
        `SELECT institution_id AS institutionId, token FROM \`${fixture}\` ORDER BY token`,
      );
      expect(binaryRows).toEqual([
        { institutionId: null, token: "CaseToken" },
        { institutionId, token: "casetoken" },
      ]);
      await expect(
        connection.query(
          `INSERT INTO \`${fixture}\` (institution_id, user_id, token) VALUES (?, ?, ?)`,
          [institutionId, 808, "CaseToken"],
        ),
      ).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
      await expect(
        connection.query(
          `INSERT INTO \`${fixture}\` (institution_id, user_id, token) VALUES (?, ?, ?)`,
          [institutionId, 909, "TrailingSpace "],
        ),
      ).rejects.toMatchObject({ code: "ER_CHECK_CONSTRAINT_VIOLATED" });

      const [columnContract] = await connection.query(
        `
          SELECT IS_NULLABLE AS nullable, COLLATION_NAME AS collationName
          FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'institution_id'
          UNION ALL
          SELECT IS_NULLABLE AS nullable, COLLATION_NAME AS collationName
          FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'token'
          ORDER BY collationName IS NULL DESC
        `,
        [fixture, fixture],
      );
      expect(columnContract).toEqual(expect.arrayContaining([
        { nullable: "YES", collationName: null },
        { nullable: "NO", collationName: "utf8mb4_bin" },
      ]));
    } finally {
      try {
        await connection.query(`UNLOCK TABLES`);
        await connection.query(`DROP TEMPORARY TABLE IF EXISTS \`${duplicateIds}\``);
        await connection.query(`DROP TABLE IF EXISTS \`${fixture}\``);
      } finally {
        connection.release();
      }
    }
  });
});
