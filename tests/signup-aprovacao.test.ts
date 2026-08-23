// tests/signup-aprovacao.test.ts — auto-cadastro público + aprovação pelo admin.
//
// Lacuna apontada na auditoria 22/08 (parte 2): o fluxo validado "a mão"
// em 18/08 (PR #168) não tinha teste de regressão.
//
//   1. POST /api/auth/signup valida campos, instituição e e-mail duplicado.
//   2. A conta nasce PENDING com vínculo INATIVO: login responde (o app
//      bloqueia na tela de aprovação), mas nenhum tenant é resolvido.
//   3. Admin aprova: vínculo ativo, acesso a todos os hospitais da
//      instituição, login com approvalStatus APPROVED, tenant resolvido.
//   4. Admin recusa: cadastro removido, login volta a 401, segunda recusa 404.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request from "supertest";
import express, { type Express } from "express";
import { auditTrail, hospitals, institutions, professionalAccess, professionalInstitutions, professionals, users } from "../drizzle/schema";
import { resolveInstitutionForUser } from "../server/_core/tenant";
import { getDb } from "../server/db";
import { adminRouter } from "../server/routes/admin";
import { authRouter } from "../server/routes/auth";

const STAMP = Date.now();
const PASSWORD = "SenhaForte123";

describe("auto-cadastro público e aprovação", () => {
  let app: Express;
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionId: number;
  let hospitalA: number;
  let hospitalB: number;
  let adminId: number;
  let adminCookie: string;
  const emailA = `signup-a-${STAMP}@test.local`;
  const emailB = `signup-b-${STAMP}@test.local`;

  async function login(email: string, password: string) {
    return request(app).post("/api/auth/login").send({ email, password });
  }
  function cookieOf(res: request.Response): string {
    const sc = res.headers["set-cookie"];
    return (Array.isArray(sc) ? sc : [sc]).find((c: string) => c?.startsWith("session=")) ?? "";
  }

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;
    app = express();
    app.use(express.json());
    app.use("/api/auth", authRouter);
    app.use("/api/admin", adminRouter);

    const [inst] = await db
      .insert(institutions)
      .values({ name: `Signup Tenant ${STAMP}`, cnpj: `${STAMP}9`.slice(-14).padStart(14, "0"), legalName: `Signup ${STAMP}`, tradeName: `SG${STAMP}`.slice(0, 20), isActive: true })
      .$returningId();
    institutionId = inst.id;
    const [ha] = await db.insert(hospitals).values({ institutionId, name: `Signup Hospital A ${STAMP}` }).$returningId();
    const [hb] = await db.insert(hospitals).values({ institutionId, name: `Signup Hospital B ${STAMP}` }).$returningId();
    hospitalA = ha.id;
    hospitalB = hb.id;

    const [admin] = await db
      .insert(users)
      .values({ name: "Signup Admin", email: `signup-admin-${STAMP}@test.local`, passwordHash: await bcrypt.hash(PASSWORD, 4), loginMethod: "email", role: "admin" })
      .$returningId();
    adminId = admin.id;
    const [pro] = await db.insert(professionals).values({ userId: adminId, name: "Signup Admin", role: "Gestor", userRole: "GESTOR_PLUS" }).$returningId();
    await db.insert(professionalInstitutions).values({ professionalId: pro.id, userId: adminId, institutionId, roleInInstitution: "GESTOR_PLUS", isPrimary: true, active: true });
    const res = await login(`signup-admin-${STAMP}@test.local`, PASSWORD);
    expect(res.status).toBe(200);
    adminCookie = cookieOf(res);
    expect(adminCookie).not.toBe("");
  });

  afterAll(async () => {
    const mine = await db.select({ id: users.id }).from(users).where(like(users.email, `signup-%-${STAMP}@test.local`));
    const ids = mine.map((u) => u.id);
    await db.delete(auditTrail).where(eq(auditTrail.institutionId, institutionId));
    if (ids.length) await db.delete(auditTrail).where(inArray(auditTrail.entityId, ids));
    await db.delete(professionalAccess).where(eq(professionalAccess.institutionId, institutionId));
    await db.delete(professionalInstitutions).where(eq(professionalInstitutions.institutionId, institutionId));
    if (ids.length) await db.delete(professionals).where(inArray(professionals.userId, ids));
    await db.delete(hospitals).where(inArray(hospitals.id, [hospitalA, hospitalB]));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    if (ids.length) await db.delete(users).where(inArray(users.id, ids));
  });

  it("valida campos, senha curta e instituição", async () => {
    expect((await request(app).post("/api/auth/signup").send({ email: emailA, password: PASSWORD, institutionId })).status).toBe(400);
    expect((await request(app).post("/api/auth/signup").send({ name: "X", email: emailA, password: "curta", institutionId })).status).toBe(400);
    expect((await request(app).post("/api/auth/signup").send({ name: "X", email: emailA, password: PASSWORD })).status).toBe(400);
    expect((await request(app).post("/api/auth/signup").send({ name: "X", email: emailA, password: PASSWORD, institutionId: 99999999 })).status).toBe(400);
  });

  it("cria conta PENDING com vínculo inativo; e-mail duplicado → 409", async () => {
    const res = await request(app).post("/api/auth/signup").send({ name: "  Signup A  ", email: emailA.toUpperCase(), password: PASSWORD, institutionId, specialty: "Anestesiologia" });
    expect(res.status).toBe(201);
    const [u] = await db.select().from(users).where(eq(users.email, emailA));
    expect(u.approvalStatus).toBe("PENDING");
    expect(u.role).toBe("doctor");
    expect(u.name).toBe("Signup A");
    const [link] = await db.select().from(professionalInstitutions).where(eq(professionalInstitutions.userId, u.id));
    expect(link.institutionId).toBe(institutionId);
    expect(link.active).toBe(false);
    expect(link.roleInInstitution).toBe("USER");
    const [pro] = await db.select({ specialty: professionals.specialty }).from(professionals).where(eq(professionals.userId, u.id));
    expect(pro.specialty).toBe("Anestesiologia");

    const dup = await request(app).post("/api/auth/signup").send({ name: "Outro", email: emailA, password: PASSWORD, institutionId });
    expect(dup.status).toBe(409);
  });

  it("PENDING: login responde com approvalStatus PENDING, mas nenhum tenant é resolvido", async () => {
    const res = await login(emailA, PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.user.approvalStatus).toBe("PENDING");
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, emailA));
    await expect(resolveInstitutionForUser(u.id, null)).rejects.toThrow(/sem vínculo/i);
    const links = await db.select({ active: professionalInstitutions.active }).from(professionalInstitutions).where(eq(professionalInstitutions.userId, u.id));
    expect(links.every((l) => l.active === false)).toBe(true); // o login não ativou nada por baixo dos panos
  });

  it("admin lista o pendente, aprova: vínculo ativo, acesso aos hospitais, login APPROVED com tenant", async () => {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, emailA));
    const list = await request(app).get("/api/admin/pending-signups").set("Cookie", adminCookie);
    expect(list.status).toBe(200);
    expect(list.body.pending.map((p: any) => p.id)).toContain(u.id);

    const ok = await request(app).post(`/api/admin/pending-signups/${u.id}/approve`).set("Cookie", adminCookie);
    expect(ok.status).toBe(200);
    const [link] = await db.select().from(professionalInstitutions).where(eq(professionalInstitutions.userId, u.id));
    expect(link.active).toBe(true);
    const access = await db.select({ hospitalId: professionalAccess.hospitalId }).from(professionalAccess).where(eq(professionalAccess.professionalId, link.professionalId));
    expect(access.map((a) => a.hospitalId).sort()).toEqual([hospitalA, hospitalB].sort());

    const res = await login(emailA, PASSWORD);
    expect(res.body.user.approvalStatus).toBe("APPROVED");
    const tenant = await resolveInstitutionForUser(u.id, null);
    expect(tenant.institutionId).toBe(institutionId);

    // Aprovar de novo → 404 (já não é pendente)
    expect((await request(app).post(`/api/admin/pending-signups/${u.id}/approve`).set("Cookie", adminCookie)).status).toBe(404);
  });

  it("admin recusa: cadastro removido, login 401, segunda recusa 404", async () => {
    const res = await request(app).post("/api/auth/signup").send({ name: "Signup B", email: emailB, password: PASSWORD, institutionId });
    expect(res.status).toBe(201);
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, emailB));
    const rej = await request(app).post(`/api/admin/pending-signups/${u.id}/reject`).set("Cookie", adminCookie);
    expect(rej.status).toBe(200);
    const gone = await db.select({ id: users.id, deletedAt: users.deletedAt }).from(users).where(eq(users.id, u.id));
    expect(gone.length === 0 || gone[0].deletedAt !== null).toBe(true);
    expect((await login(emailB, PASSWORD)).status).toBe(401);
    expect((await request(app).post(`/api/admin/pending-signups/${u.id}/reject`).set("Cookie", adminCookie)).status).toBe(404);
  });

  it("não-admin não acessa a fila de pendentes", async () => {
    const res = await login(emailA, PASSWORD);
    const cookie = cookieOf(res);
    expect((await request(app).get("/api/admin/pending-signups").set("Cookie", cookie)).status).toBe(403);
  });
});
