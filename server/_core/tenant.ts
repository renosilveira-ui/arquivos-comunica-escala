import { and, eq } from "drizzle-orm";
import { professionalInstitutions } from "../../drizzle/schema";
import { getDb } from "../db";

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
