import { enqueueTrackedPushNotification } from "./push-delivery";
import {
  loadInvitedProfessionalName,
  resolveInviteAcceptedRecipientUserId,
} from "./schedule-invite-response-signal-helpers";

export {
  loadInvitedProfessionalName,
  resolveInviteAcceptedRecipientUserId,
} from "./schedule-invite-response-signal-helpers";

export const INVITE_ACCEPTED_PUSH_TYPE = "invite_accepted";

type SignalDb = NonNullable<Parameters<typeof enqueueTrackedPushNotification>[2]>;

export type ScheduleInviteAcceptedSignalInput = {
  db: SignalDb;
  scheduleInviteId: number;
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  hospitalName: string;
  sectorName: string;
  createdByUserId: number;
  invitedUserId: number;
};

function inviteAcceptedCopy(
  professionalName: string,
  place: { hospitalName: string | null; sectorName: string | null },
): { title: string; body: string } {
  if (place.hospitalName && place.sectorName) {
    return {
      title: "Convite aceito",
      body: `${professionalName} aceitou o convite para ${place.hospitalName} · ${place.sectorName}.`,
    };
  }
  return {
    title: "Convite aceito",
    body: `${professionalName} aceitou o convite de escala.`,
  };
}

/**
 * Best-effort após commit do resgate: avisa somente o gestor que emitiu o
 * convite nominal. Qualquer falha nesta fase não desfaz o aceite.
 */
export async function enqueueScheduleInviteAcceptedSignal(
  input: ScheduleInviteAcceptedSignalInput,
): Promise<number> {
  const {
    db,
    scheduleInviteId,
    institutionId,
    hospitalId,
    sectorId,
    createdByUserId,
    invitedUserId,
  } = input;

  try {
    const recipientUserId = await resolveInviteAcceptedRecipientUserId(db, {
      institutionId,
      createdByUserId,
      invitedUserId,
    });
    if (recipientUserId == null) {
      console.error(
        `[ScheduleInviteAccepted] DESTINATARIO_AUSENTE scheduleInviteId=${JSON.stringify(scheduleInviteId)}`,
      );
      return 0;
    }

    const professionalName = await loadInvitedProfessionalName(db, invitedUserId);
    const copy = inviteAcceptedCopy(professionalName, {
      hospitalName: input.hospitalName?.trim() || null,
      sectorName: input.sectorName?.trim() || null,
    });
    const dedupKey = `schedule-invite:${scheduleInviteId}:accepted:${createdByUserId}`;

    await enqueueTrackedPushNotification(
      {
        institutionId,
        userId: recipientUserId,
        dedupKey,
        deepLink: "/schedule-invites",
        payload: {
          ...copy,
          data: {
            type: INVITE_ACCEPTED_PUSH_TYPE,
            institutionId,
            scheduleInviteId,
            hospitalId,
            sectorId,
            invitedUserId,
          },
        },
      },
      new Date(),
      db,
    );
    return 1;
  } catch {
    console.error(
      `[ScheduleInviteAccepted] SIGNAL_TRACKING_FAILED scheduleInviteId=${JSON.stringify(scheduleInviteId)}`,
    );
    return 0;
  }
}
