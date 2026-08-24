import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { DrizzleQueryError } from "drizzle-orm/errors";
import {
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
import { getDb } from "../server/db";
import {
  enqueueTrackedPushNotification,
  processPendingPushDeliveries,
  sendTrackedPushNotification,
} from "../server/push-delivery";
import { requireValidDutyConfirmation } from "../server/confirmation-integrity";
import {
  dutyConfirmationCasIdentity,
  transitionDutyConfirmation,
} from "../server/confirmation-state";
import { unregisterPushToken } from "../server/notifications-service";
import { processShiftStartPushes } from "../server/cron/shift-confirmation-dispatcher";

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

describe("autoridade atual no outbox de confirmação", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let userId: number;
  let professionalId: number;
  let shiftId: number;
  let assignmentId: number;
  let confirmationId: number;
  const stamp = Date.now();
  const now = new Date("2032-03-04T10:00:00.000Z");
  const fetchMock = vi.fn();

  beforeAll(async () => {
    const connection = await getDb();
    if (!connection) throw new Error("Database unavailable");
    db = connection;
    const [institution] = await db.insert(institutions).values({
      name: `Authority ${stamp}`,
      cnpj: `${stamp}`.slice(-14).padStart(14, "0"),
      legalName: `Authority ${stamp}`,
      tradeName: `AUTH${stamp}`.slice(0, 20),
      isActive: true,
    }).$returningId();
    institutionId = institution.id;
    const [hospital] = await db.insert(hospitals).values({
      institutionId,
      name: `Authority hospital ${stamp}`,
    }).$returningId();
    hospitalId = hospital.id;
    const [sector] = await db.insert(sectors).values({
      institutionId,
      hospitalId,
      name: `Authority sector ${stamp}`,
      category: "cirurgico",
      color: "#2563EB",
    }).$returningId();
    sectorId = sector.id;
    const [user] = await db.insert(users).values({
      name: `Authority user ${stamp}`,
      email: `authority-${stamp}@test.local`,
      passwordHash: "test",
      role: "doctor",
    }).$returningId();
    userId = user.id;
    const [professional] = await db.insert(professionals).values({
      userId,
      name: `Authority professional ${stamp}`,
      role: "MEDICO",
      specialty: "Anestesiologia",
      userRole: "USER",
    }).$returningId();
    professionalId = professional.id;
    await db.insert(professionalInstitutions).values({
      institutionId,
      professionalId,
      userId,
      roleInInstitution: "USER",
      active: true,
    });
    await db.insert(professionalAccess).values({
      institutionId,
      hospitalId,
      sectorId,
      professionalId,
      canAccess: true,
    });
    await db.insert(monthlyRosters).values({
      institutionId,
      hospitalId,
      yearMonth: "2032-03",
      status: "PUBLISHED",
    });
    const [shift] = await db.insert(shiftInstances).values({
      institutionId,
      hospitalId,
      sectorId,
      label: `Authority shift ${stamp}`,
      startAt: new Date("2032-03-04T13:00:00.000Z"),
      endAt: new Date("2032-03-04T19:00:00.000Z"),
      status: "OCUPADO",
      specialty: "Anestesiologia",
    }).$returningId();
    shiftId = shift.id;
    const [assignment] = await db.insert(shiftAssignmentsV2).values({
      institutionId,
      hospitalId,
      sectorId,
      shiftInstanceId: shiftId,
      professionalId,
      assignmentType: "ON_DUTY",
      status: "OCUPADO",
      isActive: true,
      createdBy: userId,
    }).$returningId();
    assignmentId = assignment.id;
    const [confirmation] = await db.insert(dutyConfirmations).values({
      institutionId,
      shiftInstanceId: shiftId,
      assignmentId,
      professionalId,
      userId,
      status: "PENDING",
      confirmationToken: crypto.randomUUID(),
      recheckAt: new Date("2032-03-04T10:30:00.000Z"),
    }).$returningId();
    confirmationId = confirmation.id;
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    await db.delete(notifications).where(eq(notifications.userId, userId));
    await db.delete(pushTokens).where(eq(pushTokens.userId, userId));
    await db.insert(pushTokens).values({
      institutionId,
      userId,
      token: `ExponentPushToken[authority-${stamp}]`,
      platform: "ios",
    });
    await db.update(professionalInstitutions).set({
      active: true,
      roleInInstitution: "USER",
    }).where(
      and(
        eq(professionalInstitutions.professionalId, professionalId),
        eq(professionalInstitutions.institutionId, institutionId),
      ),
    );
    await db.update(professionalAccess).set({ canAccess: true }).where(
      eq(professionalAccess.professionalId, professionalId),
    );
    await db.update(monthlyRosters).set({ status: "PUBLISHED" }).where(
      and(
        eq(monthlyRosters.institutionId, institutionId),
        eq(monthlyRosters.hospitalId, hospitalId),
        eq(monthlyRosters.yearMonth, "2032-03"),
      ),
    );
    await db.update(users).set({
      role: "doctor",
      approvalStatus: "APPROVED",
      deletedAt: null,
    }).where(
      eq(users.id, userId),
    );
    await db.update(institutions).set({ isActive: true }).where(
      eq(institutions.id, institutionId),
    );
    await db.update(shiftInstances).set({
      label: `Authority shift ${stamp}`,
      startAt: new Date("2032-03-04T13:00:00.000Z"),
      endAt: new Date("2032-03-04T19:00:00.000Z"),
    }).where(eq(shiftInstances.id, shiftId));
    await db.update(shiftAssignmentsV2).set({
      status: "OCUPADO",
      isActive: true,
    }).where(eq(shiftAssignmentsV2.id, assignmentId));
    await db
      .update(dutyConfirmations)
      .set({
        status: "PENDING",
        notifiedAt: null,
        ssoTriggeredAt: null,
        startPushSentAt: null,
        managerNotified: false,
        recheckAt: new Date("2032-03-04T10:30:00.000Z"),
      })
      .where(eq(dutyConfirmations.id, confirmationId));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.delete(notifications).where(eq(notifications.userId, userId));
    await db.delete(pushTokens).where(eq(pushTokens.userId, userId));
    await db.delete(dutyConfirmations).where(eq(dutyConfirmations.id, confirmationId));
    await db.delete(shiftAssignmentsV2).where(eq(shiftAssignmentsV2.id, assignmentId));
    await db.delete(shiftInstances).where(eq(shiftInstances.id, shiftId));
    await db.delete(professionalAccess).where(eq(professionalAccess.professionalId, professionalId));
    await db.delete(professionalInstitutions).where(eq(professionalInstitutions.professionalId, professionalId));
    await db.delete(professionals).where(eq(professionals.id, professionalId));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(monthlyRosters).where(eq(monthlyRosters.institutionId, institutionId));
    await db.delete(sectors).where(eq(sectors.id, sectorId));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
  });

  function shiftSnapshot() {
    return {
      institutionId,
      hospitalId,
      sectorId,
      label: `Authority shift ${stamp}`,
      startAt: "2032-03-04T13:00:00.000Z",
      endAt: "2032-03-04T19:00:00.000Z",
    };
  }

  function intent(suffix: string) {
    return {
      institutionId,
      userId,
      shiftInstanceId: shiftId,
      dedupKey: `authority:${stamp}:${suffix}`,
      payload: {
        title: "Confirmação de plantão",
        body: "Confirme sua presença",
        data: { type: "duty_confirmation", confirmationId, institutionId },
      },
      authority: {
        kind: "DUTY_CONFIRMATION" as const,
        purpose: "CONFIRMATION_REQUEST" as const,
        confirmationId,
        allowedStatuses: ["PENDING" as const],
        recipientKind: "ORIGINAL" as const,
        expectedUserId: userId,
        shiftSnapshot: shiftSnapshot(),
      },
    };
  }

  function autoSsoIntent(suffix: string) {
    return {
      ...intent(suffix),
      payload: {
        title: "Plantão confirmado",
        body: "Abra o Comunica+",
        data: { type: "sso_ready", confirmationId, institutionId },
      },
      authority: {
        kind: "DUTY_CONFIRMATION" as const,
        purpose: "SSO_READY" as const,
        confirmationId,
        allowedStatuses: ["CONFIRMED" as const, "REPLACEMENT_CONFIRMED" as const],
        recipientKind: "EFFECTIVE" as const,
        expectedUserId: userId,
        shiftSnapshot: shiftSnapshot(),
      },
    };
  }

  function managerIntent(suffix: string) {
    return {
      ...intent(suffix),
      payload: {
        title: "Confirmação de plantão pendente",
        body: "Verifique a presença do profissional",
          data: {
            type: "manager_confirmation_escalation",
            confirmationId,
            institutionId,
            reason: "NO_RESPONSE",
          },
      },
      authority: {
        kind: "DUTY_CONFIRMATION" as const,
        purpose: "MANAGER_ESCALATION" as const,
        confirmationId,
        allowedStatuses: ["PENDING" as const],
        recipientKind: "MANAGER" as const,
        expectedUserId: userId,
        shiftSnapshot: shiftSnapshot(),
      },
    };
  }

  it("entrega intent B a token da conta cuja proveniência foi registrada em A", async () => {
    const [provenanceInstitution] = await db.insert(institutions).values({
      name: `Token provenance ${stamp}`,
      cnpj: `${stamp}61`.slice(-14).padStart(14, "0"),
      legalName: `Token provenance ${stamp}`,
      tradeName: `PROV${stamp}`.slice(0, 20),
      isActive: true,
    }).$returningId();
    await db.update(pushTokens).set({ institutionId: provenanceInstitution.id }).where(
      eq(pushTokens.userId, userId),
    );
    fetchMock.mockResolvedValueOnce(response(200, {
      data: { status: "ok", id: `ticket-cross-provenance-${stamp}` },
    }));

    try {
      const result = await sendTrackedPushNotification(intent("cross-provenance"), now);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ phase: "TICKET_ACCEPTED", ticketAccepted: true });
      const request = fetchMock.mock.calls[0][1] as RequestInit;
      expect(JSON.parse(String(request.body))).toMatchObject({
        to: `ExponentPushToken[authority-${stamp}]`,
        data: { institutionId },
      });
    } finally {
      await db.update(pushTokens).set({ institutionId }).where(eq(pushTokens.userId, userId));
      await db.delete(institutions).where(eq(institutions.id, provenanceInstitution.id));
    }
  });

  it("terminaliza sem rede quando a instituição destino é desativada", async () => {
    const queued = await enqueueTrackedPushNotification(intent("inactive-institution"), now);
    await db.update(institutions).set({ isActive: false }).where(
      eq(institutions.id, institutionId),
    );

    try {
      await processPendingPushDeliveries(now);

      expect(fetchMock).not.toHaveBeenCalled();
      const [stored] = await db
        .select({ status: notifications.status, providerReceipt: notifications.providerReceipt })
        .from(notifications)
        .where(eq(notifications.id, queued.notificationId));
      expect(stored.status).toBe("FAILED");
      expect(stored.providerReceipt).toMatchObject({
        phase: "FAILED",
        evidence: { reason: "RECIPIENT_AUTHORITY_REVOKED" },
      });
    } finally {
      await db.update(institutions).set({ isActive: true }).where(
        eq(institutions.id, institutionId),
      );
    }
  });

  it("cancela retry quando o estado esperado já mudou", async () => {
    const queued = await enqueueTrackedPushNotification(intent("stale-state"), now);
    await db.update(dutyConfirmations).set({ status: "CONFIRMED" }).where(
      eq(dutyConfirmations.id, confirmationId),
    );
    await processPendingPushDeliveries(now);

    expect(fetchMock).not.toHaveBeenCalled();
    const [stored] = await db.select({
      status: notifications.status,
      providerReceipt: notifications.providerReceipt,
    }).from(notifications).where(eq(notifications.id, queued.notificationId));
    expect(stored.status).toBe("FAILED");
    expect(stored.providerReceipt).toMatchObject({
      phase: "FAILED",
      evidence: { reason: "RECIPIENT_AUTHORITY_REVOKED" },
    });
  });

  it("binding persistido incoerente é rejeição canônica tipada e terminal", async () => {
    const [poisoned] = await db.insert(notifications).values({
      institutionId,
      userId,
      shiftInstanceId: shiftId,
      title: "Confirmação de plantão",
      body: "Confirme sua presença",
      status: "PENDING",
      dedupKey: `authority:${stamp}:typed-binding-mismatch`,
      providerReceipt: {
        trackingVersion: 1,
        revision: 1,
        payloadData: { type: "duty_confirmation", confirmationId },
        attemptCount: 0,
        phase: "QUEUED",
        availableAt: now.toISOString(),
        authority: {
          ...intent("typed-binding-mismatch").authority,
          expectedUserId: userId + 10_000,
        },
      },
    }).$returningId();

    await processPendingPushDeliveries(now);

    expect(fetchMock).not.toHaveBeenCalled();
    const [stored] = await db
      .select({
        status: notifications.status,
        errorMessage: notifications.errorMessage,
        providerReceipt: notifications.providerReceipt,
      })
      .from(notifications)
      .where(eq(notifications.id, poisoned.id));
    expect(stored.status).toBe("FAILED");
    expect(stored.errorMessage).toBe("Autoridade do destinatário revogada");
    expect(stored.providerReceipt).toMatchObject({
      phase: "FAILED",
      evidence: { reason: "RECIPIENT_AUTHORITY_REVOKED" },
    });
  });

  it("falha Drizzle no preflight volta SUBMITTING para QUEUED sem rede nem vazamento", async () => {
    const sentinel = "DRIZZLE_PUSH_CONFIRMATION_TOKEN_SENTINEL";
    const queued = await enqueueTrackedPushNotification(intent("preflight-infrastructure"), now);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const originalSelect = db.select.bind(db);
    let selectCalls = 0;
    const selectSpy = vi.spyOn(db as any, "select").mockImplementation((...args: any[]) => {
      selectCalls += 1;
      if (selectCalls === 2) {
        throw new DrizzleQueryError(
          "select duty_confirmations where confirmation_token = ?",
          [sentinel],
          new Error(sentinel),
        );
      }
      return (originalSelect as any)(...args);
    });

    try {
      await processPendingPushDeliveries(now);
    } finally {
      selectSpy.mockRestore();
    }

    expect(fetchMock).not.toHaveBeenCalled();
    const [stored] = await db
      .select({
        status: notifications.status,
        errorMessage: notifications.errorMessage,
        providerReceipt: notifications.providerReceipt,
      })
      .from(notifications)
      .where(eq(notifications.id, queued.notificationId));
    expect(stored.status).toBe("PENDING");
    expect(stored.providerReceipt).toMatchObject({ phase: "QUEUED", attemptCount: 1 });
    expect(stored.errorMessage).toBe("Falha temporária ao validar autoridade do destinatário");
    expect(`${JSON.stringify(stored)}\n${JSON.stringify(errorLog.mock.calls)}`).not.toContain(sentinel);
  });

  it("rejeita purpose, confirmationId, tenant ou estados incoerentes antes de persistir", async () => {
    await expect(enqueueTrackedPushNotification({
      ...intent("invalid-purpose"),
      authority: {
        ...intent("invalid-purpose").authority,
        purpose: "SSO_READY",
      },
    }, now)).rejects.toThrow("Purpose, confirmationId, tenant ou destinatario invalido");

    await expect(enqueueTrackedPushNotification({
      ...intent("invalid-confirmation-id"),
      authority: {
        ...intent("invalid-confirmation-id").authority,
        confirmationId: confirmationId + 1,
      },
    }, now)).rejects.toThrow("Purpose, confirmationId, tenant ou destinatario invalido");

    await expect(enqueueTrackedPushNotification({
      ...intent("invalid-status"),
      authority: {
        ...intent("invalid-status").authority,
        allowedStatuses: ["PENDING", "CONFIRMED"],
      },
    }, now)).rejects.toThrow("Purpose, confirmationId, tenant ou destinatario invalido");

    await expect(enqueueTrackedPushNotification({
      ...intent("invalid-payload-tenant"),
      payload: {
        ...intent("invalid-payload-tenant").payload,
        data: {
          ...intent("invalid-payload-tenant").payload.data,
          institutionId: institutionId + 1,
        },
      },
    }, now)).rejects.toThrow("Purpose, confirmationId, tenant ou destinatario invalido");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("migra authority legado sem purpose quando payload e autoridade são inequívocos", async () => {
    const [legacy] = await db.insert(notifications).values({
      institutionId,
      userId,
      shiftInstanceId: shiftId,
      title: "Confirmação de plantão",
      body: "Confirme sua presença",
      status: "PENDING",
      dedupKey: `authority:${stamp}:legacy-purpose`,
      providerReceipt: {
        trackingVersion: 1,
        revision: 1,
        payloadData: { type: "duty_confirmation", confirmationId },
        attemptCount: 0,
        phase: "QUEUED",
        availableAt: now.toISOString(),
        authority: {
          kind: "DUTY_CONFIRMATION",
          confirmationId,
          allowedStatuses: ["PENDING"],
          recipientKind: "ORIGINAL",
          expectedUserId: userId,
          shiftSnapshot: shiftSnapshot(),
        },
      },
    }).$returningId();
    fetchMock.mockResolvedValue(response(200, { data: { status: "ok", id: "legacy-ticket" } }));

    await processPendingPushDeliveries(now);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [stored] = await db.select({ providerReceipt: notifications.providerReceipt })
      .from(notifications).where(eq(notifications.id, legacy.id));
    expect(stored.providerReceipt).toMatchObject({
      phase: "TICKET_ACCEPTED",
      authority: { purpose: "CONFIRMATION_REQUEST" },
    });
  });

  it("falha fechado e retira da fila um purpose persistido adulterado", async () => {
    const [poisoned] = await db.insert(notifications).values({
      institutionId,
      userId,
      shiftInstanceId: shiftId,
      title: "Confirmação de plantão",
      body: "Confirme sua presença",
      status: "PENDING",
      dedupKey: `authority:${stamp}:poisoned-purpose`,
      providerReceipt: {
        trackingVersion: 1,
        revision: 1,
        payloadData: { type: "duty_confirmation", confirmationId },
        attemptCount: 0,
        phase: "QUEUED",
        availableAt: now.toISOString(),
        authority: {
          kind: "DUTY_CONFIRMATION",
          purpose: "SSO_READY",
          confirmationId,
          allowedStatuses: ["PENDING"],
          recipientKind: "ORIGINAL",
          expectedUserId: userId,
        },
      },
    }).$returningId();
    const [stripped] = await db.insert(notifications).values({
      institutionId,
      userId,
      shiftInstanceId: shiftId,
      title: "Confirmação de plantão",
      body: "Confirme sua presença",
      status: "PENDING",
      dedupKey: `authority:${stamp}:stripped-authority`,
      providerReceipt: {
        trackingVersion: 1,
        revision: 1,
        payloadData: { type: "duty_confirmation", confirmationId },
        attemptCount: 0,
        phase: "QUEUED",
        availableAt: now.toISOString(),
      },
    }).$returningId();

    await processPendingPushDeliveries(now);

    expect(fetchMock).not.toHaveBeenCalled();
    const [stored] = await db.select({
      status: notifications.status,
      providerReceipt: notifications.providerReceipt,
    }).from(notifications).where(eq(notifications.id, poisoned.id));
    expect(stored.status).toBe("FAILED");
    expect(stored.providerReceipt).toMatchObject({
      phase: "FAILED",
      evidence: { reason: "MALFORMED_TRACKING_STATE" },
    });
    const [strippedStored] = await db.select({ status: notifications.status })
      .from(notifications).where(eq(notifications.id, stripped.id));
    expect(strippedStored.status).toBe("FAILED");
  });

  it("seleciona e falha explicitamente row de push sem trackingVersion", async () => {
    const [malformed] = await db.insert(notifications).values({
      institutionId,
      userId,
      shiftInstanceId: shiftId,
      title: "Confirmação de plantão",
      body: "Confirme sua presença",
      status: "PENDING",
      dedupKey: `authority:${stamp}:missing-tracking-version`,
      providerReceipt: {
        revision: 1,
        payloadData: { type: "duty_confirmation", confirmationId },
        attemptCount: 0,
        phase: "QUEUED",
        availableAt: now.toISOString(),
        authority: intent("missing-tracking-version").authority,
      },
    }).$returningId();

    await expect(processPendingPushDeliveries(now)).resolves.toBeGreaterThanOrEqual(1);

    expect(fetchMock).not.toHaveBeenCalled();
    const [stored] = await db
      .select({ status: notifications.status, providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(eq(notifications.id, malformed.id));
    expect(stored.status).toBe("FAILED");
    expect(stored.providerReceipt).toMatchObject({
      phase: "FAILED",
      evidence: { reason: "MALFORMED_TRACKING_STATE" },
    });
  });

  it("seleciona e falha row de confirmação com estado totalmente esvaziado", async () => {
    const [malformed] = await db.insert(notifications).values({
      institutionId,
      userId,
      shiftInstanceId: shiftId,
      title: "Confirmação de plantão",
      body: "Confirme sua presença",
      status: "PENDING",
      dedupKey: `duty-confirmation:${confirmationId}:empty-state:${userId}`,
      providerReceipt: {},
    }).$returningId();

    await expect(processPendingPushDeliveries(now)).resolves.toBeGreaterThanOrEqual(1);

    const [stored] = await db
      .select({ status: notifications.status, providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(eq(notifications.id, malformed.id));
    expect(stored.status).toBe("FAILED");
    expect(stored.providerReceipt).toMatchObject({
      phase: "FAILED",
      evidence: { reason: "MALFORMED_TRACKING_STATE" },
    });
  });

  it("cancela retry quando vínculo institucional é revogado", async () => {
    const queued = await enqueueTrackedPushNotification(intent("revoked-pi"), now);
    await db.update(professionalInstitutions).set({ active: false }).where(
      and(
        eq(professionalInstitutions.professionalId, professionalId),
        eq(professionalInstitutions.institutionId, institutionId),
      ),
    );
    await processPendingPushDeliveries(now);

    expect(fetchMock).not.toHaveBeenCalled();
    const [stored] = await db.select({ status: notifications.status }).from(notifications)
      .where(eq(notifications.id, queued.notificationId));
    expect(stored.status).toBe("FAILED");
  });

  it("cancela retry quando professional e user perdem paridade", async () => {
    const queued = await enqueueTrackedPushNotification(intent("professional-user-mismatch"), now);
    const [otherUser] = await db
      .insert(users)
      .values({
        name: `Authority mismatch ${stamp}`,
        email: `authority-mismatch-${stamp}@test.local`,
        passwordHash: "test",
        role: "doctor",
        approvalStatus: "APPROVED",
      })
      .$returningId();
    await db
      .update(professionals)
      .set({ userId: otherUser.id })
      .where(eq(professionals.id, professionalId));

    try {
      await processPendingPushDeliveries(now);

      expect(fetchMock).not.toHaveBeenCalled();
      const [stored] = await db
        .select({ status: notifications.status, providerReceipt: notifications.providerReceipt })
        .from(notifications)
        .where(eq(notifications.id, queued.notificationId));
      expect(stored.status).toBe("FAILED");
      expect(stored.providerReceipt).toMatchObject({
        phase: "FAILED",
        evidence: { reason: "RECIPIENT_AUTHORITY_REVOKED" },
      });
    } finally {
      await db
        .update(professionals)
        .set({ userId })
        .where(eq(professionals.id, professionalId));
      await db.delete(users).where(eq(users.id, otherUser.id));
    }
  });

  it("cancela retry sem tocar na rede quando o roster não é mais oficial", async () => {
    const queued = await enqueueTrackedPushNotification(intent("draft-roster"), now);
    await db.update(monthlyRosters).set({ status: "DRAFT" }).where(
      and(
        eq(monthlyRosters.institutionId, institutionId),
        eq(monthlyRosters.hospitalId, hospitalId),
        eq(monthlyRosters.yearMonth, "2032-03"),
      ),
    );

    await processPendingPushDeliveries(now);

    expect(fetchMock).not.toHaveBeenCalled();
    const [stored] = await db
      .select({ status: notifications.status, providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(eq(notifications.id, queued.notificationId));
    expect(stored.status).toBe("FAILED");
    expect(stored.providerReceipt).toMatchObject({
      phase: "FAILED",
      evidence: { reason: "RECIPIENT_AUTHORITY_REVOKED" },
    });
  });

  it("mantém o push autorizado quando a escala oficial está LOCKED", async () => {
    await db.update(monthlyRosters).set({ status: "LOCKED" }).where(
      and(
        eq(monthlyRosters.institutionId, institutionId),
        eq(monthlyRosters.hospitalId, hospitalId),
        eq(monthlyRosters.yearMonth, "2032-03"),
      ),
    );
    const queued = await enqueueTrackedPushNotification(intent("locked-roster"), now);
    fetchMock.mockResolvedValueOnce(response(200, {
      data: { status: "ok", id: `ticket-locked-${stamp}` },
    }));

    await processPendingPushDeliveries(now);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [stored] = await db
      .select({ status: notifications.status, providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(eq(notifications.id, queued.notificationId));
    expect(stored.status).toBe("PENDING");
    expect(stored.providerReceipt).toMatchObject({ phase: "TICKET_ACCEPTED" });
  });

  it("não mantém locks de confirmação enquanto o Expo está lento", async () => {
    const queued = await enqueueTrackedPushNotification(intent("slow-expo"), now);
    let signalFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      signalFetchStarted = resolve;
    });
    let releaseFetch!: () => void;
    const fetchRelease = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    fetchMock.mockImplementationOnce(async () => {
      signalFetchStarted();
      await fetchRelease;
      return response(200, { data: { status: "ok", id: `slow-ticket-${stamp}` } });
    });

    const worker = processPendingPushDeliveries(now);
    await fetchStarted;
    const competingLock = db.transaction(async (tx) => {
      await tx
        .select({ id: dutyConfirmations.id })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.id, confirmationId))
        .limit(1)
        .for("update");
    });
    const lockCompletedBeforeFetch = await Promise.race([
      competingLock.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    releaseFetch();
    await competingLock;
    await worker;

    expect(lockCompletedBeforeFetch).toBe(true);
    const [stored] = await db
      .select({ providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(eq(notifications.id, queued.notificationId));
    expect(stored.providerReceipt).toMatchObject({ phase: "TICKET_ACCEPTED" });
  });

  it("mantém e libera o mutex de ownership do token durante submissão Expo lenta", async () => {
    const queued = await enqueueTrackedPushNotification(intent("slow-expo-token-owner"), now);
    const [ownedToken] = await db
      .select({ token: pushTokens.token })
      .from(pushTokens)
      .where(eq(pushTokens.userId, userId))
      .limit(1);
    expect(ownedToken).toBeTruthy();

    let signalFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      signalFetchStarted = resolve;
    });
    let releaseFetch!: () => void;
    const fetchRelease = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    fetchMock.mockImplementationOnce(async () => {
      signalFetchStarted();
      await fetchRelease;
      return response(200, { data: { status: "ok", id: `owner-ticket-${stamp}` } });
    });

    const worker = processPendingPushDeliveries(now);
    await fetchStarted;
    let logoutSettled = false;
    const logout = unregisterPushToken(userId, ownedToken.token, 1).then((result) => {
      logoutSettled = true;
      return result;
    });

    // Supera deliberadamente o timeout antigo de 5 s. Logout/registro precisam
    // aguardar o deadline máximo da rede, sem linearizar no meio do envio.
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    expect(logoutSettled).toBe(false);
    const duringSend = await db
      .select({ userId: pushTokens.userId })
      .from(pushTokens)
      .where(eq(pushTokens.token, ownedToken.token));
    expect(duringSend).toEqual([{ userId }]);

    releaseFetch();
    await expect(worker).resolves.toBeGreaterThan(0);
    await expect(logout).resolves.toEqual({ success: true });
    await expect(
      db.select({ id: pushTokens.id }).from(pushTokens).where(eq(pushTokens.token, ownedToken.token)),
    ).resolves.toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const lockName = `escala-push-token:${createHash("sha256")
      .update(ownedToken.token)
      .digest("hex")
      .slice(0, 40)}`;
    const probe = await db.execute(sql`SELECT IS_FREE_LOCK(${lockName}) AS isFree`);
    const [probeRows] = probe as unknown as [{ isFree: number | string | null }[]];
    expect(Number(probeRows[0]?.isFree)).toBe(1);

    const [stored] = await db
      .select({ providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(eq(notifications.id, queued.notificationId));
    expect(stored.providerReceipt).toMatchObject({ phase: "TICKET_ACCEPTED" });
  }, 20_000);

  it("retry que obtém ticket recupera notifiedAt da confirmação", async () => {
    await db
      .update(dutyConfirmations)
      .set({ notifiedAt: null })
      .where(eq(dutyConfirmations.id, confirmationId));
    const queued = await enqueueTrackedPushNotification(intent("notified-at-recovery"), now);
    fetchMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(
        response(200, { data: { status: "ok", id: `notified-ticket-${stamp}` } }),
      );

    await processPendingPushDeliveries(now);
    const [beforeRetry] = await db
      .select({ notifiedAt: dutyConfirmations.notifiedAt })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, confirmationId));
    expect(beforeRetry.notifiedAt).toBeNull();

    await processPendingPushDeliveries(new Date(now.getTime() + 60_000));

    const [afterRetry] = await db
      .select({ notifiedAt: dutyConfirmations.notifiedAt })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, confirmationId));
    expect(afterRetry.notifiedAt).not.toBeNull();
    const [stored] = await db
      .select({ providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(eq(notifications.id, queued.notificationId));
    expect(stored.providerReceipt).toMatchObject({ phase: "TICKET_ACCEPTED" });
  });

  it("cancela retry quando o acesso canônico ao hospital/setor é revogado", async () => {
    const queued = await enqueueTrackedPushNotification(intent("revoked-acl"), now);
    await db.update(professionalAccess).set({ canAccess: false }).where(
      eq(professionalAccess.professionalId, professionalId),
    );
    await processPendingPushDeliveries(now);

    expect(fetchMock).not.toHaveBeenCalled();
    const [stored] = await db.select({ status: notifications.status }).from(notifications)
      .where(eq(notifications.id, queued.notificationId));
    expect(stored.status).toBe("FAILED");
  });

  it.each([
    ["PENDING", null],
    ["APPROVED", new Date("2032-03-04T10:00:00.000Z")],
  ] as const)(
    "cancela retry quando a conta deixa de ser destinatária ativa (%s, deleted=%s)",
    async (approvalStatus, deletedAt) => {
      const queued = await enqueueTrackedPushNotification(
        intent(`revoked-user-${approvalStatus}-${deletedAt ? "deleted" : "active"}`),
        now,
      );
      await db.update(users).set({ approvalStatus, deletedAt }).where(eq(users.id, userId));

      await processPendingPushDeliveries(now);

      expect(fetchMock).not.toHaveBeenCalled();
      const [stored] = await db
        .select({ status: notifications.status, providerReceipt: notifications.providerReceipt })
        .from(notifications)
        .where(eq(notifications.id, queued.notificationId));
      expect(stored.status).toBe("FAILED");
      expect(stored.providerReceipt).toMatchObject({
        phase: "FAILED",
        evidence: { reason: "RECIPIENT_AUTHORITY_REVOKED" },
      });
    },
  );

  it("cancela stale intent quando label ou horários do plantão mudam", async () => {
    const queued = await enqueueTrackedPushNotification(intent("stale-shift-snapshot"), now);
    await db
      .update(shiftInstances)
      .set({ label: `Authority shift altered ${stamp}` })
      .where(eq(shiftInstances.id, shiftId));

    await processPendingPushDeliveries(now);

    expect(fetchMock).not.toHaveBeenCalled();
    const [stored] = await db
      .select({ status: notifications.status, providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(eq(notifications.id, queued.notificationId));
    expect(stored.status).toBe("FAILED");
    expect(stored.providerReceipt).toMatchObject({
      phase: "FAILED",
      evidence: { reason: "RECIPIENT_AUTHORITY_REVOKED" },
    });
  });

  it("usa os campos vivos do shift após snapshot RR anterior ao lock", async () => {
    let signalSnapshot!: () => void;
    const snapshotEstablished = new Promise<void>((resolve) => {
      signalSnapshot = resolve;
    });
    let releaseValidation!: () => void;
    const validationReleased = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const changedLabel = `Authority shift current-read ${stamp}`;
    const validation = db.transaction(async (tx) => {
      await tx
        .select({ id: dutyConfirmations.id })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.id, confirmationId))
        .limit(1);
      signalSnapshot();
      await validationReleased;
      return requireValidDutyConfirmation(tx, confirmationId, {
        allowedStatuses: ["PENDING"],
        lockForUpdate: true,
      });
    }, { isolationLevel: "repeatable read" });

    await snapshotEstablished;
    await db
      .update(shiftInstances)
      .set({ label: changedLabel })
      .where(eq(shiftInstances.id, shiftId));
    releaseValidation();

    await expect(validation).resolves.toMatchObject({
      shift: { label: changedLabel },
    });
  });

  it("rejeita assignment inativada após snapshot RR anterior ao lock", async () => {
    let signalSnapshot!: () => void;
    const snapshotEstablished = new Promise<void>((resolve) => {
      signalSnapshot = resolve;
    });
    let releaseValidation!: () => void;
    const validationReleased = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const validation = db.transaction(async (tx) => {
      await tx
        .select({ id: dutyConfirmations.id })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.id, confirmationId))
        .limit(1);
      signalSnapshot();
      await validationReleased;
      return requireValidDutyConfirmation(tx, confirmationId, {
        allowedStatuses: ["PENDING"],
        lockForUpdate: true,
      });
    }, { isolationLevel: "repeatable read" });

    await snapshotEstablished;
    await db
      .update(shiftAssignmentsV2)
      .set({ isActive: false })
      .where(eq(shiftAssignmentsV2.id, assignmentId));
    releaseValidation();

    await expect(validation).rejects.toThrow("alocação mudou");
  });

  it("manager handoff sobrevive sem token e só fecha após receipt aceito", async () => {
    await db
      .update(professionalInstitutions)
      .set({ roleInInstitution: "GESTOR_PLUS" })
      .where(eq(professionalInstitutions.professionalId, professionalId));
    await db.delete(pushTokens).where(eq(pushTokens.userId, userId));
    const tracked = await enqueueTrackedPushNotification(managerIntent("durable-handoff"), now);

    let dueAt = now;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await processPendingPushDeliveries(dueAt);
      const [pending] = await db
        .select({ status: notifications.status, providerReceipt: notifications.providerReceipt })
        .from(notifications)
        .where(eq(notifications.id, tracked.notificationId));
      const state = pending.providerReceipt as { phase: string; attemptCount: number; availableAt: string };
      expect(pending.status).toBe("PENDING");
      expect(state).toMatchObject({ phase: "QUEUED", attemptCount: attempt });
      dueAt = new Date(state.availableAt);
    }
    const [stillOpen] = await db
      .select({ managerNotified: dutyConfirmations.managerNotified, recheckAt: dutyConfirmations.recheckAt })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, confirmationId));
    expect(stillOpen.managerNotified).toBe(false);
    expect(stillOpen.recheckAt).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    await db.insert(pushTokens).values({
      institutionId,
      userId,
      token: `ExponentPushToken[authority-manager-${stamp}]`,
      platform: "ios",
    });
    fetchMock.mockResolvedValueOnce(
      response(200, { data: { status: "ok", id: `manager-ticket-${stamp}` } }),
    );
    await processPendingPushDeliveries(dueAt);

    const [afterTicket] = await db
      .select({ managerNotified: dutyConfirmations.managerNotified, recheckAt: dutyConfirmations.recheckAt })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, confirmationId));
    expect(afterTicket.managerNotified).toBe(false);
    expect(afterTicket.recheckAt).not.toBeNull();

    fetchMock.mockResolvedValueOnce(
      response(200, { data: { [`manager-ticket-${stamp}`]: { status: "ok" } } }),
    );
    await processPendingPushDeliveries(new Date(dueAt.getTime() + 15 * 60_000));

    const [closed] = await db
      .select({ managerNotified: dutyConfirmations.managerNotified, recheckAt: dutyConfirmations.recheckAt })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, confirmationId));
    expect(closed.managerNotified).toBe(true);
    expect(closed.recheckAt).toBeNull();
    const [sent] = await db
      .select({ status: notifications.status, providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(eq(notifications.id, tracked.notificationId));
    expect(sent.status).toBe("SENT");
    expect(sent.providerReceipt).toMatchObject({ phase: "PROVIDER_ACCEPTED" });
  });

  it("receipt PENDING antigo não consome o novo prazo após transição para DECLINED", async () => {
    await db
      .update(professionalInstitutions)
      .set({ roleInInstitution: "GESTOR_PLUS" })
      .where(eq(professionalInstitutions.professionalId, professionalId));
    const ticketId = `manager-stale-pending-${stamp}`;
    fetchMock.mockResolvedValueOnce(
      response(200, { data: { status: "ok", id: ticketId } }),
    );
    const tracked = await enqueueTrackedPushNotification(
      managerIntent("stale-pending-receipt"),
      now,
    );
    await processPendingPushDeliveries(now);

    const [current] = await db
      .select()
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, confirmationId));
    const renewedRecheckAt = new Date("2032-03-04T11:30:00.000Z");
    await db
      .update(dutyConfirmations)
      .set({ managerNotified: true })
      .where(eq(dutyConfirmations.id, confirmationId));
    await db.transaction((tx) =>
      transitionDutyConfirmation(tx, {
        kind: "DECLINE",
        ...dutyConfirmationCasIdentity(current),
        expectedStatus: "PENDING",
        respondedAt: new Date("2032-03-04T10:45:00.000Z"),
        declineReason: "Indisponível",
        recheckAt: renewedRecheckAt,
      }),
    );

    fetchMock.mockResolvedValueOnce(
      response(200, { data: { [ticketId]: { status: "ok" } } }),
    );
    await processPendingPushDeliveries(new Date(now.getTime() + 15 * 60_000));

    const [stored] = await db
      .select({ status: notifications.status, providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(eq(notifications.id, tracked.notificationId));
    expect(stored.status).toBe("SENT");
    expect(stored.providerReceipt).toMatchObject({ phase: "PROVIDER_ACCEPTED" });
    const [after] = await db
      .select({
        status: dutyConfirmations.status,
        managerNotified: dutyConfirmations.managerNotified,
        recheckAt: dutyConfirmations.recheckAt,
      })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, confirmationId));
    expect(after.status).toBe("DECLINED");
    expect(after.managerNotified).toBe(false);
    expect(after.recheckAt?.toISOString()).toBe(renewedRecheckAt.toISOString());
  });

  it("admin global com PI USER ativa é destinatário gerencial canônico", async () => {
    await db.update(users).set({ role: "admin" }).where(eq(users.id, userId));
    fetchMock.mockResolvedValueOnce(
      response(200, { data: { status: "ok", id: `admin-ticket-${stamp}` } }),
    );
    const tracked = await enqueueTrackedPushNotification(managerIntent("global-admin"), now);

    await processPendingPushDeliveries(now);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [stored] = await db
      .select({ status: notifications.status, providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(eq(notifications.id, tracked.notificationId));
    expect(stored.status).toBe("PENDING");
    expect(stored.providerReceipt).toMatchObject({
      phase: "TICKET_ACCEPTED",
      authority: { recipientKind: "MANAGER", expectedUserId: userId },
    });
  });

  it("manager receipt terminal volta à fila em vez de apagar o handoff", async () => {
    await db
      .update(professionalInstitutions)
      .set({ roleInInstitution: "GESTOR_PLUS" })
      .where(eq(professionalInstitutions.professionalId, professionalId));
    fetchMock.mockResolvedValueOnce(
      response(200, { data: { status: "ok", id: `manager-rejected-${stamp}` } }),
    );
    const tracked = await enqueueTrackedPushNotification(managerIntent("terminal-receipt"), now);
    await processPendingPushDeliveries(now);
    fetchMock.mockResolvedValueOnce(response(200, {
      data: {
        [`manager-rejected-${stamp}`]: {
          status: "error",
          message: "device rejected",
          details: { error: "MessageTooBig" },
        },
      },
    }));

    await processPendingPushDeliveries(new Date(now.getTime() + 15 * 60_000));

    const [stored] = await db
      .select({ status: notifications.status, providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(eq(notifications.id, tracked.notificationId));
    expect(stored.status).toBe("PENDING");
    expect(stored.providerReceipt).toMatchObject({ phase: "QUEUED" });
    const [confirmation] = await db
      .select({ managerNotified: dutyConfirmations.managerNotified, recheckAt: dutyConfirmations.recheckAt })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, confirmationId));
    expect(confirmation.managerNotified).toBe(false);
    expect(confirmation.recheckAt).not.toBeNull();
  });

  it("retry de auto-SSO revalida CONFIRMED imediatamente antes da rede", async () => {
    await db.update(dutyConfirmations).set({ status: "CONFIRMED" }).where(
      eq(dutyConfirmations.id, confirmationId),
    );
    const queued = await enqueueTrackedPushNotification(autoSsoIntent("sso-stale"), now);
    await db.update(dutyConfirmations).set({ status: "DECLINED" }).where(
      eq(dutyConfirmations.id, confirmationId),
    );
    await processPendingPushDeliveries(now);

    expect(fetchMock).not.toHaveBeenCalled();
    const [stored] = await db.select({ status: notifications.status }).from(notifications)
      .where(eq(notifications.id, queued.notificationId));
    expect(stored.status).toBe("FAILED");
  });

  it("retry de auto-SSO revalida o vínculo do plantonista efetivo", async () => {
    await db.update(dutyConfirmations).set({ status: "CONFIRMED" }).where(
      eq(dutyConfirmations.id, confirmationId),
    );
    const queued = await enqueueTrackedPushNotification(autoSsoIntent("sso-revoked"), now);
    await db.update(professionalInstitutions).set({ active: false }).where(
      and(
        eq(professionalInstitutions.professionalId, professionalId),
        eq(professionalInstitutions.institutionId, institutionId),
      ),
    );
    await processPendingPushDeliveries(now);

    expect(fetchMock).not.toHaveBeenCalled();
    const [stored] = await db.select({ status: notifications.status }).from(notifications)
      .where(eq(notifications.id, queued.notificationId));
    expect(stored.status).toBe("FAILED");
  });

  it("retry aceito do auto-SSO recupera a evidência ssoTriggeredAt", async () => {
    await db.update(dutyConfirmations).set({ status: "CONFIRMED" }).where(
      eq(dutyConfirmations.id, confirmationId),
    );
    await enqueueTrackedPushNotification(autoSsoIntent("sso-recovery"), now);
    fetchMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(response(200, { data: { status: "ok", id: "sso-retry-ticket" } }));

    await processPendingPushDeliveries(now);
    const [beforeRetry] = await db.select({ ssoTriggeredAt: dutyConfirmations.ssoTriggeredAt })
      .from(dutyConfirmations).where(eq(dutyConfirmations.id, confirmationId));
    expect(beforeRetry.ssoTriggeredAt).toBeNull();

    await processPendingPushDeliveries(new Date(now.getTime() + 60_000));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [afterRetry] = await db.select({ ssoTriggeredAt: dutyConfirmations.ssoTriggeredAt })
      .from(dutyConfirmations).where(eq(dutyConfirmations.id, confirmationId));
    expect(afterRetry.ssoTriggeredAt).not.toBeNull();
  });

  it("retry aceito do início do plantão recupera startPushSentAt", async () => {
    await db.update(dutyConfirmations).set({ status: "CONFIRMED" }).where(
      eq(dutyConfirmations.id, confirmationId),
    );
    await enqueueTrackedPushNotification({
      ...autoSsoIntent("shift-start-recovery"),
      dedupKey: `duty-confirmation:${confirmationId}:shift-start:${userId}`,
      payload: {
        title: "Seu plantão começou",
        body: "Abra o Comunica+",
        data: {
          type: "sso_ready",
          confirmationId,
          institutionId,
          shiftInstanceId: shiftId,
        },
      },
    }, now);
    fetchMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(response(200, { data: { status: "ok", id: "start-retry-ticket" } }));

    await processPendingPushDeliveries(now);
    const [beforeRetry] = await db
      .select({ startPushSentAt: dutyConfirmations.startPushSentAt })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, confirmationId));
    expect(beforeRetry.startPushSentAt).toBeNull();

    await processPendingPushDeliveries(new Date(now.getTime() + 60_000));

    const [afterRetry] = await db
      .select({ startPushSentAt: dutyConfirmations.startPushSentAt })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, confirmationId));
    expect(afterRetry.startPushSentAt).not.toBeNull();
  });

  it("duas chamadas concorrentes deduplicam início de plantão sem pré-claim", async () => {
    const startedAt = new Date("2032-03-04T13:02:00.000Z");
    await db
      .update(dutyConfirmations)
      .set({ status: "CONFIRMED", startPushSentAt: null })
      .where(eq(dutyConfirmations.id, confirmationId));
    vi.stubEnv("SSO_TARGET_URL", "https://comunica.example");
    let signalFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      signalFetchStarted = resolve;
    });
    let releaseFetch!: () => void;
    const fetchReleased = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    fetchMock.mockImplementationOnce(async () => {
      signalFetchStarted();
      await fetchReleased;
      return response(200, { data: { status: "ok", id: `start-concurrent-${stamp}` } });
    });

    const first = processShiftStartPushes(startedAt);
    await fetchStarted;
    const second = processShiftStartPushes(startedAt);
    try {
      await second;
      const inFlightRows = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(
          notifications.dedupKey,
          `duty-confirmation:${confirmationId}:shift-start:${userId}`,
        ));
      const [duringFetch] = await db
        .select({ startPushSentAt: dutyConfirmations.startPushSentAt })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.id, confirmationId));
      expect(inFlightRows).toHaveLength(1);
      expect(duringFetch.startPushSentAt).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      releaseFetch();
      await first;
      const [after] = await db
        .select({ startPushSentAt: dutyConfirmations.startPushSentAt })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.id, confirmationId));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(after.startPushSentAt).not.toBeNull();
    } finally {
      releaseFetch();
      await Promise.allSettled([first, second]);
      vi.unstubAllEnvs();
      await db
        .update(dutyConfirmations)
        .set({ status: "PENDING", startPushSentAt: null })
        .where(eq(dutyConfirmations.id, confirmationId));
    }
  });

  it("renova lease antes de cada token e impede worker concorrente de roubar o claim", async () => {
    const secondToken = `ExponentPushToken[authority-second-${stamp}]`;
    await db.insert(pushTokens).values({
      institutionId,
      userId,
      token: secondToken,
      platform: "android",
    });
    const operationNow = new Date();
    let signalFirstRenew!: () => void;
    const firstRenewReached = new Promise<void>((resolve) => {
      signalFirstRenew = resolve;
    });
    let releaseFirstRenew!: () => void;
    const firstRenewReleased = new Promise<void>((resolve) => {
      releaseFirstRenew = resolve;
    });
    let signalStaleClaim!: () => void;
    const staleClaimReached = new Promise<void>((resolve) => {
      signalStaleClaim = resolve;
    });
    let releaseStaleClaim!: () => void;
    const staleClaimReleased = new Promise<void>((resolve) => {
      releaseStaleClaim = resolve;
    });
    let signalFirstFetch!: () => void;
    const firstFetchStarted = new Promise<void>((resolve) => {
      signalFirstFetch = resolve;
    });
    let releaseFirstFetch!: () => void;
    const firstFetchReleased = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    let callIndex = 0;
    fetchMock.mockImplementation(async () => {
      const current = callIndex++;
      if (current === 0) {
        signalFirstFetch();
        await firstFetchReleased;
      }
      return response(200, {
        data: { status: "ok", id: `lease-ticket-${stamp}-${current}` },
      });
    });

    const firstWorker = sendTrackedPushNotification(
      intent("submission-lease-renewal"),
      operationNow,
      {
        submissionLeaseMs: 5,
        beforeSubmissionLeaseRenew: async ({ sourceRevision }) => {
          if (sourceRevision !== 2) return;
          signalFirstRenew();
          await firstRenewReleased;
        },
      },
    );
    await firstRenewReached;

    const [tracked] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(
        notifications.dedupKey,
        `authority:${stamp}:submission-lease-renewal`,
      ));
    const secondWorkerPromise = processPendingPushDeliveries(
      new Date(operationNow.getTime() + 10),
      {
        submissionLeaseMs: 5,
        beforeSubmissionClaim: async ({ notificationId, sourceRevision }) => {
          if (notificationId !== tracked.id || sourceRevision !== 2) return;
          signalStaleClaim();
          await staleClaimReleased;
        },
      },
    );
    await staleClaimReached;

    // B já leu revision=2 expirada. A renova para revision=3 antes de B
    // executar seu CAS; a leitura stale não pode mais roubar o claim.
    releaseFirstRenew();
    await firstFetchStarted;

    try {
      const [duringFirstFetch] = await db
        .select({ providerReceipt: notifications.providerReceipt })
        .from(notifications)
        .where(eq(
          notifications.dedupKey,
          `authority:${stamp}:submission-lease-renewal`,
        ));
      expect(duringFirstFetch.providerReceipt).toMatchObject({
        phase: "SUBMITTING",
        revision: 3,
        attemptCount: 1,
      });

      releaseStaleClaim();
      await secondWorkerPromise;
      const [afterStaleCas] = await db
        .select({ providerReceipt: notifications.providerReceipt })
        .from(notifications)
        .where(eq(notifications.id, tracked.id));
      expect(afterStaleCas.providerReceipt).toMatchObject({
        phase: "SUBMITTING",
        revision: 3,
        attemptCount: 1,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      releaseFirstFetch();
      const result = await firstWorker;
      expect(result.phase).toBe("TICKET_ACCEPTED");

      const submittedTokens = fetchMock.mock.calls.map((call) => {
        const body = JSON.parse(String((call[1] as RequestInit).body)) as { to: string };
        return body.to;
      });
      expect(submittedTokens).toHaveLength(2);
      expect(new Set(submittedTokens).size).toBe(2);

      const [stored] = await db
        .select({ providerReceipt: notifications.providerReceipt })
        .from(notifications)
        .where(eq(
          notifications.dedupKey,
          `authority:${stamp}:submission-lease-renewal`,
        ));
      expect(stored.providerReceipt).toMatchObject({
        phase: "TICKET_ACCEPTED",
        // initial=1, claim=2, renovações=3/4, conclusão=5.
        revision: 5,
        attemptCount: 1,
        tickets: expect.arrayContaining([
          expect.objectContaining({ pushTokenId: expect.any(Number) }),
          expect.objectContaining({ pushTokenId: expect.any(Number) }),
        ]),
      });
    } finally {
      releaseFirstRenew();
      releaseStaleClaim();
      releaseFirstFetch();
      await Promise.allSettled([firstWorker, secondWorkerPromise]);
      await db.delete(pushTokens).where(eq(pushTokens.token, secondToken));
    }
  });

  it("rows futuras não bloqueiam uma intenção devida após o limite do lote", async () => {
    const future = new Date(now.getTime() + 60 * 60_000).toISOString();
    await db.insert(notifications).values(
      Array.from({ length: 100 }, (_, index) => ({
        institutionId,
        userId,
        title: "future",
        body: "future",
        status: "PENDING" as const,
        dedupKey: `authority:${stamp}:future:${index}`,
        providerReceipt: {
          trackingVersion: 1,
          revision: 1,
          payloadData: {},
          attemptCount: 0,
          phase: "QUEUED",
          availableAt: future,
        },
      })),
    );
    const due = await enqueueTrackedPushNotification({
      ...intent("due-after-100"),
      payload: {
        title: "generic due",
        body: "generic due",
        data: { type: "generic_due" },
      },
      authority: undefined,
    }, now);
    fetchMock.mockResolvedValue(response(200, { data: { status: "ok", id: "due-ticket" } }));

    await processPendingPushDeliveries(now);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [stored] = await db.select({ providerReceipt: notifications.providerReceipt })
      .from(notifications).where(eq(notifications.id, due.notificationId));
    expect(stored.providerReceipt).toMatchObject({ phase: "TICKET_ACCEPTED" });
    await db.delete(notifications).where(
      inArray(
        notifications.dedupKey,
        Array.from({ length: 100 }, (_, index) => `authority:${stamp}:future:${index}`),
      ),
    );
  });
});
