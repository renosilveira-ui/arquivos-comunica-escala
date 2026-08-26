// GET /api/admin/recent-registrations — cadastros recentes visíveis ao admin.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import express, { type Express } from "express";
import request from "supertest";
import {
  institutions,
  professionalInstitutions,
  professionals,
  users,
} from "../drizzle/schema";
import { adminRouter } from "../server/routes/admin";
import { authRouter } from "../server/routes/auth";
import { getDb } from "../server/db";

const STAMP = Date.now();
const PASSWORD = "SenhaRecent123";

describe("admin recent-registrations", () => {
  let app: Express;
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionId: number;
  let adminId: number;
  let cookie: string;
  const userIds: number[] = [];
  const professionalIds: number[] = [];

  beforeAll(async () => {
    const connection = await getDb();
    if (!connection) throw new Error("Database not available");
    db = connection;
    app = express();
    app.use(express.json());
    app.use("/api/auth", authRouter);
    app.use("/api/admin", adminRouter);

    const [institution] = await db
      .insert(institutions)
      .values({
        name: `ARR Inst ${STAMP}`,
        cnpj: `${STAMP}99`.slice(-14).padStart(14, "0"),
        legalName: `ARR Inst ${STAMP}`,
        tradeName: `ARR${STAMP}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = institution.id;

    const [adminUser] = await db
      .insert(users)
      .values({
        name: "ARR Admin",
        email: `arr-admin-${STAMP}@test.local`,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        loginMethod: "email",
        role: "admin",
        approvalStatus: "APPROVED",
      })
      .$returningId();
    adminId = adminUser.id;
    userIds.push(adminId);

    const [adminPro] = await db
      .insert(professionals)
      .values({
        userId: adminId,
        name: "ARR Admin",
        role: "Administrador",
        userRole: "GESTOR_PLUS",
      })
      .$returningId();
    professionalIds.push(adminPro.id);

    await db.insert(professionalInstitutions).values({
      userId: adminId,
      professionalId: adminPro.id,
      institutionId,
      roleInInstitution: "GESTOR_PLUS",
      isPrimary: true,
      active: true,
    });

    const awaitingEmail = `arr-awaiting-${STAMP}@test.local`;
    const signup = await request(app).post("/api/auth/signup").send({
      name: "Ananda Arruda",
      email: awaitingEmail,
      password: PASSWORD,
      medicalSpecialtyCode: "ANESTESIOLOGIA",
    });
    expect(signup.status).toBe(201);
    const [awaitingUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, awaitingEmail));
    userIds.push(awaitingUser.id);
    const [awaitingPro] = await db
      .select({ id: professionals.id })
      .from(professionals)
      .where(eq(professionals.userId, awaitingUser.id));
    professionalIds.push(awaitingPro.id);

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: `arr-admin-${STAMP}@test.local`, password: PASSWORD });
    expect(login.status).toBe(200);
    const setCookie = login.headers["set-cookie"];
    cookie = (Array.isArray(setCookie) ? setCookie : [setCookie]).find(
      (item: string) => item?.startsWith("session="),
    ) ?? "";
  });

  afterAll(async () => {
    await db
      .delete(professionalInstitutions)
      .where(inArray(professionalInstitutions.userId, userIds));
    await db
      .delete(professionals)
      .where(inArray(professionals.id, professionalIds));
    await db.delete(users).where(inArray(users.id, userIds));
    await db.delete(institutions).where(eq(institutions.id, institutionId));
  });

  it("lista cadastro público sem escala como AWAITING_SCALE", async () => {
    expect(
      (await request(app).get("/api/admin/recent-registrations").set("Cookie", cookie))
        .status,
    ).toBe(400);

    const response = await request(app)
      .get("/api/admin/recent-registrations")
      .set("Cookie", cookie)
      .set("x-tenant-id", String(institutionId));

    expect(response.status).toBe(200);
    const ananda = response.body.registrations.find(
      (row: { name: string | null }) => row.name === "Ananda Arruda",
    );
    expect(ananda).toMatchObject({
      status: "AWAITING_SCALE",
      email: `arr-awaiting-${STAMP}@test.local`,
    });
    expect(ananda.createdAt).toBeTruthy();
  });
});
