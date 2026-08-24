// Rotas REST administrativas: toda autoridade e todo alvo são tenant-scoped.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import express, { type Express } from "express";
import request from "supertest";
import {
  auditTrail,
  hospitals,
  institutions,
  professionalAccess,
  professionalInstitutions,
  professionals,
  users,
} from "../drizzle/schema";
import { adminRouter } from "../server/routes/admin";
import { authRouter } from "../server/routes/auth";
import { getDb } from "../server/db";

const STAMP = Date.now();
const PASSWORD = "SenhaTenant123";

describe("admin REST: fronteiras canônicas de tenant", () => {
  let app: Express;
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionAId: number;
  let institutionBId: number;
  let hospitalAId: number;
  let hospitalBId: number;
  let adminId: number;
  let activeAId: number;
  let activeBId: number;
  let pendingAId: number;
  let pendingBId: number;
  let multiTenantPendingId: number;
  let cookie: string;
  const userIds: number[] = [];
  const professionalIds: number[] = [];

  async function person(input: {
    tag: string;
    institutionId: number;
    globalRole?: "admin" | "doctor";
    active?: boolean;
    approvalStatus?: "PENDING" | "APPROVED";
  }): Promise<{ userId: number; professionalId: number }> {
    const [user] = await db
      .insert(users)
      .values({
        name: `ATB ${input.tag}`,
        email: `atb-${input.tag}-${STAMP}@test.local`,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        loginMethod: "email",
        role: input.globalRole ?? "doctor",
        approvalStatus: input.approvalStatus ?? "APPROVED",
      })
      .$returningId();
    const [professional] = await db
      .insert(professionals)
      .values({
        userId: user.id,
        name: `ATB ${input.tag}`,
        role: "Médico",
        userRole: input.globalRole === "admin" ? "GESTOR_PLUS" : "USER",
      })
      .$returningId();
    await db.insert(professionalInstitutions).values({
      userId: user.id,
      professionalId: professional.id,
      institutionId: input.institutionId,
      roleInInstitution: input.globalRole === "admin" ? "GESTOR_PLUS" : "USER",
      isPrimary: true,
      active: input.active ?? true,
    });
    userIds.push(user.id);
    professionalIds.push(professional.id);
    return { userId: user.id, professionalId: professional.id };
  }

  beforeAll(async () => {
    const connection = await getDb();
    if (!connection) throw new Error("Database not available");
    db = connection;
    app = express();
    app.use(express.json());
    app.use("/api/auth", authRouter);
    app.use("/api/admin", adminRouter);

    const makeInstitution = async (tag: "A" | "B") => {
      const [institution] = await db
        .insert(institutions)
        .values({
          name: `ATB ${tag} ${STAMP}`,
          cnpj: `${STAMP}${tag === "A" ? 31 : 32}`.slice(-14).padStart(14, "0"),
          legalName: `ATB ${tag} ${STAMP}`,
          tradeName: `ATB${tag}${STAMP}`.slice(0, 20),
          isActive: true,
        })
        .$returningId();
      return institution.id;
    };
    institutionAId = await makeInstitution("A");
    institutionBId = await makeInstitution("B");
    const [hospitalA] = await db
      .insert(hospitals)
      .values({ institutionId: institutionAId, name: `ATB Hospital A ${STAMP}` })
      .$returningId();
    const [hospitalB] = await db
      .insert(hospitals)
      .values({ institutionId: institutionBId, name: `ATB Hospital B ${STAMP}` })
      .$returningId();
    hospitalAId = hospitalA.id;
    hospitalBId = hospitalB.id;

    adminId = (await person({ tag: "admin", institutionId: institutionAId, globalRole: "admin" })).userId;
    activeAId = (await person({ tag: "active-a", institutionId: institutionAId })).userId;
    activeBId = (await person({ tag: "active-b", institutionId: institutionBId })).userId;
    pendingAId = (
      await person({
        tag: "pending-a",
        institutionId: institutionAId,
        active: false,
        approvalStatus: "PENDING",
      })
    ).userId;
    pendingBId = (
      await person({
        tag: "pending-b",
        institutionId: institutionBId,
        active: false,
        approvalStatus: "PENDING",
      })
    ).userId;
    const multi = await person({
      tag: "pending-multi",
      institutionId: institutionAId,
      active: false,
      approvalStatus: "PENDING",
    });
    multiTenantPendingId = multi.userId;
    await db.insert(professionalInstitutions).values({
      userId: multi.userId,
      professionalId: multi.professionalId,
      institutionId: institutionBId,
      roleInInstitution: "USER",
      isPrimary: false,
      active: false,
    });

    await db.insert(auditTrail).values([
      {
        institutionId: institutionAId,
        action: "USER_UPDATED",
        entityType: "USER",
        entityId: activeAId,
        actorUserId: adminId,
        actorRole: "admin",
        description: "ATB audit A",
      },
      {
        institutionId: institutionBId,
        action: "USER_UPDATED",
        entityType: "USER",
        entityId: activeBId,
        actorUserId: adminId,
        actorRole: "admin",
        description: "ATB audit B",
      },
    ]);

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: `atb-admin-${STAMP}@test.local`, password: PASSWORD });
    expect(login.status).toBe(200);
    const setCookie = login.headers["set-cookie"];
    cookie = (Array.isArray(setCookie) ? setCookie : [setCookie]).find((item: string) =>
      item?.startsWith("session="),
    ) ?? "";
    expect(cookie).not.toBe("");
  });

  afterAll(async () => {
    await db.delete(auditTrail).where(inArray(auditTrail.entityId, userIds));
    await db.delete(professionalAccess).where(inArray(professionalAccess.institutionId, [institutionAId, institutionBId]));
    await db.delete(professionalInstitutions).where(inArray(professionalInstitutions.userId, userIds));
    await db.delete(professionals).where(inArray(professionals.id, professionalIds));
    await db.delete(hospitals).where(inArray(hospitals.id, [hospitalAId, hospitalBId]));
    await db.delete(institutions).where(inArray(institutions.id, [institutionAId, institutionBId]));
    await db.delete(users).where(inArray(users.id, userIds));
  });

  it("reset de senha exige tenant e não alcança usuário de outro tenant", async () => {
    const [beforeA] = await db.select({ version: users.sessionVersion }).from(users).where(eq(users.id, activeAId));
    const [beforeB] = await db.select({ version: users.sessionVersion }).from(users).where(eq(users.id, activeBId));

    expect(
      (
        await request(app)
          .post(`/api/admin/users/${activeAId}/reset-password`)
          .set("Cookie", cookie)
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(`/api/admin/users/${activeBId}/reset-password`)
          .set("Cookie", cookie)
          .set("x-tenant-id", String(institutionAId))
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post(`/api/admin/users/${activeBId}/reset-password`)
          .set("Cookie", cookie)
          .set("x-tenant-id", String(institutionBId))
      ).status,
    ).toBe(403);

    const allowed = await request(app)
      .post(`/api/admin/users/${activeAId}/reset-password`)
      .set("Cookie", cookie)
      .set("x-tenant-id", String(institutionAId));
    expect(allowed.status).toBe(200);
    const [afterA] = await db.select({ version: users.sessionVersion }).from(users).where(eq(users.id, activeAId));
    const [afterB] = await db.select({ version: users.sessionVersion }).from(users).where(eq(users.id, activeBId));
    expect(afterA.version).toBe(beforeA.version + 1);
    expect(afterB.version).toBe(beforeB.version);
  });

  it("fila pendente e audit trail não vazam o tenant B", async () => {
    expect((await request(app).get("/api/admin/pending-signups").set("Cookie", cookie)).status).toBe(400);
    const pending = await request(app)
      .get("/api/admin/pending-signups")
      .set("Cookie", cookie)
      .set("x-tenant-id", String(institutionAId));
    expect(pending.status).toBe(200);
    expect(pending.body.pending.map((item: { id: number }) => item.id)).toContain(pendingAId);
    expect(pending.body.pending.map((item: { id: number }) => item.id)).not.toContain(pendingBId);

    const audit = await request(app)
      .get("/api/admin/audit")
      .set("Cookie", cookie)
      .set("x-tenant-id", String(institutionAId));
    expect(audit.status).toBe(200);
    expect(audit.body.data.some((item: { institutionId: number }) => item.institutionId !== institutionAId)).toBe(false);
    expect(audit.body.data.some((item: { entityId: number }) => item.entityId === activeAId)).toBe(true);
    expect(audit.body.data.some((item: { entityId: number }) => item.entityId === activeBId)).toBe(false);
    expect(
      (
        await request(app)
          .get("/api/admin/audit")
          .set("Cookie", cookie)
          .set("x-tenant-id", String(institutionBId))
      ).status,
    ).toBe(403);
  });

  it("aprovação usa CAS: uma única concorrente vence e só o hospital local é concedido", async () => {
    const approve = () =>
      request(app)
        .post(`/api/admin/pending-signups/${pendingAId}/approve`)
        .set("Cookie", cookie)
        .set("x-tenant-id", String(institutionAId));
    const responses = await Promise.all([approve(), approve()]);
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 404 || status === 409)).toHaveLength(1);

    const [membership] = await db
      .select({ active: professionalInstitutions.active, professionalId: professionalInstitutions.professionalId })
      .from(professionalInstitutions)
      .where(
        and(
          eq(professionalInstitutions.userId, pendingAId),
          eq(professionalInstitutions.institutionId, institutionAId),
        ),
      );
    expect(membership.active).toBe(true);
    const access = await db
      .select({ institutionId: professionalAccess.institutionId, hospitalId: professionalAccess.hospitalId })
      .from(professionalAccess)
      .where(eq(professionalAccess.professionalId, membership.professionalId));
    expect(access).toEqual([{ institutionId: institutionAId, hospitalId: hospitalAId }]);
  });

  it("aprovar/recusar não alcança pendente estrangeiro nem apaga cadastro multi-tenant", async () => {
    for (const action of ["approve", "reject"] as const) {
      const response = await request(app)
        .post(`/api/admin/pending-signups/${pendingBId}/${action}`)
        .set("Cookie", cookie)
        .set("x-tenant-id", String(institutionAId));
      expect(response.status).toBe(404);
    }
    const [foreign] = await db
      .select({ status: users.approvalStatus })
      .from(users)
      .where(eq(users.id, pendingBId));
    expect(foreign.status).toBe("PENDING");

    for (const action of ["approve", "reject"] as const) {
      const multi = await request(app)
        .post(`/api/admin/pending-signups/${multiTenantPendingId}/${action}`)
        .set("Cookie", cookie)
        .set("x-tenant-id", String(institutionAId));
      expect(multi.status).toBe(409);
    }
    expect(await db.select({ id: users.id }).from(users).where(eq(users.id, multiTenantPendingId))).toHaveLength(1);
    expect(
      await db
        .select({ id: professionalInstitutions.id })
        .from(professionalInstitutions)
        .where(eq(professionalInstitutions.userId, multiTenantPendingId)),
    ).toHaveLength(2);
  });
});
