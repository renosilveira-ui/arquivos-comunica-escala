// server/sso/duty-sync-lifecycle.ts — intenções WITHDRAW/CONFIRM derivadas
// de mutações canônicas (desistência já coberta no confirmation-router;
// remoção, vago, troca efetivada, edição temporal).
//
// CONFIRM declara [dutyStart, dutyEnd). WITHDRAW anula essa declaração.
// Presença ativa continua sendo derivada no Comunica+ pelo relógio.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { dutyConfirmations, shiftInstances, users } from "../../drizzle/schema";
import { getDb } from "../db";
import type { DutyShiftSnapshot } from "../confirmation-integrity";
import {
  canonicalizeDutySyncExternalSubject,
  DUTY_SYNC_MISSING_EXTERNAL_SUBJECT_REASON,
  enqueueDutySync,
  type DutySyncExternalSubjectBinding,
} from "./duty-sync";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
export type DutySyncLifecycleTx = Pick<Db, "insert" | "select" | "update">;

type ConfirmationStatus = typeof dutyConfirmations.$inferSelect.status;

export const DUTY_SYNC_DECLARED_STATUSES = [
  "CONFIRMED",
  "AUTO_CONFIRMED",
  "REPLACEMENT_CONFIRMED",
] as const satisfies readonly ConfirmationStatus[];

export const DUTY_SYNC_WITHDRAW_EXPECTED_STATUSES = [
  "DECLINED",
  "NOMINATED",
  "REPLACEMENT_DECLINED",
  "REPLACEMENT_CONFIRMED",
  "CONFIRMED",
  "AUTO_CONFIRMED",
] as const satisfies readonly ConfirmationStatus[];

type DeclaredStatus = (typeof DUTY_SYNC_DECLARED_STATUSES)[number];

type DeclaredConfirmation = {
  id: number;
  status: DeclaredStatus;
  userId: number;
  professionalId: number;
  replacementUserId: number | null;
  replacementProfessionalId: number | null;
};

function isDeclaredStatus(status: ConfirmationStatus): status is DeclaredStatus {
  return (DUTY_SYNC_DECLARED_STATUSES as readonly string[]).includes(status);
}

export function dutySyncWithdrawDedupKey(
  confirmationId: number,
  targetUserId: number,
): string {
  return `duty-confirmation:${confirmationId}:duty-sync:withdraw:${targetUserId}`;
}

export function dutySyncConfirmDedupKey(
  confirmationId: number,
  targetUserId: number,
): string {
  return `duty-confirmation:${confirmationId}:duty-sync:confirmed:${targetUserId}`;
}

export function dutySyncReplacementConfirmDedupKey(
  confirmationId: number,
  targetUserId: number,
): string {
  return `duty-confirmation:${confirmationId}:duty-sync:replacement-confirmed:${targetUserId}`;
}

export function dutySyncIntervalConfirmDedupKey(
  confirmationId: number,
  targetUserId: number,
  dutyStart: string,
): string {
  return `duty-confirmation:${confirmationId}:duty-sync:confirmed:${targetUserId}:interval:${dutyStart}`;
}

export function dutySyncIntervalWithdrawDedupKey(
  confirmationId: number,
  targetUserId: number,
  dutyStart: string,
): string {
  return `duty-confirmation:${confirmationId}:duty-sync:withdraw:${targetUserId}:interval:${dutyStart}`;
}

function dutyTypeFromModality(
  modality: typeof shiftInstances.$inferSelect.modality,
): "PLANTAO" | "SOBREAVISO" {
  return modality === "SOBREAVISO" ? "SOBREAVISO" : "PLANTAO";
}

function snapshotFromShift(shift: {
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  label: string;
  startAt: Date;
  endAt: Date;
}): DutyShiftSnapshot {
  return {
    institutionId: shift.institutionId,
    hospitalId: shift.hospitalId,
    sectorId: shift.sectorId,
    label: shift.label,
    startAt: shift.startAt.toISOString(),
    endAt: shift.endAt.toISOString(),
  };
}

async function resolveApprovedExternalSubject(
  db: Pick<Db, "select">,
  userId: number,
): Promise<DutySyncExternalSubjectBinding> {
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(
      and(
        eq(users.id, userId),
        eq(users.approvalStatus, "APPROVED"),
        isNull(users.deletedAt),
      ),
    )
    .limit(1)
    .for("update");
  const externalSubject = canonicalizeDutySyncExternalSubject(user?.email);
  return externalSubject
    ? { externalSubject }
    : {
        externalSubjectUnavailableReason:
          DUTY_SYNC_MISSING_EXTERNAL_SUBJECT_REASON,
      };
}

function effectiveDeclaredTarget(
  row: DeclaredConfirmation,
): { targetUserId: number; confirmationStatus: DeclaredStatus } | null {
  if (row.status === "REPLACEMENT_CONFIRMED") {
    if (!row.replacementUserId) return null;
    return {
      targetUserId: row.replacementUserId,
      confirmationStatus: row.status,
    };
  }
  return {
    targetUserId: row.userId,
    confirmationStatus: row.status,
  };
}

