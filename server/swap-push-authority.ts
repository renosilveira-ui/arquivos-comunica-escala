import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import {
  monthlyRosters,
  professionalInstitutions,
  professionals,
  shiftAssignmentsV2,
  shiftInstances,
  swapRequests,
  users,
} from "../drizzle/schema";
import { rowsFromExecute } from "./_core/db-results";
import type { getDb } from "./db";
import {
  isRecipientUserEligibleForSwapOffer,
  type SwapOfferAudience,
} from "./swap-offer-eligibility";
import { plantonistaAccessCoversShiftSql } from "./plantonista-shift-eligibility";
import { PersistedPushAuthorityBindingError } from "./push-authority-rejection";
import { yearMonthBrt } from "./local-time";

type SwapType = "SWAP" | "TRANSFER" | "CESSAO";

export type SwapOfferPushAuthority = {
  kind: "SWAP_OFFER";
  purpose: "OFFER_AVAILABLE";
  audience: SwapOfferAudience;
  expectedUserId: number;
  offerOwnerUserId: number;
  offerOwnerProfessionalId: number;
  expectedSourceAssignmentId: number;
  expectedSwapVersion: number;
  swapType: SwapType;
  expectedTargetShiftInstanceId: number | null;
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  shiftInstanceId: number;
  swapRequestId: number;
};

type SwapTakenPushAuthorityBase = {
  kind: "SWAP_TAKEN";
  purpose: "OFFER_TAKEN";
  swapType: SwapType;
  expectedUserId: number;
  expectedOwnerProfessionalId: number;
  expectedTakerUserId: number;
  expectedTakerProfessionalId: number;
  expectedSourceAssignmentId: number;
  expectedSwapVersion: number;
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  shiftInstanceId: number;
  swapRequestId: number;
};

export type SwapTakenPushAuthority = SwapTakenPushAuthorityBase &
  (
    | {
        swapType: "SWAP";
        expectedTargetShiftInstanceId: number;
        expectedTargetAssignmentId: number;
      }
    | {
        swapType: "TRANSFER" | "CESSAO";
        expectedTargetShiftInstanceId: null;
        expectedTargetAssignmentId: null;
      }
  );

export type SwapPushAuthority = SwapOfferPushAuthority | SwapTakenPushAuthority;

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type AuthorityDb = Pick<Db, "execute" | "select">;

function positiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function positiveVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isSwapType(value: unknown): value is SwapType {
  return value === "SWAP" || value === "TRANSFER" || value === "CESSAO";
}

export function parseSwapPushAuthority(
  value: Readonly<Record<string, unknown>>,
): SwapPushAuthority | null {
  const common =
    positiveId(value.expectedUserId) &&
    positiveId(value.institutionId) &&
    positiveId(value.hospitalId) &&
    positiveId(value.sectorId) &&
    positiveId(value.shiftInstanceId) &&
    positiveId(value.swapRequestId);
  if (!common) return null;
  if (
    value.kind === "SWAP_OFFER" &&
    value.purpose === "OFFER_AVAILABLE" &&
    (value.audience === "OPEN" || value.audience === "DIRECTED") &&
    positiveId(value.offerOwnerUserId) &&
    positiveId(value.offerOwnerProfessionalId) &&
    positiveId(value.expectedSourceAssignmentId) &&
    value.expectedUserId !== value.offerOwnerUserId &&
    positiveVersion(value.expectedSwapVersion) &&
    isSwapType(value.swapType) &&
    (value.swapType === "SWAP"
      ? positiveId(value.expectedTargetShiftInstanceId) &&
        value.expectedTargetShiftInstanceId !== value.shiftInstanceId
      : value.expectedTargetShiftInstanceId === null)
  ) {
    return value as SwapOfferPushAuthority;
  }
  if (
    value.kind === "SWAP_TAKEN" &&
    value.purpose === "OFFER_TAKEN" &&
    isSwapType(value.swapType) &&
    positiveId(value.expectedOwnerProfessionalId) &&
    positiveId(value.expectedTakerUserId) &&
    positiveId(value.expectedTakerProfessionalId) &&
    positiveId(value.expectedSourceAssignmentId) &&
    value.expectedUserId !== value.expectedTakerUserId &&
    value.expectedOwnerProfessionalId !== value.expectedTakerProfessionalId &&
    (value.swapType === "SWAP"
      ? positiveId(value.expectedTargetShiftInstanceId) &&
        positiveId(value.expectedTargetAssignmentId) &&
        value.expectedTargetShiftInstanceId !== value.shiftInstanceId
      : value.expectedTargetShiftInstanceId === null &&
        value.expectedTargetAssignmentId === null) &&
    positiveVersion(value.expectedSwapVersion)
  ) {
    return value as SwapTakenPushAuthority;
  }
  return null;
}

