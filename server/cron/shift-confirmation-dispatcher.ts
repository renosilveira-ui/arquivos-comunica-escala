// server/cron/shift-confirmation-dispatcher.ts
//
// Cron / CLI one-shot. A cada tick descobre assignments OCUPADOS cujo
// pedido de confirmação já venceu (dueAt = startAt - lead) e o plantão
// ainda não começou. Não usa gatilho 11/17/22 nem janela de 20 min.
// Lead: server/cron/confirmation-due.ts.
//
// Também executa a rechecagem +30min. Silêncio nunca confirma presença:
// prazo vencido mantém a escala intacta e abre alerta para decisão humana.

import { createHash, randomUUID } from "crypto";
import { TRPCError } from "@trpc/server";
import {
  and,
  eq,
  getTableName,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  or,
} from "drizzle-orm";
import { logger } from "../_core/logger";
import { safeErrorDiagnostic } from "../_core/safe-error";
import { getDb } from "../db";
import {
  dutyConfirmations,
  hospitals,
  institutions,
  managerScope as managerScopeTable,
  professionalInstitutions,
  professionals,
  scheduleContexts,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../../drizzle/schema";
import { plantonistaAccessCoversShiftSql } from "../plantonista-shift-eligibility";
import {
  HOSPITAL_TIME_ZONE,
  confirmationDiscoveryStartAtRange,
  isDueForConfirmation,
} from "./confirmation-due";
import {
  dutyShiftSnapshot,
  isCanonicalDutyConfirmationRejection,
  requireValidDutyConfirmation,
} from "../confirmation-integrity";
import {
  clearDutyConfirmationRecheckIfCurrent,
  dutyConfirmationCasIdentity,
} from "../confirmation-state";
import {
  enqueueTrackedPushNotification,
  processPendingPushDeliveries,
  sendTrackedPushNotification,
  TrackedIntentCollisionError,
  findTrackedNotificationByDedupKey as findTrackedNotificationByDedupKeyRaw,
} from "../push-delivery";
import { processPendingDutySyncs } from "../sso/duty-sync";
import { resolveTrustedSsoTargetUrl } from "../sso/url-policy";
import { processPendingComunicaPlusOutbox } from "../integrations/comunica-plus";
import { isConfirmationRouteToken } from "../../lib/confirmation-route-params";

const RECHECK_DELAY_MS = 30 * 60 * 1000; // 30 minutes

function isDuplicateEntry(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && (error as { code?: unknown }).code === "ER_DUP_ENTRY")
    return true;
  return (
    "cause" in error && isDuplicateEntry((error as { cause?: unknown }).cause)
  );
}

// ── Main tick (called every ~60s) ───────────────────────────────────────────

let running = false;
/**
 * O tick em andamento, para o shutdown esperar. Sem isto, o SIGTERM do
 * deploy cortava a escalação entre o CAS do recheck e o outbox — o timer
 * sumia e ninguém era avisado.
 */
let activeTick: Promise<void> | null = null;

/**
 * Falhas consecutivas por etapa, para a espera crescente.
 *
 * Módulo-escopo de propósito: morre com o processo, como a própria fila de
 * timers. Não é estado de negócio.
 */
const consecutiveFailures = new Map<string, number>();
const skipUntilMs = new Map<string, number>();

/** Teto da espera. Meia hora é o bastante para parar de machucar o banco. */
const MAX_BACKOFF_MS = 30 * 60_000;

/** Somente para teste: zera a espera entre cenários. */
export function resetConfirmationBackoff(): void {
  consecutiveFailures.clear();
  skipUntilMs.clear();
}

/**
 * Roda uma etapa isolada das demais, com espera crescente quando falha.
 *
 * **Isolamento.** As quatro etapas do tick são independentes: rechecagem,
 * retentativa de push, fila do Comunica+ e aviso de início de plantão não
 * dependem umas das outras. Encadeá-las com `await` fazia a primeira falha
 * matar as três seguintes — o subsistema inteiro parava por causa de uma
 * etapa, e o log dizia só "TICK_FAILED".
 *
 * **Espera crescente.** Uma etapa que falha de forma permanente e é repetida
 * a cada 60 s não se conserta sozinha: só consome conexão e toma lock. Em
 * 11/09 isso derrubou a alocação de um gestor com `ER_LOCK_DEADLOCK`. Depois
 * de falhas seguidas, a etapa recua até meia hora.
 *
 * Recuar atrasa alertas clínicos — e é o certo mesmo assim: a etapa já não
 * estava entregando nada, e insistir estava fazendo mal ao que funcionava.
 */
async function runStep(
  name: string,
  now: Date,
  step: () => Promise<unknown>,
): Promise<void> {
  const skipUntil = skipUntilMs.get(name) ?? 0;
  if (now.getTime() < skipUntil) return;

  try {
    await step();
    if (consecutiveFailures.get(name)) {
      logger.info(
        { event: "confirmation_step_recovered", step: name },
        "[ConfirmationCron] step recovered",
      );
    }
    consecutiveFailures.delete(name);
    skipUntilMs.delete(name);
  } catch (error) {
    const failures = (consecutiveFailures.get(name) ?? 0) + 1;
    consecutiveFailures.set(name, failures);
    const waitMs = Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** (failures - 1));
    skipUntilMs.set(name, now.getTime() + waitMs);
    logger.error(
      {
        event: "confirmation_step_failed",
        step: name,
        consecutiveFailures: failures,
        retryInSeconds: Math.round(waitMs / 1000),
        ...safeErrorDiagnostic(error),
      },
      "[ConfirmationCron] step failed",
    );
  }
}

