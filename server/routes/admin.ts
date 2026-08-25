import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { randomInt } from "node:crypto";
import { eq, asc, desc, and, or, gte, lte, sql, isNull } from "drizzle-orm";
import { getDb } from "../db";
import {
  users,
  passwordResets,
  professionals,
  auditTrail,
  institutions,
  hospitals,
  professionalInstitutions,
  professionalAccess,
  dutyConfirmations,
  shiftAssignmentsV2,
  shiftInstances,
} from "../../drizzle/schema";
import { AuthenticationInfrastructureError, sdk } from "../_core/sdk";
import { SessionInstanceConstraintError } from "../_core/session-instance";
import { recordAudit } from "../audit-trail";
import { parseTenantIdHeader } from "../_core/tenant";
import {
  PUSH_ACCOUNT_MUTATION_LOCK_TIMEOUT_SEC,
  revokeUserPushRegistrations,
  withPushAccountMutex,
} from "../push-registration-revocation";

type UserRole = "admin" | "manager" | "doctor" | "nurse" | "tech";
type InstitutionRole = "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";

const USER_NAME_MAX_LENGTH = 255;
const USER_EMAIL_MAX_LENGTH = 320;
const PROFESSIONAL_SPECIALTY_MAX_LENGTH = 100;

const VALID_USER_ROLES: readonly UserRole[] = [
  "admin",
  "manager",
  "doctor",
  "nurse",
  "tech",
];
const VALID_INSTITUTION_ROLES: readonly InstitutionRole[] = [
  "USER",
  "GESTOR_MEDICO",
  "GESTOR_PLUS",
];

function mapRoleToInstitutionRole(role: UserRole): InstitutionRole {
  if (role === "admin") return "GESTOR_PLUS";
  if (role === "manager") return "GESTOR_MEDICO";
  return "USER";
}

/**
 * Projeção compatível com a build já liberada, cujo modal ainda entende o
 * campo `role` legado. O valor representa o papel NO TENANT; nunca concede
 * nem revoga `users.role=admin`.
 */
function projectInstitutionRoleToLegacyRole(
  roleInInstitution: InstitutionRole,
  globalRole: UserRole,
): UserRole {
  if (roleInInstitution === "GESTOR_PLUS") return "admin";
  if (roleInInstitution === "GESTOR_MEDICO") return "manager";
  return globalRole === "doctor" ||
    globalRole === "nurse" ||
    globalRole === "tech"
    ? globalRole
    : "doctor";
}

class AdminTenantError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

type AdminQueryDb = Pick<
  NonNullable<Awaited<ReturnType<typeof getDb>>>,
  "select"
>;

type AdminMutationAuthoritySnapshot = {
  membershipId: number;
  professionalId: number;
  userId: number;
  roleInInstitution: InstitutionRole;
  globalRole: UserRole;
  userName: string | null;
  email: string | null;
  passwordHash: string | null;
  mustChangePassword: boolean;
  sessionVersion: number;
  specialty: string | null;
};

function requireExplicitTenantHeader(req: Request): number {
  const institutionId = parseTenantIdHeader(req.headers["x-tenant-id"]);
  if (!institutionId) {
    throw new AdminTenantError(
      400,
      "x-tenant-id válido é obrigatório para administração",
    );
  }
  return institutionId;
}

async function requireCanonicalAdminMembership(
  db: AdminQueryDb,
  callerUserId: number,
  institutionId: number,
): Promise<number> {
  const snapshot = await readAdminMutationAuthoritySnapshot(db, {
    userId: callerUserId,
    institutionId,
    requireGlobalAdmin: true,
  });
  if (!snapshot) {
    throw new AdminTenantError(
      403,
      "Administrador sem vínculo canônico ativo no tenant informado",
    );
  }
  return snapshot.membershipId;
}

async function requireExplicitAdminTenant(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  req: Request,
): Promise<number> {
  const institutionId = requireExplicitTenantHeader(req);
  const caller = (req as any).user as { id: number };
  await requireCanonicalAdminMembership(db, caller.id, institutionId);
  return institutionId;
}

async function readAdminMutationAuthoritySnapshot(
  db: AdminQueryDb,
  input: { userId: number; institutionId: number; requireGlobalAdmin: boolean },
): Promise<AdminMutationAuthoritySnapshot | null> {
  const conditions = [
    eq(professionalInstitutions.userId, input.userId),
    eq(professionalInstitutions.institutionId, input.institutionId),
    eq(professionalInstitutions.active, true),
    eq(users.approvalStatus, "APPROVED"),
    isNull(users.deletedAt),
  ];
  if (input.requireGlobalAdmin) conditions.push(eq(users.role, "admin"));

  const [snapshot] = await db
    .select({
      membershipId: professionalInstitutions.id,
      professionalId: professionals.id,
      userId: users.id,
      roleInInstitution: professionalInstitutions.roleInInstitution,
      globalRole: users.role,
      userName: users.name,
      email: users.email,
      passwordHash: users.passwordHash,
      mustChangePassword: users.mustChangePassword,
      sessionVersion: users.sessionVersion,
      specialty: professionals.specialty,
    })
    .from(professionalInstitutions)
    .innerJoin(
      professionals,
      and(
        eq(professionals.id, professionalInstitutions.professionalId),
        eq(professionals.userId, professionalInstitutions.userId),
      ),
    )
    .innerJoin(users, eq(users.id, professionalInstitutions.userId))
    .innerJoin(
      institutions,
      and(
        eq(institutions.id, professionalInstitutions.institutionId),
        eq(institutions.isActive, true),
      ),
    )
    .where(and(...conditions))
    .limit(1);
  return snapshot ?? null;
}

function sameAdminMutationSnapshot(
  expected: AdminMutationAuthoritySnapshot,
  current: AdminMutationAuthoritySnapshot,
): boolean {
  return (
    expected.membershipId === current.membershipId &&
    expected.professionalId === current.professionalId &&
    expected.userId === current.userId &&
    expected.roleInInstitution === current.roleInInstitution &&
    expected.globalRole === current.globalRole &&
    expected.userName === current.userName &&
    expected.email === current.email &&
    expected.passwordHash === current.passwordHash &&
    expected.mustChangePassword === current.mustChangePassword &&
    expected.sessionVersion === current.sessionVersion &&
    expected.specialty === current.specialty
  );
}

function assertAuditSafeActorName(actorName: string | null): void {
  if (actorName && actorName.length > USER_NAME_MAX_LENGTH) {
    throw new AdminTenantError(
      409,
      "Nome do administrador excede o limite seguro da trilha de auditoria",
    );
  }
}

type EmailDutyConfirmationSnapshot = {
  id: number;
  institutionId: number;
  shiftInstanceId: number;
  assignmentId: number;
  professionalId: number;
  userId: number;
  replacementProfessionalId: number | null;
  replacementUserId: number | null;
  status: typeof dutyConfirmations.$inferSelect.status;
};

