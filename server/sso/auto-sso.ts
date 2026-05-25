// server/sso/auto-sso.ts — Auto-SSO server-to-server para confirmação de presença
//
// Quando o médico confirma o plantão (ou é auto-confirmado), este módulo:
// 1. Gera o handoff token JWT RS256 (reutiliza generate.ts)
// 2. Chama POST /auth/sso/exchange no Comunica+ (server-to-server, JSON)
// 3. Armazena a sessão resultante para deep link posterior
//
// O médico recebe push com deep link → abre Comunica+ já com sessão ativa.

import { generateHandoffToken } from "./generate";
import { getDb } from "../db";
import { eq, and } from "drizzle-orm";
import {
  users,
  professionals,
  professionalInstitutions,
  dutyConfirmations,
} from "../../drizzle/schema";
import { ENV } from "../_core/env";
import { sendPushNotification } from "../notifications-service";

interface AutoSsoResult {
  ok: boolean;
  error?: string;
  accessToken?: string;
}

/**
 * Executes server-to-server SSO handoff for a confirmed duty.
 * Called after confirm/auto-confirm.
 */
export async function triggerAutoSso(
  confirmationId: number,
): Promise<AutoSsoResult> {
  const db = await getDb();
  if (!db) return { ok: false, error: "Database unavailable" };

  // 1. Load confirmation + user details
  const [conf] = await db
    .select()
    .from(dutyConfirmations)
    .where(eq(dutyConfirmations.id, confirmationId))
    .limit(1);

  if (!conf) return { ok: false, error: "Confirmation not found" };

  // Determine the actual user to log in (replacement or original)
  const targetUserId = conf.replacementUserId ?? conf.userId;

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);

  if (!user) return { ok: false, error: "User not found" };

  // 2. Get role in institution
  let roleInInstitution = "USER";
  const [link] = await db
    .select({ roleInInstitution: professionalInstitutions.roleInInstitution })
    .from(professionalInstitutions)
    .where(
      and(
        eq(professionalInstitutions.userId, targetUserId),
        eq(professionalInstitutions.institutionId, conf.institutionId),
        eq(professionalInstitutions.active, true),
      ),
    )
    .limit(1);
  if (link) roleInInstitution = link.roleInInstitution;

  // 3. Generate handoff token
  const clientNonce = `auto-sso-${conf.id}-${Date.now()}`;
  const result = await generateHandoffToken({
    user,
    institutionId: conf.institutionId,
    clientNonce,
    roleInInstitution,
  });

  if (!result.ok) {
    console.warn(`[AutoSSO] Failed to generate token for userId=${targetUserId}: ${result.message}`);
    return { ok: false, error: result.message };
  }

  // 4. Exchange with Comunica+ (server-to-server, JSON)
  try {
    const exchangeRes = await fetch(result.targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        handoffToken: result.handoffToken,
        handoffMethod: "BACKEND_TOKEN_EXCHANGE",
        clientNonce,
        sourceApp: "ESCALAS_BACKEND",
        responseMode: "json",
      }),
    });

    if (!exchangeRes.ok) {
      const body = await exchangeRes.text().catch(() => "");
      console.warn(`[AutoSSO] Comunica+ exchange failed: ${exchangeRes.status} ${body}`);
      return { ok: false, error: `Comunica+ retornou ${exchangeRes.status}` };
    }

    const exchangeData = await exchangeRes.json() as {
      ok: boolean;
      session?: { accessToken: string };
    };

    if (!exchangeData.ok || !exchangeData.session?.accessToken) {
      return { ok: false, error: "Resposta SSO inválida" };
    }

    // 5. Mark SSO as triggered
    await db
      .update(dutyConfirmations)
      .set({ ssoTriggeredAt: new Date() })
      .where(eq(dutyConfirmations.id, confirmationId));

    // 6. Send push with deep link to open Comunica+
    const comunicaBaseUrl = ENV.ssoTargetUrl;
    await sendPushNotification(targetUserId, {
      title: "Logado no Comunica+",
      body: "Seu login automático no Comunica+ foi realizado. Toque para abrir.",
      data: {
        type: "sso_ready",
        comunicaUrl: comunicaBaseUrl,
        shiftInstanceId: conf.shiftInstanceId,
      },
    });

    console.log(`[AutoSSO] Success for userId=${targetUserId}, confirmation=${confirmationId}`);
    return { ok: true, accessToken: exchangeData.session.accessToken };
  } catch (err) {
    console.error(`[AutoSSO] Exchange error:`, err);
    return { ok: false, error: (err as Error).message };
  }
}