/**
 * Devolve a MESMA promise do trabalho em andamento (não um wrapper): é o que
 * `stopConfirmationCron` entrega ao shutdown, e um tick concorrente recebe
 * a mesma, em vez de disparar um segundo processamento.
 */
export function tick(now: Date = new Date()): Promise<void> {
  // Ticks concorrentes (tick longo + setInterval) processavam a mesma
  // confirmação duas vezes.
  if (running) return activeTick ?? Promise.resolve();
  running = true;
  let work!: Promise<void>;
  work = (async () => {
    try {
      await runTickSteps(now);
    } finally {
      running = false;
      if (activeTick === work) activeTick = null;
    }
  })();
  activeTick = work;
  return work;
}

async function runTickSteps(now: Date): Promise<void> {
  // 1. Discovery due-based: catch-up de assignment tardio, swap,
  // publicação tardia e restart. Idempotente (unique assignment_id).
  await runStep("dispatchConfirmations", now, () =>
    dispatchConfirmations(now),
  );

  // 2. Persiste e conquista por CAS as escalações vencidas. O worker roda
  // depois: se o CAS perder para uma decisão humana, a autoridade de status
  // do outbox suprime o alerta obsoleto antes da rede.
  await runStep("processRechecks", now, () => processRechecks(now));

  // 2b. Terminal: o plantão terminou e ninguém respondeu. Encerra sem
  // aviso — decisão do PO (12/09/2026). É também o caminho que descarta as
  // pendências antigas na primeira rodada após o deploy.
  await runStep("expireStaleConfirmations", now, () =>
    expireStaleConfirmations(now),
  );

  // 3. Retenta pushes/receipts e integrações externas. Cada worker usa
  // lease/CAS próprio; indisponibilidade externa não pode atrasar a
  // escalação local de confirmações. Isolados entre si: um provedor fora do
  // ar não pode levar os outros dois junto.
  await Promise.all([
    runStep("processPendingPushDeliveries", now, () =>
      processPendingPushDeliveries(now),
    ),
    runStep("processPendingDutySyncs", now, () =>
      processPendingDutySyncs(now),
    ),
    runStep("processPendingComunicaPlusOutbox", now, () =>
      processPendingComunicaPlusOutbox(now),
    ),
  ]);

  // 4. Push de início de plantão (confirmados cujo plantão começou agora)
  await runStep("processShiftStartPushes", now, () =>
    processShiftStartPushes(now),
  );
}

// ── Push de início de plantão ───────────────────────────────────────────────
//
// Quando o plantão de um médico CONFIRMADO começa, envia push
// type=sso_ready ("seu plantão começou — abra o Comunica+ já logado").
// Complementa o push da confirmação: cobre o médico que confirmou cedo
// e no início do turno já não tem o push antigo à mão.
//
// Dedupe: dedupKey UNIQUE + CAS do outbox. start_push_sent_at é somente
// evidência posterior de ticket aceito; nunca funciona como pré-claim.
// Janela de captura: startAt em [now - 5min, now] — o cron roda a cada
// 60s; a folga de 5min cobre restarts curtos do processo sem re-enviar
// (o dedupe é persistente) nem notificar plantões antigos.

const START_PUSH_LOOKBACK_MS = 5 * 60 * 1000;

export async function processShiftStartPushes(now: Date) {
  const db = await getDb();
  if (!db) return;

  const confirmedStatuses = ["CONFIRMED", "REPLACEMENT_CONFIRMED"] as const;
  const windowStart = new Date(now.getTime() - START_PUSH_LOOKBACK_MS);

  const started = await db
    .select({
      id: dutyConfirmations.id,
    })
    .from(dutyConfirmations)
    .innerJoin(
      shiftInstances,
      eq(dutyConfirmations.shiftInstanceId, shiftInstances.id),
    )
    .where(
      and(
        inArray(dutyConfirmations.status, confirmedStatuses),
        isNull(dutyConfirmations.startPushSentAt),
        gte(shiftInstances.startAt, windowStart),
        lte(shiftInstances.startAt, now),
      ),
    );

  for (const conf of started) {
    let valid;
    try {
      valid = await requireValidDutyConfirmation(db, conf.id, {
        allowedStatuses: confirmedStatuses,
        requireOriginalAssignmentActive: false,
        requireEffectiveAssignment: true,
      });
    } catch {
      console.warn(
        `[ConfirmationCron] START_PUSH_VALIDATION_FAILED confirmation=${conf.id}`,
      );
      continue;
    }
    const targetUserId = valid.effective.userId;
    if (!resolveTrustedSsoTargetUrl()) {
      console.warn(
        `[ConfirmationCron] Start push suprimido: SSO_TARGET_URL inválida para institution=${valid.shift.institutionId}`,
      );
      continue;
    }

    let ticketAccepted = false;
    try {
      const tracked = await sendTrackedPushNotification(
        {
          institutionId: valid.shift.institutionId,
          userId: targetUserId,
          shiftInstanceId: valid.shift.id,
          dedupKey: `duty-confirmation:${conf.id}:shift-start:${targetUserId}`,
          payload: {
            title: "Seu plantão começou",
            body: `${valid.shift.label}: toque para abrir o Comunica+ já logado.`,
            data: {
              type: "sso_ready",
              confirmationId: conf.id,
              institutionId: valid.shift.institutionId,
              shiftInstanceId: valid.shift.id,
            },
          },
          authority: {
            kind: "DUTY_CONFIRMATION",
            purpose: "SSO_READY",
            confirmationId: conf.id,
            allowedStatuses: [...confirmedStatuses],
            recipientKind: "EFFECTIVE",
            expectedUserId: targetUserId,
            shiftSnapshot: dutyShiftSnapshot(valid.shift),
          },
        },
        now,
      );
      ticketAccepted = tracked.ticketAccepted;
    } catch {
      console.error(
        `[ConfirmationCron] START_PUSH_TRACKING_FAILED confirmation=${conf.id}`,
      );
      continue;
    }

    console.log(
      ticketAccepted
        ? `[ConfirmationCron] Expo ticket accepted for start push userId=${targetUserId} shift=${valid.shift.id}`
        : `[ConfirmationCron] Start push queued for retry userId=${targetUserId} shift=${valid.shift.id}`,
    );
  }
}