async function readEmailDutyConfirmationSnapshots(
  db: AdminQueryDb,
  userId: number,
): Promise<EmailDutyConfirmationSnapshot[]> {
  return db
    .select({
      id: dutyConfirmations.id,
      institutionId: dutyConfirmations.institutionId,
      shiftInstanceId: dutyConfirmations.shiftInstanceId,
      assignmentId: dutyConfirmations.assignmentId,
      professionalId: dutyConfirmations.professionalId,
      userId: dutyConfirmations.userId,
      replacementProfessionalId: dutyConfirmations.replacementProfessionalId,
      replacementUserId: dutyConfirmations.replacementUserId,
      status: dutyConfirmations.status,
    })
    .from(dutyConfirmations)
    .where(
      or(
        eq(dutyConfirmations.userId, userId),
        eq(dutyConfirmations.replacementUserId, userId),
      ),
    )
    .orderBy(asc(dutyConfirmations.id));
}

function sameEmailDutyConfirmationSnapshot(
  expected: EmailDutyConfirmationSnapshot,
  current: EmailDutyConfirmationSnapshot,
): boolean {
  return (
    expected.id === current.id &&
    expected.institutionId === current.institutionId &&
    expected.shiftInstanceId === current.shiftInstanceId &&
    expected.assignmentId === current.assignmentId &&
    expected.professionalId === current.professionalId &&
    expected.userId === current.userId &&
    expected.replacementProfessionalId === current.replacementProfessionalId &&
    expected.replacementUserId === current.replacementUserId &&
    expected.status === current.status
  );
}

function sameEmailDutyConfirmationSnapshots(
  expected: readonly EmailDutyConfirmationSnapshot[],
  current: readonly EmailDutyConfirmationSnapshot[],
): boolean {
  return (
    expected.length === current.length &&
    expected.every((snapshot, index) =>
      sameEmailDutyConfirmationSnapshot(snapshot, current[index]!),
    )
  );
}

/**
 * Ordem operacional global: shifts(S) → assignments(S) → confirmations(X).
 * A pré-leitura acontece sem lock; cada linha é travada por PK em ordem
 * crescente e toda a topologia é revalidada antes das autoridades pessoais.
 */
async function lockAndAssertEmailChangeAllowedForUpdate(
  db: AdminQueryDb,
  userId: number,
  snapshots: readonly EmailDutyConfirmationSnapshot[],
): Promise<void> {
  const shiftIds = [
    ...new Set(snapshots.map((row) => row.shiftInstanceId)),
  ].sort((left, right) => left - right);
  const assignmentIds = [
    ...new Set(snapshots.map((row) => row.assignmentId)),
  ].sort((left, right) => left - right);

  const lockedShifts = new Map<
    number,
    { institutionId: number; hospitalId: number; sectorId: number; endAt: Date }
  >();
  for (const shiftId of shiftIds) {
    const [shift] = await db
      .select({
        id: shiftInstances.id,
        institutionId: shiftInstances.institutionId,
        hospitalId: shiftInstances.hospitalId,
        sectorId: shiftInstances.sectorId,
        endAt: shiftInstances.endAt,
      })
      .from(shiftInstances)
      .where(eq(shiftInstances.id, shiftId))
      .limit(1)
      .for("share");
    if (!shift) {
      throw new AdminTenantError(
        409,
        "Plantão vinculado deixou de existir durante a edição",
      );
    }
    lockedShifts.set(shift.id, shift);
  }

  const lockedAssignments = new Map<
    number,
    {
      shiftInstanceId: number;
      institutionId: number;
      hospitalId: number;
      sectorId: number;
      professionalId: number;
    }
  >();
  for (const assignmentId of assignmentIds) {
    const [assignment] = await db
      .select({
        id: shiftAssignmentsV2.id,
        shiftInstanceId: shiftAssignmentsV2.shiftInstanceId,
        institutionId: shiftAssignmentsV2.institutionId,
        hospitalId: shiftAssignmentsV2.hospitalId,
        sectorId: shiftAssignmentsV2.sectorId,
        professionalId: shiftAssignmentsV2.professionalId,
      })
      .from(shiftAssignmentsV2)
      .where(eq(shiftAssignmentsV2.id, assignmentId))
      .limit(1)
      .for("share");
    if (!assignment) {
      throw new AdminTenantError(
        409,
        "Alocação vinculada deixou de existir durante a edição",
      );
    }
    lockedAssignments.set(assignment.id, assignment);
  }

  const lockedConfirmations: EmailDutyConfirmationSnapshot[] = [];
  for (const snapshot of snapshots) {
    const [confirmation] = await db
      .select({
        id: dutyConfirmations.id,
        institutionId: dutyConfirmations.institutionId,
        shiftInstanceId: dutyConfirmations.shiftInstanceId,
        assignmentId: dutyConfirmations.assignmentId,
        professionalId: dutyConfirmations.professionalId,
        userId: dutyConfirmations.userId,
        replacementProfessionalId: dutyConfirmations.replacementProfessionalId,
        replacementUserId: dutyConfirmations.replacementUserId,
        status: dutyConfirmations.status,
      })
      .from(dutyConfirmations)
      .where(eq(dutyConfirmations.id, snapshot.id))
      .limit(1)
      .for("update");
    if (
      !confirmation ||
      !sameEmailDutyConfirmationSnapshot(snapshot, confirmation)
    ) {
      throw new AdminTenantError(
        409,
        "Vínculo de confirmação mudou durante a edição",
      );
    }
    lockedConfirmations.push(confirmation);
  }

  const currentSnapshots = await readEmailDutyConfirmationSnapshots(db, userId);
  if (!sameEmailDutyConfirmationSnapshots(snapshots, currentSnapshots)) {
    throw new AdminTenantError(
      409,
      "Vínculos de plantão mudaram durante a edição; tente novamente",
    );
  }

  const now = new Date();
  for (const confirmation of lockedConfirmations) {
    const shift = lockedShifts.get(confirmation.shiftInstanceId);
    const assignment = lockedAssignments.get(confirmation.assignmentId);
    const replacementPairIsComplete =
      (confirmation.replacementProfessionalId === null) ===
      (confirmation.replacementUserId === null);
    if (
      !shift ||
      !assignment ||
      !replacementPairIsComplete ||
      assignment.shiftInstanceId !== confirmation.shiftInstanceId ||
      assignment.institutionId !== confirmation.institutionId ||
      assignment.professionalId !== confirmation.professionalId ||
      shift.institutionId !== assignment.institutionId ||
      shift.hospitalId !== assignment.hospitalId ||
      shift.sectorId !== assignment.sectorId
    ) {
      throw new AdminTenantError(
        409,
        "Topologia do plantão vinculado está inconsistente",
      );
    }
    if (shift.endAt > now) {
      throw new AdminTenantError(
        409,
        "E-mail não pode ser alterado enquanto houver plantão vinculado ainda não encerrado",
      );
    }
  }
}

async function assertEmailDutySnapshotStillCurrent(
  db: AdminQueryDb,
  userId: number,
  snapshots: readonly EmailDutyConfirmationSnapshot[],
): Promise<void> {
  const currentSnapshots = await readEmailDutyConfirmationSnapshots(db, userId);
  if (!sameEmailDutyConfirmationSnapshots(snapshots, currentSnapshots)) {
    throw new AdminTenantError(
      409,
      "Vínculos de plantão mudaram durante a edição; tente novamente",
    );
  }
}

type IdentityLockTarget = {
  userId: number;
  professionalId: number;
  membershipId: number;
  institutionId: number;
};

