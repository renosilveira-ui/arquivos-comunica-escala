import { TRPCError } from "@trpc/server";
import { and, asc, eq, isNotNull, isNull, or } from "drizzle-orm";
import {
  hospitals,
  institutions,
  managerScope,
  medicalSpecialties,
  professionalAccess,
  professionalInstitutions,
  professionals,
  scheduleContexts,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../drizzle/schema";
import { isGeneralistOperationalProfile } from "../lib/medical-specialties";
import type { ScheduleContextAdmissionPolicy } from "../lib/sao-carlos-schedule-blueprint";
import { getTenantActorFromContext, type TenantActor } from "./_core/policy";
import { protectedProcedure, router } from "./_core/trpc";
import { getDb } from "./db";

export type ScheduleContextQualification = {
  medicalSpecialtyId: number | null;
  operationalProfileCode: "MEDICO_GENERALISTA" | "RESIDENTE_ANESTESIOLOGIA" | null;
  admissionPolicy?: ScheduleContextAdmissionPolicy;
};

export type ProfessionalQualification = ScheduleContextQualification;

export type ScheduleContextAccess = {
  institutionId: number;
  professionalId: number;
  hospitalId: number;
  sectorId: number | null;
  canAccess: boolean;
};

export type ScheduleContextManagerScope = {
  institutionId: number;
  managerProfessionalId: number;
  hospitalId: number;
  sectorId: number | null;
  active: boolean;
};

export type ActiveScheduleContext = ScheduleContextQualification & {
  id: number;
  institutionId: number;
  hospitalId: number;
  hospitalName: string;
  sectorId: number;
  sectorName: string;
  medicalSpecialtyCode: string | null;
  medicalSpecialtyName: string | null;
  operationalProfileCode: "MEDICO_GENERALISTA" | "RESIDENTE_ANESTESIOLOGIA" | null;
  admissionPolicy: ScheduleContextAdmissionPolicy;
  active: boolean;
};

export type AuthorizedScheduleContext = ActiveScheduleContext & {
  qualificationKind: "SPECIALTY" | "OPERATIONAL_PROFILE" | "SECTOR_POLICY";
  qualificationCode: string;
  qualificationName: string;
  displayName: string;
  canManage: boolean;
};

export class ScheduleContextAclError extends Error {
  constructor(
    readonly status: 400 | 409,
    message: string,
  ) {
    super(message);
  }
}

export type AdministrativeScheduleContext = AuthorizedScheduleContext;

const OPERATIONAL_PROFILE_LABELS: Record<
  "MEDICO_GENERALISTA" | "RESIDENTE_ANESTESIOLOGIA",
  string
> = {
  MEDICO_GENERALISTA: "Médico generalista",
  RESIDENTE_ANESTESIOLOGIA: "Residente em anestesiologia",
};

function resolveAdmissionPolicy(
  context: ScheduleContextQualification,
): ScheduleContextAdmissionPolicy {
  if (context.admissionPolicy) return context.admissionPolicy;
  if (
    context.medicalSpecialtyId === null &&
    context.operationalProfileCode === null
  ) {
    return "ALL_CFM_EXCEPT_GENERALIST";
  }
  return "PINNED_QUALIFICATION";
}

export function qualificationMatches(
  professional: ProfessionalQualification,
  context: ScheduleContextQualification,
): boolean {
  const professionalHasExactlyOne =
    (professional.medicalSpecialtyId === null) !==
    (professional.operationalProfileCode === null);
  if (!professionalHasExactlyOne) return false;

  const policy = resolveAdmissionPolicy(context);
  if (policy === "ALL_CFM_SPECIALTIES") {
    return professional.medicalSpecialtyId !== null;
  }
  if (policy === "ALL_CFM_EXCEPT_GENERALIST") {
    return (
      professional.medicalSpecialtyId !== null &&
      !isGeneralistOperationalProfile(professional.operationalProfileCode)
    );
  }

  if (
    (context.medicalSpecialtyId === null) ===
    (context.operationalProfileCode === null)
  ) {
    return false;
  }
  if (context.medicalSpecialtyId !== null) {
    return professional.medicalSpecialtyId === context.medicalSpecialtyId;
  }
  return (
    professional.operationalProfileCode === context.operationalProfileCode
  );
}

export function accessCoversContext(
  access: ScheduleContextAccess,
  professionalId: number,
  context: Pick<
    ActiveScheduleContext,
    "institutionId" | "hospitalId" | "sectorId"
  >,
): boolean {
  return (
    access.canAccess &&
    access.professionalId === professionalId &&
    access.institutionId === context.institutionId &&
    access.hospitalId === context.hospitalId &&
    (access.sectorId === null || access.sectorId === context.sectorId)
  );
}

export function managerScopeCoversContext(
  scope: ScheduleContextManagerScope,
  professionalId: number,
  context: Pick<
    ActiveScheduleContext,
    "institutionId" | "hospitalId" | "sectorId"
  >,
): boolean {
  return (
    scope.active &&
    scope.managerProfessionalId === professionalId &&
    scope.institutionId === context.institutionId &&
    scope.hospitalId === context.hospitalId &&
    (scope.sectorId === null || scope.sectorId === context.sectorId)
  );
}

export function describeScheduleContext(
  context: ActiveScheduleContext,
  canManage: boolean,
): AuthorizedScheduleContext {
  if (context.admissionPolicy === "ALL_CFM_SPECIALTIES") {
    return {
      ...context,
      qualificationKind: "SECTOR_POLICY",
      qualificationCode: "ALL_CFM_SPECIALTIES",
      qualificationName: "Todas as especialidades",
      displayName: `${context.hospitalName} — ${context.sectorName}`,
      canManage,
    };
  }
  if (context.admissionPolicy === "ALL_CFM_EXCEPT_GENERALIST") {
    return {
      ...context,
      qualificationKind: "SECTOR_POLICY",
      qualificationCode: "ALL_CFM_EXCEPT_GENERALIST",
      qualificationName: "Especialistas",
      displayName: `${context.hospitalName} — ${context.sectorName}`,
      canManage,
    };
  }

  const qualificationKind =
    context.medicalSpecialtyId !== null
      ? ("SPECIALTY" as const)
      : ("OPERATIONAL_PROFILE" as const);
  const qualificationCode =
    context.medicalSpecialtyId !== null
      ? context.medicalSpecialtyCode!
      : context.operationalProfileCode!;
  const qualificationName =
    context.medicalSpecialtyId !== null
      ? context.medicalSpecialtyName!
      : OPERATIONAL_PROFILE_LABELS[context.operationalProfileCode!];

  return {
    ...context,
    qualificationKind,
    qualificationCode,
    qualificationName,
    displayName: `${context.hospitalName} — ${context.sectorName} — ${qualificationName}`,
    canManage,
  };
}

export function filterScheduleContextsForActor(input: {
  actor: Pick<
    TenantActor,
    "institutionId" | "professionalId" | "roleInInstitution" | "isGlobalAdmin"
  >;
  contexts: ActiveScheduleContext[];
  professional: ProfessionalQualification | null;
  accesses: ScheduleContextAccess[];
  managerScopes: ScheduleContextManagerScope[];
}): AuthorizedScheduleContext[] {
  const { actor } = input;
  const tenantContexts = input.contexts.filter(
    (context) =>
      context.active && context.institutionId === actor.institutionId,
  );

  const canPracticeInContext = (context: ActiveScheduleContext) =>
    actor.professionalId !== null &&
    input.professional !== null &&
    qualificationMatches(input.professional, context) &&
    input.accesses.some((access) =>
      accessCoversContext(access, actor.professionalId!, context),
    );

  let authorized: AuthorizedScheduleContext[];
  if (actor.isGlobalAdmin || actor.roleInInstitution === "GESTOR_PLUS") {
    authorized = tenantContexts.map((context) =>
      describeScheduleContext(context, true),
    );
  } else if (
    actor.roleInInstitution === "GESTOR_MEDICO" &&
    actor.professionalId !== null
  ) {
    // O papel de gestor não apaga o vínculo assistencial. Fora de sua
    // manager_scope, ele ainda pode ler uma escala coberta pela própria
    // qualificação + professional_access, mas não gerenciá-la.
    authorized = tenantContexts.flatMap((context) => {
      const canManage = input.managerScopes.some((scope) =>
        managerScopeCoversContext(scope, actor.professionalId!, context),
      );
      return canManage || canPracticeInContext(context)
        ? [describeScheduleContext(context, canManage)]
        : [];
    });
  } else if (actor.professionalId !== null && input.professional !== null) {
    authorized = tenantContexts
      .filter(canPracticeInContext)
      .map((context) => describeScheduleContext(context, false));
  } else {
    authorized = [];
  }

  return authorized.sort(
    (left, right) =>
      left.hospitalName.localeCompare(right.hospitalName, "pt-BR") ||
      left.sectorName.localeCompare(right.sectorName, "pt-BR") ||
      left.qualificationName.localeCompare(right.qualificationName, "pt-BR") ||
      left.id - right.id,
  );
}

export function requireSingleLegacyScheduleContext<T extends { id: number }>(
  candidates: T[],
): T {
  if (candidates.length === 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Nenhuma escala ativa corresponde ao hospital e setor informados.",
    });
  }
  if (candidates.length > 1) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "Há mais de uma escala para este setor; informe scheduleContextId.",
    });
  }
  return candidates[0];
}