// ── Dispatch confirmations due now ─────────────────────────────────────────

/**
 * Procura o push de confirmação deste ciclo pela chave que o próprio envio
 * monta. A chave inclui o token: token novo (re-arme por mudança de horário)
 * nunca colide; token igual (escalação) sempre colide.
 */
async function findTrackedNotificationByDedupKey(
  db: Parameters<typeof findTrackedNotificationByDedupKeyRaw>[0],
  input: { confirmationId: number; confirmationToken: string; userId: number },
) {
  return findTrackedNotificationByDedupKeyRaw(
    db,
    `duty-confirmation:${input.confirmationId}:request:${input.confirmationToken}:${input.userId}`,
  );
}

export async function dispatchConfirmations(now: Date) {
  const db = await getDb();
  if (!db) return;

  const { after, until } = confirmationDiscoveryStartAtRange(now);

  const assignments = await db
    .selectDistinct({
      assignmentId: shiftAssignmentsV2.id,
      shiftInstanceId: shiftAssignmentsV2.shiftInstanceId,
      professionalId: shiftAssignmentsV2.professionalId,
      institutionId: shiftAssignmentsV2.institutionId,
      hospitalId: shiftAssignmentsV2.hospitalId,
      startAt: shiftInstances.startAt,
      endAt: shiftInstances.endAt,
      label: shiftInstances.label,
      sectorId: shiftInstances.sectorId,
      userId: professionals.userId,
      confirmationId: dutyConfirmations.id,
    })
    .from(shiftAssignmentsV2)
    .innerJoin(
      shiftInstances,
      and(
        eq(shiftAssignmentsV2.shiftInstanceId, shiftInstances.id),
        eq(shiftAssignmentsV2.institutionId, shiftInstances.institutionId),
        eq(shiftAssignmentsV2.hospitalId, shiftInstances.hospitalId),
        eq(shiftAssignmentsV2.sectorId, shiftInstances.sectorId),
      ),
    )
    .innerJoin(
      hospitals,
      and(
        eq(hospitals.id, shiftInstances.hospitalId),
        eq(hospitals.institutionId, shiftInstances.institutionId),
      ),
    )
    .innerJoin(
      sectors,
      and(
        eq(sectors.id, shiftInstances.sectorId),
        eq(sectors.institutionId, shiftInstances.institutionId),
        eq(sectors.hospitalId, shiftInstances.hospitalId),
      ),
    )
    .innerJoin(
      professionals,
      eq(shiftAssignmentsV2.professionalId, professionals.id),
    )
    .innerJoin(
      users,
      and(
        eq(users.id, professionals.userId),
        eq(users.approvalStatus, "APPROVED"),
        isNull(users.deletedAt),
      ),
    )
    .innerJoin(
      professionalInstitutions,
      and(
        eq(professionalInstitutions.professionalId, professionals.id),
        eq(professionalInstitutions.userId, professionals.userId),
        eq(
          professionalInstitutions.institutionId,
          shiftInstances.institutionId,
        ),
        eq(professionalInstitutions.active, true),
      ),
    )
    .innerJoin(
      scheduleContexts,
      and(
        eq(scheduleContexts.id, shiftInstances.scheduleContextId),
        eq(scheduleContexts.institutionId, shiftInstances.institutionId),
        eq(scheduleContexts.hospitalId, shiftInstances.hospitalId),
        eq(scheduleContexts.sectorId, shiftInstances.sectorId),
        eq(scheduleContexts.active, true),
      ),
    )
    .leftJoin(
      dutyConfirmations,
      eq(dutyConfirmations.assignmentId, shiftAssignmentsV2.id),
    )
    .where(
      and(
        eq(shiftAssignmentsV2.isActive, true),
        eq(shiftAssignmentsV2.status, "OCUPADO"),
        gt(shiftInstances.startAt, after),
        lte(shiftInstances.startAt, until),
        or(
          isNull(dutyConfirmations.id),
          and(
            eq(dutyConfirmations.status, "PENDING"),
            isNull(dutyConfirmations.recheckAt),
            // `recheck_at` NULL tem dois significados e só um é "arme-me":
            // o re-arme legítimo (plantão mudou de hora) zera o recheck E
            // troca o token; a escalação ao gestor zera o recheck e marca
            // `manager_notified`, mantendo o token. Sem esta linha, o
            // escalado era redescoberto a cada minuto e re-enfileirava o
            // push com a MESMA chave do push original que falhou — colisão,
            // rollback, e o tick morria antes das outras alocações.
            eq(dutyConfirmations.managerNotified, false),
            // Aviso desligado pela instituição: tratado como escalado.
            isNull(dutyConfirmations.escalationSuppressedAt),
          ),
        ),
        plantonistaAccessCoversShiftSql(
          getTableName(professionals),
          getTableName(shiftInstances),
          getTableName(scheduleContexts),
        ),
      ),
    );

  const dueAssignments = assignments.filter((assignment) =>
    isDueForConfirmation(assignment.startAt, now),
  );

  if (dueAssignments.length === 0) {
    return;
  }

  console.log(
    `[ConfirmationCron] Found ${dueAssignments.length} due assignments`,
  );

  const createdIntents: {
    confirmationId: number;
    intent: Parameters<typeof sendTrackedPushNotification>[0];
  }[] = [];

  for (const assignment of dueAssignments) {
    const nextConfirmationToken = randomUUID();
    const recheckAt = new Date(now.getTime() + RECHECK_DELAY_MS);

    // Confirmação e intenção de transporte nascem na mesma transação. A
    // pré-seleção acima é apenas descoberta: shift, assignment, identidade,
    // vínculo, access canônico (#317/#422/#426), due-based e roster são
    // reconstruídos sob lock antes de qualquer INSERT. Papel, scope e
    // convite não substituem professional_access. unique(assignment_id)
    // fecha o segundo worker.
    let created: (typeof createdIntents)[number] | null;
    try {
      created = await db.transaction(async (tx) => {
        const [lockedShift] = await tx
          .select({
            id: shiftInstances.id,
            institutionId: shiftInstances.institutionId,
            hospitalId: shiftInstances.hospitalId,
            sectorId: shiftInstances.sectorId,
          })
          .from(shiftInstances)
          .where(
            and(
              eq(shiftInstances.id, assignment.shiftInstanceId),
              eq(shiftInstances.institutionId, assignment.institutionId),
              eq(shiftInstances.hospitalId, assignment.hospitalId),
              eq(shiftInstances.sectorId, assignment.sectorId),
            ),
          )
          .limit(1)
          .for("update");
        if (!lockedShift) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "O plantão mudou durante a criação da confirmação",
          });
        }
        const [lockedAssignment] = await tx
          .select({ id: shiftAssignmentsV2.id })
          .from(shiftAssignmentsV2)
          .where(
            and(
              eq(shiftAssignmentsV2.id, assignment.assignmentId),
              eq(shiftAssignmentsV2.shiftInstanceId, lockedShift.id),
              eq(shiftAssignmentsV2.institutionId, lockedShift.institutionId),
              eq(shiftAssignmentsV2.hospitalId, lockedShift.hospitalId),
              eq(shiftAssignmentsV2.sectorId, lockedShift.sectorId),
              eq(shiftAssignmentsV2.professionalId, assignment.professionalId),
              eq(shiftAssignmentsV2.status, "OCUPADO"),
              eq(shiftAssignmentsV2.isActive, true),
            ),
          )
          .limit(1)
          .for("update");
        if (!lockedAssignment) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "A alocação mudou durante a criação da confirmação",
          });
        }
        let confirmationId: number;
        let confirmationToken: string;
        if (assignment.confirmationId === null) {
          const [inserted] = await tx
            .insert(dutyConfirmations)
            .values({
              institutionId: assignment.institutionId,
              shiftInstanceId: assignment.shiftInstanceId,
              assignmentId: assignment.assignmentId,
              professionalId: assignment.professionalId,
              userId: assignment.userId,
              status: "PENDING",
              notifiedAt: null,
              recheckAt,
              confirmationToken: nextConfirmationToken,
            })
            .$returningId();
          confirmationId = inserted.id;
          confirmationToken = nextConfirmationToken;
        } else {
          const [rearmed] = await tx
            .select({
              id: dutyConfirmations.id,
              confirmationToken: dutyConfirmations.confirmationToken,
            })
            .from(dutyConfirmations)
            .where(
              and(
                eq(dutyConfirmations.id, assignment.confirmationId),
                eq(dutyConfirmations.institutionId, assignment.institutionId),
                eq(
                  dutyConfirmations.shiftInstanceId,
                  assignment.shiftInstanceId,
                ),
                eq(dutyConfirmations.assignmentId, assignment.assignmentId),
                eq(dutyConfirmations.professionalId, assignment.professionalId),
                eq(dutyConfirmations.userId, assignment.userId),
                eq(dutyConfirmations.status, "PENDING"),
                isNull(dutyConfirmations.recheckAt),
              ),
            )
            .limit(1)
            .for("update");
          if (!rearmed) return null;
          if (!isConfirmationRouteToken(rearmed.confirmationToken)) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "Ciclo de confirmação inválido",
            });
          }
          // Mesmo token ⇒ mesma dedupKey do push original. Se esse push já
          // existe (enviado, ou falhou em definitivo), o ciclo já foi
          // tentado: reenfileirar colidiria com ele. Não é erro — é
          // "nada a fazer", e a decisão fica com a rechecagem/escalação.
          const priorRequest = await findTrackedNotificationByDedupKey(tx, {
            confirmationId: rearmed.id,
            confirmationToken: rearmed.confirmationToken,
            userId: assignment.userId,
          });
          if (priorRequest) {
            logger.info(
              {
                event: "confirmation_rearm_skipped",
                confirmationId: rearmed.id,
                priorNotificationStatus: priorRequest.status,
              },
              "[ConfirmationCron] rearm skipped: request push already attempted",
            );
            return null;
          }
          const [claimedRearm] = await tx
            .update(dutyConfirmations)
            .set({ recheckAt, notifiedAt: null })
            .where(
              and(
                eq(dutyConfirmations.id, rearmed.id),
                eq(dutyConfirmations.status, "PENDING"),
                eq(
                  dutyConfirmations.confirmationToken,
                  rearmed.confirmationToken,
                ),
                isNull(dutyConfirmations.recheckAt),
              ),
            );
          if (claimedRearm.affectedRows !== 1) return null;
          confirmationId = rearmed.id;
          confirmationToken = rearmed.confirmationToken;
        }
        const current = await requireValidDutyConfirmation(tx, confirmationId, {
          allowedStatuses: ["PENDING"],
          expectedInstitutionId: lockedShift.institutionId,
          lockForUpdate: true,
        });
        const startTime = current.shift.startAt.toLocaleTimeString("pt-BR", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: HOSPITAL_TIME_ZONE,
        });
        const endTime = current.shift.endAt.toLocaleTimeString("pt-BR", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: HOSPITAL_TIME_ZONE,
        });
        const intent: Parameters<typeof sendTrackedPushNotification>[0] = {
          institutionId: current.shift.institutionId,
          userId: current.original.userId,
          shiftInstanceId: current.shift.id,
          dedupKey: `duty-confirmation:${confirmationId}:request:${confirmationToken}:${current.original.userId}`,
          payload: {
            title: "Confirmação de plantão",
            body: `Você confirma seu plantão ${current.shift.label} (${startTime}–${endTime})?`,
            data: {
              type: "duty_confirmation",
              confirmationId,
              confirmationToken,
              institutionId: current.shift.institutionId,
              shiftInstanceId: current.shift.id,
              assignmentId: current.original.assignmentId,
            },
          },
          authority: {
            kind: "DUTY_CONFIRMATION",
            purpose: "CONFIRMATION_REQUEST",
            confirmationId,
            allowedStatuses: ["PENDING"],
            recipientKind: "ORIGINAL",
            expectedUserId: current.original.userId,
            shiftSnapshot: dutyShiftSnapshot(current.shift),
            confirmationToken,
          },
        };
        await enqueueTrackedPushNotification(intent, now, tx);
        return {
          confirmationId,
          intent,
        };
      });
    } catch (error) {
      if (isDuplicateEntry(error)) continue;
      if (error instanceof TRPCError && error.code === "FORBIDDEN") {
        console.log(
          `[ConfirmationCron] Assignment ${assignment.assignmentId} ignorada: escala ainda não publicada`,
        );
        continue;
      }
      // Colisão de intenção é "este ciclo já foi tentado", não falha de
      // banco. Uma alocação nesse estado não pode impedir as outras do mesmo
      // tick de receberem sua confirmação.
      if (error instanceof TrackedIntentCollisionError) {
        logger.warn(
          {
            event: "confirmation_intent_collision",
            assignmentId: assignment.assignmentId,
          },
          "[ConfirmationCron] assignment skipped: tracked intent collision",
        );
        continue;
      }
      throw error;
    }
    if (created) createdIntents.push(created);
  }

  // Nenhuma chamada de rede ocorre enquanto ainda existem confirmações da
  // janela por materializar. Depois, um pool pequeno evita monopolizar o DB e
  // o Expo quando um gatilho contém muitos profissionais.
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(5, createdIntents.length) }, async () => {
      while (cursor < createdIntents.length) {
        const created = createdIntents[cursor++];
        if (!created) return;
        const { confirmationId, intent } = created;
        try {
          const tracked = await sendTrackedPushNotification(intent, now);
          if (tracked.ticketAccepted) {
            console.log(
              `[ConfirmationCron] Expo ticket accepted for confirmation=${confirmationId} userId=${intent.userId}`,
            );
            continue;
          }
        } catch {
          console.error(
            `[ConfirmationCron] CONFIRMATION_PUSH_SUBMISSION_FAILED confirmation=${confirmationId}`,
          );
        }
        await notifyManagersConfirmationEscalation(
          confirmationId,
          "PUSH_UNCONFIRMED",
        ).catch(() =>
          console.error(
            `[ConfirmationCron] MANAGER_ESCALATION_FAILED confirmation=${confirmationId}`,
          ),
        );
      }
    }),
  );
}