type LockedIdentityRows = {
  users: Map<
    number,
    {
      globalRole: UserRole;
      userName: string | null;
      email: string | null;
      passwordHash: string | null;
      mustChangePassword: boolean;
      sessionVersion: number;
      approvalStatus: typeof users.$inferSelect.approvalStatus;
      deletedAt: Date | null;
    }
  >;
  professionals: Map<
    number,
    {
      userId: number;
      name: string;
      role: string;
      userRole: InstitutionRole;
      specialty: string | null;
    }
  >;
  memberships: Map<
    number,
    {
      professionalId: number;
      userId: number;
      institutionId: number;
      roleInInstitution: InstitutionRole;
      isPrimary: boolean;
      active: boolean;
    }
  >;
};

/**
 * Ordem única de identidade: users(X) → professionals(X) → PI(X) →
 * institutions(S). Cada tabela é travada por PK crescente, sem JOIN FOR UPDATE.
 */
async function lockIdentityRowsInOrder(
  db: AdminQueryDb,
  targets: readonly IdentityLockTarget[],
): Promise<LockedIdentityRows> {
  const lockedUsers: LockedIdentityRows["users"] = new Map();
  const userIds = [...new Set(targets.map((target) => target.userId))].sort(
    (left, right) => left - right,
  );
  for (const userId of userIds) {
    const [user] = await db
      .select({
        globalRole: users.role,
        userName: users.name,
        email: users.email,
        passwordHash: users.passwordHash,
        mustChangePassword: users.mustChangePassword,
        sessionVersion: users.sessionVersion,
        approvalStatus: users.approvalStatus,
        deletedAt: users.deletedAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
      .for("update");
    if (!user)
      throw new AdminTenantError(
        409,
        "Conta mudou durante a operação administrativa",
      );
    lockedUsers.set(userId, user);
  }

  const lockedProfessionals: LockedIdentityRows["professionals"] = new Map();
  const professionalIds = [
    ...new Set(targets.map((target) => target.professionalId)),
  ].sort((left, right) => left - right);
  for (const professionalId of professionalIds) {
    const [professional] = await db
      .select({
        userId: professionals.userId,
        name: professionals.name,
        role: professionals.role,
        userRole: professionals.userRole,
        specialty: professionals.specialty,
      })
      .from(professionals)
      .where(eq(professionals.id, professionalId))
      .limit(1)
      .for("update");
    if (!professional) {
      throw new AdminTenantError(
        409,
        "Identidade profissional mudou durante a operação",
      );
    }
    lockedProfessionals.set(professionalId, professional);
  }

  const lockedMemberships: LockedIdentityRows["memberships"] = new Map();
  const membershipIds = [
    ...new Set(targets.map((target) => target.membershipId)),
  ].sort((left, right) => left - right);
  for (const membershipId of membershipIds) {
    const [membership] = await db
      .select({
        professionalId: professionalInstitutions.professionalId,
        userId: professionalInstitutions.userId,
        institutionId: professionalInstitutions.institutionId,
        roleInInstitution: professionalInstitutions.roleInInstitution,
        isPrimary: professionalInstitutions.isPrimary,
        active: professionalInstitutions.active,
      })
      .from(professionalInstitutions)
      .where(eq(professionalInstitutions.id, membershipId))
      .limit(1)
      .for("update");
    if (!membership) {
      throw new AdminTenantError(
        409,
        "Vínculo institucional mudou durante a operação",
      );
    }
    lockedMemberships.set(membershipId, membership);
  }

  const institutionIds = [
    ...new Set(targets.map((target) => target.institutionId)),
  ].sort((left, right) => left - right);
  for (const institutionId of institutionIds) {
    const [institution] = await db
      .select({ id: institutions.id })
      .from(institutions)
      .where(
        and(
          eq(institutions.id, institutionId),
          eq(institutions.isActive, true),
        ),
      )
      .limit(1)
      .for("share");
    if (!institution) {
      throw new AdminTenantError(
        403,
        "Instituição administrativa deixou de estar ativa",
      );
    }
  }

  return {
    users: lockedUsers,
    professionals: lockedProfessionals,
    memberships: lockedMemberships,
  };
}

function rebuildApprovedAdminAuthoritySnapshot(
  locked: LockedIdentityRows,
  expected: AdminMutationAuthoritySnapshot,
  institutionId: number,
): AdminMutationAuthoritySnapshot {
  const professional = locked.professionals.get(expected.professionalId);
  const membership = locked.memberships.get(expected.membershipId);
  const user = locked.users.get(expected.userId);
  if (
    !professional ||
    professional.userId !== expected.userId ||
    !membership ||
    membership.professionalId !== expected.professionalId ||
    membership.userId !== expected.userId ||
    membership.institutionId !== institutionId ||
    !membership.active ||
    !user ||
    user.approvalStatus !== "APPROVED" ||
    user.deletedAt
  ) {
    throw new AdminTenantError(
      409,
      "Autoridade administrativa mudou durante a operação",
    );
  }
  return {
    membershipId: expected.membershipId,
    professionalId: expected.professionalId,
    userId: expected.userId,
    roleInInstitution: membership.roleInInstitution,
    globalRole: user.globalRole,
    userName: user.userName,
    email: user.email,
    passwordHash: user.passwordHash,
    mustChangePassword: user.mustChangePassword,
    sessionVersion: user.sessionVersion,
    specialty: professional.specialty,
  };
}

async function lockAndRevalidateAdminMutationAuthorities(
  db: AdminQueryDb,
  input: {
    institutionId: number;
    caller: AdminMutationAuthoritySnapshot;
    target: AdminMutationAuthoritySnapshot;
    expectedCallerSessionVersion: number;
  },
): Promise<{
  caller: AdminMutationAuthoritySnapshot;
  target: AdminMutationAuthoritySnapshot;
}> {
  const locked = await lockIdentityRowsInOrder(db, [
    { ...input.caller, institutionId: input.institutionId },
    { ...input.target, institutionId: input.institutionId },
  ]);

  const caller = rebuildApprovedAdminAuthoritySnapshot(
    locked,
    input.caller,
    input.institutionId,
  );
  const target = rebuildApprovedAdminAuthoritySnapshot(
    locked,
    input.target,
    input.institutionId,
  );
  if (caller.globalRole !== "admin") {
    throw new AdminTenantError(
      403,
      "A conta deixou de possuir papel administrativo global",
    );
  }
  if (caller.sessionVersion !== input.expectedCallerSessionVersion) {
    throw new AdminTenantError(
      409,
      "A sessão administrativa foi revogada durante a operação; entre novamente",
    );
  }
  if (
    !sameAdminMutationSnapshot(input.caller, caller) ||
    !sameAdminMutationSnapshot(input.target, target)
  ) {
    throw new AdminTenantError(
      409,
      "Usuário ou autoridade mudou durante a edição; atualize e tente novamente",
    );
  }
  return { caller, target };
}

type PendingSignupSnapshot = {
  membershipId: number;
  professionalId: number;
  userId: number;
  institutionId: number;
  userName: string | null;
  email: string | null;
  globalRole: UserRole;
  passwordHash: string | null;
  mustChangePassword: boolean;
  sessionVersion: number;
  professionalName: string;
  professionalRole: string;
  professionalUserRole: InstitutionRole;
  specialty: string | null;
  roleInInstitution: InstitutionRole;
  isPrimary: boolean;
  active: boolean;
};

type UserMembershipSnapshot = {
  id: number;
  professionalId: number;
  userId: number;
  institutionId: number;
  roleInInstitution: InstitutionRole;
  isPrimary: boolean;
  active: boolean;
};

async function readPendingSignupSnapshot(
  db: AdminQueryDb,
  userId: number,
  institutionId: number,
): Promise<PendingSignupSnapshot | null> {
  const [snapshot] = await db
    .select({
      membershipId: professionalInstitutions.id,
      professionalId: professionals.id,
      userId: users.id,
      institutionId: professionalInstitutions.institutionId,
      userName: users.name,
      email: users.email,
      globalRole: users.role,
      passwordHash: users.passwordHash,
      mustChangePassword: users.mustChangePassword,
      sessionVersion: users.sessionVersion,
      professionalName: professionals.name,
      professionalRole: professionals.role,
      professionalUserRole: professionals.userRole,
      specialty: professionals.specialty,
      roleInInstitution: professionalInstitutions.roleInInstitution,
      isPrimary: professionalInstitutions.isPrimary,
      active: professionalInstitutions.active,
    })
    .from(professionalInstitutions)
    .innerJoin(
      professionals,
      and(
        eq(professionals.id, professionalInstitutions.professionalId),
        eq(professionals.userId, professionalInstitutions.userId),
      ),
    )
    .innerJoin(users, eq(users.id, professionalInstitutions.userId))
    .innerJoin(
      institutions,
      and(
        eq(institutions.id, professionalInstitutions.institutionId),
        eq(institutions.isActive, true),
      ),
    )
    .where(
      and(
        eq(professionalInstitutions.userId, userId),
        eq(professionalInstitutions.institutionId, institutionId),
        eq(professionalInstitutions.active, false),
        eq(users.approvalStatus, "PENDING"),
        isNull(users.deletedAt),
      ),
    )
    .limit(1);
  return snapshot ?? null;
}

async function readUserMembershipSnapshots(
  db: AdminQueryDb,
  userId: number,
): Promise<UserMembershipSnapshot[]> {
  return db
    .select({
      id: professionalInstitutions.id,
      professionalId: professionalInstitutions.professionalId,
      userId: professionalInstitutions.userId,
      institutionId: professionalInstitutions.institutionId,
      roleInInstitution: professionalInstitutions.roleInInstitution,
      isPrimary: professionalInstitutions.isPrimary,
      active: professionalInstitutions.active,
    })
    .from(professionalInstitutions)
    .where(eq(professionalInstitutions.userId, userId))
    .orderBy(asc(professionalInstitutions.id));
}

function samePendingSignupSnapshot(
  expected: PendingSignupSnapshot,
  current: PendingSignupSnapshot,
): boolean {
  return Object.keys(expected).every(
    (key) =>
      expected[key as keyof PendingSignupSnapshot] ===
      current[key as keyof PendingSignupSnapshot],
  );
}

function sameUserMembershipSnapshots(
  expected: readonly UserMembershipSnapshot[],
  current: readonly UserMembershipSnapshot[],
): boolean {
  return (
    expected.length === current.length &&
    expected.every((snapshot, index) => {
      const candidate = current[index];
      return (
        candidate?.id === snapshot.id &&
        candidate.professionalId === snapshot.professionalId &&
        candidate.userId === snapshot.userId &&
        candidate.institutionId === snapshot.institutionId &&
        candidate.roleInInstitution === snapshot.roleInInstitution &&
        candidate.isPrimary === snapshot.isPrimary &&
        candidate.active === snapshot.active
      );
    })
  );
}

async function lockAndRevalidatePendingSignup(
  db: AdminQueryDb,
  input: {
    institutionId: number;
    caller: AdminMutationAuthoritySnapshot;
    pending: PendingSignupSnapshot;
    memberships: readonly UserMembershipSnapshot[];
    expectedCallerSessionVersion: number;
  },
): Promise<{
  caller: AdminMutationAuthoritySnapshot;
  pending: PendingSignupSnapshot;
}> {
  const locked = await lockIdentityRowsInOrder(db, [
    { ...input.caller, institutionId: input.institutionId },
    input.pending,
  ]);
  const caller = rebuildApprovedAdminAuthoritySnapshot(
    locked,
    input.caller,
    input.institutionId,
  );
  const pendingUser = locked.users.get(input.pending.userId);
  const pendingProfessional = locked.professionals.get(
    input.pending.professionalId,
  );
  const pendingMembership = locked.memberships.get(input.pending.membershipId);
  if (
    !pendingUser ||
    pendingUser.approvalStatus !== "PENDING" ||
    pendingUser.deletedAt ||
    !pendingProfessional ||
    pendingProfessional.userId !== input.pending.userId ||
    !pendingMembership ||
    pendingMembership.professionalId !== input.pending.professionalId ||
    pendingMembership.userId !== input.pending.userId ||
    pendingMembership.institutionId !== input.institutionId ||
    pendingMembership.active
  ) {
    throw new AdminTenantError(
      409,
      "Cadastro pendente mudou durante a operação",
    );
  }
  const pending: PendingSignupSnapshot = {
    membershipId: input.pending.membershipId,
    professionalId: input.pending.professionalId,
    userId: input.pending.userId,
    institutionId: pendingMembership.institutionId,
    userName: pendingUser.userName,
    email: pendingUser.email,
    globalRole: pendingUser.globalRole,
    passwordHash: pendingUser.passwordHash,
    mustChangePassword: pendingUser.mustChangePassword,
    sessionVersion: pendingUser.sessionVersion,
    professionalName: pendingProfessional.name,
    professionalRole: pendingProfessional.role,
    professionalUserRole: pendingProfessional.userRole,
    specialty: pendingProfessional.specialty,
    roleInInstitution: pendingMembership.roleInInstitution,
    isPrimary: pendingMembership.isPrimary,
    active: pendingMembership.active,
  };
  const currentMemberships = await readUserMembershipSnapshots(
    db,
    input.pending.userId,
  );
  if (
    caller.globalRole !== "admin" ||
    caller.sessionVersion !== input.expectedCallerSessionVersion ||
    !sameAdminMutationSnapshot(input.caller, caller) ||
    !samePendingSignupSnapshot(input.pending, pending) ||
    !sameUserMembershipSnapshots(input.memberships, currentMemberships) ||
    currentMemberships.length !== 1 ||
    currentMemberships[0]?.id !== pending.membershipId ||
    pending.globalRole === "admin" ||
    pending.globalRole === "manager" ||
    pending.professionalUserRole !== "USER" ||
    pending.roleInInstitution !== "USER"
  ) {
    throw new AdminTenantError(409, "Cadastro pendente exige revisão manual");
  }
  assertAuditSafeActorName(caller.userName);
  return { caller, pending };
}

async function readPendingMutationInputs(
  db: AdminQueryDb,
  input: { callerUserId: number; targetUserId: number; institutionId: number },
): Promise<{
  caller: AdminMutationAuthoritySnapshot;
  pending: PendingSignupSnapshot;
  memberships: UserMembershipSnapshot[];
}> {
  const caller = await readAdminMutationAuthoritySnapshot(db, {
    userId: input.callerUserId,
    institutionId: input.institutionId,
    requireGlobalAdmin: true,
  });
  if (!caller) {
    throw new AdminTenantError(
      403,
      "Administrador sem vínculo canônico ativo no tenant informado",
    );
  }
  const pending = await readPendingSignupSnapshot(
    db,
    input.targetUserId,
    input.institutionId,
  );
  if (!pending) {
    throw new AdminTenantError(
      404,
      "Cadastro pendente não encontrado neste tenant",
    );
  }
  const memberships = await readUserMembershipSnapshots(db, input.targetUserId);
  return { caller, pending, memberships };
}

function sendAdminTenantError(res: Response, error: unknown): boolean {
  if (!(error instanceof AdminTenantError)) return false;
  res.status(error.status).json({ error: error.message });
  return true;
}

function affectedRows(result: unknown): number {
  if (Array.isArray(result)) {
    const header = result[0] as { affectedRows?: unknown } | undefined;
    return Number(header?.affectedRows ?? 0);
  }
  return Number(
    (result as { affectedRows?: unknown } | null)?.affectedRows ?? 0,
  );
}

export const adminRouter = Router();

/** Middleware: require authenticated admin */
async function requireAdmin(req: Request, res: Response, next: () => void) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (user.role !== "admin") {
      res
        .status(403)
        .json({ error: "Apenas administradores podem acessar esta rota" });
      return;
    }
    (req as any).user = user;
    next();
  } catch (error) {
    if (error instanceof AuthenticationInfrastructureError) {
      res.status(error.status).json({
        error: "Infraestrutura de autenticação indisponível",
        code: error.code,
      });
      return;
    }
    if (error instanceof SessionInstanceConstraintError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    res.status(401).json({ error: "Não autenticado" });
  }
}

adminRouter.use(requireAdmin);

// GET /api/admin/users — list users from the explicit active tenant
adminRouter.get(
  "/users",
  async (req: Request, res: Response): Promise<void> => {
    const db = await getDb();
    if (!db) {
      res.status(503).json({ error: "Banco de dados indisponível" });
      return;
    }

    let institutionId: number;
    try {
      institutionId = await requireExplicitAdminTenant(db, req);
    } catch (error) {
      if (sendAdminTenantError(res, error)) return;
      throw error;
    }

    const allUsers = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        globalRole: users.role,
        createdAt: users.createdAt,
        professionalId: professionals.id,
        userRole: professionals.userRole,
        specialty: professionals.specialty,
        roleInInstitution: professionalInstitutions.roleInInstitution,
      })
      .from(professionalInstitutions)
      .innerJoin(
        professionals,
        and(
          eq(professionals.id, professionalInstitutions.professionalId),
          eq(professionals.userId, professionalInstitutions.userId),
        ),
      )
      .innerJoin(users, eq(users.id, professionalInstitutions.userId))
      .where(
        and(
          eq(professionalInstitutions.institutionId, institutionId),
          eq(professionalInstitutions.active, true),
          isNull(users.deletedAt),
        ),
      )
      .orderBy(asc(users.name));

    const result = allUsers.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      // `role` permanece por compatibilidade com a build móvel já liberada.
      role: projectInstitutionRoleToLegacyRole(
        row.roleInInstitution,
        row.globalRole,
      ),
      globalRole: row.globalRole,
      roleInInstitution: row.roleInInstitution,
      createdAt: row.createdAt,
      professional: row.professionalId
        ? {
            id: row.professionalId,
            userRole: row.userRole,
            specialty: row.specialty,
          }
        : null,
    }));

    res.json({ users: result });
  },
);

