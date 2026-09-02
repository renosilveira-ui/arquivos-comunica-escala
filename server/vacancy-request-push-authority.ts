import { and, eq, isNull, or } from "drizzle-orm";
import {
  hospitals,
  managerScope,
  professionalInstitutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../drizzle/schema";
import type { getDb } from "./db";
import { PersistedPushAuthorityBindingError } from "./push-authority-rejection";

export const VACANCY_REQUEST_PUSH_PURPOSES = [
  "MANAGER_ACTION_REQUIRED",
  "REQUEST_APPROVED",
  "REQUEST_REJECTED",
] as const;

export type VacancyRequestPushPurpose =
  (typeof VACANCY_REQUEST_PUSH_PURPOSES)[number];

export const VACANCY_REQUEST_PUSH_POLICY = {
  MANAGER_ACTION_REQUIRED: {
    payloadType: "vacancy_request_created",
    recipientKind: "RESPONSIBLE_MANAGER",
    assignmentStatus: "PENDENTE",
    isActive: true,
  },
  REQUEST_APPROVED: {
    payloadType: "vacancy_request_approved",
    recipientKind: "REQUESTER",
    assignmentStatus: "OCUPADO",
    isActive: true,
  },
  REQUEST_REJECTED: {
    payloadType: "vacancy_request_rejected",
    recipientKind: "REQUESTER",
    assignmentStatus: "REJEITADO",
    isActive: false,
  },
} as const satisfies Record<
  VacancyRequestPushPurpose,
  {
    payloadType: string;
    recipientKind: "RESPONSIBLE_MANAGER" | "REQUESTER";
    assignmentStatus: "PENDENTE" | "OCUPADO" | "REJEITADO";
    isActive: boolean;
  }
>;

export type VacancyRequestPushAuthority = {
  kind: "VACANCY_REQUEST";
  purpose: VacancyRequestPushPurpose;
  assignmentId: number;
  expectedUserId: number;
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

export function parseVacancyRequestPushAuthority(
  value: Readonly<Record<string, unknown>>,
): VacancyRequestPushAuthority | null {
  if (
    value.kind !== "VACANCY_REQUEST" ||
    typeof value.purpose !== "string" ||
    !VACANCY_REQUEST_PUSH_PURPOSES.includes(
      value.purpose as VacancyRequestPushPurpose,
    ) ||
    !positiveId(value.assignmentId) ||
    !positiveId(value.expectedUserId) ||
    !positiveId(value.institutionId) ||
    !positiveId(value.hospitalId) ||
    !positiveId(value.sectorId) ||
    !positiveId(value.shiftInstanceId)
  ) {
    return null;
  }
  return value as VacancyRequestPushAuthority;
}

export function vacancyRequestAuthorityMatchesPayload(
  authority: VacancyRequestPushAuthority,
  payloadData: Readonly<Record<string, unknown>>,
): boolean {
  const policy = VACANCY_REQUEST_PUSH_POLICY[authority.purpose];
  return (
    payloadData.type === policy.payloadType &&
    payloadData.institutionId === authority.institutionId &&
    payloadData.hospitalId === authority.hospitalId &&
    payloadData.sectorId === authority.sectorId &&
    payloadData.shiftInstanceId === authority.shiftInstanceId &&
    payloadData.assignmentId === authority.assignmentId
  );
}

export function isVacancyRequestPushPayload(
  payloadData: Readonly<Record<string, unknown>>,
): boolean {
  return Object.values(VACANCY_REQUEST_PUSH_POLICY).some(
    (policy) => policy.payloadType === payloadData.type,
  );
}

export async function listResponsibleVacancyManagerUserIds(
  db: AuthorityDb,
  topology: {
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
        eq(professionalInstitutions.institutionId, topology.institutionId),
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
        eq(managerScope.institutionId, topology.institutionId),
        eq(managerScope.hospitalId, topology.hospitalId),
        or(
          isNull(managerScope.sectorId),
          eq(managerScope.sectorId, topology.sectorId),
        ),
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
        eq(professionalInstitutions.institutionId, topology.institutionId),
        eq(professionalInstitutions.roleInInstitution, "GESTOR_PLUS"),
        eq(professionalInstitutions.active, true),
      ),
    );

  const globalAdmins = await db
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
        eq(users.role, "admin"),
        eq(users.approvalStatus, "APPROVED"),
        isNull(users.deletedAt),
      ),
    )
    .where(
      and(
        eq(professionalInstitutions.institutionId, topology.institutionId),
        eq(professionalInstitutions.active, true),
      ),
    );

  return [
    ...new Set(
      [...scopedManagers, ...gestoresPlus, ...globalAdmins].map(
        (row) => row.userId,
      ),
    ),
  ].sort((left, right) => left - right);
}

