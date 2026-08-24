import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditTrail,
  hospitals,
  institutions,
  monthlyRosters,
  notifications,
  professionalAccess,
  professionalInstitutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  swapRequests,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import {
  enqueueComunicaRosterPublished,
  enqueueComunicaSwapApproved,
  processPendingComunicaPlusOutbox,
  resetComunicaPlusIntegrationStateForTests,
  resolveTrustedComunicaPlusBaseUrl,
} from "../server/integrations/comunica-plus";
import { getRosterPublicationEmails, publishMonth } from "../server/month-guards";
import { resolveTenantActor } from "../server/_core/policy";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const SYSTEM_USER_ID = "22222222-2222-4222-8222-222222222222";
const EXTERNAL_USER_ID = "33333333-3333-4333-8333-333333333333";
const SYSTEM_EMAIL = "escala-outbox@comunica.example";
const SYSTEM_PASSWORD = "not-a-real-secret";
const SYSTEM_PIN = "847362";
const YEAR_MONTH = "2032-03";
const NOW = new Date("2032-03-01T12:00:00.000Z");

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type StoredRow = {
  status: "PENDING" | "SENT" | "FAILED";
  providerReceipt: unknown;
  errorMessage: string | null;
};

function batchResponse(data: unknown, setCookie = false): Response {
  return new Response(
    JSON.stringify([{ result: { data: { json: data } } }]),
    {
      status: 200,
      headers: setCookie
        ? { "content-type": "application/json", "set-cookie": "session=test-session; Path=/; HttpOnly" }
        : { "content-type": "application/json" },
    },
  );
}

function stateOf(row: StoredRow): Record<string, unknown> {
  if (!row.providerReceipt || typeof row.providerReceipt !== "object") {
    throw new Error("providerReceipt ausente");
  }
  return row.providerReceipt as Record<string, unknown>;
}

