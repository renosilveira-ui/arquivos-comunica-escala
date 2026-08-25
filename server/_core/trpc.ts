import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from "../../shared/const.js";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";
import { parseTenantIdHeader, resolveInstitutionForUser } from "./tenant";
import { SessionInstanceConstraintError } from "./session-instance";
import { AuthenticationInfrastructureError } from "./sdk";
import { ExpectedUserConstraintError } from "./expected-user";

/** Mensagem de erro que vaza detalhes do driver (SQL, códigos MySQL) não vai para o cliente. */
export function isDriverErrorMessage(message: string): boolean {
  return /Failed query|sqlMessage|ER_[A-Z_]+|errno:|ECONNREFUSED|ETIMEDOUT|PROTOCOL_/.test(
    message,
  );
}

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    if (
      error.code === "INTERNAL_SERVER_ERROR" &&
      isDriverErrorMessage(error.message)
    ) {
      console.error(
        "[tRPC] erro interno mascarado:",
        JSON.stringify(error.message.slice(0, 300)),
      );
      return {
        ...shape,
        message: "Erro interno no servidor. Tente novamente em instantes.",
      };
    }
    return shape;
  },
});

export const router = t.router;
export const publicProcedure = t.procedure;

export function sessionInstanceConstraintHttpStatus(
  errors: readonly TRPCError[],
): number | undefined {
  const authenticationInfrastructureFailure = errors
    .map((error) => error.cause)
    .find(
      (cause): cause is AuthenticationInfrastructureError =>
        cause instanceof AuthenticationInfrastructureError,
    );
  if (authenticationInfrastructureFailure) return 503;
  const expectedUserConstraintFailure = errors
    .map((error) => error.cause)
    .find(
      (cause): cause is ExpectedUserConstraintError =>
        cause instanceof ExpectedUserConstraintError,
    );
  if (expectedUserConstraintFailure)
    return expectedUserConstraintFailure.status;
  return errors
    .map((error) => error.cause)
    .find(
      (cause): cause is SessionInstanceConstraintError =>
        cause instanceof SessionInstanceConstraintError,
    )?.status;
}

function throwAuthenticationInfrastructure(
  error: AuthenticationInfrastructureError | null | undefined,
): void {
  if (!error) return;
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "Infraestrutura de autenticação indisponível",
    cause: error,
  });
}

function throwSessionInstanceConstraint(
  error: SessionInstanceConstraintError | null | undefined,
): void {
  if (!error) return;
  const code =
    error.status === 400
      ? "BAD_REQUEST"
      : error.status === 409
        ? "CONFLICT"
        : "PRECONDITION_FAILED";
  throw new TRPCError({ code, message: error.message, cause: error });
}

function throwExpectedUserConstraint(
  error: ExpectedUserConstraintError | null | undefined,
): void {
  if (!error) return;
  throw new TRPCError({
    code: error.status === 400 ? "BAD_REQUEST" : "CONFLICT",
    message: error.message,
    cause: error,
  });
}

/**
 * Fronteira estreita para recuperação da allowlist institucional.
 *
 * A sessão já foi validada pelo SDK (inclusive sessionVersion), mas este
 * middleware deliberadamente não lê, resolve nem aceita tenant. Usá-lo em
 * recursos tenant-bound criaria bypass. Seus únicos usos são a allowlist de
 * recuperação e o ownership conta/dispositivo do token push; nenhum deles
 * lê ou muta recurso institucional.
 */
const requireSession = t.middleware(async ({ ctx, next }) => {
  throwAuthenticationInfrastructure(ctx.authenticationInfrastructureError);
  throwExpectedUserConstraint(ctx.expectedUserConstraintError);
  throwSessionInstanceConstraint(ctx.sessionInstanceConstraintError);
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const sessionProcedure = t.procedure.use(requireSession);

const requireUser = t.middleware(async (opts) => {
  const { ctx, next } = opts;

  throwAuthenticationInfrastructure(ctx.authenticationInfrastructureError);
  throwExpectedUserConstraint(ctx.expectedUserConstraintError);
  throwSessionInstanceConstraint(ctx.sessionInstanceConstraintError);
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  if (ctx.tenantResolutionError) {
    const messageByCode = {
      MALFORMED_TENANT_HEADER: "Tenant informado é inválido",
      TENANT_NOT_ALLOWED: "Tenant inválido para o usuário autenticado",
      NO_ACTIVE_MEMBERSHIP: "Usuário sem vínculo institucional ativo",
      AMBIGUOUS_PROFESSIONAL: "Vínculo profissional institucional ambíguo",
    } satisfies Record<NonNullable<typeof ctx.tenantResolutionError>, string>;
    throw new TRPCError({
      code: "FORBIDDEN",
      message: messageByCode[ctx.tenantResolutionError],
    });
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

    throwAuthenticationInfrastructure(ctx.authenticationInfrastructureError);
    throwExpectedUserConstraint(ctx.expectedUserConstraintError);
    throwSessionInstanceConstraint(ctx.sessionInstanceConstraintError);
    if (!ctx.user) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
    }
    if (ctx.user.role !== "admin") {
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
