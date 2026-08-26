import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request from "supertest";
import express, { type Express } from "express";
import { authRouter } from "../server/routes/auth";
import { adminRouter } from "../server/routes/admin";
import * as auditService from "../server/audit-trail";
import { mailer } from "../server/mailer";
import { getDb } from "../server/db";
import { sessionInstanceProof } from "../server/_core/session-instance";
import {
  users,
  professionals,
  professionalInstitutions,
  institutions,
  hospitals,
  sectors,
  shiftInstances,
  shiftAssignmentsV2,
  passwordResets,
  pushTokens,
  auditTrail,
} from "../drizzle/schema";

/**
 * Frente A3 — redefinir senha, "esqueci minha senha" e exclusão de conta.
 *
 * Cobertura:
 *   1. forgot-password responde 200 neutro para e-mail inexistente e existente
 *   2. token do e-mail → reset-password → login com a senha nova funciona
 *   3. token já usado e token expirado são rejeitados
 *   4. admin reset → login devolve mustChangePassword → change-password limpa
 *   5. DELETE /me bloqueado (409) com plantão futuro alocado
 *   6. DELETE /me ok: anonimiza, desativa vínculo, apaga push token, login falha
 */

const STAMP = Date.now();
const PASSWORD = "SenhaOriginal123";
const NEW_PASSWORD = "SenhaNovaForte456";

const EMAILS = {
  doctor: `a3-doctor-${STAMP}@test.local`,
  admin: `a3-admin-${STAMP}@test.local`,
  busy: `a3-busy-${STAMP}@test.local`,
  leaving: `a3-leaving-${STAMP}@test.local`,
};

