import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  hospitals,
  institutions,
  managerScope,
  notifications,
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
  sendTrackedPushNotification,
  type TrackedPushInput,
} from "../server/push-delivery";
import { listResponsibleVacancyManagerUserIds } from "../server/vacancy-request-push-authority";

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

describe("autoridade atual no outbox de solicitação de vaga", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionId: number;
  let otherInstitutionId: number;
  let hospitalAId: number;
  let hospitalBId: number;
  let sectorAId: number;
  let sectorSiblingAId: number;
  let sectorBId: number;
  let requesterUserId: number;
  let requesterProfessionalId: number;
  let managerAUserId: number;
  let managerAProfessionalId: number;
  let managerBUserId: number;
  let managerBProfessionalId: number;
  let managerAScopeId: number;
  let hospitalManagerUserId: number;
  let hospitalManagerProfessionalId: number;
  let gestorPlusUserId: number;
  let adminUserId: number;
  const extraUserIds: number[] = [];
  const extraProfessionalIds: number[] = [];
  const ineligibleManagerUserIds: number[] = [];
  let shiftId: number;
  let assignmentId: number;
  const stamp = Date.now();
  const now = new Date("2033-09-02T12:00:00.000Z");
  const fetchMock = vi.fn();

  beforeAll(async () => {
    const connection = await getDb();
    if (!connection) throw new Error("Database unavailable");
    db = connection;

    const [institution] = await db
      .insert(institutions)
      .values({
        name: `Vacancy authority ${stamp}`,
        cnpj: `${stamp}`.slice(-14).padStart(14, "0"),
        legalName: `Vacancy authority ${stamp}`,
        tradeName: `VAC${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = institution.id;
    const [otherInstitution] = await db
      .insert(institutions)
      .values({
        name: `Vacancy authority other ${stamp}`,
        cnpj: `${stamp + 1}`.slice(-14).padStart(14, "0"),
        legalName: `Vacancy authority other ${stamp}`,
        tradeName: `VAO${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    otherInstitutionId = otherInstitution.id;
    const [hospitalA] = await db
      .insert(hospitals)
      .values({
        institutionId,
        name: `Hospital A ${stamp}`,
      })
      .$returningId();
    const [hospitalB] = await db
      .insert(hospitals)
      .values({
        institutionId,
        name: `Hospital B ${stamp}`,
      })
      .$returningId();
    hospitalAId = hospitalA.id;
    hospitalBId = hospitalB.id;
    const [sectorA] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId: hospitalAId,
        name: `Setor A ${stamp}`,
        category: "servico",
        color: "#2563EB",
      })
      .$returningId();
    const [sectorB] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId: hospitalBId,
        name: `Setor B ${stamp}`,
        category: "servico",
        color: "#2563EB",
      })
      .$returningId();
    const [sectorSiblingA] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId: hospitalAId,
        name: `Setor irmão A ${stamp}`,
        category: "servico",
        color: "#2563EB",
      })
      .$returningId();
    sectorAId = sectorA.id;
    sectorSiblingAId = sectorSiblingA.id;
    sectorBId = sectorB.id;

    async function createProfessional(
      suffix: string,
      roleInInstitution: "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS",
      options: {
        targetInstitutionId?: number;
        globalRole?: "admin" | "manager" | "doctor";
        approvalStatus?: "APPROVED" | "PENDING";
        deletedAt?: Date | null;
        active?: boolean;
      } = {},
    ) {
      const targetInstitutionId =
        options.targetInstitutionId ?? institutionId;
      const [user] = await db
        .insert(users)
        .values({
          name: `${suffix} ${stamp}`,
          email: `${suffix}-${stamp}@test.local`,
          passwordHash: "test",
          role:
            options.globalRole ??
            (roleInInstitution === "USER" ? "doctor" : "manager"),
          approvalStatus: options.approvalStatus ?? "APPROVED",
          deletedAt: options.deletedAt ?? null,
        })
        .$returningId();
      const [professional] = await db
        .insert(professionals)
        .values({
          userId: user.id,
          name: `${suffix} ${stamp}`,
          role: roleInInstitution === "USER" ? "MEDICO" : "Gestor",
          userRole: roleInInstitution,
        })
        .$returningId();
      await db.insert(professionalInstitutions).values({
        institutionId: targetInstitutionId,
        professionalId: professional.id,
        userId: user.id,
        roleInInstitution,
        active: options.active ?? true,
      });
      return { userId: user.id, professionalId: professional.id };
    }

    const requester = await createProfessional("requester", "USER");
    requesterUserId = requester.userId;
    requesterProfessionalId = requester.professionalId;
    const managerA = await createProfessional("manager-a", "GESTOR_MEDICO");
    managerAUserId = managerA.userId;
    managerAProfessionalId = managerA.professionalId;
    const managerB = await createProfessional("manager-b", "GESTOR_MEDICO");
    managerBUserId = managerB.userId;
    managerBProfessionalId = managerB.professionalId;

    const hospitalManager = await createProfessional(
      "manager-hospital",
      "GESTOR_MEDICO",
    );
    hospitalManagerUserId = hospitalManager.userId;
    hospitalManagerProfessionalId = hospitalManager.professionalId;
    const gestorPlus = await createProfessional("gestor-plus", "GESTOR_PLUS");
    gestorPlusUserId = gestorPlus.userId;
    const admin = await createProfessional("admin", "USER", {
      globalRole: "admin",
    });
    adminUserId = admin.userId;

    for (const actor of [hospitalManager, gestorPlus, admin]) {
      extraUserIds.push(actor.userId);
      extraProfessionalIds.push(actor.professionalId);
    }
    for (const actor of [
      await createProfessional("gestor-plus-other", "GESTOR_PLUS", {
        targetInstitutionId: otherInstitutionId,
      }),
      await createProfessional("admin-other", "USER", {
        targetInstitutionId: otherInstitutionId,
        globalRole: "admin",
      }),
      await createProfessional("gestor-plus-inactive", "GESTOR_PLUS", {
        active: false,
      }),
      await createProfessional("admin-inactive", "USER", {
        globalRole: "admin",
        active: false,
      }),
      await createProfessional("gestor-plus-pending", "GESTOR_PLUS", {
        approvalStatus: "PENDING",
      }),
      await createProfessional("admin-deleted", "USER", {
        globalRole: "admin",
        deletedAt: new Date("2032-01-01T00:00:00.000Z"),
      }),
    ]) {
      extraUserIds.push(actor.userId);
      extraProfessionalIds.push(actor.professionalId);
      ineligibleManagerUserIds.push(actor.userId);
    }

    const [scopeA] = await db
      .insert(managerScope)
      .values({
        institutionId,
        managerProfessionalId: managerAProfessionalId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        active: true,
      })
      .$returningId();
    managerAScopeId = scopeA.id;
    await db.insert(managerScope).values({
      institutionId,
      managerProfessionalId: managerBProfessionalId,
      hospitalId: hospitalBId,
      sectorId: sectorBId,
      active: true,
    });
    await db.insert(managerScope).values({
      institutionId,
      managerProfessionalId: hospitalManagerProfessionalId,
      hospitalId: hospitalAId,
      sectorId: null,
      active: true,
    });
    await db.insert(managerScope).values({
      institutionId,
      managerProfessionalId: managerBProfessionalId,
      hospitalId: hospitalAId,
      sectorId: sectorSiblingAId,
      active: true,
    });

    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        label: `Vacancy shift ${stamp}`,
        startAt: new Date("2033-09-02T13:00:00.000Z"),
        endAt: new Date("2033-09-02T19:00:00.000Z"),
        status: "DISPONIVEL",
      })
      .$returningId();
    shiftId = shift.id;
    const [assignment] = await db
      .insert(shiftAssignmentsV2)
      .values({
        institutionId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        shiftInstanceId: shiftId,
        professionalId: requesterProfessionalId,
        assignmentType: "ON_DUTY",
        status: "PENDENTE",
        isActive: true,
        createdBy: requesterUserId,
      })
      .$returningId();
    assignmentId = assignment.id;

    await db.insert(pushTokens).values([
      {
        institutionId,
        userId: requesterUserId,
        token: `ExponentPushToken[vacancy-requester-${stamp}]`,
        platform: "ios",
      },
      {
        institutionId,
        userId: managerAUserId,
        token: `ExponentPushToken[vacancy-manager-a-${stamp}]`,
        platform: "ios",
      },
      {
        institutionId,
        userId: managerBUserId,
        token: `ExponentPushToken[vacancy-manager-b-${stamp}]`,
        platform: "ios",
      },
      {
        institutionId,
        userId: hospitalManagerUserId,
        token: `ExponentPushToken[vacancy-manager-hospital-${stamp}]`,
        platform: "ios",
      },
      {
        institutionId,
        userId: gestorPlusUserId,
        token: `ExponentPushToken[vacancy-gestor-plus-${stamp}]`,
        platform: "ios",
      },
      {
        institutionId,
        userId: adminUserId,
        token: `ExponentPushToken[vacancy-admin-${stamp}]`,
        platform: "ios",
      },
    ]);
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await db
      .delete(notifications)
      .where(
        inArray(notifications.userId, [
          requesterUserId,
          managerAUserId,
          managerBUserId,
          ...extraUserIds,
        ]),
      );
    await db
      .update(managerScope)
      .set({ active: true })
      .where(eq(managerScope.id, managerAScopeId));
    await db
      .update(professionalInstitutions)
      .set({ active: true })
      .where(
        and(
          eq(professionalInstitutions.professionalId, requesterProfessionalId),
          eq(professionalInstitutions.institutionId, institutionId),
        ),
      );
    await db
      .update(shiftAssignmentsV2)
      .set({
        status: "PENDENTE",
        isActive: true,
      })
      .where(eq(shiftAssignmentsV2.id, assignmentId));
  });

  function intent(
    purpose:
      | "MANAGER_ACTION_REQUIRED"
      | "REQUEST_APPROVED"
      | "REQUEST_REJECTED",
    userId: number,
    suffix: string,
  ): TrackedPushInput {
    const manager = purpose === "MANAGER_ACTION_REQUIRED";
    const payloadType = manager
      ? "vacancy_request_created"
      : purpose === "REQUEST_APPROVED"
        ? "vacancy_request_approved"
        : "vacancy_request_rejected";
    return {
      institutionId,
      userId,
      shiftInstanceId: shiftId,
      dedupKey: `vacancy-authority:${stamp}:${suffix}`,
      deepLink: manager ? "/(tabs)/pending" : `/shift-details?id=${shiftId}`,
      authority: {
        kind: "VACANCY_REQUEST",
        purpose,
        assignmentId,
        expectedUserId: userId,
        institutionId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        shiftInstanceId: shiftId,
      },
      payload: {
        title: "Vacancy authority",
        body: "Vacancy authority",
        data: {
          type: payloadType,
          institutionId,
          hospitalId: hospitalAId,
          sectorId: sectorAId,
          shiftInstanceId: shiftId,
          assignmentId,
        },
      },
    };
  }

  it("inclui apenas gestores canônicos do tenant e da topologia", async () => {
    const recipients = await listResponsibleVacancyManagerUserIds(db, {
      institutionId,
      hospitalId: hospitalAId,
      sectorId: sectorAId,
    });
    expect(recipients).toEqual(
      [
        managerAUserId,
        hospitalManagerUserId,
        gestorPlusUserId,
        adminUserId,
      ].sort((left, right) => left - right),
    );
    for (const userId of ineligibleManagerUserIds) {
      expect(recipients).not.toContain(userId);
    }
  });

  it("escopo hospitalar cobre setores irmãos sem somar escopo setorial", async () => {
    await expect(
      listResponsibleVacancyManagerUserIds(db, {
        institutionId,
        hospitalId: hospitalAId,
        sectorId: sectorSiblingAId,
      }),
    ).resolves.toEqual(
      [
        managerBUserId,
        hospitalManagerUserId,
        gestorPlusUserId,
        adminUserId,
      ].sort((left, right) => left - right),
    );
  });

  it("revalida Gestor+ e admin ativos no tenant antes do Expo", async () => {
    fetchMock
      .mockResolvedValueOnce(
        response(200, { data: { status: "ok", id: `plus-${stamp}` } }),
      )
      .mockResolvedValueOnce(
        response(200, { data: { status: "ok", id: `admin-${stamp}` } }),
      );

    for (const [userId, suffix] of [
      [gestorPlusUserId, "gestor-plus"],
      [adminUserId, "admin"],
    ] as const) {
      await expect(
        sendTrackedPushNotification(
          intent("MANAGER_ACTION_REQUIRED", userId, suffix),
          now,
        ),
      ).resolves.toMatchObject({
        status: "PENDING",
        phase: "TICKET_ACCEPTED",
        ticketAccepted: true,
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bloqueia Gestor+ e admin revogados depois do enqueue", async () => {
    const plusPush = intent(
      "MANAGER_ACTION_REQUIRED",
      gestorPlusUserId,
      "gestor-plus-revoked",
    );
    const adminPush = intent(
      "MANAGER_ACTION_REQUIRED",
      adminUserId,
      "admin-revoked",
    );
    await enqueueTrackedPushNotification(plusPush, now);
    await enqueueTrackedPushNotification(adminPush, now);
    await db
      .update(professionalInstitutions)
      .set({ active: false })
      .where(
        and(
          eq(professionalInstitutions.institutionId, institutionId),
          eq(professionalInstitutions.userId, gestorPlusUserId),
        ),
      );
    await db
      .update(users)
      .set({ approvalStatus: "PENDING" })
      .where(eq(users.id, adminUserId));

    try {
      await expect(
        sendTrackedPushNotification(plusPush, now),
      ).resolves.toMatchObject({ status: "FAILED" });
      await expect(
        sendTrackedPushNotification(adminPush, now),
      ).resolves.toMatchObject({ status: "FAILED" });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await db
        .update(professionalInstitutions)
        .set({ active: true })
        .where(
          and(
            eq(professionalInstitutions.institutionId, institutionId),
            eq(professionalInstitutions.userId, gestorPlusUserId),
          ),
        );
      await db
        .update(users)
        .set({ approvalStatus: "APPROVED" })
        .where(eq(users.id, adminUserId));
    }
  });

  it("revogação do escopo após o enqueue impede o envio ao gestor", async () => {
    const push = intent(
      "MANAGER_ACTION_REQUIRED",
      managerAUserId,
      "revoked-scope",
    );
    const queued = await enqueueTrackedPushNotification(push, now);
    await db
      .update(managerScope)
      .set({ active: false })
      .where(eq(managerScope.id, managerAScopeId));

    const result = await sendTrackedPushNotification(push, now);

    expect(result.notificationId).toBe(queued.notificationId);
    expect(result.status).toBe("FAILED");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("decisão válida chega ao solicitante e vínculo revogado bloqueia retry", async () => {
    await db
      .update(shiftAssignmentsV2)
      .set({
        status: "OCUPADO",
        isActive: true,
      })
      .where(eq(shiftAssignmentsV2.id, assignmentId));
    const valid = intent("REQUEST_APPROVED", requesterUserId, "approved");
    fetchMock.mockResolvedValueOnce(
      response(200, { data: { status: "ok", id: `vacancy-ticket-${stamp}` } }),
    );
    await expect(
      sendTrackedPushNotification(valid, now),
    ).resolves.toMatchObject({
      status: "PENDING",
      phase: "TICKET_ACCEPTED",
      ticketAccepted: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();

    fetchMock.mockClear();
    const revoked = intent("REQUEST_APPROVED", requesterUserId, "revoked-pi");
    await enqueueTrackedPushNotification(revoked, now);
    await db
      .update(professionalInstitutions)
      .set({ active: false })
      .where(
        and(
          eq(professionalInstitutions.professionalId, requesterProfessionalId),
          eq(professionalInstitutions.institutionId, institutionId),
        ),
      );
    await expect(
      sendTrackedPushNotification(revoked, now),
    ).resolves.toMatchObject({
      status: "FAILED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejeição válida preserva autoridade com alocação inativa", async () => {
    await db
      .update(shiftAssignmentsV2)
      .set({
        status: "REJEITADO",
        isActive: false,
      })
      .where(eq(shiftAssignmentsV2.id, assignmentId));
    const rejected = intent(
      "REQUEST_REJECTED",
      requesterUserId,
      "rejected",
    );
    fetchMock.mockResolvedValueOnce(
      response(200, { data: { status: "ok", id: `rejected-${stamp}` } }),
    );

    await expect(
      sendTrackedPushNotification(rejected, now),
    ).resolves.toMatchObject({
      status: "PENDING",
      phase: "TICKET_ACCEPTED",
      ticketAccepted: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("dedup concorrente preserva uma única intenção", async () => {
    const push = intent("MANAGER_ACTION_REQUIRED", managerAUserId, "dedup");
    const [first, second] = await Promise.all([
      enqueueTrackedPushNotification(push, now),
      enqueueTrackedPushNotification(push, now),
    ]);
    expect(second.notificationId).toBe(first.notificationId);
    const rows = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.dedupKey, push.dedupKey));
    expect(rows).toHaveLength(1);
  });

  afterAll(async () => {
    const userIds = [
      requesterUserId,
      managerAUserId,
      managerBUserId,
      ...extraUserIds,
    ];
    const professionalIds = [
      requesterProfessionalId,
      managerAProfessionalId,
      managerBProfessionalId,
      ...extraProfessionalIds,
    ];
    await db
      .delete(notifications)
      .where(inArray(notifications.userId, userIds));
    await db.delete(pushTokens).where(inArray(pushTokens.userId, userIds));
    await db
      .delete(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.id, assignmentId));
    await db.delete(shiftInstances).where(eq(shiftInstances.id, shiftId));
    await db
      .delete(managerScope)
      .where(inArray(managerScope.managerProfessionalId, professionalIds));
    await db
      .delete(professionalInstitutions)
      .where(inArray(professionalInstitutions.professionalId, professionalIds));
    await db
      .delete(professionals)
      .where(inArray(professionals.id, professionalIds));
    await db.delete(users).where(inArray(users.id, userIds));
    await db
      .delete(sectors)
      .where(inArray(sectors.id, [sectorAId, sectorSiblingAId, sectorBId]));
    await db
      .delete(hospitals)
      .where(inArray(hospitals.id, [hospitalAId, hospitalBId]));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    await db
      .delete(institutions)
      .where(eq(institutions.id, otherInstitutionId));
  });
});
