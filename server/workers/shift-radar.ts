import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { getDb } from "../db";
import { ENV } from "../_core/env";
import { professionals, shiftAssignmentsV2, shiftInstances } from "../../drizzle/schema";
import { enqueueShiftReminderNotification } from "../notifications-service";

const RADAR_INTERVAL_MS = 15 * 60 * 1000;
const LOOKBACK_MS = RADAR_INTERVAL_MS;
const LOOKAHEAD_HOURS = 36;

type ReminderType = "RADAR_11H" | "RADAR_3H";

function toDateAtHour(base: Date, hour: number, minute = 0, second = 0) {
  const d = new Date(base);
  d.setHours(hour, minute, second, 0);
  return d;
}

function getReminderWindowForShift(startAt: Date): {
  reminderAt: Date;
  reminderType: ReminderType;
} {
  const h = startAt.getHours();

  // 07:00 -> 20:00 do dia anterior (11h antes)
  if (h >= 7 && h < 13) {
    const previousDay = new Date(startAt);
    previousDay.setDate(previousDay.getDate() - 1);
    return {
      reminderAt: toDateAtHour(previousDay, 20, 0, 0),
      reminderType: "RADAR_11H",
    };
  }

  // 13:00 -> 10:00 mesmo dia (3h antes)
  if (h >= 13 && h < 19) {
    return {
      reminderAt: toDateAtHour(startAt, 10, 0, 0),
      reminderType: "RADAR_3H",
    };
  }

  // 19:00-07:00 -> 16:00 mesmo dia (3h antes para início 19h)
  return {
    reminderAt: toDateAtHour(startAt, 16, 0, 0),
    reminderType: "RADAR_3H",
  };
}

function isInsideDueWindow(reminderAt: Date, now: Date): boolean {
  const windowStart = new Date(now.getTime() - LOOKBACK_MS);
  return reminderAt >= windowStart && reminderAt <= now;
}

function buildShiftDeepLink(shiftId: number): string {
  return `${ENV.shiftRadarDeepLinkBaseUrl.replace(/\/$/, "")}/shift?id=${shiftId}`;
}

async function runShiftRadarCycle() {
  const db = await getDb();
  if (!db) return;

  const now = new Date();
  const horizon = new Date(now.getTime() + LOOKAHEAD_HOURS * 60 * 60 * 1000);

  const candidateShifts = await db
    .select({
      id: shiftInstances.id,
      institutionId: shiftInstances.institutionId,
      startAt: shiftInstances.startAt,
      endAt: shiftInstances.endAt,
      label: shiftInstances.label,
    })
    .from(shiftInstances)
    .where(and(gte(shiftInstances.startAt, now), lte(shiftInstances.startAt, horizon)));

  for (const shift of candidateShifts) {
    const { reminderAt, reminderType } = getReminderWindowForShift(shift.startAt);
    if (!isInsideDueWindow(reminderAt, now)) continue;

    const assignments = await db
      .select({ userId: professionals.userId })
      .from(shiftAssignmentsV2)
      .innerJoin(professionals, eq(professionals.id, shiftAssignmentsV2.professionalId))
      .where(
        and(
          eq(shiftAssignmentsV2.institutionId, shift.institutionId),
          eq(shiftAssignmentsV2.shiftInstanceId, shift.id),
          eq(shiftAssignmentsV2.isActive, true),
          inArray(shiftAssignmentsV2.status, ["OCUPADO", "CONFIRMADO"]),
        ),
      );

    for (const assignment of assignments) {
      await enqueueShiftReminderNotification({
        institutionId: shift.institutionId,
        userId: assignment.userId,
        shiftInstanceId: shift.id,
        reminderType,
        title: "Radar de Plantões",
        body: `Lembrete: plantão ${shift.label} iniciará em breve.`,
        deepLink: buildShiftDeepLink(shift.id),
      });
    }
  }
}

let radarTimer: ReturnType<typeof setInterval> | null = null;

export function startShiftRadarWorker() {
  if (!ENV.shiftRadarEnabled) {
    console.log("[ShiftRadar] disabled (SHIFT_RADAR_ENABLED=false)");
    return;
  }
  if (radarTimer) return;

  const run = async () => {
    try {
      await runShiftRadarCycle();
    } catch (error) {
      console.error("[ShiftRadar] erro no ciclo:", error);
    }
  };

  void run();
  radarTimer = setInterval(() => {
    void run();
  }, RADAR_INTERVAL_MS);

  console.log(`[ShiftRadar] started (interval=${RADAR_INTERVAL_MS}ms)`);
}