export type ContextDb = Pick<
  NonNullable<Awaited<ReturnType<typeof getDb>>>,
  "select"
>;

export type ShiftScheduleContextIdentity = {
  id: number;
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  scheduleContextId: number | null;
};

/**
 * Exceção estreita de leitura: o profissional pode abrir somente o turno ao
 * qual está canonicamente alocado, mesmo após perder ACL/qualificação ou
 * enquanto uma instância legada ainda não possui schedule_context_id.
 */
async function hasCanonicalOwnActiveAssignment(
  db: ContextDb,
  actor: TenantActor,
  shift: ShiftScheduleContextIdentity,
): Promise<boolean> {
  if (actor.professionalId === null) return false;

  const [assignment] = await db
    .select({ id: shiftAssignmentsV2.id })
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
      professionals,
      and(
        eq(professionals.id, shiftAssignmentsV2.professionalId),
        eq(professionals.id, actor.professionalId),
        eq(professionals.userId, actor.userId),
      ),
    )
    .innerJoin(
      professionalInstitutions,
      and(
        eq(professionalInstitutions.professionalId, professionals.id),
        eq(professionalInstitutions.userId, professionals.userId),
        eq(
          professionalInstitutions.institutionId,
          shiftAssignmentsV2.institutionId,
        ),
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
        eq(shiftInstances.id, shift.id),
        eq(shiftInstances.institutionId, shift.institutionId),
        eq(shiftInstances.hospitalId, shift.hospitalId),
        eq(shiftInstances.sectorId, shift.sectorId),
        eq(shiftAssignmentsV2.professionalId, actor.professionalId),
        eq(shiftAssignmentsV2.isActive, true),
      ),
    )
    .limit(1);

  return assignment !== undefined;
}

