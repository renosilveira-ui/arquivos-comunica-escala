import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { professionalInstitutions, type User } from "../../drizzle/schema";
import { getDb } from "../db";
import { sdk } from "./sdk";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: User | null;
  institutionId: number | null;
};

export async function createContext(opts: CreateExpressContextOptions): Promise<TrpcContext> {
  let user: User | null = null;
  let institutionId: number | null = null;

  try {
    user = await sdk.authenticateRequest(opts.req);
  } catch (error) {
    // Authentication is optional for public procedures.
    user = null;
  }

  if (user) {
    const db = await getDb();
    if (db) {
      const links = await db
        .select({
          institutionId: professionalInstitutions.institutionId,
          isPrimary: professionalInstitutions.isPrimary,
        })
        .from(professionalInstitutions)
        .where(
          and(
            eq(professionalInstitutions.userId, user.id),
            eq(professionalInstitutions.active, true),
          ),
        );

      const tenantHeaderRaw = opts.req.headers["x-tenant-id"];
      const tenantHeader = Array.isArray(tenantHeaderRaw)
        ? tenantHeaderRaw[0]
        : tenantHeaderRaw;
      const requestedTenantId = tenantHeader ? Number(tenantHeader) : null;

      if (
        tenantHeader &&
        (!Number.isInteger(requestedTenantId) || Number(requestedTenantId) <= 0)
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Header x-tenant-id inválido",
        });
      }

      if (requestedTenantId) {
        const hasLink = links.some((l) => l.institutionId === requestedTenantId);
        if (!hasLink) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Usuário sem vínculo ao tenant informado",
          });
        }
        institutionId = requestedTenantId;
      } else if (links.length === 1) {
        institutionId = links[0]!.institutionId;
      } else {
        institutionId = null;
      }
    }
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
    institutionId,
  };
}