// PUT /api/admin/users/:id — update user
adminRouter.put(
  "/users/:id",
  async (req: Request, res: Response): Promise<void> => {
    const userId = Number(req.params.id);
    if (!userId || isNaN(userId)) {
      res.status(400).json({ error: "ID inválido" });
      return;
    }

    const db = await getDb();
    if (!db) {
      res.status(503).json({ error: "Banco de dados indisponível" });
      return;
    }

    let institutionId: number;
    try {
      institutionId = requireExplicitTenantHeader(req);
    } catch (error) {
      if (sendAdminTenantError(res, error)) return;
      throw error;
    }

    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      res.status(400).json({ error: "Payload deve ser um objeto JSON" });
      return;
    }
    const { name, email, role, roleInInstitution, specialty } = req.body as {
      name?: unknown;
      email?: unknown;
      role?: unknown;
      roleInInstitution?: unknown;
      specialty?: unknown;
    };

    const normalizedName = typeof name === "string" ? name.trim() : undefined;
    const normalizedEmail =
      typeof email === "string" ? email.toLowerCase().trim() : undefined;
    const normalizedSpecialty =
      typeof specialty === "string" ? specialty.trim() : specialty;

    if (name !== undefined) {
      if (typeof name !== "string" || !normalizedName) {
        res.status(400).json({ error: "name deve ser texto não vazio" });
        return;
      }
      if (normalizedName.length > USER_NAME_MAX_LENGTH) {
        res.status(400).json({
          error: `name deve ter no máximo ${USER_NAME_MAX_LENGTH} caracteres`,
        });
        return;
      }
    }
    if (email !== undefined) {
      if (typeof email !== "string" || !normalizedEmail) {
        res.status(400).json({ error: "email deve ser texto não vazio" });
        return;
      }
      if (normalizedEmail.length > USER_EMAIL_MAX_LENGTH) {
        res.status(400).json({
          error: `email deve ter no máximo ${USER_EMAIL_MAX_LENGTH} caracteres`,
        });
        return;
      }
    }
    if (specialty !== undefined && specialty !== null) {
      if (typeof specialty !== "string") {
        res.status(400).json({ error: "specialty deve ser texto ou null" });
        return;
      }
      if (specialty.trim().length > PROFESSIONAL_SPECIALTY_MAX_LENGTH) {
        res.status(400).json({
          error: `specialty deve ter no máximo ${PROFESSIONAL_SPECIALTY_MAX_LENGTH} caracteres`,
        });
        return;
      }
    }

    if (
      role !== undefined &&
      (typeof role !== "string" || !VALID_USER_ROLES.includes(role as UserRole))
    ) {
      res.status(400).json({
        error: `role inválido. Valores aceitos: ${VALID_USER_ROLES.join(", ")}`,
      });
      return;
    }
    if (
      roleInInstitution !== undefined &&
      (typeof roleInInstitution !== "string" ||
        !VALID_INSTITUTION_ROLES.includes(roleInInstitution as InstitutionRole))
    ) {
      res.status(400).json({
        error: `roleInInstitution inválido. Valores aceitos: ${VALID_INSTITUTION_ROLES.join(", ")}`,
      });
      return;
    }

    const legacyInstitutionRole =
      typeof role === "string"
        ? mapRoleToInstitutionRole(role as UserRole)
        : undefined;
    const explicitInstitutionRole =
      typeof roleInInstitution === "string"
        ? (roleInInstitution as InstitutionRole)
        : undefined;
    if (
      legacyInstitutionRole &&
      explicitInstitutionRole &&
      legacyInstitutionRole !== explicitInstitutionRole
    ) {
      res.status(400).json({
        error: "role e roleInInstitution representam papéis conflitantes",
      });
      return;
    }
    const requestedInstitutionRole =
      explicitInstitutionRole ?? legacyInstitutionRole;

    // Build update object
    const updates: { name?: string; email?: string } = {};
    if (normalizedName !== undefined) updates.name = normalizedName;
    if (normalizedEmail !== undefined) updates.email = normalizedEmail;

    if (
      Object.keys(updates).length === 0 &&
      specialty === undefined &&
      requestedInstitutionRole === undefined
    ) {
      res.status(400).json({ error: "Nenhum campo para atualizar" });
      return;
    }

    const caller = (req as any).user as {
      id: number;
      role: string;
      name?: string | null;
      sessionVersion: number;
    };
    let updated: typeof users.$inferSelect;
    let resultingInstitutionRole: InstitutionRole;
    try {
      const callerSnapshot = await readAdminMutationAuthoritySnapshot(db, {
        userId: caller.id,
        institutionId,
        requireGlobalAdmin: true,
      });
      if (!callerSnapshot) {
        throw new AdminTenantError(
          403,
          "Administrador sem vínculo canônico ativo no tenant informado",
        );
      }
      const targetSnapshot = await readAdminMutationAuthoritySnapshot(db, {
        userId,
        institutionId,
        requireGlobalAdmin: false,
      });
      if (!targetSnapshot) {
        throw new AdminTenantError(
          404,
          "Usuário não possui vínculo ativo neste tenant",
        );
      }
      const emailActuallyChanges =
        normalizedEmail !== undefined &&
        targetSnapshot.email?.trim().toLowerCase() !== normalizedEmail;
      const emailDutySnapshots = emailActuallyChanges
        ? await readEmailDutyConfirmationSnapshots(db, userId)
        : [];

      const result = await withPushAccountMutex(
        db,
        userId,
        PUSH_ACCOUNT_MUTATION_LOCK_TIMEOUT_SEC,
        (connectionDb) =>
          connectionDb.transaction(
            async (tx) => {
              if (emailActuallyChanges) {
                await lockAndAssertEmailChangeAllowedForUpdate(
                  tx,
                  userId,
                  emailDutySnapshots,
                );
              }
              const locked = await lockAndRevalidateAdminMutationAuthorities(
                tx,
                {
                  institutionId,
                  caller: callerSnapshot,
                  target: targetSnapshot,
                  expectedCallerSessionVersion: caller.sessionVersion,
                },
              );
              const target = locked.target;
              assertAuditSafeActorName(locked.caller.userName);
              if (emailActuallyChanges) {
                await assertEmailDutySnapshotStillCurrent(
                  tx,
                  userId,
                  emailDutySnapshots,
                );
              }

              if (Object.keys(updates).length > 0) {
                const userUpdate = await tx
                  .update(users)
                  .set(
                    emailActuallyChanges
                      ? {
                          ...updates,
                          sessionVersion: sql`${users.sessionVersion} + 1`,
                        }
                      : updates,
                  )
                  .where(
                    emailActuallyChanges
                      ? and(
                          eq(users.id, userId),
                          eq(users.sessionVersion, target.sessionVersion),
                          eq(users.approvalStatus, "APPROVED"),
                          isNull(users.deletedAt),
                        )
                      : and(eq(users.id, userId), isNull(users.deletedAt)),
                  );
                if (emailActuallyChanges && affectedRows(userUpdate) !== 1) {
                  throw new AdminTenantError(
                    409,
                    "Conta mudou durante a alteração de e-mail",
                  );
                }
              }

              let invalidatedPasswordResetCount = 0;
              let revokedPushTokenCount = 0;
              if (emailActuallyChanges) {
                revokedPushTokenCount = await revokeUserPushRegistrations(
                  tx,
                  userId,
                );
                const invalidation = await tx
                  .delete(passwordResets)
                  .where(eq(passwordResets.userId, userId));
                invalidatedPasswordResetCount = affectedRows(invalidation);
              }

              if (specialty !== undefined) {
                await tx
                  .update(professionals)
                  .set({
                    specialty:
                      typeof normalizedSpecialty === "string" &&
                      normalizedSpecialty
                        ? normalizedSpecialty
                        : null,
                  })
                  .where(eq(professionals.id, target.professionalId));
              }

              const nextRole =
                requestedInstitutionRole ?? target.roleInInstitution;
              const roleChanged = nextRole !== target.roleInInstitution;
              if (roleChanged) {
                const roleUpdate = await tx
                  .update(professionalInstitutions)
                  .set({ roleInInstitution: nextRole })
                  .where(
                    and(
                      eq(professionalInstitutions.id, target.membershipId),
                      eq(professionalInstitutions.userId, userId),
                      eq(professionalInstitutions.institutionId, institutionId),
                      eq(professionalInstitutions.active, true),
                    ),
                  );
                if (affectedRows(roleUpdate) !== 1) {
                  throw new AdminTenantError(
                    404,
                    "Vínculo institucional deixou de estar ativo",
                  );
                }
              }

              const changedFields = [
                ...(updates.name !== undefined &&
                updates.name !== target.userName
                  ? ["name"]
                  : []),
                ...(emailActuallyChanges ? ["email"] : []),
                ...(specialty !== undefined ? ["specialty"] : []),
                ...(roleChanged ? ["roleInInstitution"] : []),
              ];

              await recordAudit(
                {
                  institutionId,
                  action: roleChanged ? "USER_ROLE_CHANGED" : "USER_UPDATED",
                  entityType: "USER",
                  entityId: userId,
                  actorUserId: caller.id,
                  actorRole: locked.caller.globalRole,
                  actorName: locked.caller.userName ?? undefined,
                  description: roleChanged
                    ? `Papel institucional do usuário #${userId} alterado para ${nextRole} pelo usuário #${locked.caller.userId}`
                    : `Usuário #${userId} atualizado pelo usuário #${locked.caller.userId}`,
                  metadata: {
                    changedFields,
                    emailChanged: emailActuallyChanges,
                    sessionVersionBefore: target.sessionVersion,
                    sessionVersionAfter: emailActuallyChanges
                      ? target.sessionVersion + 1
                      : target.sessionVersion,
                    revokedPushTokenCount,
                    invalidatedPasswordResetCount,
                    membershipId: target.membershipId,
                    previousRoleInInstitution: target.roleInInstitution,
                    newRoleInInstitution: nextRole,
                  },
                },
                { db: tx, strict: true },
              );

              const [updatedUser] = await tx
                .select()
                .from(users)
                .where(eq(users.id, userId))
                .limit(1);
              if (!updatedUser)
                throw new AdminTenantError(404, "Usuário não encontrado");
              return { updatedUser, nextRole };
            },
            { isolationLevel: "read committed" },
          ),
      );
      updated = result.updatedUser;
      resultingInstitutionRole = result.nextRole;
    } catch (error) {
      if (sendAdminTenantError(res, error)) return;
      throw error;
    }

    res.json({
      user: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        role: projectInstitutionRoleToLegacyRole(
          resultingInstitutionRole,
          updated.role,
        ),
        globalRole: updated.role,
        roleInInstitution: resultingInstitutionRole,
      },
    });
  },
);

