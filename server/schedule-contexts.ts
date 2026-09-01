import { TRPCError } from "@trpc/server";
import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  hospitals,
  institutions,
  managerScope,
  medicalSpecialties,
  professionalAccess,
  professionalInstitutions,
  professionals,
  scheduleContextAllowedQualifications,
  scheduleContexts,
  scheduleInvites,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  users,
} from "../drizzle/schema";
import { isGeneralistOperationalProfile } from "../lib/medical-specialties";
import type { ScheduleContextAdmissionPolicy } from "../lib/sao-carlos-schedule-blueprint";
import {
  assertCanManageInstitutionSchedule,
  assertManagerScopeAccess,
  assertManagerScopeAccessForUpdate,
  getTenantActorFromContext,
  type TenantActor,
} from "./_core/policy";
import { protectedProcedure, router } from "./_core/trpc";
import { recordAudit } from "./audit-trail";
import { getDb } from "./db";
import { ensureDefaultSectorScale, listManageableTopology } from "./sector-scale";
import {
  isSectorServiceSpecialtiesTableMissing,
  loadSectorServiceSpecialtiesByTopology,
  readSectorServiceSpecialties,
  replaceSectorServiceSpecialties,
  sectorServiceSpecialtiesMigrationPendingError,
  sectorServiceSpecialtyTopologyKey,
  type SectorServiceSpecialtiesAvailability,
  type SectorServiceSpecialtyDescriptor,
} from "./sector-service-specialties";
import { z } from "zod";

export type AllowedScheduleContextQualification = {
  medicalSpecialtyId: number | null;
  operationalProfileCode:
    | "MEDICO_GENERALISTA"
    | "RESIDENTE_ANESTESIOLOGIA"
    | null;
};

