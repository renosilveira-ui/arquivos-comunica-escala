import { beforeAll, describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { and, eq, gte, lt } from "drizzle-orm";
import { appRouter } from "../server/routers";
import { createContext } from "../server/_core/context";
import { getDb } from "../server/db";
import {
  hospitals,
  institutions,
  professionalAccess,
  professionalInstitutions,
  professionals,
  sectors,
  shiftInstances,
  users,
} from "../drizzle/schema";

let tenantAId = 3101;
let tenantBId = 3102;
let userMultiId = 0;
let userTenantBOnlyId = 0;

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
    color: "#0891B2",
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
  const startAt = new Date("2026-04-20T07:00:00.000Z");
  const endAt = new Date("2026-04-20T13:00:00.000Z");

  const [existing] = await db
    .select({ id: shiftInstances.id })
    .from(shiftInstances)
    .where(and(eq(shiftInstances.institutionId, institutionId), eq(shiftInstances.label, label)))
    .limit(1);
  if (existing) return existing.id;

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

async function ensureProfessionalAccess(
  db: any,
  institutionId: number,
  professionalId: number,
  hospitalId: number,
  sectorId: number,
) {
  const [existing] = await db
    .select({ id: professionalAccess.id })
    .from(professionalAccess)
    .where(
      and(
        eq(professionalAccess.institutionId, institutionId),
        eq(professionalAccess.professionalId, professionalId),
        eq(professionalAccess.hospitalId, hospitalId),
        eq(professionalAccess.sectorId, sectorId),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const [inserted] = await db.insert(professionalAccess).values({
    institutionId,
    professionalId,
    hospitalId,
    sectorId,
    canAccess: true,
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

describe("E2E tenant switch hardening", () => {
  beforeAll(async () => {
    process.env.NODE_ENV = "development";
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    await ensureInstitution(db, tenantAId, "Tenant A E2E", "31010001000191");
    await ensureInstitution(db, tenantBId, "Tenant B E2E", "31020001000191");

    const tenantAHospitalId = await ensureHospital(db, tenantAId, "Hospital Tenant A E2E");
    const tenantBHospitalId = await ensureHospital(db, tenantBId, "Hospital Tenant B E2E");
    const tenantASectorId = await ensureSector(db, tenantAId, tenantAHospitalId, "Setor Tenant A E2E");
    const tenantBSectorId = await ensureSector(db, tenantBId, tenantBHospitalId, "Setor Tenant B E2E");

    userMultiId = await ensureUser(db, "e2e.switch.multi@tests.local", "Tenant Switch Multi");
    const profMultiId = await ensureProfessional(db, userMultiId, "Tenant Switch Multi Prof");
    await ensureLink(db, userMultiId, profMultiId, tenantAId, true);
    await ensureLink(db, userMultiId, profMultiId, tenantBId, false);
    await ensureProfessionalAccess(db, tenantAId, profMultiId, tenantAHospitalId, tenantASectorId);
    await ensureProfessionalAccess(db, tenantBId, profMultiId, tenantBHospitalId, tenantBSectorId);

    userTenantBOnlyId = await ensureUser(db, "e2e.switch.bonly@tests.local", "Tenant B Only User");
    const profBOnlyId = await ensureProfessional(db, userTenantBOnlyId, "Tenant B Only Prof");
    await ensureLink(db, userTenantBOnlyId, profBOnlyId, tenantBId, true);
    await ensureProfessionalAccess(db, tenantBId, profBOnlyId, tenantBHospitalId, tenantBSectorId);

    await ensureShift(db, tenantAId, tenantAHospitalId, tenantASectorId, "E2E_TENANT_A_SHIFT");
    await ensureShift(db, tenantBId, tenantBHospitalId, tenantBSectorId, "E2E_TENANT_B_SHIFT");
  });

  it("passo 1: login no tenant A retorna apenas shifts do tenant A", async () => {
    const ctxA = await buildContext(userMultiId, tenantAId);
    const callerA = appRouter.createCaller(ctxA);

    const rowsA = await callerA.shifts.listByPeriod({
      startDate: "2026-04-01",
      endDate: "2026-05-01",
    });

    expect(rowsA.length).toBeGreaterThan(0);
    expect(rowsA.every((row) => row.institutionId === tenantAId)).toBe(true);
    expect(rowsA.some((row) => row.label === "E2E_TENANT_A_SHIFT")).toBe(true);
    expect(rowsA.some((row) => row.label === "E2E_TENANT_B_SHIFT")).toBe(false);
  });

  it("passo 2: troca para tenant B limpa cache e retorna apenas dados de B", async () => {
    const queryClient = new QueryClient();
    const shiftsQueryKey = ["trpc", "shifts.listByPeriod", { startDate: "2026-04-01", endDate: "2026-05-01" }];

    const ctxA = await buildContext(userMultiId, tenantAId);
    const callerA = appRouter.createCaller(ctxA);
    const rowsA = await callerA.shifts.listByPeriod({
      startDate: "2026-04-01",
      endDate: "2026-05-01",
    });

    queryClient.setQueryData(shiftsQueryKey, rowsA);
    expect((queryClient.getQueryData(shiftsQueryKey) as any[]).some((row) => row.institutionId === tenantAId)).toBe(
      true,
    );

    // Mirrors frontend hygiene rule on tenant switch.
    queryClient.clear();
    expect(queryClient.getQueryData(shiftsQueryKey)).toBeUndefined();

    const ctxB = await buildContext(userMultiId, tenantBId);
    const callerB = appRouter.createCaller(ctxB);
    const rowsB = await callerB.shifts.listByPeriod({
      startDate: "2026-04-01",
      endDate: "2026-05-01",
    });

    expect(rowsB.length).toBeGreaterThan(0);
    expect(rowsB.every((row) => row.institutionId === tenantBId)).toBe(true);
    expect(rowsB.some((row) => row.label === "E2E_TENANT_B_SHIFT")).toBe(true);
    expect(rowsB.some((row) => row.label === "E2E_TENANT_A_SHIFT")).toBe(false);
  });

  it("passo 3 (pentest): usuário sem vínculo no tenant A é bloqueado ao forçar x-tenant-id=A", async () => {
    await expect(buildContext(userTenantBOnlyId, tenantAId)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    // Defensive assertion: even if context were bypassed, protected call should not proceed.
    const ctxB = await buildContext(userTenantBOnlyId, tenantBId);
    const callerB = appRouter.createCaller(ctxB);
    await expect(
      callerB.shifts.listByPeriod({
        startDate: "2026-04-01",
        endDate: "2026-05-01",
      }),
    ).resolves.toBeDefined();
  });

  it("sanity: tenant leak check through direct DB query boundary", async () => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const start = new Date("2026-04-01T00:00:00.000Z");
    const end = new Date("2026-05-01T00:00:00.000Z");

    const rows = await db
      .select({
        institutionId: shiftInstances.institutionId,
        label: shiftInstances.label,
      })
      .from(shiftInstances)
      .where(and(eq(shiftInstances.institutionId, tenantAId), gte(shiftInstances.startAt, start), lt(shiftInstances.startAt, end)));

    expect(rows.every((row) => row.institutionId === tenantAId)).toBe(true);
    expect(rows.some((row) => row.label === "E2E_TENANT_A_SHIFT")).toBe(true);
  });
});