export type ScheduleContextReadGrant =
  | { kind: "SCHEDULE_CONTEXT"; context: AuthorizedScheduleContext }
  | { kind: "OWN_ASSIGNMENT"; context: null };

export function resolveShiftScheduleContextReadGrant(input: {
  shift: ShiftScheduleContextIdentity;
  ownActiveAssignment: boolean;
  authorizedContexts: readonly AuthorizedScheduleContext[];
}): ScheduleContextReadGrant | null {
  if (input.ownActiveAssignment) {
    return { kind: "OWN_ASSIGNMENT", context: null };
  }
  if (input.shift.scheduleContextId === null) return null;
  const context = input.authorizedContexts.find(
    (candidate) =>
      candidate.id === input.shift.scheduleContextId &&
      candidate.institutionId === input.shift.institutionId &&
      candidate.hospitalId === input.shift.hospitalId &&
      candidate.sectorId === input.shift.sectorId,
  );
  return context ? { kind: "SCHEDULE_CONTEXT", context } : null;
}

/**
 * Política compartilhada dos leitores de turno. A regra normal é um contexto
 * ativo coberto por manager_scope ou por ACL + qualificação; a única exceção
 * é a própria alocação ativa e canônica.
 */
export async function assertActorCanReadShiftScheduleContext(input: {
  actor: TenantActor;
  shift: ShiftScheduleContextIdentity;
  db?: ContextDb;
}): Promise<ScheduleContextReadGrant> {
  if (input.shift.institutionId !== input.actor.institutionId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Turno fora do tenant ativo.",
    });
  }
  const database = input.db ?? (await getDb());
  if (!database) throw new Error("Database not available");

  const ownActiveAssignment = await hasCanonicalOwnActiveAssignment(
    database,
    input.actor,
    input.shift,
  );
  const contexts = await listAuthorizedScheduleContexts(input.actor, database);
  const grant = resolveShiftScheduleContextReadGrant({
    shift: input.shift,
    ownActiveAssignment,
    authorizedContexts: contexts,
  });
  if (!grant) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        input.shift.scheduleContextId === null
          ? "Plantão sem escala operacional classificada."
          : "Escala fora do acesso do usuário neste tenant.",
    });
  }
  return grant;
}

