import { and, eq, isNull, or } from "drizzle-orm";
import {
  managerScope,
  professionalInstitutions,
  professionals,
  users,
  type swapRequests,
} from "../drizzle/schema";
import { enqueueTrackedPushNotification } from "./push-delivery";

type SwapRow = typeof swapRequests.$inferSelect;
type SignalDb = NonNullable<Parameters<typeof enqueueTrackedPushNotification>[2]>;

export type SwapOfferSignalInput = {
  db: SignalDb;
  swap: SwapRow;
  offererName: string;
  shiftLabel: string;
};

function offerCopy(type: SwapRow["type"], offererName: string, shiftLabel: string) {
  if (type === "SWAP") {
    return {
      title: "Proposta de troca",
      body: `${offererName} propôs uma troca no plantão ${shiftLabel}.`,
    };
  }
  return {
    title: "Oferta de plantão",
    body: `${offererName} ofereceu o plantão ${shiftLabel}.`,
  };
}

async function listScaleManagerUserIds(
  db: any,
  input: {
    institutionId: number;
    hospitalId: number;
    sectorId: number;
  },
): Promise<number[]> {
  const scopedManagers = await db
    .select({ userId: professionals.userId })
    .from(managerScope)
    .innerJoin(
      professionals,
      eq(professionals.id, managerScope.managerProfessionalId),
    )
    .innerJoin(
      professionalInstitutions,
      and(
        eq(professionalInstitutions.professionalId, professionals.id),
        eq(professionalInstitutions.userId, professionals.userId),
        eq(professionalInstitutions.institutionId, input.institutionId),
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
        eq(managerScope.institutionId, input.institutionId),
        eq(managerScope.hospitalId, input.hospitalId),
        or(isNull(managerScope.sectorId), eq(managerScope.sectorId, input.sectorId)),
        eq(managerScope.active, true),
      ),
    );

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
        eq(professionalInstitutions.institutionId, input.institutionId),
        eq(professionalInstitutions.roleInInstitution, "GESTOR_PLUS"),
        eq(professionalInstitutions.active, true),
      ),
    );

  return [
    ...scopedManagers.map((row: { userId: number }) => row.userId),
    ...gestoresPlus.map((row: { userId: number }) => row.userId),
  ];
}

export async function listSwapOfferSignalRecipientUserIds(
  db: any,
  input: {
    institutionId: number;
    hospitalId: number;
    sectorId: number;
    fromUserId: number;
    toUserId: number | null;
  },
): Promise<number[]> {
  const recipients = new Set<number>();
  if (input.toUserId !== null && input.toUserId !== input.fromUserId) {
    recipients.add(input.toUserId);
  }
  for (const userId of await listScaleManagerUserIds(db, input)) {
    if (userId !== input.fromUserId) recipients.add(userId);
  }
  return [...recipients];
}

/**
 * Persiste o sinal da oferta (push + inbox) para o destinatário
 * direcionado e para os gestores da escala. Sem isso a oferta existe
 * no banco e some da UI: ninguém é avisado.
 */
export async function enqueueSwapOfferSignals(
  input: SwapOfferSignalInput,
): Promise<number> {
  const { db, swap } = input;
  if (swap.sectorId === null) return 0;
  const userIds = await listSwapOfferSignalRecipientUserIds(db, {
    institutionId: swap.institutionId,
    hospitalId: swap.hospitalId,
    sectorId: swap.sectorId,
    fromUserId: swap.fromUserId,
    toUserId: swap.toUserId,
  });
  const copy = offerCopy(swap.type, input.offererName, input.shiftLabel);
  let persisted = 0;
  for (const userId of userIds) {
    try {
      await enqueueTrackedPushNotification(
        {
          institutionId: swap.institutionId,
          userId,
          shiftInstanceId: swap.fromShiftInstanceId,
          dedupKey: `swap-offer:${swap.id}:${userId}`,
          deepLink: "/(tabs)/trocas",
          payload: {
            ...copy,
            data: {
              type: "swap_offer",
              swapRequestId: swap.id,
              institutionId: swap.institutionId,
              shiftInstanceId: swap.fromShiftInstanceId,
              userId,
            },
          },
        },
        new Date(),
        db,
      );
      persisted += 1;
    } catch (error) {
      // O outbox entra na mesma transação da oferta. Engolir a falha
      // deixaria a oferta gravada e o push/inbox sumidos — o produto
      // mentiria que o outro lado foi avisado. A rede Expo roda depois,
      // no worker; aqui só a persistência da intenção pode falhar.
      console.error(
        `[SwapOffer] SIGNAL_TRACKING_FAILED userId=${JSON.stringify(userId)} swapId=${JSON.stringify(swap.id)}`,
      );
      throw error;
    }
  }
  return persisted;
}