export async function requireAuthorizedVacancyRequestRecipient(
  db: AuthorityDb,
  authority: VacancyRequestPushAuthority,
  lockForShare = false,
): Promise<void> {
  const assignmentQuery = db
    .select({
      assignmentId: shiftAssignmentsV2.id,
      assignmentStatus: shiftAssignmentsV2.status,
      assignmentActive: shiftAssignmentsV2.isActive,
      assignmentProfessionalId: shiftAssignmentsV2.professionalId,
      requesterUserId: professionals.userId,
      institutionId: shiftInstances.institutionId,
      hospitalId: shiftInstances.hospitalId,
      sectorId: shiftInstances.sectorId,
      shiftInstanceId: shiftInstances.id,
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
    .innerJoin(
      professionals,
      eq(professionals.id, shiftAssignmentsV2.professionalId),
    )
    .where(
      and(
        eq(shiftAssignmentsV2.id, authority.assignmentId),
        eq(shiftAssignmentsV2.institutionId, authority.institutionId),
        eq(shiftAssignmentsV2.hospitalId, authority.hospitalId),
        eq(shiftAssignmentsV2.sectorId, authority.sectorId),
        eq(shiftAssignmentsV2.shiftInstanceId, authority.shiftInstanceId),
      ),
    )
    .limit(1);
  const [assignment] = lockForShare
    ? await assignmentQuery.for("share")
    : await assignmentQuery;
  if (!assignment) invalid("Solicitação de vaga ausente ou fora da topologia");

  const policy = VACANCY_REQUEST_PUSH_POLICY[authority.purpose];
  if (
    assignment.assignmentStatus !== policy.assignmentStatus ||
    assignment.assignmentActive !== policy.isActive
  ) {
    invalid("Solicitação de vaga não está mais no estado da notificação");
  }

  if (policy.recipientKind === "REQUESTER") {
    if (assignment.requesterUserId !== authority.expectedUserId) {
      invalid("Solicitante da vaga não corresponde ao destinatário");
    }
    const membershipQuery = db
      .select({ id: professionalInstitutions.id })
      .from(professionalInstitutions)
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
          eq(
            professionalInstitutions.professionalId,
            assignment.assignmentProfessionalId,
          ),
          eq(professionalInstitutions.userId, authority.expectedUserId),
          eq(professionalInstitutions.institutionId, authority.institutionId),
          eq(professionalInstitutions.active, true),
        ),
      )
      .limit(1);
    const membership = lockForShare
      ? await membershipQuery.for("share")
      : await membershipQuery;
    if (!membership[0]) invalid("Solicitante perdeu o vínculo institucional");
    return;
  }

  const managerMembershipQuery = db
    .select({
      professionalId: professionals.id,
      roleInInstitution: professionalInstitutions.roleInInstitution,
      globalRole: users.role,
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
        eq(professionalInstitutions.userId, authority.expectedUserId),
        eq(professionalInstitutions.institutionId, authority.institutionId),
        eq(professionalInstitutions.active, true),
      ),
    )
    .limit(1);
  const managerMembership = lockForShare
    ? await managerMembershipQuery.for("share")
    : await managerMembershipQuery;
  const manager = managerMembership[0];
  if (!manager) invalid("Gestor perdeu o vínculo institucional");
  if (
    manager.globalRole === "admin" ||
    manager.roleInInstitution === "GESTOR_PLUS"
  ) {
    return;
  }
  if (manager.roleInInstitution !== "GESTOR_MEDICO") {
    invalid("Destinatário não possui papel gerencial atual");
  }

  const scopeQuery = db
    .select({ id: managerScope.id })
    .from(managerScope)
    .where(
      and(
        eq(managerScope.managerProfessionalId, manager.professionalId),
        eq(managerScope.institutionId, authority.institutionId),
        eq(managerScope.hospitalId, authority.hospitalId),
        or(
          isNull(managerScope.sectorId),
          eq(managerScope.sectorId, authority.sectorId),
        ),
        eq(managerScope.active, true),
      ),
    )
    .limit(1);
  const scope = lockForShare ? await scopeQuery.for("share") : await scopeQuery;
  if (!scope[0]) invalid("Gestor perdeu o escopo do hospital ou setor");
}
