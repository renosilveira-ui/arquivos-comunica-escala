// tests/signup-aprovacao.test.ts — auto-cadastro público + aprovação pelo admin.
//
// Lacuna apontada na auditoria 22/08 (parte 2): o fluxo validado "a mão"
// em 18/08 (PR #168) não tinha teste de regressão.
//
//   1. POST /api/auth/signup valida campos, instituição e e-mail duplicado.
//   2. A conta nasce PENDING com vínculo INATIVO: login responde (o app
//      bloqueia na tela de aprovação), mas nenhum tenant é resolvido.
//   3. Admin aprova: vínculo ativo, acesso setorial explícito, login com
//      approvalStatus APPROVED, tenant resolvido.
//   4. Admin recusa: cadastro removido, login volta a 401, segunda recusa 404.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request from "supertest";
import express, { type Express } from "express";
import {
  auditTrail,
  hospitals,
  institutions,
  medicalSpecialties,
  professionalAccess,
  professionalInstitutions,
  professionals,
  scheduleContexts,
  sectors,
  users,
} from "../drizzle/schema";
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
  let inactiveInstitutionId: number;
  let otherInstitutionId: number;
  let hospitalA: number;
  let hospitalB: number;
  let recoverySectorId: number;
  let trrSectorId: number;
  let emergencySectorId: number;
  let anesthesiaContextId: number;
  let trrContextId: number;
  let emergencyContextId: number;
  let otherTenantContextId: number;
  let adminId: number;
  let adminCookie: string;
  const emailA = `signup-a-${STAMP}@test.local`;
  const emailB = `signup-b-${STAMP}@test.local`;

  async function login(email: string, password: string) {
    return request(app).post("/api/auth/login").send({ email, password });
  }
  function cookieOf(res: request.Response): string {
    const sc = res.headers["set-cookie"];
    return (
      (Array.isArray(sc) ? sc : [sc]).find((c: string) =>
        c?.startsWith("session="),
      ) ?? ""
    );
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
      .values({
        name: `Signup Tenant ${STAMP}`,
        cnpj: `${STAMP}9`.slice(-14).padStart(14, "0"),
        legalName: `Signup ${STAMP}`,
        tradeName: `SG${STAMP}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = inst.id;
    const [inactive] = await db
      .insert(institutions)
      .values({
        name: `Signup Inactive ${STAMP}`,
        cnpj: `${STAMP}8`.slice(-14).padStart(14, "0"),
        legalName: `Signup Inactive ${STAMP}`,
        tradeName: `SGI${STAMP}`.slice(0, 20),
        isActive: false,
      })
      .$returningId();
    inactiveInstitutionId = inactive.id;
    const [other] = await db
      .insert(institutions)
      .values({
        name: `Signup Other ${STAMP}`,
        cnpj: `${STAMP}7`.slice(-14).padStart(14, "0"),
        legalName: `Signup Other ${STAMP}`,
        tradeName: `SGO${STAMP}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    otherInstitutionId = other.id;
    const [ha] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Signup Hospital A ${STAMP}` })
      .$returningId();
    const [hb] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Signup Hospital B ${STAMP}` })
      .$returningId();
    hospitalA = ha.id;
    hospitalB = hb.id;
    const [recovery] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId: hospitalA,
        name: `Sala de Recuperação ${STAMP}`,
        category: "cirurgico",
        color: "#2563EB",
      })
      .$returningId();
    const [trr] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId: hospitalA,
        name: `TRR ${STAMP}`,
        category: "servico",
        color: "#16A34A",
      })
      .$returningId();
    const [emergency] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId: hospitalB,
        name: `Emergência ${STAMP}`,
        category: "servico",
        color: "#DC2626",
      })
      .$returningId();
    recoverySectorId = recovery.id;
    trrSectorId = trr.id;
    emergencySectorId = emergency.id;
    await db
      .insert(medicalSpecialties)
      .values({
        code: "ANESTESIOLOGIA",
        name: "Anestesiologia",
        sourceVersion: "CFM_2380_2024",
        active: true,
        sortOrder: 2,
      })
      .onDuplicateKeyUpdate({ set: { active: true } });
    const [anesthesia] = await db
      .select({ id: medicalSpecialties.id })
      .from(medicalSpecialties)
      .where(eq(medicalSpecialties.code, "ANESTESIOLOGIA"));
    const [anesthesiaContext] = await db
      .insert(scheduleContexts)
      .values({
        institutionId,
        hospitalId: hospitalA,
        sectorId: recoverySectorId,
        medicalSpecialtyId: anesthesia.id,
      })
      .$returningId();
    const [trrContext] = await db
      .insert(scheduleContexts)
      .values({
        institutionId,
        hospitalId: hospitalA,
        sectorId: trrSectorId,
        operationalProfileCode: "MEDICO_GENERALISTA",
      })
      .$returningId();
    const [emergencyContext] = await db
      .insert(scheduleContexts)
      .values({
        institutionId,
        hospitalId: hospitalB,
        sectorId: emergencySectorId,
        operationalProfileCode: "MEDICO_GENERALISTA",
      })
      .$returningId();
    anesthesiaContextId = anesthesiaContext.id;
    trrContextId = trrContext.id;
    emergencyContextId = emergencyContext.id;
    const [otherHospital] = await db
      .insert(hospitals)
      .values({
        institutionId: otherInstitutionId,
        name: `Outro Hospital ${STAMP}`,
      })
      .$returningId();
    const [otherSector] = await db
      .insert(sectors)
      .values({
        institutionId: otherInstitutionId,
        hospitalId: otherHospital.id,
        name: `TRR Outro ${STAMP}`,
        category: "servico",
        color: "#7C3AED",
      })
      .$returningId();
    const [otherContext] = await db
      .insert(scheduleContexts)
      .values({
        institutionId: otherInstitutionId,
        hospitalId: otherHospital.id,
        sectorId: otherSector.id,
        operationalProfileCode: "MEDICO_GENERALISTA",
      })
      .$returningId();
    otherTenantContextId = otherContext.id;

    const [admin] = await db
      .insert(users)
      .values({
        name: "Signup Admin",
        email: `signup-admin-${STAMP}@test.local`,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        loginMethod: "email",
        role: "admin",
      })
      .$returningId();
    adminId = admin.id;
    const [pro] = await db
      .insert(professionals)
      .values({
        userId: adminId,
        name: "Signup Admin",
        role: "Gestor",
        userRole: "GESTOR_PLUS",
      })
      .$returningId();
    await db.insert(professionalInstitutions).values({
      professionalId: pro.id,
      userId: adminId,
      institutionId,
      roleInInstitution: "GESTOR_PLUS",
      isPrimary: true,
      active: true,
    });
    const res = await login(`signup-admin-${STAMP}@test.local`, PASSWORD);
    expect(res.status).toBe(200);
    adminCookie = cookieOf(res);
    expect(adminCookie).not.toBe("");
  });

  afterAll(async () => {
    const mine = await db
      .select({ id: users.id })
      .from(users)
      .where(like(users.email, `signup-%-${STAMP}@test.local`));
    const ids = mine.map((u) => u.id);
    await db
      .delete(auditTrail)
      .where(eq(auditTrail.institutionId, institutionId));
    if (ids.length)
      await db.delete(auditTrail).where(inArray(auditTrail.entityId, ids));
    await db
      .delete(professionalAccess)
      .where(eq(professionalAccess.institutionId, institutionId));
    await db
      .delete(professionalInstitutions)
      .where(eq(professionalInstitutions.institutionId, institutionId));
    if (ids.length)
      await db.delete(professionals).where(inArray(professionals.userId, ids));
    await db
      .delete(scheduleContexts)
      .where(eq(scheduleContexts.institutionId, institutionId));
    await db.delete(sectors).where(eq(sectors.institutionId, institutionId));
    await db
      .delete(hospitals)
      .where(inArray(hospitals.id, [hospitalA, hospitalB]));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
    await db
      .delete(institutions)
      .where(eq(institutions.id, inactiveInstitutionId));
    await db
      .delete(scheduleContexts)
      .where(eq(scheduleContexts.institutionId, otherInstitutionId));
    await db
      .delete(sectors)
      .where(eq(sectors.institutionId, otherInstitutionId));
    await db
      .delete(hospitals)
      .where(eq(hospitals.institutionId, otherInstitutionId));
    await db
      .delete(institutions)
      .where(eq(institutions.id, otherInstitutionId));
    if (ids.length) await db.delete(users).where(inArray(users.id, ids));
  });

  it("valida campos, senha curta e instituição", async () => {
    expect(
      (
        await request(app)
          .post("/api/auth/signup")
          .send({ email: emailA, password: PASSWORD, institutionId })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post("/api/auth/signup")
          .send({ name: "X", email: emailA, password: "curta", institutionId })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post("/api/auth/signup")
          .send({ name: "X", email: emailA, password: PASSWORD })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app).post("/api/auth/signup").send({
          name: "X",
          email: emailA,
          password: PASSWORD,
          institutionId: 99999999,
        })
      ).status,
    ).toBe(400);
    const inactiveEmail = `signup-inactive-${STAMP}@test.local`;
    expect(
      (
        await request(app).post("/api/auth/signup").send({
          name: "Signup Inactive",
          email: inactiveEmail,
          password: PASSWORD,
          institutionId: inactiveInstitutionId,
        })
      ).status,
    ).toBe(400);
    expect(
      await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, inactiveEmail)),
    ).toHaveLength(0);

    const unknown = await request(app)
      .post("/api/auth/signup")
      .send({
        name: "Especialidade livre",
        email: `signup-unknown-${STAMP}@test.local`,
        password: PASSWORD,
        institutionId,
        specialty: "Especialista em TRR",
      });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/catálogo/i);
    const both = await request(app)
      .post("/api/auth/signup")
      .send({
        name: "Dupla qualificação",
        email: `signup-both-${STAMP}@test.local`,
        password: PASSWORD,
        institutionId,
        medicalSpecialtyCode: "ANESTESIOLOGIA",
        operationalProfileCode: "MEDICO_GENERALISTA",
      });
    expect(both.status).toBe(400);
  });

  it("signup concorrente do mesmo e-mail produz uma conta completa, nunca órfã", async () => {
    const email = `signup-race-${STAMP}@test.local`;
    const payload = {
      name: "Signup Race",
      email,
      password: PASSWORD,
      institutionId,
      specialty: "Anestesiologia",
    };
    const responses = await Promise.all([
      request(app).post("/api/auth/signup").send(payload),
      request(app).post("/api/auth/signup").send(payload),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);

    const created = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));
    expect(created).toHaveLength(1);
    expect(
      await db
        .select({ id: professionals.id })
        .from(professionals)
        .where(eq(professionals.userId, created[0].id)),
    ).toHaveLength(1);
    const memberships = await db
      .select({ active: professionalInstitutions.active })
      .from(professionalInstitutions)
      .where(eq(professionalInstitutions.userId, created[0].id));
    expect(memberships).toEqual([{ active: false }]);
  });

  it("cria conta PENDING com vínculo inativo; e-mail duplicado → 409", async () => {
    const res = await request(app).post("/api/auth/signup").send({
      name: "  Signup A  ",
      email: emailA.toUpperCase(),
      password: PASSWORD,
      institutionId,
      medicalSpecialtyCode: "ANESTESIOLOGIA",
      operationalProfileCode: null,
    });
    expect(res.status).toBe(201);
    const [u] = await db.select().from(users).where(eq(users.email, emailA));
    expect(u.approvalStatus).toBe("PENDING");
    expect(u.role).toBe("doctor");
    expect(u.name).toBe("Signup A");
    const [link] = await db
      .select()
      .from(professionalInstitutions)
      .where(eq(professionalInstitutions.userId, u.id));
    expect(link.institutionId).toBe(institutionId);
    expect(link.active).toBe(false);
    expect(link.roleInInstitution).toBe("USER");
    const [pro] = await db
      .select({
        specialty: professionals.specialty,
        medicalSpecialtyId: professionals.medicalSpecialtyId,
        operationalProfileCode: professionals.operationalProfileCode,
        medicalSpecialtyCode: medicalSpecialties.code,
      })
      .from(professionals)
      .leftJoin(
        medicalSpecialties,
        eq(medicalSpecialties.id, professionals.medicalSpecialtyId),
      )
      .where(eq(professionals.userId, u.id));
    expect(pro).toMatchObject({
      specialty: "Anestesiologia",
      medicalSpecialtyCode: "ANESTESIOLOGIA",
      operationalProfileCode: null,
    });
    expect(pro.medicalSpecialtyId).toBeTypeOf("number");
    const [audit] = await db
      .select({
        description: auditTrail.description,
        metadata: auditTrail.metadata,
      })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.entityId, u.id),
          eq(auditTrail.action, "USER_CREATED"),
        ),
      );
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit)).not.toContain(emailA);
    expect((audit.metadata as Record<string, unknown>).email).toBeUndefined();

    const dup = await request(app).post("/api/auth/signup").send({
      name: "Outro",
      email: emailA,
      password: PASSWORD,
      institutionId,
    });
    expect(dup.status).toBe(409);
  });

  it("classifica Clínica Geral como perfil generalista, nunca Clínica médica", async () => {
    const email = `signup-generalist-${STAMP}@test.local`;
    const res = await request(app).post("/api/auth/signup").send({
      name: "Signup Generalista",
      email,
      password: PASSWORD,
      institutionId,
      // Compatibilidade da build anterior: texto só é aceito quando resolve
      // inequivocamente para um item conhecido.
      specialty: "Clínica Geral",
    });
    expect(res.status).toBe(201);
    const [professional] = await db
      .select({
        medicalSpecialtyId: professionals.medicalSpecialtyId,
        operationalProfileCode: professionals.operationalProfileCode,
        legacyLabel: professionals.specialty,
      })
      .from(professionals)
      .innerJoin(users, eq(users.id, professionals.userId))
      .where(eq(users.email, email));
    expect(professional).toEqual({
      medicalSpecialtyId: null,
      operationalProfileCode: "MEDICO_GENERALISTA",
      legacyLabel: "Médico generalista",
    });
  });

  it("cadastro direto separa dois generalistas por setor e rejeita ambiguidade/incompatibilidade sem escrever", async () => {
    const [pendingGeneralist] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, `signup-generalist-${STAMP}@test.local`));
    const ambiguousApproval = await request(app)
      .post(`/api/admin/pending-signups/${pendingGeneralist.id}/approve`)
      .set("Cookie", adminCookie)
      .set("x-tenant-id", String(institutionId));
    expect(ambiguousApproval.status).toBe(409);
    expect(ambiguousApproval.body.error).toMatch(/mais de uma escala/i);
    const [stillPending] = await db
      .select({ status: users.approvalStatus })
      .from(users)
      .where(eq(users.id, pendingGeneralist.id));
    expect(stillPending.status).toBe("PENDING");

    const explicitApproval = await request(app)
      .post(`/api/admin/pending-signups/${pendingGeneralist.id}/approve`)
      .set("Cookie", adminCookie)
      .set("x-tenant-id", String(institutionId))
      .send({ scheduleContextIds: [trrContextId] });
    expect(explicitApproval.status).toBe(200);

    const create = (tag: string, scheduleContextIds?: number[]) =>
      request(app)
        .post("/api/auth/register")
        .set("Cookie", adminCookie)
        .set("x-tenant-id", String(institutionId))
        .send({
          name: `Generalista ${tag}`,
          email: `signup-direct-${tag}-${STAMP}@test.local`,
          password: PASSWORD,
          professionalRole: "doctor",
          roleInInstitution: "USER",
          operationalProfileCode: "MEDICO_GENERALISTA",
          medicalSpecialtyCode: null,
          ...(scheduleContextIds ? { scheduleContextIds } : {}),
        });

    const trr = await create("trr", [trrContextId]);
    const emergency = await create("emergency", [emergencyContextId]);
    expect(trr.status).toBe(201);
    expect(emergency.status).toBe(201);

    const created = await db
      .select({
        email: users.email,
        hospitalId: professionalAccess.hospitalId,
        sectorId: professionalAccess.sectorId,
      })
      .from(users)
      .innerJoin(professionals, eq(professionals.userId, users.id))
      .innerJoin(
        professionalAccess,
        eq(professionalAccess.professionalId, professionals.id),
      )
      .where(
        inArray(users.email, [
          `signup-direct-trr-${STAMP}@test.local`,
          `signup-direct-emergency-${STAMP}@test.local`,
        ]),
      );
    expect(created).toEqual(
      expect.arrayContaining([
        {
          email: `signup-direct-trr-${STAMP}@test.local`,
          hospitalId: hospitalA,
          sectorId: trrSectorId,
        },
        {
          email: `signup-direct-emergency-${STAMP}@test.local`,
          hospitalId: hospitalB,
          sectorId: emergencySectorId,
        },
      ]),
    );
    expect(created.every((row) => row.sectorId !== null)).toBe(true);

    const edit = await request(app)
      .put(`/api/admin/users/${trr.body.user.id}`)
      .set("Cookie", adminCookie)
      .set("x-tenant-id", String(institutionId))
      .send({
        name: "Generalista TRR movido",
        email: `signup-direct-trr-${STAMP}@test.local`,
        roleInInstitution: "USER",
        medicalSpecialtyCode: null,
        operationalProfileCode: "MEDICO_GENERALISTA",
        scheduleContextIds: [emergencyContextId],
      });
    expect(edit.status).toBe(200);
    const [trrProfessional] = await db
      .select({ id: professionals.id })
      .from(professionals)
      .where(eq(professionals.userId, trr.body.user.id));
    expect(
      await db
        .select({
          hospitalId: professionalAccess.hospitalId,
          sectorId: professionalAccess.sectorId,
        })
        .from(professionalAccess)
        .where(eq(professionalAccess.professionalId, trrProfessional.id)),
    ).toEqual([{ hospitalId: hospitalB, sectorId: emergencySectorId }]);

    const invalidEdit = await request(app)
      .put(`/api/admin/users/${trr.body.user.id}`)
      .set("Cookie", adminCookie)
      .set("x-tenant-id", String(institutionId))
      .send({
        operationalProfileCode: "MEDICO_GENERALISTA",
        medicalSpecialtyCode: null,
        scheduleContextIds: [anesthesiaContextId],
      });
    expect(invalidEdit.status).toBe(409);
    expect(
      await db
        .select({ sectorId: professionalAccess.sectorId })
        .from(professionalAccess)
        .where(eq(professionalAccess.professionalId, trrProfessional.id)),
    ).toEqual([{ sectorId: emergencySectorId }]);

    const ambiguous = await create("ambiguous");
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.error).toMatch(/mais de uma escala/i);
    const incompatible = await create("mismatch", [anesthesiaContextId]);
    expect(incompatible.status).toBe(409);
    expect(incompatible.body.error).toMatch(/incompatível/i);
    const crossTenant = await create("cross-tenant", [otherTenantContextId]);
    expect(crossTenant.status).toBe(409);
    const forbiddenWrites = await db
      .select({ id: users.id })
      .from(users)
      .where(
        inArray(users.email, [
          `signup-direct-ambiguous-${STAMP}@test.local`,
          `signup-direct-mismatch-${STAMP}@test.local`,
          `signup-direct-cross-tenant-${STAMP}@test.local`,
        ]),
      );
    expect(forbiddenWrites).toEqual([]);
  });

  it("PENDING: login responde com approvalStatus PENDING, mas nenhum tenant é resolvido", async () => {
    const res = await login(emailA, PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.user.approvalStatus).toBe("PENDING");
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, emailA));
    await expect(resolveInstitutionForUser(u.id, null)).rejects.toThrow(
      /sem vínculo/i,
    );
    const links = await db
      .select({ active: professionalInstitutions.active })
      .from(professionalInstitutions)
      .where(eq(professionalInstitutions.userId, u.id));
    expect(links.every((l) => l.active === false)).toBe(true); // o login não ativou nada por baixo dos panos
  });

  it("admin lista o pendente, aprova: vínculo ativo e acesso setorial específico", async () => {
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, emailA));
    const list = await request(app)
      .get("/api/admin/pending-signups")
      .set("Cookie", adminCookie)
      .set("x-tenant-id", String(institutionId));
    expect(list.status).toBe(200);
    expect(list.body.pending.map((p: any) => p.id)).toContain(u.id);
    expect(list.body.pending.find((p: any) => p.id === u.id)).toMatchObject({
      medicalSpecialtyCode: "ANESTESIOLOGIA",
      operationalProfileCode: null,
    });

    const ok = await request(app)
      .post(`/api/admin/pending-signups/${u.id}/approve`)
      .set("Cookie", adminCookie)
      .set("x-tenant-id", String(institutionId));
    expect(ok.status).toBe(200);
    const [approvalAudit] = await db
      .select({
        description: auditTrail.description,
        metadata: auditTrail.metadata,
      })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.entityId, u.id),
          eq(auditTrail.action, "USER_UPDATED"),
        ),
      );
    expect(approvalAudit).toBeTruthy();
    expect(JSON.stringify(approvalAudit)).not.toContain(emailA);
    expect(
      (approvalAudit.metadata as Record<string, unknown>).email,
    ).toBeUndefined();
    const [link] = await db
      .select()
      .from(professionalInstitutions)
      .where(eq(professionalInstitutions.userId, u.id));
    expect(link.active).toBe(true);
    const access = await db
      .select({
        hospitalId: professionalAccess.hospitalId,
        sectorId: professionalAccess.sectorId,
      })
      .from(professionalAccess)
      .where(eq(professionalAccess.professionalId, link.professionalId));
    expect(access).toEqual([
      { hospitalId: hospitalA, sectorId: recoverySectorId },
    ]);
    expect(access.every((row) => row.sectorId !== null)).toBe(true);

    const res = await login(emailA, PASSWORD);
    expect(res.body.user.approvalStatus).toBe("APPROVED");
    const tenant = await resolveInstitutionForUser(u.id, null);
    expect(tenant.institutionId).toBe(institutionId);

    // Aprovar de novo → 404 (já não é pendente)
    expect(
      (
        await request(app)
          .post(`/api/admin/pending-signups/${u.id}/approve`)
          .set("Cookie", adminCookie)
          .set("x-tenant-id", String(institutionId))
      ).status,
    ).toBe(404);
  });

  it("admin recusa: cadastro removido, login 401, segunda recusa 404", async () => {
    const res = await request(app).post("/api/auth/signup").send({
      name: "Signup B",
      email: emailB,
      password: PASSWORD,
      institutionId,
    });
    expect(res.status).toBe(201);
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, emailB));
    // Exercita o fallback da descrição: mesmo sem nome, o audit não pode usar e-mail bruto.
    await db.update(users).set({ name: null }).where(eq(users.id, u.id));
    const rej = await request(app)
      .post(`/api/admin/pending-signups/${u.id}/reject`)
      .set("Cookie", adminCookie)
      .set("x-tenant-id", String(institutionId));
    expect(rej.status).toBe(200);
    const [audit] = await db
      .select({
        description: auditTrail.description,
        metadata: auditTrail.metadata,
      })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.entityId, u.id),
          eq(auditTrail.action, "USER_UPDATED"),
        ),
      );
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit)).not.toContain(emailB);
    expect(audit.description).toContain(`usuário #${u.id}`);
    expect((audit.metadata as Record<string, unknown>).email).toBeUndefined();
    const gone = await db
      .select({ id: users.id, deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, u.id));
    expect(gone.length === 0 || gone[0].deletedAt !== null).toBe(true);
    expect((await login(emailB, PASSWORD)).status).toBe(401);
    expect(
      (
        await request(app)
          .post(`/api/admin/pending-signups/${u.id}/reject`)
          .set("Cookie", adminCookie)
          .set("x-tenant-id", String(institutionId))
      ).status,
    ).toBe(404);
  });

  it("não-admin não acessa a fila de pendentes", async () => {
    const res = await login(emailA, PASSWORD);
    const cookie = cookieOf(res);
    expect(
      (
        await request(app)
          .get("/api/admin/pending-signups")
          .set("Cookie", cookie)
          .set("x-tenant-id", String(institutionId))
      ).status,
    ).toBe(403);
  });
});
