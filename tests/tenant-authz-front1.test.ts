import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "../server/db";
import {
  hospitals,
  institutions,
  managerScope,
  professionalAccess,
  professionalInstitutions,
  professionals,
  sectors,
  shiftInstances,
  users,
} from "../drizzle/schema";
import {
  actorCapabilities,
  assertCanManageInstitutionSchedule,
  assertManagerScopeAccess,
  resolveTenantActor,
} from "../server/_core/policy";
import { editorRouter } from "../server/editor";

describe("Frente 1 - policy tenant + scoping crítico", () => {
  let db: Awaited<ReturnType<typeof getDb>>;
  let userId: number;
  let adminUserId: number;
  let institutionAId: number;
  let institutionBId: number;
  let institutionCId: number;
  let hospitalAId: number;
  let hospitalBId: number;
  let sectorAId: number;
  let sectorBId: number;
  let professionalId: number;
  let adminProfessionalId: number;
  let shiftAId: number;

  beforeAll(async () => {
    db = await getDb();
    if (!db) throw new Error("Database not available");

    const stamp = Date.now();
    // Each CNPJ is generated independently with its own 8-digit random
    // suffix. The previous shared-base approach (cnpjBase + last-digit
    // swap) collided ~20% of runs because cnpjA could already end in
    // "7" or "8", making it equal to cnpjC or cnpjB respectively.
    const makeCnpj = () => {
      const ts = Date.now().toString();
      const rnd = Math.floor(Math.random() * 1e8).toString().padStart(8, "0");
      return `${ts}${rnd}`.slice(-14);
    };
    const cnpjA = makeCnpj();
    const cnpjB = makeCnpj();
    const cnpjC = makeCnpj();

    const [insA] = await db
      .insert(institutions)
      .values({
        name: `Tenant A ${stamp}`,
        cnpj: cnpjA,
        legalName: `Tenant A ${stamp}`,
        tradeName: `TA${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionAId = insA.id;

    const [insB] = await db
      .insert(institutions)
      .values({
        name: `Tenant B ${stamp}`,
        cnpj: cnpjB,
        legalName: `Tenant B ${stamp}`,
        tradeName: `TB${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionBId = insB.id;

    const [insC] = await db
      .insert(institutions)
      .values({
        name: `Tenant C ${stamp}`,
        cnpj: cnpjC,
        legalName: `Tenant C ${stamp}`,
        tradeName: `TC${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionCId = insC.id;

    const [hospitalA] = await db
      .insert(hospitals)
      .values({ institutionId: institutionAId, name: `Hospital A ${stamp}` })
      .$returningId();
    hospitalAId = hospitalA.id;

    const [hospitalB] = await db
      .insert(hospitals)
      .values({ institutionId: institutionBId, name: `Hospital B ${stamp}` })
      .$returningId();
    hospitalBId = hospitalB.id;

    const [sectorA] = await db
      .insert(sectors)
      .values({
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        name: `Setor A ${stamp}`,
        category: "internacao",
        color: "#2563EB",
      })
      .$returningId();
    sectorAId = sectorA.id;

    const [sectorB] = await db
      .insert(sectors)
      .values({
        institutionId: institutionBId,
        hospitalId: hospitalBId,
        name: `Setor B ${stamp}`,
        category: "internacao",
        color: "#16A34A",
      })
      .$returningId();
    sectorBId = sectorB.id;

    const [user] = await db
      .insert(users)
      .values({
        openId: `front1-user-${stamp}`,
        name: `Front1 User ${stamp}`,
        email: `front1-user-${stamp}@test.local`,
        role: "doctor",
      })
      .$returningId();
    userId = user.id;

    const [adminUser] = await db
      .insert(users)
      .values({
        openId: `front1-admin-${stamp}`,
        name: `Front1 Admin ${stamp}`,
        email: `front1-admin-${stamp}@test.local`,
        role: "admin",
      })
      .$returningId();
    adminUserId = adminUser.id;

    const [pro] = await db
      .insert(professionals)
      .values({
        userId,
        name: `Prof Front1 ${stamp}`,
        role: "Médico",
        userRole: "USER",
      })
      .$returningId();
    professionalId = pro.id;

    const [adminPro] = await db
      .insert(professionals)
      .values({
        userId: adminUserId,
        name: `Prof Admin Front1 ${stamp}`,
        role: "Médico",
        userRole: "USER",
      })
      .$returningId();
    adminProfessionalId = adminPro.id;

    await db.insert(professionalInstitutions).values([
      {
        userId,
        professionalId,
        institutionId: institutionAId,
        roleInInstitution: "USER",
        active: true,
      },
      {
        userId,
        professionalId,
        institutionId: institutionBId,
        roleInInstitution: "GESTOR_MEDICO",
        active: true,
      },
      {
        userId: adminUserId,
        professionalId: adminProfessionalId,
        institutionId: institutionAId,
        roleInInstitution: "USER",
        active: true,
      },
    ]);

    await db.insert(managerScope).values({
      institutionId: institutionBId,
      managerProfessionalId: professionalId,
      hospitalId: hospitalBId,
      sectorId: sectorBId,
      active: true,
    });

    await db.insert(professionalAccess).values([
      {
        institutionId: institutionAId,
        professionalId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
      },
      {
        institutionId: institutionBId,
        professionalId,
        hospitalId: hospitalBId,
        sectorId: sectorBId,
      },
    ]);

    const [shiftA] = await db
      .insert(shiftInstances)
      .values({
        institutionId: institutionAId,
        hospitalId: hospitalAId,
        sectorId: sectorAId,
        label: `Shift A ${stamp}`,
        startAt: new Date(Date.now() + 86_400_000),
        endAt: new Date(Date.now() + 86_400_000 + 21_600_000),
        status: "VAGO",
      })
      .$returningId();
    shiftAId = shiftA.id;
  });

  it("nega tenant hopping quando não há vínculo ativo", async () => {
    await expect(resolveTenantActor(userId, institutionCId, false)).rejects.toThrow(
      /vínculo ativo/i,
    );
  });

  it("respeita papel contextual por instituição para o mesmo usuário", async () => {
    const actorA = await resolveTenantActor(userId, institutionAId, false);
    const actorB = await resolveTenantActor(userId, institutionBId, false);

    expect(actorA.roleInInstitution).toBe("USER");
    expect(actorB.roleInInstitution).toBe("GESTOR_MEDICO");
    expect(actorCapabilities(actorA).canCreateShift).toBe(false);
    expect(actorCapabilities(actorB).canCreateShift).toBe(true);
  });

  it("mantém override explícito de admin global sem quebrar tenant", async () => {
    const adminActor = await resolveTenantActor(adminUserId, institutionAId, true);
    expect(adminActor.roleInInstitution).toBe("USER");
    expect(actorCapabilities(adminActor).canCreateShift).toBe(true);
    expect(() => assertCanManageInstitutionSchedule(adminActor)).not.toThrow();
  });

  it("exige manager_scope contextual para gestor médico", async () => {
    const actorB = await resolveTenantActor(userId, institutionBId, false);
    await expect(assertManagerScopeAccess(actorB, hospitalBId, sectorBId)).resolves.toBeUndefined();
    await expect(assertManagerScopeAccess(actorB, hospitalAId, sectorAId)).rejects.toThrow(
      /jurisdição/i,
    );
  });

  it("bloqueia mutação crítica no editor quando shift é de outro tenant", async () => {
    const caller = editorRouter.createCaller({
      user: { id: userId, role: "doctor", name: "Tenant User", email: "tenant@test.local" },
      institutionId: institutionBId,
      allowedInstitutionIds: [institutionAId, institutionBId],
    } as any);

    await expect(
      caller.assignDirect({
        shiftInstanceId: shiftAId,
        professionalId,
        assignmentType: "ON_DUTY",
        reason: "test tenant scope",
      }),
    ).rejects.toThrow(/Turno não encontrado|jurisdição/i);
  });

  it("bloqueia mutação crítica para papel USER no tenant ativo", async () => {
    const actorA = await resolveTenantActor(userId, institutionAId, false);
    expect(() => assertCanManageInstitutionSchedule(actorA)).toThrow(/gestores/i);
  });

  it("bloqueia manager_scope quando gestor muda setor/hospital no mesmo tenant", async () => {
    const [otherSector] = await db
      .insert(sectors)
      .values({
        institutionId: institutionBId,
        hospitalId: hospitalBId,
        name: `Setor B2 ${Date.now()}`,
        category: "internacao",
        color: "#9333EA",
      })
      .$returningId();

    const actorB = await resolveTenantActor(userId, institutionBId, false);
    await expect(assertManagerScopeAccess(actorB, hospitalBId, otherSector.id)).rejects.toThrow(
      /setor/i,
    );
  });

  it("garante vínculo ativo ao resolver ator por tenant", async () => {
    await db
      .update(professionalInstitutions)
      .set({ active: false })
      .where(
        and(
          eq(professionalInstitutions.userId, userId),
          eq(professionalInstitutions.institutionId, institutionAId),
        ),
      );

    await expect(resolveTenantActor(userId, institutionAId, false)).rejects.toThrow(/vínculo ativo/i);
  });
});
