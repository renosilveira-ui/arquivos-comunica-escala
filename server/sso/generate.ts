// server/sso/generate.ts — Generate SSO handoff token for Comunica+
import { SignJWT } from "jose";
import { randomUUID } from "crypto";
import { getPrivateKey, KID, ALG } from "./keys";
import { resolveActiveDuty, type DutyResolution } from "./duty-resolver";
import { getComunicaOrgId } from "./org-mapping";
import { getDb } from "../db";
import { ssoUsedTokens } from "../../drizzle/schema";
import { ENV } from "../_core/env";
import type { User } from "../../drizzle/schema";
import { recordAudit } from "../audit-trail";

const TOKEN_TTL_SEC = 90;

interface GenerateInput {
  user: User;
  institutionId: number;
  clientNonce: string;
  roleInInstitution: string;
}

export interface GenerateResult {
  ok: true;
  handoffToken: string;
  targetUrl: string;
  dutyContext: DutyResolution;
}

export interface GenerateError {
  ok: false;
  code: "no_active_duty" | "context_conflict" | "org_not_mapped" | "internal_error";
  message: string;
}

export async function generateHandoffToken(
  input: GenerateInput,
): Promise<GenerateResult | GenerateError> {
  const { user, institutionId, clientNonce, roleInInstitution } = input;

  // 1. Resolve Comunica+ organization ID
  const comunicaOrgId = getComunicaOrgId(institutionId);
  if (!comunicaOrgId) {
    return {
      ok: false,
      code: "org_not_mapped",
      message: "Instituição não mapeada para o Comunica+. Contate o administrador.",
    };
  }

  // 2. Resolve active duty
  const dutyResolution = await resolveActiveDuty(user.id, institutionId);

  if (!dutyResolution.duty) {
    return {
      ok: false,
      code: "no_active_duty",
      message: "Você não tem plantão ou sobreaviso ativo no momento. Login automático indisponível.",
    };
  }

  if (dutyResolution.contextConflict) {
    return {
      ok: false,
      code: "context_conflict",
      message: "Múltiplos plantões ativos detectados. Selecione o contexto antes de continuar.",
    };
  }

  const duty = dutyResolution.duty;

  // 3. Generate JWT
  const jti = randomUUID();
  const now = Math.floor(Date.now() / 1000);

  const privateKey = await getPrivateKey();

  const handoffToken = await new SignJWT({
    sub: String(user.id),
    externalId: `escala:user:${user.id}`,
    email: user.email ?? undefined,
    name: user.name ?? undefined,
    organizationId: comunicaOrgId,
    externalOrganizationId: String(institutionId),
    roles: [roleInInstitution],
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

  // 4. Persist jti for anti-replay (Escala side)
  try {
    const db = await getDb();
    if (db) {
      await db.insert(ssoUsedTokens).values({
        jti,
        sub: String(user.id),
        tenantKey: comunicaOrgId,
        institutionId,
        expiresAt: new Date((now + TOKEN_TTL_SEC) * 1000),
      });
    }
  } catch (err) {
    console.warn("[SSO] Failed to persist jti:", err);
  }

  // 5. Audit
  recordAudit({
    action: "SSO_JIT_LINK_CREATED",
    entityType: "USER",
    entityId: user.id,
    actorUserId: user.id,
    actorRole: user.role,
    actorName: user.name ?? undefined,
    institutionId,
    description: `SSO handoff token gerado para ${user.email} → Comunica+ (${duty.dutyType}, ${duty.serviceName})`,
    metadata: { jti, dutyType: duty.dutyType, serviceName: duty.serviceName, comunicaOrgId },
  });

  return {
    ok: true,
    handoffToken,
    targetUrl: `${ENV.ssoTargetUrl}/auth/sso/exchange`,
    dutyContext: dutyResolution,
  };
}
