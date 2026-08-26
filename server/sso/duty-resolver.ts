// server/sso/duty-resolver.ts — Resolve active duty context for SSO token
import { and, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  hospitals,
  institutions,
  monthlyRosters,
  professionalAccess,
  professionalInstitutions,
  shiftInstances,
  shiftAssignmentsV2,
  professionals,
  sectors,
  users,
} from "../../drizzle/schema";
import { yearMonthBrt } from "../local-time";
import { assertInstitutionHierarchy } from "../_core/tenant";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
export type SsoIssuanceTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface ActiveDutyContext {
  dutyType: "PLANTAO" | "SOBREAVISO";
  serviceName: string;
  sectorId: number;
  sectorRef: string | null;
  dutyStart: string; // ISO 8601
  dutyEnd: string;   // ISO 8601
}

export interface DutyResolution {
  activeDutyCount: number;
  contextConflict: boolean;
  duty: ActiveDutyContext | null;
  authoritySnapshot: DutyAuthoritySnapshot | null;
}

export type DutyAuthoritySnapshot = Readonly<{
  assignmentId: number;
  assignmentType: typeof shiftAssignmentsV2.$inferSelect.assignmentType;
  shiftId: number;
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  professionalId: number;
  userId: number;
  membershipId: number;
  accessId: number;
  accessSectorId: number | null;
  rosterId: number;
  rosterStatus: "PUBLISHED" | "LOCKED";
  rosterVersion: number;
  shiftStatus: string;
  startAt: Date;
  endAt: Date;
  sectorName: string;
  sessionVersion: number;
  userName: string | null;
  userEmail: string | null;
  userRole: typeof users.$inferSelect.role;
  roleInInstitution: typeof professionalInstitutions.$inferSelect.roleInInstitution;
}>;

export class DutyAuthorityChangedError extends Error {}

/**
 * Maps Escala assignmentType to Comunica+ dutyType.
 * ON_DUTY → PLANTAO, BACKUP/ON_CALL → SOBREAVISO
 */
function mapDutyType(assignmentType: string): "PLANTAO" | "SOBREAVISO" {
  if (assignmentType === "ON_DUTY") return "PLANTAO";
  return "SOBREAVISO";
}

/**
 * Finds active shift assignments for a user in a specific institution.
 * "Active" means the shift window includes now (with 30min tolerance).
 */
