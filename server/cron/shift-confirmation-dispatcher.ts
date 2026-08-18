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
// Também executa a rechecagem +30min: se o médico não respondeu,
// marca AUTO_CONFIRMED, dispara SSO e notifica gestor.

import { randomUUID } from "crypto";
import { and, eq, gte, lte, inArray, isNull } from "drizzle-orm";
import { getDb } from "../db";
import {
  shiftInstances,
  shiftAssignmentsV2,
  professionals,
  dutyConfirmations,
  managerScope as managerScopeTable,
  professionalInstitutions,
} from "../../drizzle/schema";
import { sendPushNotification } from "../notifications-service";
import { triggerAutoSso } from "../sso/auto-sso";
import { syncDutyToComunica } from "../sso/duty-sync";

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

let lastRunMinute = -1;

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

// ── Main tick (called every ~60s) ───────────────────────────────────────────

export async function tick() {
  const now = new Date();
  const local = getLocalTime(now);
  const currentMinute = local.hours * 60 + local.minutes;

  // Prevent double-execution in the same minute
  if (currentMinute === lastRunMinute) return;
  lastRunMinute = currentMinute;

  // 1. Check if current time matches any trigger
  for (const trigger of TRIGGERS) {
    const triggerMinute = trigger.notifyHour * 60 + trigger.notifyMinute;
    if (currentMinute === triggerMinute) {
      console.log(`[ConfirmationCron] Trigger: ${trigger.label} (${trigger.notifyHour}:${String(trigger.notifyMinute).padStart(2, "0")})`);
      await dispatchConfirmations(now, trigger);
    }
  }

  // 2. Process rechecks (PENDING confirmations past their recheckAt)
  await processRechecks(now);

  // 3. Push de início de plantão (confirmados cujo plantão começou agora)
  await processShiftStartPushes(now);
}

// ── Push de início de plantão ───────────────────────────────────────────────
//
// Quando o plantão de um médico CONFIRMADO começa, envia push
// type=sso_ready ("seu plantão começou — abra o Comunica+ já logado").
// Complementa o push da confirmação: cobre o médico que confirmou cedo
// (11h/17h/22h) e no início do turno já não tem o push antigo à mão.
//
// Dedupe: coluna duty_confirmations.start_push_sent_at (NULL = pendente).
// Janela de captura: startAt em [now - 5min, now] — o cron roda a cada
// 60s; a folga de 5min cobre restarts curtos do processo sem re-enviar
// (o dedupe é persistente) nem notificar plantões antigos.

const START_PUSH_LOOKBACK_MS = 5 * 60 * 1000;

