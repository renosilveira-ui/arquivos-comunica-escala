// tests/schedule-invite-accepted-signal.test.ts — push ao gestor emissor quando
// convite nominal é resgatado (invite_accepted only; sem recusa nesta frente).

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request from "supertest";
import express, { type Express } from "express";
import {
  auditTrail,
  hospitals,
  institutions,
  managerScope,
  notifications,
  professionalAccess,
  professionalInstitutions,
  professionals,
  scheduleContexts,
  scheduleInvites,
  sectors,
  users,
} from "../drizzle/schema";
import {
  generateScheduleInviteCode,
  hashScheduleInviteCode,
  normalizeScheduleInviteCode,
} from "../lib/schedule-invite-code";
import { getDb } from "../server/db";
import { authRouter } from "../server/routes/auth";
import * as pushDelivery from "../server/push-delivery";
import * as scheduleInviteResponseSignalHelpers from "../server/schedule-invite-response-signal-helpers";
import {
  ensureTestAnesthesiaSpecialty,
  openTestScale,
} from "./helpers/open-test-scale";
import { sessionAuthCookies } from "./helpers/session-cookies";

const PASSWORD = "SenhaForte123";
const stamp = Date.now();

type Identity = {
  userId: number;
  professionalId: number;
  name: string;
  email: string;
};

