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
import { and, eq, getTableName, gt, gte, lte, inArray, isNull, or } from "drizzle-orm";
import { getDb } from "../db";
import {
  shiftInstances,
  shiftAssignmentsV2,
  professionals,
  dutyConfirmations,
  hospitals,
  managerScope as managerScopeTable,
  professionalInstitutions,
  scheduleContexts,
  sectors,
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
} from "../push-delivery";
import { processPendingDutySyncs } from "../sso/duty-sync";
import { resolveTrustedSsoTargetUrl } from "../sso/url-policy";
import { processPendingComunicaPlusOutbox } from "../integrations/comunica-plus";
import { processPendingAuthRecoveryEmails } from "../auth-recovery";

const RECHECK_DELAY_MS = 30 * 60 * 1000; // 30 minutes

function isDuplicateEntry(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && (error as { code?: unknown }).code === "ER_DUP_ENTRY") return true;
  return "cause" in error && isDuplicateEntry((error as { cause?: unknown }).cause);
}

// ── Main tick (called every ~60s) ───────────────────────────────────────────

let running = false;

export async function tick(now: Date = new Date()) {
  // Ticks concorrentes (tick longo + setInterval) processavam a mesma
  // confirmação duas vezes.
  if (running) return;
  running = true;
  try {
    // 1. Discovery due-based: catch-up de assignment tardio, swap,
    // publicação tardia e restart. Idempotente (unique assignment_id).
    await dispatchConfirmations(now);

    // 2. Persiste e conquista por CAS as escalações vencidas. O worker roda
    // depois: se o CAS perder para uma decisão humana, a autoridade de status
    // do outbox suprime o alerta obsoleto antes da rede.
    await processRechecks(now);

    // 3. Retenta pushes/receipts e integrações externas em paralelo. Cada
    // worker usa lease/CAS próprio; indisponibilidade externa não pode atrasar
    // a escalação local de confirmações.
    await Promise.all([
      processPendingPushDeliveries(now),
      processPendingDutySyncs(now),
      processPendingComunicaPlusOutbox(now),
      processPendingAuthRecoveryEmails(now),
    ]);

    // 4. Push de início de plantão (confirmados cujo plantão começou agora)
    await processShiftStartPushes(now);
  } finally {
    running = false;
  }
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
      console.warn(`[ConfirmationCron] START_PUSH_VALIDATION_FAILED confirmation=${conf.id}`);
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
      console.error(`[ConfirmationCron] START_PUSH_TRACKING_FAILED confirmation=${conf.id}`);
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
    .innerJoin(professionals, eq(shiftAssignmentsV2.professionalId, professionals.id))
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
        eq(professionalInstitutions.institutionId, shiftInstances.institutionId),
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
        isNull(dutyConfirmations.id),
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
    const confirmationToken = randomUUID();
    const recheckAt = new Date(now.getTime() + RECHECK_DELAY_MS);

    // Confirmação e intenção de transporte nascem na mesma transação. A
    // pré-seleção acima é apenas descoberta: shift, assignment, identidade,
    // vínculo, access canônico (#317/#422/#426), due-based e roster são
    // reconstruídos sob lock antes de qualquer INSERT. Papel, scope e
    // convite não substituem professional_access. unique(assignment_id)
    // fecha o segundo worker.
    let created: typeof createdIntents[number] | null;
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
            confirmationToken,
          })
          .$returningId();
        const current = await requireValidDutyConfirmation(tx, inserted.id, {
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
          dedupKey: `duty-confirmation:${inserted.id}:request:${current.original.userId}`,
          payload: {
            title: "Confirmação de plantão",
            body: `Você confirma seu plantão ${current.shift.label} (${startTime}–${endTime})?`,
            data: {
              type: "duty_confirmation",
              confirmationId: inserted.id,
              confirmationToken,
              institutionId: current.shift.institutionId,
              shiftInstanceId: current.shift.id,
              assignmentId: current.original.assignmentId,
            },
          },
          authority: {
            kind: "DUTY_CONFIRMATION",
            purpose: "CONFIRMATION_REQUEST",
            confirmationId: inserted.id,
            allowedStatuses: ["PENDING"],
            recipientKind: "ORIGINAL",
            expectedUserId: current.original.userId,
            shiftSnapshot: dutyShiftSnapshot(current.shift),
          },
        };
        await enqueueTrackedPushNotification(intent, now, tx);
        return {
          confirmationId: inserted.id,
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
      throw error;
    }
    if (created) createdIntents.push(created);
  }

  // Nenhuma chamada de rede ocorre enquanto ainda existem confirmações da
  // janela por materializar. Depois, um pool pequeno evita monopolizar o DB e
  // o Expo quando um gatilho contém muitos profissionais.
  let cursor = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(5, createdIntents.length) },
      async () => {
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
      },
    ),
  );
}

