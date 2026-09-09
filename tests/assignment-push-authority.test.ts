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
import { and, eq } from "drizzle-orm";
import {
  hospitals,
  institutions,
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
import {
  enqueueShiftAssignedPush,
  enqueueShiftUnassignedPush,
} from "../server/assignment-push-signal";
import { getDb } from "../server/db";
import {
  enqueueTrackedPushNotification,
  processPendingPushDeliveries,
} from "../server/push-delivery";
import { drainAccountWideNativeBadgeSnapshotDispatches } from "../server/notifications-service";

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

describe("autoridade atual no outbox de alocação", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionId: number;
  let hospitalAId: number;
  let hospitalBId: number;
  let sectorAId: number;
  let sectorBId: number;
  let userId: number;
  let professionalId: number;
  let accessAId: number;
  let accessBId: number;
  let shiftId: number;
  let assignmentId: number;
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
        name: `Assignment authority ${stamp}`,
        cnpj: `${stamp}`.slice(-14).padStart(14, "0"),
        legalName: `Assignment authority ${stamp}`,
        tradeName: `ASG${stamp}`.slice(0, 20),
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

    const [user] = await db
      .insert(users)
      .values({
        name: `Assignment user ${stamp}`,
        email: `assignment-authority-${stamp}@test.local`,
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
        name: `Assignment professional ${stamp}`,
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

    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        label: `Assignment shift ${stamp}`,
        startAt: new Date("2032-09-12T10:00:00.000Z"),
        endAt: new Date("2032-09-12T16:00:00.000Z"),
        status: "OCUPADO",
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
        professionalId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
        createdBy: userId,
      })
      .$returningId();
    assignmentId = assignment.id;
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () =>
      response(200, {
        data: { status: "ok", id: `assignment-ticket-${crypto.randomUUID()}` },
      }),
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await db.delete(notifications).where(eq(notifications.userId, userId));
    await db.delete(pushTokens).where(eq(pushTokens.userId, userId));
    await db.insert(pushTokens).values({
      institutionId,
      userId,
      token: `ExponentPushToken[assignment-authority-${stamp}]`,
      platform: "ios",
    });
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
      .update(shiftAssignmentsV2)
      .set({ status: "OCUPADO", isActive: true })
      .where(eq(shiftAssignmentsV2.id, assignmentId));
    await db
      .update(shiftInstances)
      .set({ status: "OCUPADO" })
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
      .where(eq(shiftAssignmentsV2.id, assignmentId));
    await db.delete(shiftInstances).where(eq(shiftInstances.id, shiftId));
    await db
      .delete(professionalAccess)
      .where(eq(professionalAccess.professionalId, professionalId));
    await db
      .delete(professionalInstitutions)
      .where(eq(professionalInstitutions.professionalId, professionalId));
    await db.delete(professionals).where(eq(professionals.id, professionalId));
    await db.delete(users).where(eq(users.id, userId));
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
    };
  }

  function operationalMessage(type: string): Record<string, unknown> | null {
    for (const [, options] of fetchMock.mock.calls) {
      const raw = (options as RequestInit | undefined)?.body;
      if (typeof raw !== "string") continue;
      const body = JSON.parse(raw) as Record<string, unknown>;
      const data = body.data as Record<string, unknown> | undefined;
      if (data?.type === type) return body;
    }
    return null;
  }

  async function processQueued(): Promise<void> {
    await processPendingPushDeliveries(new Date(Date.now() + 1_000));
    await drainAccountWideNativeBadgeSnapshotDispatches();
  }

  it("exibe hospital e setor canônicos ao profissional alocado", async () => {
    await enqueueShiftAssignedPush({
      db,
      assignmentId,
      professionalId,
      shift: shiftInput(),
    });
    await db
      .update(hospitals)
      .set({ name: `Hospital canônico ${stamp}` })
      .where(eq(hospitals.id, hospitalAId));
    await db
      .update(sectors)
      .set({ name: `Setor canônico ${stamp}` })
      .where(eq(sectors.id, sectorAId));

    await processQueued();

    expect(operationalMessage("shift_assigned")).toMatchObject({
      title: `Hospital canônico ${stamp} · Setor canônico ${stamp}`,
      body: "Você foi escalado para o plantão de 12/09/2032, 07:00–13:00.",
    });
  });

  it("não usa acesso de hospital irmão como fallback do mesmo tenant", async () => {
    await enqueueShiftAssignedPush({
      db,
      assignmentId,
      professionalId,
      shift: shiftInput(),
    });
    await db
      .update(professionalAccess)
      .set({ canAccess: false })
      .where(eq(professionalAccess.id, accessAId));
    await db
      .update(professionalAccess)
      .set({ canAccess: true })
      .where(eq(professionalAccess.id, accessBId));

    await processQueued();

    expect(operationalMessage("shift_assigned")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    const [row] = await db
      .select({
        status: notifications.status,
        receipt: notifications.providerReceipt,
      })
      .from(notifications)
      .where(
        eq(
          notifications.dedupKey,
          `shift-assigned:${shiftId}:${professionalId}:${assignmentId}`,
        ),
      );
    expect(row.status).toBe("FAILED");
    expect(row.receipt).toMatchObject({
      phase: "FAILED",
      evidence: { reason: "RECIPIENT_AUTHORITY_REVOKED" },
    });
  });

  it("suprime alocação que ficou obsoleta antes do envio", async () => {
    await enqueueShiftAssignedPush({
      db,
      assignmentId,
      professionalId,
      shift: shiftInput(),
    });
    await db
      .update(shiftAssignmentsV2)
      .set({ isActive: false })
      .where(eq(shiftAssignmentsV2.id, assignmentId));

    await processQueued();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("suprime alocação quando a tupla ativa do profissional ficou duplicada", async () => {
    await enqueueShiftAssignedPush({
      db,
      assignmentId,
      professionalId,
      shift: shiftInput(),
    });
    const [duplicate] = await db
      .insert(shiftAssignmentsV2)
      .values({
        institutionId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        shiftInstanceId: shiftId,
        professionalId,
        assignmentType: "ON_DUTY",
        status: "PENDENTE",
        isActive: true,
        createdBy: userId,
      })
      .$returningId();

    try {
      await processQueued();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await db
        .delete(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.id, duplicate.id));
    }
  });

  it("suprime alocação quando o turno persistido deixou de estar ocupado", async () => {
    await enqueueShiftAssignedPush({
      db,
      assignmentId,
      professionalId,
      shift: shiftInput(),
    });
    await db
      .update(shiftInstances)
      .set({ status: "VAGO" })
      .where(eq(shiftInstances.id, shiftId));

    await processQueued();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("informa retirada somente enquanto a alocação permanece inativa", async () => {
    await db
      .update(shiftAssignmentsV2)
      .set({ isActive: false })
      .where(eq(shiftAssignmentsV2.id, assignmentId));
    await enqueueShiftUnassignedPush({
      db,
      assignmentId,
      professionalId,
      shift: shiftInput(),
    });

    await processQueued();

    expect(operationalMessage("shift_unassigned")).toMatchObject({
      title: `Hospital A ${stamp} · Setor A ${stamp}`,
      body: "Sua alocação no plantão de 12/09/2032, 07:00–13:00 foi retirada.",
    });
  });

  it("suprime retirada que foi revertida antes do envio", async () => {
    await db
      .update(shiftAssignmentsV2)
      .set({ isActive: false })
      .where(eq(shiftAssignmentsV2.id, assignmentId));
    await enqueueShiftUnassignedPush({
      db,
      assignmentId,
      professionalId,
      shift: shiftInput(),
    });
    await db
      .update(shiftAssignmentsV2)
      .set({ isActive: true })
      .where(eq(shiftAssignmentsV2.id, assignmentId));

    await processQueued();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("suprime retirada quando uma nova alocação ocupada substitui a linha histórica", async () => {
    await db
      .update(shiftAssignmentsV2)
      .set({ isActive: false })
      .where(eq(shiftAssignmentsV2.id, assignmentId));
    await enqueueShiftUnassignedPush({
      db,
      assignmentId,
      professionalId,
      shift: shiftInput(),
    });
    const [replacement] = await db
      .insert(shiftAssignmentsV2)
      .values({
        institutionId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        shiftInstanceId: shiftId,
        professionalId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
        createdBy: userId,
      })
      .$returningId();

    try {
      await processQueued();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await db
        .delete(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.id, replacement.id));
    }
  });

  it("recusa payload de alocação sem autoridade tipada", async () => {
    await expect(
      enqueueTrackedPushNotification({
        institutionId,
        userId,
        shiftInstanceId: shiftId,
        dedupKey: `assignment-without-authority:${stamp}`,
        payload: {
          title: "Texto do produtor",
          body: "Texto do produtor",
          data: {
            type: "shift_assigned",
            institutionId,
            hospitalId: hospitalAId,
            sectorId: sectorAId,
            shiftInstanceId: shiftId,
            assignmentId,
            professionalId,
          },
        },
      }),
    ).rejects.toThrow("Push rastreado exige autoridade canonica");
  });
});