// ── Recheck: escala silêncio para decisão humana ───────────────────────────

/**
 * Confirmações abertas cujo plantão já terminou viram EXPIRED — estado
 * terminal, sem notificação. Lotes de 500: um acúmulo de semanas (o staging
 * tinha 79) é encerrado em poucas rodadas.
 */
export async function expireStaleConfirmations(now = new Date()): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const stale = await db
    .select({ id: dutyConfirmations.id })
    .from(dutyConfirmations)
    .innerJoin(
      shiftInstances,
      eq(shiftInstances.id, dutyConfirmations.shiftInstanceId),
    )
    .where(
      and(
        inArray(dutyConfirmations.status, OPEN_CONFIRMATION_STATUSES),
        lt(shiftInstances.endAt, now),
      ),
    )
    .limit(500);
  if (!stale.length) return 0;
  const [updated] = await db
    .update(dutyConfirmations)
    .set({ status: "EXPIRED", expiredAt: now, recheckAt: null })
    .where(
      and(
        inArray(
          dutyConfirmations.id,
          stale.map((row) => row.id),
        ),
        inArray(dutyConfirmations.status, OPEN_CONFIRMATION_STATUSES),
      ),
    );
  const count = updated?.affectedRows ?? 0;
  if (count > 0) {
    logger.info(
      { event: "confirmation_expired", count },
      "stale confirmations expired",
    );
  }
  return count;
}

