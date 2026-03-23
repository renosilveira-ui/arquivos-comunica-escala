import { and, eq, isNull, or } from "drizzle-orm";
import {
  professionalAccess,
  professionalInstitutions,
  professionals,
} from "../../drizzle/schema";

type DbClient = any;

type ShiftScope = {
  institutionId: number;
  hospitalId: number;
  sectorId: number;
};

/**
 * Resolve the best professional vínculo for a user in the context of a shift.
 * Priorities:
 * 1) Same institution + access to hospital/sector
 * 2) Any institution + access to hospital/sector (legacy fallback)
 */
export async function resolveProfessionalForShift(
  db: DbClient,
  userId: number,
  scope: ShiftScope,
) {
  const candidatesSameInstitution = await db
    .select({
      id: professionals.id,
      userId: professionals.userId,
      institutionId: professionalInstitutions.institutionId,
      name: professionals.name,
      role: professionals.role,
      userRole: professionals.userRole,
    })
    .from(professionals)
    .innerJoin(
      professionalInstitutions,
      and(
        eq(professionalInstitutions.professionalId, professionals.id),
        eq(professionalInstitutions.userId, professionals.userId),
      ),
    )
    .innerJoin(professionalAccess, eq(professionalAccess.professionalId, professionals.id))
    .where(
      and(
        eq(professionals.userId, userId),
        eq(professionalInstitutions.institutionId, scope.institutionId),
        eq(professionalInstitutions.active, true),
        eq(professionalAccess.institutionId, scope.institutionId),
        eq(professionalAccess.hospitalId, scope.hospitalId),
        eq(professionalAccess.canAccess, true),
        or(eq(professionalAccess.sectorId, scope.sectorId), isNull(professionalAccess.sectorId)),
      ),
    );

  if (candidatesSameInstitution.length > 0) {
    return candidatesSameInstitution[0];
  }

  const legacyFallback = await db
    .select({
      id: professionals.id,
      userId: professionals.userId,
      institutionId: professionalInstitutions.institutionId,
      name: professionals.name,
      role: professionals.role,
      userRole: professionals.userRole,
    })
    .from(professionals)
    .innerJoin(
      professionalInstitutions,
      and(
        eq(professionalInstitutions.professionalId, professionals.id),
        eq(professionalInstitutions.userId, professionals.userId),
      ),
    )
    .innerJoin(professionalAccess, eq(professionalAccess.professionalId, professionals.id))
    .where(
      and(
        eq(professionals.userId, userId),
        eq(professionalInstitutions.active, true),
        eq(professionalAccess.hospitalId, scope.hospitalId),
        eq(professionalAccess.institutionId, professionalInstitutions.institutionId),
        eq(professionalAccess.canAccess, true),
        or(eq(professionalAccess.sectorId, scope.sectorId), isNull(professionalAccess.sectorId)),
      ),
    );

  return legacyFallback[0] ?? null;
}

export async function listProfessionalIdsByUser(
  db: DbClient,
  userId: number,
  institutionId: number,
): Promise<number[]> {
  const rows = await db
    .select({ id: professionals.id })
    .from(professionals)
    .innerJoin(
      professionalInstitutions,
      and(
        eq(professionalInstitutions.professionalId, professionals.id),
        eq(professionalInstitutions.userId, professionals.userId),
      ),
    )
    .where(
      and(
        eq(professionals.userId, userId),
        eq(professionalInstitutions.institutionId, institutionId),
        eq(professionalInstitutions.active, true),
      ),
    );

  return rows.map((r: { id: number }) => r.id);
}
