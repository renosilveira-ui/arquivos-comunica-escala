import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import {
  auditTrail,
  institutions,
  professionalInstitutions,
  professionals,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { authRouter } from "../server/routes/auth";
import { PROFESSION_CODES } from "../lib/profession-definitions";
import { actorCapabilities } from "../server/_core/policy";

describe("direcionamento pós-cadastro — HTTP e persistência", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  const stamp = Date.now();
  const created: number[] = [];
  let institutionId: number;
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;

  beforeAll(async () => {
    db = (await getDb())!;
    const [institution] = await db
      .insert(institutions)
      .values({
        name: `Onboarding ${stamp}`,
        cnpj: `${stamp}81`.slice(-14),
        isActive: true,
      })
      .$returningId();
    institutionId = institution.id;
  });
  afterAll(async () => {
    if (institutionId)
      await db
        .delete(auditTrail)
        .where(eq(auditTrail.institutionId, institutionId));
    if (created.length) {
      await db
        .delete(professionalInstitutions)
        .where(inArray(professionalInstitutions.userId, created));
      await db
        .delete(professionals)
        .where(inArray(professionals.userId, created));
      await db.delete(users).where(inArray(users.id, created));
    }
    if (institutionId)
      await db.delete(institutions).where(eq(institutions.id, institutionId));
  });

  it.each(PROFESSION_CODES)(
    "%s persiste identidade sem vínculo ou gestão, mesmo com autodeclaração",
    async (professionCode) => {
      const email = `onboarding-${professionCode}-${stamp}@test.local`;
      const response = await request(app)
        .post("/api/auth/signup")
        .send({
          name: "Pessoa de teste",
          email,
          password: "CadastroSeguro123",
          professionCode,
          ...(professionCode === "OTHER"
            ? { customProfessionName: "Educador" }
            : {}),
          ...(professionCode === "MEDIC"
            ? { operationalProfileCode: "RESIDENTE_ANESTESIOLOGIA" }
            : {}),
          intent: "CREATE",
          role: "admin",
          userRole: "GESTOR_PLUS",
          roleInInstitution: "GESTOR_MEDICO",
          manager_scope: [{ institutionId, hospitalId: 999, sectorId: 999 }],
          hospitalId: 999,
          sectorId: 999,
        });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        ok: true,
        pending: false,
        awaitingScale: true,
      });
      expect(response.headers["set-cookie"]).toBeUndefined();
      const [account] = await db
        .select()
        .from(users)
        .where(eq(users.email, email));
      created.push(account.id);
      expect(account.role).toBe("doctor"); // compatibility field, never promoted
      expect(account.approvalStatus).toBe("APPROVED");
      const [professional] = await db
        .select()
        .from(professionals)
        .where(eq(professionals.userId, account.id));
      expect(professional).toMatchObject({
        professionCode,
        userRole: "USER",
        customProfessionName: professionCode === "OTHER" ? "Educador" : null,
      });
      expect(
        await db
          .select()
          .from(professionalInstitutions)
          .where(eq(professionalInstitutions.userId, account.id)),
      ).toEqual([]);
      expect(
        actorCapabilities({
          userId: account.id,
          professionalId: professional.id,
          institutionId,
          roleInInstitution: "USER",
          isGlobalAdmin: false,
        }).canCreateShift,
      ).toBe(false);
    },
  );

  it("instituição informada continua sendo apenas solicitação pendente de USER", async () => {
    const email = `onboarding-pending-${stamp}@test.local`;
    const response = await request(app)
      .post("/api/auth/signup")
      .send({
        name: "Pessoa pendente",
        email,
        password: "CadastroSeguro123",
        professionCode: "ADMINISTRATIVE",
        institutionId,
        role: "admin",
        roleInInstitution: "GESTOR_PLUS",
        managerScopes: [{ hospitalId: 999 }],
      });
    expect(response.status).toBe(201);
    expect(response.body.pending).toBe(true);
    const [account] = await db
      .select()
      .from(users)
      .where(eq(users.email, email));
    created.push(account.id);
    expect(account.approvalStatus).toBe("PENDING");
    const [membership] = await db
      .select()
      .from(professionalInstitutions)
      .where(eq(professionalInstitutions.userId, account.id));
    expect(membership).toMatchObject({
      institutionId,
      active: false,
      roleInInstitution: "USER",
    });
  });

  it.each([
    { professionCode: "GESTOR_PLUS" },
    { professionCode: null },
    { professionCode: "OTHER", customProfessionName: " " },
    { professionCode: "OTHER", customProfessionName: "a".repeat(101) },
    { professionCode: "MEDIC" },
    { professionCode: "MEDIC", institutionId: 1 },
    { professionCode: "NURSING", medicalSpecialtyCode: "ANESTESIOLOGIA" },
    {
      professionCode: "ADMINISTRATIVE",
      operationalProfileCode: "RESIDENTE_ANESTESIOLOGIA",
    },
  ])("rejeita identidade inválida antes de persistir: %j", async (identity) => {
    const email = `onboarding-invalid-${stamp}@test.local`;
    const response = await request(app)
      .post("/api/auth/signup")
      .send({
        name: "Pessoa",
        email,
        password: "CadastroSeguro123",
        ...identity,
      });
    expect(response.status).toBe(400);
    expect(await db.select().from(users).where(eq(users.email, email))).toEqual(
      [],
    );
  });
});
