import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  hospitals,
  institutions,
  monthlyRosters,
  notifications,
  professionalAccess,
  professionalInstitutions,
  professionals,
  pushTokens,
  scheduleContexts,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { drainAccountWideNativeBadgeSnapshotDispatches } from "../server/notifications-service";
import {
  enqueueTrackedPushNotification,
  processPendingPushDeliveries,
} from "../server/push-delivery";
import { enqueueVacancyAvailableSignals } from "../server/vacancy-broadcast-signal";
import { openTestScale } from "./helpers/open-test-scale";

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

describe("autoridade atual no broadcast de vaga", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionId: number;
  let hospitalAId: number;
  let hospitalBId: number;
  let sectorAId: number;
  let sectorBId: number;
  let scheduleContextId: number;
  let userId: number;
  let professionalId: number;
  let accessAId: number;
  let accessBId: number;
  let shiftId: number;
  let pushTokenId: number;
  const stamp = Date.now();
  const fetchMock = vi.fn();
  let errorLog: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    const connection = await getDb();
    if (!connection) throw new Error("Database unavailable");
    db = connection;

    const [institution] = await db
      .insert(institutions)
      .values({
        name: `Vacancy authority ${stamp}`,
        cnpj: `${stamp}`.slice(-14).padStart(14, "4"),
        legalName: `Vacancy authority ${stamp}`,
        tradeName: `VPA${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = institution.id;

    const [hospitalA] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Hospital A ${stamp}` })
      .$returningId();
    hospitalAId = hospitalA.id;
    const [hospitalB] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Hospital B ${stamp}` })
      .$returningId();
    hospitalBId = hospitalB.id;

    const [sectorA] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId: hospitalAId,
        name: `Setor A ${stamp}`,
        category: "cirurgico",
        color: "#2563EB",
      })
      .$returningId();
    sectorAId = sectorA.id;
    const [sectorB] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId: hospitalBId,
        name: `Setor B ${stamp}`,
        category: "servico",
        color: "#16A34A",
      })
      .$returningId();
    sectorBId = sectorB.id;

    scheduleContextId = await openTestScale(db, {
      institutionId,
      hospitalId: hospitalAId,
      sectorId: sectorAId,
    });

    const [user] = await db
      .insert(users)
      .values({
        name: `Vacancy authority user ${stamp}`,
        email: `vacancy-push-authority-${stamp}@test.local`,
        passwordHash: "test",
        role: "doctor",
        approvalStatus: "APPROVED",
      })
      .$returningId();
    userId = user.id;
    const [professional] = await db
      .insert(professionals)
      .values({
        userId,
        name: `Vacancy authority professional ${stamp}`,
        role: "MEDICO",
        specialty: "Anestesiologia",
        userRole: "USER",
      })
      .$returningId();
    professionalId = professional.id;
    await db.insert(professionalInstitutions).values({
      institutionId,
      professionalId,
      userId,
      roleInInstitution: "USER",
      active: true,
    });

    const [accessA] = await db
      .insert(professionalAccess)
      .values({
        institutionId,
        professionalId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        canAccess: true,
      })
      .$returningId();
    accessAId = accessA.id;
    const [accessB] = await db
      .insert(professionalAccess)
      .values({
        institutionId,
        professionalId,
        hospitalId: hospitalBId,
        sectorId: sectorBId,
        canAccess: false,
      })
      .$returningId();
    accessBId = accessB.id;

    await db.insert(monthlyRosters).values({
      institutionId,
      hospitalId: hospitalAId,
      yearMonth: "2032-09",
      status: "PUBLISHED",
    });
    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        scheduleContextId,
        label: `Vacancy authority shift ${stamp}`,
        startAt: new Date("2032-09-12T10:00:00.000Z"),
        endAt: new Date("2032-09-12T16:00:00.000Z"),
        status: "VAGO",
      })
      .$returningId();
    shiftId = shift.id;
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () =>
      response(200, {
        data: { status: "ok", id: `vacancy-ticket-${crypto.randomUUID()}` },
      }),
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await db.delete(notifications).where(eq(notifications.userId, userId));
    await db.delete(pushTokens).where(eq(pushTokens.userId, userId));
    await db
      .delete(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.shiftInstanceId, shiftId));
    const [pushToken] = await db
      .insert(pushTokens)
      .values({
        institutionId,
        userId,
        token: `ExponentPushToken[vacancy-authority-${stamp}]`,
        platform: "ios",
      })
      .$returningId();
    pushTokenId = pushToken.id;
    await db
      .update(users)
      .set({ approvalStatus: "APPROVED", deletedAt: null })
      .where(eq(users.id, userId));
    await db
      .update(professionalInstitutions)
      .set({ active: true })
      .where(
        and(
          eq(professionalInstitutions.professionalId, professionalId),
          eq(professionalInstitutions.institutionId, institutionId),
        ),
      );
    await db
      .update(professionalAccess)
      .set({ canAccess: true })
      .where(eq(professionalAccess.id, accessAId));
    await db
      .update(professionalAccess)
      .set({ canAccess: false })
      .where(eq(professionalAccess.id, accessBId));
    await db
      .update(monthlyRosters)
      .set({ status: "PUBLISHED" })
      .where(
        and(
          eq(monthlyRosters.institutionId, institutionId),
          eq(monthlyRosters.hospitalId, hospitalAId),
          eq(monthlyRosters.yearMonth, "2032-09"),
        ),
      );
    await db
      .update(shiftInstances)
      .set({ status: "VAGO" })
      .where(eq(shiftInstances.id, shiftId));
    await db
      .update(hospitals)
      .set({ name: `Hospital A ${stamp}` })
      .where(eq(hospitals.id, hospitalAId));
    await db
      .update(sectors)
      .set({ name: `Setor A ${stamp}` })
      .where(eq(sectors.id, sectorAId));
  });

  afterEach(async () => {
    await drainAccountWideNativeBadgeSnapshotDispatches();
    expect(
      errorLog.mock.calls.some(
        (call) =>
          typeof call[0] === "string" &&
          call[0].startsWith("[PushDelivery] ROW_PROCESSING_FAILED"),
      ),
    ).toBe(false);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.delete(notifications).where(eq(notifications.userId, userId));
    await db.delete(pushTokens).where(eq(pushTokens.userId, userId));
    await db
      .delete(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.shiftInstanceId, shiftId));
    await db.delete(shiftInstances).where(eq(shiftInstances.id, shiftId));
    await db
      .delete(monthlyRosters)
      .where(
        and(
          eq(monthlyRosters.institutionId, institutionId),
          eq(monthlyRosters.hospitalId, hospitalAId),
        ),
      );
    await db
      .delete(professionalAccess)
      .where(eq(professionalAccess.professionalId, professionalId));
    await db
      .delete(professionalInstitutions)
      .where(eq(professionalInstitutions.professionalId, professionalId));
    await db.delete(professionals).where(eq(professionals.id, professionalId));
    await db.delete(users).where(eq(users.id, userId));
    await db
      .delete(scheduleContexts)
      .where(eq(scheduleContexts.id, scheduleContextId));
    await db.delete(sectors).where(eq(sectors.id, sectorBId));
    await db.delete(sectors).where(eq(sectors.id, sectorAId));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalBId));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalAId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
  });

  function shiftInput() {
    return {
      id: shiftId,
      institutionId,
      hospitalId: hospitalAId,
      sectorId: sectorAId,
      startAt: new Date("2032-09-12T10:00:00.000Z"),
      endAt: new Date("2032-09-12T16:00:00.000Z"),
      label: `Vacancy authority shift ${stamp}`,
    };
  }

  function legacyVacancyPayload(): Record<string, unknown> {
    return {
      type: "vacancy_available",
      institutionId,
      shiftInstanceId: shiftId,
      userId,
      recipientUserId: userId,
    };
  }

  async function insertLegacyQueued(suffix: string): Promise<number> {
    return insertLegacySubmission(suffix, {
      phase: "QUEUED",
      availableAt: new Date(Date.now() - 1_000).toISOString(),
    });
  }

  async function insertLegacySubmission(
    suffix: string,
    phase:
      | { phase: "QUEUED"; availableAt: string }
      | { phase: "SUBMITTING"; leaseUntil: string },
  ): Promise<number> {
    const [legacy] = await db
      .insert(notifications)
      .values({
        institutionId,
        userId,
        shiftInstanceId: shiftId,
        title: "Plantão vago disponível",
        body: "Texto legado",
        status: "PENDING",
        dedupKey: `vacancy-broadcast-legacy:${stamp}:${suffix}`,
        providerReceipt: {
          trackingVersion: 1,
          revision: 1,
          payloadData: legacyVacancyPayload(),
          attemptCount: 0,
          accountWideBadgeVersion: 1,
          ...phase,
        },
      })
      .$returningId();
    return legacy.id;
  }

  function operationalMessage(): Record<string, unknown> | null {
    for (const [, options] of fetchMock.mock.calls) {
      const raw = (options as RequestInit | undefined)?.body;
      if (typeof raw !== "string") continue;
      const body = JSON.parse(raw) as Record<string, unknown>;
      const data = body.data as Record<string, unknown> | undefined;
      if (data?.type === "vacancy_available") return body;
    }
    return null;
  }

  async function processQueued(): Promise<void> {
    await processPendingPushDeliveries(new Date(Date.now() + 1_000));
    await drainAccountWideNativeBadgeSnapshotDispatches();
  }

  it("exibe o hospital e setor canônicos para o profissional elegível", async () => {
    await enqueueVacancyAvailableSignals({ db, shift: shiftInput() });
    await db
      .update(hospitals)
      .set({ name: `Hospital canônico ${stamp}` })
      .where(eq(hospitals.id, hospitalAId));
    await db
      .update(sectors)
      .set({ name: `Setor canônico ${stamp}` })
      .where(eq(sectors.id, sectorAId));

    await processQueued();

    expect(operationalMessage()).toMatchObject({
      title: `Hospital canônico ${stamp} · Setor canônico ${stamp}`,
      body: "Há um plantão vago em 12/09/2032, 07:00–13:00.",
    });
  });

  it("migra fila legada sob autoridade atual antes de submeter ao Expo", async () => {
    const notificationId = await insertLegacyQueued("authorized");

    await processQueued();

    expect(operationalMessage()).toMatchObject({
      title: `Hospital A ${stamp} · Setor A ${stamp}`,
      body: "Há um plantão vago em 12/09/2032, 07:00–13:00.",
      data: {
        institutionId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        shiftInstanceId: shiftId,
        recipientUserId: userId,
      },
    });
    const [stored] = await db
      .select({ providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(eq(notifications.id, notificationId));
    expect(stored.providerReceipt).toMatchObject({
      phase: "TICKET_ACCEPTED",
      authority: {
        kind: "VACANCY_BROADCAST",
        purpose: "VACANCY_AVAILABLE",
        expectedUserId: userId,
        institutionId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        shiftInstanceId: shiftId,
      },
    });
  });

  it("recupera claim legado somente depois do vencimento do lease", async () => {
    const notificationId = await insertLegacySubmission("expired-lease", {
      phase: "SUBMITTING",
      leaseUntil: new Date(Date.now() - 1_000).toISOString(),
    });

    await processQueued();

    expect(operationalMessage()).toMatchObject({
      title: `Hospital A ${stamp} · Setor A ${stamp}`,
      body: "Há um plantão vago em 12/09/2032, 07:00–13:00.",
    });
    const [stored] = await db
      .select({ providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(eq(notifications.id, notificationId));
    expect(stored.providerReceipt).toMatchObject({
      phase: "TICKET_ACCEPTED",
      authority: {
        kind: "VACANCY_BROADCAST",
        purpose: "VACANCY_AVAILABLE",
        expectedUserId: userId,
        institutionId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        shiftInstanceId: shiftId,
      },
    });
  });

  it("não reativa fila legada se só restar ACL no hospital irmão", async () => {
    const notificationId = await insertLegacyQueued("revoked");
    await db
      .update(professionalAccess)
      .set({ canAccess: false })
      .where(eq(professionalAccess.id, accessAId));
    await db
      .update(professionalAccess)
      .set({ canAccess: true })
      .where(eq(professionalAccess.id, accessBId));

    await processQueued();

    expect(fetchMock).not.toHaveBeenCalled();
    const [stored] = await db
      .select({
        status: notifications.status,
        receipt: notifications.providerReceipt,
      })
      .from(notifications)
      .where(eq(notifications.id, notificationId));
    expect(stored.status).toBe("FAILED");
    expect(stored.receipt).toMatchObject({
      phase: "FAILED",
      evidence: { reason: "RECIPIENT_AUTHORITY_REVOKED" },
    });
  });

  it("não toma claim legado cujo lease ainda pertence a outro worker", async () => {
    const leaseUntil = new Date(Date.now() + 60_000).toISOString();
    const notificationId = await insertLegacySubmission("leased", {
      phase: "SUBMITTING",
      leaseUntil,
    });

    await processQueued();

    expect(fetchMock).not.toHaveBeenCalled();
    const [stored] = await db
      .select({ providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(eq(notifications.id, notificationId));
    expect(stored.providerReceipt).toMatchObject({
      phase: "SUBMITTING",
      revision: 1,
      leaseUntil,
    });
    expect(stored.providerReceipt).not.toHaveProperty("authority");
  });

  it("preserva acompanhamento de receipt legado já submetido", async () => {
    const ticketId = `legacy-receipt-${stamp}`;
    const tokenFingerprint = createHash("sha256")
      .update(`ExponentPushToken[vacancy-authority-${stamp}]`)
      .digest("hex");
    const [legacy] = await db
      .insert(notifications)
      .values({
        institutionId,
        userId,
        shiftInstanceId: shiftId,
        title: "Plantão vago disponível",
        body: "Texto legado",
        status: "PENDING",
        dedupKey: `vacancy-broadcast-legacy:${stamp}:receipt`,
        providerReceipt: {
          trackingVersion: 1,
          revision: 1,
          payloadData: legacyVacancyPayload(),
          attemptCount: 1,
          accountWideBadgeVersion: 1,
          phase: "TICKET_ACCEPTED",
          submittedAt: new Date(Date.now() - 2_000).toISOString(),
          receiptDueAt: new Date(Date.now() - 1_000).toISOString(),
          receiptAttempts: 0,
          tickets: [
            {
              ticketId,
              pushTokenId,
              expectedUserId: userId,
              tokenFingerprint,
            },
          ],
          submission: {
            status: "TICKETS_ACCEPTED",
            message: "Ticket legado aceito",
            tickets: [],
            acceptedCount: 1,
            rejectedCount: 0,
          },
        },
      })
      .$returningId();
    fetchMock.mockImplementation(async (_url, options) => {
      const body = JSON.parse(String((options as RequestInit).body)) as {
        ids?: unknown;
      };
      return Array.isArray(body.ids)
        ? response(200, { data: { [ticketId]: { status: "ok" } } })
        : response(200, {
            data: { status: "ok", id: `legacy-badge-${stamp}` },
          });
    });

    await processQueued();

    const [stored] = await db
      .select({
        status: notifications.status,
        receipt: notifications.providerReceipt,
      })
      .from(notifications)
      .where(eq(notifications.id, legacy.id));
    expect(stored.status).toBe("SENT");
    expect(stored.receipt).toMatchObject({
      phase: "PROVIDER_ACCEPTED",
    });
    expect(stored.receipt).not.toMatchObject({
      evidence: { reason: "MALFORMED_TRACKING_STATE" },
    });
  });

  it("não usa ACL do hospital irmão como fallback do mesmo tenant", async () => {
    await enqueueVacancyAvailableSignals({ db, shift: shiftInput() });
    await db
      .update(professionalAccess)
      .set({ canAccess: false })
      .where(eq(professionalAccess.id, accessAId));
    await db
      .update(professionalAccess)
      .set({ canAccess: true })
      .where(eq(professionalAccess.id, accessBId));

    await processQueued();

    expect(fetchMock).not.toHaveBeenCalled();
    const [row] = await db
      .select({
        status: notifications.status,
        receipt: notifications.providerReceipt,
      })
      .from(notifications)
      .where(eq(notifications.userId, userId));
    expect(row.status).toBe("FAILED");
    expect(row.receipt).toMatchObject({
      phase: "FAILED",
      evidence: { reason: "RECIPIENT_AUTHORITY_REVOKED" },
    });
  });

  it("suprime aviso quando o plantão deixa de estar vago", async () => {
    await enqueueVacancyAvailableSignals({ db, shift: shiftInput() });
    await db
      .update(shiftInstances)
      .set({ status: "OCUPADO" })
      .where(eq(shiftInstances.id, shiftId));

    await processQueued();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falha fechado diante de alocação ativa com topologia envenenada", async () => {
    await enqueueVacancyAvailableSignals({ db, shift: shiftInput() });
    await db.insert(shiftAssignmentsV2).values({
      shiftInstanceId: shiftId,
      institutionId,
      hospitalId: hospitalBId,
      sectorId: sectorBId,
      professionalId,
      assignmentType: "ON_DUTY",
      status: "OCUPADO",
      isActive: true,
    });

    await processQueued();

    expect(fetchMock).not.toHaveBeenCalled();
    const [row] = await db
      .select({
        status: notifications.status,
        receipt: notifications.providerReceipt,
      })
      .from(notifications)
      .where(eq(notifications.userId, userId));
    expect(row.status).toBe("FAILED");
    expect(row.receipt).toMatchObject({
      phase: "FAILED",
      evidence: { reason: "RECIPIENT_AUTHORITY_REVOKED" },
    });
  });

  it("suprime aviso quando a competência é bloqueada", async () => {
    await enqueueVacancyAvailableSignals({ db, shift: shiftInput() });
    await db
      .update(monthlyRosters)
      .set({ status: "LOCKED" })
      .where(
        and(
          eq(monthlyRosters.institutionId, institutionId),
          eq(monthlyRosters.hospitalId, hospitalAId),
          eq(monthlyRosters.yearMonth, "2032-09"),
        ),
      );

    await processQueued();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recusa payload de broadcast sem autoridade tipada", async () => {
    await expect(
      enqueueTrackedPushNotification({
        institutionId,
        userId,
        shiftInstanceId: shiftId,
        dedupKey: `vacancy-broadcast-without-authority:${stamp}`,
        payload: {
          title: "Texto do produtor",
          body: "Texto do produtor",
          data: {
            type: "vacancy_available",
            institutionId,
            hospitalId: hospitalAId,
            sectorId: sectorAId,
            shiftInstanceId: shiftId,
          },
        },
      }),
    ).rejects.toThrow("Push rastreado exige autoridade canonica");
  });

  it("recusa payload cujo destinatário diverge da autoridade tipada", async () => {
    await expect(
      enqueueTrackedPushNotification({
        institutionId,
        userId,
        shiftInstanceId: shiftId,
        dedupKey: `vacancy-broadcast-wrong-recipient:${stamp}`,
        payload: {
          title: "Texto do produtor",
          body: "Texto do produtor",
          data: {
            type: "vacancy_available",
            institutionId,
            hospitalId: hospitalAId,
            sectorId: sectorAId,
            shiftInstanceId: shiftId,
            userId: userId + 1,
          },
        },
        authority: {
          kind: "VACANCY_BROADCAST",
          purpose: "VACANCY_AVAILABLE",
          expectedUserId: userId,
          institutionId,
          hospitalId: hospitalAId,
          sectorId: sectorAId,
          shiftInstanceId: shiftId,
        },
      }),
    ).rejects.toThrow("destinatario invalido");
  });
});
