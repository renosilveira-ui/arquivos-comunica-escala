// server/sso/duty-sync.ts — Fase 1 da integração: o Escala DECLARA o
// plantonista no Comunica+ (substitui a pergunta "você é o plantonista?"
// para quem está na escala oficial).
//
// Quando o médico confirma presença (ou é auto-confirmado / substituto
// aceita), enviamos CONFIRM para POST /api/integrations/duty-roster do
// Comunica+ — que grava na mesma tabela da auto-declaração, com
// source "ESCALA". Recusa → WITHDRAW.
//
// Auth: JWT RS256 assinado com a MESMA chave do SSO de handoff
// (o Comunica+ valida pela JWKS que já consome), com scope "duty:sync"
// e jti de uso único. Sem senha compartilhada.
//
// Falhas aqui NUNCA quebram o fluxo de confirmação: fire-and-forget
// com log — o plantão confirmado no Escala é a fonte de verdade e o
// Comunica+ pode ser reconciliado depois.

import { SignJWT } from "jose";
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { getPrivateKey, KID, ALG } from "./keys";
import { getComunicaOrgId } from "./org-mapping";
import { getDb } from "../db";
import { dutyConfirmations, shiftInstances, users } from "../../drizzle/schema";
import { ENV } from "../_core/env";

const TOKEN_TTL_SEC = 90;

export type DutySyncAction = "CONFIRM" | "WITHDRAW";

interface DutySyncResult {
  ok: boolean;
  error?: string;
}

/**
 * Sincroniza o estado de plantonista de uma duty_confirmation do Escala
 * com o roster do Comunica+.
 *
 * CONFIRM  → médico vira plantonista declarado no Comunica+.
 * WITHDRAW → declaração retirada (recusa / troca aceita por outro).
 */
export async function syncDutyToComunica(
  confirmationId: number,
  action: DutySyncAction,
): Promise<DutySyncResult> {
  const db = await getDb();
  if (!db) return { ok: false, error: "Database unavailable" };

  const [conf] = await db
    .select()
    .from(dutyConfirmations)
    .where(eq(dutyConfirmations.id, confirmationId))
    .limit(1);
  if (!conf) return { ok: false, error: "Confirmation not found" };

  const organizationId = getComunicaOrgId(conf.institutionId);
  if (!organizationId) {
    // Instituição sem ponte SSO — nada a sincronizar.
    return { ok: false, error: "Instituição sem mapeamento SSO" };
  }

  // Substituto confirmado assume o lugar do original no roster.
  const targetUserId = conf.replacementUserId ?? conf.userId;
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);
  if (!user?.email) return { ok: false, error: "Usuário sem email" };

  const [shift] = await db
    .select({
      startAt: shiftInstances.startAt,
      endAt: shiftInstances.endAt,
      modality: shiftInstances.modality,
    })
    .from(shiftInstances)
    .where(eq(shiftInstances.id, conf.shiftInstanceId))
    .limit(1);
  if (!shift) return { ok: false, error: "Shift não encontrado" };

  const now = Math.floor(Date.now() / 1000);
  const privateKey = await getPrivateKey();
  const token = await new SignJWT({
    scope: "duty:sync",
    organizationId,
    email: user.email,
    action,
    dutyType: shift.modality === "SOBREAVISO" ? "SOBREAVISO" : "PLANTAO",
    dutyStart: new Date(shift.startAt).toISOString(),
    dutyEnd: new Date(shift.endAt).toISOString(),
  })
    .setProtectedHeader({ alg: ALG, kid: KID, typ: "JWT" })
    .setIssuer(ENV.ssoIssuer)
    .setAudience(ENV.ssoAudience)
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setExpirationTime(now + TOKEN_TTL_SEC)
    .sign(privateKey);

  try {
    const res = await fetch(`${ENV.ssoTargetUrl}/api/integrations/duty-roster`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({}),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[DutySync] Comunica+ retornou ${res.status} para ${action} conf=${confirmationId}: ${body.slice(0, 200)}`);
      return { ok: false, error: `Comunica+ retornou ${res.status}` };
    }

    console.log(`[DutySync] ${action} ok — conf=${confirmationId} user=${targetUserId}`);
    return { ok: true };
  } catch (err) {
    console.error(`[DutySync] ${action} falhou (rede):`, (err as Error).message);
    return { ok: false, error: (err as Error).message };
  }
}
