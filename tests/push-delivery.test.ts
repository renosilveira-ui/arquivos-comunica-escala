import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  institutions,
  notifications,
  professionalInstitutions,
  professionals,
  pushTokens,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import {
  processPendingPushDeliveries,
  sendTrackedPushNotification,
} from "../server/push-delivery";
import { registerPushToken } from "../server/notifications-service";

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

async function waitForPushTokenLockWaiter(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  token: string,
): Promise<void> {
  const marker = `escala-push-token:${createHash("sha256")
    .update(token)
    .digest("hex")
    .slice(0, 40)}`;
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const [rows] = await db.execute("SHOW FULL PROCESSLIST");
    const waiting = (rows as { Info?: unknown }[]).some(
      (row) => typeof row.Info === "string" && row.Info.includes("GET_LOCK") && row.Info.includes(marker),
    );
    if (waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Waiter do mutex push-token não observado: ${marker}`);
}

describe("outbox de push sem projeção de entrega", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionId: number;
  let userId: number;
  let otherUserId: number;
  let professionalId: number;
  const stamp = Date.now();
  const now = new Date("2031-02-10T14:00:00.000Z");
  const fetchMock = vi.fn();

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;
    const [institution] = await db
      .insert(institutions)
      .values({
        name: `Push Delivery ${stamp}`,
        cnpj: `${stamp}`.slice(-14).padStart(14, "0"),
        legalName: `Push Delivery ${stamp}`,
        tradeName: `PD${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = institution.id;
    const [user] = await db
      .insert(users)
      .values({
        name: `Push Delivery ${stamp}`,
        email: `push-delivery-${stamp}@test.local`,
        passwordHash: "test",
        role: "doctor",
      })
      .$returningId();
    userId = user.id;
    const [otherUser] = await db
      .insert(users)
      .values({
        name: `Push Delivery Other ${stamp}`,
        email: `push-delivery-other-${stamp}@test.local`,
        passwordHash: "test",
        role: "doctor",
      })
      .$returningId();
    otherUserId = otherUser.id;
    const [professional] = await db
      .insert(professionals)
      .values({
        userId,
        name: `Push Delivery ${stamp}`,
        role: "MEDICO",
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
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await db.delete(notifications).where(eq(notifications.userId, userId));
    await db.delete(pushTokens).where(eq(pushTokens.userId, userId));
    await db.insert(pushTokens).values({
      institutionId,
      userId,
      token: `ExponentPushToken[pd-${stamp}]`,
      platform: "ios",
    });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.delete(notifications).where(eq(notifications.userId, userId));
    await db.delete(pushTokens).where(eq(pushTokens.userId, userId));
    await db.delete(professionalInstitutions).where(
      eq(professionalInstitutions.professionalId, professionalId),
    );
    await db.delete(professionals).where(eq(professionals.id, professionalId));
    await db.delete(users).where(eq(users.id, userId));
    await db.delete(users).where(eq(users.id, otherUserId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
  });

  const input = (suffix: string) => ({
    institutionId,
    userId,
    dedupKey: `push-delivery:${stamp}:${suffix}`,
    payload: {
      title: "Confirmação de plantão",
      body: "Você confirma seu plantão?",
      data: { type: "transport_test", suffix },
    },
  });

  it("persiste antes do envio, aceita ticket uma vez e mantém receipt pendente", async () => {
    fetchMock.mockResolvedValue(
      response(200, { data: { status: "ok", id: "ticket-once" } }),
    );

    const first = await sendTrackedPushNotification(input("once"), now);
    const second = await sendTrackedPushNotification(input("once"), now);

    expect(first).toMatchObject({
      status: "PENDING",
      phase: "TICKET_ACCEPTED",
      ticketAccepted: true,
      providerAccepted: false,
    });
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [stored] = await db
      .select({ status: notifications.status, providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(eq(notifications.id, first.notificationId));
    expect(stored.status).toBe("PENDING");
    expect(stored.providerReceipt).toMatchObject({ phase: "TICKET_ACCEPTED" });
  });

  it("mantém o marker do badge apenas no outbox local, sem alterar o envelope Expo", async () => {
    fetchMock.mockResolvedValue(
      response(200, {
        data: { status: "ok", id: "ticket-account-badge-marker" },
      }),
    );

    const tracked = await sendTrackedPushNotification(
      {
        ...input("account-badge-marker"),
        payload: {
          title: "Vaga disponível",
          body: "Há uma vaga para você.",
          data: { type: "vacancy_available", route: "/(tabs)/vacancies" },
        },
      },
      now,
    );
    const [stored] = await db
      .select({ providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(eq(notifications.id, tracked.notificationId));
    const payloadData = (
      stored.providerReceipt as { payloadData?: Record<string, unknown> }
    ).payloadData;
    expect(stored.providerReceipt).toMatchObject({
      accountWideBadgeVersion: 1,
    });
    expect(payloadData).not.toHaveProperty("accountWideBadgeVersion");
    expect(payloadData).not.toHaveProperty("notificationId");

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      badge?: unknown;
      data?: Record<string, unknown>;
    };
    expect(body).not.toHaveProperty("badge");
    expect(body.data).toMatchObject({
      type: "vacancy_available",
      route: "/(tabs)/vacancies",
      recipientUserId: userId,
    });
    expect(body.data).not.toHaveProperty("accountWideBadgeVersion");
    expect(body.data).not.toHaveProperty("notificationId");
  });

  it("rejeita colisão de dedupKey com destinatário ou payload diferente", async () => {
    fetchMock.mockResolvedValue(
      response(200, { data: { status: "ok", id: "ticket-collision" } }),
    );
    await sendTrackedPushNotification(input("collision"), now);

    await expect(
      sendTrackedPushNotification(
        {
          ...input("collision"),
          payload: {
            ...input("collision").payload,
            body: "Conteúdo diferente",
          },
        },
        now,
      ),
    ).rejects.toThrow("Colisão de dedupKey");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("submete a todos os dispositivos da conta sem usar provenance como autoridade", async () => {
    const [otherInstitution] = await db
      .insert(institutions)
      .values({
        name: `Push Delivery Other ${stamp}`,
        cnpj: `${stamp}77`.slice(-14).padStart(14, "0"),
        legalName: `Push Delivery Other ${stamp}`,
        tradeName: `PDO${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    const otherToken = `ExponentPushToken[pd-other-${stamp}]`;
    await db.insert(pushTokens).values({
      institutionId: otherInstitution.id,
      userId,
      token: otherToken,
      platform: "android",
    });
    fetchMock.mockResolvedValue(
      response(200, { data: { status: "ok", id: "ticket-tenant" } }),
    );

    try {
      await sendTrackedPushNotification(input("tenant"), now);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const submitted = fetchMock.mock.calls.map((call) => {
        const request = call[1] as RequestInit;
        return (JSON.parse(String(request.body)) as { to: string }).to;
      });
      expect(new Set(submitted)).toEqual(new Set([
        `ExponentPushToken[pd-${stamp}]`,
        otherToken,
      ]));
    } finally {
      await db.delete(pushTokens).where(eq(pushTokens.token, otherToken));
      await db.delete(institutions).where(eq(institutions.id, otherInstitution.id));
    }
  });

  it("só projeta SENT depois de receipt ok do provedor", async () => {
    fetchMock.mockResolvedValueOnce(
      response(200, { data: { status: "ok", id: "ticket-receipt-ok" } }),
    );
    const tracked = await sendTrackedPushNotification(input("receipt-ok"), now);

    fetchMock.mockResolvedValue(
      response(200, { data: { "ticket-receipt-ok": { status: "ok" } } }),
    );
    await processPendingPushDeliveries(new Date(now.getTime() + 14 * 60_000));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await processPendingPushDeliveries(new Date(now.getTime() + 15 * 60_000));
    const [stored] = await db
      .select({
        status: notifications.status,
        sentAt: notifications.sentAt,
        providerReceipt: notifications.providerReceipt,
      })
      .from(notifications)
      .where(eq(notifications.id, tracked.notificationId));
    expect(stored.status).toBe("SENT");
    expect(stored.sentAt).not.toBeNull();
    expect(stored.providerReceipt).toMatchObject({
      phase: "PROVIDER_ACCEPTED",
      accountWideBadgeVersion: 1,
    });
  });

  it("ticket DeviceNotRegistered falha e invalida o token", async () => {
    const providerSentinel = "EXPO_PROVIDER_BODY_SENTINEL";
    fetchMock.mockResolvedValue(
      response(200, {
        data: {
          status: "error",
          message: providerSentinel,
          details: { error: "DeviceNotRegistered" },
        },
      }),
    );

    const tracked = await sendTrackedPushNotification(input("stale"), now);
    expect(tracked).toMatchObject({ status: "FAILED", phase: "FAILED", ticketAccepted: false });
    await expect(
      db.select({ id: pushTokens.id }).from(pushTokens).where(eq(pushTokens.userId, userId)),
    ).resolves.toHaveLength(0);
    const [stored] = await db
      .select({
        errorMessage: notifications.errorMessage,
        providerReceipt: notifications.providerReceipt,
      })
      .from(notifications)
      .where(eq(notifications.id, tracked.notificationId));
    expect(JSON.stringify(stored)).not.toContain(providerSentinel);
  });

  it("reassociação A→B espera fetch lento e receipt antigo não remove owner B", async () => {
    const [selected] = await db
      .select({ id: pushTokens.id, token: pushTokens.token })
      .from(pushTokens)
      .where(eq(pushTokens.userId, userId));
    const [otherUser] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, otherUserId));
    let signalFetchEntered!: () => void;
    const fetchEntered = new Promise<void>((resolve) => {
      signalFetchEntered = resolve;
    });
    let releaseFetch!: () => void;
    const fetchRelease = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    fetchMock.mockImplementationOnce(async () => {
      signalFetchEntered();
      await fetchRelease;
      return response(200, { data: { status: "ok", id: "ticket-stale-owner" } });
    });

    const trackedPromise = sendTrackedPushNotification(input("stale-owner"), now);
    await fetchEntered;
    let reassignmentSettled = false;
    const reassignmentPromise = registerPushToken(
      otherUserId,
      selected.token,
      "ios",
      null,
      otherUser.sessionVersion,
    ).then((result) => {
      reassignmentSettled = true;
      return result;
    });

    try {
      await waitForPushTokenLockWaiter(db, selected.token);
      expect(reassignmentSettled).toBe(false);
      await expect(
        db
          .select({ userId: pushTokens.userId })
          .from(pushTokens)
          .where(eq(pushTokens.id, selected.id)),
      ).resolves.toEqual([{ userId }]);

      releaseFetch();
      const tracked = await trackedPromise;
      await expect(reassignmentPromise).resolves.toEqual({
        success: true,
        message: "Token associado à conta atual",
      });

      fetchMock.mockResolvedValueOnce(
        response(200, {
          data: {
            "ticket-stale-owner": {
              status: "error",
              details: { error: "DeviceNotRegistered" },
            },
          },
        }),
      );
      await processPendingPushDeliveries(new Date(now.getTime() + 15 * 60_000));

      await expect(
        db
          .select({ id: pushTokens.id, userId: pushTokens.userId, token: pushTokens.token })
          .from(pushTokens)
          .where(eq(pushTokens.id, selected.id)),
      ).resolves.toEqual([{ id: selected.id, userId: otherUserId, token: selected.token }]);
      const [stored] = await db
        .select({ status: notifications.status, providerReceipt: notifications.providerReceipt })
        .from(notifications)
        .where(eq(notifications.id, tracked.notificationId));
      expect(stored.status).toBe("FAILED");
      expect(JSON.stringify(stored.providerReceipt)).toContain("UNCHANGED");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      releaseFetch();
      await Promise.allSettled([trackedPromise, reassignmentPromise]);
      await db.delete(pushTokens).where(eq(pushTokens.id, selected.id));
    }
  });

  it("binding de receipt divergente da notification falha antes da rede", async () => {
    fetchMock.mockResolvedValueOnce(
      response(200, { data: { status: "ok", id: "ticket-wrong-user" } }),
    );
    const tracked = await sendTrackedPushNotification(input("wrong-user"), now);
    const [storedBefore] = await db
      .select({ providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(eq(notifications.id, tracked.notificationId));
    const corrupted = structuredClone(storedBefore.providerReceipt) as {
      tickets: { expectedUserId: number }[];
    };
    corrupted.tickets[0]!.expectedUserId = otherUserId;
    await db
      .update(notifications)
      .set({ providerReceipt: corrupted })
      .where(eq(notifications.id, tracked.notificationId));
    fetchMock.mockClear();

    await processPendingPushDeliveries(new Date(now.getTime() + 15 * 60_000));

    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      db.select({ id: pushTokens.id }).from(pushTokens).where(eq(pushTokens.userId, userId)),
    ).resolves.toHaveLength(1);
    const [storedAfter] = await db
      .select({ status: notifications.status, providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(eq(notifications.id, tracked.notificationId));
    expect(storedAfter.status).toBe("FAILED");
    expect(storedAfter.providerReceipt).toMatchObject({
      phase: "FAILED",
      evidence: { reason: "MALFORMED_TRACKING_STATE" },
    });
  });

  it("marker de badge desconhecido falha fechado antes da rede", async () => {
    fetchMock.mockResolvedValueOnce(
      response(200, {
        data: { status: "ok", id: "ticket-invalid-badge-marker" },
      }),
    );
    const tracked = await sendTrackedPushNotification(
      input("invalid-badge-marker"),
      now,
    );
    const [storedBefore] = await db
      .select({ providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(eq(notifications.id, tracked.notificationId));
    const corrupted = structuredClone(
      storedBefore.providerReceipt,
    ) as Record<string, unknown>;
    corrupted.accountWideBadgeVersion = 2;
    await db
      .update(notifications)
      .set({ providerReceipt: corrupted })
      .where(eq(notifications.id, tracked.notificationId));
    fetchMock.mockClear();

    await processPendingPushDeliveries(
      new Date(now.getTime() + 15 * 60_000),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    const [storedAfter] = await db
      .select({
        status: notifications.status,
        providerReceipt: notifications.providerReceipt,
      })
      .from(notifications)
      .where(eq(notifications.id, tracked.notificationId));
    expect(storedAfter.status).toBe("FAILED");
    expect(storedAfter.providerReceipt).toMatchObject({
      phase: "FAILED",
      evidence: { reason: "MALFORMED_TRACKING_STATE" },
    });
  });

  it("falha transitória respeita backoff e tenta novamente", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(response(200, { data: { status: "ok", id: "ticket-retry" } }));

    const tracked = await sendTrackedPushNotification(input("retry"), now);
    expect(tracked).toMatchObject({ status: "PENDING", phase: "QUEUED", ticketAccepted: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await processPendingPushDeliveries(new Date(now.getTime() + 59_000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await processPendingPushDeliveries(new Date(now.getTime() + 60_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [stored] = await db
      .select({ providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(eq(notifications.id, tracked.notificationId));
    expect(stored.providerReceipt).toMatchObject({
      phase: "TICKET_ACCEPTED",
      attemptCount: 2,
      accountWideBadgeVersion: 1,
    });
  });

  it("SERVICE_ERROR permanece retryable sem limite e não persiste params Drizzle", async () => {
    const sentinel = "DRIZZLE_PUSH_TOKEN_SENTINEL";
    const originalSelect = db.select.bind(db);
    const selectSpy = vi.spyOn(db as any, "select").mockImplementation((...args: any[]) => {
      if (args.length > 0) throw new Error(sentinel);
      return (originalSelect as any)(...args);
    });

    let tracked: Awaited<ReturnType<typeof sendTrackedPushNotification>>;
    try {
      tracked = await sendTrackedPushNotification(input("service-error-indefinite"), now);
      await processPendingPushDeliveries(new Date(now.getTime() + 60_000));
      await processPendingPushDeliveries(new Date(now.getTime() + 6 * 60_000));
      await processPendingPushDeliveries(new Date(now.getTime() + 11 * 60_000));
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
      .where(eq(notifications.id, tracked!.notificationId));
    expect(stored.status).toBe("PENDING");
    expect(stored.providerReceipt).toMatchObject({ phase: "QUEUED", attemptCount: 4 });
    expect(stored.errorMessage).toBe("Serviço de push temporariamente indisponível");
    expect(JSON.stringify(stored)).not.toContain(sentinel);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain(sentinel);
  });

  it("ausência transitória de token permanece recuperável pelo outbox", async () => {
    await db.delete(pushTokens).where(eq(pushTokens.userId, userId));
    const tracked = await sendTrackedPushNotification(input("late-token"), now);
    expect(tracked).toMatchObject({ status: "PENDING", phase: "QUEUED" });
    expect(fetchMock).not.toHaveBeenCalled();

    await db.insert(pushTokens).values({
      institutionId,
      userId,
      token: `ExponentPushToken[pd-late-${stamp}]`,
      platform: "ios",
    });
    fetchMock.mockResolvedValue(
      response(200, { data: { status: "ok", id: "ticket-late-token" } }),
    );
    await processPendingPushDeliveries(new Date(now.getTime() + 60_000));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [stored] = await db.select({ providerReceipt: notifications.providerReceipt })
      .from(notifications).where(eq(notifications.id, tracked.notificationId));
    expect(stored.providerReceipt).toMatchObject({ phase: "TICKET_ACCEPTED", attemptCount: 2 });
  });

  it("receipt ausente permanece incerto e termina FAILED, nunca SENT", async () => {
    fetchMock.mockResolvedValueOnce(
      response(200, { data: { status: "ok", id: "ticket-missing" } }),
    );
    const tracked = await sendTrackedPushNotification(input("receipt-missing"), now);
    fetchMock.mockResolvedValue(response(200, { data: {} }));

    await processPendingPushDeliveries(new Date(now.getTime() + 15 * 60_000));
    await processPendingPushDeliveries(new Date(now.getTime() + 20 * 60_000));
    await processPendingPushDeliveries(new Date(now.getTime() + 25 * 60_000));

    const [stored] = await db
      .select({ status: notifications.status, sentAt: notifications.sentAt })
      .from(notifications)
      .where(eq(notifications.id, tracked.notificationId));
    expect(stored.status).toBe("FAILED");
    expect(stored.sentAt).toBeNull();
  });
});