// ---------------------------------------------------------------------------
// POST /api/admin/users/:id/reset-password — senha temporária (frente A3)
//
// Gera uma senha legível de 12 caracteres (sem 0/O/1/l/I), grava o hash
// e liga must_change_password: no próximo login o app obriga a troca.
// A senha em claro é devolvida UMA vez na resposta — não é persistida
// nem logada.
// ---------------------------------------------------------------------------

const TEMP_PASSWORD_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
const TEMP_PASSWORD_LENGTH = 12;

function generateTemporaryPassword(): string {
  let out = "";
  for (let i = 0; i < TEMP_PASSWORD_LENGTH; i++) {
    out += TEMP_PASSWORD_ALPHABET[randomInt(TEMP_PASSWORD_ALPHABET.length)];
  }
  return out;
}

adminRouter.post(
  "/users/:id/reset-password",
  async (req: Request, res: Response): Promise<void> => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      res.status(400).json({ error: "ID inválido" });
      return;
    }

    const db = await getDb();
    if (!db) {
      res.status(503).json({ error: "Banco de dados indisponível" });
      return;
    }

    let institutionId: number;
    try {
      institutionId = requireExplicitTenantHeader(req);
    } catch (error) {
      if (sendAdminTenantError(res, error)) return;
      throw error;
    }

    const caller = (req as any).user as { id: number; sessionVersion: number };
    let callerSnapshot: AdminMutationAuthoritySnapshot;
    let targetSnapshot: AdminMutationAuthoritySnapshot;
    try {
      const initialCaller = await readAdminMutationAuthoritySnapshot(db, {
        userId: caller.id,
        institutionId,
        requireGlobalAdmin: true,
      });
      if (!initialCaller) {
        throw new AdminTenantError(
          403,
          "Administrador sem vínculo canônico ativo no tenant informado",
        );
      }
      const initialTarget = await readAdminMutationAuthoritySnapshot(db, {
        userId,
        institutionId,
        requireGlobalAdmin: false,
      });
      if (!initialTarget) {
        throw new AdminTenantError(
          404,
          "Usuário não possui vínculo ativo neste tenant",
        );
      }
      callerSnapshot = initialCaller;
      targetSnapshot = initialTarget;
    } catch (error) {
      if (sendAdminTenantError(res, error)) return;
      throw error;
    }

    // O snapshot antecede o bcrypt deliberadamente: duas solicitações que se
    // sobrepõem disputam a mesma versão e só uma pode produzir senha válida.
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await bcrypt.hash(temporaryPassword, 12);
    try {
      await withPushAccountMutex(
        db,
        userId,
        PUSH_ACCOUNT_MUTATION_LOCK_TIMEOUT_SEC,
        (connectionDb) =>
          connectionDb.transaction(async (tx) => {
            const locked = await lockAndRevalidateAdminMutationAuthorities(tx, {
              institutionId,
              caller: callerSnapshot,
              target: targetSnapshot,
              expectedCallerSessionVersion: caller.sessionVersion,
            });
            assertAuditSafeActorName(locked.caller.userName);

            const updateResult = await tx
              .update(users)
              // Senha temporária revoga todas as sessões anteriores do alvo.
              .set({
                passwordHash,
                mustChangePassword: true,
                sessionVersion: sql`${users.sessionVersion} + 1`,
              })
              .where(
                and(
                  eq(users.id, userId),
                  eq(users.sessionVersion, locked.target.sessionVersion),
                  eq(users.approvalStatus, "APPROVED"),
                  isNull(users.deletedAt),
                ),
              );
            if (affectedRows(updateResult) !== 1) {
              throw new AdminTenantError(
                409,
                "Usuário mudou durante a redefinição de senha",
              );
            }

            const revokedPushTokenCount = await revokeUserPushRegistrations(
              tx,
              userId,
            );

            const resetInvalidation = await tx
              .delete(passwordResets)
              .where(eq(passwordResets.userId, userId));

            await recordAudit(
              {
                action: "USER_UPDATED",
                entityType: "USER",
                entityId: userId,
                actorUserId: caller.id,
                actorRole: locked.caller.globalRole,
                actorName: locked.caller.userName ?? undefined,
                description: `Senha do usuário #${userId} redefinida pelo usuário #${locked.caller.userId} (senha temporária, troca obrigatória no próximo login)`,
                metadata: {
                  mustChangePassword: true,
                  membershipId: locked.target.membershipId,
                  sessionVersionBefore: locked.target.sessionVersion,
                  sessionVersionAfter: locked.target.sessionVersion + 1,
                  revokedPushTokenCount,
                  invalidatedPasswordResetCount:
                    affectedRows(resetInvalidation),
                },
                institutionId,
              },
              { db: tx, strict: true },
            );
          }),
      );
    } catch (error) {
      if (sendAdminTenantError(res, error)) return;
      throw error;
    }

    res.json({ ok: true, temporaryPassword });
  },
);

