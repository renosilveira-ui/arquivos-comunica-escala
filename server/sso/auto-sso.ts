// server/sso/auto-sso.ts — Push de SSO após confirmação de presença
//
// Histórico: a versão original fazia um exchange server-to-server com o
// Comunica+ e descartava o accessToken — a sessão nascia e morria no
// servidor, e o médico caía na tela de login. O login de verdade
// acontece agora no dispositivo, via launch-code (server/sso/launch.ts):
// o app, ao receber o push type=sso_ready, pede um código one-time e
// abre o browser em /api/sso/launch, que completa o handoff.
//
// Este módulo hoje: valida que a instituição está mapeada no Comunica+
// e envia o push que dispara esse fluxo no toque.

import { getDb } from "../db";
import { eq } from "drizzle-orm";
import { dutyConfirmations } from "../../drizzle/schema";
import { hasMappingFor } from "./org-mapping";
import { ENV } from "../_core/env";
import { sendPushNotification } from "../notifications-service";
import { requireValidDutyConfirmation } from "../confirmation-integrity";

interface AutoSsoResult {
  ok: boolean;
  error?: string;
}

/**
 * Sends the "open Comunica+ logged in" push for a confirmed duty.
 * Called after confirm/auto-confirm/replacement-accept.
 */
export async function triggerAutoSso(
  confirmationId: number,
): Promise<AutoSsoResult> {
  const db = await getDb();
  if (!db) return { ok: false, error: "Database unavailable" };

  let valid;
  try {
    valid = await requireValidDutyConfirmation(db, confirmationId, {
      allowedStatuses: ["CONFIRMED", "AUTO_CONFIRMED", "REPLACEMENT_CONFIRMED"],
      requireOriginalAssignmentActive: false,
      requireEffectiveAssignment: true,
    });
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  const conf = valid.confirmation;

  // Instituição sem mapeamento no Comunica+ → não há SSO possível;
  // não enviar push que levaria a um beco sem saída.
  if (!hasMappingFor(conf.institutionId)) {
    console.warn(
      `[AutoSSO] institution ${conf.institutionId} sem SSO_ORG_MAP — push suprimido`,
    );
    return { ok: false, error: "Instituição sem mapeamento SSO" };
  }

  // Substituto confirmado recebe o push no lugar do original.
  const targetUserId = valid.effective.userId;

  await sendPushNotification(targetUserId, {
    title: "Plantão confirmado",
    body: "Toque para abrir o Comunica+ já logado no seu plantão.",
    data: {
      type: "sso_ready",
      comunicaUrl: ENV.ssoTargetUrl, // fallback se o launch-code falhar
      shiftInstanceId: valid.shift.id,
    },
  });

  await db
    .update(dutyConfirmations)
    .set({ ssoTriggeredAt: new Date() })
    .where(eq(dutyConfirmations.id, confirmationId));

  console.log(
    `[AutoSSO] Push sso_ready enviado para userId=${targetUserId}, confirmation=${confirmationId}`,
  );
  return { ok: true };
}