const OPEN_CONFIRMATION_STATUSES = [
  "PENDING",
  "NOMINATED",
  "DECLINED",
  "REPLACEMENT_DECLINED",
] as const;
type OpenConfirmationStatus = (typeof OPEN_CONFIRMATION_STATUSES)[number];

export async function processRechecks(now: Date) {
  const db = await getDb();
  if (!db) return;

  // O prazo só autoriza encerrar esta rechecagem e alertar gestores. Não
  // autoriza mudar a presença, a escala, o SSO ou o roster do Comunica+.
  const expired = await db
    .select({
      id: dutyConfirmations.id,
      status: dutyConfirmations.status,
      institutionId: dutyConfirmations.institutionId,
      shiftInstanceId: dutyConfirmations.shiftInstanceId,
      assignmentId: dutyConfirmations.assignmentId,
      professionalId: dutyConfirmations.professionalId,
      userId: dutyConfirmations.userId,
      recheckAt: dutyConfirmations.recheckAt,
    })
    .from(dutyConfirmations)
    .where(
      and(
        inArray(dutyConfirmations.status, OPEN_CONFIRMATION_STATUSES),
        lte(dutyConfirmations.recheckAt, now),
      ),
    );

  for (const conf of expired) {
    if (
      !conf.recheckAt ||
      !OPEN_CONFIRMATION_STATUSES.includes(
        conf.status as OpenConfirmationStatus,
      )
    ) {
      continue;
    }

    // A validação e o clear canônico compartilham a mesma transação/locks.
    // Falha de infraestrutura escapa, faz rollback e preserva o timer.
    let canonicallyRejected = false;
    try {
      canonicallyRejected = await db.transaction(async (tx) => {
        try {
          await requireValidDutyConfirmation(tx, conf.id, {
            allowedStatuses: [conf.status],
            requireOriginalMembership: false,
            allowMissingOriginalMembership: true,
            allowInvalidOriginalUser: true,
            requireOriginalAccess: false,
            lockForUpdate: true,
          });
          return false;
        } catch (error) {
          if (!isCanonicalDutyConfirmationRejection(error)) throw error;
          await clearDutyConfirmationRecheckIfCurrent(tx, {
            ...dutyConfirmationCasIdentity(conf),
            expectedStatus: conf.status as OpenConfirmationStatus,
            expectedRecheckAt: conf.recheckAt!,
            now,
          });
          return true;
        }
      });
    } catch {
      console.error(
        `[ConfirmationCron] RECHECK_VALIDATION_RETRY confirmation=${conf.id}`,
      );
      continue;
    }
    if (canonicallyRejected) {
      console.log(
        `[ConfirmationCron] RECHECK_CANONICALLY_REJECTED confirmation=${conf.id}`,
      );
      continue;
    }

    // Primeiro persiste todas as intencoes gerenciais. So depois o CAS pode
    // consumir o timer. Se banco/escopo falhar, o prazo permanece devido e o
    // proximo tick tenta de novo.
    let escalation;
    try {
      escalation = await notifyManagersConfirmationEscalation(
        conf.id,
        "NO_RESPONSE",
      );
    } catch {
      console.error(
        `[ConfirmationCron] MANAGER_ESCALATION_ENQUEUE_FAILED confirmation=${conf.id}`,
      );
      continue;
    }
    // Quem NÃO avisou ninguém pode ter quatro motivos, e eles pedem respostas
    // opostas: política desligada (#492) e confirmação já respondida são
    // estado normal, e a própria função os registra na origem; ausência de
    // gestor e banco fora são alarme. `ESCALATION_ALARMS` é quem decide.
    if (escalation.outcome !== "NOTIFIED") {
      const alarm = ESCALATION_ALARMS[escalation.outcome];
      if (alarm) {
        logger.error(
          {
            event: alarm.event,
            confirmationId: conf.id,
            institutionId: conf.institutionId,
            shiftInstanceId: conf.shiftInstanceId,
          },
          alarm.message,
        );
      }
      continue;
    }
    if (escalation.intentCount !== escalation.managerCount) {
      logger.error(
        {
          event: "confirmation_escalation_partial",
          confirmationId: conf.id,
          institutionId: conf.institutionId,
          intentCount: escalation.intentCount,
          managerCount: escalation.managerCount,
        },
        "[ConfirmationCron] escalation intents not fully persisted; recheck kept",
      );
      continue;
    }
    console.log(
      `[ConfirmationCron] Confirmação ${conf.id} aguarda receipt gerencial; presença permanece ${conf.status}`,
    );
  }
}