export function swapPushAuthorityMatchesPayload(
  authority: SwapPushAuthority,
  payloadData: Readonly<Record<string, unknown>>,
): boolean {
  const expectedType =
    authority.kind === "SWAP_OFFER" ? "swap_offer" : "swap_taken";
  return (
    payloadData.type === expectedType &&
    payloadData.institutionId === authority.institutionId &&
    payloadData.hospitalId === authority.hospitalId &&
    payloadData.sectorId === authority.sectorId &&
    payloadData.shiftInstanceId === authority.shiftInstanceId &&
    payloadData.swapRequestId === authority.swapRequestId &&
    payloadData.userId === authority.expectedUserId
  );
}

export function isSwapPushPayload(
  payloadData: Readonly<Record<string, unknown>>,
): boolean {
  return payloadData.type === "swap_offer" || payloadData.type === "swap_taken";
}

type ShiftLockSnapshot = Readonly<{
  id: number;
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  scheduleContextId: number | null;
  status: string;
  startAt: Date;
  endAt: Date;
}>;

async function loadShiftLockSnapshot(
  db: AuthorityDb,
  institutionId: number,
  shiftInstanceId: number,
  lockForShare: boolean,
): Promise<ShiftLockSnapshot | null> {
  const query = db
    .select({
      id: shiftInstances.id,
      institutionId: shiftInstances.institutionId,
      hospitalId: shiftInstances.hospitalId,
      sectorId: shiftInstances.sectorId,
      scheduleContextId: shiftInstances.scheduleContextId,
      status: shiftInstances.status,
      startAt: shiftInstances.startAt,
      endAt: shiftInstances.endAt,
    })
    .from(shiftInstances)
    .where(
      and(
        eq(shiftInstances.id, shiftInstanceId),
        eq(shiftInstances.institutionId, institutionId),
      ),
    )
    .limit(1);
  const rows = lockForShare ? await query.for("share") : await query;
  return rows[0] ?? null;
}

function sameShiftLockSnapshot(
  before: ShiftLockSnapshot,
  current: ShiftLockSnapshot,
): boolean {
  return (
    before.id === current.id &&
    before.institutionId === current.institutionId &&
    before.hospitalId === current.hospitalId &&
    before.sectorId === current.sectorId &&
    before.scheduleContextId === current.scheduleContextId &&
    before.status === current.status &&
    before.startAt.getTime() === current.startAt.getTime() &&
    before.endAt.getTime() === current.endAt.getTime()
  );
}

type ParticipantIdentitySnapshot = Readonly<{
  membershipId: number;
  professionalId: number;
  userId: number;
}>;

async function loadParticipantIdentitySnapshots(
  db: AuthorityDb,
  authority: SwapPushAuthority,
): Promise<ParticipantIdentitySnapshot[]> {
  const expectedUserIds =
    authority.kind === "SWAP_OFFER"
      ? [authority.offerOwnerUserId, authority.expectedUserId]
      : [authority.expectedUserId, authority.expectedTakerUserId];
  const rows = await db
    .select({
      membershipId: professionalInstitutions.id,
      professionalId: professionalInstitutions.professionalId,
      userId: professionalInstitutions.userId,
    })
    .from(professionalInstitutions)
    .where(
      and(
        eq(professionalInstitutions.institutionId, authority.institutionId),
        inArray(professionalInstitutions.userId, expectedUserIds),
      ),
    );
  const byUserId = new Map(rows.map((row) => [row.userId, row]));
  const ownerProfessionalId =
    authority.kind === "SWAP_OFFER"
      ? authority.offerOwnerProfessionalId
      : authority.expectedOwnerProfessionalId;
  const owner = byUserId.get(
    authority.kind === "SWAP_OFFER"
      ? authority.offerOwnerUserId
      : authority.expectedUserId,
  );
  const recipient = byUserId.get(
    authority.kind === "SWAP_OFFER"
      ? authority.expectedUserId
      : authority.expectedTakerUserId,
  );
  if (
    rows.length !== 2 ||
    byUserId.size !== 2 ||
    !owner ||
    owner.professionalId !== ownerProfessionalId ||
    !recipient ||
    (authority.kind === "SWAP_TAKEN" &&
      recipient.professionalId !== authority.expectedTakerProfessionalId)
  ) {
    throw new PersistedPushAuthorityBindingError(
      "Identidades da oferta não correspondem mais ao vínculo institucional",
    );
  }
  return [owner, recipient];
}

/**
 * Continua a ordem global do motor de trocas depois de mês→swap→turno:
 * alocações por id → users por id → professionals por id → vínculos por id.
 * Os locks exclusivos de identidade evitam upgrade SHARE→UPDATE cruzado entre
 * duas notificações recíprocas; a transação é curta e termina antes da rede.
 */
