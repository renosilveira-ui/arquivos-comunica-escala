import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeJwt, generateKeyPair } from "jose";
import { and, eq, inArray } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { TRPCError } from "@trpc/server";
import {
  dutyConfirmations,
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
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import {
  enqueueTrackedPushNotification,
  sendTrackedPushNotification,
} from "../server/push-delivery";
import { triggerAutoSso } from "../server/sso/auto-sso";
import {
  enqueueDutySync as enqueueRawDutySync,
  processPendingDutySyncs,
  syncDutyToComunica,
} from "../server/sso/duty-sync";

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
  hasMappingFor: vi.fn(() => true),
  getComunicaOrgId: vi.fn(() => orgMappingState.organizationId),
}));
vi.mock("../server/sso/keys", () => ({
  getPrivateKey: vi.fn(async () => keyState.privateKey),
  KID: "confirmation-boundaries-test",
  ALG: "RS256",
}));

describe("fronteiras profundas de confirmação", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionAId: number;
  let institutionBId: number;
  let hospitalAId: number;
  let hospitalBId: number;
  let sectorAId: number;
  let sectorBId: number;
  let shiftId: number;
  let withdrawShiftId: number;
  let originalAssignmentId: number;
  let replacementAssignmentId: number;
  let secondaryOriginalAssignmentId: number;
  let poisonedAssignmentId: number;
  let originalUserId: number;
  let replacementUserId: number;
  let pendingReplacementUserId: number;
  let foreignUserId: number;
  let originalProfessionalId: number;
  let replacementProfessionalId: number;
  let pendingReplacementProfessionalId: number;
  let foreignProfessionalId: number;
  let validConfirmationId: number;
  let poisonedConfirmationId: number;
  let activeOriginalConfirmationId: number;
  let mismatchedTypeConfirmationId: number;
  let pendingStatusConfirmationId: number;
  let withdrawConfirmationId: number;
  const userIds: number[] = [];
  const professionalIds: number[] = [];
  const runId = randomUUID().replaceAll("-", "");
  const pushMock = vi.mocked(sendTrackedPushNotification);
  const enqueuePushMock = vi.mocked(enqueueTrackedPushNotification);
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 204,
    text: async () => "",
  }));

  function hashIdempotencyKey(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  async function enqueueDutySync(
    input: Parameters<typeof enqueueRawDutySync>[0] & Record<string, unknown>,
    ...rest: [Date?, Parameters<typeof enqueueRawDutySync>[2]?]
  ) {
    return enqueueRawDutySync({
      ...input,
      confirmationStatus: input.expectedStatuses.includes(input.confirmationStatus as never)
        ? input.confirmationStatus
        : input.expectedStatuses[0],
      dutyType: input.dutyType ?? "PLANTAO",
    }, ...rest);
  }

  function primaryShiftSnapshot() {
    return {
      institutionId: institutionAId,
      hospitalId: hospitalAId,
      sectorId: sectorAId,
      label: "Boundary duty",
      startAt: "2031-01-10T10:00:00.000Z",
      endAt: "2031-01-10T16:00:00.000Z",
    };
  }

  function withdrawShiftSnapshot() {
    return {
      institutionId: institutionAId,
      hospitalId: hospitalAId,
      sectorId: sectorAId,
      label: "Boundary withdrawn duty",
      startAt: "2031-01-11T10:00:00.000Z",
      endAt: "2031-01-11T16:00:00.000Z",
    };
  }

  function confirmBinding() {
    const idempotencyKey = `boundary:${runId}:direct-confirm:${validConfirmationId}`;
    return {
      expectedExternalSubject: `confirmation-boundary-replacement-${runId}@test.local`,
      expectedShiftSnapshot: primaryShiftSnapshot(),
      expectedTargetUserId: replacementUserId,
      expectedInstitutionId: institutionAId,
      expectedShiftInstanceId: shiftId,
      expectedOrganizationId: orgMappingState.organizationId!,
      idempotencyKey,
      idempotencyKeySha256: hashIdempotencyKey(idempotencyKey),
      sourceSequence: validConfirmationId,
      confirmationStatus: "REPLACEMENT_CONFIRMED" as const,
      dutyType: "PLANTAO" as const,
    };
  }

  function withdrawBinding() {
    const idempotencyKey = `boundary:${runId}:direct-withdraw:${withdrawConfirmationId}`;
    return {
      expectedExternalSubject: `confirmation-boundary-original-${runId}@test.local`,
      expectedShiftSnapshot: withdrawShiftSnapshot(),
      expectedTargetUserId: originalUserId,
      expectedInstitutionId: institutionAId,
      expectedShiftInstanceId: withdrawShiftId,
      expectedOrganizationId: orgMappingState.organizationId!,
      idempotencyKey,
      idempotencyKeySha256: hashIdempotencyKey(idempotencyKey),
      sourceSequence: withdrawConfirmationId,
      confirmationStatus: "DECLINED" as const,
      dutyType: "PLANTAO" as const,
    };
  }

  function confirmIntentBinding() {
    return {
      externalSubject: `confirmation-boundary-replacement-${runId}@test.local`,
      shiftSnapshot: primaryShiftSnapshot(),
      confirmationStatus: "REPLACEMENT_CONFIRMED" as const,
      dutyType: "PLANTAO" as const,
    };
  }

  async function createNaturalKeyConfirmationPair() {
    const notifiedAt = new Date();
    const rows = await db
      .insert(dutyConfirmations)
      .values([
        {
          institutionId: institutionAId,
          shiftInstanceId: shiftId,
          assignmentId: replacementAssignmentId,
          professionalId: replacementProfessionalId,
          userId: replacementUserId,
          status: "DECLINED" as const,
          notifiedAt,
          confirmationToken: randomUUID(),
        },
        {
          institutionId: institutionAId,
          shiftInstanceId: shiftId,
          assignmentId: secondaryOriginalAssignmentId,
          professionalId: pendingReplacementProfessionalId,
          userId: pendingReplacementUserId,
          status: "REPLACEMENT_CONFIRMED" as const,
          replacementProfessionalId,
          replacementUserId,
          notifiedAt,
          confirmationToken: randomUUID(),
        },
      ])
      .$returningId();
    return {
      predecessorConfirmationId: rows[0].id,
      successorConfirmationId: rows[1].id,
    };
  }

  async function person(tag: string, institutionId: number) {
    const email = `confirmation-boundary-${tag}-${runId}@test.local`;
    const [user] = await db
      .insert(users)
      .values({ name: `Boundary ${tag}`, email, passwordHash: "test", role: "doctor" })
      .$returningId();
    const [professional] = await db
      .insert(professionals)
      .values({ userId: user.id, name: `Boundary ${tag}`, role: "Médico", userRole: "USER" })
      .$returningId();
    await db.insert(professionalInstitutions).values({
      professionalId: professional.id,
      userId: user.id,
      institutionId,
      roleInInstitution: "USER",
      isPrimary: true,
      active: true,
    });
    userIds.push(user.id);
    professionalIds.push(professional.id);
    return { userId: user.id, professionalId: professional.id, email };
  }

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;
    const { privateKey } = await generateKeyPair("RS256", { modulusLength: 2048 });
    keyState.privateKey = privateKey;

    const suffix = BigInt(`0x${runId.slice(0, 12)}`).toString().slice(-12).padStart(12, "0");
    const [institutionA] = await db
      .insert(institutions)
      .values({
        name: `Boundary A ${runId}`,
        cnpj: `${suffix}11`,
        legalName: `Boundary A ${runId}`,
        tradeName: `BA${runId}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionAId = institutionA.id;
    const [institutionB] = await db
      .insert(institutions)
      .values({
        name: `Boundary B ${runId}`,
        cnpj: `${suffix}12`,
        legalName: `Boundary B ${runId}`,
        tradeName: `BB${runId}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionBId = institutionB.id;
    const [hospital] = await db
      .insert(hospitals)
      .values({ institutionId: institutionAId, name: `Boundary Hospital ${runId}` })
      .$returningId();
    hospitalAId = hospital.id;
    const [hospitalB] = await db
      .insert(hospitals)
      .values({ institutionId: institutionBId, name: `Boundary Hospital B ${runId}` })
      .$returningId();
    hospitalBId = hospitalB.id;
    const [sector] = await db
      .insert(sectors)
      .values({
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        name: `Boundary Sector ${runId}`,
        category: "cirurgico",
        color: "#2563EB",
      })
      .$returningId();
    sectorAId = sector.id;
    const [sectorB] = await db
      .insert(sectors)
      .values({
        institutionId: institutionBId,
        hospitalId: hospitalBId,
        name: `Boundary Sector B ${runId}`,
        category: "cirurgico",
        color: "#16A34A",
      })
      .$returningId();
    sectorBId = sectorB.id;

    const original = await person("original", institutionAId);
    originalUserId = original.userId;
    originalProfessionalId = original.professionalId;
    const replacement = await person("replacement", institutionAId);
    replacementUserId = replacement.userId;
    replacementProfessionalId = replacement.professionalId;
    const pendingReplacement = await person("pending-replacement", institutionAId);
    pendingReplacementUserId = pendingReplacement.userId;
    pendingReplacementProfessionalId = pendingReplacement.professionalId;
    const foreign = await person("foreign", institutionBId);
    foreignUserId = foreign.userId;
    foreignProfessionalId = foreign.professionalId;
    const [poisonLinkUser] = await db
      .insert(users)
      .values({
        name: "Boundary poison link",
        email: `confirmation-boundary-poison-link-${runId}@test.local`,
        passwordHash: "test",
        role: "doctor",
      })
      .$returningId();
    userIds.push(poisonLinkUser.id);
    await db.insert(professionalInstitutions).values({
      professionalId: foreignProfessionalId,
      userId: poisonLinkUser.id,
      institutionId: institutionAId,
      roleInInstitution: "USER",
      isPrimary: false,
      active: true,
    });
    await db.insert(professionalAccess).values([
      {
        institutionId: institutionAId,
        professionalId: originalProfessionalId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        canAccess: true,
      },
      {
        institutionId: institutionAId,
        professionalId: replacementProfessionalId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        canAccess: true,
      },
      {
        institutionId: institutionAId,
        professionalId: pendingReplacementProfessionalId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        canAccess: true,
      },
    ]);
    await db.insert(monthlyRosters).values({
      institutionId: institutionAId,
      hospitalId: hospitalAId,
      yearMonth: "2031-01",
      status: "PUBLISHED",
    });

    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        label: "Boundary duty",
        startAt: new Date("2031-01-10T07:00:00-03:00"),
        endAt: new Date("2031-01-10T13:00:00-03:00"),
        status: "OCUPADO",
      })
      .$returningId();
    shiftId = shift.id;
    const assignments = await db
      .insert(shiftAssignmentsV2)
      .values([
        {
          shiftInstanceId: shiftId,
          institutionId: institutionAId,
          hospitalId: hospitalAId,
          sectorId: sectorAId,
          professionalId: originalProfessionalId,
          assignmentType: "ON_DUTY",
          status: "OCUPADO",
          isActive: false,
        },
        {
          shiftInstanceId: shiftId,
          institutionId: institutionAId,
          hospitalId: hospitalAId,
          sectorId: sectorAId,
          professionalId: replacementProfessionalId,
          assignmentType: "ON_DUTY",
          status: "OCUPADO",
          isActive: true,
        },
        {
          shiftInstanceId: shiftId,
          institutionId: institutionAId,
          hospitalId: hospitalAId,
          sectorId: sectorAId,
          professionalId: pendingReplacementProfessionalId,
          assignmentType: "ON_DUTY",
          status: "OCUPADO",
          isActive: false,
        },
        {
          shiftInstanceId: shiftId,
          institutionId: institutionAId,
          hospitalId: hospitalAId,
          sectorId: sectorAId,
          professionalId: originalProfessionalId,
          assignmentType: "ON_DUTY",
          status: "OCUPADO",
          isActive: false,
        },
        {
          shiftInstanceId: shiftId,
          institutionId: institutionAId,
          hospitalId: hospitalAId,
          sectorId: sectorAId,
          professionalId: pendingReplacementProfessionalId,
          assignmentType: "ON_DUTY",
          status: "PENDENTE",
          isActive: true,
        },
        {
          shiftInstanceId: shiftId,
          institutionId: institutionAId,
          hospitalId: hospitalAId,
          sectorId: sectorAId,
          professionalId: originalProfessionalId,
          assignmentType: "ON_DUTY",
          status: "OCUPADO",
          isActive: true,
        },
        {
          shiftInstanceId: shiftId,
          institutionId: institutionAId,
          hospitalId: hospitalAId,
          sectorId: sectorAId,
          professionalId: originalProfessionalId,
          assignmentType: "BACKUP",
          status: "OCUPADO",
          isActive: false,
        },
        {
          shiftInstanceId: shiftId,
          institutionId: institutionAId,
          hospitalId: hospitalAId,
          sectorId: sectorAId,
          professionalId: foreignProfessionalId,
          assignmentType: "BACKUP",
          status: "OCUPADO",
          isActive: true,
        },
        // Três assignments efetivas adversariais: cada uma diverge em
        // exatamente uma dimensão. Assim, cada predicado da tupla do
        // substituto é necessário para manter o sink fechado.
        {
          shiftInstanceId: shiftId,
          institutionId: institutionBId,
          hospitalId: hospitalAId,
          sectorId: sectorAId,
          professionalId: pendingReplacementProfessionalId,
          assignmentType: "ON_DUTY",
          status: "OCUPADO",
          isActive: true,
        },
        {
          shiftInstanceId: shiftId,
          institutionId: institutionAId,
          hospitalId: hospitalBId,
          sectorId: sectorAId,
          professionalId: pendingReplacementProfessionalId,
          assignmentType: "ON_DUTY",
          status: "OCUPADO",
          isActive: true,
        },
        {
          shiftInstanceId: shiftId,
          institutionId: institutionAId,
          hospitalId: hospitalAId,
          sectorId: sectorBId,
          professionalId: pendingReplacementProfessionalId,
          assignmentType: "ON_DUTY",
          status: "OCUPADO",
          isActive: true,
        },
      ])
      .$returningId();
    originalAssignmentId = assignments[0].id;
    replacementAssignmentId = assignments[1].id;
    secondaryOriginalAssignmentId = assignments[2].id;
    poisonedAssignmentId = assignments[7].id;

    const confirmations = await db
      .insert(dutyConfirmations)
      .values([
        {
          institutionId: institutionAId,
          shiftInstanceId: shiftId,
          assignmentId: originalAssignmentId,
          professionalId: originalProfessionalId,
          userId: originalUserId,
          status: "REPLACEMENT_CONFIRMED",
          replacementProfessionalId,
          replacementUserId,
          notifiedAt: new Date(),
          confirmationToken: randomUUID(),
        },
        {
          institutionId: institutionAId,
          shiftInstanceId: shiftId,
          assignmentId: poisonedAssignmentId,
          professionalId: foreignProfessionalId,
          userId: foreignUserId,
          status: "CONFIRMED",
          notifiedAt: new Date(),
          confirmationToken: randomUUID(),
        },
        {
          institutionId: institutionAId,
          shiftInstanceId: shiftId,
          assignmentId: assignments[5].id,
          professionalId: originalProfessionalId,
          userId: originalUserId,
          status: "REPLACEMENT_CONFIRMED",
          replacementProfessionalId,
          replacementUserId,
          notifiedAt: new Date(),
          confirmationToken: randomUUID(),
        },
        {
          institutionId: institutionAId,
          shiftInstanceId: shiftId,
          assignmentId: assignments[6].id,
          professionalId: originalProfessionalId,
          userId: originalUserId,
          status: "REPLACEMENT_CONFIRMED",
          replacementProfessionalId,
          replacementUserId,
          notifiedAt: new Date(),
          confirmationToken: randomUUID(),
        },
        {
          institutionId: institutionAId,
          shiftInstanceId: shiftId,
          assignmentId: assignments[3].id,
          professionalId: originalProfessionalId,
          userId: originalUserId,
          status: "REPLACEMENT_CONFIRMED",
          replacementProfessionalId: pendingReplacementProfessionalId,
          replacementUserId: pendingReplacementUserId,
          notifiedAt: new Date(),
          confirmationToken: randomUUID(),
        },
      ])
      .$returningId();
    validConfirmationId = confirmations[0].id;
    poisonedConfirmationId = confirmations[1].id;
    activeOriginalConfirmationId = confirmations[2].id;
    mismatchedTypeConfirmationId = confirmations[3].id;
    pendingStatusConfirmationId = confirmations[4].id;

    const [withdrawShift] = await db
      .insert(shiftInstances)
      .values({
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        label: "Boundary withdrawn duty",
        startAt: new Date("2031-01-11T07:00:00-03:00"),
        endAt: new Date("2031-01-11T13:00:00-03:00"),
        status: "OCUPADO",
      })
      .$returningId();
    withdrawShiftId = withdrawShift.id;
    const [withdrawAssignment] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId: withdrawShiftId,
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        professionalId: originalProfessionalId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
      })
      .$returningId();
    await db.insert(shiftAssignmentsV2).values({
      shiftInstanceId: withdrawShiftId,
      institutionId: institutionAId,
      hospitalId: hospitalAId,
      sectorId: sectorAId,
      professionalId: pendingReplacementProfessionalId,
      assignmentType: "ON_DUTY",
      status: "OCUPADO",
      isActive: true,
    });
    const [withdrawConfirmation] = await db
      .insert(dutyConfirmations)
      .values({
        institutionId: institutionAId,
        shiftInstanceId: withdrawShiftId,
        assignmentId: withdrawAssignment.id,
        professionalId: originalProfessionalId,
        userId: originalUserId,
        status: "DECLINED",
        notifiedAt: new Date(),
        confirmationToken: randomUUID(),
      })
      .$returningId();
    withdrawConfirmationId = withdrawConfirmation.id;
  });

  beforeEach(() => {
    orgMappingState.organizationId = "00000000-0000-4000-8000-000000000001";
    pushMock.mockClear();
    enqueuePushMock.mockClear();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 204,
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.delete(notifications).where(
      inArray(notifications.institutionId, [institutionAId, institutionBId]),
    );
    await db.delete(dutyConfirmations).where(inArray(dutyConfirmations.id, [
      validConfirmationId,
      poisonedConfirmationId,
      activeOriginalConfirmationId,
      mismatchedTypeConfirmationId,
      pendingStatusConfirmationId,
      withdrawConfirmationId,
    ]));
    await db
      .delete(shiftAssignmentsV2)
      .where(inArray(shiftAssignmentsV2.shiftInstanceId, [shiftId, withdrawShiftId]));
    await db.delete(shiftInstances).where(inArray(shiftInstances.id, [shiftId, withdrawShiftId]));
    await db.delete(professionalAccess).where(inArray(professionalAccess.professionalId, professionalIds));
    await db.delete(professionalInstitutions).where(inArray(professionalInstitutions.professionalId, professionalIds));
    await db.delete(professionals).where(inArray(professionals.id, professionalIds));
    await db.delete(monthlyRosters).where(eq(monthlyRosters.institutionId, institutionAId));
    await db.delete(sectors).where(inArray(sectors.id, [sectorAId, sectorBId]));
    await db.delete(hospitals).where(inArray(hospitals.id, [hospitalAId, hospitalBId]));
    await db.delete(institutions).where(inArray(institutions.id, [institutionAId, institutionBId]));
    await db.delete(users).where(inArray(users.id, userIds));
  });

  it("suprime push e sync quando o profissional não pertence ao tenant da confirmação", async () => {
    const rejectedIds = [
      poisonedConfirmationId,
      activeOriginalConfirmationId,
      mismatchedTypeConfirmationId,
      pendingStatusConfirmationId,
    ];
    for (const confirmationId of rejectedIds) {
      await expect(triggerAutoSso(confirmationId)).resolves.toMatchObject({ ok: false });
      await expect(
        syncDutyToComunica(confirmationId, "CONFIRM", confirmBinding()),
      ).resolves.toMatchObject({ ok: false });
    }
    expect(pushMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    const after = await db
      .select({ ssoTriggeredAt: dutyConfirmations.ssoTriggeredAt })
      .from(dutyConfirmations)
      .where(inArray(dutyConfirmations.id, rejectedIds));
    expect(after.every((row) => row.ssoTriggeredAt === null)).toBe(true);
  });

  it.each([
    {
      label: "rejeição canônica",
      failure: new TRPCError({ code: "BAD_REQUEST", message: "canonical sentinel" }),
      retryable: false,
      expectedError: "Autoridade canônica do duty-sync revogada",
    },
    {
      label: "falha genérica Drizzle",
      failure: new DrizzleQueryError(
        "select users where external_subject = ?",
        ["DRIZZLE_DUTY_EXTERNAL_SUBJECT_SENTINEL"],
        new Error("DRIZZLE_DUTY_EXTERNAL_SUBJECT_SENTINEL"),
      ),
      retryable: true,
      expectedError: "Duty-sync temporariamente indisponível",
    },
  ])("duty-sync distingue $label antes da rede", async ({
    failure,
    retryable,
    expectedError,
  }) => {
    const transactionSpy = vi
      .spyOn(db as any, "transaction")
      .mockImplementationOnce(async (callback: any) => callback({
        select: () => { throw failure; },
      }));

    let result: Awaited<ReturnType<typeof syncDutyToComunica>>;
    try {
      result = await syncDutyToComunica(validConfirmationId, "CONFIRM", confirmBinding());
    } finally {
      transactionSpy.mockRestore();
    }

    expect(result).toEqual({ ok: false, error: expectedError, retryable });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("DRIZZLE_DUTY_EXTERNAL_SUBJECT_SENTINEL");
    expect(JSON.stringify(result)).not.toContain("canonical sentinel");
  });

  it("suprime auto-SSO e duty-sync quando o mês volta a uma sabotagem DRAFT", async () => {
    await db
      .update(monthlyRosters)
      .set({ status: "DRAFT" })
      .where(
        and(
          eq(monthlyRosters.institutionId, institutionAId),
          eq(monthlyRosters.hospitalId, hospitalAId),
          eq(monthlyRosters.yearMonth, "2031-01"),
        ),
      );
    try {
      await expect(triggerAutoSso(validConfirmationId)).resolves.toMatchObject({ ok: false });
      await expect(syncDutyToComunica(
        validConfirmationId,
        "CONFIRM",
        confirmBinding(),
      )).resolves.toMatchObject({
        ok: false,
      });
      expect(pushMock).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await db
        .update(monthlyRosters)
        .set({ status: "PUBLISHED" })
        .where(
          and(
            eq(monthlyRosters.institutionId, institutionAId),
            eq(monthlyRosters.hospitalId, hospitalAId),
            eq(monthlyRosters.yearMonth, "2031-01"),
          ),
        );
    }
  });

  it.each([
    "javascript:alert(1)",
    "http://comunica.example",
    "https://localhost",
  ])("duty-sync bloqueia destino externo invalido antes da rede (%s)", async (target) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SSO_TARGET_URL", target);
    try {
      await expect(syncDutyToComunica(
        validConfirmationId,
        "CONFIRM",
        confirmBinding(),
      )).resolves.toMatchObject({ ok: false, retryable: true });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it.each([
    "http://comunica.example",
    "https://localhost",
    "https://user:secret@comunica.example",
    "https://comunica.example/exchange?tenant=1",
  ])("auto-SSO suprime sso_ready e outbox quando o destino é inválido (%s)", async (target) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SSO_TARGET_URL", target);
    try {
      await expect(triggerAutoSso(validConfirmationId)).resolves.toMatchObject({ ok: false });
      expect(enqueuePushMock).not.toHaveBeenCalled();
      expect(pushMock).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("revalida identidade, vínculo e acesso atuais do substituto antes de emitir", async () => {
    const expectSuppressed = async () => {
      await expect(triggerAutoSso(validConfirmationId)).resolves.toMatchObject({ ok: false });
      await expect(syncDutyToComunica(
        validConfirmationId,
        "CONFIRM",
        confirmBinding(),
      )).resolves.toMatchObject({
        ok: false,
      });
      expect(pushMock).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    };

    await db
      .update(professionalInstitutions)
      .set({ userId: foreignUserId })
      .where(eq(professionalInstitutions.professionalId, replacementProfessionalId));
    try {
      await expectSuppressed();
    } finally {
      await db
        .update(professionalInstitutions)
        .set({ userId: replacementUserId })
        .where(eq(professionalInstitutions.professionalId, replacementProfessionalId));
    }

    await db
      .update(professionalInstitutions)
      .set({ active: false })
      .where(eq(professionalInstitutions.professionalId, replacementProfessionalId));
    try {
      await expectSuppressed();
    } finally {
      await db
        .update(professionalInstitutions)
        .set({ active: true })
        .where(eq(professionalInstitutions.professionalId, replacementProfessionalId));
    }

    await db
      .update(professionalAccess)
      .set({ canAccess: false })
      .where(eq(professionalAccess.professionalId, replacementProfessionalId));
    try {
      await expectSuppressed();
    } finally {
      await db
        .update(professionalAccess)
        .set({ canAccess: true })
        .where(eq(professionalAccess.professionalId, replacementProfessionalId));
    }
  });

  it("usa o substituto efetivamente alocado nos dois limites externos", async () => {
    await db
      .update(professionalInstitutions)
      .set({ active: false })
      .where(
        inArray(professionalInstitutions.professionalId, [originalProfessionalId]),
      );
    try {
      await expect(triggerAutoSso(validConfirmationId)).resolves.toEqual({ ok: true });
      expect(pushMock).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: replacementUserId,
          payload: expect.objectContaining({
            data: expect.objectContaining({ shiftInstanceId: shiftId }),
          }),
          authority: expect.objectContaining({
            kind: "DUTY_CONFIRMATION",
            purpose: "SSO_READY",
            confirmationId: validConfirmationId,
            allowedStatuses: ["CONFIRMED", "REPLACEMENT_CONFIRMED"],
            recipientKind: "EFFECTIVE",
            expectedUserId: replacementUserId,
            shiftSnapshot: primaryShiftSnapshot(),
          }),
        }),
        expect.any(Date),
      );

      await expect(syncDutyToComunica(
        validConfirmationId,
        "CONFIRM",
        confirmBinding(),
      )).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const request = fetchMock.mock.calls[0][1] as RequestInit;
      const authorization = (request.headers as Record<string, string>).Authorization;
      const claims = decodeJwt(authorization.replace("Bearer ", ""));
      expect(claims.email).toBe(`confirmation-boundary-replacement-${runId}@test.local`);
      expect(claims.sub).toBe(claims.email);
    } finally {
      await db
        .update(professionalInstitutions)
        .set({ active: true })
        .where(
          inArray(professionalInstitutions.professionalId, [originalProfessionalId]),
        );
    }
  });

  it("não mantém locks de confirmação enquanto o Comunica+ está lento", async () => {
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
      return { ok: true, status: 204, text: async () => "" };
    });

    const sync = syncDutyToComunica(
      validConfirmationId,
      "CONFIRM",
      confirmBinding(),
    );
    await fetchStarted;
    const competingLock = db.transaction(async (tx) => {
      await tx
        .select({ id: dutyConfirmations.id })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.id, validConfirmationId))
        .limit(1)
        .for("update");
    });
    const lockCompletedBeforeFetch = await Promise.race([
      competingLock.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    releaseFetch();
    await competingLock;
    await expect(sync).resolves.toEqual({ ok: true });
    expect(lockCompletedBeforeFetch).toBe(true);
  });

  it("cada claim duty-sync recebe lease completo no instante real em que começa", async () => {
    const scanNow = new Date("2033-06-10T10:00:00.000Z");
    let wallNow = scanNow.getTime();
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => wallNow);
    const notificationIds: number[] = [];
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstResponse = new Promise<{ ok: boolean; status: number; text: () => Promise<string> }>(
      (resolve) => {
        releaseFirst = () => resolve({ ok: true, status: 204, text: async () => "" });
      },
    );
    const secondResponse = new Promise<{ ok: boolean; status: number; text: () => Promise<string> }>(
      (resolve) => {
        releaseSecond = () => resolve({ ok: true, status: 204, text: async () => "" });
      },
    );
    let workerA: Promise<number> | null = null;

    try {
      notificationIds.push(await enqueueDutySync({
        ...confirmIntentBinding(),
        confirmationId: validConfirmationId,
        institutionId: institutionAId,
        shiftInstanceId: shiftId,
        targetUserId: replacementUserId,
        action: "CONFIRM",
        expectedStatuses: ["REPLACEMENT_CONFIRMED"],
        dedupKey: `boundary:${runId}:duty-sync:late-claim-first`,
      }, scanNow));
      notificationIds.push(await enqueueDutySync({
        externalSubject: `confirmation-boundary-original-${runId}@test.local`,
        shiftSnapshot: withdrawShiftSnapshot(),
        confirmationId: withdrawConfirmationId,
        institutionId: institutionAId,
        shiftInstanceId: withdrawShiftId,
        targetUserId: originalUserId,
        action: "WITHDRAW",
        expectedStatuses: ["DECLINED"],
        dedupKey: `boundary:${runId}:duty-sync:late-claim-second`,
      }, scanNow));
      fetchMock
        .mockImplementationOnce(() => firstResponse)
        .mockImplementationOnce(() => secondResponse)
        .mockResolvedValue({ ok: true, status: 204, text: async () => "" });

      workerA = processPendingDutySyncs(scanNow, { concurrency: 1 });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      wallNow += 20_000;
      releaseFirst();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      const [secondClaim] = await db
        .select({ providerReceipt: notifications.providerReceipt })
        .from(notifications)
        .where(eq(notifications.id, notificationIds[1]));
      expect(secondClaim.providerReceipt).toMatchObject({ phase: "PROCESSING" });
      const leaseUntil = new Date(
        (secondClaim.providerReceipt as { leaseUntil: string }).leaseUntil,
      ).getTime();
      expect(leaseUntil - wallNow).toBeGreaterThanOrEqual(30_000);

      // Com o lease herdado do scan, este worker roubaria a segunda linha
      // enquanto o primeiro owner ainda está no fetch.
      await expect(
        processPendingDutySyncs(new Date(wallNow + 11_000), { concurrency: 1 }),
      ).resolves.toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      releaseSecond();
      await expect(workerA).resolves.toBe(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      releaseFirst();
      releaseSecond();
      await workerA?.catch(() => undefined);
      nowSpy.mockRestore();
      if (notificationIds.length > 0) {
        await db.delete(notifications).where(inArray(notifications.id, notificationIds));
      }
    }
  });

  it("assina WITHDRAW real para o titular recusado", async () => {
    await expect(syncDutyToComunica(
      withdrawConfirmationId,
      "WITHDRAW",
      withdrawBinding(),
    )).resolves.toEqual({
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const authorization = (request.headers as Record<string, string>).Authorization;
    const claims = decodeJwt(authorization.replace("Bearer ", ""));
    expect(claims.action).toBe("WITHDRAW");
    expect(claims.email).toBe(`confirmation-boundary-original-${runId}@test.local`);
    expect(claims.sub).toBe(claims.email);
  });

  it("WITHDRAW continua removendo o roster após revogação do titular", async () => {
    await db
      .update(professionalInstitutions)
      .set({ active: false })
      .where(eq(professionalInstitutions.professionalId, originalProfessionalId));
    try {
      await expect(
        syncDutyToComunica(withdrawConfirmationId, "WITHDRAW", {
          ...withdrawBinding(),
          expectedStatuses: ["DECLINED"],
          expectedTargetUserId: originalUserId,
          idempotencyKey: `boundary:${runId}:withdraw-revoked`,
          idempotencyKeySha256: hashIdempotencyKey(
            `boundary:${runId}:withdraw-revoked`,
          ),
        }),
      ).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const request = fetchMock.mock.calls[0][1] as RequestInit;
      expect((request.headers as Record<string, string>)["Idempotency-Key"])
        .toBe(`boundary:${runId}:withdraw-revoked`);
    } finally {
      await db
        .update(professionalInstitutions)
        .set({ active: true })
        .where(eq(professionalInstitutions.professionalId, originalProfessionalId));
    }
  });

  it("WITHDRAW continua removendo o roster após exclusão física do vínculo", async () => {
    await db
      .delete(professionalInstitutions)
      .where(eq(professionalInstitutions.professionalId, originalProfessionalId));
    try {
      await expect(
        syncDutyToComunica(withdrawConfirmationId, "WITHDRAW", {
          ...withdrawBinding(),
          expectedStatuses: ["DECLINED"],
          expectedTargetUserId: originalUserId,
          idempotencyKey: `boundary:${runId}:withdraw-membership-deleted`,
          idempotencyKeySha256: hashIdempotencyKey(
            `boundary:${runId}:withdraw-membership-deleted`,
          ),
        }),
      ).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await db.insert(professionalInstitutions).values({
        professionalId: originalProfessionalId,
        userId: originalUserId,
        institutionId: institutionAId,
        roleInInstitution: "USER",
        isPrimary: true,
        active: true,
      });
    }
  });

  it("duty-sync retenta com idempotency key estável e fecha em SENT", async () => {
    const now = new Date("2033-06-10T10:00:00.000Z");
    const dedupKey = `boundary:${runId}:duty-sync:retry-success`;
    const notificationId = await enqueueDutySync({
      ...confirmIntentBinding(),
      confirmationId: validConfirmationId,
      institutionId: institutionAId,
      shiftInstanceId: shiftId,
      targetUserId: replacementUserId,
      action: "CONFIRM",
      expectedStatuses: ["REPLACEMENT_CONFIRMED"],
      dedupKey,
    }, now);
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => "temporarily unavailable",
      })
      .mockResolvedValueOnce({ ok: true, status: 204, text: async () => "" });

    await expect(processPendingDutySyncs(now)).resolves.toBeGreaterThanOrEqual(1);
    await expect(
      processPendingDutySyncs(new Date(now.getTime() + 60_000)),
    ).resolves.toBeGreaterThanOrEqual(1);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstHeaders = fetchMock.mock.calls[0][1]?.headers as Record<string, string>;
    const secondHeaders = fetchMock.mock.calls[1][1]?.headers as Record<string, string>;
    expect(firstHeaders["Idempotency-Key"]).toBe(dedupKey);
    expect(secondHeaders["Idempotency-Key"]).toBe(dedupKey);
    const [stored] = await db
      .select({ status: notifications.status, providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(eq(notifications.id, notificationId));
    expect(stored.status).toBe("SENT");
    expect(stored.providerReceipt).toMatchObject({ phase: "SENT", attemptCount: 2 });
  });

  it("bloqueia sucessor devido enquanto predecessor causal está em backoff", async () => {
    const now = new Date("2033-06-10T10:01:00.000Z");
    const predecessorDueAt = new Date(now.getTime() + 5 * 60_000);
    const predecessorDedupKey = `boundary:${runId}:duty-sync:causal-future-withdraw`;
    const successorDedupKey = `boundary:${runId}:duty-sync:causal-future-confirm`;
    const predecessorId = await enqueueDutySync({
      externalSubject: `confirmation-boundary-original-${runId}@test.local`,
      shiftSnapshot: primaryShiftSnapshot(),
      confirmationId: validConfirmationId,
      institutionId: institutionAId,
      shiftInstanceId: shiftId,
      targetUserId: originalUserId,
      action: "WITHDRAW",
      expectedStatuses: ["REPLACEMENT_CONFIRMED"],
      dedupKey: predecessorDedupKey,
    }, predecessorDueAt);
    const successorId = await enqueueDutySync({
      ...confirmIntentBinding(),
      confirmationId: validConfirmationId,
      institutionId: institutionAId,
      shiftInstanceId: shiftId,
      targetUserId: replacementUserId,
      action: "CONFIRM",
      expectedStatuses: ["REPLACEMENT_CONFIRMED"],
      dedupKey: successorDedupKey,
    }, now);

    try {
      await processPendingDutySyncs(now);
      expect(fetchMock).not.toHaveBeenCalled();

      await processPendingDutySyncs(predecessorDueAt);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>)["Idempotency-Key"])
        .toBe(predecessorDedupKey);

      const [successorWhilePredecessorRan] = await db
        .select({ status: notifications.status })
        .from(notifications)
        .where(eq(notifications.id, successorId));
      expect(successorWhilePredecessorRan.status).toBe("PENDING");

      await processPendingDutySyncs(predecessorDueAt);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>)["Idempotency-Key"])
        .toBe(successorDedupKey);
      const terminalRows = await db
        .select({ id: notifications.id, status: notifications.status })
        .from(notifications)
        .where(inArray(notifications.id, [predecessorId, successorId]));
      expect(terminalRows.map((row) => row.status)).toEqual(["SENT", "SENT"]);
    } finally {
      await db.delete(notifications).where(inArray(notifications.id, [predecessorId, successorId]));
    }
  });

  it("worker concorrente não ultrapassa predecessor já claimed/SUBMITTING", async () => {
    const now = new Date("2033-06-10T10:02:00.000Z");
    const predecessorDedupKey = `boundary:${runId}:duty-sync:causal-claimed-withdraw`;
    const successorDedupKey = `boundary:${runId}:duty-sync:causal-claimed-confirm`;
    const predecessorId = await enqueueDutySync({
      externalSubject: `confirmation-boundary-original-${runId}@test.local`,
      shiftSnapshot: primaryShiftSnapshot(),
      confirmationId: validConfirmationId,
      institutionId: institutionAId,
      shiftInstanceId: shiftId,
      targetUserId: originalUserId,
      action: "WITHDRAW",
      expectedStatuses: ["REPLACEMENT_CONFIRMED"],
      dedupKey: predecessorDedupKey,
    }, now);
    const successorId = await enqueueDutySync({
      ...confirmIntentBinding(),
      confirmationId: validConfirmationId,
      institutionId: institutionAId,
      shiftInstanceId: shiftId,
      targetUserId: replacementUserId,
      action: "CONFIRM",
      expectedStatuses: ["REPLACEMENT_CONFIRMED"],
      dedupKey: successorDedupKey,
    }, now);
    let releasePredecessor!: () => void;
    const heldResponse = new Promise<{ ok: boolean; status: number; text: () => Promise<string> }>(
      (resolve) => {
        releasePredecessor = () => resolve({
          ok: true,
          status: 204,
          text: async () => "",
        });
      },
    );
    fetchMock
      .mockImplementationOnce(() => heldResponse)
      .mockResolvedValue({ ok: true, status: 204, text: async () => "" });
    let workerA: Promise<number> | null = null;

    try {
      workerA = processPendingDutySyncs(now);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const [claimedPredecessor] = await db
        .select({ providerReceipt: notifications.providerReceipt })
        .from(notifications)
        .where(eq(notifications.id, predecessorId));
      expect(claimedPredecessor.providerReceipt).toMatchObject({ phase: "PROCESSING" });

      await expect(processPendingDutySyncs(now)).resolves.toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [successorWhileClaimed] = await db
        .select({ status: notifications.status })
        .from(notifications)
        .where(eq(notifications.id, successorId));
      expect(successorWhileClaimed.status).toBe("PENDING");

      releasePredecessor();
      await workerA;
      await processPendingDutySyncs(now);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>)["Idempotency-Key"])
        .toBe(successorDedupKey);
    } finally {
      releasePredecessor();
      try {
        await workerA;
      } finally {
        await db.delete(notifications).where(inArray(notifications.id, [predecessorId, successorId]));
      }
    }
  });

  it("serializa confirmações distintas pela chave externa e mantém chaves diferentes vivas", async () => {
    const now = new Date("2033-06-10T10:02:10.000Z");
    const retryAt = new Date(now.getTime() + 60_000);
    const {
      predecessorConfirmationId,
      successorConfirmationId,
    } = await createNaturalKeyConfirmationPair();
    const predecessorDedupKey =
      `boundary:${runId}:duty-sync:natural-key-backoff-withdraw`;
    const successorDedupKey =
      `boundary:${runId}:duty-sync:natural-key-backoff-confirm`;
    const independentDedupKey =
      `boundary:${runId}:duty-sync:natural-key-independent`;
    const notificationIds: number[] = [];

    try {
      notificationIds.push(await enqueueDutySync({
        ...confirmIntentBinding(),
        externalSubject: confirmIntentBinding().externalSubject.toUpperCase(),
        confirmationId: predecessorConfirmationId,
        institutionId: institutionAId,
        shiftInstanceId: shiftId,
        targetUserId: replacementUserId,
        action: "WITHDRAW",
        expectedStatuses: ["DECLINED"],
        dedupKey: predecessorDedupKey,
      }, now));
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => "temporarily unavailable",
      });
      await processPendingDutySyncs(now);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      notificationIds.push(await enqueueDutySync({
        ...confirmIntentBinding(),
        confirmationId: successorConfirmationId,
        institutionId: institutionAId,
        shiftInstanceId: shiftId,
        targetUserId: replacementUserId,
        action: "CONFIRM",
        expectedStatuses: ["REPLACEMENT_CONFIRMED"],
        dedupKey: successorDedupKey,
      }, now));
      const [canonicalPredecessor] = await db
        .select({ providerReceipt: notifications.providerReceipt })
        .from(notifications)
        .where(eq(notifications.id, notificationIds[0]));
      expect(canonicalPredecessor.providerReceipt).toMatchObject({
        externalSubject: confirmIntentBinding().externalSubject,
      });
      notificationIds.push(await enqueueDutySync({
        externalSubject: `confirmation-boundary-original-${runId}@test.local`,
        shiftSnapshot: withdrawShiftSnapshot(),
        confirmationId: withdrawConfirmationId,
        institutionId: institutionAId,
        shiftInstanceId: withdrawShiftId,
        targetUserId: originalUserId,
        action: "WITHDRAW",
        expectedStatuses: ["DECLINED"],
        dedupKey: independentDedupKey,
      }, now));

      // O sucessor da mesma identidade externa fica cercado pelo backoff,
      // mas outra identidade operacional continua avançando.
      await processPendingDutySyncs(now);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>)["Idempotency-Key"])
        .toBe(independentDedupKey);
      const [blockedSuccessor] = await db
        .select({ status: notifications.status })
        .from(notifications)
        .where(eq(notifications.id, notificationIds[1]));
      expect(blockedSuccessor.status).toBe("PENDING");

      await processPendingDutySyncs(retryAt);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect((fetchMock.mock.calls[2]?.[1]?.headers as Record<string, string>)["Idempotency-Key"])
        .toBe(predecessorDedupKey);
      await processPendingDutySyncs(retryAt);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect((fetchMock.mock.calls[3]?.[1]?.headers as Record<string, string>)["Idempotency-Key"])
        .toBe(successorDedupKey);
    } finally {
      if (notificationIds.length > 0) {
        await db.delete(notifications).where(inArray(notifications.id, notificationIds));
      }
      await db.delete(dutyConfirmations).where(inArray(dutyConfirmations.id, [
        predecessorConfirmationId,
        successorConfirmationId,
      ]));
    }
  });

  it("worker concorrente não ultrapassa predecessor de outra confirmationId na mesma chave externa", async () => {
    const now = new Date("2033-06-10T10:02:20.000Z");
    const {
      predecessorConfirmationId,
      successorConfirmationId,
    } = await createNaturalKeyConfirmationPair();
    const predecessorDedupKey =
      `boundary:${runId}:duty-sync:natural-key-claimed-withdraw`;
    const successorDedupKey =
      `boundary:${runId}:duty-sync:natural-key-claimed-confirm`;
    const notificationIds: number[] = [];
    let releasePredecessor!: () => void;
    const heldResponse = new Promise<{ ok: boolean; status: number; text: () => Promise<string> }>(
      (resolve) => {
        releasePredecessor = () => resolve({
          ok: true,
          status: 204,
          text: async () => "",
        });
      },
    );
    let workerA: Promise<number> | null = null;

    try {
      notificationIds.push(await enqueueDutySync({
        ...confirmIntentBinding(),
        confirmationId: predecessorConfirmationId,
        institutionId: institutionAId,
        shiftInstanceId: shiftId,
        targetUserId: replacementUserId,
        action: "WITHDRAW",
        expectedStatuses: ["DECLINED"],
        dedupKey: predecessorDedupKey,
      }, now));
      notificationIds.push(await enqueueDutySync({
        ...confirmIntentBinding(),
        confirmationId: successorConfirmationId,
        institutionId: institutionAId,
        shiftInstanceId: shiftId,
        targetUserId: replacementUserId,
        action: "CONFIRM",
        expectedStatuses: ["REPLACEMENT_CONFIRMED"],
        dedupKey: successorDedupKey,
      }, now));
      fetchMock
        .mockImplementationOnce(() => heldResponse)
        .mockResolvedValue({ ok: true, status: 204, text: async () => "" });

      workerA = processPendingDutySyncs(now);
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      const [claimedPredecessor] = await db
        .select({ providerReceipt: notifications.providerReceipt })
        .from(notifications)
        .where(eq(notifications.id, notificationIds[0]));
      expect(claimedPredecessor.providerReceipt).toMatchObject({ phase: "PROCESSING" });

      await expect(processPendingDutySyncs(now)).resolves.toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      releasePredecessor();
      await workerA;
      await processPendingDutySyncs(now);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>)["Idempotency-Key"])
        .toBe(successorDedupKey);
    } finally {
      releasePredecessor();
      try {
        await workerA;
      } finally {
        if (notificationIds.length > 0) {
          await db.delete(notifications).where(inArray(notifications.id, notificationIds));
        }
        await db.delete(dutyConfirmations).where(inArray(dutyConfirmations.id, [
          predecessorConfirmationId,
          successorConfirmationId,
        ]));
      }
    }
  });

  it("terminaliza namespace duty-sync divergente e IDs persistidos não canônicos", async () => {
    const now = new Date("2033-06-10T10:02:30.000Z");
    const markerId = await enqueueDutySync({
      ...confirmIntentBinding(),
      confirmationId: validConfirmationId,
      institutionId: institutionAId,
      shiftInstanceId: shiftId,
      targetUserId: replacementUserId,
      action: "CONFIRM",
      expectedStatuses: ["REPLACEMENT_CONFIRMED"],
      dedupKey: `boundary:${runId}:duty-sync:marker-title-mismatch`,
    }, now);
    const [marker] = await db
      .select({ providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(eq(notifications.id, markerId));
    const baseState = marker.providerReceipt as Record<string, unknown>;
    await db
      .update(notifications)
      .set({ title: "Outro worker" })
      .where(eq(notifications.id, markerId));

    const invalidStates = [
      { ...baseState, confirmationId: 1.5 },
      { ...baseState, confirmationId: Number.MAX_SAFE_INTEGER + 1 },
      {
        ...baseState,
        confirmationId: validConfirmationId + 100_000,
        targetUserId: 1.5,
      },
      {
        ...baseState,
        confirmationId: validConfirmationId + 100_001,
        targetUserId: Number.MAX_SAFE_INTEGER + 1,
      },
      {
        ...baseState,
        confirmationId: validConfirmationId + 100_002,
        externalSubject: confirmIntentBinding().externalSubject.toUpperCase(),
      },
    ];
    const invalidRows = await db
      .insert(notifications)
      .values(invalidStates.map((providerReceipt, index) => ({
        institutionId: institutionAId,
        userId: replacementUserId,
        title: "Duty roster sync",
        body: "CONFIRM",
        type: "GENERAL" as const,
        status: "PENDING" as const,
        shiftInstanceId: shiftId,
        dedupKey: `boundary:${runId}:duty-sync:invalid-persisted-id:${index}`,
        providerReceipt,
      })))
      .$returningId();
    const ids = [markerId, ...invalidRows.map((row) => row.id)];

    try {
      let processed = 0;
      for (let pass = 0; pass < ids.length; pass += 1) {
        processed += await processPendingDutySyncs(now);
      }
      expect(processed).toBeGreaterThanOrEqual(ids.length);
      expect(fetchMock).not.toHaveBeenCalled();
      const stored = await db
        .select({ status: notifications.status, providerReceipt: notifications.providerReceipt })
        .from(notifications)
        .where(inArray(notifications.id, ids));
      expect(stored).toHaveLength(ids.length);
      expect(stored.every((row) => row.status === "FAILED")).toBe(true);
      expect(stored.every((row) => (
        row.providerReceipt as { evidence?: { reason?: string } }
      ).evidence?.reason === "MALFORMED_DUTY_SYNC_STATE")).toBe(true);
      expect(JSON.stringify(stored)).not.toContain(confirmIntentBinding().externalSubject);
    } finally {
      await db.delete(notifications).where(inArray(notifications.id, ids));
    }
  });

  it("worker rejeita mismatch isolado de sourceSequence e hash da idempotency key antes da rede", async () => {
    const now = new Date("2033-06-10T10:02:40.000Z");
    const firstId = await enqueueDutySync({
      ...confirmIntentBinding(),
      confirmationId: validConfirmationId,
      institutionId: institutionAId,
      shiftInstanceId: shiftId,
      targetUserId: replacementUserId,
      action: "CONFIRM",
      expectedStatuses: ["REPLACEMENT_CONFIRMED"],
      dedupKey: `boundary:${runId}:duty-sync:bad-source-sequence`,
    }, now);
    const secondId = await enqueueDutySync({
      ...confirmIntentBinding(),
      confirmationId: validConfirmationId,
      institutionId: institutionAId,
      shiftInstanceId: shiftId,
      targetUserId: replacementUserId,
      action: "CONFIRM",
      expectedStatuses: ["REPLACEMENT_CONFIRMED"],
      dedupKey: `boundary:${runId}:duty-sync:bad-idempotency-hash`,
    }, now);
    const current = await db
      .select({ id: notifications.id, providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(inArray(notifications.id, [firstId, secondId]));
    const firstState = current.find((row) => row.id === firstId)!.providerReceipt as Record<string, unknown>;
    const secondState = current.find((row) => row.id === secondId)!.providerReceipt as Record<string, unknown>;
    await db.update(notifications).set({
      providerReceipt: { ...firstState, sourceSequence: firstId + 1 },
    }).where(eq(notifications.id, firstId));
    await db.update(notifications).set({
      providerReceipt: { ...secondState, idempotencyKeySha256: "0".repeat(64) },
    }).where(eq(notifications.id, secondId));

    try {
      await processPendingDutySyncs(now);
      await processPendingDutySyncs(now);
      expect(fetchMock).not.toHaveBeenCalled();
      const stored = await db
        .select({ status: notifications.status, providerReceipt: notifications.providerReceipt })
        .from(notifications)
        .where(inArray(notifications.id, [firstId, secondId]));
      expect(stored).toHaveLength(2);
      expect(stored.every((row) => row.status === "FAILED")).toBe(true);
      expect(stored.every((row) => (
        row.providerReceipt as { evidence?: { reason?: string } }
      ).evidence?.reason === "MALFORMED_DUTY_SYNC_STATE")).toBe(true);
    } finally {
      await db.delete(notifications).where(inArray(notifications.id, [firstId, secondId]));
    }
  });

  it("worker rejeita shiftInstanceId congelado divergente da row antes da rede", async () => {
    const now = new Date("2033-06-10T10:02:42.000Z");
    const notificationId = await enqueueDutySync({
      ...confirmIntentBinding(),
      confirmationId: validConfirmationId,
      institutionId: institutionAId,
      shiftInstanceId: shiftId,
      targetUserId: replacementUserId,
      action: "CONFIRM",
      expectedStatuses: ["REPLACEMENT_CONFIRMED"],
      dedupKey: `boundary:${runId}:duty-sync:bad-shift-instance`,
    }, now);
    const [current] = await db
      .select({ providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(eq(notifications.id, notificationId));
    await db
      .update(notifications)
      .set({
        providerReceipt: {
          ...(current.providerReceipt as Record<string, unknown>),
          shiftInstanceId: withdrawShiftId,
        },
      })
      .where(eq(notifications.id, notificationId));

    try {
      await expect(processPendingDutySyncs(now)).resolves.toBeGreaterThanOrEqual(1);
      expect(fetchMock).not.toHaveBeenCalled();
      const [stored] = await db
        .select({ status: notifications.status, providerReceipt: notifications.providerReceipt })
        .from(notifications)
        .where(eq(notifications.id, notificationId));
      expect(stored.status).toBe("FAILED");
      expect(stored.providerReceipt).toMatchObject({
        phase: "FAILED",
        evidence: { reason: "MALFORMED_DUTY_SYNC_STATE" },
      });
    } finally {
      await db.delete(notifications).where(eq(notifications.id, notificationId));
    }
  });

  it("não redireciona retry para organizationId alterado no mapping", async () => {
    const now = new Date("2033-06-10T10:02:45.000Z");
    const originalOrganizationId = orgMappingState.organizationId;
    const notificationId = await enqueueDutySync({
      ...confirmIntentBinding(),
      confirmationId: validConfirmationId,
      institutionId: institutionAId,
      shiftInstanceId: shiftId,
      targetUserId: replacementUserId,
      action: "CONFIRM",
      expectedStatuses: ["REPLACEMENT_CONFIRMED"],
      dedupKey: `boundary:${runId}:duty-sync:organization-drift`,
    }, now);
    orgMappingState.organizationId = "00000000-0000-4000-8000-000000000002";

    try {
      await processPendingDutySyncs(now);
      expect(fetchMock).not.toHaveBeenCalled();
      const [stored] = await db
        .select({
          status: notifications.status,
          errorMessage: notifications.errorMessage,
          providerReceipt: notifications.providerReceipt,
        })
        .from(notifications)
        .where(eq(notifications.id, notificationId));
      expect(stored.status).toBe("FAILED");
      expect(stored.errorMessage).toBe(
        "Organização do duty-sync mudou desde a criação da intenção",
      );
      expect(stored.providerReceipt).toMatchObject({
        phase: "FAILED",
        organizationId: originalOrganizationId,
      });
      expect(JSON.stringify(stored)).not.toContain(orgMappingState.organizationId);
    } finally {
      orgMappingState.organizationId = originalOrganizationId;
      await db.delete(notifications).where(eq(notifications.id, notificationId));
    }
  });

  it("falha Drizzle de autoridade permanece na fila sem persistir externalSubject do erro", async () => {
    const now = new Date("2033-06-10T10:03:00.000Z");
    const sentinel = "DRIZZLE_DUTY_EXTERNAL_SUBJECT_PERSIST_SENTINEL";
    const notificationId = await enqueueDutySync({
      ...confirmIntentBinding(),
      confirmationId: validConfirmationId,
      institutionId: institutionAId,
      shiftInstanceId: shiftId,
      targetUserId: replacementUserId,
      action: "CONFIRM",
      expectedStatuses: ["REPLACEMENT_CONFIRMED"],
      dedupKey: `boundary:${runId}:duty-sync:authority-infrastructure`,
    }, now);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const transactionSpy = vi
      .spyOn(db as any, "transaction")
      .mockImplementationOnce(async (callback: any) => callback({
        select: () => {
          throw new DrizzleQueryError(
            "select users where external_subject = ?",
            [sentinel],
            new Error(sentinel),
          );
        },
      }));

    try {
      try {
        await processPendingDutySyncs(now);
      } finally {
        transactionSpy.mockRestore();
      }

      expect(fetchMock).not.toHaveBeenCalled();
      const [stored] = await db
        .select({
          status: notifications.status,
          errorMessage: notifications.errorMessage,
          providerReceipt: notifications.providerReceipt,
        })
        .from(notifications)
        .where(eq(notifications.id, notificationId));
      expect(stored.status).toBe("PENDING");
      expect(stored.errorMessage).toBe("Duty-sync temporariamente indisponível");
      expect(stored.providerReceipt).toMatchObject({ phase: "QUEUED", attemptCount: 1 });
      expect(`${JSON.stringify(stored)}\n${JSON.stringify(errorLog.mock.calls)}`).not.toContain(sentinel);
    } finally {
      errorLog.mockRestore();
      await db.delete(notifications).where(eq(notifications.id, notificationId));
    }
  });

  it("WITHDRAW pendente sobrevive à troca aceita e à revogação posterior do substituto", async () => {
    const now = new Date("2033-06-10T10:05:00.000Z");
    const originalSubject = withdrawBinding().expectedExternalSubject;
    const notificationId = await enqueueDutySync({
      externalSubject: originalSubject,
      shiftSnapshot: withdrawShiftSnapshot(),
      confirmationId: withdrawConfirmationId,
      institutionId: institutionAId,
      shiftInstanceId: withdrawShiftId,
      targetUserId: originalUserId,
      action: "WITHDRAW",
      expectedStatuses: [
        "DECLINED",
        "NOMINATED",
        "REPLACEMENT_DECLINED",
        "REPLACEMENT_CONFIRMED",
      ],
      dedupKey: `boundary:${runId}:duty-sync:withdraw-after-replacement`,
    }, now);
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "retry" })
      .mockResolvedValueOnce({ ok: true, status: 204, text: async () => "" });

    await processPendingDutySyncs(now);
    await db
      .update(dutyConfirmations)
      .set({
        status: "NOMINATED",
        replacementProfessionalId,
        replacementUserId,
      })
      .where(eq(dutyConfirmations.id, withdrawConfirmationId));
    await db
      .update(dutyConfirmations)
      .set({ status: "REPLACEMENT_CONFIRMED" })
      .where(eq(dutyConfirmations.id, withdrawConfirmationId));
    await db
      .update(users)
      .set({ approvalStatus: "PENDING" })
      .where(eq(users.id, replacementUserId));
    await db
      .update(professionalInstitutions)
      .set({ active: false })
      .where(eq(professionalInstitutions.professionalId, replacementProfessionalId));
    await db
      .update(professionalAccess)
      .set({ canAccess: false })
      .where(eq(professionalAccess.professionalId, replacementProfessionalId));

    try {
      await expect(syncDutyToComunica(
        validConfirmationId,
        "CONFIRM",
        confirmBinding(),
      )).resolves.toEqual({
        ok: false,
        error: "Autoridade canônica do duty-sync revogada",
        retryable: false,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await processPendingDutySyncs(new Date(now.getTime() + 60_000));

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const retryRequest = fetchMock.mock.calls[1][1] as RequestInit;
      const headers = retryRequest.headers as Record<string, string>;
      const claims = decodeJwt(headers.Authorization.replace("Bearer ", ""));
      expect(claims.action).toBe("WITHDRAW");
      expect(claims.email).toBe(originalSubject);
      expect(headers["X-Escala-Confirmation-State"]).toBe("DECLINED");
      const [stored] = await db
        .select({ status: notifications.status, providerReceipt: notifications.providerReceipt })
        .from(notifications)
        .where(eq(notifications.id, notificationId));
      expect(stored.status).toBe("SENT");
      expect(stored.providerReceipt).toMatchObject({
        phase: "SENT",
        targetUserId: originalUserId,
        externalSubject: originalSubject,
        attemptCount: 2,
      });
    } finally {
      await db
        .update(users)
        .set({ approvalStatus: "APPROVED" })
        .where(eq(users.id, replacementUserId));
      await db
        .update(professionalInstitutions)
        .set({ active: true })
        .where(eq(professionalInstitutions.professionalId, replacementProfessionalId));
      await db
        .update(professionalAccess)
        .set({ canAccess: true })
        .where(eq(professionalAccess.professionalId, replacementProfessionalId));
      await db
        .update(dutyConfirmations)
        .set({
          status: "DECLINED",
          replacementProfessionalId: null,
          replacementUserId: null,
        })
        .where(eq(dutyConfirmations.id, withdrawConfirmationId));
    }
  });

  it("WITHDRAW usa envelope congelado e monotônico após revogar toda topologia; CONFIRM segue estrito", async () => {
    const now = new Date("2033-06-10T10:07:00.000Z");
    const retryAt = new Date(now.getTime() + 60_000);
    const frozenOrganizationId = orgMappingState.organizationId!;
    const withdrawDedupKey = `boundary:${runId}:duty-sync:frozen-withdraw-monotonic`;
    const confirmDedupKey = `boundary:${runId}:duty-sync:strict-confirm-topology`;
    const withdrawId = await enqueueDutySync({
      externalSubject: withdrawBinding().expectedExternalSubject,
      shiftSnapshot: withdrawShiftSnapshot(),
      confirmationId: withdrawConfirmationId,
      institutionId: institutionAId,
      shiftInstanceId: withdrawShiftId,
      targetUserId: originalUserId,
      action: "WITHDRAW",
      expectedStatuses: ["DECLINED"],
      dedupKey: withdrawDedupKey,
    }, now);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "retry",
    });
    await processPendingDutySyncs(now);

    const confirmId = await enqueueDutySync({
      ...confirmIntentBinding(),
      confirmationId: validConfirmationId,
      institutionId: institutionAId,
      shiftInstanceId: shiftId,
      targetUserId: replacementUserId,
      action: "CONFIRM",
      expectedStatuses: ["REPLACEMENT_CONFIRMED"],
      dedupKey: confirmDedupKey,
    }, retryAt);
    const [queuedWithdraw] = await db
      .select({ providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(eq(notifications.id, withdrawId));
    expect(queuedWithdraw.providerReceipt).toMatchObject({
      sourceSequence: withdrawId,
      idempotencyKeySha256: hashIdempotencyKey(withdrawDedupKey),
      organizationId: frozenOrganizationId,
      confirmationStatus: "DECLINED",
    });

    await db.update(institutions).set({ isActive: false }).where(eq(institutions.id, institutionAId));
    await db.update(monthlyRosters).set({ status: "DRAFT" }).where(
      and(
        eq(monthlyRosters.institutionId, institutionAId),
        eq(monthlyRosters.hospitalId, hospitalAId),
        eq(monthlyRosters.yearMonth, "2031-01"),
      ),
    );
    await db.update(professionalInstitutions).set({ active: false }).where(
      inArray(professionalInstitutions.professionalId, [
        originalProfessionalId,
        replacementProfessionalId,
      ]),
    );
    await db.update(professionalAccess).set({ canAccess: false }).where(
      inArray(professionalAccess.professionalId, [
        originalProfessionalId,
        replacementProfessionalId,
      ]),
    );
    orgMappingState.organizationId = null;

    try {
      await processPendingDutySyncs(retryAt);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const index of [0, 1]) {
        const request = fetchMock.mock.calls[index]![1] as RequestInit;
        const headers = request.headers as Record<string, string>;
        const claims = decodeJwt(headers.Authorization.replace("Bearer ", ""));
        expect(headers["Idempotency-Key"]).toBe(withdrawDedupKey);
        expect(claims.sourceSequence).toBe(withdrawId);
        expect(claims.idempotencyKeySha256).toBe(hashIdempotencyKey(withdrawDedupKey));
        expect(claims.organizationId).toBe(frozenOrganizationId);
        expect(claims.email).toBe(withdrawBinding().expectedExternalSubject);
        expect(JSON.parse(String(request.body))).toEqual({ sourceSequence: withdrawId });
      }
      const stored = await db
        .select({ id: notifications.id, status: notifications.status })
        .from(notifications)
        .where(inArray(notifications.id, [withdrawId, confirmId]));
      expect(stored.find((row) => row.id === withdrawId)?.status).toBe("SENT");
      expect(stored.find((row) => row.id === confirmId)?.status).toBe("FAILED");
    } finally {
      orgMappingState.organizationId = frozenOrganizationId;
      await db.update(institutions).set({ isActive: true }).where(eq(institutions.id, institutionAId));
      await db.update(monthlyRosters).set({ status: "PUBLISHED" }).where(
        and(
          eq(monthlyRosters.institutionId, institutionAId),
          eq(monthlyRosters.hospitalId, hospitalAId),
          eq(monthlyRosters.yearMonth, "2031-01"),
        ),
      );
      await db.update(professionalInstitutions).set({ active: true }).where(
        inArray(professionalInstitutions.professionalId, [
          originalProfessionalId,
          replacementProfessionalId,
        ]),
      );
      await db.update(professionalAccess).set({ canAccess: true }).where(
        inArray(professionalAccess.professionalId, [
          originalProfessionalId,
          replacementProfessionalId,
        ]),
      );
      await db.delete(notifications).where(inArray(notifications.id, [withdrawId, confirmId]));
    }
  });

  it("CONFIRM mantém subject imutável e falha fechado se o e-mail vivo mudar", async () => {
    const now = new Date("2033-06-10T10:10:00.000Z");
    const originalSubject = confirmIntentBinding().externalSubject;
    const notificationId = await enqueueDutySync({
      ...confirmIntentBinding(),
      confirmationId: validConfirmationId,
      institutionId: institutionAId,
      shiftInstanceId: shiftId,
      targetUserId: replacementUserId,
      action: "CONFIRM",
      expectedStatuses: ["REPLACEMENT_CONFIRMED"],
      dedupKey: `boundary:${runId}:duty-sync:immutable-confirm-subject`,
    }, now);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "temporarily unavailable",
    });
    await processPendingDutySyncs(now);

    const changedEmail = `confirmation-boundary-replacement-changed-${runId}@test.local`;
    await db.update(users).set({ email: changedEmail }).where(eq(users.id, replacementUserId));
    try {
      await processPendingDutySyncs(new Date(now.getTime() + 60_000));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [stored] = await db
        .select({ status: notifications.status, providerReceipt: notifications.providerReceipt })
        .from(notifications)
        .where(eq(notifications.id, notificationId));
      expect(stored.status).toBe("FAILED");
      expect(stored.providerReceipt).toMatchObject({
        phase: "FAILED",
        externalSubject: originalSubject,
      });
    } finally {
      await db.update(users).set({ email: originalSubject }).where(eq(users.id, replacementUserId));
    }
  });

  it("WITHDRAW reutiliza o subject externo persistido mesmo após mudança de e-mail", async () => {
    const now = new Date("2033-06-10T10:12:00.000Z");
    const originalSubject = withdrawBinding().expectedExternalSubject;
    await enqueueDutySync({
      externalSubject: originalSubject,
      shiftSnapshot: withdrawShiftSnapshot(),
      confirmationId: withdrawConfirmationId,
      institutionId: institutionAId,
      shiftInstanceId: withdrawShiftId,
      targetUserId: originalUserId,
      action: "WITHDRAW",
      expectedStatuses: ["DECLINED"],
      dedupKey: `boundary:${runId}:duty-sync:immutable-withdraw-subject`,
    }, now);
    const changedEmail = `confirmation-boundary-original-changed-${runId}@test.local`;
    await db.update(users).set({ email: changedEmail }).where(eq(users.id, originalUserId));
    try {
      await processPendingDutySyncs(now);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const request = fetchMock.mock.calls[0][1] as RequestInit;
      const authorization = (request.headers as Record<string, string>).Authorization;
      expect(decodeJwt(authorization.replace("Bearer ", "")).email).toBe(originalSubject);
    } finally {
      await db.update(users).set({ email: originalSubject }).where(eq(users.id, originalUserId));
    }
  });

  it("duty-sync seleciona e falha explicitamente row malformada", async () => {
    const now = new Date("2033-06-10T10:14:00.000Z");
    const [malformed] = await db.insert(notifications).values({
      institutionId: institutionAId,
      userId: replacementUserId,
      shiftInstanceId: shiftId,
      title: "Duty roster sync",
      body: "CONFIRM",
      status: "PENDING",
      dedupKey: `boundary:${runId}:duty-sync:malformed`,
      providerReceipt: {
        phase: "QUEUED",
        revision: 1,
        confirmationId: validConfirmationId,
        action: "CONFIRM",
        expectedStatuses: ["REPLACEMENT_CONFIRMED"],
        targetUserId: replacementUserId,
        attemptCount: 0,
        availableAt: now.toISOString(),
      },
    }).$returningId();

    await expect(processPendingDutySyncs(now)).resolves.toBeGreaterThanOrEqual(1);

    expect(fetchMock).not.toHaveBeenCalled();
    const [stored] = await db
      .select({ status: notifications.status, providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(eq(notifications.id, malformed.id));
    expect(stored.status).toBe("FAILED");
    expect(stored.providerReceipt).toMatchObject({
      phase: "FAILED",
      evidence: { reason: "MALFORMED_DUTY_SYNC_STATE" },
    });
  });

  it("duty-sync recupera após outage além do antigo limite de tentativas", async () => {
    const initialDueAt = new Date("2033-06-10T10:15:00.000Z");
    const dedupKey = `boundary:${runId}:duty-sync:long-outage`;
    const notificationId = await enqueueDutySync({
      ...confirmIntentBinding(),
      confirmationId: validConfirmationId,
      institutionId: institutionAId,
      shiftInstanceId: shiftId,
      targetUserId: replacementUserId,
      action: "CONFIRM",
      expectedStatuses: ["REPLACEMENT_CONFIRMED"],
      dedupKey,
    }, initialDueAt);
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "long outage",
    });

    let dueAt = initialDueAt;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await processPendingDutySyncs(dueAt);
      const [pending] = await db
        .select({ status: notifications.status, providerReceipt: notifications.providerReceipt })
        .from(notifications)
        .where(eq(notifications.id, notificationId));
      const state = pending.providerReceipt as {
        phase: string;
        attemptCount: number;
        availableAt: string;
      };
      expect(pending.status).toBe("PENDING");
      expect(state).toMatchObject({ phase: "QUEUED", attemptCount: attempt });
      dueAt = new Date(state.availableAt);
    }

    fetchMock.mockResolvedValue({ ok: true, status: 204, text: async () => "" });
    await processPendingDutySyncs(dueAt);

    const [recovered] = await db
      .select({ status: notifications.status, providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(eq(notifications.id, notificationId));
    expect(recovered.status).toBe("SENT");
    expect(recovered.providerReceipt).toMatchObject({ phase: "SENT", attemptCount: 7 });
    expect(fetchMock).toHaveBeenCalledTimes(7);
    for (const call of fetchMock.mock.calls) {
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers["Idempotency-Key"]).toBe(dedupKey);
    }
  });

  it.each([408, 425])("duty-sync trata HTTP %i como falha transitória", async (status) => {
    const now = new Date(`2033-06-10T10:${status === 408 ? "20" : "25"}:00.000Z`);
    const notificationId = await enqueueDutySync({
      ...confirmIntentBinding(),
      confirmationId: validConfirmationId,
      institutionId: institutionAId,
      shiftInstanceId: shiftId,
      targetUserId: replacementUserId,
      action: "CONFIRM",
      expectedStatuses: ["REPLACEMENT_CONFIRMED"],
      dedupKey: `boundary:${runId}:duty-sync:http-${status}`,
    }, now);
    fetchMock
      .mockResolvedValueOnce({ ok: false, status, text: async () => "retry" })
      .mockResolvedValueOnce({ ok: true, status: 204, text: async () => "" });

    await processPendingDutySyncs(now);
    await processPendingDutySyncs(new Date(now.getTime() + 60_000));

    const [stored] = await db
      .select({ status: notifications.status, providerReceipt: notifications.providerReceipt })
      .from(notifications)
      .where(eq(notifications.id, notificationId));
    expect(stored.status).toBe("SENT");
    expect(stored.providerReceipt).toMatchObject({ phase: "SENT", attemptCount: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("duty-sync não registra o corpo não confiável devolvido pelo destino", async () => {
    const externalBody = `upstream-secret-${runId}`;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const infoLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const responseText = vi.fn(async () => externalBody);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      text: responseText,
    });

    try {
      await expect(syncDutyToComunica(
        validConfirmationId,
        "CONFIRM",
        confirmBinding(),
      )).resolves.toMatchObject({ ok: false, retryable: true });

      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("Comunica+ retornou 502"),
      );
      expect(responseText).not.toHaveBeenCalled();
      const serializedLogs = [warning, errorLog, infoLog]
        .flatMap((spy) => spy.mock.calls)
        .flat()
        .flatMap((value) => {
          const representations = [String(value)];
          if (value instanceof Error) {
            representations.push(value.message, value.stack ?? "");
          }
          try {
            representations.push(JSON.stringify(value));
          } catch {
            representations.push("[unserializable]");
          }
          return representations;
        })
        .join("\n");
      expect(serializedLogs).not.toContain(externalBody);
    } finally {
      infoLog.mockRestore();
      errorLog.mockRestore();
      warning.mockRestore();
    }
  });

  it("duty-sync rejeita combinação action/status incoerente antes do outbox", async () => {
    await expect(enqueueDutySync({
      ...confirmIntentBinding(),
      confirmationId: validConfirmationId,
      institutionId: institutionAId,
      shiftInstanceId: shiftId,
      targetUserId: replacementUserId,
      action: "CONFIRM",
      expectedStatuses: ["DECLINED"],
      dedupKey: `boundary:${runId}:duty-sync:invalid-purpose`,
    })).rejects.toThrow("Purpose ou status esperado invalido");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("duty-sync revalida o status antes do retry e não emite evento obsoleto", async () => {
    const now = new Date("2033-06-10T10:30:00.000Z");
    const notificationId = await enqueueDutySync({
      ...confirmIntentBinding(),
      confirmationId: validConfirmationId,
      institutionId: institutionAId,
      shiftInstanceId: shiftId,
      targetUserId: replacementUserId,
      action: "CONFIRM",
      expectedStatuses: ["REPLACEMENT_CONFIRMED"],
      dedupKey: `boundary:${runId}:duty-sync:stale-status`,
    }, now);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "temporarily unavailable",
    });
    await processPendingDutySyncs(now);
    await db.update(dutyConfirmations).set({ status: "REPLACEMENT_DECLINED" })
      .where(eq(dutyConfirmations.id, validConfirmationId));
    try {
      await processPendingDutySyncs(new Date(now.getTime() + 60_000));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [stored] = await db.select({
        status: notifications.status,
        providerReceipt: notifications.providerReceipt,
      }).from(notifications).where(eq(notifications.id, notificationId));
      expect(stored.status).toBe("FAILED");
      expect(stored.providerReceipt).toMatchObject({ phase: "FAILED", attemptCount: 2 });
    } finally {
      await db.update(dutyConfirmations).set({ status: "REPLACEMENT_CONFIRMED" })
        .where(eq(dutyConfirmations.id, validConfirmationId));
    }
  });

  it("duty-sync vincula o retry ao tenant canônico da confirmação", async () => {
    const now = new Date("2033-06-10T10:45:00.000Z");
    const notificationId = await enqueueDutySync({
      ...confirmIntentBinding(),
      confirmationId: validConfirmationId,
      institutionId: institutionBId,
      shiftInstanceId: shiftId,
      targetUserId: replacementUserId,
      action: "CONFIRM",
      expectedStatuses: ["REPLACEMENT_CONFIRMED"],
      dedupKey: `boundary:${runId}:duty-sync:wrong-tenant`,
    }, now);

    await processPendingDutySyncs(now);

    expect(fetchMock).not.toHaveBeenCalled();
    const [stored] = await db.select({
      status: notifications.status,
      providerReceipt: notifications.providerReceipt,
    }).from(notifications).where(eq(notifications.id, notificationId));
    expect(stored.status).toBe("FAILED");
    expect(stored.providerReceipt).toMatchObject({
      phase: "FAILED",
      evidence: { reason: "MALFORMED_DUTY_SYNC_STATE" },
    });
  });

  it("duty-sync revalida vínculo antes do retry e não emite após revogação", async () => {
    const now = new Date("2033-06-10T11:00:00.000Z");
    const notificationId = await enqueueDutySync({
      ...confirmIntentBinding(),
      confirmationId: validConfirmationId,
      institutionId: institutionAId,
      shiftInstanceId: shiftId,
      targetUserId: replacementUserId,
      action: "CONFIRM",
      expectedStatuses: ["REPLACEMENT_CONFIRMED"],
      dedupKey: `boundary:${runId}:duty-sync:revoked-retry`,
    }, now);
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => "temporarily unavailable",
    });
    await processPendingDutySyncs(now);
    await db
      .update(professionalInstitutions)
      .set({ active: false })
      .where(eq(professionalInstitutions.professionalId, replacementProfessionalId));
    try {
      await processPendingDutySyncs(new Date(now.getTime() + 60_000));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [stored] = await db
        .select({ status: notifications.status, providerReceipt: notifications.providerReceipt })
        .from(notifications)
        .where(eq(notifications.id, notificationId));
      expect(stored.status).toBe("FAILED");
      expect(stored.providerReceipt).toMatchObject({ phase: "FAILED", attemptCount: 2 });
    } finally {
      await db
        .update(professionalInstitutions)
        .set({ active: true })
        .where(eq(professionalInstitutions.professionalId, replacementProfessionalId));
    }
  });
});
