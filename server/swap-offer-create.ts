/**
 * createSwapOffer — criação canônica de oferta de troca/cessão.
 *
 * Usado por `swaps.offer` (tRPC) e, no futuro, pelo webhook WhatsApp.
 * Toda topologia, lock, elegibilidade, auditoria e sinalização de push
 * passam por aqui — sem atalho de transporte.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./db";
import { swapRequests } from "../drizzle/schema";
import { recordAudit } from "./audit-trail";
import { lockAssignmentProfessionalsForUpdate } from "./shift-validations-v2";
import { enqueueSwapOfferSignals } from "./swap-offer-signal";
import {
  assertPublishedSwapMonthsForUpdate,
  assertSameSwapSchedulingSnapshot,
  assertSwapShiftsNotStarted,
  auditNames,
  isOneWay,
  lockSwapAssignmentsForUpdate,
  lockSwapShiftsForUpdate,
  requireCanonicalAssignmentTuple,
  requireCanonicalShift,
  requireCanonicalShiftOccupant,
  requireProfessionalCanReceiveShift,
  topologyDenied,
  type CanonicalProfessional,
  type MonthLockTarget,
  type ShiftRow,
  type SwapRow,
  type SwapType,
} from "./swap-domain";

export type CreateSwapOfferInput = {
  type: SwapType;
  fromShiftInstanceId: number;
  fromAssignmentId: number;
  toShiftInstanceId?: number;
  /** Oferta DIRECIONADA: só este profissional vê e pode aceitar. */
  toProfessionalId?: number;
  reason?: string;
  expiresInHours?: number;
};

export type CreateSwapOfferActor = {
  userId: number;
  professionalId: number;
  expectedSessionVersion: number;
  institutionId: number;
};

export type CreateSwapOfferResult = SwapRow;

/**
 * Cria oferta SWAP / CESSAO / TRANSFER (aberta ou dirigida).
 * Identidade vem do actor canônico — nunca de campos livres do cliente.
 */