export async function selectActiveScheduleContexts(
  db: ContextDb,
  institutionId: number,
  filters: { id?: number; hospitalId?: number; sectorId?: number } = {},
  lockForShare = false,
): Promise<ActiveScheduleContext[]> {
  const query = db
    .select({
      id: scheduleContexts.id,
      institutionId: scheduleContexts.institutionId,
      hospitalId: scheduleContexts.hospitalId,
      hospitalName: hospitals.name,
      sectorId: scheduleContexts.sectorId,
      sectorName: sectors.name,
      medicalSpecialtyId: scheduleContexts.medicalSpecialtyId,
      medicalSpecialtyCode: medicalSpecialties.code,
      medicalSpecialtyName: medicalSpecialties.name,
      operationalProfileCode: scheduleContexts.operationalProfileCode,
      admissionPolicy: scheduleContexts.admissionPolicy,
      active: scheduleContexts.active,
    })
    .from(scheduleContexts)
    .innerJoin(
      institutions,
      and(
        eq(institutions.id, scheduleContexts.institutionId),
        eq(institutions.isActive, true),
      ),
    )
    .innerJoin(
      hospitals,
      and(
        eq(hospitals.id, scheduleContexts.hospitalId),
        eq(hospitals.institutionId, scheduleContexts.institutionId),
      ),
    )
    .innerJoin(
      sectors,
      and(
        eq(sectors.id, scheduleContexts.sectorId),
        eq(sectors.institutionId, scheduleContexts.institutionId),
        eq(sectors.hospitalId, scheduleContexts.hospitalId),
      ),
    )
    .leftJoin(
      medicalSpecialties,
      eq(medicalSpecialties.id, scheduleContexts.medicalSpecialtyId),
    )
    .where(
      and(
        eq(scheduleContexts.institutionId, institutionId),
        eq(scheduleContexts.active, true),
        ...(filters.id !== undefined
          ? [eq(scheduleContexts.id, filters.id)]
          : []),
        ...(filters.hospitalId !== undefined
          ? [eq(scheduleContexts.hospitalId, filters.hospitalId)]
          : []),
        ...(filters.sectorId !== undefined
          ? [eq(scheduleContexts.sectorId, filters.sectorId)]
          : []),
        or(
          and(
            eq(scheduleContexts.admissionPolicy, "PINNED_QUALIFICATION"),
            isNotNull(scheduleContexts.medicalSpecialtyId),
            isNull(scheduleContexts.operationalProfileCode),
            eq(medicalSpecialties.active, true),
          ),
          and(
            eq(scheduleContexts.admissionPolicy, "PINNED_QUALIFICATION"),
            isNull(scheduleContexts.medicalSpecialtyId),
            isNotNull(scheduleContexts.operationalProfileCode),
          ),
          and(
            eq(scheduleContexts.admissionPolicy, "ALL_CFM_SPECIALTIES"),
            isNull(scheduleContexts.medicalSpecialtyId),
            isNull(scheduleContexts.operationalProfileCode),
          ),
          and(
            eq(scheduleContexts.admissionPolicy, "ALL_CFM_EXCEPT_GENERALIST"),
            isNull(scheduleContexts.medicalSpecialtyId),
            isNull(scheduleContexts.operationalProfileCode),
          ),
        ),
      ),
    )
    .orderBy(
      asc(hospitals.name),
      asc(sectors.name),
      asc(medicalSpecialties.sortOrder),
      asc(scheduleContexts.operationalProfileCode),
      asc(scheduleContexts.id),
    );
  const rows = lockForShare ? await query.for("share") : await query;

  return rows.map((row) => ({
    ...row,
    active: true as const,
    operationalProfileCode: row.operationalProfileCode as
      | "MEDICO_GENERALISTA"
      | "RESIDENTE_ANESTESIOLOGIA"
      | null,
    admissionPolicy: row.admissionPolicy,
  }));
}

