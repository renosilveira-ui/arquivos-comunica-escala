import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, inArray, or } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request from "supertest";
import express, { type Express } from "express";
import { authRouter } from "../server/routes/auth";
import { adminRouter } from "../server/routes/admin";
import { mailer } from "../server/mailer";
import { getDb } from "../server/db";
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
  const userIds: Record<keyof typeof EMAILS, number> = { doctor: 0, admin: 0, busy: 0, leaving: 0 };
  const professionalIds: number[] = [];
  let institutionId: number;
  let hospitalId: number;
  let sectorId: number;
  let shiftInstanceId: number;

  async function createUser(key: keyof typeof EMAILS, role: "admin" | "doctor") {
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

  function cookieOf(res: request.Response): string | null {
    const setCookie = res.headers["set-cookie"];
    if (!setCookie) return null;
    const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
    return arr.find((c) => c.startsWith("session=")) ?? null;
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
    const ids = Object.values(userIds).filter((id) => id > 0);
    if (ids.length === 0) return;

    if (shiftInstanceId) {
      await db.delete(shiftAssignmentsV2).where(eq(shiftAssignmentsV2.shiftInstanceId, shiftInstanceId));
      await db.delete(shiftInstances).where(eq(shiftInstances.id, shiftInstanceId));
    }
    await db.delete(auditTrail).where(or(inArray(auditTrail.actorUserId, ids), inArray(auditTrail.entityId, ids)));
    await db.delete(pushTokens).where(inArray(pushTokens.userId, ids));
    await db.delete(passwordResets).where(inArray(passwordResets.userId, ids));
    if (professionalIds.length > 0) {
      await db.delete(professionalInstitutions).where(inArray(professionalInstitutions.professionalId, professionalIds));
      await db.delete(professionals).where(inArray(professionals.id, professionalIds));
    }
    await db.delete(users).where(inArray(users.id, ids));
    if (sectorId) await db.delete(sectors).where(eq(sectors.id, sectorId));
    if (hospitalId) await db.delete(hospitals).where(eq(hospitals.id, hospitalId));
    if (institutionId) await db.delete(institutions).where(eq(institutions.id, institutionId));
  });

  // -------------------------------------------------------------------------
  // Esqueci minha senha
  // -------------------------------------------------------------------------

  it("forgot-password responde 200 neutro sem revelar se o e-mail existe", async () => {
    const spy = vi.spyOn(mailer, "sendMail").mockResolvedValue({ delivered: false, transport: "console" });

    const unknown = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: `nao-existe-${STAMP}@test.local` });
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual({ ok: true });
    expect(spy).not.toHaveBeenCalled();

    const known = await request(app).post("/api/auth/forgot-password").send({ email: EMAILS.doctor });
    expect(known.status).toBe(200);
    expect(known.body).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });

  it("token do e-mail → reset-password → login com senha nova; token não pode ser reutilizado", async () => {
    const spy = vi.spyOn(mailer, "sendMail").mockResolvedValue({ delivered: false, transport: "console" });

    await request(app).post("/api/auth/forgot-password").send({ email: EMAILS.doctor });
    expect(spy).toHaveBeenCalledTimes(1);
    const text = spy.mock.calls[0][0].text;
    const match = text.match(/reset-password\?token=([0-9a-f]{64})/);
    expect(match).toBeTruthy();
    const token = match![1];
    spy.mockRestore();

    // Senha curta → 400
    const short = await request(app).post("/api/auth/reset-password").send({ token, newPassword: "curta" });
    expect(short.status).toBe(400);

    const ok = await request(app).post("/api/auth/reset-password").send({ token, newPassword: NEW_PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });

    const [reset] = await db.select().from(passwordResets).where(eq(passwordResets.userId, userIds.doctor));
    expect(reset).toBeTruthy();

    // Login com a nova senha funciona; a antiga não.
    expect((await login(EMAILS.doctor, NEW_PASSWORD)).status).toBe(200);
    expect((await login(EMAILS.doctor, PASSWORD)).status).toBe(401);

    // Reuso do mesmo token → 400
    const reuse = await request(app).post("/api/auth/reset-password").send({ token, newPassword: "OutraSenha789" });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toMatch(/inválido ou expirado/i);
  });

  it("token expirado é rejeitado", async () => {
    const spy = vi.spyOn(mailer, "sendMail").mockResolvedValue({ delivered: false, transport: "console" });
    await request(app).post("/api/auth/forgot-password").send({ email: EMAILS.doctor });
    const token = spy.mock.calls[0][0].text.match(/token=([0-9a-f]{64})/)![1];
    spy.mockRestore();

    // Força expiração no banco (não usa o token, só expira).
    await db
      .update(passwordResets)
      .set({ expiresAt: new Date(Date.now() - 60 * 1000) })
      .where(eq(passwordResets.userId, userIds.doctor));

    const res = await request(app).post("/api/auth/reset-password").send({ token, newPassword: "SenhaQualquer999" });
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
      .set("Cookie", cookieOf(doctorLogin)!);
    expect(forbidden.status).toBe(403);

    const reset = await request(app)
      .post(`/api/admin/users/${userIds.doctor}/reset-password`)
      .set("Cookie", adminCookie);
    expect(reset.status).toBe(200);
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
      .send({ currentPassword: temp, newPassword: PASSWORD });
    expect(change.status).toBe(200);

    const meAfter = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(meAfter.body.user.mustChangePassword).toBe(false);
    const relogin = await login(EMAILS.doctor, PASSWORD);
    expect(relogin.status).toBe(200);
    expect(relogin.body.user.mustChangePassword).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Exclusão de conta
  // -------------------------------------------------------------------------

  it("DELETE /me exige sessão e senha correta", async () => {
    const noSession = await request(app).delete("/api/auth/me").send({ password: PASSWORD });
    expect(noSession.status).toBe(401);

    const res = await login(EMAILS.leaving, PASSWORD);
    const wrong = await request(app)
      .delete("/api/auth/me")
      .set("Cookie", cookieOf(res)!)
      .send({ password: "SenhaErrada123" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toMatch(/senha incorreta/i);
  });

  it("DELETE /me bloqueia com 409 quando há plantão futuro alocado", async () => {
    const res = await login(EMAILS.busy, PASSWORD);
    const del = await request(app)
      .delete("/api/auth/me")
      .set("Cookie", cookieOf(res)!)
      .send({ password: PASSWORD });
    expect(del.status).toBe(409);
    expect(del.body.error).toMatch(/plantões futuros alocados/i);

    const [still] = await db.select().from(users).where(eq(users.id, userIds.busy));
    expect(still.deletedAt).toBeNull();
    expect(still.email).toBe(EMAILS.busy);
  });

  it("DELETE /me ok: anonimiza, desativa vínculo, apaga push tokens, login e sessão falham", async () => {
    const res = await login(EMAILS.leaving, PASSWORD);
    const cookie = cookieOf(res)!;

    const del = await request(app).delete("/api/auth/me").set("Cookie", cookie).send({ password: PASSWORD });
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ ok: true });

    const [gone] = await db.select().from(users).where(eq(users.id, userIds.leaving));
    expect(gone.deletedAt).not.toBeNull();
    expect(gone.name).toBe("Conta removida");
    expect(gone.email).toBe(`removido+${userIds.leaving}@anon.local`);

    const links = await db
      .select()
      .from(professionalInstitutions)
      .where(eq(professionalInstitutions.userId, userIds.leaving));
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((l) => l.active === false)).toBe(true);

    const tokens = await db.select().from(pushTokens).where(eq(pushTokens.userId, userIds.leaving));
    expect(tokens).toHaveLength(0);

    // Login pelo e-mail original e pelo anonimizado falham como credencial inválida.
    expect((await login(EMAILS.leaving, PASSWORD)).status).toBe(401);
    expect((await login(`removido+${userIds.leaving}@anon.local`, PASSWORD)).status).toBe(401);

    // Sessão antiga revogada.
    const me = await request(app).get("/api/auth/me").set("Cookie", cookie);
    expect(me.status).toBe(401);
  });
});