// ── Escalação gerencial sem confirmação automática ─────────────────────────

export type ConfirmationEscalationReason = "PUSH_UNCONFIRMED" | "NO_RESPONSE";

/**
 * Por que a escalação terminou como terminou.
 *
 * A raiz do problema que este tipo resolve: `managerCount === 0` era um sinal
 * SOBRECARREGADO. Quatro situações diferentes devolviam zero, e duas delas são
 * estado normal enquanto as outras duas são alarme — quem chamava não tinha
 * como separar, e acabava tratando todas igual.
 *
 * - `NOTIFIED`: há gestor e as intenções foram persistidas. Os contadores
 *   dizem se foi por inteiro ou pela metade.
 * - `SUPPRESSED_BY_POLICY`: a instituição desligou o aviso ao gestor (#492).
 *   Estado configurado, não falha. A própria função registra em nível info e
 *   limpa o recheck.
 * - `NO_LONGER_OPEN`: a confirmação saiu dos status abertos entre o CAS e a
 *   escalação — alguém respondeu. Não há o que escalar.
 * - `NO_MANAGER`: existe o que escalar e não há a quem avisar. **O único caso
 *   que merece alarme de negócio.**
 * - `DB_UNAVAILABLE`: o banco sumiu no meio; nem se sabe se há gestor.
 *
 * Sem essa separação, o alerta de "ninguém para avisar" tocaria para todo
 * grupo que apenas exerceu uma opção do produto — e alarme que toca à toa é
 * alarme que ninguém lê.
 */
