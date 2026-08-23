import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from "../../shared/const.js";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { parseTenantIdHeader, resolveInstitutionForUser } from "./tenant";

/** Mensagem de erro que vaza detalhes do driver (SQL, códigos MySQL) não vai para o cliente. */
export function isDriverErrorMessage(message: string): boolean {
  return /Failed query|sqlMessage|ER_[A-Z_]+|errno:|ECONNREFUSED|ETIMEDOUT|PROTOCOL_/.test(message);
}

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    if (error.code === "INTERNAL_SERVER_ERROR" && isDriverErrorMessage(error.message)) {
      console.error("[tRPC] erro interno mascarado:", JSON.stringify(error.message.slice(0, 300)));
      return { ...shape, message: "Erro interno no servidor. Tente novamente em instantes." };
    }
    return shape;
  },
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