export type ScheduleContextQualification = {
  medicalSpecialtyId: number | null;
  operationalProfileCode: "MEDICO_GENERALISTA" | "RESIDENTE_ANESTESIOLOGIA" | null;
  admissionPolicy?: ScheduleContextAdmissionPolicy;
  allowedQualifications?: readonly AllowedScheduleContextQualification[];
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
  admissionPolicy: ScheduleContextAdmissionPolicy;
  active: boolean;
  /**
   * Metadado assistencial do setor. Nunca é consultado por
   * qualificationMatches, ACL ou escrita de alocação.
   */
  serviceSpecialties?: readonly SectorServiceSpecialtyDescriptor[];
  /**
   * A relation é ativada por migration manual. A pendência só afeta sua
   * apresentação administrativa; não altera a escala nem suas permissões.
   */
  serviceSpecialtiesAvailability?: SectorServiceSpecialtiesAvailability;
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
  if (policy === "QUALIFICATION_ALLOWLIST") {
    const allowed = context.allowedQualifications;
    if (!allowed || allowed.length === 0) return false;
    return allowed.some((entry) =>
      entry.medicalSpecialtyId !== null
        ? professional.medicalSpecialtyId === entry.medicalSpecialtyId
        : professional.operationalProfileCode === entry.operationalProfileCode,
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

/**
 * ACL de professional_access para um ScheduleContext. Em
 * QUALIFICATION_ALLOWLIST exige sectorId exato — acesso hospital-wide
 * (sectorId = null) não cobre o setor. Contextos legados preservam o
 * comportamento hospital-wide de accessCoversContext.
 */
export function accessCoversScheduleContext(
  access: ScheduleContextAccess,
  professionalId: number,
  context: Pick<
    ActiveScheduleContext,
    "institutionId" | "hospitalId" | "sectorId" | "admissionPolicy"
  >,
): boolean {
  if (!accessCoversContext(access, professionalId, context)) {
    return false;
  }
  if (context.admissionPolicy === "QUALIFICATION_ALLOWLIST") {
    return access.sectorId === context.sectorId;
  }
  return true;
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

/**
 * Convite nominal enviado e ainda não resgatado (e-mail saiu, código
 * válido). Não é professional_access — o resgate é que grava o setor.
 * O gestor precisa ver e alocar essa pessoa na hora.
 */
export async function pendingNamedInviteCoversScale(
  db: ContextDb,
  input: {
    institutionId: number;
    hospitalId: number;
    sectorId: number;
    userId: number;
    now?: Date;
  },
): Promise<boolean> {
  const [invite] = await db
    .select({ id: scheduleInvites.id })
    .from(scheduleInvites)
    .where(
      and(
        eq(scheduleInvites.institutionId, input.institutionId),
        eq(scheduleInvites.hospitalId, input.hospitalId),
        eq(scheduleInvites.sectorId, input.sectorId),
        eq(scheduleInvites.invitedUserId, input.userId),
        isNull(scheduleInvites.revokedAt),
        isNull(scheduleInvites.declinedAt),
        gt(scheduleInvites.expiresAt, input.now ?? new Date()),
        sql`${scheduleInvites.redeemedCount} < ${scheduleInvites.maxRedemptions}`,
      ),
    )
    .limit(1);
  return Boolean(invite);
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
  if (context.admissionPolicy === "QUALIFICATION_ALLOWLIST") {
    return {
      ...context,
      qualificationKind: "SECTOR_POLICY",
      qualificationCode: "QUALIFICATION_ALLOWLIST",
      qualificationName: "",
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

function agendaScheduleContextPolicyRank(
  policy: ScheduleContextAdmissionPolicy,
): number {
  if (policy === "QUALIFICATION_ALLOWLIST") return 0;
  if (
    policy === "ALL_CFM_SPECIALTIES" ||
    policy === "ALL_CFM_EXCEPT_GENERALIST"
  ) {
    return 1;
  }
  return 2;
}

/** Uma linha da Agenda por hospital+setor; prioriza o contexto unificado. */
export function pickCanonicalAgendaScheduleContext(
  candidates: readonly AuthorizedScheduleContext[],
): AuthorizedScheduleContext {
  if (candidates.length === 1) return candidates[0]!;
  const sorted = [...candidates].sort((left, right) => {
    const rankDiff =
      agendaScheduleContextPolicyRank(left.admissionPolicy) -
      agendaScheduleContextPolicyRank(right.admissionPolicy);
    if (rankDiff !== 0) return rankDiff;
    return left.id - right.id;
  });
  const picked = sorted[0]!;
  if (picked.canManage || !candidates.some((candidate) => candidate.canManage)) {
    return picked;
  }
  return { ...picked, canManage: true };
}

export function dedupeAuthorizedScheduleContextsForAgenda(
  contexts: readonly AuthorizedScheduleContext[],
): AuthorizedScheduleContext[] {
  const groups = new Map<string, AuthorizedScheduleContext[]>();
  for (const context of contexts) {
    const key = `${context.hospitalId}:${context.sectorId}`;
    const list = groups.get(key) ?? [];
    list.push(context);
    groups.set(key, list);
  }
  return [...groups.values()]
    .map(pickCanonicalAgendaScheduleContext)
    .sort(
      (left, right) =>
        left.hospitalName.localeCompare(right.hospitalName, "pt-BR") ||
        left.sectorName.localeCompare(right.sectorName, "pt-BR") ||
        left.id - right.id,
    );
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

  return dedupeAuthorizedScheduleContextsForAgenda(authorized);
}

/**
 * Leitura do panorama Geral: qualquer membro ativo do tenant vê as
 * escalas ativas da instituição (quem está no plantão). canManage e
 * prática continuam na allowlist — isto não concede professional_access
 * nem mutação.
 */
export function filterScheduleContextsForRosterRead(input: {
  actor: Pick<
    TenantActor,
    "institutionId" | "professionalId" | "roleInInstitution" | "isGlobalAdmin"
  >;
  contexts: ActiveScheduleContext[];
  professional: ProfessionalQualification | null;
  accesses: ScheduleContextAccess[];
  managerScopes: ScheduleContextManagerScope[];
}): AuthorizedScheduleContext[] {
  const authorizedById = new Map(
    filterScheduleContextsForActor(input).map(
      (context) => [context.id, context] as const,
    ),
  );
  const tenantContexts = input.contexts.filter(
    (context) =>
      context.active && context.institutionId === input.actor.institutionId,
  );
  return dedupeAuthorizedScheduleContextsForAgenda(
    tenantContexts.map(
      (context) =>
        authorizedById.get(context.id) ?? describeScheduleContext(context, false),
    ),
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

async function loadScheduleContextAllowlists(
  db: ContextDb,
  contextIds: readonly number[],
): Promise<Map<number, AllowedScheduleContextQualification[]>> {
  if (contextIds.length === 0) return new Map();
  const rows = await db
    .select({
      scheduleContextId: scheduleContextAllowedQualifications.scheduleContextId,
      medicalSpecialtyId:
        scheduleContextAllowedQualifications.medicalSpecialtyId,
      operationalProfileCode:
        scheduleContextAllowedQualifications.operationalProfileCode,
    })
    .from(scheduleContextAllowedQualifications)
    .where(
      inArray(
        scheduleContextAllowedQualifications.scheduleContextId,
        [...contextIds],
      ),
    );
  const map = new Map<number, AllowedScheduleContextQualification[]>();
  for (const row of rows) {
    const list = map.get(row.scheduleContextId) ?? [];
    list.push({
      medicalSpecialtyId: row.medicalSpecialtyId,
      operationalProfileCode: row.operationalProfileCode as
        | "MEDICO_GENERALISTA"
        | "RESIDENTE_ANESTESIOLOGIA"
        | null,
    });
    map.set(row.scheduleContextId, list);
  }
  return map;
}

async function enrichActiveScheduleContexts(
  db: ContextDb,
  rows: Omit<ActiveScheduleContext, "allowedQualifications">[],
): Promise<ActiveScheduleContext[]> {
  const allowlistIds = rows
    .filter((row) => row.admissionPolicy === "QUALIFICATION_ALLOWLIST")
    .map((row) => row.id);
  const allowlists = await loadScheduleContextAllowlists(db, allowlistIds);
  return rows.map((row) => ({
    ...row,
    allowedQualifications:
      row.admissionPolicy === "QUALIFICATION_ALLOWLIST"
        ? (allowlists.get(row.id) ?? [])
        : undefined,
  }));
}

/**
 * Projeção exclusiva de leitura para interfaces administrativas. Ela fica
 * fora de selectActiveScheduleContexts para que metadados assistenciais nunca
 * se tornem dependência de elegibilidade, ACL ou escrita de plantão.
 */
export async function attachSectorServiceSpecialtiesToContexts<
  T extends ActiveScheduleContext,
>(
  db: ContextDb,
  contexts: readonly T[],
): Promise<T[]> {
  let serviceSpecialtiesByTopology: Map<
    string,
    SectorServiceSpecialtyDescriptor[]
  >;
  try {
    serviceSpecialtiesByTopology = await loadSectorServiceSpecialtiesByTopology(
      db,
      contexts.map((context) => ({
        institutionId: context.institutionId,
        hospitalId: context.hospitalId,
        sectorId: context.sectorId,
      })),
    );
  } catch (error) {
    if (isSectorServiceSpecialtiesTableMissing(error)) {
      return contexts.map((context) => ({
        ...context,
        serviceSpecialties: [],
        serviceSpecialtiesAvailability: "MIGRATION_PENDING" as const,
      }));
    }
    throw error;
  }
  return contexts.map((context) => ({
    ...context,
    serviceSpecialties:
      serviceSpecialtiesByTopology.get(
        sectorServiceSpecialtyTopologyKey(context),
      ) ?? [],
    serviceSpecialtiesAvailability: "AVAILABLE" as const,
  }));
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
 * Política compartilhada dos leitores de turno. Qualquer membro do
 * tenant lê escalas ativas da instituição (panorama Geral). A exceção
 * estreita da própria alocação cobre plantão sem contexto classificado.
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
  const contexts = await listReadableScheduleContexts(input.actor, database);
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
          and(
            eq(scheduleContexts.admissionPolicy, "QUALIFICATION_ALLOWLIST"),
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

  return enrichActiveScheduleContexts(
    db,
    rows.map((row) => ({
      ...row,
      active: true as const,
      operationalProfileCode: row.operationalProfileCode as
        | "MEDICO_GENERALISTA"
        | "RESIDENTE_ANESTESIOLOGIA"
        | null,
      admissionPolicy: row.admissionPolicy,
    })),
  );
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
          accessCoversScheduleContext(access, input.professionalId, context),
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
  const contexts = await attachSectorServiceSpecialtiesToContexts(
    database,
    await selectActiveScheduleContexts(database, institutionId),
  );
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

/** Qualificação + papel no tenant, numa query só — USER não paga manager_scope. */
async function loadProfessionalQualificationForAssumable(
  db: ContextDb,
  institutionId: number,
  professionalId: number,
): Promise<{
  qualification: ProfessionalQualification;
  roleInInstitution: "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS" | null;
} | null> {
  const [row] = await db
    .select({
      medicalSpecialtyId: professionals.medicalSpecialtyId,
      operationalProfileCode: professionals.operationalProfileCode,
      roleInInstitution: professionalInstitutions.roleInInstitution,
    })
    .from(professionals)
    .leftJoin(
      professionalInstitutions,
      and(
        eq(professionalInstitutions.professionalId, professionals.id),
        eq(professionalInstitutions.userId, professionals.userId),
        eq(professionalInstitutions.institutionId, institutionId),
        eq(professionalInstitutions.active, true),
      ),
    )
    .where(eq(professionals.id, professionalId))
    .limit(1);
  if (!row) return null;
  return {
    qualification: {
      medicalSpecialtyId: row.medicalSpecialtyId,
      operationalProfileCode: row.operationalProfileCode as
        "MEDICO_GENERALISTA" | null,
    },
    roleInInstitution: row.roleInInstitution ?? null,
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

async function loadActorScheduleContextPolicy(
  actor: TenantActor,
  database: ContextDb,
): Promise<{
  contexts: ActiveScheduleContext[];
  professional: ProfessionalQualification | null;
  accesses: ScheduleContextAccess[];
  managerScopes: ScheduleContextManagerScope[];
}> {
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
  return { contexts, professional, accesses, managerScopes };
}

export async function listAuthorizedScheduleContexts(
  actor: TenantActor,
  db?: ContextDb,
): Promise<AuthorizedScheduleContext[]> {
  const database = db ?? (await getDb());
  if (!database) throw new Error("Database not available");
  return filterScheduleContextsForActor({
    actor,
    ...(await loadActorScheduleContextPolicy(actor, database)),
  });
}

export async function listReadableScheduleContexts(
  actor: TenantActor,
  db?: ContextDb,
): Promise<AuthorizedScheduleContext[]> {
  const database = db ?? (await getDb());
  if (!database) throw new Error("Database not available");
  return filterScheduleContextsForRosterRead({
    actor,
    ...(await loadActorScheduleContextPolicy(actor, database)),
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
  const professional = await loadProfessionalQualificationForAssumable(
    database,
    institutionId,
    professionalId,
  );
  const accesses = await loadProfessionalAccesses(
    database,
    institutionId,
    professionalId,
  );
  if (!professional) return [];
  // USER não tem manager_scope. Carregar sempre quebrava o orçamento de
  // listAvailable (6 queries → 7) no caminho quente do plantonista.
  const scopes =
    professional.roleInInstitution === "GESTOR_MEDICO" ||
    professional.roleInInstitution === "GESTOR_PLUS"
      ? await loadManagerScopes(database, institutionId, professionalId)
      : [];
  return contexts
    .filter((context) => {
      const scoped = scopes.some((scope) =>
        managerScopeCoversContext(scope, professionalId, context),
      );
      // listAssumable = vagas que o próprio plantonista vê. Qualificação
      // ainda vale aqui. Alocação pelo gestor (assert + picker) não filtra
      // especialidade — ver assertProfessionalEligibleForScheduleContext.
      if (scoped) return true;
      return (
        qualificationMatches(professional.qualification, context) &&
        accesses.some((access) =>
          accessCoversScheduleContext(access, professionalId, context),
        )
      );
    })
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
  const [context] = await selectActiveScheduleContexts(
    database,
    input.institutionId,
    { id: input.scheduleContextId },
  );
  if (!context) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Escala inexistente, inativa ou fora do tenant ativo.",
    });
  }

  const [professional] = await database
    .select({ userId: professionals.userId })
    .from(professionals)
    .where(eq(professionals.id, input.professionalId))
    .limit(1);
  if (!professional) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Profissional sem acesso para esta escala.",
    });
  }

  // Alocação não filtra por especialidade / QUALIFICATION_ALLOWLIST.
  // Vale GESTOR_PLUS, acesso setorial, manager_scope ou convite nominal pendente.
  const [membership] = await database
    .select({
      roleInInstitution: professionalInstitutions.roleInInstitution,
    })
    .from(professionalInstitutions)
    .where(
      and(
        eq(professionalInstitutions.professionalId, input.professionalId),
        eq(professionalInstitutions.userId, professional.userId),
        eq(professionalInstitutions.institutionId, input.institutionId),
        eq(professionalInstitutions.active, true),
      ),
    )
    .limit(1);
  if (membership?.roleInInstitution === "GESTOR_PLUS") {
    return;
  }
  const scopes = await loadManagerScopes(
    database,
    input.institutionId,
    input.professionalId,
  );
  if (
    scopes.some((scope) =>
      managerScopeCoversContext(scope, input.professionalId, context),
    )
  ) {
    return;
  }

  const accesses = await loadProfessionalAccesses(
    database,
    input.institutionId,
    input.professionalId,
  );
  if (
    accesses.some((access) =>
      accessCoversScheduleContext(access, input.professionalId, context),
    )
  ) {
    return;
  }

  if (
    await pendingNamedInviteCoversScale(database, {
      institutionId: input.institutionId,
      hospitalId: context.hospitalId,
      sectorId: context.sectorId,
      userId: professional.userId,
    })
  ) {
    return;
  }

  throw new TRPCError({
    code: "FORBIDDEN",
    message: "Profissional sem acesso para esta escala.",
  });
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

export async function assertTenantHospitalSector(
  db: ContextDb,
  institutionId: number,
  hospitalId: number,
  sectorId: number,
): Promise<void> {
  const [row] = await db
    .select({ id: sectors.id })
    .from(sectors)
    .innerJoin(hospitals, eq(hospitals.id, sectors.hospitalId))
    .where(
      and(
        eq(sectors.id, sectorId),
        eq(sectors.institutionId, institutionId),
        eq(sectors.hospitalId, hospitalId),
        eq(hospitals.id, hospitalId),
        eq(hospitals.institutionId, institutionId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Hospital ou setor fora do tenant ativo.",
    });
  }
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
  if (input.sectorId !== undefined) {
    await assertTenantHospitalSector(
      database,
      input.institutionId,
      input.hospitalId,
      input.sectorId,
    );
  }
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
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    return attachSectorServiceSpecialtiesToContexts(
      db,
      await listAuthorizedScheduleContexts(actor, db),
    );
  }),

  /** Escalas ativas do tenant para o panorama Geral — só leitura. */
  listReadable: protectedProcedure.query(async ({ ctx }) => {
    const actor = await getTenantActorFromContext(ctx);
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    return attachSectorServiceSpecialtiesToContexts(
      db,
      await listReadableScheduleContexts(actor, db),
    );
  }),

  /**
   * Hospitais e setores que o gestor pode operar — mesmo sem escala
   * já aberta. Sem isso, Unimed (e qualquer tenant novo) some da Agenda.
   */
  listManageableTopology: protectedProcedure.query(async ({ ctx }) => {
    const actor = await getTenantActorFromContext(ctx);
    assertCanManageInstitutionSchedule(actor);
    const db = await getDb();
    if (!db) throw new Error("Database not available");
    return listManageableTopology(db, actor);
  }),

  /**
   * Cria (ou reaproveita) setor + contexto + templates padrão.
   * Mesmo caminho para São Carlos, Unimed ou qualquer outra instituição.
   */
  ensureDefaultSectorScale: protectedProcedure
    .input(
      z.object({
        hospitalId: z.number().int().positive(),
        sectorId: z.number().int().positive().optional(),
        sectorName: z
          .string()
          .trim()
          .min(2, "Informe o nome do setor (pelo menos 2 caracteres).")
          .max(255)
          .optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await getTenantActorFromContext(ctx);
      assertCanManageInstitutionSchedule(actor);
      if (input.sectorId) {
        await assertManagerScopeAccess(actor, input.hospitalId, input.sectorId);
      } else {
        await assertManagerScopeAccess(actor, input.hospitalId);
      }
      if (!input.sectorId && !input.sectorName) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Informe o setor para criar a escala.",
        });
      }
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const result = await ensureDefaultSectorScale(db, {
        institutionId: ctx.institutionId,
        hospitalId: input.hospitalId,
        sectorId: input.sectorId,
        sectorName: input.sectorName,
      });
      const [opened] = await selectActiveScheduleContexts(db, ctx.institutionId, {
        id: result.scheduleContextId,
      });
      return {
        hospitalId: result.hospitalId,
        hospitalName: result.hospitalName,
        sectorId: result.sectorId,
        sectorName: result.sectorName,
        scheduleContextId: result.scheduleContextId,
        createdSector: result.createdSector,
        createdContext: result.createdContext,
        createdTemplates: result.createdTemplates,
        context: opened ? describeScheduleContext(opened, true) : null,
      };
    }),

  /** Metadados clínicos do setor, sem efeito sobre admissão ou alocação. */
  getSectorServiceSpecialties: protectedProcedure
    .input(
      z.object({
        hospitalId: z.number().int().positive(),
        sectorId: z.number().int().positive(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const actor = await getTenantActorFromContext(ctx);
      assertCanManageInstitutionSchedule(actor);
      await assertManagerScopeAccess(actor, input.hospitalId, input.sectorId);
      const db = await getDb();
      if (!db) throw new Error("Database not available");
      const result = await readSectorServiceSpecialties(db, {
        institutionId: actor.institutionId,
        hospitalId: input.hospitalId,
        sectorId: input.sectorId,
      });
      return {
        hospitalId: input.hospitalId,
        sectorId: input.sectorId,
        ...result,
      };
    }),

  /**
   * Atualiza apenas o rótulo assistencial do setor. A autorização é refeita
   * sob lock na mesma transação que grava a relação N:N.
   */
  replaceSectorServiceSpecialties: protectedProcedure
    .input(
      z.object({
        hospitalId: z.number().int().positive(),
        sectorId: z.number().int().positive(),
        medicalSpecialtyCodes: z
          .array(z.string().trim().min(1).max(64))
          .max(55),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const actor = await getTenantActorFromContext(ctx);
      assertCanManageInstitutionSchedule(actor);
      const db = await getDb();
      if (!db) throw new Error("Database not available");

      try {
        return await db.transaction(async (tx) => {
          const actorRole = await assertManagerScopeAccessForUpdate(
            tx,
            actor,
            ctx.user!.sessionVersion,
            input.hospitalId,
            input.sectorId,
          );
          const result = await replaceSectorServiceSpecialties(tx, {
            institutionId: actor.institutionId,
            hospitalId: input.hospitalId,
            sectorId: input.sectorId,
            medicalSpecialtyCodes: input.medicalSpecialtyCodes,
          });
          if (result.changed) {
            await recordAudit(
              {
                institutionId: actor.institutionId,
                actorUserId: actor.userId,
                actorRole,
                actorName: ctx.user!.name ?? undefined,
                action: "SECTOR_SERVICE_SPECIALTIES_UPDATED",
                entityType: "SECTOR",
                entityId: input.sectorId,
                hospitalId: input.hospitalId,
                sectorId: input.sectorId,
                description: "Especialidades assistenciais do setor atualizadas",
                metadata: {
                  addedCodes: result.addedCodes,
                  removedCodes: result.removedCodes,
                },
              },
              { db: tx, strict: true },
            );
          }
          return {
            hospitalId: input.hospitalId,
            sectorId: input.sectorId,
            ...result,
          };
        });
      } catch (error) {
        if (isSectorServiceSpecialtiesTableMissing(error)) {
          throw sectorServiceSpecialtiesMigrationPendingError();
        }
        throw error;
      }
    }),
});
