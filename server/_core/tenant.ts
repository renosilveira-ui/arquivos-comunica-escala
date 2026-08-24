import { and, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { hospitals, professionalInstitutions, professionals, sectors } from "../../drizzle/schema";
import { getDb } from "../db";

type HierarchyDb = Pick<NonNullable<Awaited<ReturnType<typeof getDb>>>, "select">;

/**
 * Confirma a hierarquia institucional antes de qualquer decisão de RBAC.
 *
 * As FKs do schema validam cada ID isoladamente, mas não garantem que o
 * hospital pertença à instituição nem que o setor pertença ao mesmo par
 * instituição/hospital. A função não devolve booleano: incerteza ou
 * incoerência sempre interrompem o fluxo.
 */
export async function assertInstitutionHierarchy(
  input: Readonly<{
    institutionId: number;
    hospitalId: number;
    sectorId?: number | null;
  }>,
  options: { db?: HierarchyDb } = {},
): Promise<void> {
  const db = options.db ?? (await getDb());
  if (!db) throw new Error("Database not available");

  const invalidHierarchy = () =>
    new TRPCError({
      code: "FORBIDDEN",
      message: "Hospital ou setor fora da jurisdição do tenant ativo",
    });

  if (typeof input.sectorId === "number") {
    const [row] = await db
      .select({ hospitalId: hospitals.id, sectorId: sectors.id })
      .from(hospitals)
      .innerJoin(
        sectors,
        and(
          eq(sectors.id, input.sectorId),
          eq(sectors.hospitalId, hospitals.id),
          eq(sectors.institutionId, hospitals.institutionId),
        ),
      )
      .where(
        and(
          eq(hospitals.id, input.hospitalId),
          eq(hospitals.institutionId, input.institutionId),
        ),
      )
      .limit(1);

    if (!row) throw invalidHierarchy();
    return;
  }

  const [hospital] = await db
    .select({ id: hospitals.id })
    .from(hospitals)
    .where(
      and(
        eq(hospitals.id, input.hospitalId),
        eq(hospitals.institutionId, input.institutionId),
      ),
    )
    .limit(1);

  if (!hospital) throw invalidHierarchy();
}

export function parseTenantIdHeader(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

export async function listActiveInstitutionIdsForUser(userId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db
    .select({ institutionId: professionalInstitutions.institutionId })
    .from(professionalInstitutions)
    .innerJoin(
      professionals,
      and(
        eq(professionals.id, professionalInstitutions.professionalId),
        eq(professionals.userId, professionalInstitutions.userId),
      ),
    )
    .where(
      and(
        eq(professionalInstitutions.userId, userId),
        eq(professionalInstitutions.active, true),
      ),
    );

  return Array.from(new Set(rows.map((r) => r.institutionId)));
}

export async function resolveInstitutionForUser(
  userId: number,
  requestedTenantId: number | null,
): Promise<{ institutionId: number; allowedInstitutionIds: number[] }> {
  const allowedInstitutionIds = await listActiveInstitutionIdsForUser(userId);

  if (allowedInstitutionIds.length === 0) {
    throw new Error("Usuário sem vínculo institucional ativo");
  }

  if (requestedTenantId !== null) {
    if (!allowedInstitutionIds.includes(requestedTenantId)) {
      throw new Error("Tenant inválido para o usuário autenticado");
    }
    return { institutionId: requestedTenantId, allowedInstitutionIds };
  }

  return {
    institutionId: allowedInstitutionIds[0],
    allowedInstitutionIds,
  };
}
