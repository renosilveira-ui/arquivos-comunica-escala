import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  institutions,
  managerScope,
  professionalAccess,
  professionals,
  professionalInstitutions,
  users,
} from "../drizzle/schema";
import { assertInstitutionHierarchy } from "./_core/tenant";
import { getDb } from "./db";

export type ProfessionalInstitutionAccessRole =
  "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";

export type ProfessionalInstitutionAccessScope = Readonly<{
  hospitalId: number;
  sectorId: number | null;
}>;

export type CanonicalProfessionalInstitutionAccessState = Readonly<{
  membershipId: number;
  operationalRevision: number;
  userId: number;
  professionalId: number;
  institutionId: number;
  roleInInstitution: ProfessionalInstitutionAccessRole;
  accessTargets: readonly ProfessionalInstitutionAccessScope[];
  managerScopes: readonly ProfessionalInstitutionAccessScope[];
}>;

type ProfessionalInstitutionAccessStateInput = Readonly<{
  membershipId: number;
  operationalRevision: number;
  userId: number;
  professionalId: number;
  institutionId: number;
  roleInInstitution: ProfessionalInstitutionAccessRole;
  accessTargets: readonly ProfessionalInstitutionAccessScope[];
  managerScopes: readonly ProfessionalInstitutionAccessScope[];
}>;

type AccessReadDb = Pick<
  NonNullable<Awaited<ReturnType<typeof getDb>>>,
  "select"
>;

const ACCESS_ROLES: readonly ProfessionalInstitutionAccessRole[] = [
  "USER",
  "GESTOR_MEDICO",
  "GESTOR_PLUS",
];

export class ProfessionalInstitutionAccessStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfessionalInstitutionAccessStateError";
  }
}

function assertPositiveInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ProfessionalInstitutionAccessStateError(
      `${label} deve ser um inteiro positivo`,
    );
  }
}

function assertNonNegativeInteger(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ProfessionalInstitutionAccessStateError(
      `${label} deve ser um inteiro não negativo`,
    );
  }
}

function assertRole(
  value: unknown,
): asserts value is ProfessionalInstitutionAccessRole {
  if (
    typeof value !== "string" ||
    !ACCESS_ROLES.includes(value as ProfessionalInstitutionAccessRole)
  ) {
    throw new ProfessionalInstitutionAccessStateError(
      "roleInInstitution inválido para acesso institucional",
    );
  }
}

function compareScopes(
  left: ProfessionalInstitutionAccessScope,
  right: ProfessionalInstitutionAccessScope,
): number {
  return (
    left.hospitalId - right.hospitalId ||
    (left.sectorId ?? -1) - (right.sectorId ?? -1)
  );
}

function normalizeScopes(
  scopes: readonly ProfessionalInstitutionAccessScope[],
  label: string,
): readonly ProfessionalInstitutionAccessScope[] {
  if (!Array.isArray(scopes)) {
    throw new ProfessionalInstitutionAccessStateError(`${label} inválido`);
  }
  const unique = new Map<string, ProfessionalInstitutionAccessScope>();
  for (const scope of scopes) {
    if (!scope || typeof scope !== "object") {
      throw new ProfessionalInstitutionAccessStateError(`${label} inválido`);
    }
    assertPositiveInteger(scope.hospitalId, `${label}.hospitalId`);
    if (scope.sectorId !== null) {
      assertPositiveInteger(scope.sectorId, `${label}.sectorId`);
    }
    const normalized = Object.freeze({
      hospitalId: scope.hospitalId,
      sectorId: scope.sectorId,
    });
    unique.set(
      `${normalized.hospitalId}:${normalized.sectorId ?? "*"}`,
      normalized,
    );
  }
  return Object.freeze([...unique.values()].sort(compareScopes));
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ProfessionalInstitutionAccessStateError(
        "Estado institucional contém número inválido",
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ProfessionalInstitutionAccessStateError(
        "Estado institucional deve conter apenas JSON canônico",
      );
    }
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new ProfessionalInstitutionAccessStateError(
    "Estado institucional contém valor não serializável",
  );
}

