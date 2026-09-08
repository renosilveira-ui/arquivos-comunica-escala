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
import type {
  SwapOfferPushAuthority,
  SwapTakenPushAuthority,
} from "./swap-push-authority";

type SwapRow = typeof swapRequests.$inferSelect;
type EnqueueDb = NonNullable<Parameters<typeof enqueueTrackedPushNotification>[2]>;
type SignalDb = EnqueueDb & {
  execute: (query: string | SQLWrapper) => Promise<unknown>;
};

function positiveId(value: number | null): value is number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0;
}

function swapOfferAuthority(
  swap: SwapRow,
  expectedUserId: number,
): SwapOfferPushAuthority {
  const open = swap.toProfessionalId === null && swap.toUserId === null;
  const directed =
    positiveId(swap.toProfessionalId) && positiveId(swap.toUserId);
  const validTarget =
    swap.type === "SWAP"
      ? positiveId(swap.toShiftInstanceId) &&
        swap.toShiftInstanceId !== swap.fromShiftInstanceId &&
        swap.toAssignmentId === null
      : swap.toShiftInstanceId === null && swap.toAssignmentId === null;
  if (
    !positiveId(swap.id) ||
    !positiveId(swap.fromProfessionalId) ||
    !positiveId(swap.fromUserId) ||
    !positiveId(swap.fromAssignmentId) ||
    !positiveId(swap.fromShiftInstanceId) ||
    !positiveId(swap.institutionId) ||
    !positiveId(swap.hospitalId) ||
    !positiveId(swap.sectorId) ||
    !positiveId(expectedUserId) ||
    expectedUserId === swap.fromUserId ||
    !positiveId(swap.version) ||
    (!open && !directed) ||
    !validTarget
  ) {
    throw new Error("Oferta sem topologia canônica para o outbox de push");
  }
  return {
    kind: "SWAP_OFFER",
    purpose: "OFFER_AVAILABLE",
    audience: open ? "OPEN" : "DIRECTED",
    expectedUserId,
    offerOwnerUserId: swap.fromUserId,
    offerOwnerProfessionalId: swap.fromProfessionalId,
    expectedSourceAssignmentId: swap.fromAssignmentId,
    expectedSwapVersion: swap.version,
    swapType: swap.type,
    expectedTargetShiftInstanceId: swap.toShiftInstanceId,
    institutionId: swap.institutionId,
    hospitalId: swap.hospitalId,
    sectorId: swap.sectorId,
    shiftInstanceId: swap.fromShiftInstanceId,
    swapRequestId: swap.id,
  };
}

function swapTakenAuthority(
  swap: SwapRow,
  approvedVersion: number,
): SwapTakenPushAuthority {
  const validTarget =
    swap.type === "SWAP"
      ? positiveId(swap.toShiftInstanceId) &&
        swap.toShiftInstanceId !== swap.fromShiftInstanceId &&
        positiveId(swap.toAssignmentId)
      : swap.toShiftInstanceId === null && swap.toAssignmentId === null;
  if (
    !positiveId(swap.id) ||
    !positiveId(swap.fromProfessionalId) ||
    !positiveId(swap.fromUserId) ||
    !positiveId(swap.fromAssignmentId) ||
    !positiveId(swap.toProfessionalId) ||
    !positiveId(swap.toUserId) ||
    swap.fromProfessionalId === swap.toProfessionalId ||
    swap.fromUserId === swap.toUserId ||
    !positiveId(swap.fromShiftInstanceId) ||
    !positiveId(swap.institutionId) ||
    !positiveId(swap.hospitalId) ||
    !positiveId(swap.sectorId) ||
    !positiveId(approvedVersion) ||
    !validTarget
  ) {
    throw new Error("Conclusão sem topologia canônica para o outbox de push");
  }
  const common = {
    kind: "SWAP_TAKEN",
    purpose: "OFFER_TAKEN",
    expectedUserId: swap.fromUserId,
    expectedOwnerProfessionalId: swap.fromProfessionalId,
    expectedTakerUserId: swap.toUserId,
    expectedTakerProfessionalId: swap.toProfessionalId,
    expectedSourceAssignmentId: swap.fromAssignmentId,
    expectedSwapVersion: approvedVersion,
    institutionId: swap.institutionId,
    hospitalId: swap.hospitalId,
    sectorId: swap.sectorId,
    shiftInstanceId: swap.fromShiftInstanceId,
    swapRequestId: swap.id,
  } as const;
  return swap.type === "SWAP"
    ? {
        ...common,
        swapType: "SWAP",
        expectedTargetShiftInstanceId: swap.toShiftInstanceId as number,
        expectedTargetAssignmentId: swap.toAssignmentId as number,
      }
    : {
        ...common,
        swapType: swap.type,
        expectedTargetShiftInstanceId: null,
        expectedTargetAssignmentId: null,
      };
}

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
  if (!positiveId(swap.sectorId)) {
    throw new Error("Oferta sem setor canônico para o outbox de push");
  }
  const userIds = await eligibleRecipientUserIdsForSwapOffer(db, swap);
  const copyContext = await resolveOfferCopyContext(db, input);
  const copy = swapOfferPushCopy(copyContext);
  let persisted = 0;
  for (const userId of userIds) {
    try {
      const authority = swapOfferAuthority(swap, userId);
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
              hospitalId: authority.hospitalId,
              sectorId: authority.sectorId,
              shiftInstanceId: swap.fromShiftInstanceId,
              userId,
            },
          },
          authority,
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

function takenCopy(type: SwapRow["type"]) {
  if (type === "SWAP") {
    return {
      title: "Troca concluída",
      body: "Sua troca de plantão foi concluída.",
    };
  }
  return {
    title: "Plantão assumido",
    body: "Seu plantão foi assumido.",
  };
}

/**
 * Avisa o ofertante de que o plantão foi assumido (sem pedir aprovação).
 * Mesma transação do aceite — falha de persistência aborta o take.
 */
export async function enqueueSwapTakenSignals(input: {
  db: EnqueueDb;
  swap: SwapRow;
  approvedVersion: number;
}): Promise<number> {
  const { db, swap } = input;
  const ownerUserId = swap.fromUserId;
  if (!positiveId(ownerUserId)) {
    throw new Error("Conclusão sem ofertante canônico para o outbox de push");
  }
  const copy = takenCopy(swap.type);
  const authority = swapTakenAuthority(swap, input.approvedVersion);
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
            hospitalId: authority.hospitalId,
            sectorId: authority.sectorId,
            shiftInstanceId: swap.fromShiftInstanceId,
            userId: ownerUserId,
          },
        },
        authority,
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
