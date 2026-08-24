import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeJwt, generateKeyPair } from "jose";
import { eq, inArray } from "drizzle-orm";
import {
  dutyConfirmations,
  hospitals,
  institutions,
  professionalAccess,
  professionalInstitutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { sendPushNotification } from "../server/notifications-service";
import { triggerAutoSso } from "../server/sso/auto-sso";
import { syncDutyToComunica } from "../server/sso/duty-sync";

const keyState = vi.hoisted(() => ({ privateKey: null as CryptoKey | null }));

vi.mock("../server/notifications-service", () => ({
  sendPushNotification: vi.fn(async () => ({ success: true, message: "mock" })),
}));
vi.mock("../server/sso/org-mapping", () => ({
  hasMappingFor: vi.fn(() => true),
  getComunicaOrgId: vi.fn(() => "00000000-0000-4000-8000-000000000001"),
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
  const pushMock = vi.mocked(sendPushNotification);
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 204,
    text: async () => "",
  }));

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
    pushMock.mockClear();
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
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
      await expect(syncDutyToComunica(confirmationId, "CONFIRM")).resolves.toMatchObject({ ok: false });
    }
    expect(pushMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    const after = await db
      .select({ ssoTriggeredAt: dutyConfirmations.ssoTriggeredAt })
      .from(dutyConfirmations)
      .where(inArray(dutyConfirmations.id, rejectedIds));
    expect(after.every((row) => row.ssoTriggeredAt === null)).toBe(true);
  });

  it("revalida identidade, vínculo e acesso atuais do substituto antes de emitir", async () => {
    const expectSuppressed = async () => {
      await expect(triggerAutoSso(validConfirmationId)).resolves.toMatchObject({ ok: false });
      await expect(syncDutyToComunica(validConfirmationId, "CONFIRM")).resolves.toMatchObject({
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
        replacementUserId,
        expect.objectContaining({
          data: expect.objectContaining({ shiftInstanceId: shiftId }),
        }),
      );

      await expect(syncDutyToComunica(validConfirmationId, "CONFIRM")).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const request = fetchMock.mock.calls[0][1] as RequestInit;
      const authorization = (request.headers as Record<string, string>).Authorization;
      const claims = decodeJwt(authorization.replace("Bearer ", ""));
      expect(claims.email).toBe(`confirmation-boundary-replacement-${runId}@test.local`);
    } finally {
      await db
        .update(professionalInstitutions)
        .set({ active: true })
        .where(
          inArray(professionalInstitutions.professionalId, [originalProfessionalId]),
        );
    }
  });

  it("assina WITHDRAW real para o titular recusado", async () => {
    await expect(syncDutyToComunica(withdrawConfirmationId, "WITHDRAW")).resolves.toEqual({
      ok: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const authorization = (request.headers as Record<string, string>).Authorization;
    const claims = decodeJwt(authorization.replace("Bearer ", ""));
    expect(claims.action).toBe("WITHDRAW");
    expect(claims.email).toBe(`confirmation-boundary-original-${runId}@test.local`);
  });
});