export function normalizeProfessionalInstitutionAccessState(
  input: ProfessionalInstitutionAccessStateInput,
): CanonicalProfessionalInstitutionAccessState {
  assertPositiveInteger(input.membershipId, "membershipId");
  assertNonNegativeInteger(input.operationalRevision, "operationalRevision");
  assertPositiveInteger(input.userId, "userId");
  assertPositiveInteger(input.professionalId, "professionalId");
  assertPositiveInteger(input.institutionId, "institutionId");
  assertRole(input.roleInInstitution);

  return Object.freeze({
    membershipId: input.membershipId,
    operationalRevision: input.operationalRevision,
    userId: input.userId,
    professionalId: input.professionalId,
    institutionId: input.institutionId,
    roleInInstitution: input.roleInInstitution,
    accessTargets: normalizeScopes(input.accessTargets, "accessTargets"),
    managerScopes: normalizeScopes(input.managerScopes, "managerScopes"),
  });
}

/**
 * O hash é um compromisso do estado efetivo, sem rótulos, e-mail ou dados
 * clínicos. A revisão fica no agregado do evento; ela não entra no hash para
 * que uma regravação física equivalente não pareça mudança lógica de acesso.
 */
export function hashProfessionalInstitutionAccessState(
  input: ProfessionalInstitutionAccessStateInput,
): string {
  const state = normalizeProfessionalInstitutionAccessState(input);
  return createHash("sha256")
    .update(
      canonicalJson({
        membershipId: state.membershipId,
        userId: state.userId,
        professionalId: state.professionalId,
        institutionId: state.institutionId,
        roleInInstitution: state.roleInInstitution,
        accessTargets: state.accessTargets,
        managerScopes: state.managerScopes,
      }),
    )
    .digest("hex");
}

export function affectedScopesForProfessionalInstitutionAccess(
  input: ProfessionalInstitutionAccessStateInput,
): readonly ProfessionalInstitutionAccessScope[] {
  const state = normalizeProfessionalInstitutionAccessState(input);
  return normalizeScopes(
    [...state.accessTargets, ...state.managerScopes],
    "affectedScopes",
  );
}

/**
 * Lê e bloqueia o estado efetivo que governa acesso institucional. O helper
 * não examina especialidade nem adiciona regra de elegibilidade: papel, ACL e
 * escopo gerencial são a única superfície deste agregado.
 */
