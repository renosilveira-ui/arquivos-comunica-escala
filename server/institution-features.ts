import { and, eq } from "drizzle-orm";
import { institutionFeatureEntitlements } from "../drizzle/schema";
import {
  INSTITUTION_FEATURE_CODES,
  ROSTER_READ_POLICIES,
  type InstitutionFeatureCode,
  type RosterReadPolicy,
} from "../lib/institution-features";
import { getDb } from "./db";

type InstitutionFeatureDb = Pick<
  NonNullable<Awaited<ReturnType<typeof getDb>>>,
  "select"
>;

export type InstitutionFeatureEntitlementSnapshot = {
  id: number;
  institutionId: number;
  featureCode: string;
  enabled: boolean;
  source: "LEGACY_COMPATIBILITY" | "ADMIN_OVERRIDE" | "COMMERCIAL_PACKAGE";
  version: number;
  updatedByUserId: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export async function readInstitutionFeatureEntitlement(
  db: InstitutionFeatureDb,
  institutionId: number,
  featureCode: InstitutionFeatureCode,
  options: { lockForUpdate?: boolean } = {},
): Promise<InstitutionFeatureEntitlementSnapshot | null> {
  const baseQuery = db
    .select({
      id: institutionFeatureEntitlements.id,
      institutionId: institutionFeatureEntitlements.institutionId,
      featureCode: institutionFeatureEntitlements.featureCode,
      enabled: institutionFeatureEntitlements.enabled,
      source: institutionFeatureEntitlements.source,
      version: institutionFeatureEntitlements.version,
      updatedByUserId: institutionFeatureEntitlements.updatedByUserId,
      createdAt: institutionFeatureEntitlements.createdAt,
      updatedAt: institutionFeatureEntitlements.updatedAt,
    })
    .from(institutionFeatureEntitlements)
    .where(
      and(
        eq(institutionFeatureEntitlements.institutionId, institutionId),
        eq(institutionFeatureEntitlements.featureCode, featureCode),
      ),
    )
    .limit(2);
  const rows = options.lockForUpdate
    ? await baseQuery.for("update")
    : await baseQuery;
  if (rows.length > 1) {
    throw new Error(
      `Entitlement duplicado para institutionId=${institutionId}, featureCode=${featureCode}`,
    );
  }
  return rows[0] ?? null;
}

export function resolveRosterReadPolicyFromEntitlement(
  entitlement: Pick<
    InstitutionFeatureEntitlementSnapshot,
    "institutionId" | "featureCode" | "enabled"
  > | null,
  institutionId: number,
): RosterReadPolicy {
  if (
    entitlement?.institutionId === institutionId &&
    entitlement.featureCode ===
      INSTITUTION_FEATURE_CODES.crossScheduleRosterView &&
    entitlement.enabled === true
  ) {
    return ROSTER_READ_POLICIES.institutionWide;
  }
  return ROSTER_READ_POLICIES.authorizedContextsOnly;
}

export async function loadInstitutionRosterReadPolicy(
  institutionId: number,
  db?: InstitutionFeatureDb,
): Promise<RosterReadPolicy> {
  const database = db ?? (await getDb());
  if (!database) throw new Error("Database not available");
  const entitlement = await readInstitutionFeatureEntitlement(
    database,
    institutionId,
    INSTITUTION_FEATURE_CODES.crossScheduleRosterView,
  );
  return resolveRosterReadPolicyFromEntitlement(entitlement, institutionId);
}