// GET /api/admin/audit — query audit trail
adminRouter.get(
  "/audit",
  async (req: Request, res: Response): Promise<void> => {
    const db = await getDb();
    if (!db) {
      res.status(503).json({ error: "Banco de dados indisponivel" });
      return;
    }

    let institutionId: number;
    try {
      institutionId = await requireExplicitAdminTenant(db, req);
    } catch (error) {
      if (sendAdminTenantError(res, error)) return;
      throw error;
    }

    const {
      entityType,
      entityId,
      actorUserId,
      startDate,
      endDate,
      action,
      limit: rawLimit,
      offset: rawOffset,
    } = req.query as Record<string, string | undefined>;

    const conditions = [eq(auditTrail.institutionId, institutionId)];

    if (entityType)
      conditions.push(eq(auditTrail.entityType, entityType as any));
    if (entityId) conditions.push(eq(auditTrail.entityId, Number(entityId)));
    if (actorUserId)
      conditions.push(eq(auditTrail.actorUserId, Number(actorUserId)));
    if (action) conditions.push(eq(auditTrail.action, action as any));
    if (startDate)
      conditions.push(gte(auditTrail.createdAt, new Date(startDate)));
    if (endDate) conditions.push(lte(auditTrail.createdAt, new Date(endDate)));

    const pageLimit = Math.min(Number(rawLimit) || 50, 200);
    const pageOffset = Number(rawOffset) || 0;

    const where = and(...conditions);

    const [rows, countResult] = await Promise.all([
      db
        .select()
        .from(auditTrail)
        .where(where)
        .orderBy(desc(auditTrail.createdAt))
        .limit(pageLimit)
        .offset(pageOffset),
      db
        .select({ total: sql<number>`count(*)` })
        .from(auditTrail)
        .where(where),
    ]);

    res.json({
      data: rows,
      total: Number(countResult[0]?.total ?? 0),
      limit: pageLimit,
      offset: pageOffset,
    });
  },
);

