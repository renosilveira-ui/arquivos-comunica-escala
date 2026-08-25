import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, or } from "drizzle-orm";
import bcrypt from "bcryptjs";
import express, { type Express } from "express";
import request from "supertest";
import {
  auditTrail,
  hospitals,
  institutions,
  passwordResets,
  professionalAccess,
  professionalInstitutions,
  professionals,
  pushTokens,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../drizzle/schema";
import { sdk } from "../server/_core/sdk";
import { sessionInstanceProof } from "../server/_core/session-instance";
import * as auditService from "../server/audit-trail";
import * as dbService from "../server/db";
import { getDb } from "../server/db";
import { mailer } from "../server/mailer";
import { authRouter } from "../server/routes/auth";
import {
  ASSIGNMENT_WRITE_TRANSACTION_CONFIG,
  assertAssignmentWritesAllowedForUpdate,
} from "../server/shift-validations-v2";

const STAMP = Date.now();
const PASSWORD = "SenhaOriginal123";

function resetHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

describe("auth hardening adversarial", () => {
  let app: Express;
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let deleteRaceShiftId: number;
  const userIds: number[] = [];
  const usersByKind = new Map<string, { id: number; email: string }>();
  const professionalsByKind = new Map<string, number>();

  const cookieOf = (response: request.Response): string => {
    const raw = response.headers["set-cookie"];
    return (
      (Array.isArray(raw) ? raw : [raw]).find((value: string) =>
        value?.startsWith("session="),
      ) ?? ""
    );
  };

  const login = (email: string, password = PASSWORD) =>
    request(app).post("/api/auth/login").send({ email, password });

  const sessionInstanceForCookie = (cookie: string): string => {
    const token = cookie.match(/(?:^|;\s*)session=([^;]+)/)?.[1];
    if (!token) throw new Error("Cookie de sessão ausente no teste");
    return sessionInstanceProof(token);
  };

  const sessionInstanceOf = async (cookie: string): Promise<string> => {
    const response = await request(app)
      .get("/api/auth/me")
      .set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body.sessionInstance).toMatch(/^v1\.[A-Za-z0-9_-]{43}$/);
    return response.body.sessionInstance as string;
  };

  beforeAll(async () => {
    const connection = await getDb();
    if (!connection) throw new Error("Database not available");
    db = connection;

    app = express();
    app.use(express.json());
    app.use("/api/auth", authRouter);
    app.get("/api/operational-probe", async (req, res) => {
      try {
        const user = await sdk.authenticateRequest(req);
        res.json({ userId: user.id });
      } catch {
        res.status(403).json({ error: "forbidden" });
      }
    });

    const [institution] = await db
      .insert(institutions)
      .values({
        name: `Auth hardening ${STAMP}`,
        cnpj: `${STAMP}41`.slice(-14).padStart(14, "0"),
        legalName: `Auth hardening ${STAMP}`,
        tradeName: `AH${STAMP}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = institution.id;

    const [hospital] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Auth hardening hospital ${STAMP}` })
      .$returningId();
    hospitalId = hospital.id;
    const [sector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `Auth hardening sector ${STAMP}`,
        category: "cirurgico",
        color: "#2255AA",
        minStaffCount: 1,
      })
      .$returningId();
    sectorId = sector.id;

    for (const kind of [
      "change",
      "change-reset",
      "reset",
      "must",
      "orphan",
      "forgot-race",
      "revoked-link",
      "delete-race",
    ] as const) {
      const email = `auth-hardening-${kind}-${STAMP}@test.local`;
      const [user] = await db
        .insert(users)
        .values({
          name: `Auth ${kind}`,
          email,
          passwordHash: await bcrypt.hash(PASSWORD, 4),
          loginMethod: "email",
          role: "doctor",
        })
        .$returningId();
      usersByKind.set(kind, { id: user.id, email });
      userIds.push(user.id);

      if (kind !== "orphan") {
        const [professional] = await db
          .insert(professionals)
          .values({
            userId: user.id,
            name: `Auth ${kind}`,
            role: "Médico",
            userRole: "USER",
          })
          .$returningId();
        professionalsByKind.set(kind, professional.id);
        await db.insert(professionalInstitutions).values({
          professionalId: professional.id,
          userId: user.id,
          institutionId,
          roleInInstitution: "USER",
          isPrimary: true,
          active: true,
        });
        if (kind === "delete-race") {
          await db.insert(professionalAccess).values({
            institutionId,
            professionalId: professional.id,
            hospitalId,
            sectorId,
            canAccess: true,
          });
        }
      }
    }

    const startAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId,
        sectorId,
        label: `Auth delete race ${STAMP}`,
        startAt,
        endAt: new Date(startAt.getTime() + 12 * 60 * 60 * 1000),
        status: "VAGO",
      })
      .$returningId();
    deleteRaceShiftId = shift.id;
  });

  afterAll(async () => {
    await db
      .delete(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.shiftInstanceId, deleteRaceShiftId));
    await db
      .delete(shiftInstances)
      .where(eq(shiftInstances.id, deleteRaceShiftId));
    await db
      .delete(passwordResets)
      .where(inArray(passwordResets.userId, userIds));
    await db.delete(pushTokens).where(inArray(pushTokens.userId, userIds));
    await db
      .delete(auditTrail)
      .where(
        or(
          inArray(auditTrail.actorUserId, userIds),
          inArray(auditTrail.entityId, userIds),
        ),
      );
    await db
      .delete(professionalAccess)
      .where(
        inArray(professionalAccess.professionalId, [
          ...professionalsByKind.values(),
        ]),
      );
    await db
      .delete(professionalInstitutions)
      .where(inArray(professionalInstitutions.userId, userIds));
    await db
      .delete(professionals)
      .where(inArray(professionals.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
    await db.delete(sectors).where(eq(sectors.id, sectorId));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
  });

  it("login concorrente de conta órfã é read-only e não altera a instituição legada", async () => {
    const orphan = usersByKind.get("orphan")!;
    const [originalLegacyInstitution] = await db
      .select()
      .from(institutions)
      .where(eq(institutions.id, 1))
      .limit(1);
    const insertedLegacyInstitution = !originalLegacyInstitution;
    if (insertedLegacyInstitution) {
      await db.insert(institutions).values({
        id: 1,
        name: `Tenant legado protegido ${STAMP}`,
        cnpj: `${STAMP}49`.slice(-14).padStart(14, "0"),
        legalName: `Tenant legado protegido ${STAMP}`,
        tradeName: `TLP${STAMP}`.slice(0, 20),
        isActive: true,
        metadata: { protectedByTest: STAMP },
      });
    } else {
      await db
        .update(institutions)
        .set({
          name: `Tenant legado protegido ${STAMP}`,
          legalName: `Tenant legado protegido ${STAMP}`,
          tradeName: `TLP${STAMP}`.slice(0, 20),
          metadata: { protectedByTest: STAMP },
        })
        .where(eq(institutions.id, 1));
    }

    const [protectedSnapshot] = await db
      .select({
        name: institutions.name,
        cnpj: institutions.cnpj,
        legalName: institutions.legalName,
        tradeName: institutions.tradeName,
        isActive: institutions.isActive,
        metadata: institutions.metadata,
      })
      .from(institutions)
      .where(eq(institutions.id, 1))
      .limit(1);

    try {
      const [first, second] = await Promise.all([
        login(orphan.email),
        login(orphan.email),
      ]);
      expect([first.status, second.status]).toEqual([200, 200]);

      expect(
        await db
          .select({ id: professionals.id })
          .from(professionals)
          .where(eq(professionals.userId, orphan.id)),
      ).toHaveLength(0);
      expect(
        await db
          .select({ id: professionalInstitutions.id })
          .from(professionalInstitutions)
          .where(eq(professionalInstitutions.userId, orphan.id)),
      ).toHaveLength(0);

      const [after] = await db
        .select({
          name: institutions.name,
          cnpj: institutions.cnpj,
          legalName: institutions.legalName,
          tradeName: institutions.tradeName,
          isActive: institutions.isActive,
          metadata: institutions.metadata,
        })
        .from(institutions)
        .where(eq(institutions.id, 1))
        .limit(1);
      expect(after).toEqual(protectedSnapshot);
    } finally {
      if (insertedLegacyInstitution) {
        await db.delete(institutions).where(eq(institutions.id, 1));
      } else {
        await db
          .update(institutions)
          .set({
            name: originalLegacyInstitution.name,
            cnpj: originalLegacyInstitution.cnpj,
            legalName: originalLegacyInstitution.legalName,
            tradeName: originalLegacyInstitution.tradeName,
            isActive: originalLegacyInstitution.isActive,
            metadata: originalLegacyInstitution.metadata,
          })
          .where(eq(institutions.id, 1));
      }
    }
  });

  it("credenciais de conta órfã ou PI adulterada falham sem write nem audit no tenant 1", async () => {
    const orphan = usersByKind.get("orphan")!;
    let poisonedProfessionalId: number | null = null;
    const session = await login(orphan.email);
    expect(session.status).toBe(200);
    const cookie = cookieOf(session);
    const [before] = await db
      .select({
        passwordHash: users.passwordHash,
        sessionVersion: users.sessionVersion,
        deletedAt: users.deletedAt,
      })
      .from(users)
      .where(eq(users.id, orphan.id));
    const sendSpy = vi
      .spyOn(mailer, "sendMail")
      .mockResolvedValue({ delivered: false, transport: "console" });

    const assertNoCredentialWrite = async () => {
      const [current] = await db
        .select({
          passwordHash: users.passwordHash,
          sessionVersion: users.sessionVersion,
          deletedAt: users.deletedAt,
        })
        .from(users)
        .where(eq(users.id, orphan.id));
      expect(current).toEqual(before);
      expect(
        await db
          .select({ id: passwordResets.id })
          .from(passwordResets)
          .where(eq(passwordResets.userId, orphan.id)),
      ).toHaveLength(0);
      expect(
        await db
          .select({ id: auditTrail.id })
          .from(auditTrail)
          .where(eq(auditTrail.entityId, orphan.id)),
      ).toHaveLength(0);
      expect(
        await db
          .select({ id: auditTrail.id })
          .from(auditTrail)
          .where(
            and(
              eq(auditTrail.entityId, orphan.id),
              eq(auditTrail.institutionId, 1),
            ),
          ),
      ).toHaveLength(0);
    };

    try {
      const sessionInstance = await sessionInstanceOf(cookie);
      const change = await request(app)
        .post("/api/auth/change-password")
        .set("Cookie", cookie)
        .set("x-client-session-instance", sessionInstance)
        .send({ currentPassword: PASSWORD, newPassword: "SenhaOrfaNegada123" });
      expect(change.status).toBe(409);
      const deletion = await request(app)
        .delete("/api/auth/me")
        .set("Cookie", cookie)
        .set("x-client-session-instance", sessionInstance)
        .send({ password: PASSWORD });
      expect(deletion.status).toBe(409);
      expect(
        (
          await request(app)
            .post("/api/auth/forgot-password")
            .send({ email: orphan.email })
        ).body,
      ).toEqual({ ok: true });
      expect(sendSpy).not.toHaveBeenCalled();

      const orphanResetToken = `orphan-reset-${STAMP}`;
      await db.insert(passwordResets).values({
        userId: orphan.id,
        tokenHash: resetHash(orphanResetToken),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      });
      const orphanReset = await request(app)
        .post("/api/auth/reset-password")
        .send({
          token: orphanResetToken,
          newPassword: "SenhaOrfaResetNegada123",
        });
      expect(orphanReset.status).toBe(400);
      expect(
        await db
          .select({ usedAt: passwordResets.usedAt })
          .from(passwordResets)
          .where(eq(passwordResets.userId, orphan.id)),
      ).toEqual([{ usedAt: null }]);
      await db
        .delete(passwordResets)
        .where(eq(passwordResets.userId, orphan.id));
      await assertNoCredentialWrite();

      const [poisonedProfessional] = await db
        .insert(professionals)
        .values({
          userId: usersByKind.get("change")!.id,
          name: `Professional adulterado ${STAMP}`,
          role: "Médico",
          userRole: "USER",
        })
        .$returningId();
      poisonedProfessionalId = poisonedProfessional.id;
      await db.insert(professionalInstitutions).values({
        userId: orphan.id,
        professionalId: poisonedProfessionalId,
        institutionId,
        roleInInstitution: "USER",
        isPrimary: true,
        active: true,
      });
      const poisonedChange = await request(app)
        .post("/api/auth/change-password")
        .set("Cookie", cookie)
        .set("x-client-session-instance", sessionInstance)
        .send({
          currentPassword: PASSWORD,
          newPassword: "SenhaPIFalsaNegada123",
        });
      expect(poisonedChange.status).toBe(409);
      expect(
        (
          await request(app)
            .post("/api/auth/forgot-password")
            .send({ email: orphan.email })
        ).body,
      ).toEqual({ ok: true });
      expect(sendSpy).not.toHaveBeenCalled();
      await assertNoCredentialWrite();
    } finally {
      sendSpy.mockRestore();
      await db
        .delete(professionalInstitutions)
        .where(eq(professionalInstitutions.userId, orphan.id));
      if (poisonedProfessionalId !== null) {
        await db
          .delete(professionals)
          .where(eq(professionals.id, poisonedProfessionalId));
      }
    }
  });

  it("revogação concorrente da PI canônica aborta a troca antes de senha/reset/audit", async () => {
    const target = usersByKind.get("revoked-link")!;
    const session = await login(target.email);
    expect(session.status).toBe(200);
    const sessionInstance = await sessionInstanceOf(cookieOf(session));
    const [before] = await db
      .select({
        passwordHash: users.passwordHash,
        sessionVersion: users.sessionVersion,
      })
      .from(users)
      .where(eq(users.id, target.id));
    const newPassword = "SenhaComPIRevogada123";
    const originalHash = bcrypt.hash.bind(bcrypt);
    let signalHashStarted!: () => void;
    let releaseHash!: () => void;
    const hashStarted = new Promise<void>((resolve) => {
      signalHashStarted = resolve;
    });
    const hashGate = new Promise<void>((resolve) => {
      releaseHash = resolve;
    });
    const hashSpy = vi.spyOn(bcrypt, "hash").mockImplementation((async (
      value: string,
      rounds: string | number,
    ) => {
      if (value === newPassword) {
        signalHashStarted();
        await hashGate;
      }
      return originalHash(value, rounds);
    }) as typeof bcrypt.hash);

    try {
      const change = request(app)
        .post("/api/auth/change-password")
        .set("Cookie", cookieOf(session))
        .set("x-client-session-instance", sessionInstance)
        .send({ currentPassword: PASSWORD, newPassword })
        .then((response) => response);
      await hashStarted;
      await db
        .update(professionalInstitutions)
        .set({ active: false })
        .where(eq(professionalInstitutions.userId, target.id));
      releaseHash();

      const response = await change;
      expect(response.status).toBe(409);
      expect(
        await db
          .select({
            passwordHash: users.passwordHash,
            sessionVersion: users.sessionVersion,
          })
          .from(users)
          .where(eq(users.id, target.id)),
      ).toEqual([before]);
      expect(
        await db
          .select({ id: passwordResets.id })
          .from(passwordResets)
          .where(eq(passwordResets.userId, target.id)),
      ).toHaveLength(0);
      expect(
        await db
          .select({ id: auditTrail.id })
          .from(auditTrail)
          .where(eq(auditTrail.entityId, target.id)),
      ).toHaveLength(0);
    } finally {
      releaseHash();
      hashSpy.mockRestore();
      await db
        .update(professionalInstitutions)
        .set({ active: true })
        .where(eq(professionalInstitutions.userId, target.id));
    }
  });

  it("forgot in-flight não recria link depois que change-password revoga a credencial", async () => {
    const target = usersByKind.get("forgot-race")!;
    const session = await login(target.email);
    expect(session.status).toBe(200);
    const sessionInstance = await sessionInstanceOf(cookieOf(session));
    const newPassword = "SenhaVencedoraForgotRace123";
    const originalGetUserByEmail = dbService.getUserByEmail;
    let signalSnapshotRead!: () => void;
    let releaseForgot!: () => void;
    const snapshotRead = new Promise<void>((resolve) => {
      signalSnapshotRead = resolve;
    });
    const forgotGate = new Promise<void>((resolve) => {
      releaseForgot = resolve;
    });
    let gated = false;
    const userSpy = vi
      .spyOn(dbService, "getUserByEmail")
      .mockImplementation(async (email: string) => {
        const user = await originalGetUserByEmail(email);
        if (!gated && email === target.email) {
          gated = true;
          signalSnapshotRead();
          await forgotGate;
        }
        return user;
      });
    const sendSpy = vi
      .spyOn(mailer, "sendMail")
      .mockResolvedValue({ delivered: false, transport: "console" });

    try {
      const forgot = request(app)
        .post("/api/auth/forgot-password")
        .send({ email: target.email })
        .then((response) => response);
      await snapshotRead;
      const change = await request(app)
        .post("/api/auth/change-password")
        .set("Cookie", cookieOf(session))
        .set("x-client-session-instance", sessionInstance)
        .send({ currentPassword: PASSWORD, newPassword });
      expect(change.status).toBe(200);
      releaseForgot();

      const forgotResponse = await forgot;
      expect(forgotResponse.status).toBe(200);
      expect(forgotResponse.body).toEqual({ ok: true });
      expect(sendSpy).not.toHaveBeenCalled();
      expect(
        await db
          .select({ id: passwordResets.id })
          .from(passwordResets)
          .where(eq(passwordResets.userId, target.id)),
      ).toHaveLength(0);
      expect(
        await db
          .select({ id: auditTrail.id })
          .from(auditTrail)
          .where(
            and(
              eq(auditTrail.entityId, target.id),
              eq(
                auditTrail.description,
                "Pedido de redefinição de senha (esqueci minha senha)",
              ),
            ),
          ),
      ).toHaveLength(0);
      expect((await login(target.email, newPassword)).status).toBe(200);
    } finally {
      releaseForgot();
      userSpy.mockRestore();
      sendSpy.mockRestore();
    }
  });

  it("duas trocas concorrentes não sobrescrevem a credencial vencedora", async () => {
    const target = usersByKind.get("change")!;
    const session = await login(target.email);
    const cookie = cookieOf(session);
    const sessionInstance = await sessionInstanceOf(cookie);
    const candidateA = "SenhaConcorrenteA123";
    const candidateB = "SenhaConcorrenteB123";

    const responses = await Promise.all([
      request(app)
        .post("/api/auth/change-password")
        .set("Cookie", cookie)
        .set("x-client-session-instance", sessionInstance)
        .send({ currentPassword: PASSWORD, newPassword: candidateA }),
      request(app)
        .post("/api/auth/change-password")
        .set("Cookie", cookie)
        .set("x-client-session-instance", sessionInstance)
        .send({ currentPassword: PASSWORD, newPassword: candidateB }),
    ]);
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(
      statuses.filter((status) => status === 401 || status === 409),
    ).toHaveLength(1);

    const [current] = await db
      .select({
        passwordHash: users.passwordHash,
        sessionVersion: users.sessionVersion,
      })
      .from(users)
      .where(eq(users.id, target.id));
    const validCandidates = await Promise.all([
      bcrypt.compare(candidateA, current.passwordHash!),
      bcrypt.compare(candidateB, current.passwordHash!),
    ]);
    expect(validCandidates.filter(Boolean)).toHaveLength(1);
    expect(current.sessionVersion).toBe(2);
  });

  it("troca de senha invalida todos os links de reset no mesmo commit auditado", async () => {
    const target = usersByKind.get("change-reset")!;
    const token = `change-reset-primary-${STAMP}`;
    const usedToken = `change-reset-used-${STAMP}`;
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await db.insert(passwordResets).values([
      { userId: target.id, tokenHash: resetHash(token), expiresAt },
      {
        userId: target.id,
        tokenHash: resetHash(usedToken),
        expiresAt,
        usedAt: new Date(),
      },
    ]);

    const session = await login(target.email);
    expect(session.status).toBe(200);
    const sessionInstance = await sessionInstanceOf(cookieOf(session));
    const newPassword = "SenhaTrocaInvalidaReset123";
    const change = await request(app)
      .post("/api/auth/change-password")
      .set("Cookie", cookieOf(session))
      .set("x-client-session-instance", sessionInstance)
      .send({ currentPassword: PASSWORD, newPassword });
    expect(change.status).toBe(200);

    expect(
      await db
        .select({ id: passwordResets.id })
        .from(passwordResets)
        .where(eq(passwordResets.userId, target.id)),
    ).toHaveLength(0);
    const staleReset = await request(app)
      .post("/api/auth/reset-password")
      .send({ token, newPassword: "SenhaQueNaoPodeVencer123" });
    expect(staleReset.status).toBe(400);
    expect((await login(target.email, newPassword)).status).toBe(200);

    const [audit] = await db
      .select({ metadata: auditTrail.metadata })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.entityId, target.id),
          eq(auditTrail.description, "Senha alterada pelo próprio usuário"),
        ),
      );
    expect(audit.metadata).toMatchObject({
      sessionVersionBefore: 1,
      sessionVersionAfter: 2,
      invalidatedPasswordResetCount: 2,
    });
  });

  it("consome um reset uma única vez e invalida todos os links irmãos", async () => {
    const target = usersByKind.get("reset")!;
    const token = `primary-${STAMP}`;
    const sibling = `sibling-${STAMP}`;
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await db.insert(passwordResets).values([
      { userId: target.id, tokenHash: resetHash(token), expiresAt },
      { userId: target.id, tokenHash: resetHash(sibling), expiresAt },
    ]);

    const candidateA = "SenhaResetConcorrenteA123";
    const candidateB = "SenhaResetConcorrenteB123";
    const responses = await Promise.all([
      request(app)
        .post("/api/auth/reset-password")
        .send({ token, newPassword: candidateA }),
      request(app)
        .post("/api/auth/reset-password")
        .send({ token, newPassword: candidateB }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 400,
    ]);

    const siblingAttempt = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: sibling, newPassword: "SenhaResetIrmao123" });
    expect(siblingAttempt.status).toBe(400);

    const resets = await db
      .select({ usedAt: passwordResets.usedAt })
      .from(passwordResets)
      .where(eq(passwordResets.userId, target.id));
    expect(resets).toHaveLength(2);
    expect(resets.every((row) => row.usedAt !== null)).toBe(true);
    const [current] = await db
      .select({
        passwordHash: users.passwordHash,
        sessionVersion: users.sessionVersion,
      })
      .from(users)
      .where(eq(users.id, target.id));
    const validCandidates = await Promise.all([
      bcrypt.compare(candidateA, current.passwordHash!),
      bcrypt.compare(candidateB, current.passwordHash!),
    ]);
    expect(validCandidates.filter(Boolean)).toHaveLength(1);
    expect(current.sessionVersion).toBe(2);
  });

  it("mustChangePassword libera só me/change/logout e logout respeita o dono do token", async () => {
    const target = usersByKind.get("must")!;
    const foreign = usersByKind.get("change")!;
    await db
      .update(users)
      .set({ mustChangePassword: true })
      .where(eq(users.id, target.id));
    const session = await login(target.email);
    const cookie = cookieOf(session);
    expect(session.body.user.mustChangePassword).toBe(true);

    const ownToken = `ExponentPushToken[own-${STAMP}]`;
    const foreignToken = `ExponentPushToken[foreign-${STAMP}]`;
    await db.insert(pushTokens).values([
      { institutionId, userId: target.id, token: ownToken, platform: "ios" },
      {
        institutionId,
        userId: foreign.id,
        token: foreignToken,
        platform: "ios",
      },
    ]);

    const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(me.status).toBe(200);
    expect(me.body.user.mustChangePassword).toBe(true);
    const exactSessionInstance = sessionInstanceForCookie(cookie);
    expect(me.body.sessionInstance).toBe(exactSessionInstance);
    expect(
      (await request(app).get("/api/operational-probe").set("Cookie", cookie))
        .status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .delete("/api/auth/me")
          .set("Cookie", cookie)
          .set("x-client-session-instance", exactSessionInstance)
          .send({ password: PASSWORD })
      ).status,
    ).toBe(401);

    await request(app)
      .post("/api/auth/logout")
      .send({ pushToken: foreignToken });
    const foreignCleanupAttempt = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", cookie)
      .send({ pushToken: foreignToken });
    expect(foreignCleanupAttempt.status).toBe(200);
    expect(
      await db
        .select({ id: pushTokens.id })
        .from(pushTokens)
        .where(eq(pushTokens.token, foreignToken)),
    ).toHaveLength(1);

    // O primeiro logout revogou a sessão inteira. Uma autenticação nova é
    // necessária para provar ownership e remover o token deste aparelho.
    const ownCleanupSession = await login(target.email);
    const ownCleanup = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", cookieOf(ownCleanupSession))
      .send({ pushToken: ownToken });
    expect(ownCleanup.status).toBe(200);
    expect(
      await db
        .select({ id: pushTokens.id })
        .from(pushTokens)
        .where(eq(pushTokens.token, ownToken)),
    ).toHaveLength(0);

    const changeSession = await login(target.email);
    const changeSessionCookie = cookieOf(changeSession);
    const changeSessionInstance = await sessionInstanceOf(changeSessionCookie);
    const change = await request(app)
      .post("/api/auth/change-password")
      .set("Cookie", changeSessionCookie)
      .set("x-client-session-instance", changeSessionInstance)
      .send({
        currentPassword: PASSWORD,
        newPassword: "SenhaObrigatoriaNova123",
      });
    expect(change.status).toBe(200);
    expect(
      (
        await request(app)
          .get("/api/operational-probe")
          .set("Cookie", cookieOf(change))
      ).status,
    ).toBe(200);
  });

  it("serializa DELETE /me contra escritor de alocação sem deadlock nem usuário excluído escalado", async () => {
    const target = usersByKind.get("delete-race")!;
    const professionalId = professionalsByKind.get("delete-race")!;
    const session = await login(target.email);
    const cookie = cookieOf(session);
    expect(session.status).toBe(200);
    const sessionInstance = await sessionInstanceOf(cookie);

    const [shift] = await db
      .select({
        id: shiftInstances.id,
        institutionId: shiftInstances.institutionId,
        hospitalId: shiftInstances.hospitalId,
        sectorId: shiftInstances.sectorId,
        specialty: shiftInstances.specialty,
        startAt: shiftInstances.startAt,
        endAt: shiftInstances.endAt,
      })
      .from(shiftInstances)
      .where(eq(shiftInstances.id, deleteRaceShiftId));
    expect(shift).toBeDefined();

    let signalShiftLocked!: () => void;
    let releaseWriter!: () => void;
    const shiftLocked = new Promise<void>((resolve) => {
      signalShiftLocked = resolve;
    });
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let signalDeleteAtAudit!: () => void;
    let releaseDelete!: () => void;
    const deleteAtAudit = new Promise<void>((resolve) => {
      signalDeleteAtAudit = resolve;
    });
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });

    const originalRecordAudit = auditService.recordAudit;
    const auditSpy = vi
      .spyOn(auditService, "recordAudit")
      .mockImplementationOnce((async (
        ...args: Parameters<typeof auditService.recordAudit>
      ) => {
        signalDeleteAtAudit();
        await deleteGate;
        await originalRecordAudit(...args);
      }) as typeof auditService.recordAudit);

    let writerSettled = false;
    const writer = db
      .transaction(async (tx) => {
        const [lockedShift] = await tx
          .select({ id: shiftInstances.id })
          .from(shiftInstances)
          .where(eq(shiftInstances.id, shift.id))
          .limit(1)
          .for("update");
        expect(lockedShift?.id).toBe(shift.id);
        signalShiftLocked();
        await writerGate;

        await assertAssignmentWritesAllowedForUpdate(tx, [
          {
            professionalId,
            expectedUserId: target.id,
            institutionId: shift.institutionId,
            hospitalId: shift.hospitalId,
            sectorId: shift.sectorId,
            startAt: shift.startAt,
            endAt: shift.endAt,
            requiredSpecialty: shift.specialty,
          },
        ]);
        await tx.insert(shiftAssignmentsV2).values({
          shiftInstanceId: shift.id,
          institutionId: shift.institutionId,
          hospitalId: shift.hospitalId,
          sectorId: shift.sectorId,
          professionalId,
          assignmentType: "ON_DUTY",
          status: "PENDENTE",
          isActive: true,
        });
      }, ASSIGNMENT_WRITE_TRANSACTION_CONFIG)
      .finally(() => {
        writerSettled = true;
      });

    try {
      await shiftLocked;
      const deletion = request(app)
        .delete("/api/auth/me")
        .set("Cookie", cookie)
        .set("x-client-session-instance", sessionInstance)
        .send({ password: PASSWORD })
        .then((response) => response);
      await deleteAtAudit;

      releaseWriter();
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(writerSettled).toBe(false);

      releaseDelete();
      const [deleteResponse, writerResult] = await Promise.all([
        deletion,
        writer.then(
          () => ({ status: "fulfilled" as const }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        ),
      ]);
      expect(deleteResponse.status).toBe(200);
      expect(writerResult.status).toBe("rejected");
      if (writerResult.status === "rejected") {
        expect(String(writerResult.reason)).toMatch(
          /inativo|aprovado|inexistente/i,
        );
      }
    } finally {
      releaseWriter();
      releaseDelete();
      auditSpy.mockRestore();
    }

    const [deleted] = await db
      .select({ deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, target.id));
    expect(deleted.deletedAt).not.toBeNull();
    expect(
      await db
        .select({ id: shiftAssignmentsV2.id })
        .from(shiftAssignmentsV2)
        .where(
          and(
            eq(shiftAssignmentsV2.shiftInstanceId, shift.id),
            eq(shiftAssignmentsV2.professionalId, professionalId),
            eq(shiftAssignmentsV2.isActive, true),
          ),
        ),
    ).toHaveLength(0);
  });
});
