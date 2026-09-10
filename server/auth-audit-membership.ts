import { and, asc, desc, eq } from "drizzle-orm";
import {
  institutions,
  professionalInstitutions,
  professionals,
} from "../drizzle/schema";
import type { getDb } from "./db";

export class AuthMutationError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 409,
    message: string,
  ) {
    super(message);
  }
}

export type AuditMembershipSnapshot = {
  membershipId: number;
  professionalId: number;
  institutionId: number;
  isPrimary: boolean;
};

type AuthAuditQueryDb = Pick<
  NonNullable<Awaited<ReturnType<typeof getDb>>>,
  "select"
>;

/** Resolve uma topologia institucional canônica para auditoria de credencial. */
export async function readCanonicalAuditMembership(
  db: AuthAuditQueryDb,
  userId: number,
  options: { allowInactive?: boolean } = {},
): Promise<AuditMembershipSnapshot | null> {
  const [membership] = await db
    .select({
      membershipId: professionalInstitutions.id,
      professionalId: professionals.id,
      institutionId: professionalInstitutions.institutionId,
      isPrimary: professionalInstitutions.isPrimary,
    })
    .from(professionalInstitutions)
    .innerJoin(
      professionals,
      and(
        eq(professionals.id, professionalInstitutions.professionalId),
        eq(professionals.userId, professionalInstitutions.userId),
      ),
    )
    .innerJoin(
      institutions,
      and(
        eq(institutions.id, professionalInstitutions.institutionId),
        eq(institutions.isActive, true),
      ),
    )
    .where(
      and(
        eq(professionalInstitutions.userId, userId),
        options.allowInactive
          ? undefined
          : eq(professionalInstitutions.active, true),
      ),
    )
    .orderBy(
      desc(professionalInstitutions.active),
      desc(professionalInstitutions.isPrimary),
      asc(professionalInstitutions.id),
    )
    .limit(1);
  return membership ?? null;
}

/** Ordem global: user já travado → professional → PI → institution. */
export async function lockCanonicalAuditMembership(
  db: AuthAuditQueryDb,
  userId: number,
  expected: AuditMembershipSnapshot,
  options: { allowInactive?: boolean } = {},
): Promise<AuditMembershipSnapshot> {
  const [professional] = await db
    .select({ id: professionals.id, userId: professionals.userId })
    .from(professionals)
    .where(eq(professionals.id, expected.professionalId))
    .limit(1)
    .for("update");
  const [membership] = professional
    ? await db
        .select({
          membershipId: professionalInstitutions.id,
          professionalId: professionalInstitutions.professionalId,
          userId: professionalInstitutions.userId,
          institutionId: professionalInstitutions.institutionId,
          isPrimary: professionalInstitutions.isPrimary,
          active: professionalInstitutions.active,
        })
        .from(professionalInstitutions)
        .where(eq(professionalInstitutions.id, expected.membershipId))
        .limit(1)
        .for("update")
    : [];
  const [institution] = membership
    ? await db
        .select({ id: institutions.id })
        .from(institutions)
        .where(
          and(
            eq(institutions.id, expected.institutionId),
            eq(institutions.isActive, true),
          ),
        )
        .limit(1)
        .for("share")
    : [];

  if (
    professional?.userId !== userId ||
    !membership ||
    membership.professionalId !== expected.professionalId ||
    membership.userId !== userId ||
    membership.institutionId !== expected.institutionId ||
    membership.isPrimary !== expected.isPrimary ||
    (!options.allowInactive && !membership.active) ||
    !institution
  ) {
    throw new AuthMutationError(
      409,
      "Vínculo institucional canônico mudou durante a operação; tente novamente",
    );
  }

  return expected;
}