export async function resolveActiveDuty(input: {
  userId: number;
  institutionId: number;
  professionalId: number;
}): Promise<DutyResolution> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database unavailable");
  }

  const toleranceMinutes = 30;
  const now = new Date();
  const upperBound = new Date(now.getTime() + toleranceMinutes * 60_000);
  const lowerBound = new Date(now.getTime() - toleranceMinutes * 60_000);

  // A linha de assignment é a superfície de descoberta. Todos os demais
  // relacionamentos são LEFT JOINs deliberadamente: uma tupla contaminada
  // precisa permanecer visível para ser rejeitada, nunca simplesmente sumir
  // do resultado enquanto outra alocação válida autoriza o handoff.
  const discoveredAssignments = await db
    .select({
      assignmentId: shiftAssignmentsV2.id,
      assignmentType: shiftAssignmentsV2.assignmentType,
      assignmentStatus: shiftAssignmentsV2.status,
      assignmentInstitutionId: shiftAssignmentsV2.institutionId,
      assignmentHospitalId: shiftAssignmentsV2.hospitalId,
      assignmentSectorId: shiftAssignmentsV2.sectorId,
      assignmentProfessionalId: shiftAssignmentsV2.professionalId,
      shiftId: shiftInstances.id,
      shiftStatus: shiftInstances.status,
      shiftInstitutionId: shiftInstances.institutionId,
      shiftHospitalId: shiftInstances.hospitalId,
      shiftSectorId: shiftInstances.sectorId,
      startAt: shiftInstances.startAt,
      endAt: shiftInstances.endAt,
      sectorId: shiftInstances.sectorId,
      sectorName: sectors.name,
      canonicalInstitutionId: institutions.id,
      canonicalHospitalId: hospitals.id,
      canonicalSectorId: sectors.id,
      canonicalProfessionalId: professionals.id,
      canonicalProfessionalUserId: professionals.userId,
      canonicalMembershipId: professionalInstitutions.id,
      canonicalMembershipRole: professionalInstitutions.roleInInstitution,
      canonicalUserId: users.id,
      canonicalUserSessionVersion: users.sessionVersion,
      canonicalUserName: users.name,
      canonicalUserEmail: users.email,
      canonicalUserRole: users.role,
      canonicalAccessId: professionalAccess.id,
      canonicalAccessSectorId: professionalAccess.sectorId,
      rosterStatus: monthlyRosters.status,
      rosterId: monthlyRosters.id,
      rosterVersion: monthlyRosters.version,
    })
    .from(shiftAssignmentsV2)
    .innerJoin(shiftInstances, eq(shiftAssignmentsV2.shiftInstanceId, shiftInstances.id))
    .leftJoin(
      professionals,
      and(
        eq(professionals.id, shiftAssignmentsV2.professionalId),
        eq(professionals.id, input.professionalId),
        eq(professionals.userId, input.userId),
      ),
    )
    .leftJoin(
      professionalInstitutions,
      and(
        eq(professionalInstitutions.professionalId, professionals.id),
        eq(professionalInstitutions.userId, input.userId),
        eq(professionalInstitutions.institutionId, input.institutionId),
        eq(professionalInstitutions.active, true),
      ),
    )
    .leftJoin(
      users,
      and(
        eq(users.id, professionalInstitutions.userId),
        eq(users.approvalStatus, "APPROVED"),
        isNull(users.deletedAt),
      ),
    )
    .leftJoin(
      professionalAccess,
      and(
        eq(professionalAccess.professionalId, professionals.id),
        eq(professionalAccess.institutionId, shiftInstances.institutionId),
        eq(professionalAccess.hospitalId, shiftInstances.hospitalId),
        or(
          isNull(professionalAccess.sectorId),
          eq(professionalAccess.sectorId, shiftInstances.sectorId),
        ),
        eq(professionalAccess.canAccess, true),
      ),
    )
    .leftJoin(
      institutions,
      and(
        eq(institutions.id, shiftInstances.institutionId),
        eq(institutions.isActive, true),
      ),
    )
    .leftJoin(
      hospitals,
      and(
        eq(hospitals.id, shiftInstances.hospitalId),
        eq(hospitals.institutionId, shiftInstances.institutionId),
      ),
    )
    .leftJoin(
      sectors,
      and(
        eq(sectors.id, shiftInstances.sectorId),
        eq(sectors.institutionId, shiftInstances.institutionId),
        eq(sectors.hospitalId, shiftInstances.hospitalId),
      ),
    )
    .leftJoin(
      monthlyRosters,
      and(
        eq(monthlyRosters.institutionId, shiftInstances.institutionId),
        eq(monthlyRosters.hospitalId, shiftInstances.hospitalId),
        eq(
          monthlyRosters.yearMonth,
          sql<string>`DATE_FORMAT(DATE_SUB(${shiftInstances.startAt}, INTERVAL 3 HOUR), '%Y-%m')`,
        ),
      ),
    )
    .where(
      and(
        eq(shiftAssignmentsV2.professionalId, input.professionalId),
        eq(shiftAssignmentsV2.institutionId, input.institutionId),
        eq(shiftAssignmentsV2.isActive, true),
        lte(shiftInstances.startAt, upperBound),
        gte(shiftInstances.endAt, lowerBound),
      ),
    );

  // Um acesso hospitalar (sector_id NULL) e outro acesso setorial podem
  // autorizar a mesma alocacao. Isso nao representa dois plantoes: conserva
  // uma unica linha por assignment e fixa o menor ACL id para o snapshot.
  const assignmentsById = new Map<number, (typeof discoveredAssignments)[number]>();
  for (const assignment of discoveredAssignments) {
    const current = assignmentsById.get(assignment.assignmentId);
    if (
      !current ||
      (assignment.canonicalAccessId !== null &&
        (current.canonicalAccessId === null ||
          assignment.canonicalAccessId < current.canonicalAccessId))
    ) {
      assignmentsById.set(assignment.assignmentId, assignment);
    }
  }
  const activeAssignments = [...assignmentsById.values()];

  if (activeAssignments.length === 0) {
    return {
      activeDutyCount: 0,
      contextConflict: false,
      duty: null,
      authoritySnapshot: null,
    };
  }

  const invalid = activeAssignments.find(
    (assignment) =>
      assignment.assignmentStatus !== "OCUPADO" ||
      assignment.shiftStatus !== "OCUPADO" ||
      assignment.assignmentInstitutionId !== assignment.shiftInstitutionId ||
      assignment.assignmentHospitalId !== assignment.shiftHospitalId ||
      assignment.assignmentSectorId !== assignment.shiftSectorId ||
      assignment.shiftInstitutionId !== input.institutionId ||
      assignment.assignmentProfessionalId !== input.professionalId ||
      assignment.canonicalInstitutionId !== input.institutionId ||
      assignment.canonicalHospitalId !== assignment.shiftHospitalId ||
      assignment.canonicalSectorId !== assignment.shiftSectorId ||
      assignment.canonicalProfessionalId !== input.professionalId ||
      assignment.canonicalProfessionalUserId !== input.userId ||
      !assignment.canonicalMembershipId ||
      !assignment.canonicalMembershipRole ||
      assignment.canonicalUserId !== input.userId ||
      !assignment.canonicalAccessId ||
      !assignment.rosterId ||
      assignment.rosterVersion === null ||
      assignment.sectorName === null ||
      (assignment.rosterStatus !== "PUBLISHED" && assignment.rosterStatus !== "LOCKED"),
  );
  if (invalid) {
    console.warn(
      `[SSO] Alocação #${invalid.assignmentId} ignorada por topologia ou roster não oficial`,
    );
    return {
      activeDutyCount: 0,
      contextConflict: false,
      duty: null,
      authoritySnapshot: null,
    };
  }

  if (activeAssignments.length > 1) {
    // Multiple active duties — flag conflict, return first for reference
    const first = activeAssignments[0]!;
    return {
      activeDutyCount: activeAssignments.length,
      contextConflict: true,
      duty: {
        dutyType: mapDutyType(first.assignmentType),
        serviceName: first.sectorName!,
        sectorId: first.sectorId,
        sectorRef: null,
        dutyStart: new Date(first.startAt).toISOString(),
        dutyEnd: new Date(first.endAt).toISOString(),
      },
      authoritySnapshot: null,
    };
  }

  const assignment = activeAssignments[0]!;
  return {
    activeDutyCount: 1,
    contextConflict: false,
    duty: {
      dutyType: mapDutyType(assignment.assignmentType),
      serviceName: assignment.sectorName!,
      sectorId: assignment.sectorId,
      sectorRef: null,
      dutyStart: new Date(assignment.startAt).toISOString(),
      dutyEnd: new Date(assignment.endAt).toISOString(),
    },
    authoritySnapshot: {
      assignmentId: assignment.assignmentId,
      assignmentType: assignment.assignmentType,
      shiftId: assignment.shiftId,
      institutionId: assignment.assignmentInstitutionId,
      hospitalId: assignment.assignmentHospitalId,
      sectorId: assignment.assignmentSectorId,
      professionalId: assignment.assignmentProfessionalId,
      userId: assignment.canonicalUserId!,
      membershipId: assignment.canonicalMembershipId!,
      accessId: assignment.canonicalAccessId!,
      accessSectorId: assignment.canonicalAccessSectorId,
      rosterId: assignment.rosterId!,
      rosterStatus: assignment.rosterStatus as "PUBLISHED" | "LOCKED",
      rosterVersion: assignment.rosterVersion!,
      shiftStatus: assignment.shiftStatus,
      startAt: assignment.startAt,
      endAt: assignment.endAt,
      sectorName: assignment.sectorName!,
      sessionVersion: assignment.canonicalUserSessionVersion!,
      userName: assignment.canonicalUserName,
      userEmail: assignment.canonicalUserEmail,
      userRole: assignment.canonicalUserRole!,
      roleInInstitution: assignment.canonicalMembershipRole!,
    },
  };
}

