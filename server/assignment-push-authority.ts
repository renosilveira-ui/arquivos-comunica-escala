import { and, eq, isNull } from "drizzle-orm";
import {
  hospitals,
  professionalInstitutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../drizzle/schema";
import type { getDb } from "./db";
import { findCanonicalConfirmationAccessId } from "./confirmation-canonical-access";
import { PersistedPushAuthorityBindingError } from "./push-authority-rejection";

export const ASSIGNMENT_LIFECYCLE_PUSH_PURPOSES = [
  "ASSIGNED",
  "UNASSIGNED",
] as const;

export type AssignmentLifecyclePushPurpose =
  (typeof ASSIGNMENT_LIFECYCLE_PUSH_PURPOSES)[number];

export const ASSIGNMENT_LIFECYCLE_PUSH_POLICY = {
  ASSIGNED: {
    payloadType: "shift_assigned",
    assignmentActive: true,
    assignmentStatus: "OCUPADO",
  },
  UNASSIGNED: {
    payloadType: "shift_unassigned",
    assignmentActive: false,
    assignmentStatus: null,
  },
} as const satisfies Record<
  AssignmentLifecyclePushPurpose,
  {
    payloadType: string;
    assignmentActive: boolean;
    assignmentStatus: "OCUPADO" | null;
  }
>;

export type AssignmentLifecyclePushAuthority = {
  kind: "ASSIGNMENT_LIFECYCLE";
  purpose: AssignmentLifecyclePushPurpose;
  assignmentId: number;
  expectedUserId: number;
  professionalId: number;
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  shiftInstanceId: number;
};

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
type AuthorityDb = Pick<Db, "select">;

function invalid(message: string): never {
  throw new PersistedPushAuthorityBindingError(message);
}

function positiveId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function parseAssignmentLifecyclePushAuthority(
  value: Readonly<Record<string, unknown>>,
): AssignmentLifecyclePushAuthority | null {
  if (
    value.kind !== "ASSIGNMENT_LIFECYCLE" ||
    typeof value.purpose !== "string" ||
    !ASSIGNMENT_LIFECYCLE_PUSH_PURPOSES.includes(
      value.purpose as AssignmentLifecyclePushPurpose,
    ) ||
    !positiveId(value.assignmentId) ||
    !positiveId(value.expectedUserId) ||
    !positiveId(value.professionalId) ||
    !positiveId(value.institutionId) ||
    !positiveId(value.hospitalId) ||
    !positiveId(value.sectorId) ||
    !positiveId(value.shiftInstanceId)
  ) {
    return null;
  }
  return value as AssignmentLifecyclePushAuthority;
}

export function assignmentLifecycleAuthorityMatchesPayload(
  authority: AssignmentLifecyclePushAuthority,
  payloadData: Readonly<Record<string, unknown>>,
): boolean {
  const policy = ASSIGNMENT_LIFECYCLE_PUSH_POLICY[authority.purpose];
  return (
    payloadData.type === policy.payloadType &&
    payloadData.institutionId === authority.institutionId &&
    payloadData.hospitalId === authority.hospitalId &&
    payloadData.sectorId === authority.sectorId &&
    payloadData.shiftInstanceId === authority.shiftInstanceId &&
    payloadData.assignmentId === authority.assignmentId &&
    payloadData.professionalId === authority.professionalId
  );
}

export function isAssignmentLifecyclePushPayload(
  payloadData: Readonly<Record<string, unknown>>,
): boolean {
  return Object.values(ASSIGNMENT_LIFECYCLE_PUSH_POLICY).some(
    (policy) => policy.payloadType === payloadData.type,
  );
}

/**
 * Reconstrói a autoridade do destinatário no envio, sem confiar no produtor.
 * O registro da alocação, a topologia, a conta, o vínculo e a ACL precisam
 * continuar apontando para a mesma pessoa dentro do mesmo hospital e setor.
 */
export async function requireAuthorizedAssignmentLifecycleRecipient(
  db: AuthorityDb,
  authority: AssignmentLifecyclePushAuthority,
  lockForShare = false,
): Promise<void> {
  const assignmentQuery = db
    .select({
      assignmentStatus: shiftAssignmentsV2.status,
      assignmentActive: shiftAssignmentsV2.isActive,
      scheduleContextId: shiftInstances.scheduleContextId,
    })
    .from(shiftAssignmentsV2)
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
    .where(
      and(
        eq(shiftAssignmentsV2.id, authority.assignmentId),
        eq(shiftAssignmentsV2.professionalId, authority.professionalId),
        eq(shiftAssignmentsV2.institutionId, authority.institutionId),
        eq(shiftAssignmentsV2.hospitalId, authority.hospitalId),
        eq(shiftAssignmentsV2.sectorId, authority.sectorId),
        eq(shiftAssignmentsV2.shiftInstanceId, authority.shiftInstanceId),
      ),
    )
    .limit(1);
  const assignmentRows = lockForShare
    ? await assignmentQuery.for("share")
    : await assignmentQuery;
  const assignment = assignmentRows[0];
  if (!assignment) invalid("Alocação ausente ou fora da topologia persistida");

  const policy = ASSIGNMENT_LIFECYCLE_PUSH_POLICY[authority.purpose];
  if (
    assignment.assignmentActive !== policy.assignmentActive ||
    (policy.assignmentStatus !== null &&
      assignment.assignmentStatus !== policy.assignmentStatus)
  ) {
    invalid("Alocação não está mais no estado da notificação");
  }

  if (authority.purpose === "UNASSIGNED") {
    const currentAssignmentQuery = db
      .select({ id: shiftAssignmentsV2.id })
      .from(shiftAssignmentsV2)
      .where(
        and(
          eq(shiftAssignmentsV2.professionalId, authority.professionalId),
          eq(shiftAssignmentsV2.institutionId, authority.institutionId),
          eq(shiftAssignmentsV2.hospitalId, authority.hospitalId),
          eq(shiftAssignmentsV2.sectorId, authority.sectorId),
          eq(shiftAssignmentsV2.shiftInstanceId, authority.shiftInstanceId),
          eq(shiftAssignmentsV2.status, "OCUPADO"),
          eq(shiftAssignmentsV2.isActive, true),
        ),
      )
      .limit(1);
    const currentAssignments = lockForShare
      ? await currentAssignmentQuery.for("share")
      : await currentAssignmentQuery;
    if (currentAssignments[0]) {
      invalid("Profissional voltou a estar alocado no plantão");
    }
  }

  const membershipQuery = db
    .select({ id: professionalInstitutions.id })
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
        eq(users.id, professionalInstitutions.userId),
        eq(users.approvalStatus, "APPROVED"),
        isNull(users.deletedAt),
      ),
    )
    .where(
      and(
        eq(professionalInstitutions.professionalId, authority.professionalId),
        eq(professionalInstitutions.userId, authority.expectedUserId),
        eq(professionalInstitutions.institutionId, authority.institutionId),
        eq(professionalInstitutions.active, true),
      ),
    )
    .limit(1);
  const memberships = lockForShare
    ? await membershipQuery.for("share")
    : await membershipQuery;
  if (!memberships[0]) invalid("Profissional perdeu o vínculo institucional");

  const accessId = await findCanonicalConfirmationAccessId(db, {
    professionalId: authority.professionalId,
    institutionId: authority.institutionId,
    hospitalId: authority.hospitalId,
    sectorId: authority.sectorId,
    scheduleContextId: assignment.scheduleContextId,
  });
  if (!accessId) invalid("Profissional perdeu o acesso ao hospital ou setor");

  if (lockForShare) {
    const lockedAccessId = await findCanonicalConfirmationAccessId(db, {
      professionalId: authority.professionalId,
      institutionId: authority.institutionId,
      hospitalId: authority.hospitalId,
      sectorId: authority.sectorId,
      scheduleContextId: assignment.scheduleContextId,
      accessId,
      lockForUpdate: true,
    });
    if (!lockedAccessId) {
      invalid("Profissional perdeu o acesso ao hospital ou setor");
    }
  }
}