async function lockSwapAssignmentsAndIdentities(
  db: AuthorityDb,
  authority: SwapPushAuthority,
  shifts: readonly ShiftLockSnapshot[],
): Promise<void> {
  const shiftIds = shifts.map((shift) => shift.id);
  const participants = await loadParticipantIdentitySnapshots(db, authority);
  const participantProfessionalIds = participants.map(
    (participant) => participant.professionalId,
  );
  const assignmentSnapshots = await db
    .select({
      id: shiftAssignmentsV2.id,
      professionalId: shiftAssignmentsV2.professionalId,
    })
    .from(shiftAssignmentsV2)
    .innerJoin(
      shiftInstances,
      eq(shiftInstances.id, shiftAssignmentsV2.shiftInstanceId),
    )
    .where(
      or(
        inArray(shiftAssignmentsV2.shiftInstanceId, shiftIds),
        and(
          inArray(
            shiftAssignmentsV2.professionalId,
            participantProfessionalIds,
          ),
          eq(shiftAssignmentsV2.isActive, true),
          or(
            ...shifts.map((shift) =>
              and(
                lt(shiftInstances.startAt, shift.endAt),
                gt(shiftInstances.endAt, shift.startAt),
              ),
            ),
          ),
        ),
      ),
    );
  const orderedAssignmentSnapshots = [...assignmentSnapshots].sort(
    (left, right) => left.id - right.id,
  );
  if (orderedAssignmentSnapshots.length > 0) {
    const current = await db
      .select({
        id: shiftAssignmentsV2.id,
        professionalId: shiftAssignmentsV2.professionalId,
      })
      .from(shiftAssignmentsV2)
      .where(
        inArray(
          shiftAssignmentsV2.id,
          orderedAssignmentSnapshots.map((snapshot) => snapshot.id),
        ),
      )
      .orderBy(asc(shiftAssignmentsV2.id))
      .for("share");
    if (
      current.length !== orderedAssignmentSnapshots.length ||
      current.some(
        (row, index) =>
          row.id !== orderedAssignmentSnapshots[index]?.id ||
          row.professionalId !==
            orderedAssignmentSnapshots[index]?.professionalId,
      )
    ) {
      throw new Error("As alocações mudaram durante a validação do push");
    }
  }

  const professionalIds = [
    ...new Set([
      ...participantProfessionalIds,
      ...assignmentSnapshots.map((assignment) => assignment.professionalId),
    ]),
  ].sort((left, right) => left - right);
  const professionalSnapshots = await db
    .select({ id: professionals.id, userId: professionals.userId })
    .from(professionals)
    .where(inArray(professionals.id, professionalIds));
  if (professionalSnapshots.length !== professionalIds.length) {
    throw new PersistedPushAuthorityBindingError(
      "Identidade profissional da oferta não existe mais",
    );
  }
  const userIds = [
    ...new Set(professionalSnapshots.map((snapshot) => snapshot.userId)),
  ].sort((left, right) => left - right);
  for (const userId of userIds) {
    const [current] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .for("update");
    if (!current) {
      throw new PersistedPushAuthorityBindingError(
        "Conta profissional da oferta não existe mais",
      );
    }
  }
  const professionalById = new Map(
    professionalSnapshots.map((snapshot) => [snapshot.id, snapshot]),
  );
  for (const professionalId of professionalIds) {
    const snapshot = professionalById.get(professionalId)!;
    const [current] = await db
      .select({ id: professionals.id, userId: professionals.userId })
      .from(professionals)
      .where(
        and(
          eq(professionals.id, professionalId),
          eq(professionals.userId, snapshot.userId),
        ),
      )
      .limit(1)
      .for("update");
    if (!current) {
      throw new PersistedPushAuthorityBindingError(
        "Identidade profissional mudou durante a validação do push",
      );
    }
  }
  for (const participant of [...participants].sort(
    (left, right) => left.membershipId - right.membershipId,
  )) {
    const [current] = await db
      .select({ id: professionalInstitutions.id })
      .from(professionalInstitutions)
      .where(
        and(
          eq(professionalInstitutions.id, participant.membershipId),
          eq(professionalInstitutions.institutionId, authority.institutionId),
          eq(
            professionalInstitutions.professionalId,
            participant.professionalId,
          ),
          eq(professionalInstitutions.userId, participant.userId),
        ),
      )
      .limit(1)
      .for("update");
    if (!current) {
      throw new PersistedPushAuthorityBindingError(
        "Vínculo institucional mudou durante a validação do push",
      );
    }
  }
}

/**
 * Ordem compatível com o motor de trocas: meses → solicitação → turnos.
 * Evita o ciclo roster↔swap entre o guard do push e um aceite concorrente.
 * O primeiro snapshot é apenas para descobrir os meses; toda a topologia é
 * relida sob lock e uma corrida transitória volta à fila, sem liberar texto.
 */