/**
 * Valida o contrato REST sem aceitar coercoes silenciosas. `undefined`
 * identifica uma build antiga; array vazio continua sendo uma selecao
 * explicita invalida para medico.
 */
export function parseScheduleContextIds(value: unknown): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new ScheduleContextAclError(
      400,
      "scheduleContextIds deve ser uma lista de IDs",
    );
  }
  if (value.length === 0) {
    throw new ScheduleContextAclError(
      400,
      "Selecione ao menos uma escala operacional",
    );
  }
  if (value.length > 100) {
    throw new ScheduleContextAclError(
      400,
      "scheduleContextIds excede o limite permitido",
    );
  }
  const ids = value.map((id) => {
    if (!Number.isInteger(id) || (id as number) <= 0) {
      throw new ScheduleContextAclError(
        400,
        "scheduleContextIds contém ID inválido",
      );
    }
    return id as number;
  });
  if (new Set(ids).size !== ids.length) {
    throw new ScheduleContextAclError(
      400,
      "scheduleContextIds não pode conter IDs repetidos",
    );
  }
  return ids;
}

function assertExactlyOneProfessionalQualification(
  qualification: ProfessionalQualification,
): void {
  if (
    (qualification.medicalSpecialtyId === null) ===
    (qualification.operationalProfileCode === null)
  ) {
    throw new ScheduleContextAclError(
      409,
      "Médico deve possuir exatamente uma qualificação ativa",
    );
  }
}

/**
 * Revalida no banco, dentro da transacao chamadora, tenant, topologia,
 * atividade e qualificacao de cada contexto selecionado. Para compatibilidade
 * com uma build antiga, a omissao so e resolvida quando existe exatamente um
 * contexto compativel.
 */
export async function resolveScheduleContextAclSelection(input: {
  db: ContextDb;
  institutionId: number;
  qualification: ProfessionalQualification;
  requestedScheduleContextIds: number[] | undefined;
}): Promise<ActiveScheduleContext[]> {
  assertExactlyOneProfessionalQualification(input.qualification);
  const compatible = (
    await selectActiveScheduleContexts(input.db, input.institutionId, {}, true)
  ).filter((context) => qualificationMatches(input.qualification, context));

  if (input.requestedScheduleContextIds === undefined) {
    if (compatible.length === 0) {
      throw new ScheduleContextAclError(
        409,
        "Nenhuma escala ativa é compatível com a qualificação médica",
      );
    }
    if (compatible.length > 1) {
      throw new ScheduleContextAclError(
        409,
        "Há mais de uma escala compatível; selecione explicitamente onde o médico poderá atuar",
      );
    }
    return compatible;
  }

  const compatibleById = new Map(
    compatible.map((context) => [context.id, context] as const),
  );
  const selected = input.requestedScheduleContextIds.map((id) =>
    compatibleById.get(id),
  );
  if (selected.some((context) => context === undefined)) {
    throw new ScheduleContextAclError(
      409,
      "Escala inexistente, inativa, fora do tenant ou incompatível com a qualificação",
    );
  }
  return selected as ActiveScheduleContext[];
}

export function scheduleContextsToSpecificAccessTargets(
  contexts: Pick<ActiveScheduleContext, "hospitalId" | "sectorId">[],
): { hospitalId: number; sectorId: number }[] {
  const targets = new Map<string, { hospitalId: number; sectorId: number }>();
  for (const context of contexts) {
    targets.set(`${context.hospitalId}:${context.sectorId}`, {
      hospitalId: context.hospitalId,
      sectorId: context.sectorId,
    });
  }
  return [...targets.values()];
}

