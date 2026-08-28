import { and, eq, inArray } from "drizzle-orm";
import {
  hospitals,
  managerScope,
  sectors,
} from "../drizzle/schema";
import {
  managerScopesRequiredForRole,
  normalizeManagerScopes,
  type InstitutionRoleForScope,
  type ManagerScopeDraft,
} from "../lib/manager-scope-admin";

export class ManagerScopeAdminError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    message: string,
  ) {
    super(message);
  }
}

type ScopeWriteDb = {
  select: (...args: never[]) => unknown;
  insert: (...args: never[]) => unknown;
  update: (...args: never[]) => unknown;
};

export async function loadActiveManagerScopes(
  db: {
    select: Function;
  },
  input: { institutionId: number; professionalIds: number[] },
): Promise<Map<number, ManagerScopeDraft[]>> {
  const out = new Map<number, ManagerScopeDraft[]>();
  if (input.professionalIds.length === 0) return out;
  const rows = await db
    .select({
      professionalId: managerScope.managerProfessionalId,
      hospitalId: managerScope.hospitalId,
      sectorId: managerScope.sectorId,
    })
    .from(managerScope)
    .where(
      and(
        eq(managerScope.institutionId, input.institutionId),
        inArray(managerScope.managerProfessionalId, input.professionalIds),
        eq(managerScope.active, true),
      ),
    );
  for (const row of rows as {
    professionalId: number;
    hospitalId: number;
    sectorId: number | null;
  }[]) {
    const list = out.get(row.professionalId) ?? [];
    list.push({ hospitalId: row.hospitalId, sectorId: row.sectorId });
    out.set(row.professionalId, list);
  }
  for (const [id, list] of out) {
    out.set(id, normalizeManagerScopes(list));
  }
  return out;
}

export async function listTenantHospitalsAndSectors(
  db: { select: Function },
  institutionId: number,
): Promise<{
  hospitals: { id: number; name: string }[];
  sectors: { id: number; name: string; hospitalId: number }[];
}> {
  const hospitalRows = await db
    .select({ id: hospitals.id, name: hospitals.name })
    .from(hospitals)
    .where(eq(hospitals.institutionId, institutionId));
  const sectorRows = await db
    .select({
      id: sectors.id,
      name: sectors.name,
      hospitalId: sectors.hospitalId,
    })
    .from(sectors)
    .where(eq(sectors.institutionId, institutionId));
  return {
    hospitals: hospitalRows as { id: number; name: string }[],
    sectors: sectorRows as { id: number; name: string; hospitalId: number }[],
  };
}

export async function resolveManagerScopesForRole(input: {
  db: { select: Function };
  institutionId: number;
  role: InstitutionRoleForScope;
  requested: ManagerScopeDraft[] | undefined;
  existing: ManagerScopeDraft[];
}): Promise<ManagerScopeDraft[]> {
  if (input.role === "USER") {
    return [];
  }
  if (input.requested !== undefined) {
    await assertScopesBelongToTenant(input.db, input.institutionId, input.requested);
    if (managerScopesRequiredForRole(input.role) && input.requested.length === 0) {
      throw new ManagerScopeAdminError(
        400,
        "Selecione o hospital que este gestor opera. Sem isso ele não abre o calendário.",
      );
    }
    return input.requested;
  }
  if (input.role === "GESTOR_PLUS") {
    return input.existing;
  }
  if (input.existing.length > 0) {
    return input.existing;
  }
  const catalog = await listTenantHospitalsAndSectors(input.db, input.institutionId);
  if (catalog.hospitals.length === 0) {
    throw new ManagerScopeAdminError(
      400,
      "Cadastre um hospital nesta instituição antes de definir o gestor da escala.",
    );
  }
  if (catalog.hospitals.length === 1) {
    return [{ hospitalId: catalog.hospitals[0].id, sectorId: null }];
  }
  throw new ManagerScopeAdminError(
    400,
    "Selecione o hospital que este gestor opera. Sem isso ele não abre o calendário.",
  );
}

async function assertScopesBelongToTenant(
  db: { select: Function },
  institutionId: number,
  scopes: ManagerScopeDraft[],
): Promise<void> {
  if (scopes.length === 0) return;
  const catalog = await listTenantHospitalsAndSectors(db, institutionId);
  const hospitalIds = new Set(catalog.hospitals.map((row) => row.id));
  const sectorsByHospital = new Map<number, Set<number>>();
  for (const sector of catalog.sectors) {
    const set = sectorsByHospital.get(sector.hospitalId) ?? new Set<number>();
    set.add(sector.id);
    sectorsByHospital.set(sector.hospitalId, set);
  }
  for (const scope of scopes) {
    if (!hospitalIds.has(scope.hospitalId)) {
      throw new ManagerScopeAdminError(
        400,
        "Hospital do escopo não pertence a esta instituição.",
      );
    }
    if (scope.sectorId != null) {
      const sectorsOfHospital = sectorsByHospital.get(scope.hospitalId);
      if (!sectorsOfHospital?.has(scope.sectorId)) {
        throw new ManagerScopeAdminError(
          400,
          "Setor do escopo não pertence a este hospital.",
        );
      }
    }
  }
}

export async function replaceManagerScopesForProfessional(
  tx: ScopeWriteDb,
  input: {
    institutionId: number;
    professionalId: number;
    scopes: ManagerScopeDraft[];
  },
): Promise<void> {
  await (tx as { update: Function })
    .update(managerScope)
    .set({ active: false })
    .where(
      and(
        eq(managerScope.institutionId, input.institutionId),
        eq(managerScope.managerProfessionalId, input.professionalId),
        eq(managerScope.active, true),
      ),
    );
  for (const scope of input.scopes) {
    await (tx as { insert: Function }).insert(managerScope).values({
      institutionId: input.institutionId,
      managerProfessionalId: input.professionalId,
      hospitalId: scope.hospitalId,
      sectorId: scope.sectorId,
      active: true,
    });
  }
}