export type ConfirmationEscalationOutcome =
  | "NOTIFIED"
  | "SUPPRESSED_BY_POLICY"
  | "NO_LONGER_OPEN"
  | "NO_MANAGER"
  | "DB_UNAVAILABLE";

export type ConfirmationEscalationResult = {
  outcome: ConfirmationEscalationOutcome;
  managerCount: number;
  intentCount: number;
};

/**
 * Quais desfechos viram alarme, e com que nome. O que não está aqui é estado
 * normal, já explicado na origem — a tabela existe para essa decisão ficar
 * legível num lugar só, em vez de espalhada em `if`s.
 */
const ESCALATION_ALARMS: Partial<
  Record<ConfirmationEscalationOutcome, { event: string; message: string }>
> = {
  NO_MANAGER: {
    event: "confirmation_escalation_no_manager",
    message:
      "[ConfirmationCron] no eligible manager for escalation; recheck kept",
  },
  DB_UNAVAILABLE: {
    event: "confirmation_escalation_db_unavailable",
    message:
      "[ConfirmationCron] database unavailable during escalation; recheck kept",
  },
};

export async function notifyManagersConfirmationEscalation(
  confirmationId: number,
  reason: ConfirmationEscalationReason,
): Promise<ConfirmationEscalationResult> {
  const db = await getDb();
  if (!db) {
    return { outcome: "DB_UNAVAILABLE", managerCount: 0, intentCount: 0 };
  }
  const [snapshot] = await db
    .select({ status: dutyConfirmations.status })
    .from(dutyConfirmations)
    .where(eq(dutyConfirmations.id, confirmationId))
    .limit(1);
  if (
    !snapshot ||
    !OPEN_CONFIRMATION_STATUSES.includes(
      snapshot.status as OpenConfirmationStatus,
    )
  ) {
    return { outcome: "NO_LONGER_OPEN", managerCount: 0, intentCount: 0 };
  }
  const valid = await requireValidDutyConfirmation(db, confirmationId, {
    allowedStatuses: [snapshot.status],
    requireOriginalMembership: false,
    allowMissingOriginalMembership: true,
    allowInvalidOriginalUser: true,
    requireOriginalAccess: false,
  });
  const shift = valid.shift;

  // Decisão do PO (12/09/2026): avisar o gestor é escolha do grupo de
  // trabalho. Desligado, a confirmação fica aberta até o plantão terminar
  // (EXPIRED), sem avisar ninguém — e a descoberta não a re-arma.
  const [policy] = await db
    .select({ notify: institutions.notifyManagerOnUnconfirmed })
    .from(institutions)
    .where(eq(institutions.id, valid.shift.institutionId))
    .limit(1);
  if (policy && !policy.notify) {
    await db
      .update(dutyConfirmations)
      .set({ escalationSuppressedAt: new Date(), recheckAt: null })
      .where(
        and(
          eq(dutyConfirmations.id, confirmationId),
          inArray(dutyConfirmations.status, OPEN_CONFIRMATION_STATUSES),
          isNull(dutyConfirmations.escalationSuppressedAt),
        ),
      );
    logger.info(
      {
        event: "confirmation_escalation_suppressed",
        confirmationId,
        institutionId: valid.shift.institutionId,
        reason,
      },
      "manager escalation suppressed by institution policy",
    );
    return { outcome: "SUPPRESSED_BY_POLICY", managerCount: 0, intentCount: 0 };
  }

  // Find managers for this hospital/sector via manager_scope
  const managers = await db
    .select({
      userId: professionals.userId,
    })
    .from(managerScopeTable)
    .innerJoin(
      professionals,
      eq(professionals.id, managerScopeTable.managerProfessionalId),
    )
    .innerJoin(
      professionalInstitutions,
      and(
        eq(professionalInstitutions.professionalId, professionals.id),
        eq(professionalInstitutions.userId, professionals.userId),
        eq(professionalInstitutions.institutionId, valid.shift.institutionId),
        eq(professionalInstitutions.roleInInstitution, "GESTOR_MEDICO"),
        eq(professionalInstitutions.active, true),
      ),
    )
    .innerJoin(
      users,
      and(
        eq(users.id, professionals.userId),
        eq(users.approvalStatus, "APPROVED"),
        isNull(users.deletedAt),
      ),
    )
    .where(
      and(
        eq(managerScopeTable.institutionId, valid.shift.institutionId),
        eq(managerScopeTable.hospitalId, shift.hospitalId),
        or(
          isNull(managerScopeTable.sectorId),
          eq(managerScopeTable.sectorId, shift.sectorId),
        ),
        eq(managerScopeTable.active, true),
      ),
    );

  // Also find GESTOR_PLUS users (institution-wide managers)
  const gestoresPlus = await db
    .select({ userId: professionals.userId })
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
        eq(users.id, professionals.userId),
        eq(users.approvalStatus, "APPROVED"),
        isNull(users.deletedAt),
      ),
    )
    .where(
      and(
        eq(professionalInstitutions.institutionId, valid.shift.institutionId),
        eq(professionalInstitutions.roleInInstitution, "GESTOR_PLUS"),
        eq(professionalInstitutions.active, true),
      ),
    );

  // Admin global só recebe alerta dentro de tenant onde ainda possui
  // professional↔PI ativa. Isso espelha a autoridade canônica de policy.ts:
  // o papel global não contorna a admissão institucional.
  const globalAdmins = await db
    .select({ userId: professionals.userId })
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
        eq(users.id, professionals.userId),
        eq(users.role, "admin"),
        eq(users.approvalStatus, "APPROVED"),
        isNull(users.deletedAt),
      ),
    )
    .where(
      and(
        eq(professionalInstitutions.institutionId, valid.shift.institutionId),
        eq(professionalInstitutions.active, true),
      ),
    );

  const managerUserIds = new Set([
    ...managers.map((m) => m.userId),
    ...gestoresPlus.map((g) => g.userId),
    ...globalAdmins.map((admin) => admin.userId),
  ]);

  const doctorName = valid.original.name ?? `Usuário #${valid.original.userId}`;
  const shiftRevision = createHash("sha256")
    .update(JSON.stringify(dutyShiftSnapshot(valid.shift)))
    .digest("hex")
    .slice(0, 12);
  const recheckEpoch = valid.confirmation.recheckAt?.toISOString();
  if (
    !recheckEpoch ||
    valid.confirmation.recheckAt?.getUTCMilliseconds() !== 0
  ) {
    throw new Error("CONFIRMATION_RECHECK_EPOCH_UNAVAILABLE");
  }
  const recheckRevision = valid.confirmation.recheckAt.getTime();
  const confirmationToken = valid.confirmation.confirmationToken;

  let intentCount = 0;
  for (const managerUserId of managerUserIds) {
    const push =
      reason === "PUSH_UNCONFIRMED"
        ? {
            title: "Falha ao notificar confirmação",
            body: `Não foi possível comprovar o envio da confirmação de ${doctorName} para o plantão ${shift.label}. Verifique manualmente no Escala+.`,
          }
        : {
            title: "Confirmação de plantão pendente",
            body: `${doctorName} não respondeu no prazo do plantão ${shift.label}. O sistema não confirmou automaticamente; verifique a presença.`,
          };
    try {
      await enqueueTrackedPushNotification({
        institutionId: valid.shift.institutionId,
        userId: managerUserId,
        shiftInstanceId: valid.shift.id,
        dedupKey: `duty-confirmation:${confirmationId}:manager:${reason}:${snapshot.status}:${recheckRevision}:${confirmationToken}:${shiftRevision}:${managerUserId}`,
        payload: {
          ...push,
          data: {
            type: "manager_confirmation_escalation",
            reason,
            confirmationId,
            institutionId: valid.shift.institutionId,
            shiftInstanceId: valid.shift.id,
            userId: valid.original.userId,
            recheckEpoch,
            confirmationToken,
          },
        },
        authority: {
          kind: "DUTY_CONFIRMATION",
          purpose: "MANAGER_ESCALATION",
          confirmationId,
          allowedStatuses: [snapshot.status],
          recipientKind: "MANAGER",
          expectedUserId: managerUserId,
          shiftSnapshot: dutyShiftSnapshot(valid.shift),
          recheckEpoch,
          confirmationToken,
        },
      });
      intentCount += 1;
    } catch {
      // Um destinatário sem outbox disponível não pode impedir os demais
      // gestores de receberem o alerta.
      console.error(
        `[ConfirmationCron] MANAGER_ALERT_TRACKING_FAILED userId=${managerUserId}`,
      );
    }
  }

  console.log(
    `[ConfirmationCron] Escalation ${reason}: ${intentCount}/${managerUserIds.size} intent(s) persisted`,
  );
  return {
    outcome: managerUserIds.size === 0 ? "NO_MANAGER" : "NOTIFIED",
    managerCount: managerUserIds.size,
    intentCount,
  };
}