export function projectEffectiveScheduleContextIds(input: {
  institutionId: number;
  professionalId: number;
  qualification: ProfessionalQualification;
  contexts: ActiveScheduleContext[];
  accesses: ScheduleContextAccess[];
}): number[] {
  return input.contexts
    .filter(
      (context) =>
        context.active &&
        context.institutionId === input.institutionId &&
        qualificationMatches(input.qualification, context) &&
        input.accesses.some((access) =>
          accessCoversContext(access, input.professionalId, context),
        ),
    )
    .map((context) => context.id);
}

export async function listAdministrativeScheduleContexts(
  institutionId: number,
  db?: ContextDb,
): Promise<AdministrativeScheduleContext[]> {
  const database = db ?? (await getDb());
  if (!database) throw new Error("Database not available");
  const contexts = await selectActiveScheduleContexts(database, institutionId);
  return contexts.map((context) => describeScheduleContext(context, true));
}

async function loadProfessionalQualification(
  db: ContextDb,
  professionalId: number,
): Promise<ProfessionalQualification | null> {
  const [professional] = await db
    .select({
      medicalSpecialtyId: professionals.medicalSpecialtyId,
      operationalProfileCode: professionals.operationalProfileCode,
    })
    .from(professionals)
    .where(eq(professionals.id, professionalId))
    .limit(1);
  if (!professional) return null;
  return {
    medicalSpecialtyId: professional.medicalSpecialtyId,
    operationalProfileCode: professional.operationalProfileCode as
      "MEDICO_GENERALISTA" | null,
  };
}

async function loadProfessionalAccesses(
  db: ContextDb,
  institutionId: number,
  professionalId: number,
): Promise<ScheduleContextAccess[]> {
  return db
    .select({
      institutionId: professionalAccess.institutionId,
      professionalId: professionalAccess.professionalId,
      hospitalId: professionalAccess.hospitalId,
      sectorId: professionalAccess.sectorId,
      canAccess: professionalAccess.canAccess,
    })
    .from(professionalAccess)
    .where(
      and(
        eq(professionalAccess.institutionId, institutionId),
        eq(professionalAccess.professionalId, professionalId),
        eq(professionalAccess.canAccess, true),
      ),
    );
}

async function loadManagerScopes(
  db: ContextDb,
  institutionId: number,
  professionalId: number,
): Promise<ScheduleContextManagerScope[]> {
  return db
    .select({
      institutionId: managerScope.institutionId,
      managerProfessionalId: managerScope.managerProfessionalId,
      hospitalId: managerScope.hospitalId,
      sectorId: managerScope.sectorId,
      active: managerScope.active,
    })
    .from(managerScope)
    .where(
      and(
        eq(managerScope.institutionId, institutionId),
        eq(managerScope.managerProfessionalId, professionalId),
        eq(managerScope.active, true),
      ),
    );
}

export async function listAuthorizedScheduleContexts(
  actor: TenantActor,
  db?: ContextDb,
): Promise<AuthorizedScheduleContext[]> {
  const database = db ?? (await getDb());
  if (!database) throw new Error("Database not available");
  const contexts = await selectActiveScheduleContexts(
    database,
    actor.institutionId,
  );
  const professional =
    actor.professionalId === null
      ? null
      : await loadProfessionalQualification(database, actor.professionalId);
  const accesses =
    actor.professionalId === null
      ? []
      : await loadProfessionalAccesses(
          database,
          actor.institutionId,
          actor.professionalId,
        );
  const managerScopes =
    actor.roleInInstitution === "GESTOR_MEDICO" && actor.professionalId !== null
      ? await loadManagerScopes(
          database,
          actor.institutionId,
          actor.professionalId,
        )
      : [];

  return filterScheduleContextsForActor({
    actor,
    contexts,
    professional,
    accesses,
    managerScopes,
  });
}

