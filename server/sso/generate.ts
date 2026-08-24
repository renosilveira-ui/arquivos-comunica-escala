// server/sso/generate.ts — Generate SSO handoff token for Comunica+
import { SignJWT } from "jose";
import { randomUUID } from "crypto";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { getPrivateKey, KID, ALG } from "./keys";
import {
  assertDutyAuthoritySnapshotForIssuance,
  DutyAuthorityChangedError,
  resolveActiveDuty,
  type DutyAuthoritySnapshot,
  type DutyResolution,
} from "./duty-resolver";
import { getComunicaOrgId } from "./org-mapping";
import { getDb } from "../db";
import {
  institutions,
  professionalInstitutions,
  professionals,
  ssoUsedTokens,
  users,
} from "../../drizzle/schema";
import { ENV } from "../_core/env";
import type { User } from "../../drizzle/schema";
import { recordAudit } from "../audit-trail";
import { resolveTenantActor, type InstitutionRole } from "../_core/policy";
import { resolveTrustedSsoTargetUrl } from "./url-policy";

const TOKEN_TTL_SEC = 90;

interface GenerateInput {
  user: Pick<User, "id" | "name" | "email" | "role" | "sessionVersion">;
  institutionId: number;
  clientNonce: string;
}

type GenerateDependencies = Readonly<{
  createJti: () => string;
  beforeIssuanceTransaction: () => Promise<void>;
}>;

const DEFAULT_GENERATE_DEPENDENCIES: GenerateDependencies = {
  createJti: randomUUID,
  beforeIssuanceTransaction: async () => undefined,
};

export class SsoAuthorityError extends Error {}

export type CanonicalSsoActor = {
  user: Pick<User, "id" | "name" | "email" | "role" | "sessionVersion">;
  professionalId: number;
  membershipId: number;
  roleInInstitution: InstitutionRole;
};

/**
 * Reconstrói a identidade SSO a partir da tupla canônica completa. O papel
 * recebido por um caller nunca entra no token: PI, professional, user e
 * institution precisam concordar no estado vivo.
 */
