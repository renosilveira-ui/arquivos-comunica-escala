// tests/admin-role-sync.test.ts — auditoria 22/08, achado A1.
//
// PUT /api/admin/users/:id com `role` precisa refletir em
// professional_institutions.role_in_institution, que é a única coluna lida
// pela autorização por tenant (resolveTenantActor → actorCapabilities).
// Antes: rebaixar gestor não revogava poderes; promover médico não concedia.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request from "supertest";
import express, { type Express } from "express";
import { authRouter } from "../server/routes/auth";
import { adminRouter } from "../server/routes/admin";
import { actorCapabilities, resolveTenantActor } from "../server/_core/policy";
import { getDb } from "../server/db";
import { auditTrail, institutions, professionalInstitutions, professionals, users } from "../drizzle/schema";

const STAMP = Date.now();
const PASSWORD = "SenhaAdmin123";

describe("admin: trocar papel reflete no vínculo institucional", () => {
  let app: Express;
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionId: number;
  let adminId: number;
  let targetId: number;
  let targetProfessionalId: number;
  let cookie: string;

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
      .values({
        name: `RoleSync ${STAMP}`,
        cnpj: `${STAMP}`.slice(-14).padStart(14, "0"),
        legalName: `RoleSync ${STAMP}`,
        tradeName: `RS${STAMP}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = inst.id;

    const [admin] = await db
      .insert(users)
      .values({
        name: "RoleSync Admin",
        email: `rolesync-admin-${STAMP}@test.local`,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        loginMethod: "email",
        role: "admin",
      })
      .$returningId();
    adminId = admin.id;

    // Alvo começa como GESTOR_MEDICO na instituição.
    const [target] = await db
      .insert(users)
      .values({
        name: "RoleSync Alvo",
        email: `rolesync-alvo-${STAMP}@test.local`,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        loginMethod: "email",
        role: "manager",
      })
      .$returningId();
    targetId = target.id;
    const [pro] = await db
      .insert(professionals)
      .values({ userId: targetId, name: "RoleSync Alvo", role: "Médico", userRole: "GESTOR_MEDICO" })
      .$returningId();
    targetProfessionalId = pro.id;
    await db.insert(professionalInstitutions).values({
      professionalId: targetProfessionalId,
      userId: targetId,
      institutionId,
      roleInInstitution: "GESTOR_MEDICO",
      isPrimary: true,
      active: true,
    });

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: `rolesync-admin-${STAMP}@test.local`, password: PASSWORD });
    expect(login.status).toBe(200);
    const setCookie = login.headers["set-cookie"];
    const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
    cookie = arr.find((c: string) => c.startsWith("session=")) ?? "";
    expect(cookie).not.toBe("");
  });

  afterAll(async () => {
    // O login do admin cria professional + vínculo via ensureProfessionalLink:
    // limpar por userId, não só o que o teste inseriu.
    await db.delete(auditTrail).where(inArray(auditTrail.entityId, [targetId, adminId]));
    await db.delete(professionalInstitutions).where(inArray(professionalInstitutions.userId, [adminId, targetId]));
    await db.delete(professionals).where(inArray(professionals.userId, [adminId, targetId]));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    await db.delete(users).where(inArray(users.id, [adminId, targetId]));
  });

  async function linkRole(): Promise<string> {
    const [row] = await db
      .select({ role: professionalInstitutions.roleInInstitution })
      .from(professionalInstitutions)
      .where(eq(professionalInstitutions.userId, targetId));
    return row?.role ?? "";
  }

  async function canManage(): Promise<boolean> {
    const actor = await resolveTenantActor(targetId, institutionId, false);
    return actorCapabilities(actor).canCreateShift;
  }

  it("estado inicial: gestor gerencia a escala", async () => {
    expect(await linkRole()).toBe("GESTOR_MEDICO");
    expect(await canManage()).toBe(true);
  });

  it("rebaixar para doctor revoga o poder de gestão de verdade", async () => {
    const res = await request(app).put(`/api/admin/users/${targetId}`).set("Cookie", cookie).send({ role: "doctor" });
    expect(res.status).toBe(200);
    expect(await linkRole()).toBe("USER");
    expect(await canManage()).toBe(false);
    const [pro] = await db.select({ userRole: professionals.userRole }).from(professionals).where(eq(professionals.id, targetProfessionalId));
    expect(pro.userRole).toBe("USER");
  });

  it("promover para manager concede o poder de gestão", async () => {
    const res = await request(app).put(`/api/admin/users/${targetId}`).set("Cookie", cookie).send({ role: "manager" });
    expect(res.status).toBe(200);
    expect(await linkRole()).toBe("GESTOR_MEDICO");
    expect(await canManage()).toBe(true);
  });

  it("promover para admin vira GESTOR_PLUS no vínculo", async () => {
    const res = await request(app).put(`/api/admin/users/${targetId}`).set("Cookie", cookie).send({ role: "admin" });
    expect(res.status).toBe(200);
    expect(await linkRole()).toBe("GESTOR_PLUS");
  });

  it("atualizar só o nome não mexe no vínculo", async () => {
    const res = await request(app).put(`/api/admin/users/${targetId}`).set("Cookie", cookie).send({ name: "RoleSync Alvo 2" });
    expect(res.status).toBe(200);
    expect(await linkRole()).toBe("GESTOR_PLUS");
  });
});
