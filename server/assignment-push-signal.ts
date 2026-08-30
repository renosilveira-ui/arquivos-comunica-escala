import { and, eq, isNull } from "drizzle-orm";
import {
  hospitals,
  professionalInstitutions,
  professionals,
  sectors,
  users,
} from "../drizzle/schema";
import { formatHospitalTimeRange } from "../lib/hospital-time";
import { enqueueTrackedPushNotification } from "./push-delivery";

export const SHIFT_ASSIGNED_PUSH_TYPE = "shift_assigned";

type SignalDb = NonNullable<
  Parameters<typeof enqueueTrackedPushNotification>[2]
>;

export type ShiftAssignedPushInput = {
  db: SignalDb;
  assignmentId: number;
  professionalId: number;
  shift: {
    id: number;
    institutionId: number;
    hospitalId: number;
    sectorId: number;
    startAt: Date;
    endAt: Date;
  };
};

/** Calendário do hospital (UTC−03:00), sem depender do fuso do servidor. */
function formatHospitalDate(date: Date): string {
  const wall = new Date(date.getTime() - 3 * 60 * 60 * 1000);
  const day = String(wall.getUTCDate()).padStart(2, "0");
  const month = String(wall.getUTCMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${wall.getUTCFullYear()}`;
}

async function resolveAssignedUserId(
  db: SignalDb,
  professionalId: number,
  institutionId: number,
): Promise<number | null> {
  const [row] = await db
    .select({ userId: professionals.userId })
    .from(professionals)
    .innerJoin(
      professionalInstitutions,
      and(
        eq(professionalInstitutions.professionalId, professionals.id),
        eq(professionalInstitutions.userId, professionals.userId),
        eq(professionalInstitutions.institutionId, institutionId),
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
    .where(eq(professionals.id, professionalId))
    .limit(1);
  return row?.userId ?? null;
}

async function loadPlaceNames(
  db: SignalDb,
  input: { institutionId: number; hospitalId: number; sectorId: number },
): Promise<{ hospitalName: string | null; sectorName: string | null }> {
  const [hospital] = await db
    .select({ name: hospitals.name })
    .from(hospitals)
    .where(
      and(
        eq(hospitals.id, input.hospitalId),
        eq(hospitals.institutionId, input.institutionId),
      ),
    )
    .limit(1);
  const [sector] = await db
    .select({ name: sectors.name })
    .from(sectors)
    .where(
      and(
        eq(sectors.id, input.sectorId),
        eq(sectors.institutionId, input.institutionId),
        eq(sectors.hospitalId, input.hospitalId),
      ),
    )
    .limit(1);
  return {
    hospitalName: hospital?.name?.trim() || null,
    sectorName: sector?.name?.trim() || null,
  };
}

function assignmentCopy(
  place: { hospitalName: string | null; sectorName: string | null },
  startAt: Date,
  endAt: Date,
): { title: string; body: string } {
  const sector = place.sectorName ?? "setor";
  const date = formatHospitalDate(startAt);
  const hours = formatHospitalTimeRange(startAt, endAt);
  const body = place.hospitalName
    ? `Você foi escalado em ${place.hospitalName} · ${sector}, ${date}, ${hours}.`
    : `Você foi escalado para ${sector}, ${date}, ${hours}.`;
  return {
    title: "Novo plantão na sua escala",
    body,
  };
}

/**
 * Persiste o push de alocação na mesma transação do assignment.
 * Destinatário sai do profissional persistido + PI ativa no tenant do plantão.
 * Sem token Expo a intenção fica PENDING; a alocação não depende da rede.
 */
export async function enqueueShiftAssignedPush(
  input: ShiftAssignedPushInput,
): Promise<number> {
  const { db, shift, professionalId, assignmentId } = input;
  const userId = await resolveAssignedUserId(
    db,
    professionalId,
    shift.institutionId,
  );
  if (userId == null) {
    console.error(
      `[AssignmentPush] DESTINATARIO_AUSENTE professionalId=${JSON.stringify(professionalId)} shiftId=${JSON.stringify(shift.id)}`,
    );
    return 0;
  }

  const place = await loadPlaceNames(db, shift);
  const copy = assignmentCopy(place, shift.startAt, shift.endAt);
  const dedupKey = `shift-assigned:${shift.id}:${professionalId}:${assignmentId}`;

  try {
    await enqueueTrackedPushNotification(
      {
        institutionId: shift.institutionId,
        userId,
        shiftInstanceId: shift.id,
        dedupKey,
        deepLink: `/shift-details?id=${shift.id}`,
        payload: {
          ...copy,
          data: {
            type: SHIFT_ASSIGNED_PUSH_TYPE,
            institutionId: shift.institutionId,
            shiftInstanceId: shift.id,
            assignmentId,
            professionalId,
            userId,
          },
        },
      },
      new Date(),
      db,
    );
    return 1;
  } catch (error) {
    console.error(
      `[AssignmentPush] SIGNAL_TRACKING_FAILED shiftId=${JSON.stringify(shift.id)} assignmentId=${JSON.stringify(assignmentId)}`,
    );
    throw error;
  }
}