async function lockSwapDeliveryRows(
  db: AuthorityDb,
  authority: SwapPushAuthority,
): Promise<void> {
  if (
    !parseSwapPushAuthority(authority as unknown as Record<string, unknown>)
  ) {
    throw new PersistedPushAuthorityBindingError(
      "Autoridade persistida da oferta tem formato inválido",
    );
  }
  const shiftIds = [
    authority.shiftInstanceId,
    authority.expectedTargetShiftInstanceId,
  ]
    .filter((id): id is number => id !== null)
    .filter((id, index, all) => all.indexOf(id) === index)
    .sort((left, right) => left - right);
  const beforeById = new Map<number, ShiftLockSnapshot>();
  for (const shiftId of shiftIds) {
    const shift = await loadShiftLockSnapshot(
      db,
      authority.institutionId,
      shiftId,
      false,
    );
    if (!shift) {
      throw new PersistedPushAuthorityBindingError(
        "Plantão da oferta não existe mais na instituição esperada",
      );
    }
    if (
      shiftId === authority.shiftInstanceId &&
      (shift.hospitalId !== authority.hospitalId ||
        shift.sectorId !== authority.sectorId)
    ) {
      throw new PersistedPushAuthorityBindingError(
        "Plantão da oferta saiu da topologia persistida",
      );
    }
    beforeById.set(shiftId, shift);
  }

  const rosterTargets = [
    ...new Map(
      [...beforeById.values()].map((shift) => {
        const yearMonth = yearMonthBrt(shift.startAt);
        return [
          `${shift.institutionId}:${shift.hospitalId}:${yearMonth}`,
          {
            institutionId: shift.institutionId,
            hospitalId: shift.hospitalId,
            yearMonth,
          },
        ] as const;
      }),
    ).values(),
  ].sort(
    (left, right) =>
      left.institutionId - right.institutionId ||
      left.hospitalId - right.hospitalId ||
      left.yearMonth.localeCompare(right.yearMonth),
  );
  for (const target of rosterTargets) {
    const [roster] = await db
      .select({ status: monthlyRosters.status })
      .from(monthlyRosters)
      .where(
        and(
          eq(monthlyRosters.institutionId, target.institutionId),
          eq(monthlyRosters.hospitalId, target.hospitalId),
          eq(monthlyRosters.yearMonth, target.yearMonth),
        ),
      )
      .limit(1)
      .for("share");
    const statusAllowed =
      authority.kind === "SWAP_OFFER"
        ? roster?.status === "PUBLISHED"
        : roster?.status === "PUBLISHED" || roster?.status === "LOCKED";
    if (!statusAllowed) {
      throw new PersistedPushAuthorityBindingError(
        "Escala da oferta não está mais em estado operacional notificável",
      );
    }
  }

  const swapConditions = [
    eq(swapRequests.id, authority.swapRequestId),
    eq(swapRequests.institutionId, authority.institutionId),
    eq(swapRequests.hospitalId, authority.hospitalId),
    eq(swapRequests.sectorId, authority.sectorId),
    eq(swapRequests.fromShiftInstanceId, authority.shiftInstanceId),
    eq(swapRequests.fromAssignmentId, authority.expectedSourceAssignmentId),
    eq(swapRequests.version, authority.expectedSwapVersion),
    eq(swapRequests.type, authority.swapType),
  ];
  if (authority.kind === "SWAP_OFFER") {
    swapConditions.push(
      eq(swapRequests.status, "PENDING"),
      eq(swapRequests.fromUserId, authority.offerOwnerUserId),
      eq(swapRequests.fromProfessionalId, authority.offerOwnerProfessionalId),
      authority.audience === "OPEN"
        ? isNull(swapRequests.toUserId)
        : eq(swapRequests.toUserId, authority.expectedUserId),
      authority.audience === "OPEN"
        ? isNull(swapRequests.toProfessionalId)
        : sql`${swapRequests.toProfessionalId} IS NOT NULL`,
    );
  } else {
    swapConditions.push(
      eq(swapRequests.status, "APPROVED"),
      eq(swapRequests.fromUserId, authority.expectedUserId),
      eq(
        swapRequests.fromProfessionalId,
        authority.expectedOwnerProfessionalId,
      ),
      eq(swapRequests.toUserId, authority.expectedTakerUserId),
      eq(swapRequests.toProfessionalId, authority.expectedTakerProfessionalId),
    );
  }
  swapConditions.push(
    authority.expectedTargetShiftInstanceId === null
      ? isNull(swapRequests.toShiftInstanceId)
      : eq(
          swapRequests.toShiftInstanceId,
          authority.expectedTargetShiftInstanceId,
        ),
  );
  if (authority.kind === "SWAP_TAKEN") {
    swapConditions.push(
      authority.expectedTargetAssignmentId === null
        ? isNull(swapRequests.toAssignmentId)
        : eq(swapRequests.toAssignmentId, authority.expectedTargetAssignmentId),
    );
  }
  const [lockedSwap] = await db
    .select({ id: swapRequests.id })
    .from(swapRequests)
    .where(and(...swapConditions))
    .limit(1)
    .for("share");
  if (!lockedSwap) {
    throw new PersistedPushAuthorityBindingError(
      "Oferta não corresponde mais ao evento persistido",
    );
  }

  for (const shiftId of shiftIds) {
    const before = beforeById.get(shiftId)!;
    const current = await loadShiftLockSnapshot(
      db,
      authority.institutionId,
      shiftId,
      true,
    );
    if (!current || !sameShiftLockSnapshot(before, current)) {
      throw new Error(
        "A topologia da oferta mudou durante a validação do push",
      );
    }
  }
  await lockSwapAssignmentsAndIdentities(
    db,
    authority,
    shiftIds.map((shiftId) => beforeById.get(shiftId)!),
  );
}