/**
 * Ponto de linearizacao da emissao SSO.
 *
 * O snapshot usado para assinar o JWT e revalidado sob o protocolo global de
 * locks: roster -> shift -> assignment -> user -> professional -> PI/ACL.
 * Assim uma revogacao que venceu antes desta transacao nunca deixa JTI ou
 * auditoria duraveis; alteracoes posteriores esperam o commit da emissao.
 */
export async function assertDutyAuthoritySnapshotForIssuance(
  tx: SsoIssuanceTx,
  expected: DutyAuthoritySnapshot,
): Promise<void> {
  const changed = (): never => {
    throw new DutyAuthorityChangedError("Autoridade do plantao mudou durante a emissao");
  };

  const [roster] = await tx
    .select({
      id: monthlyRosters.id,
      institutionId: monthlyRosters.institutionId,
      hospitalId: monthlyRosters.hospitalId,
      yearMonth: monthlyRosters.yearMonth,
      status: monthlyRosters.status,
      version: monthlyRosters.version,
    })
    .from(monthlyRosters)
    .where(eq(monthlyRosters.id, expected.rosterId))
    .limit(1)
    .for("share");
  if (
    !roster ||
    roster.institutionId !== expected.institutionId ||
    roster.hospitalId !== expected.hospitalId ||
    roster.yearMonth !== yearMonthBrt(expected.startAt) ||
    roster.status !== expected.rosterStatus ||
    roster.version !== expected.rosterVersion ||
    (roster.status !== "PUBLISHED" && roster.status !== "LOCKED")
  ) changed();

  const [shift] = await tx
    .select({
      id: shiftInstances.id,
      institutionId: shiftInstances.institutionId,
      hospitalId: shiftInstances.hospitalId,
      sectorId: shiftInstances.sectorId,
      status: shiftInstances.status,
      startAt: shiftInstances.startAt,
      endAt: shiftInstances.endAt,
    })
    .from(shiftInstances)
    .where(eq(shiftInstances.id, expected.shiftId))
    .limit(1)
    .for("update");
  if (
    !shift ||
    shift.institutionId !== expected.institutionId ||
    shift.hospitalId !== expected.hospitalId ||
    shift.sectorId !== expected.sectorId ||
    shift.status !== expected.shiftStatus ||
    shift.status !== "OCUPADO" ||
    shift.startAt.getTime() !== expected.startAt.getTime() ||
    shift.endAt.getTime() !== expected.endAt.getTime()
  ) changed();

  const [assignment] = await tx
    .select({
      id: shiftAssignmentsV2.id,
      shiftInstanceId: shiftAssignmentsV2.shiftInstanceId,
      institutionId: shiftAssignmentsV2.institutionId,
      hospitalId: shiftAssignmentsV2.hospitalId,
      sectorId: shiftAssignmentsV2.sectorId,
      professionalId: shiftAssignmentsV2.professionalId,
      assignmentType: shiftAssignmentsV2.assignmentType,
      status: shiftAssignmentsV2.status,
      isActive: shiftAssignmentsV2.isActive,
    })
    .from(shiftAssignmentsV2)
    .where(eq(shiftAssignmentsV2.id, expected.assignmentId))
    .limit(1)
    .for("update");
  if (
    !assignment ||
    assignment.shiftInstanceId !== expected.shiftId ||
    assignment.institutionId !== expected.institutionId ||
    assignment.hospitalId !== expected.hospitalId ||
    assignment.sectorId !== expected.sectorId ||
    assignment.professionalId !== expected.professionalId ||
    assignment.assignmentType !== expected.assignmentType ||
    assignment.status !== "OCUPADO" ||
    !assignment.isActive
  ) changed();

  const [user] = await tx
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      approvalStatus: users.approvalStatus,
      deletedAt: users.deletedAt,
      sessionVersion: users.sessionVersion,
    })
    .from(users)
    .where(eq(users.id, expected.userId))
    .limit(1)
    .for("update");
  if (
    !user ||
    user.approvalStatus !== "APPROVED" ||
    user.deletedAt !== null ||
    user.sessionVersion !== expected.sessionVersion ||
    user.name !== expected.userName ||
    user.email !== expected.userEmail ||
    user.role !== expected.userRole
  ) changed();

  const [professional] = await tx
    .select({ id: professionals.id, userId: professionals.userId })
    .from(professionals)
    .where(eq(professionals.id, expected.professionalId))
    .limit(1)
    .for("update");
  if (!professional || professional.userId !== expected.userId) changed();

  const [membership] = await tx
    .select({
      id: professionalInstitutions.id,
      professionalId: professionalInstitutions.professionalId,
      userId: professionalInstitutions.userId,
      institutionId: professionalInstitutions.institutionId,
      roleInInstitution: professionalInstitutions.roleInInstitution,
      active: professionalInstitutions.active,
    })
    .from(professionalInstitutions)
    .where(eq(professionalInstitutions.id, expected.membershipId))
    .limit(1)
    .for("update");
  if (
    !membership ||
    membership.professionalId !== expected.professionalId ||
    membership.userId !== expected.userId ||
    membership.institutionId !== expected.institutionId ||
    membership.roleInInstitution !== expected.roleInInstitution ||
    !membership.active
  ) changed();

  const [access] = await tx
    .select({
      id: professionalAccess.id,
      institutionId: professionalAccess.institutionId,
      professionalId: professionalAccess.professionalId,
      hospitalId: professionalAccess.hospitalId,
      sectorId: professionalAccess.sectorId,
      canAccess: professionalAccess.canAccess,
    })
    .from(professionalAccess)
    .where(eq(professionalAccess.id, expected.accessId))
    .limit(1)
    .for("update");
  if (
    !access ||
    access.institutionId !== expected.institutionId ||
    access.professionalId !== expected.professionalId ||
    access.hospitalId !== expected.hospitalId ||
    access.sectorId !== expected.accessSectorId ||
    (access.sectorId !== null && access.sectorId !== expected.sectorId) ||
    !access.canAccess
  ) changed();

  const [institution] = await tx
    .select({ id: institutions.id, isActive: institutions.isActive })
    .from(institutions)
    .where(eq(institutions.id, expected.institutionId))
    .limit(1)
    .for("share");
  if (!institution?.isActive) changed();

  try {
    await assertInstitutionHierarchy(
      {
        institutionId: expected.institutionId,
        hospitalId: expected.hospitalId,
        sectorId: expected.sectorId,
      },
      { db: tx, lockForShare: true },
    );
  } catch {
    changed();
  }
  const [sector] = await tx
    .select({ name: sectors.name })
    .from(sectors)
    .where(eq(sectors.id, expected.sectorId))
    .limit(1)
    .for("share");
  if (!sector || sector.name !== expected.sectorName) changed();

  // A trava do profissional impede novos writers cooperativos. Esta leitura
  // READ COMMITTED detecta outro plantao que tenha vencido antes do mutex.
  const now = new Date();
  const upperBound = new Date(now.getTime() + 30 * 60_000);
  const lowerBound = new Date(now.getTime() - 30 * 60_000);
  const activeAssignments = await tx
    .select({ id: shiftAssignmentsV2.id })
    .from(shiftAssignmentsV2)
    .innerJoin(shiftInstances, eq(shiftAssignmentsV2.shiftInstanceId, shiftInstances.id))
    .where(
      and(
        eq(shiftAssignmentsV2.professionalId, expected.professionalId),
        eq(shiftAssignmentsV2.institutionId, expected.institutionId),
        eq(shiftAssignmentsV2.isActive, true),
        lte(shiftInstances.startAt, upperBound),
        gte(shiftInstances.endAt, lowerBound),
      ),
    );
  if (
    activeAssignments.length !== 1 ||
    activeAssignments[0]?.id !== expected.assignmentId
  ) changed();
}
