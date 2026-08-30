// tests/auth-admin-config.test.ts — auditoria 22/08 (parte 2), auth/admin.
//
// - POST /api/auth/register exige tenant explícito e canônico; body não pode
//   trocar o tenant e papel institucional nunca promove users.role global.
// - Ações do admin (PUT /users/:id) entram na trilha de auditoria com
//   institution_id (antes o INSERT falhava em silêncio).
// - GET /api/auth/me não é limitado pelo rate limit de autenticação.
// - Erros do driver MySQL não vazam para o cliente tRPC.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request from "supertest";
import express, { type Express } from "express";
import {
  auditTrail,
  hospitals,
  institutions,
  professionalAccess,
  professionalInstitutions,
  professionals,
  scheduleContexts,
  sectors,
  users,
} from "../drizzle/schema";
import { createAuthRateLimit } from "../server/_core/security";
import { isDriverErrorMessage } from "../server/_core/trpc";
import { sdk } from "../server/_core/sdk";
import { getDb } from "../server/db";
import { adminRouter } from "../server/routes/admin";
import { authRouter } from "../server/routes/auth";
import * as auditService from "../server/audit-trail";
import { sessionAuthCookies } from "./helpers/session-cookies";

const STAMP = Date.now();
const PASSWORD = "SenhaAdmin123";

type TestDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;

async function createSingleActiveGeneralistContext(
  db: TestDb,
  institutionId: number,
  tag: string,
): Promise<number> {
  const [hospital] = await db
    .insert(hospitals)
    .values({
      institutionId,
      name: `AAC Hospital ${tag} ${STAMP}`,
    })
    .$returningId();
  const [sector] = await db
    .insert(sectors)
    .values({
      institutionId,
      hospitalId: hospital.id,
      name: `AAC Emergência ${tag} ${STAMP}`,
      category: "servico",
      color: "#2563EB",
    })
    .$returningId();
  const [context] = await db
    .insert(scheduleContexts)
    .values({
      institutionId,
      hospitalId: hospital.id,
      sectorId: sector.id,
      medicalSpecialtyId: null,
      operationalProfileCode: "MEDICO_GENERALISTA",
      active: true,
    })
    .$returningId();
  return context.id;
}

function generalistRegistration(scheduleContextId: number) {
  return {
    medicalSpecialtyCode: null,
    operationalProfileCode: "MEDICO_GENERALISTA" as const,
    scheduleContextIds: [scheduleContextId],
  };
}