// ── Start the cron interval ─────────────────────────────────────────────────
//
// O setInterval só vive enquanto o processo web está acordado. No plano
// Render free a instância dorme após 15 min: rechecagem +30 min e o push
// de início (lookback 5 min) falham em silêncio. A discovery due-based
// faz catch-up no próximo tick enquanto o plantão ainda não começou, mas
// isso não substitui execução 24/7. Fechar pontualidade 24/7 é
// EXTERNAL_INFRA_ACTION_REQUIRED — ver
// docs/operations/confirmation-coverage.md. O CLI `pnpm confirmation:tick`
// é o gancho de um Cron cobrado; este módulo não cria o serviço.

let intervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Registra POR QUE o tick falhou, não só que falhou.
 *
 * A versão anterior escrevia apenas "TICK_FAILED". Como este cron roda a cada
 * 60 segundos, uma falha permanente produzia 1.440 linhas por dia, todas
 * idênticas e todas inúteis: dava para ver que estava quebrado havia semanas
 * e era impossível saber do quê. O diagnóstico é sanitizado — categoria e
 * código do driver, nunca mensagem crua nem dado de escala.
 */
function logTickFailure(error: unknown): void {
  logger.error(
    { event: "confirmation_tick_failed", ...safeErrorDiagnostic(error) },
    "[ConfirmationCron] TICK_FAILED",
  );
}

export function startConfirmationCron() {
  if (intervalId) return;
  console.log("[ConfirmationCron] Started (checks every 60s)");
  // Run immediately on start
  tick().catch(logTickFailure);
  // Then every 60 seconds
  intervalId = setInterval(() => {
    tick().catch(logTickFailure);
  }, 60_000);
}

/** Para o timer e devolve o tick em andamento, para o shutdown drenar. */
export function stopConfirmationCron(): Promise<void> {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("[ConfirmationCron] Stopped");
  }
  return activeTick ?? Promise.resolve();
}