export async function listAssumableScheduleContextIds(
  institutionId: number,
  professionalId: number,
  db?: ContextDb,
): Promise<number[]> {
  const database = db ?? (await getDb());
  if (!database) throw new Error("Database not available");
  // Também roda dentro de transações de candidatura; consultas sequenciais
  // evitam concorrência de comandos na mesma conexão MySQL.
  const contexts = await selectActiveScheduleContexts(database, institutionId);
  const professional = await loadProfessionalQualification(
    database,
    professionalId,
  );
  const accesses = await loadProfessionalAccesses(
    database,
    institutionId,
    professionalId,
  );
  if (!professional) return [];
  return contexts
    .filter(
      (context) =>
        qualificationMatches(professional, context) &&
        accesses.some((access) =>
          accessCoversContext(access, professionalId, context),
        ),
    )
    .map((context) => context.id);
}

export async function assertProfessionalEligibleForScheduleContext(input: {
  institutionId: number;
  professionalId: number;
  scheduleContextId: number | null;
  db?: ContextDb;
  /** Em mutações, manter o contexto estável até a escrita da alocação. */
  lockForShare?: boolean;
}): Promise<void> {
  if (input.scheduleContextId === null) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Plantão sem escala operacional classificada.",
    });
  }
  if (input.lockForShare && !input.db) {
    throw new TypeError("lockForShare exige a conexão da transação de escrita");
  }
  const database = input.db ?? (await getDb());
  if (!database) throw new Error("Database not available");
  if (input.lockForShare) {
    const [lockedContext] = await database
      .select({ id: scheduleContexts.id })
      .from(scheduleContexts)
      .where(
        and(
          eq(scheduleContexts.id, input.scheduleContextId),
          eq(scheduleContexts.institutionId, input.institutionId),
          eq(scheduleContexts.active, true),
        ),
      )
      .limit(1)
      .for("share");
    if (!lockedContext) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Escala inexistente, inativa ou fora do tenant ativo.",
      });
    }
  }
  const ids = await listAssumableScheduleContextIds(
    input.institutionId,
    input.professionalId,
    database,
  );
  if (!ids.includes(input.scheduleContextId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Profissional sem acesso ou qualificação para esta escala.",
    });
  }
}

export async function assertActiveScheduleContextTopology(input: {
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  scheduleContextId: number | null;
  db?: ContextDb;
}): Promise<ActiveScheduleContext> {
  if (input.scheduleContextId === null) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Plantão sem escala operacional classificada.",
    });
  }
  const database = input.db ?? (await getDb());
  if (!database) throw new Error("Database not available");
  const [context] = await selectActiveScheduleContexts(
    database,
    input.institutionId,
    {
      id: input.scheduleContextId,
      hospitalId: input.hospitalId,
      sectorId: input.sectorId,
    },
  );
  if (!context) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Escala inativa ou fora da topologia do plantão.",
    });
  }
  return context;
}

export async function resolveScheduleContextForShiftCreation(input: {
  institutionId: number;
  scheduleContextId?: number;
  hospitalId: number;
  sectorId?: number;
  templateSectorId: number | null;
  db?: ContextDb;
}): Promise<AuthorizedScheduleContext> {
  const database = input.db ?? (await getDb());
  if (!database) throw new Error("Database not available");
  const candidates = await selectActiveScheduleContexts(
    database,
    input.institutionId,
    {
      ...(input.scheduleContextId !== undefined
        ? { id: input.scheduleContextId }
        : {}),
      hospitalId: input.hospitalId,
      ...(input.sectorId !== undefined ? { sectorId: input.sectorId } : {}),
    },
  );
  const context =
    input.scheduleContextId !== undefined
      ? candidates[0]
      : requireSingleLegacyScheduleContext(candidates);
  if (!context) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Escala inexistente, inativa ou fora do tenant ativo.",
    });
  }
  if (
    input.templateSectorId !== null &&
    input.templateSectorId !== context.sectorId
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "O template informado pertence a outro setor.",
    });
  }
  return describeScheduleContext(context, true);
}

export const scheduleContextsRouter = router({
  listMine: protectedProcedure.query(async ({ ctx }) => {
    const actor = await getTenantActorFromContext(ctx);
    return listAuthorizedScheduleContexts(actor);
  }),
});