async function processShiftStartPushes(now: Date) {
  const db = await getDb();
  if (!db) return;

  const confirmedStatuses = ["CONFIRMED", "AUTO_CONFIRMED", "REPLACEMENT_CONFIRMED"] as const;
  const windowStart = new Date(now.getTime() - START_PUSH_LOOKBACK_MS);

  const started = await db
    .select({
      id: dutyConfirmations.id,
      userId: dutyConfirmations.userId,
      replacementUserId: dutyConfirmations.replacementUserId,
      shiftInstanceId: dutyConfirmations.shiftInstanceId,
      shiftLabel: shiftInstances.label,
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
    const targetUserId = conf.replacementUserId ?? conf.userId;

    // Marca ANTES de enviar: se o push falhar, preferimos perder um
    // aviso a re-notificar em loop a cada 60s.
    await db
      .update(dutyConfirmations)
      .set({ startPushSentAt: now })
      .where(eq(dutyConfirmations.id, conf.id));

    await sendPushNotification(targetUserId, {
      title: "Seu plantão começou",
      body: `${conf.shiftLabel}: toque para abrir o Comunica+ já logado.`,
      data: {
        type: "sso_ready",
        shiftInstanceId: conf.shiftInstanceId,
      },
    }).catch((err) =>
      console.error("[ConfirmationCron] Start push failed:", err),
    );

    console.log(
      `[ConfirmationCron] Start push sent userId=${targetUserId} shift=${conf.shiftInstanceId}`,
    );
  }
}

// ── Dispatch confirmations for a trigger window ─────────────────────────────

async function dispatchConfirmations(now: Date, trigger: TriggerWindow) {
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

  // Build shift time window
  const shiftStartAt = new Date(`${dateStr}T${trigger.shiftStartTime}:00`);
  const shiftEndAt = new Date(`${dateStr}T${trigger.shiftEndTime}:00`);
  // Overnight shift: end time is next day
  if (shiftEndAt <= shiftStartAt) {
    shiftEndAt.setDate(shiftEndAt.getDate() + 1);
  }

  // Find active assignments for shifts in this window
  // Tolerance: ±30 minutes on start time to catch slight variations
  const startLow = new Date(shiftStartAt.getTime() - 30 * 60_000);
  const startHigh = new Date(shiftStartAt.getTime() + 30 * 60_000);

  const assignments = await db
    .select({
      assignmentId: shiftAssignmentsV2.id,
      shiftInstanceId: shiftAssignmentsV2.shiftInstanceId,
      professionalId: shiftAssignmentsV2.professionalId,
      institutionId: shiftAssignmentsV2.institutionId,
      startAt: shiftInstances.startAt,
      endAt: shiftInstances.endAt,
      label: shiftInstances.label,
      sectorId: shiftInstances.sectorId,
      userId: professionals.userId,
      professionalName: professionals.name,
    })
    .from(shiftAssignmentsV2)
    .innerJoin(shiftInstances, eq(shiftAssignmentsV2.shiftInstanceId, shiftInstances.id))
    .innerJoin(professionals, eq(shiftAssignmentsV2.professionalId, professionals.id))
    .where(
      and(
        eq(shiftAssignmentsV2.isActive, true),
        gte(shiftInstances.startAt, startLow),
        lte(shiftInstances.startAt, startHigh),
      ),
    );

  if (assignments.length === 0) {
    console.log(`[ConfirmationCron] No assignments found for ${trigger.label} ${dateStr}`);
    return;
  }

  console.log(`[ConfirmationCron] Found ${assignments.length} assignments for ${trigger.label} ${dateStr}`);

  for (const assignment of assignments) {
    // Skip if confirmation already exists for this assignment
    const [existing] = await db
      .select({ id: dutyConfirmations.id })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.assignmentId, assignment.assignmentId))
      .limit(1);

    if (existing) continue;

    const confirmationToken = randomUUID();
    const recheckAt = new Date(now.getTime() + RECHECK_DELAY_MS);

    // Create confirmation record
    await db.insert(dutyConfirmations).values({
      institutionId: assignment.institutionId,
      shiftInstanceId: assignment.shiftInstanceId,
      assignmentId: assignment.assignmentId,
      professionalId: assignment.professionalId,
      userId: assignment.userId,
      status: "PENDING",
      notifiedAt: now,
      recheckAt,
      confirmationToken,
    });

    // Send push notification
    const startTime = new Date(assignment.startAt).toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    });
    const endTime = new Date(assignment.endAt).toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    });

    await sendPushNotification(assignment.userId, {
      title: "Confirmação de plantão",
      body: `Você confirma seu plantão ${assignment.label} (${startTime}–${endTime})?`,
      data: {
        type: "duty_confirmation",
        confirmationToken,
        shiftInstanceId: assignment.shiftInstanceId,
        assignmentId: assignment.assignmentId,
      },
    });

    console.log(`[ConfirmationCron] Sent confirmation to ${assignment.professionalName} (userId=${assignment.userId})`);
  }
}

// ── Recheck: auto-confirm unresponsive doctors ──────────────────────────────

async function processRechecks(now: Date) {
  const db = await getDb();
  if (!db) return;

  // Find confirmations past their recheck time that need auto-resolution.
  // PENDING: doctor never responded
  // NOMINATED: replacement indicated but hasn't accepted
  // DECLINED: doctor declined but never indicated replacement
  // REPLACEMENT_DECLINED: substitute refused, no new nomination
  const expired = await db
    .select({
      id: dutyConfirmations.id,
      userId: dutyConfirmations.userId,
      professionalId: dutyConfirmations.professionalId,
      shiftInstanceId: dutyConfirmations.shiftInstanceId,
      assignmentId: dutyConfirmations.assignmentId,
      institutionId: dutyConfirmations.institutionId,
    })
    .from(dutyConfirmations)
    .where(
      and(
        inArray(dutyConfirmations.status, ["PENDING", "NOMINATED", "DECLINED", "REPLACEMENT_DECLINED"]),
        lte(dutyConfirmations.recheckAt, now),
      ),
    );

  for (const conf of expired) {
    // Auto-confirm: whoever is currently assigned gets logged in
    await db
      .update(dutyConfirmations)
      .set({
        status: "AUTO_CONFIRMED",
        autoConfirmedAt: now,
        managerNotified: true,
      })
      .where(eq(dutyConfirmations.id, conf.id));

    // Notify the doctor that they were auto-confirmed
    await sendPushNotification(conf.userId, {
      title: "Plantão confirmado automaticamente",
      body: "Você não respondeu a confirmação. Seu plantão foi confirmado e o login no Comunica+ será realizado.",
      data: {
        type: "duty_auto_confirmed",
        shiftInstanceId: conf.shiftInstanceId,
      },
    });

    // Auto-SSO for the assigned doctor
    // Duty-sync: auto-confirmado também vira plantonista declarado
    syncDutyToComunica(conf.id, "CONFIRM").catch((err) =>
      console.error("[ConfirmationCron] Duty-sync failed:", err),
    );
    triggerAutoSso(conf.id).catch((err) =>
      console.error("[ConfirmationCron] Auto-SSO failed:", err),
    );

    // Notify managers responsible for this shift's hospital/sector
    await notifyManagersAutoConfirm(conf).catch((err) =>
      console.error("[ConfirmationCron] Manager notification failed:", err),
    );

    console.log(`[ConfirmationCron] Auto-confirmed userId=${conf.userId} for shift=${conf.shiftInstanceId}`);
  }
}