export async function resolveCanonicalSsoActor(
  userId: number,
  institutionId: number,
  expectedSessionVersion?: number,
): Promise<CanonicalSsoActor> {
  let tenantActor;
  try {
    tenantActor = await resolveTenantActor(userId, institutionId, false);
  } catch (error) {
    if (error instanceof TRPCError && error.code === "FORBIDDEN") {
      throw new SsoAuthorityError("Identidade institucional inválida");
    }
    throw error;
  }

  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const [canonical] = await db
    .select({
      userId: users.id,
      userName: users.name,
      userEmail: users.email,
      globalRole: users.role,
      sessionVersion: users.sessionVersion,
      professionalId: professionals.id,
      membershipId: professionalInstitutions.id,
      roleInInstitution: professionalInstitutions.roleInInstitution,
      institutionId: institutions.id,
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
      users,
      and(
        eq(users.id, professionalInstitutions.userId),
        eq(users.approvalStatus, "APPROVED"),
        isNull(users.deletedAt),
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
        eq(professionalInstitutions.institutionId, institutionId),
        eq(professionalInstitutions.professionalId, tenantActor.professionalId!),
        eq(professionalInstitutions.active, true),
      ),
    )
    .limit(1);

  if (
    !canonical ||
    canonical.userId !== userId ||
    canonical.institutionId !== institutionId ||
    canonical.professionalId !== tenantActor.professionalId ||
    canonical.roleInInstitution !== tenantActor.roleInInstitution ||
    (expectedSessionVersion !== undefined &&
      canonical.sessionVersion !== expectedSessionVersion)
  ) {
    throw new SsoAuthorityError("Identidade institucional ou sessão inválida");
  }

  return {
    user: {
      id: canonical.userId,
      name: canonical.userName,
      email: canonical.userEmail,
      role: canonical.globalRole,
      sessionVersion: canonical.sessionVersion,
    },
    professionalId: canonical.professionalId,
    membershipId: canonical.membershipId,
    roleInInstitution: canonical.roleInInstitution,
  };
}

export interface GenerateResult {
  ok: true;
  handoffToken: string;
  targetUrl: string;
  dutyContext: DutyResolution;
}

export interface GenerateError {
  ok: false;
  code:
    | "no_active_duty"
    | "context_conflict"
    | "org_not_mapped"
    | "invalid_input"
    | "authority_invalid"
    | "internal_error";
  message: string;
}

export async function generateHandoffToken(
  input: GenerateInput,
  dependencies: Partial<GenerateDependencies> = DEFAULT_GENERATE_DEPENDENCIES,
): Promise<GenerateResult | GenerateError> {
  const { user: authenticatedUser, institutionId } = input;
  const clientNonce = input.clientNonce.trim();
  if (!clientNonce || clientNonce.length > 191) {
    return {
      ok: false,
      code: "invalid_input",
      message: "clientNonce deve ter entre 1 e 191 caracteres.",
    };
  }

  // 1. Resolve Comunica+ organization ID
  const comunicaOrgId = getComunicaOrgId(institutionId);
  if (!comunicaOrgId) {
    return {
      ok: false,
      code: "org_not_mapped",
      message: "Instituição não mapeada para o Comunica+. Contate o administrador.",
    };
  }
  const targetBaseUrl = resolveTrustedSsoTargetUrl();
  if (!targetBaseUrl) {
    console.error("[SSO] SSO_TARGET_URL ausente ou invalida; handoff bloqueado");
    return {
      ok: false,
      code: "internal_error",
      message: "Login automatico indisponivel por configuracao invalida.",
    };
  }

  let canonical: CanonicalSsoActor;
  let dutyResolution: DutyResolution;
  let dutySnapshot: DutyAuthoritySnapshot;
  let handoffToken: string;
  let jti: string;
  const now = Math.floor(Date.now() / 1000);
  try {
    // 2. Revalidate current identity and resolve only a canonical official duty.
    canonical = await resolveCanonicalSsoActor(
      authenticatedUser.id,
      institutionId,
      authenticatedUser.sessionVersion,
    );
    dutyResolution = await resolveActiveDuty({
      userId: canonical.user.id,
      institutionId,
      professionalId: canonical.professionalId,
    });

    if (dutyResolution.contextConflict) {
      return {
        ok: false,
        code: "context_conflict",
        message: "Múltiplos plantões ativos detectados. Selecione o contexto antes de continuar.",
      };
    }

    if (!dutyResolution.duty || !dutyResolution.authoritySnapshot) {
      return {
        ok: false,
        code: "no_active_duty",
        message: "Você não tem plantão ou sobreaviso ativo no momento. Login automático indisponível.",
      };
    }

    dutySnapshot = dutyResolution.authoritySnapshot;
    if (
      dutySnapshot.userId !== canonical.user.id ||
      dutySnapshot.professionalId !== canonical.professionalId ||
      dutySnapshot.membershipId !== canonical.membershipId ||
      dutySnapshot.sessionVersion !== canonical.user.sessionVersion ||
      dutySnapshot.userName !== canonical.user.name ||
      dutySnapshot.userEmail !== canonical.user.email ||
      dutySnapshot.userRole !== canonical.user.role ||
      dutySnapshot.roleInInstitution !== canonical.roleInInstitution
    ) {
      throw new SsoAuthorityError("Identidade mudou durante a pre-validacao");
    }

    const duty = dutyResolution.duty;
    jti = (dependencies.createJti ?? DEFAULT_GENERATE_DEPENDENCIES.createJti)();
    const privateKey = await getPrivateKey();
    handoffToken = await new SignJWT({
      sub: String(canonical.user.id),
      externalId: `escala:user:${canonical.user.id}`,
      email: canonical.user.email ?? undefined,
      name: canonical.user.name ?? undefined,
      organizationId: comunicaOrgId,
      externalOrganizationId: String(institutionId),
      roles: [canonical.roleInInstitution],
      dutyType: duty.dutyType,
      serviceName: duty.serviceName,
      sectorId: duty.sectorRef ?? String(duty.sectorId),
      dutyStart: duty.dutyStart,
      dutyEnd: duty.dutyEnd,
      activeDutyCount: dutyResolution.activeDutyCount,
      contextConflict: false,
      scope: "sso:login",
      nonce: clientNonce,
    })
      .setProtectedHeader({ alg: ALG, kid: KID, typ: "JWT" })
      .setIssuer(ENV.ssoIssuer)
      .setAudience(ENV.ssoAudience)
      .setJti(jti)
      .setIssuedAt(now)
      .setExpirationTime(now + TOKEN_TTL_SEC)
      .sign(privateKey);
  } catch (error) {
    if (error instanceof SsoAuthorityError) {
      return {
        ok: false,
        code: "authority_invalid",
        message: "Identidade institucional ou sessão inválida para login automático.",
      };
    }
    console.error("[SSO] HANDOFF_VALIDATION_OR_SIGNING_FAILED");
    return {
      ok: false,
      code: "internal_error",
      message: "Não foi possível gerar o login automático. Tente novamente.",
    };
  }

  const duty = dutyResolution.duty;

  // 4. Persist issuance proof and audit atomically. Signing happens first,
  // but the token is never returned unless both durable writes commit.
  try {
    await (dependencies.beforeIssuanceTransaction ??
      DEFAULT_GENERATE_DEPENDENCIES.beforeIssuanceTransaction)();
    const db = await getDb();
    if (!db) {
      throw new Error("Database unavailable");
    }

    await db.transaction(async (tx) => {
      await assertDutyAuthoritySnapshotForIssuance(tx, dutySnapshot);

      await tx.insert(ssoUsedTokens).values({
        jti,
        sub: String(canonical.user.id),
        tenantKey: comunicaOrgId,
        institutionId,
        expiresAt: new Date((now + TOKEN_TTL_SEC) * 1000),
      });

      await recordAudit(
        {
          action: "SSO_JIT_LINK_CREATED",
          entityType: "USER",
          entityId: canonical.user.id,
          actorUserId: canonical.user.id,
          actorRole: canonical.roleInInstitution,
          actorName: canonical.user.name ?? undefined,
          institutionId,
          description: `SSO handoff token gerado para usuário #${canonical.user.id} → Comunica+ (${duty.dutyType}, ${duty.serviceName})`,
          metadata: { jti, dutyType: duty.dutyType, serviceName: duty.serviceName, comunicaOrgId },
        },
        { db: tx, strict: true },
      );
    }, { isolationLevel: "read committed" });
  } catch (err) {
    if (err instanceof DutyAuthorityChangedError) {
      return {
        ok: false,
        code: "authority_invalid",
        message: "A autoridade do plantao mudou durante o login automatico.",
      };
    }
    console.error("[SSO] HANDOFF_PERSISTENCE_FAILED");
    return {
      ok: false,
      code: "internal_error",
      message: "Não foi possível gerar o login automático. Tente novamente.",
    };
  }

  return {
    ok: true,
    handoffToken,
    targetUrl: `${targetBaseUrl}/auth/sso/exchange`,
    dutyContext: dutyResolution,
  };
}
