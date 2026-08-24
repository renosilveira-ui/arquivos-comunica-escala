// tests/admin-role-sync.test.ts — papel administrativo contextual por tenant.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import request from "supertest";
import express, { type Express } from "express";
import { authRouter } from "../server/routes/auth";
import { adminRouter } from "../server/routes/admin";
import { actorCapabilities, resolveTenantActor } from "../server/_core/policy";
import { getDb } from "../server/db";
import {
  auditTrail,
  dutyConfirmations,
  hospitals,
  institutions,
  monthlyRosters,
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
import { yearMonthBrt } from "../server/local-time";
import { sdk } from "../server/_core/sdk";

const STAMP = Date.now();
const PASSWORD = "SenhaAdmin123";

type InstitutionRole = "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";

describe("admin: papel institucional isolado por tenant", () => {
  let app: Express;
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionAId: number;
  let institutionBId: number;
  let institutionCId: number;
  let hospitalAId: number;
  let sectorAId: number;
  let adminId: number;
  let adminProfessionalId: number;
  let secondAdminId: number;
  let secondAdminProfessionalId: number;
  let targetId: number;
  let targetProfessionalId: number;
  let onlyBUserId: number;
  let inactiveUserId: number;
  let poisonedUserId: number;
  let cookie: string;
  let secondAdminCookie: string;
  const userIds: number[] = [];
  const professionalIds: number[] = [];
  const transientConfirmationIds: number[] = [];
  const transientAssignmentIds: number[] = [];
  const transientShiftIds: number[] = [];
  const targetEmail = `rolesync-target-${STAMP}@test.local`;

  async function createPerson(
    tag: string,
    globalRole: "admin" | "manager" | "doctor" = "doctor",
  ): Promise<{ userId: number; professionalId: number }> {
    const [user] = await db
      .insert(users)
      .values({
        name: `RoleSync ${tag}`,
        email: `rolesync-${tag}-${STAMP}@test.local`,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        loginMethod: "email",
        role: globalRole,
      })
      .$returningId();
    const [professional] = await db
      .insert(professionals)
      .values({
        userId: user.id,
        name: `RoleSync ${tag}`,
        role: "Médico",
        // Projeção legada deliberadamente USER: o teste prova que o PUT
        // contextual não a usa nem a sobrescreve.
        userRole: "USER",
      })
      .$returningId();
    userIds.push(user.id);
    professionalIds.push(professional.id);
    return { userId: user.id, professionalId: professional.id };
  }

  async function link(
    person: { userId: number; professionalId: number },
    institutionId: number,
    roleInInstitution: InstitutionRole,
    active = true,
  ) {
    await db.insert(professionalInstitutions).values({
      userId: person.userId,
      professionalId: person.professionalId,
      institutionId,
      roleInInstitution,
      isPrimary: institutionId === institutionAId,
      active,
    });
  }

  async function createPendingPerson(tag: string): Promise<{
    userId: number;
    professionalId: number;
    email: string;
  }> {
    const person = await createPerson(tag);
    await link(person, institutionAId, "USER", false);
    await db
      .update(users)
      .set({ approvalStatus: "PENDING" })
      .where(eq(users.id, person.userId));
    return {
      ...person,
      email: `rolesync-${tag}-${STAMP}@test.local`,
    };
  }

  async function rolesForTarget() {
    const rows = await db
      .select({
        institutionId: professionalInstitutions.institutionId,
        roleInInstitution: professionalInstitutions.roleInInstitution,
      })
      .from(professionalInstitutions)
      .where(eq(professionalInstitutions.userId, targetId));
    return new Map(rows.map((row) => [row.institutionId, row.roleInInstitution]));
  }

  async function globalProjections() {
    const [user] = await db
      .select({ role: users.role, name: users.name })
      .from(users)
      .where(eq(users.id, targetId));
    const [professional] = await db
      .select({ userRole: professionals.userRole, specialty: professionals.specialty })
      .from(professionals)
      .where(eq(professionals.id, targetProfessionalId));
    return { user, professional };
  }

  async function createDutyFixture(input: {
    original: { userId: number; professionalId: number };
    replacement?: { userId: number; professionalId: number };
    endAt: Date;
    status?: typeof dutyConfirmations.$inferInsert.status;
  }): Promise<number> {
    const { original, replacement, endAt } = input;
    const startAt = new Date(endAt.getTime() - 6 * 60 * 60 * 1000);
    await db
      .insert(monthlyRosters)
      .values({
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        yearMonth: yearMonthBrt(startAt),
        status: "PUBLISHED",
      })
      .onDuplicateKeyUpdate({ set: { status: "PUBLISHED" } });
    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        label: `RoleSync duty ${transientShiftIds.length}`,
        startAt,
        endAt,
        status: "OCUPADO",
        createdBy: adminId,
      })
      .$returningId();
    transientShiftIds.push(shift.id);
    const [assignment] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId: shift.id,
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        professionalId: original.professionalId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
        createdBy: adminId,
      })
      .$returningId();
    transientAssignmentIds.push(assignment.id);
    const [confirmation] = await db
      .insert(dutyConfirmations)
      .values({
        institutionId: institutionAId,
        shiftInstanceId: shift.id,
        assignmentId: assignment.id,
        professionalId: original.professionalId,
        userId: original.userId,
        status: input.status ?? (replacement ? "REPLACEMENT_CONFIRMED" : "CONFIRMED"),
        replacementProfessionalId: replacement?.professionalId ?? null,
        replacementUserId: replacement?.userId ?? null,
        confirmationToken: `rolesync-duty-${STAMP}-${shift.id}`,
      })
      .$returningId();
    transientConfirmationIds.push(confirmation.id);
    return confirmation.id;
  }

  async function createDutyLinkedToTarget(
    relation: "original" | "replacement",
    endAt: Date,
    status?: typeof dutyConfirmations.$inferInsert.status,
  ): Promise<number> {
    return createDutyFixture({
      original:
        relation === "original"
          ? { userId: targetId, professionalId: targetProfessionalId }
          : { userId: adminId, professionalId: adminProfessionalId },
      replacement:
        relation === "replacement"
          ? { userId: targetId, professionalId: targetProfessionalId }
          : undefined,
      endAt,
      status,
    });
  }

  async function raceHttpAfterUserLockGate(
    userId: number,
    start: () => [Promise<request.Response>, Promise<request.Response>],
  ): Promise<[request.Response, request.Response]> {
    let reportLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      reportLocked = resolve;
    });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = db.transaction(async (tx) => {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
        .for("update");
      reportLocked();
      await hold;
    });
    await locked;
    const operations = start();
    // Dá tempo para ambos concluírem autenticação/pré-leitura e alcançarem
    // o mesmo mutex de usuário; o gate não participa de nenhuma outra ordem.
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    release();
    await gate;
    return Promise.all(operations);
  }

  async function runWithCallerRevokedAfterMiddleware(
    invoke: (staleCookie: string) => Promise<request.Response>,
  ): Promise<request.Response> {
    const originalAuthenticate = sdk.authenticateRequest.bind(sdk);
    const authenticateSpy = vi
      .spyOn(sdk, "authenticateRequest")
      .mockImplementationOnce(async (...args: Parameters<typeof sdk.authenticateRequest>) => {
        const staleUser = await originalAuthenticate(...args);
        expect(staleUser.id).toBe(adminId);
        await db
          .update(users)
          .set({ sessionVersion: staleUser.sessionVersion + 1 })
          .where(
            and(
              eq(users.id, staleUser.id),
              eq(users.sessionVersion, staleUser.sessionVersion),
            ),
          );
        return staleUser;
      });

    let response: request.Response;
    try {
      response = await invoke(cookie);
    } finally {
      authenticateSpy.mockRestore();
    }

    const refreshed = await request(app)
      .post("/api/auth/login")
      .send({ email: `rolesync-admin-${STAMP}@test.local`, password: PASSWORD });
    expect(refreshed.status).toBe(200);
    const setCookie = refreshed.headers["set-cookie"];
    cookie = (Array.isArray(setCookie) ? setCookie : [setCookie]).find(
      (entry: string) => entry?.startsWith("session="),
    ) ?? "";
    expect(cookie).not.toBe("");
    return response!;
  }

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;

    app = express();
    app.use(express.json());
    app.use("/api/auth", authRouter);
    app.use("/api/admin", adminRouter);

    const createInstitution = async (tag: string, suffix: string) => {
      const [institution] = await db
        .insert(institutions)
        .values({
          name: `RoleSync ${tag} ${STAMP}`,
          cnpj: `${STAMP}${suffix}`.slice(-14).padStart(14, "0"),
          legalName: `RoleSync ${tag} ${STAMP}`,
          tradeName: `RS${tag}${STAMP}`.slice(0, 20),
          isActive: true,
        })
        .$returningId();
      return institution.id;
    };
    institutionAId = await createInstitution("A", "11");
    institutionBId = await createInstitution("B", "12");
    institutionCId = await createInstitution("C", "13");

    const [hospitalA] = await db
      .insert(hospitals)
      .values({ institutionId: institutionAId, name: `RoleSync Hospital A ${STAMP}` })
      .$returningId();
    hospitalAId = hospitalA.id;
    const [sectorA] = await db
      .insert(sectors)
      .values({
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        name: `RoleSync Setor A ${STAMP}`,
        category: "cirurgico",
        color: "#2563EB",
      })
      .$returningId();
    sectorAId = sectorA.id;

    const admin = await createPerson("admin", "admin");
    adminId = admin.userId;
    adminProfessionalId = admin.professionalId;
    await link(admin, institutionAId, "USER");
    await link(admin, institutionBId, "USER");
    const secondAdmin = await createPerson("admin-2", "admin");
    secondAdminId = secondAdmin.userId;
    secondAdminProfessionalId = secondAdmin.professionalId;
    await link(secondAdmin, institutionAId, "GESTOR_PLUS");

    const target = await createPerson("target");
    targetId = target.userId;
    targetProfessionalId = target.professionalId;
    await link(target, institutionAId, "USER");
    await link(target, institutionBId, "GESTOR_PLUS");
    // O alvo pertence a C, mas o admin não: o vínculo do alvo não pode
    // substituir a prova de tenant do ator.
    await link(target, institutionCId, "GESTOR_MEDICO");

    await db.insert(professionalAccess).values([
      {
        institutionId: institutionAId,
        professionalId: adminProfessionalId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        canAccess: true,
      },
      {
        institutionId: institutionAId,
        professionalId: secondAdminProfessionalId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        canAccess: true,
      },
      {
        institutionId: institutionAId,
        professionalId: targetProfessionalId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        canAccess: true,
      },
    ]);

    const onlyB = await createPerson("only-b");
    onlyBUserId = onlyB.userId;
    await link(onlyB, institutionBId, "USER");

    const inactive = await createPerson("inactive-a");
    inactiveUserId = inactive.userId;
    await link(inactive, institutionAId, "GESTOR_MEDICO", false);

    // PI com FKs individualmente válidas, mas professional.user_id != pi.user_id.
    const decoy = await createPerson("decoy");
    const [poisonedUser] = await db
      .insert(users)
      .values({
        name: "RoleSync Poisoned",
        email: `rolesync-poisoned-${STAMP}@test.local`,
        passwordHash: "test",
        loginMethod: "email",
        role: "doctor",
      })
      .$returningId();
    poisonedUserId = poisonedUser.id;
    userIds.push(poisonedUser.id);
    await db.insert(professionalInstitutions).values({
      userId: poisonedUser.id,
      professionalId: decoy.professionalId,
      institutionId: institutionAId,
      roleInInstitution: "GESTOR_PLUS",
      isPrimary: true,
      active: true,
    });

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: `rolesync-admin-${STAMP}@test.local`, password: PASSWORD });
    expect(login.status).toBe(200);
    const setCookie = login.headers["set-cookie"];
    const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
    cookie = arr.find((entry: string) => entry.startsWith("session=")) ?? "";
    expect(cookie).not.toBe("");

    const secondLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: `rolesync-admin-2-${STAMP}@test.local`, password: PASSWORD });
    expect(secondLogin.status).toBe(200);
    const secondSetCookie = secondLogin.headers["set-cookie"];
    const secondCookies = Array.isArray(secondSetCookie) ? secondSetCookie : [secondSetCookie];
    secondAdminCookie =
      secondCookies.find((entry: string) => entry.startsWith("session=")) ?? "";
    expect(secondAdminCookie).not.toBe("");
  });

  beforeEach(async () => {
    await db.delete(auditTrail).where(eq(auditTrail.entityId, targetId));
    await db.delete(pushTokens).where(eq(pushTokens.userId, targetId));
    await db
      .delete(passwordResets)
      .where(inArray(passwordResets.userId, [adminId, secondAdminId, targetId]));
    await db
      .update(users)
      .set({ approvalStatus: "APPROVED", deletedAt: null })
      .where(eq(users.id, adminId));
    await db
      .update(professionalInstitutions)
      .set({ active: true })
      .where(
        and(
          eq(professionalInstitutions.userId, adminId),
          eq(professionalInstitutions.institutionId, institutionAId),
        ),
      );
    await db
      .update(users)
      .set({ name: "RoleSync target", email: targetEmail, role: "doctor" })
      .where(eq(users.id, targetId));
    await db
      .update(professionals)
      .set({ userRole: "USER", specialty: null })
      .where(eq(professionals.id, targetProfessionalId));
    await db
      .update(professionalInstitutions)
      .set({ roleInInstitution: "USER", active: true })
      .where(
        and(
          eq(professionalInstitutions.userId, targetId),
          eq(professionalInstitutions.institutionId, institutionAId),
        ),
      );
    await db
      .update(professionalInstitutions)
      .set({ roleInInstitution: "GESTOR_PLUS", active: true })
      .where(
        and(
          eq(professionalInstitutions.userId, targetId),
          eq(professionalInstitutions.institutionId, institutionBId),
        ),
      );
  });

  afterEach(async () => {
    if (transientConfirmationIds.length > 0) {
      await db
        .delete(dutyConfirmations)
        .where(inArray(dutyConfirmations.id, transientConfirmationIds));
    }
    if (transientAssignmentIds.length > 0) {
      await db
        .delete(shiftAssignmentsV2)
        .where(inArray(shiftAssignmentsV2.id, transientAssignmentIds));
    }
    if (transientShiftIds.length > 0) {
      await db.delete(shiftInstances).where(inArray(shiftInstances.id, transientShiftIds));
    }
    transientConfirmationIds.length = 0;
    transientAssignmentIds.length = 0;
    transientShiftIds.length = 0;
  });

  afterAll(async () => {
    await db.delete(pushTokens).where(inArray(pushTokens.userId, userIds));
    await db.delete(passwordResets).where(inArray(passwordResets.userId, userIds));
    await db.delete(auditTrail).where(inArray(auditTrail.entityId, userIds));
    await db.delete(professionalAccess).where(inArray(professionalAccess.professionalId, professionalIds));
    await db.delete(professionalInstitutions).where(inArray(professionalInstitutions.userId, userIds));
    await db.delete(professionals).where(inArray(professionals.id, professionalIds));
    await db.delete(monthlyRosters).where(eq(monthlyRosters.institutionId, institutionAId));
    await db.delete(sectors).where(eq(sectors.id, sectorAId));
    await db.delete(hospitals).where(eq(hospitals.id, hospitalAId));
    await db
      .delete(institutions)
      .where(inArray(institutions.id, [institutionAId, institutionBId, institutionCId]));
    await db.delete(users).where(inArray(users.id, userIds));
  });

  it("GET lista somente vínculos canônicos ativos do tenant e projeta role para a build antiga", async () => {
    const responseA = await request(app)
      .get("/api/admin/users")
      .set("Cookie", cookie)
      .set("x-tenant-id", String(institutionAId));
    expect(responseA.status).toBe(200);
    const targetA = responseA.body.users.find((user: { id: number }) => user.id === targetId);
    expect(targetA).toMatchObject({
      role: "doctor",
      globalRole: "doctor",
      roleInInstitution: "USER",
    });
    expect(responseA.body.users.some((user: { id: number }) => user.id === onlyBUserId)).toBe(false);
    expect(responseA.body.users.some((user: { id: number }) => user.id === inactiveUserId)).toBe(false);
    expect(responseA.body.users.some((user: { id: number }) => user.id === poisonedUserId)).toBe(false);

    const responseB = await request(app)
      .get("/api/admin/users")
      .set("Cookie", cookie)
      .set("x-tenant-id", String(institutionBId));
    expect(responseB.status).toBe(200);
    expect(responseB.body.users.find((user: { id: number }) => user.id === targetId)).toMatchObject({
      role: "admin",
      globalRole: "doctor",
      roleInInstitution: "GESTOR_PLUS",
    });
    expect(responseB.body.users.some((user: { id: number }) => user.id === onlyBUserId)).toBe(true);
  });

  it("exige tenant explícito e vínculo canônico ativo do próprio admin", async () => {
    expect((await request(app).get("/api/admin/users").set("Cookie", cookie)).status).toBe(400);
    expect(
      (await request(app).get("/api/admin/users").set("Cookie", cookie).set("x-tenant-id", "abc"))
        .status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .put(`/api/admin/users/${targetId}`)
          .set("Cookie", cookie)
          .set("x-tenant-id", String(institutionCId))
          .send({ roleInInstitution: "USER" })
      ).status,
    ).toBe(403);
    expect(await rolesForTarget()).toEqual(
      new Map([
        [institutionAId, "USER"],
        [institutionBId, "GESTOR_PLUS"],
        [institutionCId, "GESTOR_MEDICO"],
      ]),
    );
  });

  it("sessão admin suspensa ou com PI inativa perde GET e mutation sem qualquer write", async () => {
    const [before] = await db
      .select({
        passwordHash: users.passwordHash,
        sessionVersion: users.sessionVersion,
        mustChangePassword: users.mustChangePassword,
      })
      .from(users)
      .where(eq(users.id, targetId));

    for (const state of ["PENDING", "INACTIVE_PI"] as const) {
      try {
        if (state === "PENDING") {
          await db
            .update(users)
            .set({ approvalStatus: "PENDING" })
            .where(eq(users.id, adminId));
        } else {
          await db
            .update(professionalInstitutions)
            .set({ active: false })
            .where(
              and(
                eq(professionalInstitutions.userId, adminId),
                eq(professionalInstitutions.institutionId, institutionAId),
              ),
            );
        }

        const list = await request(app)
          .get("/api/admin/users")
          .set("Cookie", cookie)
          .set("x-tenant-id", String(institutionAId));
        expect(list.status).toBe(403);
        const mutation = await request(app)
          .post(`/api/admin/users/${targetId}/reset-password`)
          .set("Cookie", cookie)
          .set("x-tenant-id", String(institutionAId));
        expect(mutation.status).toBe(403);

        const [after] = await db
          .select({
            passwordHash: users.passwordHash,
            sessionVersion: users.sessionVersion,
            mustChangePassword: users.mustChangePassword,
          })
          .from(users)
          .where(eq(users.id, targetId));
        expect(after).toEqual(before);
        expect(
          await db
            .select({ id: auditTrail.id })
            .from(auditTrail)
            .where(eq(auditTrail.entityId, targetId)),
        ).toHaveLength(0);
      } finally {
        await db
          .update(users)
          .set({ approvalStatus: "APPROVED" })
          .where(eq(users.id, adminId));
        await db
          .update(professionalInstitutions)
          .set({ active: true })
          .where(
            and(
              eq(professionalInstitutions.userId, adminId),
              eq(professionalInstitutions.institutionId, institutionAId),
            ),
          );
      }
    }
  });

  it("payload legado promove somente o vínculo do tenant e preserva projeções globais", async () => {
    const response = await request(app)
      .put(`/api/admin/users/${targetId}`)
      .set("Cookie", cookie)
      .set("x-tenant-id", String(institutionAId))
      .send({ role: "manager" });
    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({
      role: "manager",
      globalRole: "doctor",
      roleInInstitution: "GESTOR_MEDICO",
    });

    const roles = await rolesForTarget();
    expect(roles.get(institutionAId)).toBe("GESTOR_MEDICO");
    expect(roles.get(institutionBId)).toBe("GESTOR_PLUS");
    expect(await globalProjections()).toMatchObject({
      user: { role: "doctor" },
      professional: { userRole: "USER" },
    });
    expect(actorCapabilities(await resolveTenantActor(targetId, institutionAId, false)).canCreateShift).toBe(true);
    expect((await resolveTenantActor(targetId, institutionBId, false)).roleInInstitution).toBe("GESTOR_PLUS");

    const [audit] = await db
      .select({
        institutionId: auditTrail.institutionId,
        action: auditTrail.action,
        metadata: auditTrail.metadata,
      })
      .from(auditTrail)
      .where(and(eq(auditTrail.entityId, targetId), eq(auditTrail.action, "USER_ROLE_CHANGED")));
    expect(audit).toMatchObject({ institutionId: institutionAId, action: "USER_ROLE_CHANGED" });
    expect(audit.metadata).toMatchObject({
      previousRoleInInstitution: "USER",
      newRoleInInstitution: "GESTOR_MEDICO",
    });
  });

  it("roleInInstitution novo rebaixa somente o tenant selecionado", async () => {
    const response = await request(app)
      .put(`/api/admin/users/${targetId}`)
      .set("Cookie", cookie)
      .set("x-tenant-id", String(institutionBId))
      .send({ roleInInstitution: "USER" });
    expect(response.status).toBe(200);
    const roles = await rolesForTarget();
    expect(roles.get(institutionAId)).toBe("USER");
    expect(roles.get(institutionBId)).toBe("USER");
    expect(roles.get(institutionCId)).toBe("GESTOR_MEDICO");
    expect(await globalProjections()).toMatchObject({
      user: { role: "doctor" },
      professional: { userRole: "USER" },
    });
  });

  it("build antiga pode salvar um Gestor+ sem promover a conta a admin global", async () => {
    const response = await request(app)
      .put(`/api/admin/users/${targetId}`)
      .set("Cookie", cookie)
      .set("x-tenant-id", String(institutionBId))
      .send({
        name: "RoleSync target",
        email: `rolesync-target-${STAMP}@test.local`,
        role: "admin",
        specialty: null,
      });
    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({
      role: "admin",
      globalRole: "doctor",
      roleInInstitution: "GESTOR_PLUS",
    });
    const roles = await rolesForTarget();
    expect(roles.get(institutionAId)).toBe("USER");
    expect(roles.get(institutionBId)).toBe("GESTOR_PLUS");
    expect(await globalProjections()).toMatchObject({
      user: { role: "doctor" },
      professional: { userRole: "USER" },
    });
  });

  it("nega papéis inválidos ou representações conflitantes sem alterar estado", async () => {
    const before = await rolesForTarget();
    const conflict = await request(app)
      .put(`/api/admin/users/${targetId}`)
      .set("Cookie", cookie)
      .set("x-tenant-id", String(institutionAId))
      .send({ role: "manager", roleInInstitution: "USER" });
    expect(conflict.status).toBe(400);
    const invalidInstitutionRole = await request(app)
      .put(`/api/admin/users/${targetId}`)
      .set("Cookie", cookie)
      .set("x-tenant-id", String(institutionAId))
      .send({ roleInInstitution: "SUPER_ADMIN" });
    expect(invalidInstitutionRole.status).toBe(400);
    const invalidLegacyRole = await request(app)
      .put(`/api/admin/users/${targetId}`)
      .set("Cookie", cookie)
      .set("x-tenant-id", String(institutionAId))
      .send({ role: "owner" });
    expect(invalidLegacyRole.status).toBe(400);
    expect(await rolesForTarget()).toEqual(before);
    expect(
      await db.select({ id: auditTrail.id }).from(auditTrail).where(eq(auditTrail.entityId, targetId)),
    ).toHaveLength(0);
  });

  it("rejeita strings acima do schema antes de qualquer escrita ou auditoria", async () => {
    const [beforeUser] = await db
      .select({ name: users.name, email: users.email, sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, targetId));
    const [beforeProfessional] = await db
      .select({ specialty: professionals.specialty })
      .from(professionals)
      .where(eq(professionals.id, targetProfessionalId));
    const beforeRoles = await rolesForTarget();

    for (const payload of [
      { name: "N".repeat(256) },
      { email: `${"e".repeat(310)}@example.test` },
      { specialty: "S".repeat(101) },
    ]) {
      const response = await request(app)
        .put(`/api/admin/users/${targetId}`)
        .set("Cookie", cookie)
        .set("x-tenant-id", String(institutionAId))
        .send(payload);
      expect(response.status).toBe(400);
    }

    const [afterUser] = await db
      .select({ name: users.name, email: users.email, sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, targetId));
    const [afterProfessional] = await db
      .select({ specialty: professionals.specialty })
      .from(professionals)
      .where(eq(professionals.id, targetProfessionalId));
    expect(afterUser).toEqual(beforeUser);
    expect(afterProfessional).toEqual(beforeProfessional);
    expect(await rolesForTarget()).toEqual(beforeRoles);
    expect(
      await db.select({ id: auditTrail.id }).from(auditTrail).where(eq(auditTrail.entityId, targetId)),
    ).toHaveLength(0);
  });

  it("nega alvo de outro tenant, vínculo inativo e identidade PI adulterada", async () => {
    for (const userId of [onlyBUserId, inactiveUserId, poisonedUserId]) {
      const response = await request(app)
        .put(`/api/admin/users/${userId}`)
        .set("Cookie", cookie)
        .set("x-tenant-id", String(institutionAId))
        .send({ roleInInstitution: "GESTOR_PLUS" });
      expect(response.status).toBe(404);
    }

    const [inactive] = await db
      .select({ active: professionalInstitutions.active, role: professionalInstitutions.roleInInstitution })
      .from(professionalInstitutions)
      .where(
        and(
          eq(professionalInstitutions.userId, inactiveUserId),
          eq(professionalInstitutions.institutionId, institutionAId),
        ),
      );
    expect(inactive).toEqual({ active: false, role: "GESTOR_MEDICO" });
    const [poisoned] = await db
      .select({ role: professionalInstitutions.roleInInstitution })
      .from(professionalInstitutions)
      .where(eq(professionalInstitutions.userId, poisonedUserId));
    expect(poisoned.role).toBe("GESTOR_PLUS");
  });

  it("alteração cadastral não toca em nenhum papel e é auditada no tenant explícito", async () => {
    const beforeRoles = await rolesForTarget();
    const response = await request(app)
      .put(`/api/admin/users/${targetId}`)
      .set("Cookie", cookie)
      .set("x-tenant-id", String(institutionAId))
      .send({ name: "RoleSync Alvo Atualizado", specialty: "Anestesiologia" });
    expect(response.status).toBe(200);
    expect(await rolesForTarget()).toEqual(beforeRoles);
    expect(await globalProjections()).toMatchObject({
      user: { name: "RoleSync Alvo Atualizado", role: "doctor" },
      professional: { userRole: "USER", specialty: "Anestesiologia" },
    });
    const [audit] = await db
      .select({ institutionId: auditTrail.institutionId, action: auditTrail.action })
      .from(auditTrail)
      .where(and(eq(auditTrail.entityId, targetId), eq(auditTrail.action, "USER_UPDATED")));
    expect(audit).toEqual({ institutionId: institutionAId, action: "USER_UPDATED" });
  });

  it("nega mudança de e-mail do titular original enquanto o plantão não terminou", async () => {
    await createDutyLinkedToTarget("original", new Date(Date.now() + 60 * 60 * 1000));

    const response = await request(app)
      .put(`/api/admin/users/${targetId}`)
      .set("Cookie", cookie)
      .set("x-tenant-id", String(institutionAId))
      .send({ email: `rolesync-original-blocked-${STAMP}@test.local` });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/plantão vinculado ainda não encerrado/i);
    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, targetId));
    expect(user.email).toBe(targetEmail);
    expect(
      await db.select({ id: auditTrail.id }).from(auditTrail).where(eq(auditTrail.entityId, targetId)),
    ).toHaveLength(0);
  });

  it("nega mudança de e-mail do substituto enquanto o plantão não terminou", async () => {
    await createDutyLinkedToTarget("replacement", new Date(Date.now() + 60 * 60 * 1000));

    const response = await request(app)
      .put(`/api/admin/users/${targetId}`)
      .set("Cookie", cookie)
      .set("x-tenant-id", String(institutionAId))
      .send({ email: `rolesync-replacement-blocked-${STAMP}@test.local` });

    expect(response.status).toBe(409);
    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, targetId));
    expect(user.email).toBe(targetEmail);
    expect(
      await db.select({ id: auditTrail.id }).from(auditTrail).where(eq(auditTrail.entityId, targetId)),
    ).toHaveLength(0);
  });

  it("permite mudança de e-mail quando todos os plantões ligados já terminaram", async () => {
    await createDutyLinkedToTarget("original", new Date(Date.now() - 60 * 1000));
    const nextEmail = `rolesync-ended-duty-${STAMP}@test.local`;

    const response = await request(app)
      .put(`/api/admin/users/${targetId}`)
      .set("Cookie", cookie)
      .set("x-tenant-id", String(institutionAId))
      .send({ email: nextEmail });

    expect(response.status).toBe(200);
    expect(response.body.user.email).toBe(nextEmail);
    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, targetId));
    expect(user.email).toBe(nextEmail);
    const audits = await db
      .select({ action: auditTrail.action })
      .from(auditTrail)
      .where(eq(auditTrail.entityId, targetId));
    expect(audits).toEqual([{ action: "USER_UPDATED" }]);
  });

  it("mudança real de e-mail revoga sessão e invalida todos os resets na mesma auditoria", async () => {
    const targetLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: targetEmail, password: PASSWORD });
    expect(targetLogin.status).toBe(200);
    const targetSetCookie = targetLogin.headers["set-cookie"];
    const targetCookies = Array.isArray(targetSetCookie) ? targetSetCookie : [targetSetCookie];
    const targetCookie =
      targetCookies.find((entry: string) => entry.startsWith("session=")) ?? "";
    expect(targetCookie).not.toBe("");
    await db.insert(pushTokens).values([
      {
        institutionId: institutionAId,
        userId: targetId,
        token: `ExponentPushToken[email-change-a-${STAMP}]`,
        platform: "ios",
      },
      {
        institutionId: institutionBId,
        userId: targetId,
        token: `ExponentPushToken[email-change-b-${STAMP}]`,
        platform: "android",
      },
    ]);

    const [before] = await db
      .select({ email: users.email, sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, targetId));
    await db.insert(passwordResets).values([
      {
        userId: targetId,
        tokenHash: "a".repeat(64),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      },
      {
        userId: targetId,
        tokenHash: "b".repeat(64),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        usedAt: new Date(),
      },
    ]);
    const nextEmail = `rolesync-revoked-${STAMP}@test.local`;

    const response = await request(app)
      .put(`/api/admin/users/${targetId}`)
      .set("Cookie", cookie)
      .set("x-tenant-id", String(institutionAId))
      .send({ email: nextEmail });

    expect(response.status).toBe(200);
    const [after] = await db
      .select({ email: users.email, sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, targetId));
    expect(after).toEqual({ email: nextEmail, sessionVersion: before.sessionVersion + 1 });
    expect(
      await db
        .select({ id: passwordResets.id })
        .from(passwordResets)
        .where(eq(passwordResets.userId, targetId)),
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: pushTokens.id })
        .from(pushTokens)
        .where(eq(pushTokens.userId, targetId)),
    ).toHaveLength(0);
    expect(
      (await request(app).get("/api/auth/me").set("Cookie", targetCookie)).status,
    ).toBe(401);
    const [audit] = await db
      .select({ description: auditTrail.description, metadata: auditTrail.metadata })
      .from(auditTrail)
      .where(eq(auditTrail.entityId, targetId));
    expect(audit.metadata).toMatchObject({
      changedFields: expect.arrayContaining(["email"]),
      emailChanged: true,
      sessionVersionBefore: before.sessionVersion,
      sessionVersionAfter: before.sessionVersion + 1,
      revokedPushTokenCount: 2,
      invalidatedPasswordResetCount: 2,
    });
    expect((audit.metadata as Record<string, unknown>).changes).toBeUndefined();
    expect(JSON.stringify(audit)).not.toContain(before.email);
    expect(JSON.stringify(audit)).not.toContain(nextEmail);
  });

  it("producer que materializa confirmação antes do mutex do usuário faz PUT e-mail abortar", async () => {
    const startAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const endAt = new Date(startAt.getTime() + 6 * 60 * 60 * 1000);
    const [shift] = await db
      .insert(shiftInstances)
      .values({
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        label: `RoleSync producer race ${STAMP}`,
        startAt,
        endAt,
        status: "OCUPADO",
        createdBy: adminId,
      })
      .$returningId();
    transientShiftIds.push(shift.id);
    const [assignment] = await db
      .insert(shiftAssignmentsV2)
      .values({
        shiftInstanceId: shift.id,
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        professionalId: targetProfessionalId,
        assignmentType: "ON_DUTY",
        status: "OCUPADO",
        isActive: true,
        createdBy: adminId,
      })
      .$returningId();
    transientAssignmentIds.push(assignment.id);

    let signalProducerHasUser!: () => void;
    let releaseProducer!: () => void;
    const producerHasUser = new Promise<void>((resolve) => {
      signalProducerHasUser = resolve;
    });
    const producerGate = new Promise<void>((resolve) => {
      releaseProducer = resolve;
    });
    const producer = db.transaction(async (tx) => {
      await tx
        .select({ id: shiftInstances.id })
        .from(shiftInstances)
        .where(eq(shiftInstances.id, shift.id))
        .limit(1)
        .for("update");
      await tx
        .select({ id: shiftAssignmentsV2.id })
        .from(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.id, assignment.id))
        .limit(1)
        .for("update");
      const [confirmation] = await tx
        .insert(dutyConfirmations)
        .values({
          institutionId: institutionAId,
          shiftInstanceId: shift.id,
          assignmentId: assignment.id,
          professionalId: targetProfessionalId,
          userId: targetId,
          status: "PENDING",
          confirmationToken: `rolesync-producer-race-${STAMP}`,
        })
        .$returningId();
      transientConfirmationIds.push(confirmation.id);
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, targetId))
        .limit(1)
        .for("update");
      signalProducerHasUser();
      await producerGate;
    });
    await producerHasUser;

    const [before] = await db
      .select({ email: users.email, sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, targetId));
    const nextEmail = `rolesync-producer-blocked-${STAMP}@test.local`;
    let updateSettled = false;
    const update = request(app)
      .put(`/api/admin/users/${targetId}`)
      .set("Cookie", cookie)
      .set("x-tenant-id", String(institutionAId))
      .send({ email: nextEmail })
      .then((response) => response)
      .finally(() => {
        updateSettled = true;
      });

    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 75));
      expect(updateSettled).toBe(false);
      releaseProducer();
      await producer;
      const response = await update;
      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/vínculos de plantão mudaram/i);
      expect(
        await db
          .select({ email: users.email, sessionVersion: users.sessionVersion })
          .from(users)
          .where(eq(users.id, targetId)),
      ).toEqual([before]);
      expect(
        await db
          .select({ id: auditTrail.id })
          .from(auditTrail)
          .where(eq(auditTrail.entityId, targetId)),
      ).toHaveLength(0);
    } finally {
      releaseProducer();
      await producer;
    }
  }, 30_000);

  it("nega mudança do próprio e-mail do admin sem inverter a ordem de locks", async () => {
    await db.delete(auditTrail).where(eq(auditTrail.entityId, adminId));
    await createDutyFixture({
      original: { userId: adminId, professionalId: adminProfessionalId },
      endAt: new Date(Date.now() + 60 * 60 * 1000),
      status: "CONFIRMED",
    });
    const [before] = await db.select({ email: users.email }).from(users).where(eq(users.id, adminId));

    const response = await request(app)
      .put(`/api/admin/users/${adminId}`)
      .set("Cookie", cookie)
      .set("x-tenant-id", String(institutionAId))
      .send({ email: `rolesync-admin-self-blocked-${STAMP}@test.local` });

    expect(response.status).toBe(409);
    const [after] = await db.select({ email: users.email }).from(users).where(eq(users.id, adminId));
    expect(after.email).toBe(before.email);
    expect(
      await db.select({ id: auditTrail.id }).from(auditTrail).where(eq(auditTrail.entityId, adminId)),
    ).toHaveLength(0);
  });

  it("dois admins editando um ao outro usam ordem total sem deadlock", async () => {
    for (let round = 0; round < 10; round++) {
      const firstName = `RoleSync cross first ${round}`;
      const secondName = `RoleSync cross second ${round}`;
      const first = request(app)
        .put(`/api/admin/users/${secondAdminId}`)
        .set("Cookie", cookie)
        .set("x-tenant-id", String(institutionAId))
        .send({ name: firstName });
      const second = request(app)
        .put(`/api/admin/users/${adminId}`)
        .set("Cookie", secondAdminCookie)
        .set("x-tenant-id", String(institutionAId))
        .send({ name: secondName });
      const responses = await Promise.all(round % 2 === 0 ? [first, second] : [second, first]);
      expect(responses.every((response) => response.status === 200 || response.status === 409)).toBe(true);
      expect(responses.some((response) => response.status === 200)).toBe(true);

      const [firstAdmin, secondAdmin] = await Promise.all([
        db.select({ name: users.name }).from(users).where(eq(users.id, adminId)).then((rows) => rows[0]),
        db.select({ name: users.name }).from(users).where(eq(users.id, secondAdminId)).then((rows) => rows[0]),
      ]);
      const firstResponse = round % 2 === 0 ? responses[0] : responses[1];
      const secondResponse = round % 2 === 0 ? responses[1] : responses[0];
      if (firstResponse.status === 200) expect(secondAdmin.name).toBe(firstName);
      if (secondResponse.status === 200) expect(firstAdmin.name).toBe(secondName);
    }
  }, 30_000);

  it("approve pendente × exclusão da conta serializa sem deadlock nem estado parcial", async () => {
    const pending = await createPendingPerson("pending-approve-delete");
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: pending.email, password: PASSWORD });
    expect(login.status).toBe(200);
    const setCookie = login.headers["set-cookie"];
    const pendingCookie =
      (Array.isArray(setCookie) ? setCookie : [setCookie]).find(
        (entry: string) => entry?.startsWith("session="),
      ) ?? "";

    const [approve, deletion] = await raceHttpAfterUserLockGate(pending.userId, () => [
      request(app)
        .post(`/api/admin/pending-signups/${pending.userId}/approve`)
        .set("Cookie", cookie)
        .set("x-tenant-id", String(institutionAId))
        .then((response) => response),
      request(app)
        .delete("/api/auth/me")
        .set("Cookie", pendingCookie)
        .send({ password: PASSWORD })
        .then((response) => response),
    ]);

    expect([approve.status, deletion.status].filter((status) => status === 200)).toHaveLength(1);
    expect([approve.status, deletion.status].every((status) => [200, 401, 409].includes(status))).toBe(true);
    const [user] = await db
      .select({ approvalStatus: users.approvalStatus, deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, pending.userId));
    const [membership] = await db
      .select({ active: professionalInstitutions.active })
      .from(professionalInstitutions)
      .where(eq(professionalInstitutions.userId, pending.userId));
    if (approve.status === 200) {
      expect(user).toMatchObject({ approvalStatus: "APPROVED", deletedAt: null });
      expect(membership.active).toBe(true);
    } else {
      expect(deletion.status).toBe(200);
      expect(user.deletedAt).not.toBeNull();
      expect(membership.active).toBe(false);
    }
  }, 30_000);

  it("reject pendente × exclusão da conta produz um único desfecho sem deadlock", async () => {
    const pending = await createPendingPerson("pending-reject-delete");
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: pending.email, password: PASSWORD });
    expect(login.status).toBe(200);
    const setCookie = login.headers["set-cookie"];
    const pendingCookie =
      (Array.isArray(setCookie) ? setCookie : [setCookie]).find(
        (entry: string) => entry?.startsWith("session="),
      ) ?? "";

    const [rejection, deletion] = await raceHttpAfterUserLockGate(pending.userId, () => [
      request(app)
        .post(`/api/admin/pending-signups/${pending.userId}/reject`)
        .set("Cookie", cookie)
        .set("x-tenant-id", String(institutionAId))
        .then((response) => response),
      request(app)
        .delete("/api/auth/me")
        .set("Cookie", pendingCookie)
        .send({ password: PASSWORD })
        .then((response) => response),
    ]);

    expect([rejection.status, deletion.status].filter((status) => status === 200)).toHaveLength(1);
    expect([rejection.status, deletion.status].every((status) => [200, 401, 404, 409].includes(status))).toBe(true);
    const remainingUsers = await db
      .select({ deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, pending.userId));
    if (rejection.status === 200) {
      expect(remainingUsers).toHaveLength(0);
    } else {
      expect(deletion.status).toBe(200);
      expect(remainingUsers[0]?.deletedAt).not.toBeNull();
    }
  }, 30_000);

  it("revogação concorrente do papel e PI do admin falha fechado antes de aprovar", async () => {
    const pending = await createPendingPerson("pending-admin-revocation");
    let reportRevocationLocked!: () => void;
    const revocationLocked = new Promise<void>((resolve) => {
      reportRevocationLocked = resolve;
    });
    let releaseRevocation!: () => void;
    const holdRevocation = new Promise<void>((resolve) => {
      releaseRevocation = resolve;
    });
    const revocation = db.transaction(async (tx) => {
      await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, adminId))
        .limit(1)
        .for("update");
      await tx
        .select({ id: professionals.id })
        .from(professionals)
        .where(eq(professionals.id, adminProfessionalId))
        .limit(1)
        .for("update");
      await tx
        .select({ id: professionalInstitutions.id })
        .from(professionalInstitutions)
        .where(
          and(
            eq(professionalInstitutions.userId, adminId),
            eq(professionalInstitutions.institutionId, institutionAId),
          ),
        )
        .limit(1)
        .for("update");
      await tx.update(users).set({ role: "doctor" }).where(eq(users.id, adminId));
      await tx
        .update(professionalInstitutions)
        .set({ active: false })
        .where(
          and(
            eq(professionalInstitutions.userId, adminId),
            eq(professionalInstitutions.institutionId, institutionAId),
          ),
        );
      reportRevocationLocked();
      await holdRevocation;
    });
    await revocationLocked;
    const approval = request(app)
      .post(`/api/admin/pending-signups/${pending.userId}/approve`)
      .set("Cookie", cookie)
      .set("x-tenant-id", String(institutionAId))
      .then((response) => response);
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    releaseRevocation();
    await revocation;

    try {
      const response = await approval;
      expect(response.status).toBe(409);
      const [user] = await db
        .select({ approvalStatus: users.approvalStatus })
        .from(users)
        .where(eq(users.id, pending.userId));
      const [membership] = await db
        .select({ active: professionalInstitutions.active })
        .from(professionalInstitutions)
        .where(eq(professionalInstitutions.userId, pending.userId));
      expect(user.approvalStatus).toBe("PENDING");
      expect(membership.active).toBe(false);
      expect(
        await db
          .select({ id: auditTrail.id })
          .from(auditTrail)
          .where(eq(auditTrail.entityId, pending.userId)),
      ).toHaveLength(0);
    } finally {
      await db.update(users).set({ role: "admin" }).where(eq(users.id, adminId));
      await db
        .update(professionalInstitutions)
        .set({ active: true })
        .where(
          and(
            eq(professionalInstitutions.userId, adminId),
            eq(professionalInstitutions.institutionId, institutionAId),
          ),
        );
    }
  }, 30_000);

  it("sessão revogada após middleware aborta PUT, reset, approve e reject antes do primeiro write", async () => {
    const [targetBeforePut] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, targetId));
    const put = await runWithCallerRevokedAfterMiddleware((staleCookie) =>
      request(app)
        .put(`/api/admin/users/${targetId}`)
        .set("Cookie", staleCookie)
        .set("x-tenant-id", String(institutionAId))
        .send({ name: "NÃO PODE COMMITAR" }),
    );
    expect(put.status).toBe(409);
    expect(put.body.error).toMatch(/sessão.*revogada/i);
    expect(
      await db.select({ name: users.name }).from(users).where(eq(users.id, targetId)),
    ).toEqual([targetBeforePut]);
    expect(
      await db.select({ id: auditTrail.id }).from(auditTrail).where(eq(auditTrail.entityId, targetId)),
    ).toHaveLength(0);

    const [targetBeforeReset] = await db
      .select({
        passwordHash: users.passwordHash,
        mustChangePassword: users.mustChangePassword,
        sessionVersion: users.sessionVersion,
      })
      .from(users)
      .where(eq(users.id, targetId));
    await db.insert(passwordResets).values({
      userId: targetId,
      tokenHash: "e".repeat(64),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
    const reset = await runWithCallerRevokedAfterMiddleware((staleCookie) =>
      request(app)
        .post(`/api/admin/users/${targetId}/reset-password`)
        .set("Cookie", staleCookie)
        .set("x-tenant-id", String(institutionAId)),
    );
    expect(reset.status).toBe(409);
    expect(reset.body.temporaryPassword).toBeUndefined();
    expect(
      await db
        .select({
          passwordHash: users.passwordHash,
          mustChangePassword: users.mustChangePassword,
          sessionVersion: users.sessionVersion,
        })
        .from(users)
        .where(eq(users.id, targetId)),
    ).toEqual([targetBeforeReset]);
    expect(
      await db
        .select({ id: passwordResets.id })
        .from(passwordResets)
        .where(eq(passwordResets.userId, targetId)),
    ).toHaveLength(1);
    expect(
      await db.select({ id: auditTrail.id }).from(auditTrail).where(eq(auditTrail.entityId, targetId)),
    ).toHaveLength(0);

    for (const operation of ["approve", "reject"] as const) {
      const pending = await createPendingPerson(`pending-stale-${operation}`);
      const response = await runWithCallerRevokedAfterMiddleware((staleCookie) =>
        request(app)
          .post(`/api/admin/pending-signups/${pending.userId}/${operation}`)
          .set("Cookie", staleCookie)
          .set("x-tenant-id", String(institutionAId)),
      );
      expect(response.status).toBe(409);
      const [pendingUser] = await db
        .select({ approvalStatus: users.approvalStatus, deletedAt: users.deletedAt })
        .from(users)
        .where(eq(users.id, pending.userId));
      const [pendingMembership] = await db
        .select({ active: professionalInstitutions.active })
        .from(professionalInstitutions)
        .where(eq(professionalInstitutions.userId, pending.userId));
      expect(pendingUser).toEqual({ approvalStatus: "PENDING", deletedAt: null });
      expect(pendingMembership.active).toBe(false);
      expect(
        await db
          .select({ id: auditTrail.id })
          .from(auditTrail)
          .where(eq(auditTrail.entityId, pending.userId)),
      ).toHaveLength(0);
    }
  }, 30_000);

  it("dois admins redefinindo o mesmo alvo geram uma única senha válida", async () => {
    const [before] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, targetId));
    await db.insert(passwordResets).values({
      userId: targetId,
      tokenHash: "c".repeat(64),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });

    const responses = await Promise.all([
      request(app)
        .post(`/api/admin/users/${targetId}/reset-password`)
        .set("Cookie", cookie)
        .set("x-tenant-id", String(institutionAId)),
      request(app)
        .post(`/api/admin/users/${targetId}/reset-password`)
        .set("Cookie", secondAdminCookie)
        .set("x-tenant-id", String(institutionAId)),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const success = responses.find((response) => response.status === 200)!;
    const conflict = responses.find((response) => response.status === 409)!;
    expect(success.body.temporaryPassword).toHaveLength(12);
    expect(conflict.body.temporaryPassword).toBeUndefined();

    const [target] = await db
      .select({
        passwordHash: users.passwordHash,
        mustChangePassword: users.mustChangePassword,
        sessionVersion: users.sessionVersion,
      })
      .from(users)
      .where(eq(users.id, targetId));
    expect(await bcrypt.compare(success.body.temporaryPassword, target.passwordHash!)).toBe(true);
    expect(target.mustChangePassword).toBe(true);
    expect(target.sessionVersion).toBe(before.sessionVersion + 1);
    expect(
      await db
        .select({ id: passwordResets.id })
        .from(passwordResets)
        .where(eq(passwordResets.userId, targetId)),
    ).toHaveLength(0);
    expect(
      await db.select({ id: auditTrail.id }).from(auditTrail).where(eq(auditTrail.entityId, targetId)),
    ).toHaveLength(1);
  }, 30_000);

  it("dois admins redefinindo um ao outro não deadlockam e só um commit vence", async () => {
    await db
      .delete(auditTrail)
      .where(inArray(auditTrail.entityId, [adminId, secondAdminId]));
    const beforeRows = await db
      .select({
        id: users.id,
        passwordHash: users.passwordHash,
        sessionVersion: users.sessionVersion,
      })
      .from(users)
      .where(inArray(users.id, [adminId, secondAdminId]));
    const before = new Map(beforeRows.map((row) => [row.id, row]));

    const [first, second] = await Promise.all([
      request(app)
        .post(`/api/admin/users/${secondAdminId}/reset-password`)
        .set("Cookie", cookie)
        .set("x-tenant-id", String(institutionAId)),
      request(app)
        .post(`/api/admin/users/${adminId}/reset-password`)
        .set("Cookie", secondAdminCookie)
        .set("x-tenant-id", String(institutionAId)),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const winner = first.status === 200
      ? { response: first, targetId: secondAdminId }
      : { response: second, targetId: adminId };
    const loserTargetId = winner.targetId === adminId ? secondAdminId : adminId;
    const afterRows = await db
      .select({
        id: users.id,
        passwordHash: users.passwordHash,
        sessionVersion: users.sessionVersion,
      })
      .from(users)
      .where(inArray(users.id, [adminId, secondAdminId]));
    const after = new Map(afterRows.map((row) => [row.id, row]));

    expect(
      await bcrypt.compare(
        winner.response.body.temporaryPassword,
        after.get(winner.targetId)!.passwordHash!,
      ),
    ).toBe(true);
    expect(after.get(winner.targetId)!.sessionVersion).toBe(
      before.get(winner.targetId)!.sessionVersion + 1,
    );
    expect(after.get(loserTargetId)).toEqual(before.get(loserTargetId));
    expect(
      await db
        .select({ entityId: auditTrail.entityId })
        .from(auditTrail)
        .where(inArray(auditTrail.entityId, [adminId, secondAdminId])),
    ).toHaveLength(1);
  }, 30_000);
});