describe("outbox durável Comunica+", () => {
  let db: Db;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let otherSectorId: number;
  let userId: number;
  let professionalId: number;
  let professionalAccessId: number;
  let otherUserId: number;
  let otherProfessionalId: number;
  let otherProfessionalAccessId: number;
  let shiftInstanceId: number;
  let assignmentId: number;
  let rosterId: number;
  let swapId: number;
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const recipientEmail = `comunica-outbox-${stamp}@test.local`;
  const otherRecipientEmail = `comunica-outbox-other-${stamp}@test.local`;
  const fetchMock = vi.fn<typeof fetch>();

  async function loadRow(notificationId: number): Promise<StoredRow> {
    const [row] = await db
      .select({
        status: notifications.status,
        providerReceipt: notifications.providerReceipt,
        errorMessage: notifications.errorMessage,
      })
      .from(notifications)
      .where(eq(notifications.id, notificationId))
      .limit(1);
    if (!row) throw new Error(`notification ${notificationId} ausente`);
    return row;
  }

  async function enqueue(now = NOW): Promise<number> {
    return enqueueComunicaRosterPublished({
      rosterId,
      institutionId,
      hospitalId,
      yearMonth: YEAR_MONTH,
      publishedVersion: 2,
      targetUserId: userId,
      targetEmail: recipientEmail,
      now,
    });
  }

  async function enqueueSwap(now = NOW): Promise<number> {
    return enqueueComunicaSwapApproved({
      swapId,
      swapVersion: 2,
      institutionId,
      shiftInstanceId,
      recipientRole: "FROM",
      targetUserId: userId,
      targetEmail: recipientEmail,
      now,
    });
  }

  function primeSuccessfulRemote(noticeId = "notice-outbox-1"): void {
    fetchMock
      .mockResolvedValueOnce(batchResponse({
        id: SYSTEM_USER_ID,
        organizationId: ORGANIZATION_ID,
        email: SYSTEM_EMAIL,
      }, true))
      .mockResolvedValueOnce(batchResponse({ userId: EXTERNAL_USER_ID }))
      .mockResolvedValueOnce(batchResponse({ id: noticeId }));
  }

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;

    const [institution] = await db.insert(institutions).values({
      name: `Comunica Outbox ${stamp}`,
      cnpj: `${stamp}19`.slice(-14).padStart(14, "0"),
      legalName: `Comunica Outbox ${stamp}`,
      tradeName: `CO${stamp}`.slice(0, 24),
      isActive: true,
    }).$returningId();
    institutionId = institution.id;

    const [hospital] = await db.insert(hospitals).values({
      institutionId,
      name: `Hospital Outbox ${stamp}`,
    }).$returningId();
    hospitalId = hospital.id;

    const [sector] = await db.insert(sectors).values({
      institutionId,
      hospitalId,
      name: `Setor Outbox ${stamp}`,
      category: "cirurgico",
      color: "#123456",
    }).$returningId();
    sectorId = sector.id;
    const [otherSector] = await db.insert(sectors).values({
      institutionId,
      hospitalId,
      name: `Outro Setor Outbox ${stamp}`,
      category: "servico",
      color: "#654321",
    }).$returningId();
    otherSectorId = otherSector.id;

    const [user] = await db.insert(users).values({
      name: `Recipient Outbox ${stamp}`,
      email: recipientEmail,
      passwordHash: "test",
      role: "doctor",
      approvalStatus: "APPROVED",
    }).$returningId();
    userId = user.id;
    const [professional] = await db.insert(professionals).values({
      userId,
      name: `Recipient Outbox ${stamp}`,
      role: "MEDICO",
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
    const [access] = await db.insert(professionalAccess).values({
      institutionId,
      professionalId,
      hospitalId,
      sectorId,
      canAccess: true,
    }).$returningId();
    professionalAccessId = access.id;

    const [otherUser] = await db.insert(users).values({
      name: `Other Recipient Outbox ${stamp}`,
      email: otherRecipientEmail,
      passwordHash: "test",
      role: "doctor",
      approvalStatus: "APPROVED",
    }).$returningId();
    otherUserId = otherUser.id;
    const [otherProfessional] = await db.insert(professionals).values({
      userId: otherUserId,
      name: `Other Recipient Outbox ${stamp}`,
      role: "MEDICO",
      userRole: "USER",
    }).$returningId();
    otherProfessionalId = otherProfessional.id;
    await db.insert(professionalInstitutions).values({
      institutionId,
      professionalId: otherProfessionalId,
      userId: otherUserId,
      roleInInstitution: "USER",
      active: true,
    });
    const [otherAccess] = await db.insert(professionalAccess).values({
      institutionId,
      professionalId: otherProfessionalId,
      hospitalId,
      sectorId,
      canAccess: true,
    }).$returningId();
    otherProfessionalAccessId = otherAccess.id;

    const [shift] = await db.insert(shiftInstances).values({
      institutionId,
      hospitalId,
      sectorId,
      label: `Outbox ${stamp}`,
      startAt: new Date("2032-03-12T07:00:00-03:00"),
      endAt: new Date("2032-03-12T13:00:00-03:00"),
      status: "OCUPADO",
    }).$returningId();
    shiftInstanceId = shift.id;
    const [assignment] = await db.insert(shiftAssignmentsV2).values({
      shiftInstanceId,
      institutionId,
      hospitalId,
      sectorId,
      professionalId,
      assignmentType: "ON_DUTY",
      status: "OCUPADO",
      isActive: true,
      createdBy: userId,
    }).$returningId();
    assignmentId = assignment.id;
    const [roster] = await db.insert(monthlyRosters).values({
      institutionId,
      hospitalId,
      yearMonth: YEAR_MONTH,
      status: "PUBLISHED",
      version: 2,
      publishedAt: NOW,
      publishedByUserId: userId,
    }).$returningId();
    rosterId = roster.id;
    const [swap] = await db.insert(swapRequests).values({
      type: "CESSAO",
      status: "APPROVED",
      fromProfessionalId: professionalId,
      fromUserId: userId,
      fromShiftInstanceId: shiftInstanceId,
      fromAssignmentId: assignmentId,
      toProfessionalId: otherProfessionalId,
      toUserId: otherUserId,
      reviewedByUserId: userId,
      reviewedAt: NOW,
      institutionId,
      hospitalId,
      sectorId,
      version: 2,
    }).$returningId();
    swapId = swap.id;
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    resetComunicaPlusIntegrationStateForTests();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("COMUNICA_PLUS_OUTBOUND_ENABLED", "1");
    vi.stubEnv("COMUNICA_PLUS_URL", "https://comunica.example");
    vi.stubEnv("SSO_TARGET_URL", "https://comunica.example");
    vi.stubEnv("COMUNICA_PLUS_SYSTEM_EMAIL", SYSTEM_EMAIL);
    vi.stubEnv("COMUNICA_PLUS_SYSTEM_PASSWORD", SYSTEM_PASSWORD);
    vi.stubEnv("COMUNICA_PLUS_SYSTEM_PIN", SYSTEM_PIN);
    vi.stubEnv("SSO_ORG_MAP", JSON.stringify({ [institutionId]: ORGANIZATION_ID }));

    await db.delete(notifications).where(inArray(notifications.userId, [userId, otherUserId]));
    await db.delete(auditTrail).where(eq(auditTrail.institutionId, institutionId));
    await db.update(institutions).set({ isActive: true }).where(eq(institutions.id, institutionId));
    await db.update(users).set({
      email: recipientEmail,
      role: "doctor",
      approvalStatus: "APPROVED",
      deletedAt: null,
    }).where(eq(users.id, userId));
    await db.update(professionalInstitutions).set({ active: true }).where(
      inArray(professionalInstitutions.professionalId, [professionalId, otherProfessionalId]),
    );
    await db.update(professionalAccess).set({
      canAccess: true,
      sectorId,
    }).where(eq(professionalAccess.id, professionalAccessId));
    await db.update(professionalAccess).set({
      canAccess: true,
      sectorId,
    }).where(eq(professionalAccess.id, otherProfessionalAccessId));
    await db.update(shiftAssignmentsV2).set({
      status: "OCUPADO",
      isActive: true,
    }).where(eq(shiftAssignmentsV2.id, assignmentId));
    await db.update(monthlyRosters).set({
      status: "PUBLISHED",
      version: 2,
    }).where(eq(monthlyRosters.id, rosterId));
    await db.update(swapRequests).set({
      status: "APPROVED",
      version: 2,
      fromProfessionalId: professionalId,
      fromUserId: userId,
      toProfessionalId: otherProfessionalId,
      toUserId: otherUserId,
    }).where(eq(swapRequests.id, swapId));
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await db.delete(notifications).where(inArray(notifications.userId, [userId, otherUserId]));
    await db.delete(auditTrail).where(eq(auditTrail.institutionId, institutionId));
    await db.delete(swapRequests).where(eq(swapRequests.id, swapId));
    await db.delete(monthlyRosters).where(eq(monthlyRosters.id, rosterId));
    await db.delete(shiftAssignmentsV2).where(eq(shiftAssignmentsV2.id, assignmentId));
    await db.delete(shiftInstances).where(eq(shiftInstances.id, shiftInstanceId));
    await db.delete(professionalAccess).where(
      inArray(professionalAccess.id, [professionalAccessId, otherProfessionalAccessId]),
    );
    await db.delete(professionalInstitutions).where(
      inArray(professionalInstitutions.professionalId, [professionalId, otherProfessionalId]),
    );
    await db.delete(professionals).where(
      inArray(professionals.id, [professionalId, otherProfessionalId]),
    );
    await db.delete(users).where(inArray(users.id, [userId, otherUserId]));
    await db.delete(sectors).where(inArray(sectors.id, [sectorId, otherSectorId]));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
  });

  it("aceita somente URL HTTPS da origem confiável em produção", () => {
    const base = {
      NODE_ENV: "production",
      SSO_TARGET_URL: "https://comunica.example",
    };
    expect(resolveTrustedComunicaPlusBaseUrl({
      ...base,
      COMUNICA_PLUS_URL: "https://comunica.example/api/",
    })).toBe("https://comunica.example/api");
    expect(resolveTrustedComunicaPlusBaseUrl({
      ...base,
      COMUNICA_PLUS_URL: "http://comunica.example",
    })).toBeNull();
    expect(resolveTrustedComunicaPlusBaseUrl({
      ...base,
      COMUNICA_PLUS_URL: "https://evil.example",
    })).toBeNull();
    expect(resolveTrustedComunicaPlusBaseUrl({
      ...base,
      COMUNICA_PLUS_URL: "https://user:secret@comunica.example",
    })).toBeNull();
    expect(resolveTrustedComunicaPlusBaseUrl({
      ...base,
      COMUNICA_PLUS_URL: "https://comunica.example?redirect=https://evil.example",
    })).toBeNull();
  });

  it("publicação persiste audit e intent na mesma transação sem tocar rede", async () => {
    await db.update(users).set({ role: "admin" }).where(eq(users.id, userId));
    await db.update(monthlyRosters).set({ status: "DRAFT", version: 1 }).where(
      eq(monthlyRosters.id, rosterId),
    );
    const actor = await resolveTenantActor(userId, institutionId, true);

    await publishMonth(institutionId, hospitalId, YEAR_MONTH, actor, 1);

    const [roster] = await db.select({
      status: monthlyRosters.status,
      version: monthlyRosters.version,
    }).from(monthlyRosters).where(eq(monthlyRosters.id, rosterId));
    expect(roster).toEqual({ status: "PUBLISHED", version: 2 });
    const [intent] = await db.select({
      id: notifications.id,
      providerReceipt: notifications.providerReceipt,
    }).from(notifications).where(
      eq(notifications.dedupKey, `comunica:v1:roster:${rosterId}:v2:u${userId}`),
    );
    expect(intent).toBeDefined();
    expect(stateOf({ status: "PENDING", providerReceipt: intent.providerReceipt, errorMessage: null }))
      .toMatchObject({ phase: "QUEUED", templateCode: "ROSTER_PUBLISHED" });
    const audits = await db.select({ id: auditTrail.id }).from(auditTrail).where(
      and(
        eq(auditTrail.institutionId, institutionId),
        eq(auditTrail.entityId, rosterId),
        eq(auditTrail.action, "ROSTER_PUBLISHED"),
      ),
    );
    expect(audits).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("colisão do intent reverte publicação e auditoria em vez de confirmar sem outbox", async () => {
    await db.update(users).set({ role: "admin" }).where(eq(users.id, userId));
    await db.update(monthlyRosters).set({ status: "DRAFT", version: 1 }).where(
      eq(monthlyRosters.id, rosterId),
    );
    await db.insert(notifications).values({
      institutionId,
      userId,
      title: "collision",
      body: "collision",
      type: "GENERAL",
      status: "PENDING",
      dedupKey: `comunica:v1:roster:${rosterId}:v2:u${userId}`,
      providerReceipt: {},
    });
    const actor = await resolveTenantActor(userId, institutionId, true);

    await expect(
      publishMonth(institutionId, hospitalId, YEAR_MONTH, actor, 1),
    ).rejects.toThrow("Colisão de dedupKey");

    const [roster] = await db.select({
      status: monthlyRosters.status,
      version: monthlyRosters.version,
    }).from(monthlyRosters).where(eq(monthlyRosters.id, rosterId));
    expect(roster).toEqual({ status: "DRAFT", version: 1 });
    const audits = await db.select({ id: auditTrail.id }).from(auditTrail).where(
      and(
        eq(auditTrail.institutionId, institutionId),
        eq(auditTrail.entityId, rosterId),
        eq(auditTrail.action, "ROSTER_PUBLISHED"),
      ),
    );
    expect(audits).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deduplica o intent local e conclui a notice com timeout aplicado", async () => {
    const firstId = await enqueue();
    const secondId = await enqueue();
    expect(secondId).toBe(firstId);
    const rows = await db.select({ id: notifications.id }).from(notifications).where(
      eq(notifications.dedupKey, `comunica:v1:roster:${rosterId}:v2:u${userId}`),
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(stateOf(await loadRow(firstId)))).not.toContain(recipientEmail);

    primeSuccessfulRemote();
    await expect(processPendingComunicaPlusOutbox(NOW)).resolves.toBe(1);

    const stored = await loadRow(firstId);
    expect(stored.status).toBe("SENT");
    expect(stateOf(stored)).toMatchObject({
      phase: "SENT",
      templateCode: "ROSTER_PUBLISHED",
      organizationId: ORGANIZATION_ID,
      externalUserId: EXTERNAL_USER_ID,
      evidence: { state: "NOTICE_CREATED", noticeId: "notice-outbox-1" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    const noticeRequest = fetchMock.mock.calls[2];
    expect(String(noticeRequest[0])).toContain("notices.createStructuredNotice");
    const noticeBody = JSON.parse(String(noticeRequest[1]?.body)) as Record<string, unknown>;
    expect(noticeBody).toEqual({
      "0": {
        organizationId: ORGANIZATION_ID,
        pin: SYSTEM_PIN,
        templateCode: "ROSTER_PUBLISHED",
        targetType: "USER",
        targetUserId: EXTERNAL_USER_ID,
      },
    });
  });

  it("processa SHIFT_SWAP_APPROVED somente para swap, versão e destinatário vinculados", async () => {
    const notificationId = await enqueueSwap();
    primeSuccessfulRemote("notice-swap-approved");

    await processPendingComunicaPlusOutbox(NOW);

    const stored = await loadRow(notificationId);
    expect(stored.status).toBe("SENT");
    expect(stateOf(stored)).toMatchObject({
      phase: "SENT",
      templateCode: "SHIFT_SWAP_APPROVED",
      targetUserId: userId,
      event: {
        kind: "SHIFT_SWAP_APPROVED",
        swapId,
        swapVersion: 2,
        shiftInstanceId,
        recipientRole: "FROM",
      },
      evidence: { noticeId: "notice-swap-approved" },
    });
    const noticeBody = JSON.parse(
      String(fetchMock.mock.calls[2]?.[1]?.body),
    ) as { "0": { templateCode: string; targetUserId: string } };
    expect(noticeBody["0"]).toMatchObject({
      templateCode: "SHIFT_SWAP_APPROVED",
      targetUserId: EXTERNAL_USER_ID,
    });
  });

  it.each([
    "STATUS",
    "VERSION",
    "RECIPIENT",
    "ACL",
  ] as const)("suprime swap aprovado obsoleto sem rede: %s", async (scenario) => {
    const notificationId = await enqueueSwap();
    if (scenario === "STATUS") {
      await db.update(swapRequests).set({ status: "ACCEPTED" }).where(eq(swapRequests.id, swapId));
    } else if (scenario === "VERSION") {
      await db.update(swapRequests).set({ version: 3 }).where(eq(swapRequests.id, swapId));
    } else if (scenario === "RECIPIENT") {
      await db.update(swapRequests).set({ fromUserId: otherUserId }).where(eq(swapRequests.id, swapId));
    } else {
      await db.update(professionalAccess).set({ canAccess: false }).where(
        eq(professionalAccess.id, professionalAccessId),
      );
    }

    await processPendingComunicaPlusOutbox(NOW);

    const stored = await loadRow(notificationId);
    expect(stored.status).toBe("FAILED");
    expect(stateOf(stored).phase).toBe("SUPPRESSED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sem opt-in preserva o intent e nunca exaure retry", async () => {
    const notificationId = await enqueue();
    vi.stubEnv("COMUNICA_PLUS_OUTBOUND_ENABLED", "");
    vi.stubEnv("COMUNICA_PLUS_SYSTEM_EMAIL", "must-not-be-read@example.test");
    vi.stubEnv("COMUNICA_PLUS_SYSTEM_PASSWORD", "must-not-be-read");
    vi.stubEnv("COMUNICA_PLUS_SYSTEM_PIN", "0000");

    await processPendingComunicaPlusOutbox(NOW);
    let stored = await loadRow(notificationId);
    expect(stored.status).toBe("PENDING");
    expect(stateOf(stored)).toMatchObject({
      phase: "QUEUED",
      attemptCount: 1,
      lastErrorCode: "COMUNICA_OUTBOUND_DISABLED",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    for (let attempt = 2; attempt <= 12; attempt += 1) {
      const dueAt = new Date(String(stateOf(stored).availableAt));
      await processPendingComunicaPlusOutbox(dueAt);
      stored = await loadRow(notificationId);
      expect(stored.status).toBe("PENDING");
      expect(stateOf(stored)).toMatchObject({
        phase: "QUEUED",
        attemptCount: attempt,
        lastErrorCode: "COMUNICA_OUTBOUND_DISABLED",
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retry de timeout permanece durável e depois conclui sem nova intenção", async () => {
    const notificationId = await enqueue();
    const timeout = Object.assign(new Error("simulated timeout"), { name: "TimeoutError" });
    fetchMock.mockRejectedValueOnce(timeout);

    await processPendingComunicaPlusOutbox(NOW);
    let stored = await loadRow(notificationId);
    expect(stored.status).toBe("PENDING");
    expect(stateOf(stored)).toMatchObject({
      phase: "QUEUED",
      attemptCount: 1,
      lastErrorCode: "COMUNICA_TIMEOUT",
    });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);

    primeSuccessfulRemote("notice-after-timeout");
    await processPendingComunicaPlusOutbox(new Date(String(stateOf(stored).availableAt)));
    stored = await loadRow(notificationId);
    expect(stored.status).toBe("SENT");
    expect(stateOf(stored)).toMatchObject({
      phase: "SENT",
      attemptCount: 2,
      evidence: { noticeId: "notice-after-timeout" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("lease futuro não é reconquistado enquanto a primeira entrega está em rede", async () => {
    const notificationId = await enqueue();
    let resolveLogin!: (response: Response) => void;
    const pendingLogin = new Promise<Response>((resolve) => {
      resolveLogin = resolve;
    });
    fetchMock
      .mockReturnValueOnce(pendingLogin)
      .mockResolvedValueOnce(batchResponse({ userId: EXTERNAL_USER_ID }))
      .mockResolvedValueOnce(batchResponse({ id: "notice-after-lease" }));

    const firstWorker = processPendingComunicaPlusOutbox(NOW);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const processing = stateOf(await loadRow(notificationId));
    expect(processing.phase).toBe("PROCESSING");
    expect(new Date(String(processing.leaseUntil)).getTime() - NOW.getTime()).toBe(120_000);

    await expect(
      processPendingComunicaPlusOutbox(new Date(NOW.getTime() + 90_000)),
    ).resolves.toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveLogin(batchResponse({
      id: SYSTEM_USER_ID,
      organizationId: ORGANIZATION_ID,
      email: SYSTEM_EMAIL,
    }, true));
    await firstWorker;
    expect((await loadRow(notificationId)).status).toBe("SENT");
  });

  it("lease expirado após crash é reconquistado por CAS", async () => {
    const notificationId = await enqueue();
    const queued = stateOf(await loadRow(notificationId));
    await db.update(notifications).set({
      providerReceipt: {
        ...queued,
        phase: "PROCESSING",
        revision: 2,
        attemptCount: 1,
        leaseUntil: new Date(NOW.getTime() - 1).toISOString(),
      },
    }).where(eq(notifications.id, notificationId));
    primeSuccessfulRemote("notice-after-crash");

    await processPendingComunicaPlusOutbox(NOW);
    const stored = await loadRow(notificationId);
    expect(stored.status).toBe("SENT");
    expect(stateOf(stored)).toMatchObject({
      phase: "SENT",
      attemptCount: 2,
      evidence: { noticeId: "notice-after-crash" },
    });
  });

  it("URL hostil em produção não recebe credenciais nem rede", async () => {
    const notificationId = await enqueue();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("COMUNICA_PLUS_URL", "https://evil.example");
    vi.stubEnv("SSO_TARGET_URL", "https://trusted.example");

    await processPendingComunicaPlusOutbox(NOW);
    const stored = await loadRow(notificationId);
    expect(stored.status).toBe("PENDING");
    expect(stateOf(stored)).toMatchObject({
      phase: "QUEUED",
      lastErrorCode: "UNTRUSTED_COMUNICA_URL",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sessão autenticada em outra organização nunca alcança resolução ou notice", async () => {
    const notificationId = await enqueue();
    fetchMock.mockResolvedValueOnce(batchResponse({
      id: SYSTEM_USER_ID,
      organizationId: "44444444-4444-4444-8444-444444444444",
      email: SYSTEM_EMAIL,
    }, true));

    await processPendingComunicaPlusOutbox(NOW);
    const stored = await loadRow(notificationId);
    expect(stored.status).toBe("PENDING");
    expect(stateOf(stored)).toMatchObject({
      phase: "QUEUED",
      lastErrorCode: "COMUNICA_ORGANIZATION_MISMATCH",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("auth.login");
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(recipientEmail);
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(SYSTEM_PASSWORD);
  });

  it.each([
    "PENDING_ASSIGNMENT",
    "INACTIVE_INSTITUTION",
    "REVOKED_ACCESS",
    "OTHER_SECTOR_ACCESS",
  ] as const)("suprime sem rede quando a autoridade muda: %s", async (scenario) => {
    const notificationId = await enqueue();
    if (scenario === "PENDING_ASSIGNMENT") {
      await db.update(shiftAssignmentsV2).set({ status: "PENDENTE" }).where(
        eq(shiftAssignmentsV2.id, assignmentId),
      );
    } else if (scenario === "INACTIVE_INSTITUTION") {
      await db.update(institutions).set({ isActive: false }).where(
        eq(institutions.id, institutionId),
      );
    } else if (scenario === "REVOKED_ACCESS") {
      await db.update(professionalAccess).set({ canAccess: false }).where(
        eq(professionalAccess.id, professionalAccessId),
      );
    } else {
      await db.update(professionalAccess).set({ sectorId: otherSectorId }).where(
        eq(professionalAccess.id, professionalAccessId),
      );
    }

    expect(await getRosterPublicationEmails(institutionId, hospitalId, YEAR_MONTH)).toEqual([]);
    await processPendingComunicaPlusOutbox(NOW);
    const stored = await loadRow(notificationId);
    expect(stored.status).toBe("FAILED");
    expect(stateOf(stored).phase).toBe("SUPPRESSED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

});
