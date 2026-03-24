import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { User } from "../../drizzle/schema";
import { sdk } from "./sdk";
import { parseTenantIdHeader, resolveInstitutionForUser } from "./tenant";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
  institutionId: number | null;
  allowedInstitutionIds: number[];
};

export async function createContext(opts: CreateExpressContextOptions): Promise<TrpcContext> {
  let user: User | null = null;
  let institutionId: number | null = null;
  let allowedInstitutionIds: number[] = [];

  try {
    user = await sdk.authenticateRequest(opts.req);
  } catch {
    // Authentication is optional for public procedures.
    user = null;
  }

  if (user) {
    const tenantHeader = parseTenantIdHeader(opts.req.headers["x-tenant-id"]);
    const tenant = await resolveInstitutionForUser(user.id, tenantHeader);
    institutionId = tenant.institutionId;
    allowedInstitutionIds = tenant.allowedInstitutionIds;
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
    institutionId,
    allowedInstitutionIds,
  };
}
