import { TRPCError } from "@trpc/server";
import { and, eq, isNull, or } from "drizzle-orm";
import {
  dutyConfirmations,
  managerScope,
  professionalAccess,
  professionalInstitutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../drizzle/schema";
import type { getDb } from "./db";
import { assertInstitutionHierarchy } from "./_core/tenant";
import { assertOfficialRoster } from "./month-guards";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type ConfirmationReadDb = Pick<Db, "select">;
export type DutyConfirmationStatus = typeof dutyConfirmations.$inferSelect.status;

/**
 * Incoerência determinística entre uma intenção durável e sua autoridade.
 * É uma rejeição canônica: repetir a mesma linha não pode torná-la válida.
 */
export class PersistedDutyConfirmationBindingError extends TRPCError {
  constructor(message: string) {
    super({ code: "BAD_REQUEST", message });
    this.name = "PersistedDutyConfirmationBindingError";
  }
}

/**
 * Somente rejeições determinísticas podem encerrar trabalho durável. Falhas
 * genéricas (DB, rede, driver) permanecem retryable e nunca são confundidas
 * com revogação de autoridade.
 */
export function isCanonicalDutyConfirmationRejection(error: unknown): boolean {
  return error instanceof PersistedDutyConfirmationBindingError ||
    (error instanceof TRPCError &&
      (error.code === "FORBIDDEN" || error.code === "BAD_REQUEST"));
}

type ExpectedActor = {
  kind: "ORIGINAL" | "REPLACEMENT";
  userId: number;
  /** Versão da sessão autenticada no início do request. Obrigatória em escrita. */
  sessionVersion?: number;
};

type ValidationOptions = {
  allowedStatuses: readonly DutyConfirmationStatus[];
  expectedActor?: ExpectedActor;
  expectedInstitutionId?: number;
  requireOriginalMembership?: boolean;
  /**
   * Exceção estreita para WITHDRAW: a exclusão física do vínculo não pode
   * impedir a remoção de uma declaração externa já emitida. Demais fluxos
   * continuam exigindo a linha PI canônica, mesmo quando toleram active=false.
   */
  allowMissingOriginalMembership?: boolean;
  /**
   * Exceção exclusiva de WITHDRAW/escalação: a conta do titular pode ter
   * sido removida depois que o evento externo nasceu. Nunca aplicar ao
   * destinatário efetivo de push/SSO ou a um substituto.
   */
  allowInvalidOriginalUser?: boolean;
  requireOriginalAccess?: boolean;
  requireOriginalAssignmentActive?: boolean;
  requireReplacementMembership?: boolean;
  requireEffectiveAssignment?: boolean;
  additionalAuthorityTargets?: readonly {
    professionalId: number;
    userId: number;
    requireAccess: boolean;
  }[];
  /**
   * Bloqueia as linhas canônicas usadas pela decisão até o fim da transação.
   * Use somente nas mutações, imediatamente antes do CAS.
   */
  lockForUpdate?: boolean;
};

type EffectiveDutyTarget = {
  assignmentId: number | null;
  professionalId: number;
  userId: number;
};

export type ValidatedDutyConfirmation = {
  confirmation: typeof dutyConfirmations.$inferSelect;
  original: EffectiveDutyTarget & {
    assignmentType: typeof shiftAssignmentsV2.$inferSelect.assignmentType;
    isActive: boolean;
    name: string;
  };
  replacement: (EffectiveDutyTarget & {
    name: string;
    specialty: string | null;
  }) | null;
  effective: EffectiveDutyTarget;
  shift: {
    id: number;
    institutionId: number;
    hospitalId: number;
    sectorId: number;
    label: string;
    startAt: Date;
    endAt: Date;
    modality: typeof shiftInstances.$inferSelect.modality;
    specialty: string | null;
    sectorName: string;
  };
};

export type DutyShiftSnapshot = Readonly<{
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  label: string;
  startAt: string;
  endAt: string;
}>;

export function dutyShiftSnapshot(
  shift: ValidatedDutyConfirmation["shift"],
): DutyShiftSnapshot {
  return {
    institutionId: shift.institutionId,
    hospitalId: shift.hospitalId,
    sectorId: shift.sectorId,
    label: shift.label,
    startAt: shift.startAt.toISOString(),
    endAt: shift.endAt.toISOString(),
  };
}

function assertDutyShiftSnapshot(
  shift: ValidatedDutyConfirmation["shift"],
  expected: DutyShiftSnapshot,
): void {
  const current = dutyShiftSnapshot(shift);
  if (
    current.institutionId !== expected.institutionId ||
    current.hospitalId !== expected.hospitalId ||
    current.sectorId !== expected.sectorId ||
    current.label !== expected.label ||
    current.startAt !== expected.startAt ||
    current.endAt !== expected.endAt
  ) {
    invalid("O plantão mudou depois que a intenção foi criada");
  }
}

function invalid(
  message = "Confirmação fora da hierarquia institucional",
  code: "FORBIDDEN" | "BAD_REQUEST" = "FORBIDDEN",
): never {
  throw new TRPCError({ code, message });
}

/**
 * Reconstrói uma confirmação exclusivamente a partir das relações canônicas.
 * Nenhum caller pode autorizar, mutar ou emitir usando apenas os IDs duplicados
 * em duty_confirmations.
 */
export async function requireValidDutyConfirmation(
  db: ConfirmationReadDb,
  confirmationId: number,
  options: ValidationOptions,
): Promise<ValidatedDutyConfirmation> {
  let prelockedEffectiveAssignmentId: number | null = null;
  let currentLockedShift: Pick<
    ValidatedDutyConfirmation["shift"],
    | "id"
    | "institutionId"
    | "hospitalId"
    | "sectorId"
    | "label"
    | "startAt"
    | "endAt"
    | "modality"
    | "specialty"
  > | null = null;
  let currentLockedOriginalAssignment: Pick<
    typeof shiftAssignmentsV2.$inferSelect,
    "assignmentType" | "status" | "isActive"
  > | null = null;
  if (options.lockForUpdate) {
    if (
      options.expectedActor &&
      !Number.isSafeInteger(options.expectedActor.sessionVersion)
    ) {
      invalid("Versão da sessão autenticada ausente");
    }
    // Pré-leitura sem lock resolve as chaves. A autoridade só nasce depois da
    // revalidação sob a ordem global: shift → assignment → confirmation.
    // Joins FOR UPDATE não garantem ordem física de aquisição no MySQL.
    const [snapshot] = await db
      .select({
        institutionId: dutyConfirmations.institutionId,
        shiftInstanceId: dutyConfirmations.shiftInstanceId,
        assignmentId: dutyConfirmations.assignmentId,
        professionalId: dutyConfirmations.professionalId,
        userId: dutyConfirmations.userId,
        status: dutyConfirmations.status,
        replacementProfessionalId: dutyConfirmations.replacementProfessionalId,
        replacementUserId: dutyConfirmations.replacementUserId,
      })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, confirmationId))
      .limit(1);
    if (!snapshot) invalid();

    const [lockedShift] = await db
      .select({
        id: shiftInstances.id,
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
          eq(shiftInstances.id, snapshot.shiftInstanceId),
          eq(shiftInstances.institutionId, snapshot.institutionId),
        ),
      )
      .limit(1)
      .for("update");
    if (!lockedShift) invalid();
    currentLockedShift = lockedShift;

    const [originalAssignmentSnapshot] = await db
      .select({
        id: shiftAssignmentsV2.id,
        shiftInstanceId: shiftAssignmentsV2.shiftInstanceId,
        institutionId: shiftAssignmentsV2.institutionId,
        hospitalId: shiftAssignmentsV2.hospitalId,
        sectorId: shiftAssignmentsV2.sectorId,
        professionalId: shiftAssignmentsV2.professionalId,
        assignmentType: shiftAssignmentsV2.assignmentType,
      })
      .from(shiftAssignmentsV2)
      .where(
        and(
          eq(shiftAssignmentsV2.id, snapshot.assignmentId),
          eq(shiftAssignmentsV2.shiftInstanceId, snapshot.shiftInstanceId),
          eq(shiftAssignmentsV2.institutionId, snapshot.institutionId),
          eq(shiftAssignmentsV2.professionalId, snapshot.professionalId),
        ),
      )
      .limit(1);
    if (
      !originalAssignmentSnapshot ||
      originalAssignmentSnapshot.hospitalId !== lockedShift.hospitalId ||
      originalAssignmentSnapshot.sectorId !== lockedShift.sectorId
    ) invalid();

    let replacementAssignmentSnapshot: { id: number } | null = null;
    if (options.requireEffectiveAssignment && snapshot.status === "REPLACEMENT_CONFIRMED") {
      if (!snapshot.replacementProfessionalId || !snapshot.replacementUserId) {
        invalid("Substituto inválido");
      }
      const replacementAssignments = await db
        .select({ id: shiftAssignmentsV2.id })
        .from(shiftAssignmentsV2)
        .where(
          and(
            eq(shiftAssignmentsV2.shiftInstanceId, lockedShift.id),
            eq(shiftAssignmentsV2.institutionId, lockedShift.institutionId),
            eq(shiftAssignmentsV2.hospitalId, lockedShift.hospitalId),
            eq(shiftAssignmentsV2.sectorId, lockedShift.sectorId),
            eq(shiftAssignmentsV2.professionalId, snapshot.replacementProfessionalId),
            eq(shiftAssignmentsV2.assignmentType, originalAssignmentSnapshot.assignmentType),
            eq(shiftAssignmentsV2.status, "OCUPADO"),
            eq(shiftAssignmentsV2.isActive, true),
          ),
        )
        .limit(2);
      if (replacementAssignments.length !== 1) {
        invalid("Substituto não está alocado neste plantão");
      }
      replacementAssignmentSnapshot = replacementAssignments[0]!;
    }

    const assignmentLocks = [
      { id: originalAssignmentSnapshot.id, replacement: false },
      ...(replacementAssignmentSnapshot
        ? [{ id: replacementAssignmentSnapshot.id, replacement: true }]
        : []),
    ].sort((left, right) => left.id - right.id);
    for (const target of assignmentLocks) {
      const [lockedAssignment] = await db
        .select({
          id: shiftAssignmentsV2.id,
          assignmentType: shiftAssignmentsV2.assignmentType,
          status: shiftAssignmentsV2.status,
          isActive: shiftAssignmentsV2.isActive,
        })
        .from(shiftAssignmentsV2)
        .where(
          target.replacement
            ? and(
                eq(shiftAssignmentsV2.id, target.id),
                eq(shiftAssignmentsV2.shiftInstanceId, lockedShift.id),
                eq(shiftAssignmentsV2.institutionId, lockedShift.institutionId),
                eq(shiftAssignmentsV2.hospitalId, lockedShift.hospitalId),
                eq(shiftAssignmentsV2.sectorId, lockedShift.sectorId),
                eq(shiftAssignmentsV2.professionalId, snapshot.replacementProfessionalId!),
                eq(shiftAssignmentsV2.assignmentType, originalAssignmentSnapshot.assignmentType),
                eq(shiftAssignmentsV2.status, "OCUPADO"),
                eq(shiftAssignmentsV2.isActive, true),
              )
            : and(
                eq(shiftAssignmentsV2.id, target.id),
                eq(shiftAssignmentsV2.shiftInstanceId, snapshot.shiftInstanceId),
                eq(shiftAssignmentsV2.institutionId, snapshot.institutionId),
                eq(shiftAssignmentsV2.hospitalId, lockedShift.hospitalId),
                eq(shiftAssignmentsV2.sectorId, lockedShift.sectorId),
                eq(shiftAssignmentsV2.professionalId, snapshot.professionalId),
                eq(
                  shiftAssignmentsV2.assignmentType,
                  originalAssignmentSnapshot.assignmentType,
                ),
              ),
        )
        .limit(1)
        .for("update");
      if (!lockedAssignment) invalid("A alocação mudou durante o processamento");
      if (!target.replacement) {
        if (
          lockedAssignment.status !== "OCUPADO" ||
          (options.requireOriginalAssignmentActive !== false && !lockedAssignment.isActive)
        ) {
          invalid("A alocação mudou durante o processamento", "BAD_REQUEST");
        }
        currentLockedOriginalAssignment = lockedAssignment;
      }
    }
    prelockedEffectiveAssignmentId = replacementAssignmentSnapshot?.id ?? null;

    const [lockedConfirmation] = await db
      .select({
        institutionId: dutyConfirmations.institutionId,
        shiftInstanceId: dutyConfirmations.shiftInstanceId,
        assignmentId: dutyConfirmations.assignmentId,
        professionalId: dutyConfirmations.professionalId,
        userId: dutyConfirmations.userId,
        status: dutyConfirmations.status,
        replacementProfessionalId: dutyConfirmations.replacementProfessionalId,
        replacementUserId: dutyConfirmations.replacementUserId,
      })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, confirmationId))
      .limit(1)
      .for("update");
    if (
      !lockedConfirmation ||
      lockedConfirmation.institutionId !== snapshot.institutionId ||
      lockedConfirmation.shiftInstanceId !== snapshot.shiftInstanceId ||
      lockedConfirmation.assignmentId !== snapshot.assignmentId ||
      lockedConfirmation.professionalId !== snapshot.professionalId ||
      lockedConfirmation.userId !== snapshot.userId ||
      lockedConfirmation.status !== snapshot.status ||
      lockedConfirmation.replacementProfessionalId !== snapshot.replacementProfessionalId ||
      lockedConfirmation.replacementUserId !== snapshot.replacementUserId
    ) invalid("A confirmação mudou durante o processamento", "BAD_REQUEST");
  }

  const topologyQuery = db
    .select({
      confirmation: dutyConfirmations,
      assignmentId: shiftAssignmentsV2.id,
      assignmentType: shiftAssignmentsV2.assignmentType,
      assignmentStatus: shiftAssignmentsV2.status,
      assignmentIsActive: shiftAssignmentsV2.isActive,
      originalMembershipId: professionalInstitutions.id,
      originalMembershipActive: professionalInstitutions.active,
      originalName: professionals.name,
      shiftId: shiftInstances.id,
      shiftInstitutionId: shiftInstances.institutionId,
      shiftHospitalId: shiftInstances.hospitalId,
      shiftSectorId: shiftInstances.sectorId,
      shiftLabel: shiftInstances.label,
      shiftStartAt: shiftInstances.startAt,
      shiftEndAt: shiftInstances.endAt,
      shiftModality: shiftInstances.modality,
      shiftSpecialty: shiftInstances.specialty,
    })
    .from(dutyConfirmations)
    .innerJoin(
      shiftAssignmentsV2,
      and(
        eq(shiftAssignmentsV2.id, dutyConfirmations.assignmentId),
        eq(shiftAssignmentsV2.shiftInstanceId, dutyConfirmations.shiftInstanceId),
        eq(shiftAssignmentsV2.institutionId, dutyConfirmations.institutionId),
        eq(shiftAssignmentsV2.professionalId, dutyConfirmations.professionalId),
      ),
    )
    .innerJoin(
      shiftInstances,
      and(
        eq(shiftInstances.id, shiftAssignmentsV2.shiftInstanceId),
        eq(shiftInstances.institutionId, shiftAssignmentsV2.institutionId),
        eq(shiftInstances.hospitalId, shiftAssignmentsV2.hospitalId),
        eq(shiftInstances.sectorId, shiftAssignmentsV2.sectorId),
      ),
    )
    .innerJoin(
      professionals,
      and(
        eq(professionals.id, dutyConfirmations.professionalId),
        eq(professionals.id, shiftAssignmentsV2.professionalId),
        eq(professionals.userId, dutyConfirmations.userId),
      ),
    )
    .leftJoin(
      professionalInstitutions,
      and(
        eq(professionalInstitutions.professionalId, professionals.id),
        eq(professionalInstitutions.userId, professionals.userId),
        eq(professionalInstitutions.institutionId, dutyConfirmations.institutionId),
      ),
    )
    .where(eq(dutyConfirmations.id, confirmationId))
    .limit(1);
  const [row] = await topologyQuery;

  if (!row) invalid();
  await assertInstitutionHierarchy(
    {
      institutionId: row.shiftInstitutionId,
      hospitalId: row.shiftHospitalId,
      sectorId: row.shiftSectorId,
    },
    { db, lockForShare: options.lockForUpdate },
  );
  const currentShiftStartAt = currentLockedShift?.startAt ?? row.shiftStartAt;
  await assertOfficialRoster(
    db,
    row.shiftInstitutionId,
    row.shiftHospitalId,
    currentShiftStartAt,
  );
  const [canonicalSector] = await db
    .select({ name: sectors.name })
    .from(sectors)
    .where(
      and(
        eq(sectors.id, row.shiftSectorId),
        eq(sectors.institutionId, row.shiftInstitutionId),
        eq(sectors.hospitalId, row.shiftHospitalId),
      ),
    )
    .limit(1);
  if (!canonicalSector) invalid();
  const conf = row.confirmation;

  if (!row.originalMembershipId && !options.allowMissingOriginalMembership) {
    invalid("Titular sem vínculo canônico nesta instituição");
  }
  if (!options.lockForUpdate && !options.allowInvalidOriginalUser) {
    const [currentOriginalUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, conf.userId),
          eq(users.approvalStatus, "APPROVED"),
          isNull(users.deletedAt),
        ),
      )
      .limit(1);
    if (!currentOriginalUser) invalid("Conta do titular não está ativa");
  }

  if (!options.allowedStatuses.includes(conf.status)) {
    invalid(`Confirmação já processada (${conf.status})`, "BAD_REQUEST");
  }
  if (
    options.expectedInstitutionId !== undefined &&
    conf.institutionId !== options.expectedInstitutionId
  ) {
    invalid("Confirmação não pertence à instituição ativa");
  }
  if (options.expectedActor?.kind === "ORIGINAL" && conf.userId !== options.expectedActor.userId) {
    invalid("Confirmação não pertence ao usuário autenticado");
  }
  const currentAssignmentStatus =
    currentLockedOriginalAssignment?.status ?? row.assignmentStatus;
  const currentAssignmentIsActive =
    currentLockedOriginalAssignment?.isActive ?? row.assignmentIsActive;
  const currentAssignmentType =
    currentLockedOriginalAssignment?.assignmentType ?? row.assignmentType;
  if (currentAssignmentStatus !== "OCUPADO") {
    invalid("A alocação ainda não foi aprovada para este plantão", "BAD_REQUEST");
  }
  const requireOriginalMembership =
    options.requireOriginalMembership !== false && conf.status !== "REPLACEMENT_CONFIRMED";
  const requireOriginalAccess =
    options.requireOriginalAccess !== false && conf.status !== "REPLACEMENT_CONFIRMED";
  const requiresReplacementBinding =
    options.requireReplacementMembership === true ||
    options.expectedActor?.kind === "REPLACEMENT" ||
    conf.status === "REPLACEMENT_CONFIRMED";
  if (
    requiresReplacementBinding &&
    (!conf.replacementProfessionalId || !conf.replacementUserId)
  ) {
    invalid("Substituto inválido");
  }
  const needsReplacementAuthority = requiresReplacementBinding;

  let lockedAuthorities: Map<number, {
    userId: number;
    name: string;
    specialty: string | null;
  }> | null = null;
  if (options.lockForUpdate) {
    type AuthorityTarget = {
      professionalId: number;
      userId: number;
      original: boolean;
      requireActiveMembership: boolean;
      allowMissingMembership: boolean;
      requireAccess: boolean;
      requireApprovedUser: boolean;
    };
    const byProfessionalId = new Map<number, AuthorityTarget>();
    const addTarget = (target: AuthorityTarget) => {
      const existing = byProfessionalId.get(target.professionalId);
      if (existing && existing.userId !== target.userId) invalid("Identidade profissional inválida");
      byProfessionalId.set(target.professionalId, existing
        ? {
            ...existing,
            original: existing.original || target.original,
            requireActiveMembership:
              existing.requireActiveMembership || target.requireActiveMembership,
            allowMissingMembership:
              existing.allowMissingMembership && target.allowMissingMembership,
            requireAccess: existing.requireAccess || target.requireAccess,
            requireApprovedUser: existing.requireApprovedUser || target.requireApprovedUser,
          }
        : target);
    };
    addTarget({
      professionalId: conf.professionalId,
      userId: conf.userId,
      original: true,
      requireActiveMembership: requireOriginalMembership,
      allowMissingMembership: options.allowMissingOriginalMembership === true,
      requireAccess: requireOriginalAccess,
      requireApprovedUser: options.allowInvalidOriginalUser !== true,
    });
    if (needsReplacementAuthority) {
      addTarget({
        professionalId: conf.replacementProfessionalId!,
        userId: conf.replacementUserId!,
        original: false,
        requireActiveMembership: true,
        allowMissingMembership: false,
        requireAccess: true,
        requireApprovedUser: true,
      });
    }
    for (const target of options.additionalAuthorityTargets ?? []) {
      addTarget({
        professionalId: target.professionalId,
        userId: target.userId,
        original: false,
        requireActiveMembership: true,
        allowMissingMembership: false,
        requireAccess: target.requireAccess,
        requireApprovedUser: true,
      });
    }
    const targets = [...byProfessionalId.values()].sort(
      (left, right) => left.professionalId - right.professionalId,
    );
    const userTargets = [...new Map(
      targets.map((target) => [target.userId, target] as const),
    ).values()].sort((left, right) => left.userId - right.userId);
    for (const target of userTargets) {
      const [currentUser] = await db
        .select({
          id: users.id,
          approvalStatus: users.approvalStatus,
          deletedAt: users.deletedAt,
          sessionVersion: users.sessionVersion,
        })
        .from(users)
        .where(eq(users.id, target.userId))
        .limit(1)
        .for("update");
      if (
        !currentUser ||
        (target.requireApprovedUser &&
          (currentUser.approvalStatus !== "APPROVED" || currentUser.deletedAt !== null)) ||
        (target.userId === options.expectedActor?.userId &&
          currentUser.sessionVersion !== options.expectedActor.sessionVersion)
      ) {
        if (
          currentUser &&
          target.userId === options.expectedActor?.userId &&
          currentUser.sessionVersion !== options.expectedActor.sessionVersion
        ) {
          invalid("Sessão revogada");
        }
        invalid(target.original
          ? "Conta do titular não está ativa"
          : "Conta do substituto não está ativa");
      }
    }
    lockedAuthorities = new Map();
    for (const target of targets) {
      const [professional] = await db
        .select({
          id: professionals.id,
          userId: professionals.userId,
          name: professionals.name,
          specialty: professionals.specialty,
        })
        .from(professionals)
        .where(
          and(
            eq(professionals.id, target.professionalId),
            eq(professionals.userId, target.userId),
          ),
        )
        .limit(1)
        .for("update");
      if (!professional) invalid(target.original ? "Titular inválido" : "Substituto inválido");
      lockedAuthorities.set(target.professionalId, professional);
    }
    const memberships = new Map<number, { id: number; active: boolean } | null>();
    for (const target of targets) {
      const [membership] = await db
        .select({ id: professionalInstitutions.id, active: professionalInstitutions.active })
        .from(professionalInstitutions)
        .where(
          and(
            eq(professionalInstitutions.professionalId, target.professionalId),
            eq(professionalInstitutions.userId, target.userId),
            eq(professionalInstitutions.institutionId, conf.institutionId),
          ),
        )
        .limit(1);
      memberships.set(target.professionalId, membership ?? null);
      if (
        (!membership && !target.allowMissingMembership) ||
        (target.requireActiveMembership && !membership?.active)
      ) {
        invalid(target.original
          ? "Titular sem vínculo ativo nesta instituição"
          : "Substituto sem vínculo ativo nesta instituição");
      }
    }
    for (const [target, membership] of targets
      .map((target) => [target, memberships.get(target.professionalId)] as const)
      .filter((entry): entry is readonly [AuthorityTarget, { id: number; active: boolean }] =>
        entry[1] != null)
      .sort((left, right) => left[1].id - right[1].id)) {
      const [lockedMembership] = await db
        .select({ active: professionalInstitutions.active })
        .from(professionalInstitutions)
        .where(
          and(
            eq(professionalInstitutions.id, membership.id),
            eq(professionalInstitutions.professionalId, target.professionalId),
            eq(professionalInstitutions.userId, target.userId),
            eq(professionalInstitutions.institutionId, conf.institutionId),
          ),
        )
        .limit(1)
        .for("update");
      if (
        !lockedMembership ||
        (target.requireActiveMembership && !lockedMembership.active)
      ) {
        invalid(target.original
          ? "Titular sem vínculo ativo nesta instituição"
          : "Substituto sem vínculo ativo nesta instituição");
      }
    }
    const accesses: { target: AuthorityTarget; id: number }[] = [];
    for (const target of targets) {
      if (!target.requireAccess) continue;
      const [access] = await db
        .select({ id: professionalAccess.id })
        .from(professionalAccess)
        .where(
          and(
            eq(professionalAccess.professionalId, target.professionalId),
            eq(professionalAccess.institutionId, row.shiftInstitutionId),
            eq(professionalAccess.hospitalId, row.shiftHospitalId),
            or(
              isNull(professionalAccess.sectorId),
              eq(professionalAccess.sectorId, row.shiftSectorId),
            ),
            eq(professionalAccess.canAccess, true),
          ),
        )
        .orderBy(professionalAccess.id)
        .limit(1);
      if (!access) {
        invalid(target.original
          ? "Titular sem acesso ao hospital ou setor deste plantão"
          : "Substituto sem acesso ao hospital ou setor deste plantão");
      }
      accesses.push({ target, id: access.id });
    }
    for (const { target, id } of accesses.sort((left, right) => left.id - right.id)) {
      const [lockedAccess] = await db
        .select({ id: professionalAccess.id })
        .from(professionalAccess)
        .where(
          and(
            eq(professionalAccess.id, id),
            eq(professionalAccess.professionalId, target.professionalId),
            eq(professionalAccess.institutionId, row.shiftInstitutionId),
            eq(professionalAccess.hospitalId, row.shiftHospitalId),
            or(
              isNull(professionalAccess.sectorId),
              eq(professionalAccess.sectorId, row.shiftSectorId),
            ),
            eq(professionalAccess.canAccess, true),
          ),
        )
        .limit(1)
        .for("update");
      if (!lockedAccess) {
        invalid(target.original
          ? "Titular sem acesso ao hospital ou setor deste plantão"
          : "Substituto sem acesso ao hospital ou setor deste plantão");
      }
    }
  } else if (requireOriginalMembership && !row.originalMembershipActive) {
    invalid("Titular sem vínculo ativo nesta instituição");
  }

  if (requireOriginalAccess && !options.lockForUpdate) {
    const originalAccessQuery = db
      .select({ id: professionalAccess.id })
      .from(professionalAccess)
      .where(
        and(
          eq(professionalAccess.professionalId, conf.professionalId),
          eq(professionalAccess.institutionId, row.shiftInstitutionId),
          eq(professionalAccess.hospitalId, row.shiftHospitalId),
          or(
            isNull(professionalAccess.sectorId),
            eq(professionalAccess.sectorId, row.shiftSectorId),
          ),
          eq(professionalAccess.canAccess, true),
        ),
      )
      .limit(1);
    const [originalAccess] = await originalAccessQuery;
    if (!originalAccess) invalid("Titular sem acesso ao hospital ou setor deste plantão");
  }
  if (options.requireOriginalAssignmentActive !== false && !currentAssignmentIsActive) {
    invalid("Esta alocação foi removida da escala — não há o que confirmar.", "BAD_REQUEST");
  }

  let replacement: ValidatedDutyConfirmation["replacement"] = null;

  if (needsReplacementAuthority) {
    if (lockedAuthorities) {
      const lockedReplacement = lockedAuthorities.get(conf.replacementProfessionalId!);
      if (!lockedReplacement || lockedReplacement.userId !== conf.replacementUserId) {
        invalid("Substituto inválido");
      }
      replacement = {
        assignmentId: null,
        professionalId: conf.replacementProfessionalId!,
        userId: lockedReplacement.userId,
        name: lockedReplacement.name,
        specialty: lockedReplacement.specialty,
      };
    } else {
      const replacementQuery = db
      .select({
        professionalId: professionals.id,
        userId: professionals.userId,
        name: professionals.name,
        specialty: professionals.specialty,
      })
      .from(professionals)
      .innerJoin(
        professionalInstitutions,
        and(
          eq(professionalInstitutions.professionalId, professionals.id),
          eq(professionalInstitutions.userId, professionals.userId),
          eq(professionalInstitutions.institutionId, conf.institutionId),
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
      .innerJoin(
        professionalAccess,
        and(
          eq(professionalAccess.professionalId, professionals.id),
          eq(professionalAccess.institutionId, conf.institutionId),
          eq(professionalAccess.hospitalId, row.shiftHospitalId),
          or(
            isNull(professionalAccess.sectorId),
            eq(professionalAccess.sectorId, row.shiftSectorId),
          ),
          eq(professionalAccess.canAccess, true),
        ),
      )
      .where(
        and(
          eq(professionals.id, conf.replacementProfessionalId!),
          eq(professionals.userId, conf.replacementUserId!),
        ),
      )
      .limit(1);
      const [replacementPerson] = await replacementQuery;
      if (!replacementPerson) invalid("Substituto sem vínculo ativo nesta instituição");
      replacement = {
        assignmentId: null,
        professionalId: replacementPerson.professionalId,
        userId: replacementPerson.userId,
        name: replacementPerson.name,
        specialty: replacementPerson.specialty,
      };
    }
    if (
      options.expectedActor?.kind === "REPLACEMENT" &&
      replacement.userId !== options.expectedActor.userId
    ) invalid("Você não é o profissional indicado");
  }

  let effective: EffectiveDutyTarget = {
    assignmentId: row.assignmentId,
    professionalId: conf.professionalId,
    userId: conf.userId,
  };
  if (options.requireEffectiveAssignment && conf.status === "REPLACEMENT_CONFIRMED") {
    if (!replacement) invalid("Substituto inválido");
    if (currentAssignmentIsActive) {
      invalid("A alocação original ainda está ativa", "BAD_REQUEST");
    }
    const replacementAssignmentQuery = db
      .select({ id: shiftAssignmentsV2.id })
      .from(shiftAssignmentsV2)
      .where(
        and(
          eq(shiftAssignmentsV2.shiftInstanceId, row.shiftId),
          eq(shiftAssignmentsV2.institutionId, row.shiftInstitutionId),
          eq(shiftAssignmentsV2.hospitalId, row.shiftHospitalId),
          eq(shiftAssignmentsV2.sectorId, row.shiftSectorId),
          eq(shiftAssignmentsV2.professionalId, replacement.professionalId),
          eq(shiftAssignmentsV2.assignmentType, currentAssignmentType),
          eq(shiftAssignmentsV2.status, "OCUPADO"),
          eq(shiftAssignmentsV2.isActive, true),
        ),
      )
      .limit(1);
    const [replacementAssignment] = options.lockForUpdate
      ? prelockedEffectiveAssignmentId
        ? [{ id: prelockedEffectiveAssignmentId }]
        : []
      : await replacementAssignmentQuery;
    if (!replacementAssignment) invalid("Substituto não está alocado neste plantão");
    replacement.assignmentId = replacementAssignment.id;
    effective = {
      assignmentId: replacementAssignment.id,
      professionalId: replacement.professionalId,
      userId: replacement.userId,
    };
  } else if (options.requireEffectiveAssignment && !currentAssignmentIsActive) {
    invalid("A alocação efetiva não está ativa", "BAD_REQUEST");
  }

  return {
    confirmation: conf,
    original: {
      assignmentId: row.assignmentId,
      professionalId: conf.professionalId,
      userId: conf.userId,
      assignmentType: currentAssignmentType,
      isActive: currentAssignmentIsActive,
      name: row.originalName,
    },
    replacement,
    effective,
    shift: {
      id: row.shiftId,
      institutionId: row.shiftInstitutionId,
      hospitalId: row.shiftHospitalId,
      sectorId: row.shiftSectorId,
      label: currentLockedShift?.label ?? row.shiftLabel,
      startAt: currentShiftStartAt,
      endAt: currentLockedShift?.endAt ?? row.shiftEndAt,
      modality: currentLockedShift?.modality ?? row.shiftModality,
      specialty: currentLockedShift?.specialty ?? row.shiftSpecialty,
      sectorName: canonicalSector.name,
    },
  };
}

export type DutyConfirmationRecipientAuthority =
  | "ORIGINAL"
  | "REPLACEMENT"
  | "EFFECTIVE"
  | "MANAGER";

type ManagerRecipientSnapshot = {
  professionalId: number;
  membershipId: number;
  scopeId: number | null;
  role: "GESTOR_MEDICO" | "GESTOR_PLUS" | "GLOBAL_ADMIN";
};

async function findAuthorizedManagerRecipient(
  db: ConfirmationReadDb,
  shift: ValidatedDutyConfirmation["shift"],
  expectedUserId: number,
): Promise<ManagerRecipientSnapshot | null> {
  const [scopedManager] = await db
    .select({
      scopeId: managerScope.id,
      professionalId: professionals.id,
      membershipId: professionalInstitutions.id,
    })
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
        eq(professionalInstitutions.institutionId, shift.institutionId),
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
        eq(professionals.userId, expectedUserId),
        eq(managerScope.institutionId, shift.institutionId),
        eq(managerScope.hospitalId, shift.hospitalId),
        or(isNull(managerScope.sectorId), eq(managerScope.sectorId, shift.sectorId)),
        eq(managerScope.active, true),
      ),
    )
    .orderBy(professionals.id, managerScope.id)
    .limit(1);
  if (scopedManager) return { ...scopedManager, role: "GESTOR_MEDICO" };

  const [gestorPlus] = await db
    .select({
      professionalId: professionals.id,
      membershipId: professionalInstitutions.id,
    })
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
        eq(professionals.userId, expectedUserId),
        eq(professionalInstitutions.institutionId, shift.institutionId),
        eq(professionalInstitutions.roleInInstitution, "GESTOR_PLUS"),
        eq(professionalInstitutions.active, true),
      ),
    )
    .orderBy(professionals.id)
    .limit(1);
  if (gestorPlus) return { ...gestorPlus, scopeId: null, role: "GESTOR_PLUS" };

  const [globalAdmin] = await db
    .select({
      professionalId: professionals.id,
      membershipId: professionalInstitutions.id,
    })
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
        eq(users.role, "admin"),
        eq(users.approvalStatus, "APPROVED"),
        isNull(users.deletedAt),
      ),
    )
    .where(
      and(
        eq(professionals.userId, expectedUserId),
        eq(professionalInstitutions.institutionId, shift.institutionId),
        eq(professionalInstitutions.active, true),
      ),
    )
    .orderBy(professionals.id)
    .limit(1);
  return globalAdmin ? { ...globalAdmin, scopeId: null, role: "GLOBAL_ADMIN" } : null;
}

