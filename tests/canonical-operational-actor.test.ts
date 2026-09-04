import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inArray, sql } from "drizzle-orm";
import {
  hospitals,
  institutions,
  managerScope,
  professionalAccess,
  professionalInstitutions,
  professionals,
  sectors,
  userContactChannels,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { logger } from "../server/_core/logger";
import { rowsFromExecute } from "../server/_core/db-results";
import {
  isCanonicalOperationalActorInfraFailure,
  resolveCanonicalOperationalActorForUser,
} from "../server/_core/canonical-operational-actor";
import { listActiveInstitutionIdsForUser } from "../server/_core/tenant";
import { parseSwapIntent } from "../server/natural-language/swap-intent-parser";
import {
  resolveSwapIntent,
  type SwapIntentActor,
} from "../server/natural-language/swap-intent-resolver";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type InstitutionRole = "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";

describe("resolveCanonicalOperationalActorForUser — identidade e topologia", () => {
  let db: Db;
  const stamp = Date.now();
  let tenantSeq = 0;
  const userIds: number[] = [];
  const professionalIds: number[] = [];
  const institutionIds: number[] = [];
  const hospitalIds: number[] = [];
  const sectorIds: number[] = [];
  const accessIds: number[] = [];
  const scopeIds: number[] = [];

  async function makeTenant(label: string, active = true) {
    tenantSeq += 1;
    const cnpj = `${String(stamp).slice(-10)}${String(tenantSeq).padStart(4, "0")}`;
    const [institution] = await db
      .insert(institutions)
      .values({
        name: `COA ${label} ${stamp}`,
        cnpj,
        legalName: `COA ${label} ${stamp}`,
        tradeName: `COA${label}`,
        isActive: active,
      })
      .$returningId();
    institutionIds.push(institution.id);
    const [hospital] = await db
      .insert(hospitals)
      .values({
        institutionId: institution.id,
        name: `COA Hospital ${label} ${stamp}`,
      })
      .$returningId();
    hospitalIds.push(hospital.id);
    const [sector] = await db
      .insert(sectors)
      .values({
        institutionId: institution.id,
        hospitalId: hospital.id,
        name: "UTI",
        category: "internacao",
        color: "#2563EB",
      })
      .$returningId();
    sectorIds.push(sector.id);
    return {
      institutionId: institution.id,
      hospitalId: hospital.id,
      sectorId: sector.id,
    };
  }

  async function makeUser(input: {
    label: string;
    approvalStatus?: "PENDING" | "APPROVED";
    deletedAt?: Date | null;
    role?: "admin" | "manager" | "doctor";
    email?: string;
    name?: string;
  }) {
    const name = input.name ?? `coa-user-${input.label}-${stamp}`;
    const [user] = await db
      .insert(users)
      .values({
        name,
        email: input.email ?? `coa-${input.label}-${stamp}@example.test`,
        passwordHash: "not-used",
        role: input.role ?? "doctor",
        approvalStatus: input.approvalStatus ?? "APPROVED",
        sessionVersion: 1,
        deletedAt: input.deletedAt ?? null,
      })
      .$returningId();
    userIds.push(user.id);
    return { userId: user.id, name };
  }

  async function makeProfessional(input: {
    userId: number;
    name: string;
    userRole?: InstitutionRole;
  }) {
    const [professional] = await db
      .insert(professionals)
      .values({
        userId: input.userId,
        name: input.name,
        role: "Médico",
        specialty: "Anestesiologia",
        userRole: input.userRole ?? "USER",
      })
      .$returningId();
    professionalIds.push(professional.id);
    return professional.id;
  }

  async function linkMembership(input: {
    userId: number;
    professionalId: number;
    institutionId: number;
    roleInInstitution?: InstitutionRole;
    active?: boolean;
    isPrimary?: boolean;
  }) {
    await db.insert(professionalInstitutions).values({
      professionalId: input.professionalId,
      userId: input.userId,
      institutionId: input.institutionId,
      roleInInstitution: input.roleInInstitution ?? "USER",
      active: input.active ?? true,
      isPrimary: input.isPrimary ?? false,
    });
  }

  async function grantAccess(input: {
    professionalId: number;
    institutionId: number;
    hospitalId: number;
    sectorId: number | null;
  }) {
    const [row] = await db
      .insert(professionalAccess)
      .values({
        institutionId: input.institutionId,
        professionalId: input.professionalId,
        hospitalId: input.hospitalId,
        sectorId: input.sectorId,
        canAccess: true,
      })
      .$returningId();
    accessIds.push(row.id);
  }

  async function grantScope(input: {
    professionalId: number;
    institutionId: number;
    hospitalId: number;
    sectorId: number | null;
  }) {
    const [row] = await db
      .insert(managerScope)
      .values({
        institutionId: input.institutionId,
        managerProfessionalId: input.professionalId,
        hospitalId: input.hospitalId,
        sectorId: input.sectorId,
        active: true,
      })
      .$returningId();
    scopeIds.push(row.id);
  }

  beforeAll(async () => {
    const maybe = await getDb();
    if (!maybe) throw new Error("DB unavailable");
    db = maybe;
  });

  afterAll(async () => {
    if (accessIds.length > 0) {
      await db.delete(professionalAccess).where(inArray(professionalAccess.id, accessIds));
    }
    if (scopeIds.length > 0) {
      await db.delete(managerScope).where(inArray(managerScope.id, scopeIds));
    }
    if (professionalIds.length > 0) {
      await db
        .delete(professionalInstitutions)
        .where(inArray(professionalInstitutions.professionalId, professionalIds));
      await db.delete(professionals).where(inArray(professionals.id, professionalIds));
    }
    if (userIds.length > 0) {
      await db.delete(userContactChannels).where(inArray(userContactChannels.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    if (sectorIds.length > 0) {
      await db.delete(sectors).where(inArray(sectors.id, sectorIds));
    }
    if (hospitalIds.length > 0) {
      await db.delete(hospitals).where(inArray(hospitals.id, hospitalIds));
    }
    if (institutionIds.length > 0) {
      await db.delete(institutions).where(inArray(institutions.id, institutionIds));
    }
  });

  it("schema: 1 user → 0 ou >1 professional é possível; sem UNIQUE em professionals.user_id", async () => {
    const result = await db.execute(sql`
      SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'professionals'
    `);
    type IndexRow = {
      INDEX_NAME: string;
      NON_UNIQUE: number | string;
      COLUMN_NAME: string;
      SEQ_IN_INDEX: number | string;
    };
    const indexes = new Map<string, { nonUnique: number; columns: string[] }>();
    for (const row of rowsFromExecute<IndexRow>(result)) {
      const name = String(row.INDEX_NAME);
      const entry = indexes.get(name) ?? {
        nonUnique: Number(row.NON_UNIQUE),
        columns: [],
      };
      entry.columns[Number(row.SEQ_IN_INDEX) - 1] = String(row.COLUMN_NAME);
      indexes.set(name, entry);
    }
    const uniqueOnUserId = [...indexes.values()].some(
      (index) =>
        index.nonUnique === 0 &&
        index.columns.filter(Boolean).join(",") === "user_id",
    );
    expect(uniqueOnUserId).toBe(false);
  });

  it("1. user válido + professional válido + uma instituição", async () => {
    const tenant = await makeTenant("one");
    const { userId, name } = await makeUser({ label: "ok" });
    const professionalId = await makeProfessional({ userId, name });
    await linkMembership({
      userId,
      professionalId,
      institutionId: tenant.institutionId,
    });

    const result = await resolveCanonicalOperationalActorForUser({ userId });
    expect(result).toEqual({
      ok: true,
      actor: {
        userId,
        professionalId,
        institutionIds: [tenant.institutionId],
      },
    });
  });

  it("2. user inexistente → ACTOR_NOT_FOUND", async () => {
    const result = await resolveCanonicalOperationalActorForUser({
      userId: 2_000_000_000,
    });
    expect(result).toEqual({ ok: false, code: "ACTOR_NOT_FOUND" });
    expect(isCanonicalOperationalActorInfraFailure(result)).toBe(false);
  });

  it("userId inválido (não é inteiro positivo) → ACTOR_NOT_FOUND, não infra", async () => {
    for (const userId of [0, -3, 1.5, Number.NaN]) {
      const result = await resolveCanonicalOperationalActorForUser({ userId });
      expect(result).toEqual({ ok: false, code: "ACTOR_NOT_FOUND" });
    }
  });

  it("3. professional inexistente → ACTOR_PROFESSIONAL_NOT_FOUND", async () => {
    const { userId } = await makeUser({ label: "noprof" });
    const result = await resolveCanonicalOperationalActorForUser({ userId });
    expect(result).toEqual({ ok: false, code: "ACTOR_PROFESSIONAL_NOT_FOUND" });
  });

  it("4. professional inválido: user PENDING ou deletado → ACTOR_NOT_FOUND", async () => {
    const pending = await makeUser({
      label: "pending",
      approvalStatus: "PENDING",
    });
    const pendingProf = await makeProfessional({
      userId: pending.userId,
      name: pending.name,
    });
    const pendingTenant = await makeTenant("pendt");
    await linkMembership({
      userId: pending.userId,
      professionalId: pendingProf,
      institutionId: pendingTenant.institutionId,
    });
    await expect(
      resolveCanonicalOperationalActorForUser({ userId: pending.userId }),
    ).resolves.toEqual({ ok: false, code: "ACTOR_NOT_FOUND" });

    const deleted = await makeUser({
      label: "deleted",
      deletedAt: new Date(),
    });
    const deletedProf = await makeProfessional({
      userId: deleted.userId,
      name: deleted.name,
    });
    await linkMembership({
      userId: deleted.userId,
      professionalId: deletedProf,
      institutionId: pendingTenant.institutionId,
    });
    await expect(
      resolveCanonicalOperationalActorForUser({ userId: deleted.userId }),
    ).resolves.toEqual({ ok: false, code: "ACTOR_NOT_FOUND" });
  });

  it("5. >1 professional para o mesmo user → ACTOR_PROFESSIONAL_AMBIGUOUS (nunca LIMIT 1)", async () => {
    const tenant = await makeTenant("amb");
    const { userId, name } = await makeUser({ label: "two-prof" });
    const first = await makeProfessional({ userId, name: `${name} A` });
    const second = await makeProfessional({ userId, name: `${name} B` });
    await linkMembership({
      userId,
      professionalId: first,
      institutionId: tenant.institutionId,
    });
    // unique (userId, institutionId) impede segundo vínculo no mesmo tenant;
    // o segundo professional existe mesmo sem membership.
    expect(second).not.toBe(first);
    const result = await resolveCanonicalOperationalActorForUser({ userId });
    expect(result).toEqual({ ok: false, code: "ACTOR_PROFESSIONAL_AMBIGUOUS" });
    expect(result).not.toMatchObject({ ok: true });
  });

  it("5b. dois professionals com memberships em tenants distintos continua AMBIGUOUS", async () => {
    const tenantA = await makeTenant("amb-a");
    const tenantB = await makeTenant("amb-b");
    const { userId, name } = await makeUser({ label: "two-prof-split" });
    const first = await makeProfessional({ userId, name: `${name} A` });
    const second = await makeProfessional({ userId, name: `${name} B` });
    await linkMembership({
      userId,
      professionalId: first,
      institutionId: tenantA.institutionId,
    });
    await linkMembership({
      userId,
      professionalId: second,
      institutionId: tenantB.institutionId,
    });
    const result = await resolveCanonicalOperationalActorForUser({ userId });
    expect(result).toEqual({ ok: false, code: "ACTOR_PROFESSIONAL_AMBIGUOUS" });
    const sessionIds = await listActiveInstitutionIdsForUser(userId);
    expect([...sessionIds].sort((a, b) => a - b)).toEqual(
      [tenantA.institutionId, tenantB.institutionId].sort((a, b) => a - b),
    );
  });

  it("6-8. USER, GESTOR_MEDICO e GESTOR_PLUS com professional resolvem igual", async () => {
    const tenant = await makeTenant("roles");
    const resolved: { role: InstitutionRole; actor: unknown }[] = [];
    for (const role of ["USER", "GESTOR_MEDICO", "GESTOR_PLUS"] as const) {
      const { userId, name } = await makeUser({
        label: `role-${role}`,
        role: role === "GESTOR_PLUS" ? "admin" : "doctor",
      });
      const professionalId = await makeProfessional({
        userId,
        name,
        userRole: role,
      });
      await linkMembership({
        userId,
        professionalId,
        institutionId: tenant.institutionId,
        roleInInstitution: role,
      });
      const result = await resolveCanonicalOperationalActorForUser({ userId });
      expect(result).toEqual({
        ok: true,
        actor: {
          userId,
          professionalId,
          institutionIds: [tenant.institutionId],
        },
      });
      resolved.push({ role, actor: result.ok ? result.actor : result });
    }
    expect(new Set(resolved.map((row) => JSON.stringify({
      institutionIds: (row.actor as { institutionIds: number[] }).institutionIds,
    }))).size).toBe(1);
  });

  it("9. gestor sem identidade clínica não resolve", async () => {
    const { userId } = await makeUser({ label: "gestor-bare", role: "manager" });
    const result = await resolveCanonicalOperationalActorForUser({ userId });
    expect(result).toEqual({ ok: false, code: "ACTOR_PROFESSIONAL_NOT_FOUND" });
  });

  it("10-14. uma, duas e três instituições; ordem determinística; sem duplicatas", async () => {
    const tenantC = await makeTenant("C3");
    const tenantA = await makeTenant("A3");
    const tenantB = await makeTenant("B3");
    const { userId, name } = await makeUser({ label: "multi" });
    const professionalId = await makeProfessional({ userId, name });
    // Insert order C, A, B — o retorno deve ser ids crescentes, não ordem SQL.
    await linkMembership({
      userId,
      professionalId,
      institutionId: tenantC.institutionId,
    });
    await linkMembership({
      userId,
      professionalId,
      institutionId: tenantA.institutionId,
    });
    await linkMembership({
      userId,
      professionalId,
      institutionId: tenantB.institutionId,
      // Primary no maior id: listActive ordena primary-first; B2-B ordena por id.
      isPrimary: true,
    });

    const result = await resolveCanonicalOperationalActorForUser({ userId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expected = [
      tenantC.institutionId,
      tenantA.institutionId,
      tenantB.institutionId,
    ].sort((left, right) => left - right);
    expect(result.actor.institutionIds).toEqual(expected);
    expect(result.actor.institutionIds).toEqual(
      [...new Set(result.actor.institutionIds)],
    );
    expect(result.actor.institutionIds.every((id) => id > 0)).toBe(true);
    const sessionOrder = await listActiveInstitutionIdsForUser(userId);
    expect(sessionOrder[0]).toBe(tenantB.institutionId);
    expect(result.actor.institutionIds).not.toEqual(sessionOrder);
    expect([...result.actor.institutionIds].sort((a, b) => a - b)).toEqual(
      [...sessionOrder].sort((a, b) => a - b),
    );
  });

  it("11. duas instituições é sucesso — não escolhe tenant nem AMBIGUOUS_INSTITUTION", async () => {
    const first = await makeTenant("d1");
    const second = await makeTenant("d2");
    const { userId, name } = await makeUser({ label: "dual" });
    const professionalId = await makeProfessional({ userId, name });
    await linkMembership({
      userId,
      professionalId,
      institutionId: second.institutionId,
    });
    await linkMembership({
      userId,
      professionalId,
      institutionId: first.institutionId,
    });
    const result = await resolveCanonicalOperationalActorForUser({ userId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actor.institutionIds).toEqual(
      [first.institutionId, second.institutionId].sort((a, b) => a - b),
    );
    expect(JSON.stringify(result)).not.toContain("AMBIGUOUS_INSTITUTION");
  });

  it("15-16. membership inativa ou zero vínculos → ACTOR_INSTITUTION_MEMBERSHIP_NOT_FOUND", async () => {
    const tenant = await makeTenant("inact");
    const none = await makeUser({ label: "zero-mem" });
    const noneProf = await makeProfessional({
      userId: none.userId,
      name: none.name,
    });
    expect(noneProf).toBeGreaterThan(0);
    await expect(
      resolveCanonicalOperationalActorForUser({ userId: none.userId }),
    ).resolves.toEqual({
      ok: false,
      code: "ACTOR_INSTITUTION_MEMBERSHIP_NOT_FOUND",
    });

    const inactive = await makeUser({ label: "inactive-mem" });
    const inactiveProf = await makeProfessional({
      userId: inactive.userId,
      name: inactive.name,
    });
    await linkMembership({
      userId: inactive.userId,
      professionalId: inactiveProf,
      institutionId: tenant.institutionId,
      active: false,
    });
    await expect(
      resolveCanonicalOperationalActorForUser({ userId: inactive.userId }),
    ).resolves.toEqual({
      ok: false,
      code: "ACTOR_INSTITUTION_MEMBERSHIP_NOT_FOUND",
    });
  });

  it("17. instituição inativa não entra no actor", async () => {
    const dead = await makeTenant("dead", false);
    const live = await makeTenant("live");
    const { userId, name } = await makeUser({ label: "dead-inst" });
    const professionalId = await makeProfessional({ userId, name });
    await linkMembership({
      userId,
      professionalId,
      institutionId: dead.institutionId,
    });
    await expect(
      resolveCanonicalOperationalActorForUser({ userId }),
    ).resolves.toEqual({
      ok: false,
      code: "ACTOR_INSTITUTION_MEMBERSHIP_NOT_FOUND",
    });
    await linkMembership({
      userId,
      professionalId,
      institutionId: live.institutionId,
    });
    await expect(
      resolveCanonicalOperationalActorForUser({ userId }),
    ).resolves.toEqual({
      ok: true,
      actor: {
        userId,
        professionalId,
        institutionIds: [live.institutionId],
      },
    });
  });

  it("18. manager_scope sozinho não cria tenant", async () => {
    const home = await makeTenant("home-m");
    const foreign = await makeTenant("foreign-m");
    const { userId, name } = await makeUser({ label: "scope-only" });
    const professionalId = await makeProfessional({
      userId,
      name,
      userRole: "GESTOR_MEDICO",
    });
    await grantScope({
      professionalId,
      institutionId: foreign.institutionId,
      hospitalId: foreign.hospitalId,
      sectorId: null,
    });
    await expect(
      resolveCanonicalOperationalActorForUser({ userId }),
    ).resolves.toEqual({
      ok: false,
      code: "ACTOR_INSTITUTION_MEMBERSHIP_NOT_FOUND",
    });
    await linkMembership({
      userId,
      professionalId,
      institutionId: home.institutionId,
      roleInInstitution: "GESTOR_MEDICO",
    });
    const result = await resolveCanonicalOperationalActorForUser({ userId });
    expect(result).toEqual({
      ok: true,
      actor: {
        userId,
        professionalId,
        institutionIds: [home.institutionId],
      },
    });
  });

  it("19. professional_access sozinho não cria tenant; hospital-wide não duplica", async () => {
    const home = await makeTenant("home-a");
    const foreign = await makeTenant("foreign-a");
    const { userId, name } = await makeUser({ label: "acl-only" });
    const professionalId = await makeProfessional({ userId, name });
    await grantAccess({
      professionalId,
      institutionId: foreign.institutionId,
      hospitalId: foreign.hospitalId,
      sectorId: foreign.sectorId,
    });
    await expect(
      resolveCanonicalOperationalActorForUser({ userId }),
    ).resolves.toEqual({
      ok: false,
      code: "ACTOR_INSTITUTION_MEMBERSHIP_NOT_FOUND",
    });
    await linkMembership({
      userId,
      professionalId,
      institutionId: home.institutionId,
    });
    await grantAccess({
      professionalId,
      institutionId: home.institutionId,
      hospitalId: home.hospitalId,
      sectorId: null,
    });
    await grantAccess({
      professionalId,
      institutionId: home.institutionId,
      hospitalId: home.hospitalId,
      sectorId: home.sectorId,
    });
    const result = await resolveCanonicalOperationalActorForUser({ userId });
    expect(result).toEqual({
      ok: true,
      actor: {
        userId,
        professionalId,
        institutionIds: [home.institutionId],
      },
    });
  });

  it("20. role sozinho não cria tenant", async () => {
    const { userId } = await makeUser({ label: "role-only", role: "admin" });
    await expect(
      resolveCanonicalOperationalActorForUser({ userId }),
    ).resolves.toEqual({ ok: false, code: "ACTOR_PROFESSIONAL_NOT_FOUND" });
  });

  it("21. mesmo nome de setor em outro tenant é irrelevante", async () => {
    const home = await makeTenant("uti-home");
    await makeTenant("uti-other");
    const { userId, name } = await makeUser({ label: "sector-name" });
    const professionalId = await makeProfessional({ userId, name });
    await linkMembership({
      userId,
      professionalId,
      institutionId: home.institutionId,
    });
    const result = await resolveCanonicalOperationalActorForUser({ userId });
    expect(result).toEqual({
      ok: true,
      actor: {
        userId,
        professionalId,
        institutionIds: [home.institutionId],
      },
    });
  });

  it("paridade: mesmo user/estado → mesmo professionalId e mesmo conjunto de tenants que listActive", async () => {
    const one = await makeTenant("par-a");
    const two = await makeTenant("par-b");
    const { userId, name } = await makeUser({ label: "parity" });
    const professionalId = await makeProfessional({ userId, name });
    await linkMembership({
      userId,
      professionalId,
      institutionId: two.institutionId,
      isPrimary: true,
    });
    await linkMembership({
      userId,
      professionalId,
      institutionId: one.institutionId,
    });
    const result = await resolveCanonicalOperationalActorForUser({ userId });
    const sessionIds = await listActiveInstitutionIdsForUser(userId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actor.professionalId).toBe(professionalId);
    expect([...result.actor.institutionIds].sort((a, b) => a - b)).toEqual(
      [...sessionIds].sort((a, b) => a - b),
    );
  });

  it("B2-B alimenta resolveSwapIntent sem adapter if source === WHATSAPP", async () => {
    const tenant = await makeTenant("feed");
    const { userId, name } = await makeUser({ label: "feed-nl" });
    const professionalId = await makeProfessional({ userId, name });
    await linkMembership({
      userId,
      professionalId,
      institutionId: tenant.institutionId,
    });
    const result = await resolveCanonicalOperationalActorForUser({ userId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const actor: SwapIntentActor = result.actor;
    const parsed = parseSwapIntent(
      "quero passar meu plantão de amanhã à noite para a Débora",
    );
    expect("kind" in parsed).toBe(true);
    if ("ok" in parsed) throw new Error(`parser falhou: ${parsed.code}`);
    const resolved = await resolveSwapIntent(parsed, actor, {
      now: new Date("2026-09-09T15:00:00Z"),
    });
    expect(resolved).toHaveProperty("ok");
    expect(JSON.stringify(resolved)).not.toMatch(/WHATSAPP|source ===/);
  });

  it("28-30. output mínimo sem PII; logs só event/userId/resultCode/institutionCount/professionalId", async () => {
    const tenant = await makeTenant("pii");
    const secretName = `Maria Silva CPF 529.982.247-25 tel +5585999123456 ${stamp}`;
    const secretEmail = `maria.silva.${stamp}@hospital.example`;
    const secretPhone = "+5585999123456";
    const { userId } = await makeUser({
      label: "pii",
      name: secretName,
      email: secretEmail,
    });
    const professionalId = await makeProfessional({
      userId,
      name: secretName,
    });
    await linkMembership({
      userId,
      professionalId,
      institutionId: tenant.institutionId,
    });

    const lines: string[] = [];
    const spy = vi.spyOn(logger, "info").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((value) => String(value)).join(" "));
      return logger;
    });
    const result = await resolveCanonicalOperationalActorForUser({ userId });
    spy.mockRestore();

    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secretName);
    expect(serialized).not.toContain(secretEmail);
    expect(serialized).not.toContain(secretPhone);
    expect(serialized).not.toContain("529.982.247-25");
    expect(serialized).not.toMatch(/telefone|pushToken|passwordHash|address/i);
    expect(serialized).not.toContain("GESTOR_PLUS");
    if (!result.ok) return;
    expect(Object.keys(result).sort()).toEqual(["actor", "ok"]);
    expect(Object.keys(result.actor).sort()).toEqual([
      "institutionIds",
      "professionalId",
      "userId",
    ]);

    const joined = lines.join("\n");
    expect(joined).not.toContain(secretName);
    expect(joined).not.toContain(secretEmail);
    expect(joined).not.toContain(secretPhone);
    expect(joined).not.toContain("quero passar");
    const payload = JSON.parse(lines.find((line) => line.includes("canonical_operational_actor_resolved")) ?? "{}");
    expect(payload).toMatchObject({
      event: "canonical_operational_actor_resolved",
      userId,
      resultCode: "OK",
      institutionCount: 1,
      professionalId,
    });
    expect(Object.keys(payload).sort()).toEqual([
      "event",
      "institutionCount",
      "professionalId",
      "resultCode",
      "userId",
    ]);
  });
});