describe("auth: forgot/reset password, admin reset, account deletion", () => {
  let app: Express;
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  const userIds: Record<keyof typeof EMAILS, number> = {
    doctor: 0,
    admin: 0,
    busy: 0,
    leaving: 0,
  };
  const extraUserIds: number[] = [];
  const extraInstitutionIds: number[] = [];
  const professionalIds: number[] = [];
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let shiftInstanceId: number;

  async function createUser(
    key: keyof typeof EMAILS,
    role: "admin" | "doctor",
  ) {
    const [row] = await db
      .insert(users)
      .values({
        name: `A3 ${key} ${STAMP}`,
        email: EMAILS[key],
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        loginMethod: "email",
        role,
      })
      .$returningId();
    userIds[key] = row.id;
    return row.id;
  }

  async function createProfessionalWithLink(userId: number, name: string) {
    const [pro] = await db
      .insert(professionals)
      .values({ userId, name, role: "Médico", userRole: "USER" })
      .$returningId();
    professionalIds.push(pro.id);
    await db.insert(professionalInstitutions).values({
      professionalId: pro.id,
      userId,
      institutionId,
      roleInInstitution: "USER",
      isPrimary: true,
      active: true,
    });
    return pro.id;
  }

  async function login(email: string, password: string) {
    return request(app).post("/api/auth/login").send({ email, password });
  }

  async function loginExact(email: string, password: string) {
    const previous = process.env.SESSION_EXACT_BINDING_SUPPORTED;
    process.env.SESSION_EXACT_BINDING_SUPPORTED = "1";
    try {
      return await request(app)
        .post("/api/auth/login")
        .set("x-client-session-protocol", "exact-v1")
        .send({ email, password });
    } finally {
      if (previous === undefined) {
        delete process.env.SESSION_EXACT_BINDING_SUPPORTED;
      } else {
        process.env.SESSION_EXACT_BINDING_SUPPORTED = previous;
      }
    }
  }

  function cookieOf(res: request.Response): string | null {
    return (
      setCookieHeaders(res).find((cookie) => cookie.startsWith("session=")) ??
      null
    );
  }

  function setCookieHeaders(res: request.Response): string[] {
    const header = res.headers["set-cookie"];
    return Array.isArray(header) ? header : header ? [header] : [];
  }

  function cookiePair(res: request.Response, name: string): string {
    const header = setCookieHeaders(res).find((candidate) =>
      candidate.startsWith(`${name}=`),
    );
    if (!header) throw new Error(`Cookie ${name} ausente`);
    return header.split(";", 1)[0]!;
  }

  function proofForCookie(cookie: string): string {
    const pair = cookie
      .split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith("session="));
    const token = pair?.slice("session=".length);
    if (!token) throw new Error("Token de sessão ausente no cookie de teste");
    return sessionInstanceProof(token);
  }

  beforeAll(async () => {
    const maybeDb = await getDb();
    if (!maybeDb) throw new Error("Database not available");
    db = maybeDb;

    app = express();
    app.use(express.json());
    app.use("/api/auth", authRouter);
    app.use("/api/admin", adminRouter);

    const [institution] = await db
      .insert(institutions)
      .values({
        name: `A3 Tenant ${STAMP}`,
        cnpj: `${STAMP}`.slice(-14).padStart(14, "0"),
        legalName: `A3 Tenant ${STAMP}`,
        tradeName: `A3${STAMP}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = institution.id;

    const [hospital] = await db
      .insert(hospitals)
      .values({ institutionId, name: `A3 Hospital ${STAMP}` })
      .$returningId();
    hospitalId = hospital.id;

    const [sector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `A3 Setor ${STAMP}`,
        category: "cirurgico",
        color: "#2563EB",
      })
      .$returningId();
    sectorId = sector.id;

    await createUser("doctor", "doctor");
    await createUser("admin", "admin");
    await createUser("busy", "doctor");
    await createUser("leaving", "doctor");

    for (const key of ["doctor", "admin", "busy", "leaving"] as const) {
      await createProfessionalWithLink(userIds[key], `A3 ${key} ${STAMP}`);
    }

    // Plantão futuro (+2 dias) alocado ao usuário "busy".
    const startAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const endAt = new Date(startAt.getTime() + 6 * 60 * 60 * 1000);
    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId,
        hospitalId,
        sectorId,
        label: `A3 Shift ${STAMP}`,
        startAt,
        endAt,
        status: "OCUPADO",
      })
      .$returningId();
    shiftInstanceId = shift.id;

    const busyProfessionalId = professionalIds[2];
    await db.insert(shiftAssignmentsV2).values({
      shiftInstanceId,
      institutionId,
      hospitalId,
      sectorId,
      professionalId: busyProfessionalId,
      assignmentType: "ON_DUTY",
      status: "OCUPADO",
      isActive: true,
    });

    // Push token do usuário que vai excluir a conta.
    await db.insert(pushTokens).values({
      institutionId,
      userId: userIds.leaving,
      token: `ExponentPushToken[a3-${STAMP}]`,
      platform: "ios",
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    const ids = [...Object.values(userIds), ...extraUserIds].filter(
      (id) => id > 0,
    );
    if (ids.length === 0) return;

    if (shiftInstanceId) {
      await db
        .delete(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.shiftInstanceId, shiftInstanceId));
      await db
        .delete(shiftInstances)
        .where(eq(shiftInstances.id, shiftInstanceId));
    }
    await db
      .delete(auditTrail)
      .where(
        or(
          inArray(auditTrail.actorUserId, ids),
          inArray(auditTrail.entityId, ids),
        ),
      );
    await db.delete(pushTokens).where(inArray(pushTokens.userId, ids));
    await db.delete(passwordResets).where(inArray(passwordResets.userId, ids));
    if (professionalIds.length > 0) {
      await db
        .delete(professionalInstitutions)
        .where(
          inArray(professionalInstitutions.professionalId, professionalIds),
        );
      await db
        .delete(professionals)
        .where(inArray(professionals.id, professionalIds));
    }
    await db.delete(users).where(inArray(users.id, ids));
    if (sectorId) await db.delete(sectors).where(eq(sectors.id, sectorId));
    if (hospitalId)
      await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    if (extraInstitutionIds.length > 0) {
      await db
        .delete(institutions)
        .where(inArray(institutions.id, extraInstitutionIds));
    }
    if (institutionId)
      await db.delete(institutions).where(eq(institutions.id, institutionId));
  });

  // -------------------------------------------------------------------------
  // Esqueci minha senha
  // -------------------------------------------------------------------------

  it("produção falha fechada sem APP_PUBLIC_URL HTTPS válida e não cria token", async () => {
    const beforeTokens = await db
      .select({ id: passwordResets.id, usedAt: passwordResets.usedAt })
      .from(passwordResets)
      .where(eq(passwordResets.userId, userIds.leaving));
    const beforeAudits = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.entityId, userIds.leaving),
          eq(
            auditTrail.description,
            "Pedido de redefinição de senha (esqueci minha senha)",
          ),
        ),
      );
    const sendSpy = vi
      .spyOn(mailer, "sendMail")
      .mockResolvedValue({ delivered: false, transport: "console" });
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    vi.stubEnv("NODE_ENV", "production");
    try {
      const configs = ["", "não-é-url", "http://inseguro.example"];
      for (const appPublicUrl of configs) {
        vi.stubEnv("APP_PUBLIC_URL", appPublicUrl);
        const response = await request(app)
          .post("/api/auth/forgot-password")
          .set("Host", "atacante.example")
          .set("X-Forwarded-Proto", "https")
          .send({ email: EMAILS.leaving });
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ ok: true });
      }

      expect(sendSpy).not.toHaveBeenCalled();
      expect(
        await db
          .select({ id: passwordResets.id, usedAt: passwordResets.usedAt })
          .from(passwordResets)
          .where(eq(passwordResets.userId, userIds.leaving)),
      ).toEqual(beforeTokens);
      expect(
        await db
          .select({ id: auditTrail.id })
          .from(auditTrail)
          .where(
            and(
              eq(auditTrail.entityId, userIds.leaving),
              eq(
                auditTrail.description,
                "Pedido de redefinição de senha (esqueci minha senha)",
              ),
            ),
          ),
      ).toEqual(beforeAudits);
    } finally {
      vi.unstubAllEnvs();
      sendSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("link de produção usa somente APP_PUBLIC_URL confiável, nunca Host/X-Forwarded-Proto", async () => {
    const sendSpy = vi
      .spyOn(mailer, "sendMail")
      .mockResolvedValue({ delivered: false, transport: "console" });
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_PUBLIC_URL", "https://confiavel.example/app/");

    try {
      const response = await request(app)
        .post("/api/auth/forgot-password")
        .set("Host", "atacante.example")
        .set("X-Forwarded-Proto", "http")
        .send({ email: EMAILS.busy });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });
      expect(sendSpy).toHaveBeenCalledTimes(1);
      const text = sendSpy.mock.calls[0][0].text;
      expect(text).toContain(
        "https://confiavel.example/app/reset-password?token=",
      );
      expect(text).not.toContain("atacante.example");
    } finally {
      vi.unstubAllEnvs();
      sendSpy.mockRestore();
    }
  });

  it("forgot-password responde 200 neutro sem revelar se o e-mail existe", async () => {
    const spy = vi
      .spyOn(mailer, "sendMail")
      .mockResolvedValue({ delivered: false, transport: "console" });

    const unknown = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: `nao-existe-${STAMP}@test.local` });
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual({ ok: true });
    expect(spy).not.toHaveBeenCalled();

    const known = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: EMAILS.doctor });
    expect(known.status).toBe(200);
    expect(known.body).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(1);

    const [audit] = await db
      .select({
        description: auditTrail.description,
        metadata: auditTrail.metadata,
      })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.entityId, userIds.doctor),
          eq(
            auditTrail.description,
            "Pedido de redefinição de senha (esqueci minha senha)",
          ),
        ),
      );
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit)).not.toContain(EMAILS.doctor);
    expect((audit.metadata as Record<string, unknown>).email).toBeUndefined();

    spy.mockRestore();
  });

  it("token do e-mail → reset-password → login com senha nova; token não pode ser reutilizado", async () => {
    const spy = vi
      .spyOn(mailer, "sendMail")
      .mockResolvedValue({ delivered: false, transport: "console" });

    await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: EMAILS.doctor });
    expect(spy).toHaveBeenCalledTimes(1);
    const text = spy.mock.calls[0][0].text;
    const match = text.match(/reset-password\?token=([0-9a-f]{64})/);
    expect(match).toBeTruthy();
    const token = match![1];
    spy.mockRestore();
    await db.insert(pushTokens).values([
      {
        institutionId,
        userId: userIds.doctor,
        token: `ExponentPushToken[reset-public-a-${STAMP}]`,
        platform: "ios",
      },
      {
        institutionId,
        userId: userIds.doctor,
        token: `ExponentPushToken[reset-public-b-${STAMP}]`,
        platform: "android",
      },
    ]);

    // Senha curta → 400
    const short = await request(app)
      .post("/api/auth/reset-password")
      .send({ token, newPassword: "curta" });
    expect(short.status).toBe(400);

    const ok = await request(app)
      .post("/api/auth/reset-password")
      .send({ token, newPassword: NEW_PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    expect(
      await db
        .select({ id: pushTokens.id })
        .from(pushTokens)
        .where(eq(pushTokens.userId, userIds.doctor)),
    ).toHaveLength(0);
    const [resetAudit] = await db
      .select({ metadata: auditTrail.metadata })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.entityId, userIds.doctor),
          eq(
            auditTrail.description,
            "Senha redefinida via link de 'esqueci minha senha'",
          ),
        ),
      );
    expect(resetAudit?.metadata).toMatchObject({ revokedPushTokenCount: 2 });

    const [reset] = await db
      .select()
      .from(passwordResets)
      .where(eq(passwordResets.userId, userIds.doctor));
    expect(reset).toBeTruthy();

    // Login com a nova senha funciona; a antiga não.
    expect((await login(EMAILS.doctor, NEW_PASSWORD)).status).toBe(200);
    expect((await login(EMAILS.doctor, PASSWORD)).status).toBe(401);

    // Reuso do mesmo token → 400
    const reuse = await request(app)
      .post("/api/auth/reset-password")
      .send({ token, newPassword: "OutraSenha789" });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toMatch(/inválido ou expirado/i);
  });

  it("token expirado é rejeitado", async () => {
    const spy = vi
      .spyOn(mailer, "sendMail")
      .mockResolvedValue({ delivered: false, transport: "console" });
    await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: EMAILS.doctor });
    const token = spy.mock.calls[0][0].text.match(/token=([0-9a-f]{64})/)![1];
    spy.mockRestore();

    // Força expiração no banco (não usa o token, só expira).
    await db
      .update(passwordResets)
      .set({ expiresAt: new Date(Date.now() - 60 * 1000) })
      .where(eq(passwordResets.userId, userIds.doctor));

    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token, newPassword: "SenhaQualquer999" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/inválido ou expirado/i);

    // Token inexistente também → 400
    const bogus = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "f".repeat(64), newPassword: "SenhaQualquer999" });
    expect(bogus.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Admin: senha temporária + troca obrigatória
  // -------------------------------------------------------------------------

  it("admin reset → login devolve mustChangePassword → change-password limpa a flag", async () => {
    const adminLogin = await login(EMAILS.admin, PASSWORD);
    expect(adminLogin.status).toBe(200);
    const adminCookie = cookieOf(adminLogin)!;

    // Não-admin não pode
    const doctorLogin = await login(EMAILS.doctor, NEW_PASSWORD);
    const forbidden = await request(app)
      .post(`/api/admin/users/${userIds.doctor}/reset-password`)
      .set("Cookie", cookieOf(doctorLogin)!)
      .set("x-tenant-id", String(institutionId));
    expect(forbidden.status).toBe(403);

    await db.insert(pushTokens).values([
      {
        institutionId,
        userId: userIds.doctor,
        token: `ExponentPushToken[reset-admin-a-${STAMP}]`,
        platform: "ios",
      },
      {
        institutionId,
        userId: userIds.doctor,
        token: `ExponentPushToken[reset-admin-b-${STAMP}]`,
        platform: "android",
      },
    ]);

    const reset = await request(app)
      .post(`/api/admin/users/${userIds.doctor}/reset-password`)
      .set("Cookie", adminCookie)
      .set("x-tenant-id", String(institutionId));
    expect(reset.status).toBe(200);
    expect(
      await db
        .select({ id: pushTokens.id })
        .from(pushTokens)
        .where(eq(pushTokens.userId, userIds.doctor)),
    ).toHaveLength(0);
    const [adminResetAudit] = await db
      .select({ metadata: auditTrail.metadata })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.entityId, userIds.doctor),
          eq(
            auditTrail.description,
            `Senha do usuário #${userIds.doctor} redefinida pelo usuário #${userIds.admin} (senha temporária, troca obrigatória no próximo login)`,
          ),
        ),
      );
    expect(adminResetAudit?.metadata).toMatchObject({
      revokedPushTokenCount: 2,
    });
    const temp: string = reset.body.temporaryPassword;
    expect(temp).toMatch(/^[A-HJ-NP-Za-km-z2-9]{12}$/);

    // Senha antiga morreu; temporária entra e exige troca.
    expect((await login(EMAILS.doctor, NEW_PASSWORD)).status).toBe(401);
    const tempLogin = await login(EMAILS.doctor, temp);
    expect(tempLogin.status).toBe(200);
    expect(tempLogin.body.user.mustChangePassword).toBe(true);
    const cookie = cookieOf(tempLogin)!;

    const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(me.body.user.mustChangePassword).toBe(true);

    const change = await request(app)
      .post("/api/auth/change-password")
      .set("Cookie", cookie)
      .set("x-client-session-instance", proofForCookie(cookie))
      .send({ currentPassword: temp, newPassword: PASSWORD });
    expect(change.status).toBe(200);

    // A troca revoga a sessão antiga (B3) e devolve a nova no Set-Cookie.
    expect(
      (await request(app).get("/api/auth/me").set("Cookie", cookie)).status,
    ).toBe(401);
    const meAfter = await request(app)
      .get("/api/auth/me")
      .set("Cookie", cookieOf(change)!);
    expect(meAfter.body.user.mustChangePassword).toBe(false);
    const relogin = await login(EMAILS.doctor, PASSWORD);
    expect(relogin.status).toBe(200);
    expect(relogin.body.user.mustChangePassword).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Exclusão de conta
  // -------------------------------------------------------------------------

  it("DELETE /me exige sessão e senha correta", async () => {
    const noSession = await request(app)
      .delete("/api/auth/me")
      .send({ password: PASSWORD });
    expect(noSession.status).toBe(401);

    const res = await loginExact(EMAILS.leaving, PASSWORD);
    const cookie = cookieOf(res)!;
    const [before] = await db
      .select({
        deletedAt: users.deletedAt,
        sessionVersion: users.sessionVersion,
      })
      .from(users)
      .where(eq(users.id, userIds.leaving));
    const missingProof = await request(app)
      .delete("/api/auth/me")
      .set("Cookie", cookie)
      .set("x-client-expected-user-id", String(userIds.leaving))
      .send({ password: PASSWORD });
    expect(missingProof.status).toBe(428);
    expect(missingProof.body).toMatchObject({
      code: "SESSION_INSTANCE_REQUIRED",
    });
    expect(
      (
        await db
          .select({
            deletedAt: users.deletedAt,
            sessionVersion: users.sessionVersion,
          })
          .from(users)
          .where(eq(users.id, userIds.leaving))
      )[0],
    ).toEqual(before);

    const wrong = await request(app)
      .delete("/api/auth/me")
      .set("Cookie", cookie)
      .set("x-client-session-instance", proofForCookie(cookie))
      .send({ password: "SenhaErrada123" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toMatch(/senha incorreta/i);
  });

  it("DELETE /me restaura o fence exato e não limpa cookie se o commit falhar", async () => {
    const browser = request.agent(app);
    const fenceSetup = await browser.post("/api/auth/logout").send({});
    const stableFence = cookiePair(fenceSetup, "session_fence");
    const loginResponse = await browser
      .post("/api/auth/login")
      .send({ email: EMAILS.leaving, password: PASSWORD });
    expect(loginResponse.status).toBe(200);
    const loginCookie = cookieOf(loginResponse)!;
    const [before] = await db
      .select({
        deletedAt: users.deletedAt,
        sessionVersion: users.sessionVersion,
      })
      .from(users)
      .where(eq(users.id, userIds.leaving));
    const auditFailure = vi
      .spyOn(auditService, "recordAudit")
      .mockRejectedValueOnce(new Error("forced delete audit failure"));

    let failed: request.Response;
    try {
      failed = await browser
        .delete("/api/auth/me")
        .set("x-client-expected-user-id", String(userIds.leaving))
        .set("x-client-session-instance", proofForCookie(loginCookie))
        .send({ password: PASSWORD });
    } finally {
      auditFailure.mockRestore();
    }

    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: "Falha ao excluir conta" });
    const headers = setCookieHeaders(failed);
    expect(
      headers.some(
        (header) =>
          header.startsWith("session=") &&
          /Expires=Thu, 01 Jan 1970|Max-Age=0/i.test(header),
      ),
    ).toBe(false);
    const fenceHeaders = headers.filter((header) =>
      header.startsWith("session_fence="),
    );
    expect(fenceHeaders).toHaveLength(2);
    expect(fenceHeaders.at(-1)?.split(";", 1)[0]).toBe(stableFence);

    const [after] = await db
      .select({
        deletedAt: users.deletedAt,
        sessionVersion: users.sessionVersion,
      })
      .from(users)
      .where(eq(users.id, userIds.leaving));
    expect(after).toEqual(before);
    await expect(browser.get("/api/auth/me")).resolves.toMatchObject({
      status: 200,
    });
  });

  it("DELETE /me rejeita expected-user divergente ou malformado sem qualquer efeito", async () => {
    const loginResponse = await login(EMAILS.leaving, PASSWORD);
    const cookie = cookieOf(loginResponse)!;
    const [beforeUser] = await db
      .select({
        email: users.email,
        deletedAt: users.deletedAt,
        sessionVersion: users.sessionVersion,
      })
      .from(users)
      .where(eq(users.id, userIds.leaving));
    const beforeTokens = await db
      .select({ id: pushTokens.id })
      .from(pushTokens)
      .where(eq(pushTokens.userId, userIds.leaving));
    const beforeAudits = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.entityId, userIds.leaving),
          eq(
            auditTrail.description,
            "Conta excluída pelo próprio usuário (soft-delete, dados anonimizados)",
          ),
        ),
      );

    const divergent = await request(app)
      .delete("/api/auth/me")
      .set("Cookie", cookie)
      .set("x-client-session-instance", proofForCookie(cookie))
      .set("x-client-expected-user-id", String(userIds.busy))
      .send({ password: PASSWORD });
    expect(divergent.status).toBe(409);
    expect(divergent.body).toMatchObject({ code: "EXPECTED_USER_MISMATCH" });

    const malformed = await request(app)
      .delete("/api/auth/me")
      .set("Cookie", cookie)
      .set("x-client-session-instance", proofForCookie(cookie))
      .set("x-client-expected-user-id", `0${userIds.leaving}`)
      .send({ password: PASSWORD });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({
      code: "MALFORMED_EXPECTED_USER_ID",
    });

    const [afterUser] = await db
      .select({
        email: users.email,
        deletedAt: users.deletedAt,
        sessionVersion: users.sessionVersion,
      })
      .from(users)
      .where(eq(users.id, userIds.leaving));
    expect(afterUser).toEqual(beforeUser);
    expect(
      await db
        .select({ id: pushTokens.id })
        .from(pushTokens)
        .where(eq(pushTokens.userId, userIds.leaving)),
    ).toEqual(beforeTokens);
    expect(
      await db
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(
          and(
            eq(auditTrail.entityId, userIds.leaving),
            eq(
              auditTrail.description,
              "Conta excluída pelo próprio usuário (soft-delete, dados anonimizados)",
            ),
          ),
        ),
    ).toEqual(beforeAudits);
    await expect(
      request(app).get("/api/auth/me").set("Cookie", cookie),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("DELETE /me rejeita proof S1 sobre cookie S2 do mesmo usuário sem tocar conta, push ou auditoria", async () => {
    const first = await loginExact(EMAILS.leaving, PASSWORD);
    const second = await loginExact(EMAILS.leaving, PASSWORD);
    const firstCookie = cookieOf(first)!;
    const secondCookie = cookieOf(second)!;
    expect(firstCookie).not.toBe(secondCookie);

    const [beforeUser] = await db
      .select({
        email: users.email,
        deletedAt: users.deletedAt,
        sessionVersion: users.sessionVersion,
      })
      .from(users)
      .where(eq(users.id, userIds.leaving));
    const beforeTokens = await db
      .select({ id: pushTokens.id })
      .from(pushTokens)
      .where(eq(pushTokens.userId, userIds.leaving));
    const beforeAudits = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.entityId, userIds.leaving),
          eq(
            auditTrail.description,
            "Conta excluída pelo próprio usuário (soft-delete, dados anonimizados)",
          ),
        ),
      );

    const response = await request(app)
      .delete("/api/auth/me")
      .set("Cookie", secondCookie)
      .set("x-client-expected-user-id", String(userIds.leaving))
      .set("x-client-session-instance", proofForCookie(firstCookie))
      .send({ password: PASSWORD });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: "SESSION_INSTANCE_MISMATCH" });
    expect(
      (
        await db
          .select({
            email: users.email,
            deletedAt: users.deletedAt,
            sessionVersion: users.sessionVersion,
          })
          .from(users)
          .where(eq(users.id, userIds.leaving))
      )[0],
    ).toEqual(beforeUser);
    expect(
      await db
        .select({ id: pushTokens.id })
        .from(pushTokens)
        .where(eq(pushTokens.userId, userIds.leaving)),
    ).toEqual(beforeTokens);
    expect(
      await db
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(
          and(
            eq(auditTrail.entityId, userIds.leaving),
            eq(
              auditTrail.description,
              "Conta excluída pelo próprio usuário (soft-delete, dados anonimizados)",
            ),
          ),
        ),
    ).toEqual(beforeAudits);
    await expect(
      request(app).get("/api/auth/me").set("Cookie", secondCookie),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("DELETE /me bloqueia com 409 quando há plantão futuro alocado", async () => {
    const res = await login(EMAILS.busy, PASSWORD);
    const cookie = cookieOf(res)!;
    const del = await request(app)
      .delete("/api/auth/me")
      .set("Cookie", cookie)
      .set("x-client-session-instance", proofForCookie(cookie))
      .send({ password: PASSWORD });
    expect(del.status).toBe(409);
    expect(del.body.error).toMatch(/plantões futuros alocados/i);

    // Mutation-sensitive: trocar apenas startAt para o passado não pode
    // transformar um plantão em andamento em elegível para exclusão.
    await db
      .update(shiftInstances)
      .set({
        startAt: new Date(Date.now() - 60 * 60 * 1000),
        endAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .where(eq(shiftInstances.id, shiftInstanceId));
    const ongoing = await request(app)
      .delete("/api/auth/me")
      .set("Cookie", cookie)
      .set("x-client-session-instance", proofForCookie(cookie))
      .send({ password: PASSWORD });
    expect(ongoing.status).toBe(409);

    const [still] = await db
      .select()
      .from(users)
      .where(eq(users.id, userIds.busy));
    expect(still.deletedAt).toBeNull();
    expect(still.email).toBe(EMAILS.busy);
  });

  it("DELETE /me bloqueia o último admin HTTP global mesmo com PI contextual USER", async () => {
    const res = await login(EMAILS.admin, PASSWORD);
    const adminCookie = cookieOf(res)!;
    const deletion = await request(app)
      .delete("/api/auth/me")
      .set("Cookie", adminCookie)
      .set("x-client-session-instance", proofForCookie(adminCookie))
      .send({ password: PASSWORD });
    expect(deletion.status).toBe(409);
    expect(deletion.body.error).toMatch(
      /administração global|administrador global/i,
    );
    const [admin] = await db
      .select()
      .from(users)
      .where(eq(users.id, userIds.admin));
    expect(admin.deletedAt).toBeNull();
    const [membership] = await db
      .select({ role: professionalInstitutions.roleInInstitution })
      .from(professionalInstitutions)
      .where(eq(professionalInstitutions.userId, userIds.admin));
    expect(membership.role).toBe("USER");
  });

  it("DELETE /me bloqueia o último GESTOR_PLUS contextual sem depender do papel global", async () => {
    const res = await login(EMAILS.admin, PASSWORD);
    const managerCookie = cookieOf(res)!;
    // O papel global legado não é a fonte de autoridade institucional.
    await db
      .update(users)
      .set({ role: "doctor" })
      .where(eq(users.id, userIds.admin));
    await db
      .update(professionalInstitutions)
      .set({ roleInInstitution: "GESTOR_PLUS" })
      .where(eq(professionalInstitutions.userId, userIds.admin));
    try {
      const deletion = await request(app)
        .delete("/api/auth/me")
        .set("Cookie", managerCookie)
        .set("x-client-session-instance", proofForCookie(managerCookie))
        .send({ password: PASSWORD });
      expect(deletion.status).toBe(409);
      expect(deletion.body.error).toMatch(/transfira a administração/i);
      const [admin] = await db
        .select()
        .from(users)
        .where(eq(users.id, userIds.admin));
      expect(admin.deletedAt).toBeNull();
    } finally {
      await db
        .update(users)
        .set({ role: "admin" })
        .where(eq(users.id, userIds.admin));
      await db
        .update(professionalInstitutions)
        .set({ roleInInstitution: "USER" })
        .where(eq(professionalInstitutions.userId, userIds.admin));
    }
  });

  it("duas exclusões concorrentes de admins globais deixam exatamente um capaz no tenant", async () => {
    const [tenant] = await db
      .insert(institutions)
      .values({
        name: `A3 Admin Race ${STAMP}`,
        cnpj: `${STAMP}77`.slice(-14).padStart(14, "0"),
        legalName: `A3 Admin Race ${STAMP}`,
        tradeName: `A3R${STAMP}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    extraInstitutionIds.push(tenant.id);

    const racerCookies: string[] = [];
    for (const tag of ["a", "b"] as const) {
      const email = `a3-admin-race-${tag}-${STAMP}@test.local`;
      const [user] = await db
        .insert(users)
        .values({
          name: `A3 Admin Race ${tag}`,
          email,
          passwordHash: await bcrypt.hash(PASSWORD, 4),
          loginMethod: "email",
          role: "admin",
        })
        .$returningId();
      extraUserIds.push(user.id);
      const [professional] = await db
        .insert(professionals)
        .values({
          userId: user.id,
          name: `A3 Admin Race ${tag}`,
          role: "Administrador",
          userRole: "USER",
        })
        .$returningId();
      professionalIds.push(professional.id);
      await db.insert(professionalInstitutions).values({
        professionalId: professional.id,
        userId: user.id,
        institutionId: tenant.id,
        roleInInstitution: "USER",
        isPrimary: true,
        active: true,
      });
      const session = await login(email, PASSWORD);
      racerCookies.push(cookieOf(session)!);
    }

    const deletions = await Promise.all(
      racerCookies.map((racerCookie) =>
        request(app)
          .delete("/api/auth/me")
          .set("Cookie", racerCookie)
          .set("x-client-session-instance", proofForCookie(racerCookie))
          .send({ password: PASSWORD }),
      ),
    );
    expect(deletions.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);

    const capable = await db
      .select({ userId: users.id })
      .from(professionalInstitutions)
      .innerJoin(
        professionals,
        and(
          eq(professionals.id, professionalInstitutions.professionalId),
          eq(professionals.userId, professionalInstitutions.userId),
        ),
      )
      .innerJoin(
        users,
        and(
          eq(users.id, professionalInstitutions.userId),
          eq(users.role, "admin"),
          eq(users.approvalStatus, "APPROVED"),
          isNull(users.deletedAt),
        ),
      )
      .where(
        and(
          eq(professionalInstitutions.institutionId, tenant.id),
          eq(professionalInstitutions.active, true),
        ),
      );
    expect(capable).toHaveLength(1);
  });

  it("DELETE /me ok: anonimiza, desativa vínculo, apaga push tokens, login e sessão falham", async () => {
    const res = await login(EMAILS.leaving, PASSWORD);
    const cookie = cookieOf(res)!;

    const del = await request(app)
      .delete("/api/auth/me")
      .set("Cookie", cookie)
      .set("x-client-expected-user-id", String(userIds.leaving))
      .set("x-client-session-instance", proofForCookie(cookie))
      .send({ password: PASSWORD });
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true, sessionFenceRotated: true });
    const terminalHeaders = setCookieHeaders(del);
    expect(
      terminalHeaders.filter(
        (header) =>
          header.startsWith("session=") &&
          /Expires=Thu, 01 Jan 1970|Max-Age=0/i.test(header),
      ),
    ).toHaveLength(2);
    const terminalFenceHeaders = terminalHeaders.filter((header) =>
      header.startsWith("session_fence="),
    );
    expect(terminalFenceHeaders).toHaveLength(1);
    expect(terminalFenceHeaders[0]).not.toMatch(
      /Expires=Thu, 01 Jan 1970|Max-Age=0/i,
    );

    const [gone] = await db
      .select()
      .from(users)
      .where(eq(users.id, userIds.leaving));
    expect(gone.deletedAt).not.toBeNull();
    expect(gone.name).toBe("Conta removida");
    expect(gone.email).toBe(`removido+${userIds.leaving}@anon.local`);
    expect(gone.openId).toBeNull();
    expect(gone.loginMethod).toBeNull();
    expect(gone.passwordHash).toBeNull();

    const professionalRows = await db
      .select({ name: professionals.name })
      .from(professionals)
      .where(eq(professionals.userId, userIds.leaving));
    expect(professionalRows.length).toBeGreaterThan(0);
    expect(professionalRows.every((row) => row.name === "Conta removida")).toBe(
      true,
    );

    const links = await db
      .select()
      .from(professionalInstitutions)
      .where(eq(professionalInstitutions.userId, userIds.leaving));
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((l) => l.active === false)).toBe(true);

    const tokens = await db
      .select()
      .from(pushTokens)
      .where(eq(pushTokens.userId, userIds.leaving));
    expect(tokens).toHaveLength(0);
    const [deleteAudit] = await db
      .select({ metadata: auditTrail.metadata })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.entityId, userIds.leaving),
          eq(
            auditTrail.description,
            "Conta excluída pelo próprio usuário (soft-delete, dados anonimizados)",
          ),
        ),
      );
    expect(deleteAudit?.metadata).toMatchObject({ revokedPushTokenCount: 1 });

    // Login pelo e-mail original e pelo anonimizado falham como credencial inválida.
    expect((await login(EMAILS.leaving, PASSWORD)).status).toBe(401);
    expect(
      (await login(`removido+${userIds.leaving}@anon.local`, PASSWORD)).status,
    ).toBe(401);

    // Sessão antiga revogada.
    const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(me.status).toBe(401);
  });
});
