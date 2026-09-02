import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  institutions,
  notifications,
  professionalInstitutions,
  professionals,
  pushTokens,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { appRouter } from "../server/routers";
import { drainAccountWideNativeBadgeSnapshotDispatches } from "../server/notifications-service";
import { ACCOUNT_WIDE_BADGE_VERSION } from "../lib/account-wide-native-badge";

const stamp = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
const currentSessionVersion = 1;

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

async function waitForBadgeAcknowledgementLockWaiter(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  userId: number,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  const accountPredicate = `\`notifications\`.\`user_id\` = ${userId}`;
  while (Date.now() < deadline) {
    const [rows] = await db.execute("SHOW FULL PROCESSLIST");
    const waiting = (rows as { Info?: unknown }[]).some((row) => {
      if (typeof row.Info !== "string") return false;
      const query = row.Info.toLowerCase();
      return query.includes(accountPredicate) && query.includes("for update");
    });
    if (waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Waiter do acknowledgement de badge não observado");
}

describe("badge account-wide — selector e acknowledgement canônicos", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionAId: number;
  let institutionBId: number;
  let accountUserId: number;
  let otherUserId: number;
  let accountProfessionalId: number;
  let otherProfessionalId: number;
  const notificationIds: number[] = [];

  const callerFor = (
    userId: number,
    sessionVersion: number,
    institutionId: number,
  ) =>
    appRouter.createCaller({
      user: {
        id: userId,
        name: "Badge test",
        email: `badge-caller-${userId}@test.local`,
        role: "doctor",
        sessionVersion,
      },
      institutionId,
      allowedInstitutionIds: [institutionAId, institutionBId],
      tenantProfessionalId:
        userId === accountUserId ? accountProfessionalId : otherProfessionalId,
      tenantResolutionError: null,
      req: {} as never,
      res: {} as never,
    } as never);

  const trackedReceipt = (
    type: string,
    recipientUserId: number,
    options: {
      marker?: boolean;
      phase?:
        | "QUEUED"
        | "SUBMITTING"
        | "TICKET_ACCEPTED"
        | "RECEIPT_CHECKING"
        | "PROVIDER_ACCEPTED";
    } = {},
  ) => ({
    trackingVersion: 1,
    revision: 1,
    payloadData: { type, recipientUserId },
    attemptCount: 1,
    ...(options.marker === false
      ? {}
      : { accountWideBadgeVersion: ACCOUNT_WIDE_BADGE_VERSION }),
    phase: options.phase ?? "PROVIDER_ACCEPTED",
    terminalAt: "2032-01-01T00:00:00.000Z",
  });

  async function insertNotification(input: {
    institutionId: number;
    userId: number;
    dedupSuffix: string;
    providerReceipt: Record<string, unknown>;
    status?: "PENDING" | "SENT";
  }): Promise<number> {
    const [created] = await db
      .insert(notifications)
      .values({
        institutionId: input.institutionId,
        userId: input.userId,
        title: "Atualização de escala",
        body: "Há uma atualização disponível.",
        type: "GENERAL",
        status: input.status ?? "SENT",
        dedupKey: `account-badge:${stamp}:${input.dedupSuffix}`,
        providerReceipt: input.providerReceipt,
        read: false,
      })
      .$returningId();
    notificationIds.push(created.id);
    return created.id;
  }

  beforeAll(async () => {
    const connection = await getDb();
    if (!connection) throw new Error("Database not available");
    db = connection;

    const [institutionA] = await db
      .insert(institutions)
      .values({
        name: `Badge A ${stamp}`,
        cnpj: `${stamp}1`.slice(-14).padStart(14, "0"),
        legalName: `Badge A ${stamp}`,
        tradeName: `BA${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionAId = institutionA.id;
    const [institutionB] = await db
      .insert(institutions)
      .values({
        name: `Badge B ${stamp}`,
        cnpj: `${stamp}2`.slice(-14).padStart(14, "0"),
        legalName: `Badge B ${stamp}`,
        tradeName: `BB${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionBId = institutionB.id;

    const [accountUser] = await db
      .insert(users)
      .values({
        name: `Badge account ${stamp}`,
        email: `badge-account-${stamp}@test.local`,
        passwordHash: "test",
        role: "doctor",
        approvalStatus: "APPROVED",
        sessionVersion: currentSessionVersion,
      })
      .$returningId();
    accountUserId = accountUser.id;
    const [otherUser] = await db
      .insert(users)
      .values({
        name: `Badge other ${stamp}`,
        email: `badge-other-${stamp}@test.local`,
        passwordHash: "test",
        role: "doctor",
        approvalStatus: "APPROVED",
        sessionVersion: currentSessionVersion,
      })
      .$returningId();
    otherUserId = otherUser.id;

    const [accountProfessional] = await db
      .insert(professionals)
      .values({
        userId: accountUserId,
        name: `Badge account ${stamp}`,
        role: "MEDICO",
        userRole: "USER",
      })
      .$returningId();
    accountProfessionalId = accountProfessional.id;
    const [otherProfessional] = await db
      .insert(professionals)
      .values({
        userId: otherUserId,
        name: `Badge other ${stamp}`,
        role: "MEDICO",
        userRole: "USER",
      })
      .$returningId();
    otherProfessionalId = otherProfessional.id;
    await db.insert(professionalInstitutions).values([
      {
        userId: accountUserId,
        professionalId: accountProfessionalId,
        institutionId: institutionAId,
        roleInInstitution: "USER",
        active: true,
      },
      {
        userId: accountUserId,
        professionalId: accountProfessionalId,
        institutionId: institutionBId,
        roleInInstitution: "USER",
        active: true,
      },
      {
        userId: otherUserId,
        professionalId: otherProfessionalId,
        institutionId: institutionAId,
        roleInInstitution: "USER",
        active: true,
      },
    ]);
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(pushTokens).where(
      inArray(pushTokens.userId, [accountUserId, otherUserId]),
    );
    if (notificationIds.length > 0) {
      await db
        .delete(notifications)
        .where(inArray(notifications.id, notificationIds));
    }
    await db
      .delete(professionalInstitutions)
      .where(
        inArray(professionalInstitutions.professionalId, [
          accountProfessionalId,
          otherProfessionalId,
        ]),
      );
    await db
      .delete(professionals)
      .where(
        inArray(professionals.id, [accountProfessionalId, otherProfessionalId]),
      );
    await db
      .delete(users)
      .where(inArray(users.id, [accountUserId, otherUserId]));
    await db
      .delete(institutions)
      .where(inArray(institutions.id, [institutionAId, institutionBId]));
  });

  afterEach(async () => {
    await drainAccountWideNativeBadgeSnapshotDispatches();
  });

  it("conta todos os vínculos ativos da conta, mas exclui outboxes internos e não entregáveis", async () => {
    const visibleA = await insertNotification({
      institutionId: institutionAId,
      userId: accountUserId,
      dedupSuffix: "visible-a",
      providerReceipt: trackedReceipt("vacancy_available", accountUserId),
    });
    const visibleB = await insertNotification({
      institutionId: institutionBId,
      userId: accountUserId,
      dedupSuffix: "visible-b",
      providerReceipt: trackedReceipt("swap_offer", accountUserId, {
        phase: "PROVIDER_ACCEPTED",
      }),
    });
    const internalOutbox = await insertNotification({
      institutionId: institutionAId,
      userId: accountUserId,
      dedupSuffix: "internal",
      providerReceipt: {
        comunicaPlusOutboxVersion: 1,
        payloadData: {
          type: "vacancy_available",
          recipientUserId: accountUserId,
        },
        phase: "PROVIDER_ACCEPTED",
      },
    });
    const dutySyncOutbox = await insertNotification({
      institutionId: institutionAId,
      userId: accountUserId,
      dedupSuffix: "duty-sync",
      providerReceipt: {
        dutySyncVersion: 1,
        payloadData: {
          type: "vacancy_available",
          recipientUserId: accountUserId,
        },
        phase: "PROVIDER_ACCEPTED",
      },
    });
    const legacyOutbox = await insertNotification({
      institutionId: institutionAId,
      userId: accountUserId,
      dedupSuffix: "legacy",
      providerReceipt: trackedReceipt("vacancy_available", accountUserId, {
        marker: false,
      }),
    });
    const wrongRecipient = await insertNotification({
      institutionId: institutionAId,
      userId: accountUserId,
      dedupSuffix: "wrong-recipient",
      providerReceipt: trackedReceipt("vacancy_available", otherUserId),
    });
    const stringMarker = await insertNotification({
      institutionId: institutionAId,
      userId: accountUserId,
      dedupSuffix: "string-marker",
      providerReceipt: {
        ...trackedReceipt("vacancy_available", accountUserId),
        accountWideBadgeVersion: String(ACCOUNT_WIDE_BADGE_VERSION),
      },
    });
    const booleanMarker = await insertNotification({
      institutionId: institutionAId,
      userId: accountUserId,
      dedupSuffix: "boolean-marker",
      providerReceipt: {
        ...trackedReceipt("vacancy_available", accountUserId),
        accountWideBadgeVersion: true,
      },
    });
    const nullMarker = await insertNotification({
      institutionId: institutionAId,
      userId: accountUserId,
      dedupSuffix: "null-marker",
      providerReceipt: {
        ...trackedReceipt("vacancy_available", accountUserId),
        accountWideBadgeVersion: null,
      },
    });
    const stringRecipient = await insertNotification({
      institutionId: institutionAId,
      userId: accountUserId,
      dedupSuffix: "string-recipient",
      providerReceipt: {
        ...trackedReceipt("vacancy_available", accountUserId),
        payloadData: {
          type: "vacancy_available",
          recipientUserId: String(accountUserId),
        },
      },
    });
    const fractionalRecipient = await insertNotification({
      institutionId: institutionAId,
      userId: accountUserId,
      dedupSuffix: "fractional-recipient",
      providerReceipt: {
        ...trackedReceipt("vacancy_available", accountUserId),
        payloadData: {
          type: "vacancy_available",
          recipientUserId: accountUserId + 0.5,
        },
      },
    });
    const unsupportedType = await insertNotification({
      institutionId: institutionAId,
      userId: accountUserId,
      dedupSuffix: "unsupported-type",
      providerReceipt: trackedReceipt("transport_test", accountUserId),
    });
    const queued = await insertNotification({
      institutionId: institutionAId,
      userId: accountUserId,
      dedupSuffix: "queued",
      status: "PENDING",
      providerReceipt: trackedReceipt("vacancy_available", accountUserId, {
        phase: "QUEUED",
      }),
    });
    const submitting = await insertNotification({
      institutionId: institutionAId,
      userId: accountUserId,
      dedupSuffix: "submitting",
      status: "PENDING",
      providerReceipt: trackedReceipt("vacancy_available", accountUserId, {
        phase: "SUBMITTING",
      }),
    });
    const ticketAccepted = await insertNotification({
      institutionId: institutionAId,
      userId: accountUserId,
      dedupSuffix: "ticket-accepted",
      status: "PENDING",
      providerReceipt: trackedReceipt("vacancy_available", accountUserId, {
        phase: "TICKET_ACCEPTED",
      }),
    });
    const receiptChecking = await insertNotification({
      institutionId: institutionAId,
      userId: accountUserId,
      dedupSuffix: "receipt-checking",
      status: "PENDING",
      providerReceipt: trackedReceipt("vacancy_available", accountUserId, {
        phase: "RECEIPT_CHECKING",
      }),
    });
    const otherAccount = await insertNotification({
      institutionId: institutionAId,
      userId: otherUserId,
      dedupSuffix: "other-account",
      providerReceipt: trackedReceipt("vacancy_available", otherUserId),
    });

    await expect(
      callerFor(
        accountUserId,
        currentSessionVersion,
        institutionAId,
      ).notifications.getUnreadAccountBadgeCount(),
    ).resolves.toEqual({ count: 4 });
    await expect(
      callerFor(
        accountUserId,
        currentSessionVersion,
        institutionBId,
      ).notifications.getUnreadAccountBadgeCount(),
    ).resolves.toEqual({ count: 4 });

    await db
      .update(professionalInstitutions)
      .set({ active: false })
      .where(
        and(
          eq(professionalInstitutions.userId, accountUserId),
          eq(professionalInstitutions.institutionId, institutionBId),
        ),
      );
    await expect(
      callerFor(
        accountUserId,
        currentSessionVersion,
        institutionAId,
      ).notifications.getUnreadAccountBadgeCount(),
    ).resolves.toEqual({ count: 3 });

    // A conta já havia visto quatro alertas, mas o vínculo B foi revogado
    // antes do acknowledgement. O write reexecuta o selector no servidor e
    // não pode marcar a row B como lida por ela ter aparecido anteriormente.
    await expect(
      callerFor(
        accountUserId,
        currentSessionVersion,
        institutionAId,
      ).notifications.acknowledgeAccountBadge(),
    ).resolves.toEqual({ acknowledged: 3, count: 0 });
    const afterRevocationAcknowledgement = await db
      .select({ id: notifications.id, read: notifications.read })
      .from(notifications)
      .where(inArray(notifications.id, [visibleA, visibleB]));
    const readAfterRevocation = new Map(
      afterRevocationAcknowledgement.map((row) => [row.id, row.read]),
    );
    expect(readAfterRevocation.get(visibleA)).toBe(true);
    expect(readAfterRevocation.get(visibleB)).toBe(false);

    await db
      .update(professionalInstitutions)
      .set({ active: true })
      .where(
        and(
          eq(professionalInstitutions.userId, accountUserId),
          eq(professionalInstitutions.institutionId, institutionBId),
        ),
      );

    await expect(
      callerFor(
        accountUserId,
        currentSessionVersion,
        institutionBId,
      ).notifications.getUnreadAccountBadgeCount(),
    ).resolves.toEqual({ count: 1 });

    await expect(
      callerFor(
        accountUserId,
        currentSessionVersion + 1,
        institutionAId,
      ).notifications.getUnreadAccountBadgeCount(),
    ).resolves.toEqual({ count: 0 });

    await expect(
      callerFor(
        accountUserId,
        currentSessionVersion + 1,
        institutionAId,
      ).notifications.acknowledgeAccountBadge(),
    ).resolves.toEqual({ acknowledged: 0, count: 0 });
    const [afterStaleSessionAcknowledgement] = await db
      .select({ read: notifications.read })
      .from(notifications)
      .where(eq(notifications.id, visibleB));
    expect(afterStaleSessionAcknowledgement.read).toBe(false);

    await db
      .update(institutions)
      .set({ isActive: false })
      .where(eq(institutions.id, institutionBId));
    try {
      await expect(
        callerFor(
          accountUserId,
          currentSessionVersion,
          institutionAId,
        ).notifications.getUnreadAccountBadgeCount(),
      ).resolves.toEqual({ count: 0 });
      await expect(
        callerFor(
          accountUserId,
          currentSessionVersion,
          institutionAId,
        ).notifications.acknowledgeAccountBadge(),
      ).resolves.toEqual({ acknowledged: 0, count: 0 });
      const [afterInactiveInstitutionAcknowledgement] = await db
        .select({ read: notifications.read })
        .from(notifications)
        .where(eq(notifications.id, visibleB));
      expect(afterInactiveInstitutionAcknowledgement.read).toBe(false);
    } finally {
      await db
        .update(institutions)
        .set({ isActive: true })
        .where(eq(institutions.id, institutionBId));
    }

    await expect(
      callerFor(
        accountUserId,
        currentSessionVersion,
        institutionBId,
      ).notifications.acknowledgeAccountBadge(),
    ).resolves.toEqual({ acknowledged: 1, count: 0 });

    const rows = await db
      .select({ id: notifications.id, read: notifications.read })
      .from(notifications)
      .where(
        inArray(notifications.id, [
          visibleA,
          visibleB,
          internalOutbox,
          dutySyncOutbox,
          legacyOutbox,
          wrongRecipient,
          stringMarker,
          booleanMarker,
          nullMarker,
          stringRecipient,
          fractionalRecipient,
          unsupportedType,
          queued,
          submitting,
          ticketAccepted,
          receiptChecking,
          otherAccount,
        ]),
      );
    const readById = new Map(rows.map((row) => [row.id, row.read]));
    expect(readById.get(visibleA)).toBe(true);
    expect(readById.get(visibleB)).toBe(true);
    expect(readById.get(internalOutbox)).toBe(false);
    expect(readById.get(dutySyncOutbox)).toBe(false);
    expect(readById.get(legacyOutbox)).toBe(false);
    expect(readById.get(wrongRecipient)).toBe(false);
    expect(readById.get(stringMarker)).toBe(false);
    expect(readById.get(booleanMarker)).toBe(false);
    expect(readById.get(nullMarker)).toBe(false);
    expect(readById.get(stringRecipient)).toBe(false);
    expect(readById.get(fractionalRecipient)).toBe(false);
    expect(readById.get(unsupportedType)).toBe(false);
    expect(readById.get(queued)).toBe(false);
    expect(readById.get(submitting)).toBe(false);
    expect(readById.get(ticketAccepted)).toBe(true);
    expect(readById.get(receiptChecking)).toBe(true);
    expect(readById.get(otherAccount)).toBe(false);

    // O app pode reconhecer o alerta enquanto o Expo ainda aguarda receipt.
    // Quando a mesma row transita para SENT, read=true permanece e ela não
    // ressurge no badge após o retorno ao background.
    await db
      .update(notifications)
      .set({
        status: "SENT",
        providerReceipt: trackedReceipt("vacancy_available", accountUserId, {
          phase: "PROVIDER_ACCEPTED",
        }),
      })
      .where(eq(notifications.id, ticketAccepted));
    await expect(
      callerFor(
        accountUserId,
        currentSessionVersion,
        institutionAId,
      ).notifications.getUnreadAccountBadgeCount(),
    ).resolves.toEqual({ count: 0 });
    await expect(
      callerFor(
        otherUserId,
        currentSessionVersion,
        institutionAId,
      ).notifications.getUnreadAccountBadgeCount(),
    ).resolves.toEqual({ count: 1 });
  });

  it("reconhece sem esperar o Expo e sincroniza todos os tokens iOS autorizados", async () => {
    await insertNotification({
      institutionId: institutionAId,
      userId: accountUserId,
      dedupSuffix: "authorized-ios-tokens-ack",
      providerReceipt: trackedReceipt("vacancy_available", accountUserId),
    });
    const firstToken = `ExponentPushToken[badge-a-${stamp}]`;
    const secondToken = `ExponentPushToken[badge-b-${stamp}]`;
    await db.insert(pushTokens).values([
      {
        institutionId: institutionAId,
        userId: accountUserId,
        token: firstToken,
        platform: "ios",
      },
      {
        institutionId: institutionBId,
        userId: accountUserId,
        token: secondToken,
        platform: "ios",
      },
    ]);

    let signalFirstFetch!: () => void;
    const firstFetchStarted = new Promise<void>((resolve) => {
      signalFirstFetch = resolve;
    });
    let releaseFirstFetch!: () => void;
    const firstFetchRelease = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        signalFirstFetch();
        await firstFetchRelease;
        return response(200, {
          data: { status: "ok", id: "badge-zero-first" },
        });
      })
      .mockResolvedValue(
        response(200, {
          data: { status: "ok", id: "badge-zero-second" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const acknowledgement = callerFor(
      accountUserId,
      currentSessionVersion,
      institutionAId,
    ).notifications.acknowledgeAccountBadge();

    try {
      await firstFetchStarted;
      await expect(acknowledgement).resolves.toEqual({
        acknowledged: 1,
        count: 0,
      });

      releaseFirstFetch();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      const bodies = fetchMock.mock.calls.map((call) =>
        JSON.parse(String((call[1] as RequestInit).body)) as {
          to: string;
          badge: number;
          title?: unknown;
          body?: unknown;
        },
      );
      expect(new Set(bodies.map((body) => body.to))).toEqual(
        new Set([firstToken, secondToken]),
      );
      expect(bodies.every((body) => body.badge === 0)).toBe(true);
      expect(bodies.every((body) => !("title" in body) && !("body" in body))).toBe(true);
    } finally {
      releaseFirstFetch();
      vi.unstubAllGlobals();
      await db.delete(pushTokens).where(
        inArray(pushTokens.token, [firstToken, secondToken]),
      );
    }
  });

  it("espera a revogação concorrente e preserva a notificação do vínculo removido", async () => {
    const visibleA = await insertNotification({
      institutionId: institutionAId,
      userId: accountUserId,
      dedupSuffix: "concurrent-visible-a",
      providerReceipt: trackedReceipt("vacancy_available", accountUserId),
    });
    const visibleB = await insertNotification({
      institutionId: institutionBId,
      userId: accountUserId,
      dedupSuffix: "concurrent-visible-b",
      providerReceipt: trackedReceipt("swap_offer", accountUserId),
    });

    let reportRevocationLocked!: () => void;
    const revocationLocked = new Promise<void>((resolve) => {
      reportRevocationLocked = resolve;
    });
    let releaseRevocation!: () => void;
    const holdRevocation = new Promise<void>((resolve) => {
      releaseRevocation = resolve;
    });
    const revocation = db.transaction(async (tx) => {
      await tx
        .select({ id: professionalInstitutions.id })
        .from(professionalInstitutions)
        .where(
          and(
            eq(professionalInstitutions.userId, accountUserId),
            eq(professionalInstitutions.institutionId, institutionBId),
          ),
        )
        .limit(1)
        .for("update");
      await tx
        .update(professionalInstitutions)
        .set({ active: false })
        .where(
          and(
            eq(professionalInstitutions.userId, accountUserId),
            eq(professionalInstitutions.institutionId, institutionBId),
          ),
        );
      reportRevocationLocked();
      await holdRevocation;
    });

    try {
      await revocationLocked;
      const acknowledgement = callerFor(
        accountUserId,
        currentSessionVersion,
        institutionAId,
      ).notifications.acknowledgeAccountBadge();

      await waitForBadgeAcknowledgementLockWaiter(db, accountUserId);
      releaseRevocation();
      await revocation;

      await expect(acknowledgement).resolves.toEqual({
        acknowledged: 1,
        count: 0,
      });
      const rows = await db
        .select({ id: notifications.id, read: notifications.read })
        .from(notifications)
        .where(inArray(notifications.id, [visibleA, visibleB]));
      const readById = new Map(rows.map((row) => [row.id, row.read]));
      expect(readById.get(visibleA)).toBe(true);
      expect(readById.get(visibleB)).toBe(false);
    } finally {
      releaseRevocation();
      await revocation.catch(() => undefined);
      await db
        .update(professionalInstitutions)
        .set({ active: true })
        .where(
          and(
            eq(professionalInstitutions.userId, accountUserId),
            eq(professionalInstitutions.institutionId, institutionBId),
          ),
        );
    }
  });
});