// DELETE /api/admin/users/:id — not implemented (no isActive field)
adminRouter.delete(
  "/users/:id",
  async (req: Request, res: Response): Promise<void> => {
    const caller = (req as any).user;
    const userId = Number(req.params.id);

    if (userId === caller.id) {
      res.status(400).json({ error: "Não é possível desativar a si mesmo" });
      return;
    }

    res.status(501).json({
      error:
        "Funcionalidade de desativação ainda não implementada (campo isActive não existe na tabela users)",
    });
  },
);

// ---------------------------------------------------------------------------
// Cadastros pendentes (auto-cadastro público — feat/self-signup)
// ---------------------------------------------------------------------------

// GET /api/admin/pending-signups — contas aguardando aprovação no tenant ativo
adminRouter.get(
  "/pending-signups",
  async (req: Request, res: Response): Promise<void> => {
    const db = await getDb();
    if (!db) {
      res.status(503).json({ error: "Banco de dados indisponível" });
      return;
    }

    let institutionId: number;
    try {
      institutionId = await requireExplicitAdminTenant(db, req);
    } catch (error) {
      if (sendAdminTenantError(res, error)) return;
      throw error;
    }

    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        createdAt: users.createdAt,
        institutionId: professionalInstitutions.institutionId,
        institutionName: institutions.name,
      })
      .from(professionalInstitutions)
      .innerJoin(
        professionals,
        and(
          eq(professionals.id, professionalInstitutions.professionalId),
          eq(professionals.userId, professionalInstitutions.userId),
        ),
      )
      .innerJoin(users, eq(users.id, professionalInstitutions.userId))
      .innerJoin(
        institutions,
        eq(institutions.id, professionalInstitutions.institutionId),
      )
      .where(
        and(
          eq(users.approvalStatus, "PENDING"),
          eq(professionalInstitutions.institutionId, institutionId),
          eq(professionalInstitutions.active, false),
          isNull(users.deletedAt),
        ),
      )
      .orderBy(asc(users.createdAt));

    res.json({ pending: rows });
  },
);