function confirmationMatchesProfessional(
  row: DeclaredConfirmation,
  professionalIds: ReadonlySet<number>,
): boolean {
  if (professionalIds.size === 0) return true;
  if (row.status === "REPLACEMENT_CONFIRMED") {
    return (
      row.replacementProfessionalId != null &&
      professionalIds.has(row.replacementProfessionalId)
    );
  }
  return professionalIds.has(row.professionalId);
}

async function loadDeclaredConfirmations(
  tx: DutySyncLifecycleTx,
  input: {
    institutionId: number;
    shiftInstanceId: number;
    professionalIds?: readonly number[];
  },
): Promise<DeclaredConfirmation[]> {
  const rows = await tx
    .select({
      id: dutyConfirmations.id,
      status: dutyConfirmations.status,
      userId: dutyConfirmations.userId,
      professionalId: dutyConfirmations.professionalId,
      replacementUserId: dutyConfirmations.replacementUserId,
      replacementProfessionalId: dutyConfirmations.replacementProfessionalId,
    })
    .from(dutyConfirmations)
    .where(
      and(
        eq(dutyConfirmations.institutionId, input.institutionId),
        eq(dutyConfirmations.shiftInstanceId, input.shiftInstanceId),
        inArray(dutyConfirmations.status, DUTY_SYNC_DECLARED_STATUSES),
      ),
    );
  const professionalIds = input.professionalIds
    ? new Set(input.professionalIds)
    : new Set<number>();
  const declared: DeclaredConfirmation[] = [];
  for (const row of rows) {
    if (!isDeclaredStatus(row.status)) continue;
    const item: DeclaredConfirmation = {
      id: row.id,
      status: row.status,
      userId: row.userId,
      professionalId: row.professionalId,
      replacementUserId: row.replacementUserId,
      replacementProfessionalId: row.replacementProfessionalId,
    };
    if (!confirmationMatchesProfessional(item, professionalIds)) continue;
    declared.push(item);
  }
  return declared;
}

async function loadShiftEnvelope(
  tx: DutySyncLifecycleTx,
  input: { institutionId: number; shiftInstanceId: number },
): Promise<{
  snapshot: DutyShiftSnapshot;
  dutyType: "PLANTAO" | "SOBREAVISO";
  serviceName: string | null;
} | null> {
  const [shift] = await tx
    .select({
      institutionId: shiftInstances.institutionId,
      hospitalId: shiftInstances.hospitalId,
      sectorId: shiftInstances.sectorId,
      label: shiftInstances.label,
      startAt: shiftInstances.startAt,
      endAt: shiftInstances.endAt,
      modality: shiftInstances.modality,
      specialty: shiftInstances.specialty,
    })
    .from(shiftInstances)
    .where(
      and(
        eq(shiftInstances.id, input.shiftInstanceId),
        eq(shiftInstances.institutionId, input.institutionId),
      ),
    )
    .limit(1);
  if (!shift) return null;
  return {
    snapshot: snapshotFromShift(shift),
    dutyType: dutyTypeFromModality(shift.modality),
    serviceName: shift.specialty,
  };
}

export async function enqueueDutySyncWithdrawIntent(
  tx: DutySyncLifecycleTx,
  input: {
    confirmationId: number;
    institutionId: number;
    shiftInstanceId: number;
    targetUserId: number;
    shiftSnapshot: DutyShiftSnapshot;
    confirmationStatus: ConfirmationStatus;
    dutyType: "PLANTAO" | "SOBREAVISO";
    serviceName?: string | null;
    dedupKey?: string;
  },
  now = new Date(),
): Promise<number> {
  const externalSubjectBinding = await resolveApprovedExternalSubject(
    tx,
    input.targetUserId,
  );
  return enqueueDutySync(
    {
      confirmationId: input.confirmationId,
      institutionId: input.institutionId,
      shiftInstanceId: input.shiftInstanceId,
      targetUserId: input.targetUserId,
      ...externalSubjectBinding,
      shiftSnapshot: input.shiftSnapshot,
      action: "WITHDRAW",
      confirmationStatus: input.confirmationStatus,
      expectedStatuses: [...DUTY_SYNC_WITHDRAW_EXPECTED_STATUSES],
      dutyType: input.dutyType,
      serviceName: input.serviceName,
      dedupKey:
        input.dedupKey ??
        dutySyncWithdrawDedupKey(input.confirmationId, input.targetUserId),
    },
    now,
    tx,
  );
}