export async function requireAuthorizedSwapOfferRecipient(
  db: AuthorityDb,
  authority: SwapOfferPushAuthority,
  lockForShare = false,
): Promise<void> {
  const parsed = parseSwapPushAuthority(
    authority as unknown as Record<string, unknown>,
  );
  if (!parsed || parsed.kind !== "SWAP_OFFER") {
    throw new PersistedPushAuthorityBindingError(
      "Autoridade persistida da oferta tem formato inválido",
    );
  }
  if (lockForShare) await lockSwapDeliveryRows(db, authority);
  const eligible = await isRecipientUserEligibleForSwapOffer(db, {
    id: authority.swapRequestId,
    fromUserId: authority.offerOwnerUserId,
    institutionId: authority.institutionId,
    expectedUserId: authority.expectedUserId,
    expectedFromUserId: authority.offerOwnerUserId,
    expectedFromProfessionalId: authority.offerOwnerProfessionalId,
    expectedSourceAssignmentId: authority.expectedSourceAssignmentId,
    expectedSwapVersion: authority.expectedSwapVersion,
    swapType: authority.swapType,
    expectedTargetShiftInstanceId: authority.expectedTargetShiftInstanceId,
    hospitalId: authority.hospitalId,
    sectorId: authority.sectorId,
    audience: authority.audience,
    lockForShare,
  });
  if (!eligible) {
    throw new PersistedPushAuthorityBindingError(
      "Destinatário não está mais elegível para a oferta de plantão",
    );
  }
}

