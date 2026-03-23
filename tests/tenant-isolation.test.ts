import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createContext } from "../server/_core/context";
import { appRouter } from "../server/routers";
import { getDb } from "../server/db";
import {
  hospitals,
  institutions,
  professionalInstitutions,
  professionals,
  sectors,
  shiftInstances,
  users,
} from "../drizzle/schema";

let previousNodeEnv = process.env.NODE_ENV;

let tenantAId = 1;
let tenantBId = 2;
let tenantAHospitalId = 0;
let tenantASectorId = 0;
let tenantBHospitalId = 0;
let tenantBSectorId = 0;
let tenantAShiftId = 0;
let tenantBShiftId = 0;
let userTenantAId = 0;
let userTenantBId = 0;
let userMultiId = 0;

async function ensureInstitution(db: any, id: number, name: string, cnpj: string) {
  await db
    .insert(institutions)
    .values({
      id,
      name,
      cnpj,
      legalName: `${name} S.A.`,
      tradeName: name,
      isActive: true,
    })
    .onDuplicateKeyUpdate({
      set: { name, legalName: `${name} S.A.`, tradeName: name, isActive: true },
    });
}

async function ensureHospital(db: any, institutionId: number, name: string) {
  const [existing] = await db
    .select({ id: hospitals.id })
    .from(hospitals)
    .where(and(eq(hospitals.institutionId, institutionId), eq(hospitals.name, name)))
    .limit(1);
  if (existing) return existing.id;

  const [inserted] = await db
    .insert(hospitals)
    .values({ institutionId, name, address: `Endereço ${name}` });
  return (inserted as any).insertId as number;
}

