import { TRPCError } from "@trpc/server";
import { and, eq, isNull, or } from "drizzle-orm";
import {
  dutyConfirmations,
  hospitals,
  professionalAccess,
  professionalInstitutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
} from "../drizzle/schema";
import type { getDb } from "./db";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
export type DutyConfirmationStatus = typeof dutyConfirmations.$inferSelect.status;

type ExpectedActor = {
  kind: "ORIGINAL" | "REPLACEMENT";
  userId: number;
};

type ValidationOptions = {
  allowedStatuses: readonly DutyConfirmationStatus[];
  expectedActor?: ExpectedActor;
  expectedInstitutionId?: number;
  requireOriginalAssignmentActive?: boolean;
  requireReplacementMembership?: boolean;
  requireEffectiveAssignment?: boolean;
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
  db: Db,
  confirmationId: number,
  options: ValidationOptions,
): Promise<ValidatedDutyConfirmation> {
  const [row] = await db
    .select({
      confirmation: dutyConfirmations,
      assignmentId: shiftAssignmentsV2.id,
      assignmentType: shiftAssignmentsV2.assignmentType,
      assignmentStatus: shiftAssignmentsV2.status,
      assignmentIsActive: shiftAssignmentsV2.isActive,
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
      sectorName: sectors.name,
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
      hospitals,
      and(
        eq(hospitals.id, shiftInstances.hospitalId),
        eq(hospitals.institutionId, shiftInstances.institutionId),
      ),
    )
    .innerJoin(
      sectors,
      and(
        eq(sectors.id, shiftInstances.sectorId),
        eq(sectors.institutionId, shiftInstances.institutionId),
        eq(sectors.hospitalId, shiftInstances.hospitalId),
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
    .innerJoin(
      professionalInstitutions,
      and(
        eq(professionalInstitutions.professionalId, professionals.id),
        eq(professionalInstitutions.userId, professionals.userId),
        eq(professionalInstitutions.institutionId, dutyConfirmations.institutionId),
      ),
    )
    .where(eq(dutyConfirmations.id, confirmationId))
    .limit(1);

  if (!row) invalid();
  const conf = row.confirmation;

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
  if (row.assignmentStatus !== "OCUPADO") {
    invalid("A alocação ainda não foi aprovada para este plantão", "BAD_REQUEST");
  }
  if (conf.status !== "REPLACEMENT_CONFIRMED" && !row.originalMembershipActive) {
    invalid("Titular sem vínculo ativo nesta instituição");
  }
  if (conf.status !== "REPLACEMENT_CONFIRMED") {
    const [originalAccess] = await db
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
    if (!originalAccess) invalid("Titular sem acesso ao hospital ou setor deste plantão");
  }
  if (options.requireOriginalAssignmentActive !== false && !row.assignmentIsActive) {
    invalid("Esta alocação foi removida da escala — não há o que confirmar.", "BAD_REQUEST");
  }

  const needsReplacement =
    options.requireReplacementMembership === true ||
    options.expectedActor?.kind === "REPLACEMENT" ||
    conf.status === "REPLACEMENT_CONFIRMED";
  let replacement: ValidatedDutyConfirmation["replacement"] = null;

  if (needsReplacement) {
    if (!conf.replacementProfessionalId || !conf.replacementUserId) invalid("Substituto inválido");
    const [replacementPerson] = await db
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
          eq(professionals.id, conf.replacementProfessionalId),
          eq(professionals.userId, conf.replacementUserId),
        ),
      )
      .limit(1);
    if (!replacementPerson) invalid("Substituto sem vínculo ativo nesta instituição");
    if (
      options.expectedActor?.kind === "REPLACEMENT" &&
      replacementPerson.userId !== options.expectedActor.userId
    ) {
      invalid("Você não é o profissional indicado");
    }
    replacement = {
      assignmentId: null,
      professionalId: replacementPerson.professionalId,
      userId: replacementPerson.userId,
      name: replacementPerson.name,
      specialty: replacementPerson.specialty,
    };
  }

  let effective: EffectiveDutyTarget = {
    assignmentId: row.assignmentId,
    professionalId: conf.professionalId,
    userId: conf.userId,
  };
  if (options.requireEffectiveAssignment && conf.status === "REPLACEMENT_CONFIRMED") {
    if (!replacement) invalid("Substituto inválido");
    if (row.assignmentIsActive) {
      invalid("A alocação original ainda está ativa", "BAD_REQUEST");
    }
    const [replacementAssignment] = await db
      .select({ id: shiftAssignmentsV2.id })
      .from(shiftAssignmentsV2)
      .where(
        and(
          eq(shiftAssignmentsV2.shiftInstanceId, row.shiftId),
          eq(shiftAssignmentsV2.institutionId, row.shiftInstitutionId),
          eq(shiftAssignmentsV2.hospitalId, row.shiftHospitalId),
          eq(shiftAssignmentsV2.sectorId, row.shiftSectorId),
          eq(shiftAssignmentsV2.professionalId, replacement.professionalId),
          eq(shiftAssignmentsV2.assignmentType, row.assignmentType),
          eq(shiftAssignmentsV2.status, "OCUPADO"),
          eq(shiftAssignmentsV2.isActive, true),
        ),
      )
      .limit(1);
    if (!replacementAssignment) invalid("Substituto não está alocado neste plantão");
    replacement.assignmentId = replacementAssignment.id;
    effective = {
      assignmentId: replacementAssignment.id,
      professionalId: replacement.professionalId,
      userId: replacement.userId,
    };
  } else if (options.requireEffectiveAssignment && !row.assignmentIsActive) {
    invalid("A alocação efetiva não está ativa", "BAD_REQUEST");
  }

  return {
    confirmation: conf,
    original: {
      assignmentId: row.assignmentId,
      professionalId: conf.professionalId,
      userId: conf.userId,
      assignmentType: row.assignmentType,
      isActive: row.assignmentIsActive,
      name: row.originalName,
    },
    replacement,
    effective,
    shift: {
      id: row.shiftId,
      institutionId: row.shiftInstitutionId,
      hospitalId: row.shiftHospitalId,
      sectorId: row.shiftSectorId,
      label: row.shiftLabel,
      startAt: row.shiftStartAt,
      endAt: row.shiftEndAt,
      modality: row.shiftModality,
      specialty: row.shiftSpecialty,
      sectorName: row.sectorName,
    },
  };
}
