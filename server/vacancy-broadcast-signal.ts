import { and, eq, gt, like, type SQLWrapper } from "drizzle-orm";
import { notifications, sectors } from "../drizzle/schema";
import {
  formatHospitalDate,
  formatHospitalTime,
} from "../lib/hospital-time";
import {
  VACANCY_AVAILABLE_DEEP_LINK,
  VACANCY_AVAILABLE_PUSH_TITLE,
  VACANCY_AVAILABLE_PUSH_TYPE,
  VACANCY_BROADCAST_COOLDOWN_MS,
  vacancyBroadcastDedupKey,
  vacancyBroadcastDedupPrefix,
} from "../lib/vacancy-broadcast";
import { enqueueTrackedPushNotification } from "./push-delivery";
import {
  eligibleProfessionalUserIdsForShift,
} from "./plantonista-shift-eligibility";

type EnqueueDb = NonNullable<Parameters<typeof enqueueTrackedPushNotification>[2]>;
type SignalDb = EnqueueDb & {
  execute: (query: string | SQLWrapper) => Promise<unknown>;
  select: EnqueueDb["select"];
};

export type VacancyBroadcastShift = {
  id: number;
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  startAt: Date;
  endAt: Date;
  label: string;
};

function compactHospitalHour(value: Date): string {
  const [hours, minutes] = formatHospitalTime(value).split(":");
  return minutes === "00" ? `${hours}h` : `${hours}:${minutes}`;
}

export function vacancyBroadcastPushCopy(input: {
  sectorName?: string | null;
  startAt: Date;
  endAt: Date;
}): { title: string; body: string } {
  const sector = input.sectorName?.trim() || "Setor";
  const date = formatHospitalDate(input.startAt).slice(0, 5);
  const hours = `${compactHospitalHour(input.startAt)}–${compactHospitalHour(input.endAt)}`;
  return {
    title: VACANCY_AVAILABLE_PUSH_TITLE,
    body: `${sector} · ${date} · ${hours}`,
  };
}

async function loadSectorName(
  db: SignalDb,
  shift: VacancyBroadcastShift,
): Promise<string> {
  const [sector] = await db
    .select({ name: sectors.name })
    .from(sectors)
    .where(
      and(
        eq(sectors.id, shift.sectorId),
        eq(sectors.institutionId, shift.institutionId),
        eq(sectors.hospitalId, shift.hospitalId),
      ),
    )
    .limit(1);
  return sector?.name?.trim() || "";
}

export async function recentVacancyBroadcastExists(
  db: Pick<SignalDb, "select">,
  shift: Pick<VacancyBroadcastShift, "id" | "institutionId">,
  now: Date,
): Promise<boolean> {
  const [row] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.institutionId, shift.institutionId),
        eq(notifications.shiftInstanceId, shift.id),
        like(notifications.dedupKey, `${vacancyBroadcastDedupPrefix(shift.id)}%`),
        gt(
          notifications.createdAt,
          new Date(now.getTime() - VACANCY_BROADCAST_COOLDOWN_MS),
        ),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Persiste o aviso de vaga (push + inbox) para plantonistas elegíveis.
 * Só deve ser chamado pela mutation deliberada do gestor.
 */
export async function enqueueVacancyAvailableSignals(input: {
  db: SignalDb;
  shift: VacancyBroadcastShift;
  now?: Date;
}): Promise<number> {
  const { db, shift } = input;
  const now = input.now ?? new Date();
  const userIds = await eligibleProfessionalUserIdsForShift(db, {
    id: shift.id,
    institutionId: shift.institutionId,
  });
  const sectorName = await loadSectorName(db, shift);
  const copy = vacancyBroadcastPushCopy({
    sectorName,
    startAt: shift.startAt,
    endAt: shift.endAt,
  });
  let persisted = 0;
  for (const userId of userIds) {
    try {
      await enqueueTrackedPushNotification(
        {
          institutionId: shift.institutionId,
          userId,
          shiftInstanceId: shift.id,
          dedupKey: vacancyBroadcastDedupKey({
            shiftInstanceId: shift.id,
            userId,
            now,
          }),
          deepLink: VACANCY_AVAILABLE_DEEP_LINK,
          payload: {
            ...copy,
            data: {
              type: VACANCY_AVAILABLE_PUSH_TYPE,
              institutionId: shift.institutionId,
              shiftInstanceId: shift.id,
              userId,
            },
          },
        },
        now,
        db,
      );
      persisted += 1;
    } catch (error) {
      console.error(
        `[VacancyBroadcast] SIGNAL_TRACKING_FAILED userId=${JSON.stringify(userId)} shiftId=${JSON.stringify(shift.id)}`,
      );
      throw error;
    }
  }
  return persisted;
}