// ── Notify managers about auto-confirmations ────────────────────────────────

async function notifyManagersAutoConfirm(conf: {
  shiftInstanceId: number;
  institutionId: number;
  userId: number;
}) {
  const db = await getDb();
  if (!db) return;

  // Get shift details for context
  const [shift] = await db
    .select({
      hospitalId: shiftInstances.hospitalId,
      sectorId: shiftInstances.sectorId,
      label: shiftInstances.label,
    })
    .from(shiftInstances)
    .where(eq(shiftInstances.id, conf.shiftInstanceId))
    .limit(1);

  if (!shift) return;

  // Get doctor name
  const [pro] = await db
    .select({ name: professionals.name })
    .from(professionals)
    .where(eq(professionals.userId, conf.userId))
    .limit(1);

  // Find managers for this hospital/sector via manager_scope
  const managers = await db
    .select({
      userId: professionalInstitutions.userId,
    })
    .from(managerScopeTable)
    .innerJoin(
      professionalInstitutions,
      and(
        eq(professionalInstitutions.professionalId, managerScopeTable.managerProfessionalId),
        eq(professionalInstitutions.institutionId, conf.institutionId),
        eq(professionalInstitutions.active, true),
      ),
    )
    .where(
      and(
        eq(managerScopeTable.institutionId, conf.institutionId),
        eq(managerScopeTable.hospitalId, shift.hospitalId),
        eq(managerScopeTable.active, true),
      ),
    );

  // Also find GESTOR_PLUS users (institution-wide managers)
  const gestoresPlus = await db
    .select({ userId: professionalInstitutions.userId })
    .from(professionalInstitutions)
    .where(
      and(
        eq(professionalInstitutions.institutionId, conf.institutionId),
        eq(professionalInstitutions.roleInInstitution, "GESTOR_PLUS"),
        eq(professionalInstitutions.active, true),
      ),
    );

  const managerUserIds = new Set([
    ...managers.map((m) => m.userId),
    ...gestoresPlus.map((g) => g.userId),
  ]);

  const doctorName = pro?.name ?? `Usuário #${conf.userId}`;

  for (const managerUserId of managerUserIds) {
    await sendPushNotification(managerUserId, {
      title: "Plantão confirmado automaticamente",
      body: `${doctorName} não respondeu a confirmação do plantão ${shift.label}. O sistema confirmou automaticamente.`,
      data: {
        type: "manager_auto_confirm_alert",
        shiftInstanceId: conf.shiftInstanceId,
        userId: conf.userId,
      },
    });
  }

  if (managerUserIds.size > 0) {
    console.log(`[ConfirmationCron] Notified ${managerUserIds.size} manager(s) about auto-confirm for shift=${conf.shiftInstanceId}`);
  }
}

// ── Start the cron interval ─────────────────────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;

export function startConfirmationCron() {
  if (intervalId) return;
  console.log("[ConfirmationCron] Started (checks every 60s)");
  // Run immediately on start
  tick().catch((err) => console.error("[ConfirmationCron] tick error:", err));
  // Then every 60 seconds
  intervalId = setInterval(() => {
    tick().catch((err) => console.error("[ConfirmationCron] tick error:", err));
  }, 60_000);
}

export function stopConfirmationCron() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("[ConfirmationCron] Stopped");
  }
}