export async function requireAuthorizedSwapTakenRecipient(
  db: AuthorityDb,
  authority: SwapTakenPushAuthority,
  lockForShare = false,
): Promise<void> {
  const parsed = parseSwapPushAuthority(
    authority as unknown as Record<string, unknown>,
  );
  if (!parsed || parsed.kind !== "SWAP_TAKEN") {
    throw new PersistedPushAuthorityBindingError(
      "Autoridade persistida da conclusão tem formato inválido",
    );
  }
  if (lockForShare) await lockSwapDeliveryRows(db, authority);
  const lockClause = lockForShare ? sql`FOR SHARE` : sql``;
  const counterpartPredicate =
    authority.swapType === "SWAP"
      ? sql`
        AND sr.to_shift_instance_id = ${authority.expectedTargetShiftInstanceId}
        AND sr.to_shift_instance_id != sr.from_shift_instance_id
        AND sr.to_assignment_id = ${authority.expectedTargetAssignmentId}
        AND EXISTS (
          SELECT 1
          FROM shift_instances tsi
          JOIN schedule_contexts tsc
            ON tsc.id = tsi.schedule_context_id
           AND tsc.institution_id = tsi.institution_id
           AND tsc.hospital_id = tsi.hospital_id
           AND tsc.sector_id = tsi.sector_id
           AND tsc.active = 1
          JOIN hospitals th
            ON th.id = tsi.hospital_id
           AND th.institution_id = tsi.institution_id
          JOIN sectors ts
            ON ts.id = tsi.sector_id
           AND ts.institution_id = tsi.institution_id
           AND ts.hospital_id = tsi.hospital_id
          JOIN monthly_rosters tmr
            ON tmr.institution_id = tsi.institution_id
           AND tmr.hospital_id = tsi.hospital_id
           AND tmr.year_month = DATE_FORMAT(DATE_SUB(tsi.start_at, INTERVAL 3 HOUR), '%Y-%m')
           AND tmr.status IN ('PUBLISHED', 'LOCKED')
          JOIN shift_assignments_v2 previous_taker_assignment
            ON previous_taker_assignment.id = sr.to_assignment_id
           AND previous_taker_assignment.shift_instance_id = tsi.id
           AND previous_taker_assignment.institution_id = tsi.institution_id
           AND previous_taker_assignment.hospital_id = tsi.hospital_id
           AND previous_taker_assignment.sector_id = tsi.sector_id
           AND previous_taker_assignment.professional_id = tp.id
           AND previous_taker_assignment.is_active = 0
           AND previous_taker_assignment.status = 'OCUPADO'
          JOIN shift_assignments_v2 current_owner_assignment
            ON current_owner_assignment.shift_instance_id = tsi.id
           AND current_owner_assignment.institution_id = tsi.institution_id
           AND current_owner_assignment.hospital_id = tsi.hospital_id
           AND current_owner_assignment.sector_id = tsi.sector_id
           AND current_owner_assignment.professional_id = fp.id
           AND current_owner_assignment.is_active = 1
           AND current_owner_assignment.status = 'OCUPADO'
          WHERE tsi.id = sr.to_shift_instance_id
            AND tsi.institution_id = sr.institution_id
            AND NOT EXISTS (
              SELECT 1
              FROM shift_assignments_v2 poisoned_target_assignment
              WHERE poisoned_target_assignment.shift_instance_id = tsi.id
                AND poisoned_target_assignment.is_active = 1
                AND (
                  poisoned_target_assignment.institution_id != tsi.institution_id
                  OR poisoned_target_assignment.hospital_id != tsi.hospital_id
                  OR poisoned_target_assignment.sector_id != tsi.sector_id
                )
            )
            AND (
              SELECT COUNT(*)
              FROM shift_assignments_v2 target_owner_count
              WHERE target_owner_count.shift_instance_id = tsi.id
                AND target_owner_count.institution_id = tsi.institution_id
                AND target_owner_count.hospital_id = tsi.hospital_id
                AND target_owner_count.sector_id = tsi.sector_id
                AND target_owner_count.professional_id = fp.id
                AND target_owner_count.is_active = 1
            ) = 1
        )`
      : sql`
        AND sr.to_shift_instance_id IS NULL
        AND sr.to_assignment_id IS NULL`;
  const result = await db.execute(sql`
    SELECT sr.id AS swapRequestId
    FROM swap_requests sr
    JOIN institutions inst
      ON inst.id = sr.institution_id
     AND inst.is_active = 1
    JOIN shift_instances fsi
      ON fsi.id = sr.from_shift_instance_id
     AND fsi.institution_id = sr.institution_id
     AND fsi.hospital_id = sr.hospital_id
     AND fsi.sector_id = sr.sector_id
    JOIN schedule_contexts fsc
      ON fsc.id = fsi.schedule_context_id
     AND fsc.institution_id = fsi.institution_id
     AND fsc.hospital_id = fsi.hospital_id
     AND fsc.sector_id = fsi.sector_id
     AND fsc.active = 1
    JOIN hospitals fh
      ON fh.id = fsi.hospital_id
     AND fh.institution_id = fsi.institution_id
    JOIN sectors fs
      ON fs.id = fsi.sector_id
     AND fs.institution_id = fsi.institution_id
     AND fs.hospital_id = fsi.hospital_id
    JOIN monthly_rosters fmr
      ON fmr.institution_id = fsi.institution_id
     AND fmr.hospital_id = fsi.hospital_id
     AND fmr.year_month = DATE_FORMAT(DATE_SUB(fsi.start_at, INTERVAL 3 HOUR), '%Y-%m')
     AND fmr.status IN ('PUBLISHED', 'LOCKED')
    JOIN professionals fp
      ON fp.id = sr.from_professional_id
     AND fp.user_id = sr.from_user_id
    JOIN users fu
      ON fu.id = fp.user_id
     AND fu.approval_status = 'APPROVED'
     AND fu.deleted_at IS NULL
    JOIN professional_institutions fpi
      ON fpi.professional_id = fp.id
     AND fpi.user_id = fp.user_id
     AND fpi.institution_id = sr.institution_id
     AND fpi.active = 1
    JOIN professionals tp
      ON tp.id = sr.to_professional_id
     AND tp.user_id = sr.to_user_id
    JOIN users tu
      ON tu.id = tp.user_id
     AND tu.approval_status = 'APPROVED'
     AND tu.deleted_at IS NULL
    JOIN professional_institutions tpi
      ON tpi.professional_id = tp.id
     AND tpi.user_id = tp.user_id
     AND tpi.institution_id = sr.institution_id
     AND tpi.active = 1
    JOIN shift_assignments_v2 current_taker_assignment
      ON current_taker_assignment.shift_instance_id = fsi.id
     AND current_taker_assignment.institution_id = fsi.institution_id
     AND current_taker_assignment.hospital_id = fsi.hospital_id
     AND current_taker_assignment.sector_id = fsi.sector_id
     AND current_taker_assignment.professional_id = tp.id
     AND current_taker_assignment.is_active = 1
     AND current_taker_assignment.status = 'OCUPADO'
    JOIN shift_assignments_v2 previous_owner_assignment
      ON previous_owner_assignment.id = sr.from_assignment_id
     AND previous_owner_assignment.shift_instance_id = fsi.id
     AND previous_owner_assignment.institution_id = fsi.institution_id
     AND previous_owner_assignment.hospital_id = fsi.hospital_id
     AND previous_owner_assignment.sector_id = fsi.sector_id
     AND previous_owner_assignment.professional_id = fp.id
     AND previous_owner_assignment.is_active = 0
     AND previous_owner_assignment.status = 'OCUPADO'
    WHERE sr.id = ${authority.swapRequestId}
      AND sr.institution_id = ${authority.institutionId}
      AND sr.hospital_id = ${authority.hospitalId}
      AND sr.sector_id = ${authority.sectorId}
      AND sr.from_shift_instance_id = ${authority.shiftInstanceId}
      AND sr.from_assignment_id = ${authority.expectedSourceAssignmentId}
      AND sr.from_user_id = ${authority.expectedUserId}
      AND sr.from_professional_id = ${authority.expectedOwnerProfessionalId}
      AND sr.to_user_id = ${authority.expectedTakerUserId}
      AND sr.to_professional_id = ${authority.expectedTakerProfessionalId}
      AND sr.from_user_id != sr.to_user_id
      AND sr.from_professional_id != sr.to_professional_id
      AND sr.type = ${authority.swapType}
      AND sr.status = 'APPROVED'
      AND sr.version = ${authority.expectedSwapVersion}
      ${counterpartPredicate}
      AND (
        SELECT COUNT(*)
        FROM shift_assignments_v2 source_taker_count
        WHERE source_taker_count.shift_instance_id = fsi.id
          AND source_taker_count.institution_id = fsi.institution_id
          AND source_taker_count.hospital_id = fsi.hospital_id
          AND source_taker_count.sector_id = fsi.sector_id
          AND source_taker_count.professional_id = tp.id
          AND source_taker_count.is_active = 1
      ) = 1
      AND (
        ${plantonistaAccessCoversShiftSql("fp", "fsi", "fsc")}
        OR fpi.role_in_institution = 'GESTOR_PLUS'
        OR EXISTS (
          SELECT 1
          FROM manager_scope owner_scope
          WHERE owner_scope.manager_professional_id = fp.id
            AND owner_scope.institution_id = fsi.institution_id
            AND owner_scope.hospital_id = fsi.hospital_id
            AND (owner_scope.sector_id IS NULL OR owner_scope.sector_id = fsi.sector_id)
            AND owner_scope.active = 1
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM shift_assignments_v2 poisoned_source_assignment
        WHERE poisoned_source_assignment.shift_instance_id = fsi.id
          AND poisoned_source_assignment.is_active = 1
          AND (
            poisoned_source_assignment.institution_id != fsi.institution_id
            OR poisoned_source_assignment.hospital_id != fsi.hospital_id
            OR poisoned_source_assignment.sector_id != fsi.sector_id
          )
      )
    ${lockClause}
  `);
  const rows = rowsFromExecute<{ swapRequestId: number | string }>(result);
  if (
    rows.length !== 1 ||
    Number(rows[0]?.swapRequestId) !== authority.swapRequestId
  ) {
    throw new PersistedPushAuthorityBindingError(
      "Oferta assumida não corresponde mais ao estado operacional esperado",
    );
  }
}