describe("push de convite aceito", () => {
  let app: Express;
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionA: number;
  let institutionB: number;
  let hospitalA: number;
  let hospitalB: number;
  let sectorA: number;
  let sectorB: number;
  let anesthesiaId: number;
  let creator: Identity;
  let otherGestor: Identity;
  let gestorPlus: Identity;
  let invitee: Identity;
  let tenantBGestor: Identity;
  const userIds: number[] = [];
  const professionalIds: number[] = [];

  async function login(email: string) {
    return request(app).post("/api/auth/login").send({ email, password: PASSWORD });
  }

  function cookieOf(res: request.Response): string {
    return sessionAuthCookies(res);
  }

  async function createIdentity(
    label: string,
    institutionId: number,
    input: {
      roleInInstitution: "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";
      withAccess?: boolean;
      hospitalId: number;
      sectorId: number;
      deletedAt?: Date | null;
      active?: boolean;
    },
  ): Promise<Identity> {
    const name = `invite-accepted-${stamp}-${label}`;
    const email = `${name}@example.test`;
    const [user] = await db
      .insert(users)
      .values({
        name,
        email,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        role: input.roleInInstitution === "USER" ? "doctor" : "manager",
        approvalStatus: "APPROVED",
        sessionVersion: 1,
        deletedAt: input.deletedAt ?? null,
      })
      .$returningId();
    userIds.push(user.id);
    const [professional] = await db
      .insert(professionals)
      .values({
        userId: user.id,
        name,
        role: "Médico",
        specialty: "Anestesiologia",
        medicalSpecialtyId: anesthesiaId,
        userRole: input.roleInInstitution,
      })
      .$returningId();
    professionalIds.push(professional.id);
    await db.insert(professionalInstitutions).values({
      professionalId: professional.id,
      userId: user.id,
      institutionId,
      roleInInstitution: input.roleInInstitution,
      active: input.active ?? true,
    });
    if (input.withAccess !== false) {
      await db.insert(professionalAccess).values({
        institutionId,
        professionalId: professional.id,
        hospitalId: input.hospitalId,
        sectorId: input.sectorId,
        canAccess: true,
      });
    }
    return { userId: user.id, professionalId: professional.id, name, email };
  }

  async function createInvite(
    institutionId: number,
    hospitalId: number,
    sectorId: number,
    createdByUserId: number,
    invitedUserId: number,
  ) {
    const code = generateScheduleInviteCode();
    const [invite] = await db
      .insert(scheduleInvites)
      .values({
        institutionId,
        hospitalId,
        sectorId,
        codeHash: hashScheduleInviteCode(normalizeScheduleInviteCode(code)),
        createdByUserId,
        invitedUserId,
        invitedEmail: `invitee-${stamp}@example.test`,
        maxRedemptions: 1,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .$returningId();
    return { inviteId: invite.id, code };
  }

  async function redeemInvite(code: string, sessionCookie: string) {
    return request(app)
      .post("/api/auth/redeem-invite")
      .set("Cookie", sessionCookie)
      .send({ inviteCode: code });
  }

  async function notificationRowsForUsers(userIdList: number[]) {
    if (userIdList.length === 0) return [];
    return db
      .select({
        id: notifications.id,
        userId: notifications.userId,
        dedupKey: notifications.dedupKey,
        title: notifications.title,
        providerReceipt: notifications.providerReceipt,
      })
      .from(notifications)
      .where(inArray(notifications.userId, userIdList));
  }

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;
    app = express();
    app.use(express.json());
    app.use("/api/auth", authRouter);

    anesthesiaId = await ensureTestAnesthesiaSpecialty(db);

    const [instA] = await db
      .insert(institutions)
      .values({
        name: `Invite Accepted A ${stamp}`,
        cnpj: `${stamp}1`.slice(-14).padStart(14, "0"),
        legalName: `Invite A ${stamp}`,
        tradeName: `IA${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionA = instA.id;
    const [instB] = await db
      .insert(institutions)
      .values({
        name: `Invite Accepted B ${stamp}`,
        cnpj: `${stamp}2`.slice(-14).padStart(14, "0"),
        legalName: `Invite B ${stamp}`,
        tradeName: `IB${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionB = instB.id;

    const [hospA] = await db
      .insert(hospitals)
      .values({ institutionId: institutionA, name: `Hospital A ${stamp}` })
      .$returningId();
    hospitalA = hospA.id;
    const [hospB] = await db
      .insert(hospitals)
      .values({ institutionId: institutionB, name: `Hospital B ${stamp}` })
      .$returningId();
    hospitalB = hospB.id;

    const [secA] = await db
      .insert(sectors)
      .values({
        institutionId: institutionA,
        hospitalId: hospitalA,
        name: `Setor A ${stamp}`,
        category: "cirurgico",
        color: "#2563EB",
      })
      .$returningId();
    sectorA = secA.id;
    const [secB] = await db
      .insert(sectors)
      .values({
        institutionId: institutionB,
        hospitalId: hospitalB,
        name: `Setor B ${stamp}`,
        category: "cirurgico",
        color: "#0F766E",
      })
      .$returningId();
    sectorB = secB.id;

    await openTestScale(db, {
      institutionId: institutionA,
      hospitalId: hospitalA,
      sectorId: sectorA,
    });
    await openTestScale(db, {
      institutionId: institutionB,
      hospitalId: hospitalB,
      sectorId: sectorB,
    });

    creator = await createIdentity("creator", institutionA, {
      roleInInstitution: "GESTOR_MEDICO",
      hospitalId: hospitalA,
      sectorId: sectorA,
    });
    otherGestor = await createIdentity("other-gestor", institutionA, {
      roleInInstitution: "GESTOR_MEDICO",
      hospitalId: hospitalA,
      sectorId: sectorA,
    });
    gestorPlus = await createIdentity("gestor-plus", institutionA, {
      roleInInstitution: "GESTOR_PLUS",
      hospitalId: hospitalA,
      sectorId: sectorA,
    });
    invitee = await createIdentity("invitee", institutionA, {
      roleInInstitution: "USER",
      hospitalId: hospitalA,
      sectorId: sectorA,
      withAccess: false,
    });
    tenantBGestor = await createIdentity("tenant-b-gestor", institutionB, {
      roleInInstitution: "GESTOR_MEDICO",
      hospitalId: hospitalB,
      sectorId: sectorB,
    });

    await db.insert(managerScope).values([
      {
        institutionId: institutionA,
        managerProfessionalId: creator.professionalId,
        hospitalId: hospitalA,
        sectorId: sectorA,
        active: true,
      },
      {
        institutionId: institutionA,
        managerProfessionalId: otherGestor.professionalId,
        hospitalId: hospitalA,
        sectorId: sectorA,
        active: true,
      },
    ]);
  });

  afterAll(async () => {
    if (userIds.length > 0) {
      await db
        .delete(auditTrail)
        .where(inArray(auditTrail.institutionId, [institutionA, institutionB]));
      await db.delete(notifications).where(inArray(notifications.userId, userIds));
      await db.delete(scheduleInvites).where(
        inArray(scheduleInvites.institutionId, [institutionA, institutionB]),
      );
      await db.delete(professionalAccess).where(
        inArray(professionalAccess.professionalId, professionalIds),
      );
      await db.delete(managerScope).where(
        inArray(managerScope.managerProfessionalId, professionalIds),
      );
      await db.delete(professionalInstitutions).where(
        inArray(professionalInstitutions.userId, userIds),
      );
      await db.delete(professionals).where(inArray(professionals.id, professionalIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    await db
      .delete(scheduleContexts)
      .where(
        and(
          eq(scheduleContexts.institutionId, institutionA),
          eq(scheduleContexts.hospitalId, hospitalA),
          eq(scheduleContexts.sectorId, sectorA),
        ),
      );
    await db
      .delete(scheduleContexts)
      .where(
        and(
          eq(scheduleContexts.institutionId, institutionB),
          eq(scheduleContexts.hospitalId, hospitalB),
          eq(scheduleContexts.sectorId, sectorB),
        ),
      );
    await db.delete(sectors).where(inArray(sectors.id, [sectorA, sectorB]));
    await db.delete(hospitals).where(inArray(hospitals.id, [hospitalA, hospitalB]));
    await db
      .delete(institutions)
      .where(inArray(institutions.id, [institutionA, institutionB]));
  });

  it("registra invite_accepted para o gestor emissor após resgate válido", async () => {
    const { inviteId, code } = await createInvite(
      institutionA,
      hospitalA,
      sectorA,
      creator.userId,
      invitee.userId,
    );
    const session = await login(invitee.email);
    expect(session.status).toBe(200);
    const joined = await redeemInvite(code, cookieOf(session));
    expect(joined.status).toBe(200);
    expect(joined.body.ok).toBe(true);

    const [inviteRow] = await db
      .select({ redeemedCount: scheduleInvites.redeemedCount })
      .from(scheduleInvites)
      .where(eq(scheduleInvites.id, inviteId));
    expect(inviteRow?.redeemedCount).toBe(1);

    const [access] = await db
      .select({ canAccess: professionalAccess.canAccess })
      .from(professionalAccess)
      .where(
        and(
          eq(professionalAccess.professionalId, invitee.professionalId),
          eq(professionalAccess.sectorId, sectorA),
        ),
      );
    expect(access?.canAccess).toBe(true);

    const rows = await notificationRowsForUsers([
      creator.userId,
      otherGestor.userId,
      gestorPlus.userId,
      invitee.userId,
      tenantBGestor.userId,
    ]);
    const creatorRows = rows.filter((row) => row.userId === creator.userId);
    expect(creatorRows).toHaveLength(1);
    expect(creatorRows[0]?.dedupKey).toBe(
      `schedule-invite:${inviteId}:accepted:${creator.userId}`,
    );
    expect(creatorRows[0]?.title).toBe("Convite aceito");

    const payloadData = (
      creatorRows[0]?.providerReceipt as {
        payloadData?: Record<string, unknown>;
      }
    )?.payloadData;
    expect(payloadData).toMatchObject({
      type: "invite_accepted",
      institutionId: institutionA,
      scheduleInviteId: inviteId,
      hospitalId: hospitalA,
      sectorId: sectorA,
      invitedUserId: invitee.userId,
    });
    expect(payloadData).not.toHaveProperty("createdByUserId");
    expect(JSON.stringify(payloadData)).not.toMatch(/token|hash|codigo|código/i);

    expect(rows.some((row) => row.userId === otherGestor.userId)).toBe(false);
    expect(rows.some((row) => row.userId === gestorPlus.userId)).toBe(false);
    expect(rows.some((row) => row.userId === invitee.userId)).toBe(false);
  });

  it("isola tenant: gestor de outra instituição não recebe o push", async () => {
    const localInvitee = await createIdentity("tenant-isolation-invitee", institutionA, {
      roleInInstitution: "USER",
      hospitalId: hospitalA,
      sectorId: sectorA,
      withAccess: false,
    });
    const { inviteId, code } = await createInvite(
      institutionA,
      hospitalA,
      sectorA,
      creator.userId,
      localInvitee.userId,
    );
    const session = await login(localInvitee.email);
    const joined = await redeemInvite(code, cookieOf(session));
    expect(joined.status).toBe(200);

    const rows = await notificationRowsForUsers([tenantBGestor.userId]);
    expect(rows).toHaveLength(0);
    expect(inviteId).toBeGreaterThan(0);
  });

  it("não envia push quando o criador perdeu vínculo ativo, mas o resgate persiste", async () => {
    const inactiveCreator = await createIdentity("inactive-creator", institutionA, {
      roleInInstitution: "GESTOR_MEDICO",
      hospitalId: hospitalA,
      sectorId: sectorA,
      active: false,
    });
    const localInvitee = await createIdentity("inactive-invitee", institutionA, {
      roleInInstitution: "USER",
      hospitalId: hospitalA,
      sectorId: sectorA,
      withAccess: false,
    });
    const { inviteId, code } = await createInvite(
      institutionA,
      hospitalA,
      sectorA,
      inactiveCreator.userId,
      localInvitee.userId,
    );
    const session = await login(localInvitee.email);
    const joined = await redeemInvite(code, cookieOf(session));
    expect(joined.status).toBe(200);

    const [inviteRow] = await db
      .select({ redeemedCount: scheduleInvites.redeemedCount })
      .from(scheduleInvites)
      .where(eq(scheduleInvites.id, inviteId));
    expect(inviteRow?.redeemedCount).toBe(1);

    const rows = await notificationRowsForUsers([inactiveCreator.userId]);
    expect(rows).toHaveLength(0);
  });

  async function expectSuccessfulRedeemAfterSignalFailure(input: {
    creatorUserId: number;
    invitee: Identity;
  }) {
    const { inviteId, code } = await createInvite(
      institutionA,
      hospitalA,
      sectorA,
      input.creatorUserId,
      input.invitee.userId,
    );
    const session = await login(input.invitee.email);
    const joined = await redeemInvite(code, cookieOf(session));
    expect(joined.status).toBe(200);
    expect(joined.body.ok).toBe(true);

    const [inviteRow] = await db
      .select({ redeemedCount: scheduleInvites.redeemedCount })
      .from(scheduleInvites)
      .where(eq(scheduleInvites.id, inviteId));
    expect(inviteRow?.redeemedCount).toBe(1);

    const [access] = await db
      .select({ canAccess: professionalAccess.canAccess })
      .from(professionalAccess)
      .where(eq(professionalAccess.professionalId, input.invitee.professionalId));
    expect(access?.canAccess).toBe(true);
    return inviteId;
  }

  it("mantém resgate commitado quando a resolução do destinatário falha", async () => {
    const localCreator = await createIdentity("resolve-fail-creator", institutionA, {
      roleInInstitution: "GESTOR_MEDICO",
      hospitalId: hospitalA,
      sectorId: sectorA,
    });
    const localInvitee = await createIdentity("resolve-fail-invitee", institutionA, {
      roleInInstitution: "USER",
      hospitalId: hospitalA,
      sectorId: sectorA,
      withAccess: false,
    });
    const spy = vi
      .spyOn(scheduleInviteResponseSignalHelpers, "resolveInviteAcceptedRecipientUserId")
      .mockRejectedValue(new Error("forced resolve failure"));
    try {
      await expectSuccessfulRedeemAfterSignalFailure({
        creatorUserId: localCreator.userId,
        invitee: localInvitee,
      });
    } finally {
      spy.mockRestore();
    }
    const rows = await notificationRowsForUsers([localCreator.userId]);
    expect(rows).toHaveLength(0);
  });

  it("mantém resgate commitado quando o carregamento do nome falha", async () => {
    const localCreator = await createIdentity("name-fail-creator", institutionA, {
      roleInInstitution: "GESTOR_MEDICO",
      hospitalId: hospitalA,
      sectorId: sectorA,
    });
    const localInvitee = await createIdentity("name-fail-invitee", institutionA, {
      roleInInstitution: "USER",
      hospitalId: hospitalA,
      sectorId: sectorA,
      withAccess: false,
    });
    const spy = vi
      .spyOn(scheduleInviteResponseSignalHelpers, "loadInvitedProfessionalName")
      .mockRejectedValue(new Error("forced name failure"));
    try {
      await expectSuccessfulRedeemAfterSignalFailure({
        creatorUserId: localCreator.userId,
        invitee: localInvitee,
      });
    } finally {
      spy.mockRestore();
    }
    const rows = await notificationRowsForUsers([localCreator.userId]);
    expect(rows).toHaveLength(0);
  });

  it("mantém resgate commitado quando o outbox falha", async () => {
    const localCreator = await createIdentity("outbox-creator", institutionA, {
      roleInInstitution: "GESTOR_MEDICO",
      hospitalId: hospitalA,
      sectorId: sectorA,
    });
    const localInvitee = await createIdentity("outbox-invitee", institutionA, {
      roleInInstitution: "USER",
      hospitalId: hospitalA,
      sectorId: sectorA,
      withAccess: false,
    });
    const spy = vi
      .spyOn(pushDelivery, "enqueueTrackedPushNotification")
      .mockRejectedValue(new Error("forced outbox failure"));
    try {
      await expectSuccessfulRedeemAfterSignalFailure({
        creatorUserId: localCreator.userId,
        invitee: localInvitee,
      });
    } finally {
      spy.mockRestore();
    }
    const rows = await notificationRowsForUsers([localCreator.userId]);
    expect(rows).toHaveLength(0);
  });

  it("segunda tentativa de resgate não cria segundo push", async () => {
    const localCreator = await createIdentity("idempotent-creator", institutionA, {
      roleInInstitution: "GESTOR_MEDICO",
      hospitalId: hospitalA,
      sectorId: sectorA,
    });
    const localInvitee = await createIdentity("idempotent-invitee", institutionA, {
      roleInInstitution: "USER",
      hospitalId: hospitalA,
      sectorId: sectorA,
      withAccess: false,
    });
    const { inviteId, code } = await createInvite(
      institutionA,
      hospitalA,
      sectorA,
      localCreator.userId,
      localInvitee.userId,
    );
    const session = await login(localInvitee.email);
    const cookie = cookieOf(session);
    const first = await redeemInvite(code, cookie);
    expect(first.status).toBe(200);
    const second = await redeemInvite(code, cookie);
    expect(second.status).toBe(400);

    const rows = await notificationRowsForUsers([localCreator.userId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dedupKey).toBe(
      `schedule-invite:${inviteId}:accepted:${localCreator.userId}`,
    );
  });
});