export async function createSwapOffer(
  input: CreateSwapOfferInput,
  actor: CreateSwapOfferActor,
): Promise<CreateSwapOfferResult> {
  const db = await getDb();
  if (!db) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "DB unavailable",
    });
  }

  const userId = actor.userId;
  const expectedSessionVersion = actor.expectedSessionVersion;
  const institutionId = actor.institutionId;
  const expiresInHours = input.expiresInHours ?? 48;

  if (!actor.professionalId) {
    throw topologyDenied("Ator sem identidade profissional canônica");
  }
  if (isOneWay(input.type) && input.toShiftInstanceId !== undefined) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Cessão/repasse não aceita turno de contrapartida",
    });
  }
  if (
    input.type === "SWAP" &&
    (!input.toShiftInstanceId ||
      input.toShiftInstanceId === input.fromShiftInstanceId)
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "SWAP requer outro turno de contrapartida",
    });
  }

  const validateOfferTopology = async (conn: any, lockForUpdate: boolean) => {
    const source = await requireCanonicalAssignmentTuple(conn, {
      institutionId,
      shiftInstanceId: input.fromShiftInstanceId,
      assignmentId: input.fromAssignmentId,
      professionalId: actor.professionalId,
      userId,
      requireActive: true,
      lockForUpdate,
      expectedSessionVersion,
    });
    let toShift: ShiftRow | null = null;
    if (input.type === "SWAP" && input.toShiftInstanceId) {
      toShift = await requireCanonicalShift(conn, {
        institutionId,
        shiftInstanceId: input.toShiftInstanceId,
        lockForUpdate,
      });
      if (toShift.status !== "OCUPADO") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Turno de troca não está ocupado",
        });
      }
      await requireProfessionalCanReceiveShift(conn, {
        institutionId,
        professionalId: source.professional.professionalId,
        userId: source.professional.userId,
        shift: toShift,
        lockForUpdate,
        expectedSessionVersion,
      });
    }
    assertSwapShiftsNotStarted(source.shift, toShift);

    let target: CanonicalProfessional | null = null;
    let counterpart: CanonicalProfessional | null = null;
    if (input.toProfessionalId) {
      target = await requireProfessionalCanReceiveShift(conn, {
        institutionId,
        professionalId: input.toProfessionalId,
        shift: source.shift,
        lockForUpdate,
      });
      if (target.userId === userId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Não é possível direcionar a oferta a você mesmo",
        });
      }
      if (toShift) {
        await requireCanonicalAssignmentTuple(conn, {
          institutionId,
          shiftInstanceId: toShift.id,
          professionalId: target.professionalId,
          userId: target.userId,
          requireActive: true,
          lockForUpdate,
        });
      }
      counterpart = target;
    } else if (toShift) {
      counterpart = (
        await requireCanonicalShiftOccupant(conn, {
          shift: toShift,
          lockForUpdate,
        })
      ).professional;
    }
    return { source, toShift, target, counterpart };
  };

  const preflight = await validateOfferTopology(db, false);
  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);

  const offerAudit = auditNames(input.type, "OFFERED");
  const offerDescription =
    input.type === "SWAP"
      ? `Troca oferecida: turno #${input.fromShiftInstanceId} ↔ turno #${input.toShiftInstanceId}`
      : `${offerAudit.label} oferecida: turno #${input.fromShiftInstanceId}`;

  return db.transaction(async (tx) => {
    const monthTargets: MonthLockTarget[] = [
      {
        institutionId: preflight.source.shift.institutionId,
        hospitalId: preflight.source.shift.hospitalId,
        date: preflight.source.shift.startAt,
      },
    ];
    if (preflight.toShift) {
      monthTargets.push({
        institutionId: preflight.toShift.institutionId,
        hospitalId: preflight.toShift.hospitalId,
        date: preflight.toShift.startAt,
      });
    }
    // Unicidade LIVE (≤1 PENDING|ACCEPTED por fromAssignmentId): o mutex
    // é este par FOR UPDATE (mês, depois turno de origem), não UNIQUE SQL
    // nem o SELECT de existência abaixo. Em REPEATABLE READ o primeiro
    // SELECT consistente da transação não pode ocorrer ANTES destes locks
    // — se ocorrer, o waiter reusa snapshot vazio e o INSERT duplica.
    // Não reordenar sem prova de concorrência MySQL.
    await assertPublishedSwapMonthsForUpdate(tx, monthTargets);
    await lockSwapShiftsForUpdate(tx, institutionId, [
      input.fromShiftInstanceId,
      input.toShiftInstanceId,
    ]);
    const assignmentProfessionalIds = await lockSwapAssignmentsForUpdate(
      tx,
      institutionId,
      [input.fromShiftInstanceId, input.toShiftInstanceId],
    );
    await lockAssignmentProfessionalsForUpdate(
      tx,
      [
        ...assignmentProfessionalIds,
        preflight.source.professional.professionalId,
        preflight.counterpart?.professionalId,
      ].filter((id): id is number => typeof id === "number"),
    );
    const locked = await validateOfferTopology(tx, true);
    assertSameSwapSchedulingSnapshot(
      preflight.source.shift,
      locked.source.shift,
      preflight.toShift,
      locked.toShift,
      "A topologia do plantão mudou enquanto a oferta era criada.",
    );

    const [openOffer] = await tx
      .select({ id: swapRequests.id })
      .from(swapRequests)
      .where(
        and(
          eq(swapRequests.fromAssignmentId, input.fromAssignmentId),
          eq(swapRequests.institutionId, institutionId),
          inArray(swapRequests.status, ["PENDING", "ACCEPTED"]),
        ),
      )
      .limit(1);
    if (openOffer) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "Já existe uma oferta aberta para este plantão. Cancele-a antes de criar outra.",
      });
    }

    const [result] = await tx.insert(swapRequests).values({
      type: input.type,
      status: "PENDING",
      fromProfessionalId: locked.source.professional.professionalId,
      fromUserId: userId,
      fromShiftInstanceId: locked.source.shift.id,
      fromAssignmentId: locked.source.assignmentId,
      toShiftInstanceId: locked.toShift?.id ?? null,
      toProfessionalId: locked.target?.professionalId ?? null,
      toUserId: locked.target?.userId ?? null,
      institutionId: locked.source.shift.institutionId,
      hospitalId: locked.source.shift.hospitalId,
      sectorId: locked.source.shift.sectorId,
      reason: input.reason ?? null,
      expiresAt,
    });
    const createdId = Number(result.insertId);
    await recordAudit(
      {
        action: offerAudit.action,
        entityType: offerAudit.entityType,
        entityId: createdId,
        actorUserId: userId,
        actorRole: locked.source.professional.roleInInstitution,
        actorName: locked.source.professional.name,
        description: offerDescription,
        fromProfessionalId: locked.source.professional.professionalId,
        fromUserId: userId,
        shiftInstanceId: locked.source.shift.id,
        hospitalId: locked.source.shift.hospitalId,
        sectorId: locked.source.shift.sectorId,
        institutionId: locked.source.shift.institutionId,
        metadata: { type: input.type, reason: input.reason },
      },
      { db: tx, strict: true },
    );
    const [created] = await tx
      .select()
      .from(swapRequests)
      .where(eq(swapRequests.id, createdId))
      .limit(1);
    if (!created) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Oferta criada sem snapshot transacional de retorno",
      });
    }
    await enqueueSwapOfferSignals({
      db: tx,
      swap: created,
      shiftLabel: locked.source.shift.label,
      startAt: locked.source.shift.startAt,
    });
    return created;
  });
}