async function ensureSector(db: any, institutionId: number, hospitalId: number, name: string) {
  const [existing] = await db
    .select({ id: sectors.id })
    .from(sectors)
    .where(
      and(
        eq(sectors.institutionId, institutionId),
        eq(sectors.hospitalId, hospitalId),
        eq(sectors.name, name),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const [inserted] = await db.insert(sectors).values({
    institutionId,
    hospitalId,
    name,
    category: "internacao",
    color: "#2563EB",
    minStaffCount: 1,
  });
  return (inserted as any).insertId as number;
}

async function ensureUser(db: any, email: string, name: string) {
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) return existing.id;

  const [inserted] = await db.insert(users).values({
    email,
    name,
    role: "doctor",
    loginMethod: "test",
  });
  return (inserted as any).insertId as number;
}

async function ensureProfessional(db: any, userId: number, name: string) {
  const [existing] = await db
    .select({ id: professionals.id })
    .from(professionals)
    .where(eq(professionals.userId, userId))
    .limit(1);
  if (existing) return existing.id;

  const [inserted] = await db.insert(professionals).values({
    userId,
    name,
    role: "Médico",
    userRole: "USER",
  });
  return (inserted as any).insertId as number;
}

async function ensureLink(
  db: any,
  userId: number,
  professionalId: number,
  institutionId: number,
  isPrimary: boolean,
) {
  const [existing] = await db
    .select({ id: professionalInstitutions.id })
    .from(professionalInstitutions)
    .where(
      and(
        eq(professionalInstitutions.professionalId, professionalId),
        eq(professionalInstitutions.institutionId, institutionId),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const [inserted] = await db.insert(professionalInstitutions).values({
    userId,
    professionalId,
    institutionId,
    roleInInstitution: "USER",
    isPrimary,
    active: true,
  });
  return (inserted as any).insertId as number;
}

async function ensureShift(
  db: any,
  institutionId: number,
  hospitalId: number,
  sectorId: number,
  label: string,
) {
  const [existing] = await db
    .select({ id: shiftInstances.id })
    .from(shiftInstances)
    .where(and(eq(shiftInstances.institutionId, institutionId), eq(shiftInstances.label, label)))
    .limit(1);
  if (existing) return existing.id;

  const startAt = new Date();
  startAt.setDate(startAt.getDate() + 10);
  startAt.setHours(7, 0, 0, 0);
  const endAt = new Date(startAt);
  endAt.setHours(13, 0, 0, 0);

  const [inserted] = await db.insert(shiftInstances).values({
    institutionId,
    hospitalId,
    sectorId,
    label,
    startAt,
    endAt,
    status: "VAGO",
  });
  return (inserted as any).insertId as number;
}

async function buildContext(userId: number, tenantId?: number) {
  return createContext({
    req: {
      headers: {
        "x-test-user-id": String(userId),
        ...(tenantId ? { "x-tenant-id": String(tenantId) } : {}),
      },
    } as any,
    res: {} as any,
  });
}

describe("tenant isolation (anti-leak)", () => {
  beforeAll(async () => {
    previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    const db = await getDb();
    if (!db) throw new Error("Database not available");

    await ensureInstitution(db, tenantAId, "Hospital das Clínicas", "11111111000191");
    await ensureInstitution(db, tenantBId, "Santa Casa", "22222222000191");

    tenantAHospitalId = await ensureHospital(db, tenantAId, "Hospital A - Segurança");
    tenantBHospitalId = await ensureHospital(db, tenantBId, "Hospital B - Segurança");
    tenantASectorId = await ensureSector(db, tenantAId, tenantAHospitalId, "Setor A Segurança");
    tenantBSectorId = await ensureSector(db, tenantBId, tenantBHospitalId, "Setor B Segurança");

    userTenantAId = await ensureUser(db, "tenant.a@tests.local", "Tenant A User");
    const professionalAId = await ensureProfessional(db, userTenantAId, "Tenant A Prof");
    await ensureLink(db, userTenantAId, professionalAId, tenantAId, true);

    userTenantBId = await ensureUser(db, "tenant.b@tests.local", "Tenant B User");
    const professionalBId = await ensureProfessional(db, userTenantBId, "Tenant B Prof");
    await ensureLink(db, userTenantBId, professionalBId, tenantBId, true);

    userMultiId = await ensureUser(db, "tenant.multi@tests.local", "Tenant Multi User");
    const professionalMultiId = await ensureProfessional(db, userMultiId, "Tenant Multi Prof");
    await ensureLink(db, userMultiId, professionalMultiId, tenantAId, true);
    await ensureLink(db, userMultiId, professionalMultiId, tenantBId, false);

    tenantAShiftId = await ensureShift(
      db,
      tenantAId,
      tenantAHospitalId,
      tenantASectorId,
      "TENANT_A_SHIFT_TEST",
    );
    tenantBShiftId = await ensureShift(
      db,
      tenantBId,
      tenantBHospitalId,
      tenantBSectorId,
      "TENANT_B_SHIFT_TEST",
    );
  });

  afterAll(() => {
    process.env.NODE_ENV = previousNodeEnv;
  });

  it("fallback automático quando usuário possui apenas 1 vínculo e não envia x-tenant-id", async () => {
    const ctx = await buildContext(userTenantAId);
    expect(ctx.institutionId).toBe(tenantAId);
  });

  it("nega acesso quando usuário tenta selecionar tenant sem vínculo ativo", async () => {
    await expect(buildContext(userTenantAId, tenantBId)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("quando usuário tem múltiplos vínculos e não envia header, contexto fica sem tenant ativo", async () => {
    const ctx = await buildContext(userMultiId);
    expect(ctx.institutionId).toBeNull();
  });

  it("tenantProcedure bloqueia rotas sensíveis quando institutionId é nulo", async () => {
    const ctx = await buildContext(userMultiId);
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.shifts.listByPeriod({
        startDate: "2026-03-01",
        endDate: "2026-03-31",
      }),
    ).rejects.toBeInstanceOf(TRPCError);
  });

  it("usuário do tenant A não enxerga turnos do tenant B", async () => {
    const ctx = await buildContext(userTenantAId, tenantAId);
    const caller = appRouter.createCaller(ctx);
    const rows = await caller.shifts.listByPeriod({
      startDate: "2026-01-01",
      endDate: "2027-01-01",
    });

    const labels = rows.map((row) => row.label);
    expect(labels).toContain("TENANT_A_SHIFT_TEST");
    expect(labels).not.toContain("TENANT_B_SHIFT_TEST");
  });

  it("usuário do tenant B não enxerga turnos do tenant A", async () => {
    const ctx = await buildContext(userTenantBId, tenantBId);
    const caller = appRouter.createCaller(ctx);
    const rows = await caller.shifts.listByPeriod({
      startDate: "2026-01-01",
      endDate: "2027-01-01",
    });

    const labels = rows.map((row) => row.label);
    expect(labels).toContain("TENANT_B_SHIFT_TEST");
    expect(labels).not.toContain("TENANT_A_SHIFT_TEST");
  });

  it("não permite alterar shift de outro tenant via shifts.update", async () => {
    await expect(buildContext(userTenantAId, tenantBId)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("endpoint sem tenantProcedure (listInstitutions) não vaza instituições de outros usuários", async () => {
    const ctx = await buildContext(userTenantAId);
    const caller = appRouter.createCaller(ctx);
    const rows = await caller.professionals.listInstitutions();
    expect(rows.every((r) => r.institutionId === tenantAId)).toBe(true);
  });
});