// ── Recheck: escala silêncio para decisão humana ───────────────────────────

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
    if (!conf.recheckAt || !OPEN_CONFIRMATION_STATUSES.includes(conf.status as OpenConfirmationStatus)) {
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
      console.error(`[ConfirmationCron] RECHECK_VALIDATION_RETRY confirmation=${conf.id}`);
      continue;
    }
    if (canonicallyRejected) {
      console.log(`[ConfirmationCron] RECHECK_CANONICALLY_REJECTED confirmation=${conf.id}`);
      continue;
    }

    // Primeiro persiste todas as intencoes gerenciais. So depois o CAS pode
    // consumir o timer. Se banco/escopo falhar, o prazo permanece devido e o
    // proximo tick tenta de novo.
    let escalation;
    try {
      escalation = await notifyManagersConfirmationEscalation(conf.id, "NO_RESPONSE");
    } catch {
      console.error(`[ConfirmationCron] MANAGER_ESCALATION_ENQUEUE_FAILED confirmation=${conf.id}`);
      continue;
    }
    if (escalation.managerCount === 0 || escalation.intentCount !== escalation.managerCount) {
      console.error(
        `[ConfirmationCron] Confirmação ${conf.id} mantém recheck: ${escalation.intentCount}/${escalation.managerCount} alertas persistidos`,
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

export async function notifyManagersConfirmationEscalation(
  confirmationId: number,
  reason: ConfirmationEscalationReason,
) {
  const db = await getDb();
  if (!db) return { managerCount: 0, intentCount: 0 };
  const [snapshot] = await db
    .select({ status: dutyConfirmations.status })
    .from(dutyConfirmations)
    .where(eq(dutyConfirmations.id, confirmationId))
    .limit(1);
  if (!snapshot || !OPEN_CONFIRMATION_STATUSES.includes(snapshot.status as OpenConfirmationStatus)) {
    return { managerCount: 0, intentCount: 0 };
  }
  const valid = await requireValidDutyConfirmation(db, confirmationId, {
    allowedStatuses: [snapshot.status],
    requireOriginalMembership: false,
    allowMissingOriginalMembership: true,
    allowInvalidOriginalUser: true,
    requireOriginalAccess: false,
  });
  const shift = valid.shift;

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
        or(isNull(managerScopeTable.sectorId), eq(managerScopeTable.sectorId, shift.sectorId)),
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
  const recheckRevision = valid.confirmation.recheckAt?.getTime() ?? 0;

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
        dedupKey: `duty-confirmation:${confirmationId}:manager:${reason}:${snapshot.status}:${recheckRevision}:${shiftRevision}:${managerUserId}`,
        payload: {
          ...push,
          data: {
            type: "manager_confirmation_escalation",
            reason,
            confirmationId,
            institutionId: valid.shift.institutionId,
            shiftInstanceId: valid.shift.id,
            userId: valid.original.userId,
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
  return { managerCount: managerUserIds.size, intentCount };
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

export function startConfirmationCron() {
  if (intervalId) return;
  console.log("[ConfirmationCron] Started (checks every 60s)");
  // Run immediately on start
  tick().catch(() => console.error("[ConfirmationCron] TICK_FAILED"));
  // Then every 60 seconds
  intervalId = setInterval(() => {
    tick().catch(() => console.error("[ConfirmationCron] TICK_FAILED"));
  }, 60_000);
}

export function stopConfirmationCron() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("[ConfirmationCron] Stopped");
  }
}