async function enqueueDutySyncConfirmIntent(
  tx: DutySyncLifecycleTx,
  input: {
    confirmationId: number;
    institutionId: number;
    shiftInstanceId: number;
    targetUserId: number;
    shiftSnapshot: DutyShiftSnapshot;
    confirmationStatus: "CONFIRMED" | "REPLACEMENT_CONFIRMED";
    dutyType: "PLANTAO" | "SOBREAVISO";
    serviceName?: string | null;
    dedupKey: string;
  },
  now = new Date(),
): Promise<number> {
  const externalSubjectBinding = await resolveApprovedExternalSubject(
    tx,
    input.targetUserId,
  );
  return enqueueDutySync(
    {
      confirmationId: input.confirmationId,
      institutionId: input.institutionId,
      shiftInstanceId: input.shiftInstanceId,
      targetUserId: input.targetUserId,
      ...externalSubjectBinding,
      shiftSnapshot: input.shiftSnapshot,
      action: "CONFIRM",
      confirmationStatus: input.confirmationStatus,
      expectedStatuses:
        input.confirmationStatus === "REPLACEMENT_CONFIRMED"
          ? ["REPLACEMENT_CONFIRMED"]
          : ["CONFIRMED"],
      dutyType: input.dutyType,
      serviceName: input.serviceName,
      dedupKey: input.dedupKey,
    },
    now,
    tx,
  );
}

/**
 * Compensação durável: se o profissional removido tinha declaração vigente
 * (CONFIRM enviado ou legado AUTO_CONFIRMED), emite WITHDRAW do sujeito
 * efetivo. Alocação PENDING/DECLINED/NOMINATED sem declaração não gera
 * WITHDRAW. professionalIds vazio = todas as declarações do turno (vago).
 */
export async function enqueueDutySyncWithdrawsForRemovedProfessionals(
  tx: DutySyncLifecycleTx,
  input: {
    institutionId: number;
    shiftInstanceId: number;
    professionalIds?: readonly number[];
  },
  now = new Date(),
): Promise<number> {
  const envelope = await loadShiftEnvelope(tx, input);
  if (!envelope) return 0;
  const declared = await loadDeclaredConfirmations(tx, input);
  let enqueued = 0;
  for (const row of declared) {
    const target = effectiveDeclaredTarget(row);
    if (!target) continue;
    await enqueueDutySyncWithdrawIntent(
      tx,
      {
        confirmationId: row.id,
        institutionId: input.institutionId,
        shiftInstanceId: input.shiftInstanceId,
        targetUserId: target.targetUserId,
        shiftSnapshot: envelope.snapshot,
        confirmationStatus: target.confirmationStatus,
        dutyType: envelope.dutyType,
        serviceName: envelope.serviceName,
      },
      now,
    );
    enqueued += 1;
  }
  return enqueued;
}

/**
 * Edição temporal: a chave natural do Comunica+ inclui dutyStart.
 * WITHDRAW o intervalo antigo e, se a declaração local continua vigente,
 * CONFIRM o intervalo novo. Ordenação: WITHDRAW primeiro (mesmo confirmationId).
 */
export async function enqueueDutySyncIntervalRewrite(
  tx: DutySyncLifecycleTx,
  input: {
    institutionId: number;
    shiftInstanceId: number;
    previousSnapshot: DutyShiftSnapshot;
    nextSnapshot: DutyShiftSnapshot;
    previousDutyType: "PLANTAO" | "SOBREAVISO";
    nextDutyType: "PLANTAO" | "SOBREAVISO";
    previousServiceName?: string | null;
    nextServiceName?: string | null;
  },
  now = new Date(),
): Promise<number> {
  const declared = await loadDeclaredConfirmations(tx, {
    institutionId: input.institutionId,
    shiftInstanceId: input.shiftInstanceId,
  });
  let enqueued = 0;
  for (const row of declared) {
    const target = effectiveDeclaredTarget(row);
    if (!target) continue;
    await enqueueDutySyncWithdrawIntent(
      tx,
      {
        confirmationId: row.id,
        institutionId: input.institutionId,
        shiftInstanceId: input.shiftInstanceId,
        targetUserId: target.targetUserId,
        shiftSnapshot: input.previousSnapshot,
        confirmationStatus: target.confirmationStatus,
        dutyType: input.previousDutyType,
        serviceName: input.previousServiceName,
        dedupKey: dutySyncIntervalWithdrawDedupKey(
          row.id,
          target.targetUserId,
          input.previousSnapshot.startAt,
        ),
      },
      now,
    );
    if (
      row.status === "CONFIRMED" ||
      row.status === "REPLACEMENT_CONFIRMED"
    ) {
      await enqueueDutySyncConfirmIntent(
        tx,
        {
          confirmationId: row.id,
          institutionId: input.institutionId,
          shiftInstanceId: input.shiftInstanceId,
          targetUserId: target.targetUserId,
          shiftSnapshot: input.nextSnapshot,
          confirmationStatus: row.status,
          dutyType: input.nextDutyType,
          serviceName: input.nextServiceName,
          dedupKey: dutySyncIntervalConfirmDedupKey(
            row.id,
            target.targetUserId,
            input.nextSnapshot.startAt,
          ),
        },
        now,
      );
    }
    enqueued += 1;
  }
  return enqueued;
}