export async function requireAuthorizedLegacySwapPushAuthority(
  db: AuthorityDb,
  input: Readonly<{
    expectedUserId: number;
    institutionId: number;
    shiftInstanceId: number;
    payloadData: Readonly<Record<string, unknown>>;
  }>,
): Promise<SwapPushAuthority> {
  const swapRequestId = input.payloadData.swapRequestId;
  if (
    !positiveId(input.expectedUserId) ||
    !positiveId(input.institutionId) ||
    !positiveId(input.shiftInstanceId) ||
    !positiveId(swapRequestId) ||
    !isSwapPushPayload(input.payloadData) ||
    input.payloadData.institutionId !== input.institutionId ||
    input.payloadData.shiftInstanceId !== input.shiftInstanceId ||
    input.payloadData.userId !== input.expectedUserId ||
    (input.payloadData.recipientUserId !== undefined &&
      input.payloadData.recipientUserId !== input.expectedUserId)
  ) {
    throw new PersistedPushAuthorityBindingError(
      "Outbox legado não corresponde à identidade persistida da oferta",
    );
  }
  const [snapshot] = await db
    .select({
      swapRequestId: swapRequests.id,
      swapType: swapRequests.type,
      status: swapRequests.status,
      version: swapRequests.version,
      fromProfessionalId: swapRequests.fromProfessionalId,
      fromUserId: swapRequests.fromUserId,
      fromAssignmentId: swapRequests.fromAssignmentId,
      toProfessionalId: swapRequests.toProfessionalId,
      toUserId: swapRequests.toUserId,
      toShiftInstanceId: swapRequests.toShiftInstanceId,
      toAssignmentId: swapRequests.toAssignmentId,
      hospitalId: shiftInstances.hospitalId,
      sectorId: shiftInstances.sectorId,
    })
    .from(swapRequests)
    .innerJoin(
      shiftInstances,
      and(
        eq(shiftInstances.id, swapRequests.fromShiftInstanceId),
        eq(shiftInstances.institutionId, swapRequests.institutionId),
        eq(shiftInstances.hospitalId, swapRequests.hospitalId),
        eq(shiftInstances.sectorId, swapRequests.sectorId),
      ),
    )
    .where(
      and(
        eq(swapRequests.id, swapRequestId),
        eq(swapRequests.institutionId, input.institutionId),
        eq(swapRequests.fromShiftInstanceId, input.shiftInstanceId),
      ),
    )
    .limit(1);
  if (
    !snapshot ||
    !positiveId(snapshot.swapRequestId) ||
    !positiveId(snapshot.fromProfessionalId) ||
    !positiveId(snapshot.fromUserId) ||
    !positiveId(snapshot.fromAssignmentId) ||
    !positiveVersion(snapshot.version) ||
    !isSwapType(snapshot.swapType) ||
    !positiveId(snapshot.hospitalId) ||
    !positiveId(snapshot.sectorId) ||
    (input.payloadData.hospitalId !== undefined &&
      input.payloadData.hospitalId !== snapshot.hospitalId) ||
    (input.payloadData.sectorId !== undefined &&
      input.payloadData.sectorId !== snapshot.sectorId)
  ) {
    throw new PersistedPushAuthorityBindingError(
      "Outbox legado não corresponde à topologia canônica da oferta",
    );
  }
  if (input.payloadData.type === "swap_offer") {
    const open =
      snapshot.toProfessionalId === null && snapshot.toUserId === null;
    const directed =
      positiveId(snapshot.toProfessionalId) && positiveId(snapshot.toUserId);
    const audience: SwapOfferAudience = open ? "OPEN" : "DIRECTED";
    if (
      snapshot.status !== "PENDING" ||
      (!open && !directed) ||
      snapshot.fromUserId === input.expectedUserId ||
      (audience === "DIRECTED" && snapshot.toUserId !== input.expectedUserId) ||
      (snapshot.swapType === "SWAP"
        ? !positiveId(snapshot.toShiftInstanceId) ||
          snapshot.toAssignmentId !== null
        : snapshot.toShiftInstanceId !== null ||
          snapshot.toAssignmentId !== null)
    ) {
      throw new PersistedPushAuthorityBindingError(
        "Outbox legado não corresponde ao destinatário atual da oferta",
      );
    }
    const authority: SwapOfferPushAuthority = {
      kind: "SWAP_OFFER",
      purpose: "OFFER_AVAILABLE",
      audience,
      expectedUserId: input.expectedUserId,
      offerOwnerUserId: snapshot.fromUserId,
      offerOwnerProfessionalId: snapshot.fromProfessionalId,
      expectedSourceAssignmentId: snapshot.fromAssignmentId,
      expectedSwapVersion: snapshot.version,
      swapType: snapshot.swapType,
      expectedTargetShiftInstanceId: snapshot.toShiftInstanceId,
      institutionId: input.institutionId,
      hospitalId: snapshot.hospitalId,
      sectorId: snapshot.sectorId,
      shiftInstanceId: input.shiftInstanceId,
      swapRequestId: snapshot.swapRequestId,
    };
    await requireAuthorizedSwapOfferRecipient(db, authority, true);
    return authority;
  }
  if (
    input.payloadData.type !== "swap_taken" ||
    snapshot.status !== "APPROVED" ||
    snapshot.fromUserId !== input.expectedUserId ||
    !positiveId(snapshot.toUserId) ||
    !positiveId(snapshot.toProfessionalId) ||
    !positiveVersion(snapshot.version) ||
    !isSwapType(snapshot.swapType)
  ) {
    throw new PersistedPushAuthorityBindingError(
      "Outbox legado não corresponde à conclusão atual da oferta",
    );
  }
  if (
    snapshot.swapType === "SWAP"
      ? !positiveId(snapshot.toShiftInstanceId) ||
        !positiveId(snapshot.toAssignmentId)
      : snapshot.toShiftInstanceId !== null || snapshot.toAssignmentId !== null
  ) {
    throw new PersistedPushAuthorityBindingError(
      "Outbox legado não corresponde à contrapartida atual da oferta",
    );
  }
  const common = {
    kind: "SWAP_TAKEN",
    purpose: "OFFER_TAKEN",
    expectedUserId: input.expectedUserId,
    expectedOwnerProfessionalId: snapshot.fromProfessionalId,
    expectedTakerUserId: snapshot.toUserId,
    expectedTakerProfessionalId: snapshot.toProfessionalId,
    expectedSourceAssignmentId: snapshot.fromAssignmentId,
    expectedSwapVersion: snapshot.version,
    institutionId: input.institutionId,
    hospitalId: snapshot.hospitalId,
    sectorId: snapshot.sectorId,
    shiftInstanceId: input.shiftInstanceId,
    swapRequestId: snapshot.swapRequestId,
  } as const;
  const authority: SwapTakenPushAuthority =
    snapshot.swapType === "SWAP"
      ? {
          ...common,
          swapType: "SWAP",
          expectedTargetShiftInstanceId: snapshot.toShiftInstanceId as number,
          expectedTargetAssignmentId: snapshot.toAssignmentId as number,
        }
      : {
          ...common,
          swapType: snapshot.swapType,
          expectedTargetShiftInstanceId: null,
          expectedTargetAssignmentId: null,
        };
  await requireAuthorizedSwapTakenRecipient(db, authority, true);
  return authority;
}
