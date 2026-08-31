import { and, eq, type SQLWrapper } from "drizzle-orm";
import { sectors, shiftInstances, type swapRequests } from "../drizzle/schema";
import {
  SWAP_OFFER_DEEP_LINK,
  SWAP_OFFER_PUSH_TITLE,
} from "../lib/swap-offer-badge-refresh";
import {
  formatHospitalDate,
  formatHospitalTime,
} from "../lib/hospital-time";
import { enqueueTrackedPushNotification } from "./push-delivery";
import { eligibleRecipientUserIdsForSwapOffer } from "./swap-offer-eligibility";

type SwapRow = typeof swapRequests.$inferSelect;
type EnqueueDb = NonNullable<Parameters<typeof enqueueTrackedPushNotification>[2]>;
type SignalDb = EnqueueDb & {
  execute: (query: string | SQLWrapper) => Promise<unknown>;
};

export type SwapOfferSignalInput = {
  db: SignalDb;
  swap: SwapRow;
  shiftLabel: string;
  sectorName?: string | null;
  startAt?: Date | string;
};

export function swapOfferPushCopy(input: {
  sectorName?: string | null;
  shiftLabel: string;
  startAt?: Date | string | null;
}): { title: string; body: string } {
  const parts: string[] = [];
  const sector = input.sectorName?.trim();
  if (sector) parts.push(sector);
  const label = input.shiftLabel.trim();
  if (label) parts.push(label);
  if (input.startAt) {
    parts.push(
      `${formatHospitalDate(input.startAt)} ${formatHospitalTime(input.startAt)}`,
    );
  }
  return {
    title: SWAP_OFFER_PUSH_TITLE,
    body: parts.join(" · "),
  };
}

async function resolveOfferCopyContext(
  db: SignalDb,
  input: SwapOfferSignalInput,
): Promise<{ sectorName: string; shiftLabel: string; startAt: Date | null }> {
  const shiftLabel = input.shiftLabel.trim();
  let sectorName = input.sectorName?.trim() ?? "";
  let startAt = input.startAt ? new Date(input.startAt) : null;
  if (sectorName && startAt && !Number.isNaN(startAt.getTime())) {
    return { sectorName, shiftLabel, startAt };
  }
  const [place] = await db
    .select({
      sectorName: sectors.name,
      startAt: shiftInstances.startAt,
      shiftLabel: shiftInstances.label,
    })
    .from(shiftInstances)
    .innerJoin(
      sectors,
      and(
        eq(sectors.id, shiftInstances.sectorId),
        eq(sectors.institutionId, shiftInstances.institutionId),
        eq(sectors.hospitalId, shiftInstances.hospitalId),
      ),
    )
    .where(
      and(
        eq(shiftInstances.id, input.swap.fromShiftInstanceId),
        eq(shiftInstances.institutionId, input.swap.institutionId),
      ),
    )
    .limit(1);
  if (!sectorName) sectorName = place?.sectorName?.trim() ?? "";
  if (!startAt || Number.isNaN(startAt.getTime())) {
    startAt = place?.startAt ?? null;
  }
  return {
    sectorName,
    shiftLabel: shiftLabel || place?.shiftLabel?.trim() || "",
    startAt,
  };
}

/**
 * Persiste o sinal da oferta (push + inbox) para médicos plantonistas
 * elegíveis a responder. Gestores não entram só pelo papel; o ofertante
 * nunca entra; outro tenant nunca entra.
 */
export async function enqueueSwapOfferSignals(
  input: SwapOfferSignalInput,
): Promise<number> {
  const { db, swap } = input;
  if (swap.sectorId === null) return 0;
  const userIds = await eligibleRecipientUserIdsForSwapOffer(db, swap);
  const copyContext = await resolveOfferCopyContext(db, input);
  const copy = swapOfferPushCopy(copyContext);
  let persisted = 0;
  for (const userId of userIds) {
    try {
      await enqueueTrackedPushNotification(
        {
          institutionId: swap.institutionId,
          userId,
          shiftInstanceId: swap.fromShiftInstanceId,
          dedupKey: `swap-offer:${swap.id}:${userId}`,
          deepLink: SWAP_OFFER_DEEP_LINK,
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

function takenCopy(type: SwapRow["type"], takerName: string, shiftLabel: string) {
  if (type === "SWAP") {
    return {
      title: "Troca concluída",
      body: `${takerName} assumiu o plantão ${shiftLabel}. A troca foi concluída.`,
    };
  }
  return {
    title: "Plantão assumido",
    body: `${takerName} assumiu o plantão ${shiftLabel}.`,
  };
}

/**
 * Avisa o ofertante de que o plantão foi assumido (sem pedir aprovação).
 * Mesma transação do aceite — falha de persistência aborta o take.
 */
export async function enqueueSwapTakenSignals(input: {
  db: EnqueueDb;
  swap: SwapRow;
  takerName: string;
  shiftLabel: string;
}): Promise<number> {
  const { db, swap } = input;
  const ownerUserId = swap.fromUserId;
  if (!ownerUserId) return 0;
  const copy = takenCopy(swap.type, input.takerName, input.shiftLabel);
  try {
    await enqueueTrackedPushNotification(
      {
        institutionId: swap.institutionId,
        userId: ownerUserId,
        shiftInstanceId: swap.fromShiftInstanceId,
        dedupKey: `swap-taken:${swap.id}:${ownerUserId}`,
        deepLink: "/my-offers",
        payload: {
          ...copy,
          data: {
            type: "swap_taken",
            swapRequestId: swap.id,
            institutionId: swap.institutionId,
            shiftInstanceId: swap.fromShiftInstanceId,
            userId: ownerUserId,
          },
        },
      },
      new Date(),
      db,
    );
    return 1;
  } catch (error) {
    console.error(
      `[SwapTake] SIGNAL_TRACKING_FAILED userId=${JSON.stringify(ownerUserId)} swapId=${JSON.stringify(swap.id)}`,
    );
    throw error;
  }
}
