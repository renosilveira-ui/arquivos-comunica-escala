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
import { and, eq, gte, lte, isNull, inArray } from "drizzle-orm";
import { getDb } from "../db";
import {
  shiftInstances,
  shiftAssignmentsV2,
  professionals,
  users,
  dutyConfirmations,
} from "../../drizzle/schema";
import { sendPushNotification } from "../notifications-service";
import { triggerAutoSso } from "../sso/auto-sso";

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

let lastRunMinute = -1;

// ── Main tick (called every ~60s) ───────────────────────────────────────────

export async function tick() {
  const now = new Date();
  const currentMinute = now.getHours() * 60 + now.getMinutes();

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
}

// ── Dispatch confirmations for a trigger window ─────────────────────────────

async function dispatchConfirmations(now: Date, trigger: TriggerWindow) {
  const db = await getDb();
  if (!db) return;

  // Determine which date the shift is on
  const shiftDate = new Date(now);
  if (trigger.shiftNextDay) {
    shiftDate.setDate(shiftDate.getDate() + 1);
  }
  const dateStr = shiftDate.toISOString().split("T")[0]!;

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

  // Find PENDING confirmations past their recheck time
  const pendingExpired = await db
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
        eq(dutyConfirmations.status, "PENDING"),
        lte(dutyConfirmations.recheckAt, now),
      ),
    );

  // Also find NOMINATED replacements that haven't been accepted
  const nominatedExpired = await db
    .select({
      id: dutyConfirmations.id,
      userId: dutyConfirmations.userId,
      professionalId: dutyConfirmations.professionalId,
      replacementUserId: dutyConfirmations.replacementUserId,
      shiftInstanceId: dutyConfirmations.shiftInstanceId,
      institutionId: dutyConfirmations.institutionId,
    })
    .from(dutyConfirmations)
    .where(
      and(
        eq(dutyConfirmations.status, "NOMINATED"),
        lte(dutyConfirmations.recheckAt, now),
      ),
    );

  for (const conf of [...pendingExpired, ...nominatedExpired]) {
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
    triggerAutoSso(conf.id).catch((err) =>
      console.error("[ConfirmationCron] Auto-SSO failed:", err),
    );

    // Notify manager about the auto-confirmation
    // TODO (Fase 5): Resolve manager userId and send notification

    console.log(`[ConfirmationCron] Auto-confirmed userId=${conf.userId} for shift=${conf.shiftInstanceId}`);
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
