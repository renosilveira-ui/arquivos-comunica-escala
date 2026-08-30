import { and, eq, isNull } from "drizzle-orm";
import {
  hospitals,
  professionalInstitutions,
  professionals,
  sectors,
  users,
} from "../drizzle/schema";
import {
  formatHospitalDate,
  formatHospitalTimeRange,
} from "../lib/hospital-time";
import { enqueueTrackedPushNotification } from "./push-delivery";

export const SHIFT_ASSIGNED_PUSH_TYPE = "shift_assigned";
export const SHIFT_UNASSIGNED_PUSH_TYPE = "shift_unassigned";

type SignalDb = NonNullable<
  Parameters<typeof enqueueTrackedPushNotification>[2]
>;

export type AssignmentLifecyclePushInput = {
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

export type ShiftAssignedPushInput = AssignmentLifecyclePushInput;

type AssignmentLifecycleKind = "assigned" | "unassigned";

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
  kind: AssignmentLifecycleKind,
  place: { hospitalName: string | null; sectorName: string | null },
  startAt: Date,
  endAt: Date,
): { title: string; body: string } {
  const sector = place.sectorName ?? "setor";
  const date = formatHospitalDate(startAt);
  const hours = formatHospitalTimeRange(startAt, endAt);
  if (kind === "assigned") {
    const body = place.hospitalName
      ? `Você foi escalado em ${place.hospitalName} · ${sector}, ${date}, ${hours}.`
      : `Você foi escalado para ${sector}, ${date}, ${hours}.`;
    return {
      title: "Novo plantão na sua escala",
      body,
    };
  }
  const body = place.hospitalName
    ? `Você não está mais alocado no plantão de ${place.hospitalName} · ${sector}, ${date}, ${hours}.`
    : `Você não está mais alocado no plantão de ${sector}, ${date}, ${hours}.`;
  return {
    title: "Alteração na sua escala",
    body,
  };
}

/**
 * Persiste o push de ciclo de alocação na mesma transação do assignment.
 * Destinatário sai do profissional persistido + PI ativa no tenant do plantão.
 * Sem token Expo a intenção fica PENDING; a alocação não depende da rede.
 */
async function enqueueAssignmentLifecyclePush(
  kind: AssignmentLifecycleKind,
  input: AssignmentLifecyclePushInput,
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
  const copy = assignmentCopy(kind, place, shift.startAt, shift.endAt);
  const type =
    kind === "assigned" ? SHIFT_ASSIGNED_PUSH_TYPE : SHIFT_UNASSIGNED_PUSH_TYPE;
  const dedupKey = `shift-${kind}:${shift.id}:${professionalId}:${assignmentId}`;

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
            type,
            institutionId: shift.institutionId,
            shiftInstanceId: shift.id,
            assignmentId,
            professionalId,
            ...(kind === "assigned" ? { userId } : {}),
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

export async function enqueueShiftAssignedPush(
  input: AssignmentLifecyclePushInput,
): Promise<number> {
  return enqueueAssignmentLifecyclePush("assigned", input);
}

export async function enqueueShiftUnassignedPush(
  input: AssignmentLifecyclePushInput,
): Promise<number> {
  return enqueueAssignmentLifecyclePush("unassigned", input);
}
