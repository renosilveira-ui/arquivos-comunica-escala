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
import { and, eq, inArray, isNull } from "drizzle-orm";
import { dutyConfirmations } from "../../drizzle/schema";
import { hasMappingFor } from "./org-mapping";
import { resolveTrustedSsoTargetUrl } from "./url-policy";
import {
  enqueueTrackedPushNotification,
  sendTrackedPushNotification,
  type TrackedPushInput,
} from "../push-delivery";
import {
  dutyShiftSnapshot,
  requireValidDutyConfirmation,
} from "../confirmation-integrity";

interface AutoSsoResult {
  ok: boolean;
  error?: string;
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type AutoSsoOutboxDb = Pick<Db, "insert" | "select" | "update">;

/**
 * Persiste o sso_ready no mesmo commit da confirmação. `null` significa que
 * a instituição não possui integração configurada; qualquer outra falha é
 * estrutural e deve abortar a transação chamadora.
 */
export async function enqueueAutoSsoPush(
  confirmationId: number,
  now = new Date(),
  dbOverride?: AutoSsoOutboxDb,
): Promise<TrackedPushInput | null> {
  const db = dbOverride ?? await getDb();
  if (!db) throw new Error("Database unavailable");
  const valid = await requireValidDutyConfirmation(db, confirmationId, {
    allowedStatuses: ["CONFIRMED", "REPLACEMENT_CONFIRMED"],
    requireOriginalAssignmentActive: false,
    requireEffectiveAssignment: true,
    // Chamadores transacionais já seguem shift → assignment → confirmation;
    // a releitura corrente impede que o outbox herde label/horários/identidade
    // de um snapshot RR anterior. O caminho avulso será revalidado pelo worker.
    lockForUpdate: dbOverride !== undefined,
  });
  if (!hasMappingFor(valid.confirmation.institutionId)) {
    console.warn(
      `[AutoSSO] institution ${valid.confirmation.institutionId} sem SSO_ORG_MAP — push suprimido`,
    );
    return null;
  }
  if (!resolveTrustedSsoTargetUrl()) {
    console.warn(
      `[AutoSSO] institution ${valid.confirmation.institutionId} com SSO_TARGET_URL inválida — push suprimido`,
    );
    return null;
  }

  const targetUserId = valid.effective.userId;
  const intent: TrackedPushInput = {
    institutionId: valid.shift.institutionId,
    userId: targetUserId,
    shiftInstanceId: valid.shift.id,
    dedupKey: `duty-confirmation:${confirmationId}:sso-ready:${targetUserId}`,
    payload: {
      title: "Plantão confirmado",
      body: "Toque para abrir o Comunica+ já logado no seu plantão.",
      data: {
        type: "sso_ready",
        confirmationId,
        institutionId: valid.shift.institutionId,
        shiftInstanceId: valid.shift.id,
      },
    },
    authority: {
      kind: "DUTY_CONFIRMATION",
      purpose: "SSO_READY",
      confirmationId,
      allowedStatuses: ["CONFIRMED", "REPLACEMENT_CONFIRMED"],
      recipientKind: "EFFECTIVE",
      expectedUserId: targetUserId,
      shiftSnapshot: dutyShiftSnapshot(valid.shift),
    },
  };
  await enqueueTrackedPushNotification(intent, now, db);
  return intent;
}

/**
 * Sends the "open Comunica+ logged in" push for a confirmed duty.
 * Called only after an explicit confirmation or replacement acceptance.
 */
export async function triggerAutoSso(
  confirmationId: number,
): Promise<AutoSsoResult> {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>> | null;
  try {
    db = await getDb();
  } catch {
    return { ok: false, error: "Serviço SSO temporariamente indisponível" };
  }
  if (!db) return { ok: false, error: "Database unavailable" };

  let intent: TrackedPushInput | null;
  try {
    intent = await enqueueAutoSsoPush(confirmationId, new Date());
  } catch {
    return { ok: false, error: "Não foi possível preparar o login automático" };
  }
  if (!intent) {
    return { ok: false, error: "Integração SSO indisponível para esta instituição" };
  }

  const now = new Date();
  let tracked;
  try {
    tracked = await sendTrackedPushNotification(
      intent,
      now,
    );
  } catch {
    return { ok: false, error: "Push SSO persistido para retry" };
  }

  if (!tracked.ticketAccepted) {
    return {
      ok: false,
      error: "Push SSO persistido para retry; ticket ainda não aceito pelo Expo",
    };
  }

  let updated: { affectedRows: number };
  try {
    [updated] = await db
      .update(dutyConfirmations)
      .set({ ssoTriggeredAt: now })
      .where(
        and(
          eq(dutyConfirmations.id, confirmationId),
          inArray(dutyConfirmations.status, ["CONFIRMED", "REPLACEMENT_CONFIRMED"]),
          isNull(dutyConfirmations.ssoTriggeredAt),
        ),
      );
  } catch {
    return { ok: false, error: "Não foi possível registrar o login automático" };
  }

  if (updated.affectedRows !== 1) {
    let current: { ssoTriggeredAt: Date | null } | undefined;
    try {
      [current] = await db
        .select({ ssoTriggeredAt: dutyConfirmations.ssoTriggeredAt })
        .from(dutyConfirmations)
        .where(eq(dutyConfirmations.id, confirmationId))
        .limit(1);
    } catch {
      return { ok: false, error: "Não foi possível validar o login automático" };
    }
    if (!current?.ssoTriggeredAt) {
      return { ok: false, error: "Confirmação mudou antes do registro do push SSO" };
    }
  }

  console.log(
    `[AutoSSO] Expo ticket aceito para sso_ready userId=${intent.userId}, confirmation=${confirmationId}`,
  );
  return { ok: true };
}