/**
 * Revalida o destinatario imediatamente antes de cada tentativa externa.
 * O outbox nunca transforma uma autorizacao antiga em autorizacao atual.
 */
export async function requireAuthorizedDutyConfirmationRecipient(
  db: ConfirmationReadDb,
  input: {
    confirmationId: number;
    allowedStatuses: readonly DutyConfirmationStatus[];
    recipientKind: DutyConfirmationRecipientAuthority;
    expectedUserId: number;
    shiftSnapshot: DutyShiftSnapshot;
    allowInactiveOriginalAssignment?: boolean;
    lockForUpdate?: boolean;
  },
): Promise<ValidatedDutyConfirmation> {
  const validationOptions: ValidationOptions = {
    allowedStatuses: input.allowedStatuses,
    // A perda de vínculo do titular é precisamente um motivo para alertar um
    // gestor ainda autorizado. Ela não pode apagar silenciosamente a
    // escalação; os demais destinatários continuam exigindo PI/ACL atuais.
    requireOriginalMembership: input.recipientKind !== "MANAGER",
    allowMissingOriginalMembership: input.recipientKind === "MANAGER",
    allowInvalidOriginalUser: input.recipientKind === "MANAGER",
    requireOriginalAccess: input.recipientKind !== "MANAGER",
    requireOriginalAssignmentActive: !input.allowInactiveOriginalAssignment,
    requireReplacementMembership: input.recipientKind === "REPLACEMENT",
    requireEffectiveAssignment: input.recipientKind === "EFFECTIVE",
  };
  let managerSnapshot: ManagerRecipientSnapshot | null = null;
  if (input.recipientKind === "MANAGER" && input.lockForUpdate) {
    const preflight = await requireValidDutyConfirmation(
      db,
      input.confirmationId,
      validationOptions,
    );
    assertDutyShiftSnapshot(preflight.shift, input.shiftSnapshot);
    managerSnapshot = await findAuthorizedManagerRecipient(
      db,
      preflight.shift,
      input.expectedUserId,
    );
    if (!managerSnapshot) invalid("Gestor sem escopo ativo para receber o alerta");
  }
  const valid = await requireValidDutyConfirmation(db, input.confirmationId, {
    ...validationOptions,
    ...(managerSnapshot
      ? {
          additionalAuthorityTargets: [{
            professionalId: managerSnapshot.professionalId,
            userId: input.expectedUserId,
            requireAccess: false,
          }],
        }
      : {}),
    lockForUpdate: input.lockForUpdate,
  });
  assertDutyShiftSnapshot(valid.shift, input.shiftSnapshot);

  if (input.recipientKind === "REPLACEMENT") {
    if (valid.replacement?.userId !== input.expectedUserId) {
      invalid("Substituto do outbox nao corresponde ao vinculo atual");
    }
    return valid;
  }
  if (input.recipientKind === "EFFECTIVE") {
    if (valid.effective.userId !== input.expectedUserId) {
      invalid("Destinatario efetivo do outbox nao corresponde a escala atual");
    }
    return valid;
  }

  if (input.recipientKind === "ORIGINAL") {
    if (valid.original.userId !== input.expectedUserId) {
      invalid("Titular do outbox nao corresponde a confirmacao atual");
    }
    // Em REPLACEMENT_CONFIRMED a validacao estrutural permite que o titular
    // antigo esteja inativo, pois ele deixou de ser o plantonista efetivo.
    // Para receber push institucional, contudo, o vinculo atual segue sendo
    // obrigatorio.
    const [membership] = await db
      .select({ id: professionalInstitutions.id })
      .from(professionalInstitutions)
      .where(
        and(
          eq(professionalInstitutions.professionalId, valid.original.professionalId),
          eq(professionalInstitutions.userId, input.expectedUserId),
          eq(professionalInstitutions.institutionId, valid.shift.institutionId),
          eq(professionalInstitutions.active, true),
        ),
      )
      .limit(1);
    const [access] = await db
      .select({ id: professionalAccess.id })
      .from(professionalAccess)
      .where(
        and(
          eq(professionalAccess.professionalId, valid.original.professionalId),
          eq(professionalAccess.institutionId, valid.shift.institutionId),
          eq(professionalAccess.hospitalId, valid.shift.hospitalId),
          or(
            isNull(professionalAccess.sectorId),
            eq(professionalAccess.sectorId, valid.shift.sectorId),
          ),
          eq(professionalAccess.canAccess, true),
        ),
      )
      .orderBy(professionalAccess.id)
      .limit(1);
    if (!membership || !access) {
      invalid("Titular sem vinculo ou acesso ativo para receber o push");
    }
    if (input.lockForUpdate) {
      const [lockedMembership] = await db
        .select({ id: professionalInstitutions.id })
        .from(professionalInstitutions)
        .where(
          and(
            eq(professionalInstitutions.id, membership.id),
            eq(professionalInstitutions.professionalId, valid.original.professionalId),
            eq(professionalInstitutions.userId, input.expectedUserId),
            eq(professionalInstitutions.institutionId, valid.shift.institutionId),
            eq(professionalInstitutions.active, true),
          ),
        )
        .limit(1)
        .for("update");
      const [lockedAccess] = await db
        .select({ id: professionalAccess.id })
        .from(professionalAccess)
        .where(
          and(
            eq(professionalAccess.id, access.id),
            eq(professionalAccess.professionalId, valid.original.professionalId),
            eq(professionalAccess.institutionId, valid.shift.institutionId),
            eq(professionalAccess.hospitalId, valid.shift.hospitalId),
            or(
              isNull(professionalAccess.sectorId),
              eq(professionalAccess.sectorId, valid.shift.sectorId),
            ),
            eq(professionalAccess.canAccess, true),
          ),
        )
        .limit(1)
        .for("update");
      if (!lockedMembership || !lockedAccess) {
        invalid("Titular sem vinculo ou acesso ativo para receber o push");
      }
    }
    return valid;
  }

  const manager = await findAuthorizedManagerRecipient(
    db,
    valid.shift,
    input.expectedUserId,
  );
  if (!manager) invalid("Gestor sem escopo ativo para receber o alerta");
  if (
    managerSnapshot &&
    (
      manager.professionalId !== managerSnapshot.professionalId ||
      manager.membershipId !== managerSnapshot.membershipId ||
      manager.scopeId !== managerSnapshot.scopeId ||
      manager.role !== managerSnapshot.role
    )
  ) invalid("A autoridade gerencial mudou durante o retry");
  if (input.lockForUpdate) {
    const [currentMembership] = await db
      .select({ id: professionalInstitutions.id })
      .from(professionalInstitutions)
      .where(
        and(
          eq(professionalInstitutions.id, manager.membershipId),
          eq(professionalInstitutions.professionalId, manager.professionalId),
          eq(professionalInstitutions.userId, input.expectedUserId),
          eq(professionalInstitutions.institutionId, valid.shift.institutionId),
          manager.role === "GLOBAL_ADMIN"
            ? undefined
            : eq(professionalInstitutions.roleInInstitution, manager.role),
          eq(professionalInstitutions.active, true),
        ),
      )
      .limit(1)
      .for("update");
    let currentScope = { id: 0 } as { id: number } | undefined;
    if (manager.scopeId !== null) {
      [currentScope] = await db
        .select({ id: managerScope.id })
        .from(managerScope)
        .where(
          and(
            eq(managerScope.id, manager.scopeId),
            eq(managerScope.managerProfessionalId, manager.professionalId),
            eq(managerScope.institutionId, valid.shift.institutionId),
            eq(managerScope.hospitalId, valid.shift.hospitalId),
            or(isNull(managerScope.sectorId), eq(managerScope.sectorId, valid.shift.sectorId)),
            eq(managerScope.active, true),
          ),
        )
        .limit(1)
        .for("update");
    }
    let currentGlobalAdmin = { id: 0 } as { id: number } | undefined;
    if (manager.role === "GLOBAL_ADMIN") {
      [currentGlobalAdmin] = await db
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.id, input.expectedUserId),
            eq(users.role, "admin"),
            eq(users.approvalStatus, "APPROVED"),
            isNull(users.deletedAt),
          ),
        )
        .limit(1)
        .for("update");
    }
    if (!currentMembership || !currentScope || !currentGlobalAdmin) {
      invalid("Gestor sem escopo ativo para receber o alerta");
    }
  }
  return valid;
}
