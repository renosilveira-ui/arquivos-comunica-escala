// server/cron/shift-confirmation-dispatcher.ts
//
// Cron job que roda a cada minuto. Nos horários-gatilho (11h, 17h, 22h)
// envia push notifications pedindo confirmação de presença aos médicos
// alocados nos plantões correspondentes.
//
// Horários fixos:
//   11:00 → plantão Tarde  (13:00–19:00)
//   17:00 → plantão Noite  (19:00–07:00)
//   22:00 → plantão Manhã  (07:00–13:00 do dia seguinte)
//
// Também executa a rechecagem +30min. Silêncio nunca confirma presença:
// prazo vencido mantém a escala intacta e abre alerta para decisão humana.

import { createHash, randomUUID } from "crypto";
import { TRPCError } from "@trpc/server";
import { and, eq, gte, lte, inArray, isNull, or } from "drizzle-orm";
import { getDb } from "../db";
import {
  shiftInstances,
  shiftAssignmentsV2,
  professionals,
  dutyConfirmations,
  hospitals,
  managerScope as managerScopeTable,
  professionalAccess,
  professionalInstitutions,
  sectors,
  users,
} from "../../drizzle/schema";
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

// ── Trigger schedule ────────────────────────────────────────────────────────

interface TriggerWindow {
  /** Hour:minute to send the notification */
  notifyHour: number;
  notifyMinute: number;
  /** Shift start time (HH:MM) */
  shiftStartTime: string;
  /** Shift end time (HH:MM) */
  shiftEndTime: string;
  /** Label for the shift period */
  label: string;
  /** Whether the shift is on the next calendar day */
  shiftNextDay: boolean;
}

const TRIGGERS: TriggerWindow[] = [
  { notifyHour: 11, notifyMinute: 0, shiftStartTime: "13:00", shiftEndTime: "19:00", label: "Tarde", shiftNextDay: false },
  { notifyHour: 17, notifyMinute: 0, shiftStartTime: "19:00", shiftEndTime: "07:00", label: "Noite", shiftNextDay: false },
  { notifyHour: 22, notifyMinute: 0, shiftStartTime: "07:00", shiftEndTime: "13:00", label: "Manhã", shiftNextDay: true },
];

const RECHECK_DELAY_MS = 30 * 60 * 1000; // 30 minutes
const TIMEZONE = process.env.TZ_HOSPITAL || "America/Sao_Paulo";


function getLocalTime(now: Date): { hours: number; minutes: number; dateStr: string } {
  const local = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);

  const get = (type: string) => local.find((p) => p.type === type)?.value ?? "0";
  return {
    hours: Number(get("hour")),
    minutes: Number(get("minute")),
    dateStr: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

function isDuplicateEntry(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && (error as { code?: unknown }).code === "ER_DUP_ENTRY") return true;
  return "cause" in error && isDuplicateEntry((error as { cause?: unknown }).cause);
}

// ── Main tick (called every ~60s) ───────────────────────────────────────────

/** Janela após o horário-gatilho em que o disparo ainda é feito (restart/drift). */
const TRIGGER_WINDOW_MIN = 20;
let running = false;

export async function tick(now: Date = new Date()) {
  // Ticks concorrentes (tick longo + setInterval) processavam a mesma
  // confirmação duas vezes.
  if (running) return;
  running = true;
  try {
    const local = getLocalTime(now);
    const currentMinute = local.hours * 60 + local.minutes;

    // 1. Gatilhos: dentro de uma JANELA após o horário, não só no minuto
    // exato — deploy/restart ou drift do setInterval às 11:00/17:00/22:00
    // pulava o disparo do dia. dispatchConfirmations é idempotente
    // (uma confirmação por alocação), então repetir na janela é seguro.
    for (const trigger of TRIGGERS) {
      const triggerMinute = trigger.notifyHour * 60 + trigger.notifyMinute;
      if (currentMinute >= triggerMinute && currentMinute < triggerMinute + TRIGGER_WINDOW_MIN) {
        await dispatchConfirmations(now, trigger);
      }
    }

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
// (11h/17h/22h) e no início do turno já não tem o push antigo à mão.
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

// ── Dispatch confirmations for a trigger window ─────────────────────────────

export async function dispatchConfirmations(now: Date, trigger: TriggerWindow) {
  const db = await getDb();
  if (!db) return;

  // Determine which date the shift is on (using local timezone)
  const local = getLocalTime(now);
  let dateStr = local.dateStr;
  if (trigger.shiftNextDay) {
    const next = new Date(`${dateStr}T12:00:00`);
    next.setDate(next.getDate() + 1);
    dateStr = next.toISOString().split("T")[0]!;
  }

  // Build shift time window.
  //
  // shiftStartTime/shiftEndTime são horários de PAREDE do hospital
  // (America/Sao_Paulo), mas start_at no banco é gravado como instante
  // UTC pelo editor do app (Manhã 07h BRT = 10:00Z). Sem o offset
  // explícito, o servidor (TZ=UTC) interpretava "13:00" como 13:00Z e a
  // janela caía 3h antes dos plantões reais — o cron nunca encontrava
  // nada criado pelo app. São Paulo é UTC-3 fixo (sem horário de verão
  // desde 2019).
  const shiftStartAt = new Date(`${dateStr}T${trigger.shiftStartTime}:00-03:00`);
  const shiftEndAt = new Date(`${dateStr}T${trigger.shiftEndTime}:00-03:00`);
  // Overnight shift: end time is next day
  if (shiftEndAt <= shiftStartAt) {
    shiftEndAt.setDate(shiftEndAt.getDate() + 1);
  }

  // Find active assignments for shifts in this window
  // Tolerance: ±30 minutes on start time to catch slight variations
  const startLow = new Date(shiftStartAt.getTime() - 30 * 60_000);
  const startHigh = new Date(shiftStartAt.getTime() + 30 * 60_000);

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
      professionalAccess,
      and(
        eq(professionalAccess.professionalId, professionals.id),
        eq(professionalAccess.institutionId, shiftInstances.institutionId),
        eq(professionalAccess.hospitalId, shiftInstances.hospitalId),
        or(
          isNull(professionalAccess.sectorId),
          eq(professionalAccess.sectorId, shiftInstances.sectorId),
        ),
        eq(professionalAccess.canAccess, true),
      ),
    )
    .where(
      and(
        eq(shiftAssignmentsV2.isActive, true),
        eq(shiftAssignmentsV2.status, "OCUPADO"),
        gte(shiftInstances.startAt, startLow),
        lte(shiftInstances.startAt, startHigh),
      ),
    );

  if (assignments.length === 0) {
    console.log(`[ConfirmationCron] No assignments found for ${trigger.label} ${dateStr}`);
    return;
  }

  console.log(`[ConfirmationCron] Found ${assignments.length} assignments for ${trigger.label} ${dateStr}`);

  const createdIntents: {
    confirmationId: number;
    intent: Parameters<typeof sendTrackedPushNotification>[0];
  }[] = [];

  for (const assignment of assignments) {
    const confirmationToken = randomUUID();
    const recheckAt = new Date(now.getTime() + RECHECK_DELAY_MS);

    // Confirmação e intenção de transporte nascem na mesma transação. A
    // pré-seleção acima é apenas descoberta: shift, assignment, identidade,
    // vínculo, ACL, roster e texto do plantão são todos reconstruídos sob lock
    // antes de qualquer INSERT. A unique(assignment_id) fecha o segundo worker.
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
          timeZone: TIMEZONE,
        });
        const endTime = current.shift.endAt.toLocaleTimeString("pt-BR", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: TIMEZONE,
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
