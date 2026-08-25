import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { AuthenticationInfrastructureError, sdk } from "./sdk";
import { parseTenantIdHeader } from "./tenant";
import { SessionInstanceConstraintError } from "./session-instance";

export type TenantResolutionErrorCode =
  | "MALFORMED_TENANT_HEADER"
  | "TENANT_NOT_ALLOWED"
  | "NO_ACTIVE_MEMBERSHIP"
  | "AMBIGUOUS_PROFESSIONAL";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
  institutionId: number | null;
  allowedInstitutionIds: number[];
  tenantProfessionalId?: number | null;
  tenantResolutionError?: TenantResolutionErrorCode | null;
  sessionInstanceConstraintError?: SessionInstanceConstraintError | null;
  authenticationInfrastructureError?: AuthenticationInfrastructureError | null;
};

export async function createContext(
  opts: CreateExpressContextOptions,
): Promise<TrpcContext> {
  let user: User | null = null;
  let institutionId: number | null = null;
  let allowedInstitutionIds: number[] = [];
  let tenantProfessionalId: number | null = null;
  let tenantResolutionError: TenantResolutionErrorCode | null = null;
  let sessionInstanceConstraintError: SessionInstanceConstraintError | null =
    null;
  let authenticationInfrastructureError: AuthenticationInfrastructureError | null =
    null;

  try {
    const authenticated = await sdk.authenticateRequestWithActiveMemberships(
      opts.req,
    );
    user = authenticated.user;

    const rawTenantHeader = opts.req.headers["x-tenant-id"];
    const requestedTenantId = parseTenantIdHeader(rawTenantHeader);
    if (rawTenantHeader !== undefined && requestedTenantId === null) {
      tenantResolutionError = "MALFORMED_TENANT_HEADER";
    } else {
      const membershipsByInstitution = new Map<number, Set<number>>();
      for (const membership of authenticated.activeMemberships) {
        const professionalsForInstitution =
          membershipsByInstitution.get(membership.institutionId) ??
          new Set<number>();
        professionalsForInstitution.add(membership.professionalId);
        membershipsByInstitution.set(
          membership.institutionId,
          professionalsForInstitution,
        );
      }

      const activeInstitutionIds = Array.from(membershipsByInstitution.keys());
      if (activeInstitutionIds.length === 0) {
        tenantResolutionError = "NO_ACTIVE_MEMBERSHIP";
      } else if (
        requestedTenantId !== null &&
        !membershipsByInstitution.has(requestedTenantId)
      ) {
        tenantResolutionError = "TENANT_NOT_ALLOWED";
      } else {
        const selectedInstitutionId =
          requestedTenantId ?? activeInstitutionIds[0];
        const professionalIds = membershipsByInstitution.get(
          selectedInstitutionId,
        )!;
        if (professionalIds.size !== 1) {
          tenantResolutionError = "AMBIGUOUS_PROFESSIONAL";
        } else {
          institutionId = selectedInstitutionId;
          allowedInstitutionIds = activeInstitutionIds;
          tenantProfessionalId = professionalIds.values().next().value ?? null;
        }
      }
    }
  } catch (error) {
    // Authentication is optional for public procedures.
    user = null;
    tenantResolutionError = null;
    sessionInstanceConstraintError =
      error instanceof SessionInstanceConstraintError ? error : null;
    authenticationInfrastructureError =
      error instanceof AuthenticationInfrastructureError ? error : null;
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
    institutionId,
    allowedInstitutionIds,
    tenantProfessionalId,
    tenantResolutionError,
    sessionInstanceConstraintError,
    authenticationInfrastructureError,
  };
}