describe("auth/admin: instituição do cadastro, auditoria, rate limit, erros", () => {
  let app: Express;
  let db: TestDb;
  let instA: number;
  let instB: number;
  let instC: number;
  let contextA: number;
  let contextB: number;
  let adminId: number;
  let cookie: string;
  const createdUserIds: number[] = [];

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;
    app = express();
    app.use(express.json());
    const limiter = createAuthRateLimit({ max: 50, windowMs: 60_000 });
    app.use(
      "/api/auth",
      (req, res, next) =>
        req.method === "GET" ? next() : limiter(req, res, next),
      authRouter,
    );
    app.use("/api/admin", adminRouter);

    const mk = async (tag: string) => {
      const [i] = await db
        .insert(institutions)
        .values({
          name: `AAC ${tag} ${STAMP}`,
          cnpj: `${STAMP}${tag === "A" ? 7 : tag === "B" ? 8 : 9}`
            .slice(-14)
            .padStart(14, "0"),
          legalName: `AAC ${tag}`,
          tradeName: `AAC${tag}${STAMP}`.slice(0, 20),
          isActive: true,
        })
        .$returningId();
      return i.id;
    };
    instA = await mk("A");
    instB = await mk("B");
    instC = await mk("C");
    contextA = await createSingleActiveGeneralistContext(db, instA, "A");
    contextB = await createSingleActiveGeneralistContext(db, instB, "B");

    const [admin] = await db
      .insert(users)
      .values({
        name: "AAC Admin",
        email: `aac-admin-${STAMP}@test.local`,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        loginMethod: "email",
        role: "admin",
      })
      .$returningId();
    adminId = admin.id;
    createdUserIds.push(adminId);
    const [pro] = await db
      .insert(professionals)
      .values({
        userId: adminId,
        name: "AAC Admin",
        role: "Gestor",
        userRole: "GESTOR_PLUS",
      })
      .$returningId();
    await db.insert(professionalInstitutions).values([
      {
        professionalId: pro.id,
        userId: adminId,
        institutionId: instA,
        roleInInstitution: "GESTOR_PLUS",
        isPrimary: true,
        active: true,
      },
      {
        professionalId: pro.id,
        userId: adminId,
        institutionId: instB,
        roleInInstitution: "GESTOR_PLUS",
        isPrimary: false,
        active: true,
      },
    ]);

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: `aac-admin-${STAMP}@test.local`, password: PASSWORD });
    expect(login.status).toBe(200);
    cookie = sessionAuthCookies(login);
    expect(cookie).not.toBe("");
  });

  afterAll(async () => {
    const mine = await db
      .select({ id: users.id })
      .from(users)
      .where(like(users.email, `aac-%-${STAMP}@test.local`));
    const ids = [...new Set([...createdUserIds, ...mine.map((u) => u.id)])];
    await db
      .delete(auditTrail)
      .where(inArray(auditTrail.institutionId, [instA, instB, instC]));
    await db.delete(auditTrail).where(inArray(auditTrail.entityId, ids));
    await db
      .delete(professionalAccess)
      .where(inArray(professionalAccess.institutionId, [instA, instB, instC]));
    await db
      .delete(professionalInstitutions)
      .where(inArray(professionalInstitutions.userId, ids));
    await db.delete(professionals).where(inArray(professionals.userId, ids));
    await db
      .delete(scheduleContexts)
      .where(inArray(scheduleContexts.institutionId, [instA, instB, instC]));
    await db
      .delete(sectors)
      .where(inArray(sectors.institutionId, [instA, instB, instC]));
    await db
      .delete(hospitals)
      .where(inArray(hospitals.institutionId, [instA, instB, instC]));
    await db
      .delete(institutions)
      .where(inArray(institutions.id, [instA, instB, instC]));
    await db.delete(users).where(inArray(users.id, ids));
  });

  it("JWT exact-v1 sem proof mantém 428 nas superfícies REST admin e register", async () => {
    const [admin] = await db
      .select({
        name: users.name,
        sessionVersion: users.sessionVersion,
      })
      .from(users)
      .where(eq(users.id, adminId));
    const token = await sdk.signSession({
      userId: String(adminId),
      name: admin.name ?? "AAC Admin",
      sessionVersion: admin.sessionVersion,
      sessionBindingVersion: 1,
    });

    const adminResponse = await request(app)
      .get("/api/admin/users")
      .set("Cookie", `session=${token}`)
      .set("x-tenant-id", String(instA));
    expect(adminResponse.status).toBe(428);
    expect(adminResponse.body).toMatchObject({
      code: "SESSION_INSTANCE_REQUIRED",
    });

    const deniedEmail = `aac-exact-missing-${STAMP}@test.local`;
    const registerResponse = await request(app)
      .post("/api/auth/register")
      .set("Cookie", `session=${token}`)
      .set("x-tenant-id", String(instA))
      .send({
        name: "AAC Exact Missing",
        email: deniedEmail,
        password: "SenhaNova123",
        role: "doctor",
        ...generalistRegistration(contextA),
      });
    expect(registerResponse.status).toBe(428);
    expect(registerResponse.body).toMatchObject({
      code: "SESSION_INSTANCE_REQUIRED",
    });
    expect(
      await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, deniedEmail)),
    ).toEqual([]);
  });

  it("register: usa a instituição ativa do admin (x-tenant-id) e não toca na instituição 1", async () => {
    const [before] = await db
      .select({ name: institutions.name, cnpj: institutions.cnpj })
      .from(institutions)
      .where(eq(institutions.id, 1));
    const targetEmail = `aac-novo-b-${STAMP}@test.local`;
    const res = await request(app)
      .post("/api/auth/register")
      .set("Cookie", cookie)
      .set("x-tenant-id", String(instB))
      .set("x-client-expected-user-id", String(adminId))
      .send({
        name: "AAC Novo B",
        email: targetEmail,
        password: "SenhaNova123",
        role: "doctor",
        ...generalistRegistration(contextB),
      });
    expect(res.status).toBe(201);
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, targetEmail));
    createdUserIds.push(u.id);
    const links = await db
      .select({ institutionId: professionalInstitutions.institutionId })
      .from(professionalInstitutions)
      .where(eq(professionalInstitutions.userId, u.id));
    expect(links.map((l) => l.institutionId)).toEqual([instB]);
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
    expect(JSON.stringify(audit)).not.toContain(targetEmail);
    expect((audit.metadata as Record<string, unknown>).email).toBeUndefined();
    const [after] = await db
      .select({ name: institutions.name, cnpj: institutions.cnpj })
      .from(institutions)
      .where(eq(institutions.id, 1));
    expect(after).toEqual(before);
  });

  it("expected-user divergente bloqueia register e mutação admin antes de writes", async () => {
    const deniedEmail = `aac-expected-user-denied-${STAMP}@test.local`;
    const register = await request(app)
      .post("/api/auth/register")
      .set("Cookie", cookie)
      .set("x-tenant-id", String(instA))
      .set("x-client-expected-user-id", String(adminId + 1))
      .send({
        name: "AAC Expected Denied",
        email: deniedEmail,
        password: "SenhaNova123",
        role: "doctor",
        ...generalistRegistration(contextA),
      });
    expect(register.status).toBe(409);
    expect(register.body).toMatchObject({ code: "EXPECTED_USER_MISMATCH" });
    expect(
      await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, deniedEmail)),
    ).toHaveLength(0);

    const [targetBefore] = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.email, `aac-novo-b-${STAMP}@test.local`));
    const auditsBefore = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.entityId, targetBefore.id),
          eq(auditTrail.action, "USER_UPDATED"),
        ),
      );
    const update = await request(app)
      .put(`/api/admin/users/${targetBefore.id}`)
      .set("Cookie", cookie)
      .set("x-tenant-id", String(instB))
      .set("x-client-expected-user-id", String(adminId + 1))
      .send({ name: "NOME QUE NÃO PODE SER GRAVADO" });
    expect(update.status).toBe(409);
    expect(update.body).toMatchObject({ code: "EXPECTED_USER_MISMATCH" });

    const [targetAfter] = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.id, targetBefore.id));
    expect(targetAfter).toEqual(targetBefore);
    expect(
      await db
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(
          and(
            eq(auditTrail.entityId, targetBefore.id),
            eq(auditTrail.action, "USER_UPDATED"),
          ),
        ),
    ).toEqual(auditsBefore);
  });

  it("expected-user malformado é 400, ausência de credencial é 401 e ambos fazem zero writes", async () => {
    const malformedEmail = `aac-expected-malformed-${STAMP}@test.local`;
    const unauthenticatedEmail = `aac-expected-unauth-${STAMP}@test.local`;
    const [adminBefore] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, adminId));

    const malformedRegister = await request(app)
      .post("/api/auth/register")
      .set("Cookie", cookie)
      .set("x-tenant-id", String(instA))
      .set("x-client-expected-user-id", `0${adminId}`)
      .send({
        name: "AAC Malformed",
        email: malformedEmail,
        password: "SenhaNova123",
        role: "doctor",
        ...generalistRegistration(contextA),
      });
    expect(malformedRegister.status).toBe(400);
    expect(malformedRegister.body).toMatchObject({
      code: "MALFORMED_EXPECTED_USER_ID",
    });

    const malformedAdmin = await request(app)
      .put(`/api/admin/users/${adminId}`)
      .set("Cookie", cookie)
      .set("x-tenant-id", String(instA))
      .set("x-client-expected-user-id", `0${adminId}`)
      .send({ name: "NÃO GRAVAR MALFORMED" });
    expect(malformedAdmin.status).toBe(400);
    expect(malformedAdmin.body).toMatchObject({
      code: "MALFORMED_EXPECTED_USER_ID",
    });

    const unauthenticatedRegister = await request(app)
      .post("/api/auth/register")
      .set("x-tenant-id", String(instA))
      .send({
        name: "AAC Unauthenticated",
        email: unauthenticatedEmail,
        password: "SenhaNova123",
        role: "doctor",
        ...generalistRegistration(contextA),
      });
    expect(unauthenticatedRegister.status).toBe(401);

    const unauthenticatedAdmin = await request(app)
      .put(`/api/admin/users/${adminId}`)
      .set("x-tenant-id", String(instA))
      .send({ name: "NÃO GRAVAR UNAUTH" });
    expect(unauthenticatedAdmin.status).toBe(401);

    expect(
      await db
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.email, [malformedEmail, unauthenticatedEmail])),
    ).toEqual([]);
    const [adminAfter] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, adminId));
    expect(adminAfter).toEqual(adminBefore);
  });

  it("register: body só pode repetir o tenant explícito", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .set("Cookie", cookie)
      .set("x-tenant-id", String(instA))
      .send({
        name: "AAC Novo A",
        email: `aac-novo-a-${STAMP}@test.local`,
        password: "SenhaNova123",
        role: "doctor",
        institutionId: instA,
        ...generalistRegistration(contextA),
      });
    expect(res.status).toBe(201);
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, `aac-novo-a-${STAMP}@test.local`));
    createdUserIds.push(u.id);
    const links = await db
      .select({ institutionId: professionalInstitutions.institutionId })
      .from(professionalInstitutions)
      .where(eq(professionalInstitutions.userId, u.id));
    expect(links.map((l) => l.institutionId)).toEqual([instA]);

    const bad = await request(app)
      .post("/api/auth/register")
      .set("Cookie", cookie)
      .set("x-tenant-id", String(instA))
      .send({
        name: "AAC X",
        email: `aac-x-${STAMP}@test.local`,
        password: "SenhaNova123",
        institutionId: 99999999,
        ...generalistRegistration(contextA),
      });
    expect(bad.status).toBe(400);
  });

  it("register: nega tenant ausente, divergente ou sem vínculo canônico do admin", async () => {
    const email = (tag: string) => `aac-deny-${tag}-${STAMP}@test.local`;
    expect(
      (
        await request(app)
          .post("/api/auth/register")
          .set("Cookie", cookie)
          .send({
            name: "AAC Sem Tenant",
            email: email("missing"),
            password: "SenhaNova123",
            ...generalistRegistration(contextA),
          })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post("/api/auth/register")
          .set("Cookie", cookie)
          .set("x-tenant-id", String(instA))
          .send({
            name: "AAC Divergente",
            email: email("mismatch"),
            password: "SenhaNova123",
            institutionId: instB,
            ...generalistRegistration(contextA),
          })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post("/api/auth/register")
          .set("Cookie", cookie)
          .set("x-tenant-id", String(instC))
          .send({
            name: "AAC Tenant C",
            email: email("foreign"),
            password: "SenhaNova123",
            ...generalistRegistration(contextA),
          })
      ).status,
    ).toBe(403);
    for (const tag of ["missing", "mismatch", "foreign"]) {
      expect(
        await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, email(tag))),
      ).toHaveLength(0);
    }
  });

  it("register: payload legado e novo nunca criam admin/manager global", async () => {
    const cases = [
      {
        tag: "legacy-admin",
        payload: {
          role: "admin",
          ...generalistRegistration(contextA),
        },
        globalRole: "doctor",
        institutionRole: "GESTOR_PLUS",
        professionalLabel: "Médico",
      },
      {
        tag: "legacy-manager",
        payload: {
          role: "manager",
          ...generalistRegistration(contextA),
        },
        globalRole: "doctor",
        institutionRole: "GESTOR_MEDICO",
        professionalLabel: "Médico",
      },
      {
        tag: "new-nurse-plus",
        payload: {
          professionalRole: "nurse",
          roleInInstitution: "GESTOR_PLUS",
        },
        globalRole: "nurse",
        institutionRole: "GESTOR_PLUS",
        professionalLabel: "Enfermeiro",
      },
    ] as const;

    for (const item of cases) {
      const email = `aac-${item.tag}-${STAMP}@test.local`;
      const response = await request(app)
        .post("/api/auth/register")
        .set("Cookie", cookie)
        .set("x-tenant-id", String(instA))
        .send({
          name: `AAC ${item.tag}`,
          email,
          password: "SenhaNova123",
          ...item.payload,
        });
      expect(response.status).toBe(201);
      const [created] = await db
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(eq(users.email, email));
      createdUserIds.push(created.id);
      expect(created.role).toBe(item.globalRole);
      const [professional] = await db
        .select({
          label: professionals.role,
          legacyRole: professionals.userRole,
        })
        .from(professionals)
        .where(eq(professionals.userId, created.id));
      expect(professional).toEqual({
        label: item.professionalLabel,
        legacyRole: item.institutionRole,
      });
      const [membership] = await db
        .select({ role: professionalInstitutions.roleInInstitution })
        .from(professionalInstitutions)
        .where(eq(professionalInstitutions.userId, created.id));
      expect(membership.role).toBe(item.institutionRole);
    }

    const conflictEmail = `aac-conflict-${STAMP}@test.local`;
    const conflict = await request(app)
      .post("/api/auth/register")
      .set("Cookie", cookie)
      .set("x-tenant-id", String(instA))
      .send({
        name: "AAC Conflict",
        email: conflictEmail,
        password: "SenhaNova123",
        role: "admin",
        roleInInstitution: "USER",
        ...generalistRegistration(contextA),
      });
    expect(conflict.status).toBe(400);
    expect(
      await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, conflictEmail)),
    ).toHaveLength(0);
  });

  it("register autoriza pelo GESTOR_PLUS contextual, não pelo papel global legado", async () => {
    const actorEmail = `aac-contextual-actor-${STAMP}@test.local`;
    const actorCreation = await request(app)
      .post("/api/auth/register")
      .set("Cookie", cookie)
      .set("x-tenant-id", String(instA))
      .send({
        name: "AAC Contextual Actor",
        email: actorEmail,
        password: "SenhaNova123",
        professionalRole: "doctor",
        roleInInstitution: "GESTOR_PLUS",
        ...generalistRegistration(contextA),
      });
    expect(actorCreation.status).toBe(201);
    const [actor] = await db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.email, actorEmail));
    createdUserIds.push(actor.id);
    expect(actor.role).toBe("doctor");

    const actorLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: actorEmail, password: "SenhaNova123" });
    const actorCookie = sessionAuthCookies(actorLogin);
    expect(actorCookie).not.toBe("");

    const childEmail = `aac-contextual-child-${STAMP}@test.local`;
    const child = await request(app)
      .post("/api/auth/register")
      .set("Cookie", actorCookie)
      .set("x-tenant-id", String(instA))
      .send({
        name: "AAC Contextual Child",
        email: childEmail,
        password: "SenhaNova123",
        ...generalistRegistration(contextA),
      });
    expect(child.status).toBe(201);
    const [childUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, childEmail));
    createdUserIds.push(childUser.id);

    await db
      .update(professionalInstitutions)
      .set({ roleInInstitution: "USER" })
      .where(
        and(
          eq(professionalInstitutions.userId, actor.id),
          eq(professionalInstitutions.institutionId, instA),
        ),
      );
    const deniedEmail = `aac-contextual-denied-${STAMP}@test.local`;
    const denied = await request(app)
      .post("/api/auth/register")
      .set("Cookie", actorCookie)
      .set("x-tenant-id", String(instA))
      .send({
        name: "AAC Contextual Denied",
        email: deniedEmail,
        password: "SenhaNova123",
        ...generalistRegistration(contextA),
      });
    expect(denied.status).toBe(403);
    expect(
      await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, deniedEmail)),
    ).toHaveLength(0);
  });

  it("register revalida o GESTOR_PLUS contextual depois do bcrypt e antes do primeiro write", async () => {
    const targetEmail = `aac-revoked-race-${STAMP}@test.local`;
    const gatedPassword = "SenhaRevogada123";
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
      if (value === gatedPassword) {
        signalHashStarted();
        await hashGate;
      }
      return originalHash(value, rounds);
    }) as typeof bcrypt.hash);

    try {
      const pending = request(app)
        .post("/api/auth/register")
        .set("Cookie", cookie)
        .set("x-tenant-id", String(instA))
        .send({
          name: "AAC Revoked Race",
          email: targetEmail,
          password: gatedPassword,
          ...generalistRegistration(contextA),
        })
        .then((response) => response);
      await hashStarted;
      await db
        .update(professionalInstitutions)
        .set({ roleInInstitution: "USER" })
        .where(
          and(
            eq(professionalInstitutions.userId, adminId),
            eq(professionalInstitutions.institutionId, instA),
          ),
        );
      releaseHash();
      const response = await pending;
      expect(response.status).toBe(403);
      expect(
        await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, targetEmail)),
      ).toHaveLength(0);
    } finally {
      releaseHash();
      hashSpy.mockRestore();
      await db
        .update(professionalInstitutions)
        .set({ roleInInstitution: "GESTOR_PLUS" })
        .where(
          and(
            eq(professionalInstitutions.userId, adminId),
            eq(professionalInstitutions.institutionId, instA),
          ),
        );
    }
  });

  it("register: PI adulterada do ator não autoriza e falha de auditoria reverte todos os writes", async () => {
    const [decoyUser] = await db
      .insert(users)
      .values({
        name: "AAC Decoy",
        email: `aac-decoy-${STAMP}@test.local`,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        loginMethod: "email",
        role: "doctor",
      })
      .$returningId();
    const [decoyProfessional] = await db
      .insert(professionals)
      .values({
        userId: decoyUser.id,
        name: "AAC Decoy",
        role: "Médico",
        userRole: "USER",
      })
      .$returningId();
    const poisonedEmail = `aac-poisoned-admin-${STAMP}@test.local`;
    const [poisonedAdmin] = await db
      .insert(users)
      .values({
        name: "AAC Poisoned Admin",
        email: poisonedEmail,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        loginMethod: "email",
        role: "admin",
      })
      .$returningId();
    await db.insert(professionalInstitutions).values({
      userId: poisonedAdmin.id,
      professionalId: decoyProfessional.id,
      institutionId: instA,
      roleInInstitution: "GESTOR_PLUS",
      isPrimary: true,
      active: true,
    });
    const poisonedLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: poisonedEmail, password: PASSWORD });
    const poisonedCookie = sessionAuthCookies(poisonedLogin);
    const deniedEmail = `aac-poisoned-target-${STAMP}@test.local`;
    const denied = await request(app)
      .post("/api/auth/register")
      .set("Cookie", poisonedCookie)
      .set("x-tenant-id", String(instA))
      .send({
        name: "AAC Poisoned Target",
        email: deniedEmail,
        password: "SenhaNova123",
        ...generalistRegistration(contextA),
      });
    expect(denied.status).toBe(403);
    expect(
      await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, deniedEmail)),
    ).toHaveLength(0);

    const rollbackEmail = `aac-rollback-${STAMP}@test.local`;
    const auditFailure = vi
      .spyOn(auditService, "recordAudit")
      .mockRejectedValueOnce(new Error("forced strict audit failure"));
    const failed = await request(app)
      .post("/api/auth/register")
      .set("Cookie", cookie)
      .set("x-tenant-id", String(instA))
      .send({
        name: "AAC Rollback",
        email: rollbackEmail,
        password: "SenhaNova123",
        professionalRole: "doctor",
        roleInInstitution: "GESTOR_PLUS",
        ...generalistRegistration(contextA),
      });
    auditFailure.mockRestore();
    expect(failed.status).toBe(500);
    expect(
      await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, rollbackEmail)),
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(eq(auditTrail.description, "forced strict audit failure")),
    ).toHaveLength(0);
  });

  it("login/me não inventam vínculo para conta administrativa órfã", async () => {
    const orphanEmail = `aac-orphan-admin-${STAMP}@test.local`;
    const [orphan] = await db
      .insert(users)
      .values({
        name: "AAC Orphan Admin",
        email: orphanEmail,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        loginMethod: "email",
        role: "admin",
      })
      .$returningId();
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: orphanEmail, password: PASSWORD });
    expect(login.status).toBe(200);
    const orphanCookie = sessionAuthCookies(login);
    expect(
      (await request(app).get("/api/auth/me").set("Cookie", orphanCookie))
        .status,
    ).toBe(200);
    expect(
      await db
        .select({ id: professionalInstitutions.id })
        .from(professionalInstitutions)
        .where(eq(professionalInstitutions.userId, orphan.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: professionals.id })
        .from(professionals)
        .where(eq(professionals.userId, orphan.id)),
    ).toHaveLength(0);

    const deniedEmail = `aac-orphan-target-${STAMP}@test.local`;
    const denied = await request(app)
      .post("/api/auth/register")
      .set("Cookie", orphanCookie)
      .set("x-tenant-id", String(instA))
      .send({
        name: "AAC Orphan Target",
        email: deniedEmail,
        password: "SenhaNova123",
        ...generalistRegistration(contextA),
      });
    expect(denied.status).toBe(403);
    expect(
      await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, deniedEmail)),
    ).toHaveLength(0);
  });

  it("admin PUT /users/:id grava auditoria com institution_id", async () => {
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, `aac-novo-a-${STAMP}@test.local`));
    const res = await request(app)
      .put(`/api/admin/users/${u.id}`)
      .set("Cookie", cookie)
      .set("x-tenant-id", String(instA))
      .set("x-client-expected-user-id", String(adminId))
      .send({ name: "AAC Novo A2" });
    expect(res.status).toBe(200);
    const rows = await db
      .select({
        institutionId: auditTrail.institutionId,
        action: auditTrail.action,
      })
      .from(auditTrail)
      .where(
        and(
          eq(auditTrail.entityId, u.id),
          eq(auditTrail.action, "USER_UPDATED"),
        ),
      );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].institutionId).toBe(instA);
  });

  it("GET /api/auth/me não consome o rate limit de autenticação", async () => {
    for (let i = 0; i < 6; i++) {
      const r = await request(app).get("/api/auth/me").set("Cookie", cookie);
      expect(r.status).toBe(200);
      expect(r.headers["cache-control"]).toBe("no-store");
    }
  });

  it("mensagens de erro do driver são reconhecidas para mascarar", () => {
    expect(isDriverErrorMessage("Failed query: insert into `x` ...")).toBe(
      true,
    );
    expect(isDriverErrorMessage("ER_DUP_ENTRY: Duplicate entry")).toBe(true);
    expect(isDriverErrorMessage("Turno não encontrado")).toBe(false);
    expect(isDriverErrorMessage("Apenas Gestor+ pode editar.")).toBe(false);
  });

  it("register in-flight aborta se admin reset revogar a sessão durante o bcrypt", async () => {
    const targetEmail = `aac-session-revoked-register-${STAMP}@test.local`;
    const gatedPassword = "SenhaRegisterRevogado123";
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
      if (value === gatedPassword) {
        signalHashStarted();
        await hashGate;
      }
      return originalHash(value, rounds);
    }) as typeof bcrypt.hash);
    const beforeAudits = await db
      .select({ id: auditTrail.id })
      .from(auditTrail)
      .where(eq(auditTrail.actorUserId, adminId));

    try {
      const registration = request(app)
        .post("/api/auth/register")
        .set("Cookie", cookie)
        .set("x-tenant-id", String(instA))
        .send({
          name: "AAC Session Revoked Register",
          email: targetEmail,
          password: gatedPassword,
          ...generalistRegistration(contextA),
        })
        .then((response) => response);
      await hashStarted;

      const reset = await request(app)
        .post(`/api/admin/users/${adminId}/reset-password`)
        .set("Cookie", cookie)
        .set("x-tenant-id", String(instA));
      expect(reset.status).toBe(200);
      releaseHash();

      const response = await registration;
      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/sessão.*revogada/i);
      expect(
        await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, targetEmail)),
      ).toHaveLength(0);
      const afterAudits = await db
        .select({
          id: auditTrail.id,
          description: auditTrail.description,
          metadata: auditTrail.metadata,
        })
        .from(auditTrail)
        .where(eq(auditTrail.actorUserId, adminId));
      expect(afterAudits).toHaveLength(beforeAudits.length + 1);
      expect(JSON.stringify(afterAudits)).not.toContain(targetEmail);
    } finally {
      releaseHash();
      hashSpy.mockRestore();
    }
  });
});