// POST /api/admin/pending-signups/:id/approve — aprova a conta:
// APPROVED + ativa o vínculo institucional + concede acesso a todos os
// hospitais da instituição escolhida (sectorId null = todos os setores).
adminRouter.post(
  "/pending-signups/:id/approve",
  async (req: Request, res: Response): Promise<void> => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      res.status(400).json({ error: "ID inválido" });
      return;
    }

    const db = await getDb();
    if (!db) {
      res.status(503).json({ error: "Banco de dados indisponível" });
      return;
    }

    let institutionId: number;
    try {
      institutionId = requireExplicitTenantHeader(req);
    } catch (error) {
      if (sendAdminTenantError(res, error)) return;
      throw error;
    }

    const caller = (req as any).user as { id: number; sessionVersion: number };
    try {
      const snapshots = await readPendingMutationInputs(db, {
        callerUserId: caller.id,
        targetUserId: userId,
        institutionId,
      });
      await db.transaction(async (tx) => {
        const locked = await lockAndRevalidatePendingSignup(tx, {
          institutionId,
          ...snapshots,
          expectedCallerSessionVersion: caller.sessionVersion,
        });
        const pending = locked.pending;

        const userUpdate = await tx
          .update(users)
          .set({ approvalStatus: "APPROVED" })
          .where(
            and(
              eq(users.id, userId),
              eq(users.approvalStatus, "PENDING"),
              eq(users.sessionVersion, pending.sessionVersion),
              isNull(users.deletedAt),
            ),
          );
        if (affectedRows(userUpdate) !== 1) {
          throw new AdminTenantError(409, "Cadastro deixou de estar pendente");
        }

        const membershipUpdate = await tx
          .update(professionalInstitutions)
          .set({ active: true })
          .where(
            and(
              eq(professionalInstitutions.id, pending.membershipId),
              eq(professionalInstitutions.userId, userId),
              eq(professionalInstitutions.institutionId, institutionId),
              eq(professionalInstitutions.active, false),
            ),
          );
        if (affectedRows(membershipUpdate) !== 1) {
          throw new AdminTenantError(
            409,
            "Vínculo institucional deixou de estar pendente",
          );
        }

        const institutionHospitals = await tx
          .select({ id: hospitals.id })
          .from(hospitals)
          .where(eq(hospitals.institutionId, institutionId));
        for (const hospital of institutionHospitals) {
          await tx.insert(professionalAccess).values({
            institutionId,
            professionalId: pending.professionalId,
            hospitalId: hospital.id,
            sectorId: null,
            canAccess: true,
          });
        }

        await recordAudit(
          {
            institutionId,
            action: "USER_UPDATED",
            entityType: "USER",
            entityId: userId,
            actorUserId: caller.id,
            actorRole: locked.caller.globalRole,
            actorName: locked.caller.userName ?? undefined,
            description: `Cadastro do usuário #${userId} aprovado pelo usuário #${locked.caller.userId}`,
            metadata: {
              approval: "APPROVED",
              selfSignup: true,
              membershipId: pending.membershipId,
            },
          },
          { db: tx, strict: true },
        );
      });
    } catch (error) {
      if (sendAdminTenantError(res, error)) return;
      throw error;
    }

    res.json({ ok: true });
  },
);

// POST /api/admin/pending-signups/:id/reject — recusa e remove a conta
// pendente (vínculo + profissional + usuário). Só atua sobre PENDING.
adminRouter.post(
  "/pending-signups/:id/reject",
  async (req: Request, res: Response): Promise<void> => {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      res.status(400).json({ error: "ID inválido" });
      return;
    }

    const db = await getDb();
    if (!db) {
      res.status(503).json({ error: "Banco de dados indisponível" });
      return;
    }

    let institutionId: number;
    try {
      institutionId = requireExplicitTenantHeader(req);
    } catch (error) {
      if (sendAdminTenantError(res, error)) return;
      throw error;
    }

    const caller = (req as any).user as { id: number; sessionVersion: number };
    try {
      const snapshots = await readPendingMutationInputs(db, {
        callerUserId: caller.id,
        targetUserId: userId,
        institutionId,
      });
      await db.transaction(async (tx) => {
        const locked = await lockAndRevalidatePendingSignup(tx, {
          institutionId,
          ...snapshots,
          expectedCallerSessionVersion: caller.sessionVersion,
        });
        const pending = locked.pending;

        // Auditar dentro da mesma transação antes da remoção; o entityId é histórico.
        await recordAudit(
          {
            institutionId,
            action: "USER_UPDATED",
            entityType: "USER",
            entityId: userId,
            actorUserId: caller.id,
            actorRole: locked.caller.globalRole,
            actorName: locked.caller.userName ?? undefined,
            description: `Cadastro do usuário #${userId} recusado e removido pelo usuário #${locked.caller.userId}`,
            metadata: {
              approval: "REJECTED",
              selfSignup: true,
              membershipId: pending.membershipId,
            },
          },
          { db: tx, strict: true },
        );

        await tx
          .delete(professionalAccess)
          .where(
            and(
              eq(professionalAccess.professionalId, pending.professionalId),
              eq(professionalAccess.institutionId, institutionId),
            ),
          );
        const membershipDelete = await tx
          .delete(professionalInstitutions)
          .where(
            and(
              eq(professionalInstitutions.id, pending.membershipId),
              eq(professionalInstitutions.userId, userId),
              eq(professionalInstitutions.institutionId, institutionId),
              eq(professionalInstitutions.active, false),
            ),
          );
        if (affectedRows(membershipDelete) !== 1) {
          throw new AdminTenantError(
            409,
            "Vínculo pendente mudou durante a recusa",
          );
        }

        const professionalDelete = await tx
          .delete(professionals)
          .where(
            and(
              eq(professionals.id, pending.professionalId),
              eq(professionals.userId, userId),
            ),
          );
        if (affectedRows(professionalDelete) !== 1) {
          throw new AdminTenantError(
            409,
            "Identidade profissional mudou durante a recusa",
          );
        }
        const userDelete = await tx
          .delete(users)
          .where(
            and(
              eq(users.id, userId),
              eq(users.approvalStatus, "PENDING"),
              eq(users.sessionVersion, pending.sessionVersion),
              isNull(users.deletedAt),
            ),
          );
        if (affectedRows(userDelete) !== 1) {
          throw new AdminTenantError(
            409,
            "Cadastro deixou de estar pendente durante a recusa",
          );
        }
      });
    } catch (error) {
      if (sendAdminTenantError(res, error)) return;
      throw error;
    }

    res.json({ ok: true });
  },
);
