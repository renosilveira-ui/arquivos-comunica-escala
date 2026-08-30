// tests/schedule-invite-decline.test.ts — recusa explícita de convite nominal.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
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
import { pendingNamedInviteCoversScale } from "../server/schedule-contexts";
import * as scheduleInviteResponseSignalHelpers from "../server/schedule-invite-response-signal-helpers";
import { ensureTestAnesthesiaSpecialty, openTestScale } from "./helpers/open-test-scale";
import { sessionAuthCookies } from "./helpers/session-cookies";

const PASSWORD = "SenhaForte123";
const stamp = Date.now();

type Identity = {
  userId: number;
  professionalId: number;
  name: string;
  email: string;
};

describe("recusa explícita de convite nominal", () => {
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
  let wrongUser: Identity;
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
    const name = `invite-decline-${stamp}-${label}`;
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
    overrides?: Partial<{
      expiresAt: Date;
      revokedAt: Date;
      declinedAt: Date;
      redeemedCount: number;
    }>,
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
        expiresAt: overrides?.expiresAt ?? new Date(Date.now() + 86_400_000),
        revokedAt: overrides?.revokedAt ?? null,
        declinedAt: overrides?.declinedAt ?? null,
        redeemedCount: overrides?.redeemedCount ?? 0,
      })
      .$returningId();
    return { inviteId: invite.id, code };
  }

  async function declineInvite(code: string, sessionCookie: string) {
    return request(app)
      .post("/api/auth/decline-invite")
      .set("Cookie", sessionCookie)
      .send({ inviteCode: code });
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

  async function inviteRow(inviteId: number) {
    const [row] = await db
      .select()
      .from(scheduleInvites)
      .where(eq(scheduleInvites.id, inviteId));
    return row;
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
        name: `Invite Decline A ${stamp}`,
        cnpj: `${stamp}1`.slice(-14).padStart(14, "0"),
        legalName: `Decline A ${stamp}`,
        tradeName: `IDA${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionA = instA.id;
    const [instB] = await db
      .insert(institutions)
      .values({
        name: `Invite Decline B ${stamp}`,
        cnpj: `${stamp}2`.slice(-14).padStart(14, "0"),
        legalName: `Decline B ${stamp}`,
        tradeName: `IDB${stamp}`.slice(0, 20),
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
    wrongUser = await createIdentity("wrong-user", institutionA, {
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

  it("preenche declinedAt e declinedByUserId sem alterar redeemedCount nem revokedAt", async () => {
    const { inviteId, code } = await createInvite(
      institutionA,
      hospitalA,
      sectorA,
      creator.userId,
      invitee.userId,
    );
    const session = await login(invitee.email);
    const declined = await declineInvite(code, cookieOf(session));
    expect(declined.status).toBe(200);
    expect(declined.body.ok).toBe(true);

    const row = await inviteRow(inviteId);
    expect(row?.declinedAt).not.toBeNull();
    expect(row?.declinedByUserId).toBe(invitee.userId);
    expect(row?.redeemedCount).toBe(0);
    expect(row?.revokedAt).toBeNull();
  });

  it("rejeita convidado errado", async () => {
    const { code } = await createInvite(
      institutionA,
      hospitalA,
      sectorA,
      creator.userId,
      invitee.userId,
    );
    const session = await login(wrongUser.email);
    const declined = await declineInvite(code, cookieOf(session));
    expect(declined.status).toBe(403);
    expect(declined.body.error).toContain("não foi emitido para a sua conta");
  });

  it("rejeita convite expirado", async () => {
    const { code } = await createInvite(
      institutionA,
      hospitalA,
      sectorA,
      creator.userId,
      invitee.userId,
      { expiresAt: new Date(Date.now() - 60_000) },
    );
    const session = await login(invitee.email);
    const declined = await declineInvite(code, cookieOf(session));
    expect(declined.status).toBe(400);
    expect(declined.body.error).toContain("inválido ou expirado");
  });

  it("rejeita convite revogado", async () => {
    const { code } = await createInvite(
      institutionA,
      hospitalA,
      sectorA,
      creator.userId,
      invitee.userId,
      { revokedAt: new Date() },
    );
    const session = await login(invitee.email);
    const declined = await declineInvite(code, cookieOf(session));
    expect(declined.status).toBe(400);
    expect(declined.body.error).toContain("inválido ou expirado");
  });

  it("rejeita convite já aceito", async () => {
    const { code } = await createInvite(
      institutionA,
      hospitalA,
      sectorA,
      creator.userId,
      invitee.userId,
      { redeemedCount: 1 },
    );
    const session = await login(invitee.email);
    const declined = await declineInvite(code, cookieOf(session));
    expect(declined.status).toBe(400);
    expect(declined.body.error).toContain("inválido ou expirado");
  });

  it("rejeita segunda recusa com mensagem clara e sem segundo audit", async () => {
    const { inviteId, code } = await createInvite(
      institutionA,
      hospitalA,
      sectorA,
      creator.userId,
      invitee.userId,
    );
    const session = await login(invitee.email);
    const cookie = cookieOf(session);
    const first = await declineInvite(code, cookie);
    expect(first.status).toBe(200);

    const auditsAfterFirst = await db
      .select()
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.institutionId, institutionA),
          eq(auditTrail.entityId, invitee.userId),
          eq(auditTrail.description, "Convite nominal recusado"),
        ),
      );
    const declineAuditsFirst = auditsAfterFirst.filter((row) => {
      const metadata = row.metadata as { scheduleInviteId?: number } | null;
      return metadata?.scheduleInviteId === inviteId;
    });
    expect(declineAuditsFirst).toHaveLength(1);

    const second = await declineInvite(code, cookie);
    expect(second.status).toBe(400);
    expect(second.body.error).toBe("Este convite já foi recusado");

    const auditsAfterSecond = await db
      .select()
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.institutionId, institutionA),
          eq(auditTrail.entityId, invitee.userId),
          eq(auditTrail.description, "Convite nominal recusado"),
        ),
      );
    const declineAuditsSecond = auditsAfterSecond.filter((row) => {
      const metadata = row.metadata as { scheduleInviteId?: number } | null;
      return metadata?.scheduleInviteId === inviteId;
    });
    expect(declineAuditsSecond).toHaveLength(1);
    expect(inviteId).toBeGreaterThan(0);
  });

  it("convite recusado não pode ser resgatado depois", async () => {
    const { code } = await createInvite(
      institutionA,
      hospitalA,
      sectorA,
      creator.userId,
      invitee.userId,
    );
    const session = await login(invitee.email);
    const cookie = cookieOf(session);
    const declined = await declineInvite(code, cookie);
    expect(declined.status).toBe(200);

    const redeemed = await redeemInvite(code, cookie);
    expect(redeemed.status).toBe(400);
    expect(redeemed.body.error).toContain("inválido ou expirado");

    const [access] = await db
      .select()
      .from(professionalAccess)
      .where(eq(professionalAccess.professionalId, invitee.professionalId));
    expect(access).toBeUndefined();
  });

  it("outro convite do mesmo usuário não é afetado", async () => {
    const first = await createInvite(
      institutionA,
      hospitalA,
      sectorA,
      creator.userId,
      invitee.userId,
    );
    const second = await createInvite(
      institutionA,
      hospitalA,
      sectorA,
      creator.userId,
      invitee.userId,
    );
    const session = await login(invitee.email);
    const declined = await declineInvite(first.code, cookieOf(session));
    expect(declined.status).toBe(200);

    const firstRow = await inviteRow(first.inviteId);
    const secondRow = await inviteRow(second.inviteId);
    expect(firstRow?.declinedAt).not.toBeNull();
    expect(secondRow?.declinedAt).toBeNull();
    expect(secondRow?.revokedAt).toBeNull();
  });

  it("permite novo convite após recusa", async () => {
    const declinedInvite = await createInvite(
      institutionA,
      hospitalA,
      sectorA,
      creator.userId,
      invitee.userId,
    );
    const session = await login(invitee.email);
    const cookie = cookieOf(session);
    expect((await declineInvite(declinedInvite.code, cookie)).status).toBe(200);

    const fresh = await createInvite(
      institutionA,
      hospitalA,
      sectorA,
      creator.userId,
      invitee.userId,
    );
    const redeemed = await redeemInvite(fresh.code, cookie);
    expect(redeemed.status).toBe(200);

    const declinedRow = await inviteRow(declinedInvite.inviteId);
    expect(declinedRow?.revokedAt).toBeNull();
    expect(declinedRow?.declinedAt).not.toBeNull();
  });

  it("persiste audit sem código, hash ou token", async () => {
    const { inviteId, code } = await createInvite(
      institutionA,
      hospitalA,
      sectorA,
      creator.userId,
      invitee.userId,
    );
    const session = await login(invitee.email);
    const declined = await declineInvite(code, cookieOf(session));
    expect(declined.status).toBe(200);

    const audits = await db
      .select()
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.institutionId, institutionA),
          eq(auditTrail.entityId, invitee.userId),
          eq(auditTrail.description, "Convite nominal recusado"),
        ),
      );
    const audit = audits.find((row) => {
      const metadata = row.metadata as { scheduleInviteId?: number } | null;
      return metadata?.scheduleInviteId === inviteId;
    });
    expect(audit?.description).toBe("Convite nominal recusado");
    const metadata = audit?.metadata as Record<string, unknown>;
    expect(metadata).toMatchObject({
      scheduleInviteId: inviteId,
      institutionId: institutionA,
      hospitalId: hospitalA,
      sectorId: sectorA,
    });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toMatch(/token|hash|codigo|código|inviteCode/i);
  });

  it("corrida accept × decline: apenas um vence e nunca redeemedCount>0 com declinedAt", async () => {
    const localInvitee = await createIdentity("race-invitee", institutionA, {
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
    const cookie = cookieOf(session);

    const results = await Promise.allSettled([
      redeemInvite(code, cookie),
      declineInvite(code, cookie),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    expect(fulfilled).toHaveLength(2);
    const statuses = fulfilled.map(
      (result) =>
        (result as PromiseFulfilledResult<request.Response>).value.status,
    );
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 400)).toHaveLength(1);

    const row = await inviteRow(inviteId);
    const accepted = row?.redeemedCount === 1 && row.declinedAt == null;
    const declined = row?.declinedAt != null && row.redeemedCount === 0;
    expect(accepted || declined).toBe(true);
    expect(row?.redeemedCount === 1 && row.declinedAt != null).toBe(false);
  });

  it("registra invite_declined para o gestor emissor após recusa válida", async () => {
    const localInvitee = await createIdentity("push-invitee", institutionA, {
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
    const declined = await declineInvite(code, cookieOf(session));
    expect(declined.status).toBe(200);

    const rows = await notificationRowsForUsers([
      creator.userId,
      otherGestor.userId,
      gestorPlus.userId,
      localInvitee.userId,
      tenantBGestor.userId,
    ]);
    const creatorRows = rows.filter(
      (row) =>
        row.userId === creator.userId &&
        row.dedupKey === `schedule-invite:${inviteId}:declined:${creator.userId}`,
    );
    expect(creatorRows).toHaveLength(1);
    expect(creatorRows[0]?.dedupKey).toBe(
      `schedule-invite:${inviteId}:declined:${creator.userId}`,
    );
    expect(creatorRows[0]?.title).toBe("Convite recusado");

    const payloadData = (
      creatorRows[0]?.providerReceipt as {
        payloadData?: Record<string, unknown>;
      }
    )?.payloadData;
    expect(payloadData).toMatchObject({
      type: "invite_declined",
      institutionId: institutionA,
      scheduleInviteId: inviteId,
      hospitalId: hospitalA,
      sectorId: sectorA,
      invitedUserId: localInvitee.userId,
    });
    expect(payloadData).not.toHaveProperty("createdByUserId");
    expect(JSON.stringify(payloadData)).not.toMatch(/token|hash|codigo|código/i);

    expect(rows.some((row) => row.userId === otherGestor.userId)).toBe(false);
    expect(rows.some((row) => row.userId === gestorPlus.userId)).toBe(false);
    expect(rows.some((row) => row.userId === localInvitee.userId)).toBe(false);
  });

  it("isola tenant no push: gestor de outra instituição não recebe", async () => {
    const localInvitee = await createIdentity("tenant-isolation", institutionA, {
      roleInInstitution: "USER",
      hospitalId: hospitalA,
      sectorId: sectorA,
      withAccess: false,
    });
    const { code } = await createInvite(
      institutionA,
      hospitalA,
      sectorA,
      creator.userId,
      localInvitee.userId,
    );
    const session = await login(localInvitee.email);
    expect((await declineInvite(code, cookieOf(session))).status).toBe(200);

    const rows = await notificationRowsForUsers([tenantBGestor.userId]);
    expect(rows).toHaveLength(0);
  });

  it("mantém recusa commitada quando criador perdeu vínculo ativo", async () => {
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
    const declined = await declineInvite(code, cookieOf(session));
    expect(declined.status).toBe(200);

    const row = await inviteRow(inviteId);
    expect(row?.declinedAt).not.toBeNull();

    const rows = await notificationRowsForUsers([inactiveCreator.userId]);
    expect(rows).toHaveLength(0);
  });

  async function expectSuccessfulDeclineAfterSignalFailure(input: {
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
    const declined = await declineInvite(code, cookieOf(session));
    expect(declined.status).toBe(200);
    const row = await inviteRow(inviteId);
    expect(row?.declinedAt).not.toBeNull();
    return inviteId;
  }

  it("mantém recusa commitada quando a resolução do destinatário falha", async () => {
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
      await expectSuccessfulDeclineAfterSignalFailure({
        creatorUserId: localCreator.userId,
        invitee: localInvitee,
      });
    } finally {
      spy.mockRestore();
    }
    const rows = await notificationRowsForUsers([localCreator.userId]);
    expect(rows).toHaveLength(0);
  });

  it("mantém recusa commitada quando o carregamento do nome falha", async () => {
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
      await expectSuccessfulDeclineAfterSignalFailure({
        creatorUserId: localCreator.userId,
        invitee: localInvitee,
      });
    } finally {
      spy.mockRestore();
    }
    const rows = await notificationRowsForUsers([localCreator.userId]);
    expect(rows).toHaveLength(0);
  });

  it("mantém recusa commitada quando o outbox falha", async () => {
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
      await expectSuccessfulDeclineAfterSignalFailure({
        creatorUserId: localCreator.userId,
        invitee: localInvitee,
      });
    } finally {
      spy.mockRestore();
    }
    const rows = await notificationRowsForUsers([localCreator.userId]);
    expect(rows).toHaveLength(0);
  });

  it("pendingNamedInviteCoversScale ignora convite recusado", async () => {
    const localInvitee = await createIdentity("pending-invitee", institutionA, {
      roleInInstitution: "USER",
      hospitalId: hospitalA,
      sectorId: sectorA,
      withAccess: false,
    });
    const { code } = await createInvite(
      institutionA,
      hospitalA,
      sectorA,
      creator.userId,
      localInvitee.userId,
    );
    const before = await pendingNamedInviteCoversScale(db, {
      institutionId: institutionA,
      hospitalId: hospitalA,
      sectorId: sectorA,
      userId: localInvitee.userId,
    });
    expect(before).toBe(true);

    const session = await login(localInvitee.email);
    expect((await declineInvite(code, cookieOf(session))).status).toBe(200);

    const after = await pendingNamedInviteCoversScale(db, {
      institutionId: institutionA,
      hospitalId: hospitalA,
      sectorId: sectorA,
      userId: localInvitee.userId,
    });
    expect(after).toBe(false);
  });

  it("listActive exclui convites recusados", async () => {
    const localInvitee = await createIdentity("list-active", institutionA, {
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
    expect((await declineInvite(code, cookieOf(session))).status).toBe(200);

    const activeRows = await db
      .select({ id: scheduleInvites.id })
      .from(scheduleInvites)
      .where(
        and(
          eq(scheduleInvites.institutionId, institutionA),
          isNull(scheduleInvites.revokedAt),
          isNull(scheduleInvites.declinedAt),
        ),
      );
    expect(activeRows.some((row) => row.id === inviteId)).toBe(false);
  });

  it("reenvio não revoga convite já recusado", async () => {
    const localInvitee = await createIdentity("reenvio", institutionA, {
      roleInInstitution: "USER",
      hospitalId: hospitalA,
      sectorId: sectorA,
      withAccess: false,
    });
    const declinedInvite = await createInvite(
      institutionA,
      hospitalA,
      sectorA,
      creator.userId,
      localInvitee.userId,
    );
    const session = await login(localInvitee.email);
    expect((await declineInvite(declinedInvite.code, cookieOf(session))).status).toBe(200);

    const newCode = generateScheduleInviteCode();
    const [newInvite] = await db
      .insert(scheduleInvites)
      .values({
        institutionId: institutionA,
        hospitalId: hospitalA,
        sectorId: sectorA,
        codeHash: hashScheduleInviteCode(normalizeScheduleInviteCode(newCode)),
        createdByUserId: creator.userId,
        invitedUserId: localInvitee.userId,
        invitedEmail: localInvitee.email,
        maxRedemptions: 1,
        expiresAt: new Date(Date.now() + 86_400_000),
      })
      .$returningId();

    await db
      .update(scheduleInvites)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(scheduleInvites.institutionId, institutionA),
          eq(scheduleInvites.hospitalId, hospitalA),
          eq(scheduleInvites.sectorId, sectorA),
          eq(scheduleInvites.invitedUserId, localInvitee.userId),
          isNull(scheduleInvites.revokedAt),
          isNull(scheduleInvites.declinedAt),
          sql`${scheduleInvites.id} <> ${newInvite.id}`,
        ),
      );

    const declinedRow = await inviteRow(declinedInvite.inviteId);
    expect(declinedRow?.revokedAt).toBeNull();
    expect(declinedRow?.declinedAt).not.toBeNull();
  });
});