export async function readCanonicalProfessionalInstitutionAccessStateForUpdate(
  tx: AccessReadDb,
  input: Readonly<{
    membershipId: number;
    institutionId: number;
    expectedUserId?: number;
    expectedProfessionalId?: number;
  }>,
): Promise<CanonicalProfessionalInstitutionAccessState> {
  // A consulta inicial só localiza as chaves que determinam a ordem de lock.
  // Nenhum dado dela é aceito como autoridade: o vínculo será relido sob lock
  // depois de users -> professionals, a mesma ordem do writer administrativo.
  // Isso evita adquirir professional depois de PI e formar ciclo com uma
  // atualização administrativa concorrente.
  const [membershipLocator] = await tx
    .select({
      id: professionalInstitutions.id,
      userId: professionalInstitutions.userId,
      professionalId: professionalInstitutions.professionalId,
      institutionId: professionalInstitutions.institutionId,
    })
    .from(professionalInstitutions)
    .where(
      and(
        eq(professionalInstitutions.id, input.membershipId),
        eq(professionalInstitutions.institutionId, input.institutionId),
      ),
    )
    .limit(1);
  if (!membershipLocator) {
    throw new ProfessionalInstitutionAccessStateError(
      "Vínculo institucional ativo não corresponde ao agregado informado",
    );
  }

  const [account] = await tx
    .select({
      id: users.id,
      approvalStatus: users.approvalStatus,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(eq(users.id, membershipLocator.userId))
    .limit(1)
    .for("update");
  if (
    !account ||
    account.approvalStatus !== "APPROVED" ||
    account.deletedAt !== null
  ) {
    throw new ProfessionalInstitutionAccessStateError(
      "Conta do vínculo institucional não está aprovada e ativa",
    );
  }

  const [professional] = await tx
    .select({
      id: professionals.id,
      userId: professionals.userId,
    })
    .from(professionals)
    .where(eq(professionals.id, membershipLocator.professionalId))
    .limit(1)
    .for("update");
  if (
    !professional ||
    professional.id !== membershipLocator.professionalId ||
    professional.userId !== membershipLocator.userId
  ) {
    throw new ProfessionalInstitutionAccessStateError(
      "Profissional não corresponde ao usuário do vínculo institucional",
    );
  }

  const [membership] = await tx
    .select({
      id: professionalInstitutions.id,
      operationalRevision: professionalInstitutions.operationalRevision,
      userId: professionalInstitutions.userId,
      professionalId: professionalInstitutions.professionalId,
      institutionId: professionalInstitutions.institutionId,
      roleInInstitution: professionalInstitutions.roleInInstitution,
      active: professionalInstitutions.active,
    })
    .from(professionalInstitutions)
    .where(
      and(
        eq(professionalInstitutions.id, input.membershipId),
        eq(professionalInstitutions.institutionId, input.institutionId),
      ),
    )
    .limit(1)
    .for("update");
  if (
    !membership ||
    !membership.active ||
    membership.userId !== membershipLocator.userId ||
    membership.professionalId !== membershipLocator.professionalId ||
    professional.userId !== membership.userId ||
    (input.expectedUserId !== undefined &&
      membership.userId !== input.expectedUserId) ||
    (input.expectedProfessionalId !== undefined &&
      membership.professionalId !== input.expectedProfessionalId)
  ) {
    throw new ProfessionalInstitutionAccessStateError(
      "Vínculo institucional ativo não corresponde ao agregado informado",
    );
  }

  const [institution] = await tx
    .select({ id: institutions.id })
    .from(institutions)
    .where(
      and(
        eq(institutions.id, membership.institutionId),
        eq(institutions.isActive, true),
      ),
    )
    .limit(1)
    .for("share");
  if (!institution) {
    throw new ProfessionalInstitutionAccessStateError(
      "Instituição do acesso deixou de estar ativa",
    );
  }

  const accessRows = await tx
    .select({
      hospitalId: professionalAccess.hospitalId,
      sectorId: professionalAccess.sectorId,
      canAccess: professionalAccess.canAccess,
    })
    .from(professionalAccess)
    .where(
      and(
        eq(professionalAccess.institutionId, membership.institutionId),
        eq(professionalAccess.professionalId, membership.professionalId),
      ),
    )
    .orderBy(
      asc(professionalAccess.hospitalId),
      asc(professionalAccess.sectorId),
      asc(professionalAccess.id),
    )
    .for("update");
  const managerScopeRows = await tx
    .select({
      hospitalId: managerScope.hospitalId,
      sectorId: managerScope.sectorId,
      active: managerScope.active,
    })
    .from(managerScope)
    .where(
      and(
        eq(managerScope.institutionId, membership.institutionId),
        eq(managerScope.managerProfessionalId, membership.professionalId),
      ),
    )
    .orderBy(
      asc(managerScope.hospitalId),
      asc(managerScope.sectorId),
      asc(managerScope.id),
    )
    .for("update");

  const state = normalizeProfessionalInstitutionAccessState({
    membershipId: membership.id,
    operationalRevision: membership.operationalRevision,
    userId: membership.userId,
    professionalId: membership.professionalId,
    institutionId: membership.institutionId,
    roleInInstitution: membership.roleInInstitution,
    accessTargets: accessRows
      .filter((access) => access.canAccess)
      .map((access) => ({
        hospitalId: access.hospitalId,
        sectorId: access.sectorId,
      })),
    managerScopes: managerScopeRows
      .filter((scope) => scope.active)
      .map((scope) => ({
        hospitalId: scope.hospitalId,
        sectorId: scope.sectorId,
      })),
  });

  for (const scope of affectedScopesForProfessionalInstitutionAccess(state)) {
    await assertInstitutionHierarchy(
      {
        institutionId: state.institutionId,
        hospitalId: scope.hospitalId,
        sectorId: scope.sectorId,
      },
      { db: tx, lockForShare: true },
    );
  }

  return state;
}
