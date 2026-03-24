import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from "../../shared/const.js";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { parseTenantIdHeader, resolveInstitutionForUser } from "./tenant";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

const requireUser = t.middleware(async (opts) => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  let institutionId = ctx.institutionId;
  let allowedInstitutionIds = ctx.allowedInstitutionIds;

  if (!institutionId) {
    const tenantHeader = parseTenantIdHeader(ctx.req?.headers?.["x-tenant-id"]);
    try {
      const tenant = await resolveInstitutionForUser(ctx.user.id, tenantHeader);
      institutionId = tenant.institutionId;
      allowedInstitutionIds = tenant.allowedInstitutionIds;
    } catch (error) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: (error as Error).message || "Sem vínculo institucional ativo",
      });
    }
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
      institutionId,
      allowedInstitutionIds,
    },
  });
});

export const protectedProcedure = t.procedure.use(requireUser);

export const adminProcedure = t.procedure.use(
  t.middleware(async (opts) => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== "admin") {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);
