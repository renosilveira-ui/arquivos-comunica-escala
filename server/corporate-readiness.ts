import { createHash } from "node:crypto";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import {
  managerScope,
  monthlyRosters,
  professionalAccess,
  professionalInstitutions,
  professionals,
  pushTokens,
  scheduleContexts,
  scheduleContextAllowedQualifications,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  shiftTemplates,
  users,
} from "../drizzle/schema";
import { pickShiftTemplatesForSector } from "../lib/shift-template-options";
import { monthWindowBrt } from "./local-time";
import type { TenantActor } from "./_core/policy";
import type { getDb } from "./db";

export const CORPORATE_READINESS_REPORT_VERSION = "v1" as const;

export const CORPORATE_READINESS_SEVERITIES = [
  "SECURITY_BLOCKER",
  "OPERATIONAL_WARNING",
  "INFO",
] as const;

export type CorporateReadinessSeverity =
  (typeof CORPORATE_READINESS_SEVERITIES)[number];

export type CorporateReadinessScope = {
  institutionId: number;
  hospitalId: number;
  sectorId?: number;
  yearMonth: string;
};

export type CorporateReadinessIssue = {
  code: string;
  severity: CorporateReadinessSeverity;
  scope: {
    institutionId: number;
    hospitalId: number;
    sectorId?: number;
  };
};

export type SectorReadinessV1 = {
  sectorId: number;
  sectorName: string;
  metrics: {
    activeScheduleContextCount: number;
    resolvedActiveTemplateCount: number;
    calendarMonthShiftCount: number;
    vacantShiftCount: number;
    assignedShiftCount: number;
    activeManagerCount: number;
    eligibleProfessionalCount: number;
    allocatedProfessionalCount: number;
    allocatedProfessionalsWithPushTokenCount: number;
    allocatedProfessionalsWithEmailCount: number;
    confirmationCompatibleShiftCount: number;
  };
  issues: CorporateReadinessIssue[];
};

export type CorporateReadinessSummary = Record<
  CorporateReadinessSeverity,
  number
>;

export type CorporateReadinessReportV1 = {
  version: typeof CORPORATE_READINESS_REPORT_VERSION;
  scope: CorporateReadinessScope;
  rosterStatus: "DRAFT" | "PUBLISHED" | "LOCKED";
  generatedAt: string;
  snapshotHash: string;
  summary: CorporateReadinessSummary;
  hospitalIssues: CorporateReadinessIssue[];
  sectors: SectorReadinessV1[];
  acknowledgement: {
    required: boolean;
    operationalWarningCodes: string[];
  };
  integrations: {
    /** Aguardando a relação N:N `sector_service_specialties` da PR própria. */
    serviceSpecialtyMetadata: "AVAILABLE" | "PENDING_RELATION";
  };
  visibility: {
    detailsRedacted: boolean;
    /** Nunca expõe cardinalidade de setores fora da jurisdição do gestor. */
    hiddenSectorCount: number | null;
  };
};

export type CorporateReadinessAcknowledgement = {
  snapshotHash: string;
  issueCodes: string[];
};

type ReadinessDb = Pick<
  NonNullable<Awaited<ReturnType<typeof getDb>>>,
  "select"
>;

type ReadinessMembership = {
  professionalId: number;
  userId: number;
  roleInInstitution: "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";
  userEmail: string | null;
};

export type CorporateReadinessSource = {
  scope: CorporateReadinessScope;
  rosterStatus: "DRAFT" | "PUBLISHED" | "LOCKED";
  sectors: { id: number; name: string }[];
  activeScheduleContexts: {
    id: number;
    sectorId: number;
    medicalSpecialtyId: number | null;
    operationalProfileCode: string | null;
    /** Só QUALIFICATION_ALLOWLIST exige ACL setorial exata na regra canônica. */
    admissionPolicy?: string;
  }[];
  /**
   * Autoridade canônica de elegibilidade dos contextos com allowlist. Isto não
   * é a relação descritiva setor↔especialidade: altera a admissão existente e
   * por isso precisa invalidar a ciência de prontidão.
   */
  scheduleContextAllowedQualifications: {
    scheduleContextId: number;
    medicalSpecialtyId: number | null;
    operationalProfileCode: string | null;
  }[];
  invalidScheduleContextIds: number[];
  activeTemplates: {
    id: number;
    hospitalId: number;
    sectorId: number | null;
    name: string;
    startTime: string;
    endTime: string;
    priority: number | null;
  }[];
  invalidTemplateIds: number[];
  shifts: {
    id: number;
    sectorId: number;
    scheduleContextId: number | null;
    label: string;
    specialty: string | null;
    status: string;
    startAt: Date;
    endAt: Date;
    modality: string;
    coverageType: string | null;
    paymentModel: string;
    productivityCapBrl: string | null;
  }[];
  invalidShiftIds: number[];
  memberships: ReadinessMembership[];
  activeProfessionalAccesses: {
    professionalId: number;
    sectorId: number | null;
  }[];
  invalidProfessionalAccessIds: number[];
  staleProfessionalAccessIds: number[];
  activeManagerScopes: {
    id: number;
    managerProfessionalId: number;
    sectorId: number | null;
  }[];
  invalidManagerScopeIds: number[];
  staleManagerScopeIds: number[];
  activeAssignments: {
    id: number;
    shiftInstanceId: number;
    professionalId: number;
    sectorId: number;
    status: string;
  }[];
  invalidAssignmentIds: number[];
  usersWithPushTokens: number[];
  /**
   * Ponto de integração para `user_operational_email_trust` da frente de
   * eventos. Enquanto a relação não existir, a ausência desta fonte não pode
   * produzir um alerta impossível de ser resolvido pelo gestor.
   */
  trustedEmailUserIds?: number[];
  /**
   * Ponto de integração para a PR de especialidades assistenciais.
   * A fonte só deve ser preenchida quando a relação
   * `sector_service_specialties` estiver disponível. Sua ausência não gera
   * alerta provisório: não é seguro transformar a falta da migração em
   * contrato funcional definitivo.
   */
  serviceSpecialtyMetadata?: { sectorIdsWithSpecialties: number[] };
};

const CONFIRMATION_COMPATIBLE_START_TIMES = new Set([
  "07:00",
  "13:00",
  "19:00",
]);

function emptySummary(): CorporateReadinessSummary {
  return {
    SECURITY_BLOCKER: 0,
    OPERATIONAL_WARNING: 0,
    INFO: 0,
  };
}

function clockBrt(date: Date): string {
  return new Date(date.getTime() - 3 * 60 * 60 * 1000)
    .toISOString()
    .slice(11, 16);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function snapshotHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/** Ordem fixa independente de locale/ICU: snapshots auditáveis não podem
 * variar conforme a imagem de execução. Os códigos do contrato são ASCII. */
function compareCanonicalStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareCanonicalStrings);
}

function numericAscending(left: number, right: number): number {
  return left - right;
}

/**
 * O hash precisa mudar quando a configuração operacional muda, mesmo se ela
 * continuar produzindo a mesma contagem de alertas. Mantemos somente IDs e
 * parâmetros técnicos: nomes, e-mails e qualquer conteúdo sensível ficam fora
 * do snapshot canônico.
 */
function readinessConfigurationFingerprint(source: CorporateReadinessSource) {
  return {
    sectors: source.sectors.map((sector) => sector.id).sort(numericAscending),
    activeScheduleContexts: source.activeScheduleContexts
      .map((context) => ({
        id: context.id,
        sectorId: context.sectorId,
        medicalSpecialtyId: context.medicalSpecialtyId,
        operationalProfileCode: context.operationalProfileCode,
        admissionPolicy: context.admissionPolicy ?? null,
      }))
      .sort((left, right) => left.id - right.id),
    scheduleContextAllowedQualifications: source.scheduleContextAllowedQualifications
      .map((qualification) => ({
        scheduleContextId: qualification.scheduleContextId,
        medicalSpecialtyId: qualification.medicalSpecialtyId,
        operationalProfileCode: qualification.operationalProfileCode,
      }))
      .sort(
        (left, right) =>
          left.scheduleContextId - right.scheduleContextId ||
          (left.medicalSpecialtyId ?? 0) - (right.medicalSpecialtyId ?? 0) ||
          compareCanonicalStrings(
            left.operationalProfileCode ?? "",
            right.operationalProfileCode ?? "",
          ),
      ),
    invalidScheduleContextIds: [...source.invalidScheduleContextIds].sort(
      numericAscending,
    ),
    activeTemplates: source.activeTemplates
      .map((template) => ({
        id: template.id,
        hospitalId: template.hospitalId,
        sectorId: template.sectorId,
        name: template.name,
        startTime: template.startTime,
        endTime: template.endTime,
        priority: template.priority,
      }))
      .sort((left, right) => left.id - right.id),
    invalidTemplateIds: [...source.invalidTemplateIds].sort(numericAscending),
    shifts: source.shifts
      .map((shift) => ({
        id: shift.id,
        sectorId: shift.sectorId,
        scheduleContextId: shift.scheduleContextId,
        label: shift.label,
        specialty: shift.specialty,
        status: shift.status,
        startAt: shift.startAt.toISOString(),
        endAt: shift.endAt.toISOString(),
        modality: shift.modality,
        coverageType: shift.coverageType,
        paymentModel: shift.paymentModel,
        productivityCapBrl: shift.productivityCapBrl,
      }))
      .sort((left, right) => left.id - right.id),
    invalidShiftIds: [...source.invalidShiftIds].sort(numericAscending),
    memberships: source.memberships
      .map((membership) => ({
        professionalId: membership.professionalId,
        userId: membership.userId,
        roleInInstitution: membership.roleInInstitution,
        hasEmail: membership.userEmail !== null,
      }))
      .sort(
        (left, right) =>
          left.professionalId - right.professionalId ||
          left.userId - right.userId,
      ),
    activeProfessionalAccesses: source.activeProfessionalAccesses
      .map((access) => ({
        professionalId: access.professionalId,
        sectorId: access.sectorId,
      }))
      .sort(
        (left, right) =>
          left.professionalId - right.professionalId ||
          (left.sectorId ?? 0) - (right.sectorId ?? 0),
      ),
    invalidProfessionalAccessIds: [...source.invalidProfessionalAccessIds].sort(
      numericAscending,
    ),
    staleProfessionalAccessIds: [...source.staleProfessionalAccessIds].sort(
      numericAscending,
    ),
    activeManagerScopes: source.activeManagerScopes
      .map((scope) => ({
        id: scope.id,
        managerProfessionalId: scope.managerProfessionalId,
        sectorId: scope.sectorId,
      }))
      .sort((left, right) => left.id - right.id),
    invalidManagerScopeIds: [...source.invalidManagerScopeIds].sort(
      numericAscending,
    ),
    staleManagerScopeIds: [...source.staleManagerScopeIds].sort(
      numericAscending,
    ),
    activeAssignments: source.activeAssignments
      .map((assignment) => ({
        id: assignment.id,
        shiftInstanceId: assignment.shiftInstanceId,
        professionalId: assignment.professionalId,
        sectorId: assignment.sectorId,
        status: assignment.status,
      }))
      .sort((left, right) => left.id - right.id),
    invalidAssignmentIds: [...source.invalidAssignmentIds].sort(
      numericAscending,
    ),
    usersWithPushTokens: [...source.usersWithPushTokens].sort(numericAscending),
    trustedEmailUserIds: source.trustedEmailUserIds
      ? [...source.trustedEmailUserIds].sort(numericAscending)
      : null,
    serviceSpecialtyMetadata: source.serviceSpecialtyMetadata
      ? {
          sectorIdsWithSpecialties: [
            ...source.serviceSpecialtyMetadata.sectorIdsWithSpecialties,
          ].sort(numericAscending),
        }
      : null,
  };
}

function isOperationalManager(
  membership: ReadinessMembership | undefined,
): boolean {
  return membership?.roleInInstitution === "GESTOR_MEDICO";
}

function isActiveMembership(
  membershipByProfessional: Map<number, ReadinessMembership>,
  professionalId: number,
): boolean {
  return membershipByProfessional.has(professionalId);
}

export function buildCorporateReadinessReport(
  source: CorporateReadinessSource,
  generatedAt = new Date().toISOString(),
): CorporateReadinessReportV1 {
  const sectorsById = new Map(
    source.sectors.map((sector) => [sector.id, sector]),
  );
  const contextIdsBySector = new Map<number, Set<number>>();
  for (const context of source.activeScheduleContexts) {
    if (!sectorsById.has(context.sectorId)) continue;
    const ids = contextIdsBySector.get(context.sectorId) ?? new Set<number>();
    ids.add(context.id);
    contextIdsBySector.set(context.sectorId, ids);
  }

  const membershipByProfessional = new Map(
    source.memberships.map((membership) => [
      membership.professionalId,
      membership,
    ]),
  );
  const gestorPlusProfessionalIds = new Set(
    source.memberships
      .filter((membership) => membership.roleInInstitution === "GESTOR_PLUS")
      .map((membership) => membership.professionalId),
  );
  const pushUserIds = new Set(source.usersWithPushTokens);
  const reportIssues = new Map<string, CorporateReadinessIssue>();
  const addIssue = (
    code: string,
    severity: CorporateReadinessSeverity,
    sectorId?: number,
  ) => {
    const key = `${severity}:${code}:${sectorId ?? "hospital"}`;
    if (reportIssues.has(key)) return;
    reportIssues.set(key, {
      code,
      severity,
      scope: {
        institutionId: source.scope.institutionId,
        hospitalId: source.scope.hospitalId,
        ...(sectorId !== undefined ? { sectorId } : {}),
      },
    });
  };

  if (source.sectors.length === 0) {
    addIssue("NO_SECTORS_CONFIGURED", "OPERATIONAL_WARNING");
  }
  if (source.invalidTemplateIds.length > 0) {
    addIssue("INVALID_TEMPLATE_TOPOLOGY", "SECURITY_BLOCKER");
  }
  if (source.invalidScheduleContextIds.length > 0) {
    addIssue("INVALID_SCHEDULE_CONTEXT_TOPOLOGY", "SECURITY_BLOCKER");
  }
  if (source.invalidShiftIds.length > 0) {
    addIssue("INVALID_SHIFT_TOPOLOGY", "SECURITY_BLOCKER");
  }
  if (source.invalidProfessionalAccessIds.length > 0) {
    addIssue("INVALID_PROFESSIONAL_ACCESS_TOPOLOGY", "SECURITY_BLOCKER");
  }
  if (source.invalidManagerScopeIds.length > 0) {
    addIssue("INVALID_MANAGER_SCOPE_TOPOLOGY", "SECURITY_BLOCKER");
  }
  if (source.staleProfessionalAccessIds.length > 0) {
    addIssue("STALE_PROFESSIONAL_ACCESS", "OPERATIONAL_WARNING");
  }
  if (source.staleManagerScopeIds.length > 0) {
    addIssue("STALE_MANAGER_SCOPE", "OPERATIONAL_WARNING");
  }
  if (source.invalidAssignmentIds.length > 0) {
    addIssue("INVALID_ASSIGNMENT_TOPOLOGY", "SECURITY_BLOCKER");
  }

  const validTemplates = source.activeTemplates.filter(
    (template) =>
      template.sectorId === null || sectorsById.has(template.sectorId),
  );
  const validAccesses = source.activeProfessionalAccesses.filter(
    (access) =>
      (access.sectorId === null || sectorsById.has(access.sectorId)) &&
      isActiveMembership(membershipByProfessional, access.professionalId),
  );
  const validManagerScopes = source.activeManagerScopes.filter(
    (scope) =>
      (scope.sectorId === null || sectorsById.has(scope.sectorId)) &&
      isOperationalManager(
        membershipByProfessional.get(scope.managerProfessionalId),
      ),
  );
  // Esta coleção reproduz a exceção da porta canônica de escrita: um
  // manager_scope ativo cobre a alocação, desde que o vínculo institucional
  // do profissional ainda exista. A métrica de gestores abaixo continua
  // exigindo o papel GESTOR_MEDICO; não transformamos escopo legado em papel.
  const assignmentCoverageManagerScopes = source.activeManagerScopes.filter(
    (scope) =>
      (scope.sectorId === null || sectorsById.has(scope.sectorId)) &&
      isActiveMembership(membershipByProfessional, scope.managerProfessionalId),
  );
  const validShifts = source.shifts.filter((shift) =>
    sectorsById.has(shift.sectorId),
  );
  const shiftsById = new Map(validShifts.map((shift) => [shift.id, shift]));
  const contextsById = new Map(
    source.activeScheduleContexts.map((context) => [context.id, context]),
  );
  const assignmentsByShift = new Map<number, typeof source.activeAssignments>();
  for (const assignment of source.activeAssignments) {
    const list = assignmentsByShift.get(assignment.shiftInstanceId) ?? [];
    list.push(assignment);
    assignmentsByShift.set(assignment.shiftInstanceId, list);
  }

  const sectorReports = source.sectors
    .slice()
    .sort((left, right) => left.id - right.id)
    .map((sector): SectorReadinessV1 => {
      const contextIds = contextIdsBySector.get(sector.id) ?? new Set<number>();
      const sectorTemplates = pickShiftTemplatesForSector(
        validTemplates,
        source.scope.hospitalId,
        sector.id,
      );
      const sectorShifts = validShifts.filter(
        (shift) => shift.sectorId === sector.id,
      );
      const validAccessProfessionalIds = new Set(
        validAccesses
          .filter(
            (access) =>
              access.sectorId === null || access.sectorId === sector.id,
          )
          .map((access) => access.professionalId),
      );
      const scopedManagerProfessionalIds = new Set(
        validManagerScopes
          .filter(
            (scope) => scope.sectorId === null || scope.sectorId === sector.id,
          )
          .map((scope) => scope.managerProfessionalId),
      );
      const eligibleProfessionalIds = new Set([
        ...gestorPlusProfessionalIds,
        ...scopedManagerProfessionalIds,
        ...validAccessProfessionalIds,
      ]);
      const allocatedProfessionalIds = new Set<number>();
      let assignedShiftCount = 0;
      for (const shift of sectorShifts) {
        const assignments = (assignmentsByShift.get(shift.id) ?? []).filter(
          (assignment) =>
            assignment.sectorId === sector.id &&
            isActiveMembership(
              membershipByProfessional,
              assignment.professionalId,
            ),
        );
        const hasCanonicalAssignmentCoverage = (
          assignment: (typeof source.activeAssignments)[number],
        ): boolean => {
          const membership = membershipByProfessional.get(
            assignment.professionalId,
          );
          if (!membership) return false;
          if (membership.roleInInstitution === "GESTOR_PLUS") return true;
          if (
            assignmentCoverageManagerScopes.some(
              (scope) =>
                scope.managerProfessionalId === assignment.professionalId &&
                (scope.sectorId === null || scope.sectorId === sector.id),
            )
          ) {
            return true;
          }
          const requiresExactSectorAccess =
            shift.scheduleContextId !== null &&
            contextsById.get(shift.scheduleContextId)?.admissionPolicy ===
              "QUALIFICATION_ALLOWLIST";
          return validAccesses.some(
            (access) =>
              access.professionalId === assignment.professionalId &&
              (requiresExactSectorAccess
                ? access.sectorId === sector.id
                : access.sectorId === null || access.sectorId === sector.id),
          );
        };
        const confirmedAssignments = assignments.filter(
          (assignment) => assignment.status === "OCUPADO",
        );
        const coveredAssignments = confirmedAssignments.filter(
          hasCanonicalAssignmentCoverage,
        );
        const hasRevokedConfirmedAccess = confirmedAssignments.some(
          (assignment) => !hasCanonicalAssignmentCoverage(assignment),
        );
        if (hasRevokedConfirmedAccess) {
          addIssue("ALLOCATION_ACCESS_REVOKED", "SECURITY_BLOCKER", sector.id);
        }
        if (coveredAssignments.length > 0) assignedShiftCount += 1;
        for (const assignment of coveredAssignments) {
          allocatedProfessionalIds.add(assignment.professionalId);
        }

        if (shift.status === "VAGO") {
          addIssue(
            "VACANT_SHIFT_REQUIRES_ALLOCATION",
            "OPERATIONAL_WARNING",
            sector.id,
          );
        } else if (
          shift.status === "PENDENTE" ||
          assignments.some((assignment) => assignment.status === "PENDENTE")
        ) {
          addIssue(
            "PENDING_ALLOCATION_REQUIRES_REVIEW",
            "OPERATIONAL_WARNING",
            sector.id,
          );
        } else if (
          shift.status === "OCUPADO" &&
          coveredAssignments.length === 0
        ) {
          if (!hasRevokedConfirmedAccess) {
            addIssue(
              "OCCUPIED_SHIFT_WITHOUT_VALID_ASSIGNMENT",
              "SECURITY_BLOCKER",
              sector.id,
            );
          }
        } else if (shift.status !== "OCUPADO") {
          addIssue("UNKNOWN_SHIFT_STATUS", "SECURITY_BLOCKER", sector.id);
        }
      }

      if (contextIds.size === 0) {
        addIssue(
          "MISSING_ACTIVE_SCHEDULE_CONTEXT",
          "OPERATIONAL_WARNING",
          sector.id,
        );
      }
      if (sectorTemplates.length === 0) {
        addIssue(
          "MISSING_ACTIVE_SHIFT_TEMPLATE",
          "OPERATIONAL_WARNING",
          sector.id,
        );
      }
      if (sectorShifts.length === 0) {
        addIssue("NO_CALENDAR_FOR_MONTH", "INFO", sector.id);
      }
      if (
        scopedManagerProfessionalIds.size === 0 &&
        gestorPlusProfessionalIds.size === 0
      ) {
        addIssue(
          "NO_ACTIVE_MANAGER_COVERAGE",
          "OPERATIONAL_WARNING",
          sector.id,
        );
      }
      if (eligibleProfessionalIds.size === 0) {
        addIssue("NO_ELIGIBLE_PROFESSIONAL_COVERAGE", "INFO", sector.id);
      }
      for (const shift of sectorShifts) {
        if (shift.scheduleContextId === null) {
          addIssue("UNCLASSIFIED_SHIFT_CONTEXT", "SECURITY_BLOCKER", sector.id);
        } else if (!contextIds.has(shift.scheduleContextId)) {
          addIssue(
            "INVALID_SHIFT_CONTEXT_TOPOLOGY",
            "SECURITY_BLOCKER",
            sector.id,
          );
        }
        if (!CONFIRMATION_COMPATIBLE_START_TIMES.has(clockBrt(shift.startAt))) {
          addIssue(
            "CONFIRMATION_WINDOW_UNSUPPORTED",
            "OPERATIONAL_WARNING",
            sector.id,
          );
        }
      }

      const allocatedMemberships = [...allocatedProfessionalIds]
        .map((professionalId) => membershipByProfessional.get(professionalId))
        .filter((membership): membership is ReadinessMembership =>
          Boolean(membership),
        );
      const issueList = [...reportIssues.values()].filter(
        (issue) => issue.scope.sectorId === sector.id,
      );
      return {
        sectorId: sector.id,
        sectorName: sector.name,
        metrics: {
          activeScheduleContextCount: contextIds.size,
          resolvedActiveTemplateCount: sectorTemplates.length,
          calendarMonthShiftCount: sectorShifts.length,
          vacantShiftCount: sectorShifts.filter(
            (shift) => shift.status === "VAGO",
          ).length,
          assignedShiftCount,
          activeManagerCount: new Set([
            ...gestorPlusProfessionalIds,
            ...scopedManagerProfessionalIds,
          ]).size,
          eligibleProfessionalCount: eligibleProfessionalIds.size,
          allocatedProfessionalCount: allocatedMemberships.length,
          allocatedProfessionalsWithPushTokenCount: allocatedMemberships.filter(
            (membership) => pushUserIds.has(membership.userId),
          ).length,
          allocatedProfessionalsWithEmailCount: allocatedMemberships.filter(
            (membership) => Boolean(membership.userEmail),
          ).length,
          confirmationCompatibleShiftCount: sectorShifts.filter((shift) =>
            CONFIRMATION_COMPATIBLE_START_TIMES.has(clockBrt(shift.startAt)),
          ).length,
        },
        issues: issueList.sort(
          (left, right) =>
            compareCanonicalStrings(left.severity, right.severity) ||
            compareCanonicalStrings(left.code, right.code),
        ),
      };
    });

  for (const sector of sectorReports) {
    if (
      sector.metrics.allocatedProfessionalCount >
      sector.metrics.allocatedProfessionalsWithPushTokenCount
    ) {
      addIssue("PUSH_DELIVERY_COVERAGE_PARTIAL", "INFO", sector.sectorId);
    }
    if (
      sector.metrics.allocatedProfessionalCount >
      sector.metrics.allocatedProfessionalsWithEmailCount
    ) {
      addIssue("EMAIL_DELIVERY_COVERAGE_PARTIAL", "INFO", sector.sectorId);
    }
  }
  if (source.trustedEmailUserIds) {
    const trustedEmailUserIds = new Set(source.trustedEmailUserIds);
    for (const sector of sectorReports) {
      const hasUntrustedAllocatedProfessional = source.activeAssignments.some(
        (assignment) => {
          const shift = shiftsById.get(assignment.shiftInstanceId);
          if (
            shift?.sectorId !== sector.sectorId ||
            assignment.sectorId !== sector.sectorId
          ) {
            return false;
          }
          const membership = membershipByProfessional.get(
            assignment.professionalId,
          );
          return membership
            ? !trustedEmailUserIds.has(membership.userId)
            : false;
        },
      );
      if (hasUntrustedAllocatedProfessional) {
        addIssue("EMAIL_TRUST_COVERAGE_PARTIAL", "INFO", sector.sectorId);
      }
    }
  }
  if (source.serviceSpecialtyMetadata) {
    const definedSectorIds = new Set(
      source.serviceSpecialtyMetadata.sectorIdsWithSpecialties,
    );
    for (const sector of sectorReports) {
      if (!definedSectorIds.has(sector.sectorId)) {
        addIssue("SERVICE_SPECIALTY_METADATA_PENDING", "INFO", sector.sectorId);
      }
    }
  }

  const allIssues = [...reportIssues.values()].sort(
    (left, right) =>
      (left.scope.sectorId ?? 0) - (right.scope.sectorId ?? 0) ||
      compareCanonicalStrings(left.severity, right.severity) ||
      compareCanonicalStrings(left.code, right.code),
  );
  const issuesBySector = new Map<number, CorporateReadinessIssue[]>();
  for (const issue of allIssues) {
    if (issue.scope.sectorId === undefined) continue;
    const list = issuesBySector.get(issue.scope.sectorId) ?? [];
    list.push(issue);
    issuesBySector.set(issue.scope.sectorId, list);
  }
  for (const sector of sectorReports) {
    sector.issues = issuesBySector.get(sector.sectorId) ?? [];
  }

  const summary = emptySummary();
  for (const issue of allIssues) summary[issue.severity] += 1;
  const hospitalIssues = allIssues.filter(
    (issue) => issue.scope.sectorId === undefined,
  );
  const operationalWarningCodes = uniqueSorted(
    allIssues
      .filter((issue) => issue.severity === "OPERATIONAL_WARNING")
      .map((issue) => issue.code),
  );
  const snapshot = {
    version: CORPORATE_READINESS_REPORT_VERSION,
    scope: source.scope,
    rosterStatus: source.rosterStatus,
    hospitalIssues: hospitalIssues.map((issue) => ({
      code: issue.code,
      severity: issue.severity,
    })),
    sectors: sectorReports.map((sector) => ({
      sectorId: sector.sectorId,
      metrics: sector.metrics,
      issues: sector.issues.map((issue) => ({
        code: issue.code,
        severity: issue.severity,
      })),
    })),
    configuration: readinessConfigurationFingerprint(source),
  };

  return {
    version: CORPORATE_READINESS_REPORT_VERSION,
    scope: source.scope,
    rosterStatus: source.rosterStatus,
    generatedAt,
    snapshotHash: snapshotHash(snapshot),
    summary,
    hospitalIssues,
    sectors: sectorReports,
    acknowledgement: {
      required: operationalWarningCodes.length > 0,
      operationalWarningCodes,
    },
    integrations: {
      serviceSpecialtyMetadata: source.serviceSpecialtyMetadata
        ? "AVAILABLE"
        : "PENDING_RELATION",
    },
    visibility: { detailsRedacted: false, hiddenSectorCount: 0 },
  };
}

export function projectCorporateReadinessReport(
  report: CorporateReadinessReportV1,
  input: { visibleSectorIds: readonly number[]; revealAll: boolean },
): CorporateReadinessReportV1 {
  if (input.revealAll) return report;
  const visible = new Set(input.visibleSectorIds);
  const sectors = report.sectors.filter((sector) =>
    visible.has(sector.sectorId),
  );
  // Um gestor setorial pode diagnosticar somente sua própria operação. Os
  // totais, códigos de ciência e alertas hospitalares podem revelar a
  // existência/configuração de outros setores e nunca servem para autorizar
  // publicação. A projeção recebe um hash próprio para não ser reutilizada
  // como ciência da escala hospitalar completa.
  const visibleIssues = sectors.flatMap((sector) => sector.issues);
  const summary = emptySummary();
  for (const issue of visibleIssues) summary[issue.severity] += 1;
  const operationalWarningCodes = uniqueSorted(
    visibleIssues
      .filter((issue) => issue.severity === "OPERATIONAL_WARNING")
      .map((issue) => issue.code),
  );
  return {
    ...report,
    snapshotHash: snapshotHash({
      version: report.version,
      scope: report.scope,
      redacted: true,
      // O hash redigido precisa provar somente o conteúdo que o gestor pode
      // ver. Incluir o hash hospitalar canônico faria cada mudança invisível
      // em outro setor aparecer como um sinal lateral para este gestor.
      sectors: sectors.map((sector) => ({
        sectorId: sector.sectorId,
        metrics: sector.metrics,
        issues: sector.issues.map((issue) => ({
          code: issue.code,
          severity: issue.severity,
        })),
      })),
    }),
    summary,
    hospitalIssues: [],
    sectors,
    acknowledgement: {
      required: operationalWarningCodes.length > 0,
      operationalWarningCodes,
    },
    visibility: {
      // Mesmo quando um gestor possui todos os setores individualmente, a
      // ausência de escopo hospitalar ainda redige alertas agregados e nem
      // revela quantos setores permanecem fora do seu escopo.
      detailsRedacted: true,
      hiddenSectorCount: null,
    },
  };
}

export function assertReadinessAcknowledgement(
  report: CorporateReadinessReportV1,
  acknowledgement: CorporateReadinessAcknowledgement | undefined,
): void {
  if (report.summary.SECURITY_BLOCKER > 0) {
    throw new Error("READINESS_SECURITY_BLOCKER");
  }
  if (!report.acknowledgement.required) return;
  if (!acknowledgement) {
    throw new Error("READINESS_ACKNOWLEDGEMENT_REQUIRED");
  }
  if (acknowledgement.snapshotHash !== report.snapshotHash) {
    throw new Error("READINESS_SNAPSHOT_STALE");
  }
  const submittedCodes = uniqueSorted(acknowledgement.issueCodes);
  const expectedCodes = report.acknowledgement.operationalWarningCodes;
  if (
    submittedCodes.length !== expectedCodes.length ||
    submittedCodes.some((code, index) => code !== expectedCodes[index])
  ) {
    throw new Error("READINESS_ISSUES_MISMATCH");
  }
}

async function loadReadinessMemberships(
  db: ReadinessDb,
  institutionId: number,
): Promise<ReadinessMembership[]> {
  const membershipRows = await db
    .select({
      professionalId: professionalInstitutions.professionalId,
      userId: professionalInstitutions.userId,
      roleInInstitution: professionalInstitutions.roleInInstitution,
    })
    .from(professionalInstitutions)
    .where(
      and(
        eq(professionalInstitutions.institutionId, institutionId),
        eq(professionalInstitutions.active, true),
      ),
    );
  if (membershipRows.length === 0) return [];
  const professionalIds = uniqueNumberIds(
    membershipRows.map((row) => row.professionalId),
  );
  const userIds = uniqueNumberIds(membershipRows.map((row) => row.userId));
  // Não paralelizar selects quando este helper recebe a conexão de uma
  // transação: o mysql2 não permite dois comandos concorrentes no mesmo
  // socket.
  const professionalRows = await db
    .select({ id: professionals.id, userId: professionals.userId })
    .from(professionals)
    .where(inArray(professionals.id, professionalIds));
  const userRows = await db
    .select({
      id: users.id,
      email: users.email,
      approvalStatus: users.approvalStatus,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(inArray(users.id, userIds));
  const professionalUsers = new Map(
    professionalRows.map((row) => [row.id, row.userId]),
  );
  const approvedUsers = new Map(
    userRows
      .filter(
        (row) => row.approvalStatus === "APPROVED" && row.deletedAt === null,
      )
      .map((row) => [row.id, row]),
  );
  return membershipRows
    .filter(
      (membership) =>
        professionalUsers.get(membership.professionalId) ===
          membership.userId && approvedUsers.has(membership.userId),
    )
    .map((membership) => ({
      professionalId: membership.professionalId,
      userId: membership.userId,
      roleInInstitution: membership.roleInInstitution,
      userEmail: approvedUsers.get(membership.userId)?.email ?? null,
    }));
}

function uniqueNumberIds(values: readonly number[]): number[] {
  return [...new Set(values)].filter(
    (value) => Number.isInteger(value) && value > 0,
  );
}

export async function getCorporateReadinessReport(
  db: ReadinessDb,
  scope: CorporateReadinessScope,
): Promise<CorporateReadinessReportV1> {
  const window = monthWindowBrt(scope.yearMonth);
  const allHospitalSectorRows = await db
    .select({ id: sectors.id, name: sectors.name })
    .from(sectors)
    .where(
      and(
        eq(sectors.institutionId, scope.institutionId),
        eq(sectors.hospitalId, scope.hospitalId),
      ),
    );
  const sectorFilters = [
    eq(sectors.institutionId, scope.institutionId),
    eq(sectors.hospitalId, scope.hospitalId),
    ...(scope.sectorId === undefined ? [] : [eq(sectors.id, scope.sectorId)]),
  ];
  const sectorRows = await db
    .select({ id: sectors.id, name: sectors.name })
    .from(sectors)
    .where(and(...sectorFilters));
  const sectorIds = new Set(sectorRows.map((sector) => sector.id));
  const hospitalSectorIds = new Set(
    allHospitalSectorRows.map((sector) => sector.id),
  );
  const contextRows = await db
    .select({
      id: scheduleContexts.id,
      institutionId: scheduleContexts.institutionId,
      hospitalId: scheduleContexts.hospitalId,
      sectorId: scheduleContexts.sectorId,
      medicalSpecialtyId: scheduleContexts.medicalSpecialtyId,
      operationalProfileCode: scheduleContexts.operationalProfileCode,
      admissionPolicy: scheduleContexts.admissionPolicy,
    })
    .from(scheduleContexts)
    .where(
      and(
        eq(scheduleContexts.hospitalId, scope.hospitalId),
        eq(scheduleContexts.active, true),
      ),
    );
  const templateRows = await db
    .select({
      id: shiftTemplates.id,
      institutionId: shiftTemplates.institutionId,
      hospitalId: shiftTemplates.hospitalId,
      sectorId: shiftTemplates.sectorId,
      name: shiftTemplates.name,
      startTime: shiftTemplates.startTime,
      endTime: shiftTemplates.endTime,
      priority: shiftTemplates.priority,
    })
    .from(shiftTemplates)
    .where(
      and(
        eq(shiftTemplates.hospitalId, scope.hospitalId),
        eq(shiftTemplates.isActive, true),
      ),
    );
  const shiftRows = await db
    .select({
      id: shiftInstances.id,
      institutionId: shiftInstances.institutionId,
      hospitalId: shiftInstances.hospitalId,
      sectorId: shiftInstances.sectorId,
      scheduleContextId: shiftInstances.scheduleContextId,
      label: shiftInstances.label,
      specialty: shiftInstances.specialty,
      status: shiftInstances.status,
      startAt: shiftInstances.startAt,
      endAt: shiftInstances.endAt,
      modality: shiftInstances.modality,
      coverageType: shiftInstances.coverageType,
      paymentModel: shiftInstances.paymentModel,
      productivityCapBrl: shiftInstances.productivityCapBrl,
    })
    .from(shiftInstances)
    .where(
      and(
        eq(shiftInstances.hospitalId, scope.hospitalId),
        gte(shiftInstances.startAt, window.start),
        lt(shiftInstances.startAt, window.end),
      ),
    );
  const rosterRows = await db
    .select({ status: monthlyRosters.status })
    .from(monthlyRosters)
    .where(
      and(
        eq(monthlyRosters.institutionId, scope.institutionId),
        eq(monthlyRosters.hospitalId, scope.hospitalId),
        eq(monthlyRosters.yearMonth, scope.yearMonth),
      ),
    )
    .limit(1);
  const memberships = await loadReadinessMemberships(db, scope.institutionId);
  const membershipByProfessional = new Map(
    memberships.map((membership) => [membership.professionalId, membership]),
  );
  const accessRows = await db
    .select({
      id: professionalAccess.id,
      institutionId: professionalAccess.institutionId,
      professionalId: professionalAccess.professionalId,
      hospitalId: professionalAccess.hospitalId,
      sectorId: professionalAccess.sectorId,
    })
    .from(professionalAccess)
    .where(
      and(
        eq(professionalAccess.hospitalId, scope.hospitalId),
        eq(professionalAccess.canAccess, true),
      ),
    );
  const managerRows = await db
    .select({
      id: managerScope.id,
      institutionId: managerScope.institutionId,
      managerProfessionalId: managerScope.managerProfessionalId,
      hospitalId: managerScope.hospitalId,
      sectorId: managerScope.sectorId,
    })
    .from(managerScope)
    .where(
      and(
        eq(managerScope.hospitalId, scope.hospitalId),
        eq(managerScope.active, true),
      ),
    );
  const validContextRows = contextRows.filter(
    (context) =>
      context.institutionId === scope.institutionId &&
      context.hospitalId === scope.hospitalId,
  );
  const validAllowlistContextIds = uniqueNumberIds(
    validContextRows
      .filter(
        (context) =>
          context.admissionPolicy === "QUALIFICATION_ALLOWLIST" &&
          (scope.sectorId === undefined || context.sectorId === scope.sectorId),
      )
      .map((context) => context.id),
  );
  const allowedQualificationRows =
    validAllowlistContextIds.length === 0
      ? []
      : await db
          .select({
            scheduleContextId:
              scheduleContextAllowedQualifications.scheduleContextId,
            medicalSpecialtyId:
              scheduleContextAllowedQualifications.medicalSpecialtyId,
            operationalProfileCode:
              scheduleContextAllowedQualifications.operationalProfileCode,
          })
          .from(scheduleContextAllowedQualifications)
          .where(
            inArray(
              scheduleContextAllowedQualifications.scheduleContextId,
              validAllowlistContextIds,
            ),
          );
  const validTemplateRows = templateRows.filter(
    (template) =>
      template.institutionId === scope.institutionId &&
      template.hospitalId === scope.hospitalId,
  );
  const validShiftRows = shiftRows.filter(
    (shift) =>
      shift.institutionId === scope.institutionId &&
      shift.hospitalId === scope.hospitalId,
  );
  const validAccessRows = accessRows.filter(
    (access) =>
      access.institutionId === scope.institutionId &&
      access.hospitalId === scope.hospitalId,
  );
  const validManagerRows = managerRows.filter(
    (scopeRow) =>
      scopeRow.institutionId === scope.institutionId &&
      scopeRow.hospitalId === scope.hospitalId,
  );
  const shiftIds = uniqueNumberIds(validShiftRows.map((shift) => shift.id));
  const assignmentRows =
    shiftIds.length === 0
      ? []
      : await db
          .select({
            id: shiftAssignmentsV2.id,
            institutionId: shiftAssignmentsV2.institutionId,
            shiftInstanceId: shiftAssignmentsV2.shiftInstanceId,
            hospitalId: shiftAssignmentsV2.hospitalId,
            professionalId: shiftAssignmentsV2.professionalId,
            sectorId: shiftAssignmentsV2.sectorId,
            status: shiftAssignmentsV2.status,
          })
          .from(shiftAssignmentsV2)
          .where(
            and(
              eq(shiftAssignmentsV2.isActive, true),
              inArray(shiftAssignmentsV2.shiftInstanceId, shiftIds),
            ),
          );
  const validShiftsById = new Map(
    validShiftRows.map((shift) => [shift.id, shift]),
  );
  const membershipUserIds = uniqueNumberIds(
    memberships.map((membership) => membership.userId),
  );
  const tokenRows =
    membershipUserIds.length === 0
      ? []
      : await db
          .select({ userId: pushTokens.userId })
          .from(pushTokens)
          .where(inArray(pushTokens.userId, membershipUserIds));
  return buildCorporateReadinessReport({
    scope,
    rosterStatus: (rosterRows[0]?.status ?? "DRAFT") as
      "DRAFT" | "PUBLISHED" | "LOCKED",
    sectors: sectorRows,
    activeScheduleContexts: validContextRows
      .filter((context) => sectorIds.has(context.sectorId))
      .map((context) => ({
        id: context.id,
        sectorId: context.sectorId,
        medicalSpecialtyId: context.medicalSpecialtyId,
        operationalProfileCode: context.operationalProfileCode,
        admissionPolicy: context.admissionPolicy,
      })),
    scheduleContextAllowedQualifications: allowedQualificationRows,
    invalidScheduleContextIds: contextRows
      .filter(
        (context) =>
          context.institutionId !== scope.institutionId ||
          context.hospitalId !== scope.hospitalId ||
          !hospitalSectorIds.has(context.sectorId),
      )
      .map((context) => context.id),
    activeTemplates: validTemplateRows.map((template) => ({
      id: template.id,
      hospitalId: template.hospitalId,
      sectorId: template.sectorId,
      name: template.name,
      startTime: template.startTime,
      endTime: template.endTime,
      priority: template.priority,
    })),
    invalidTemplateIds: templateRows
      .filter(
        (template) =>
          template.institutionId !== scope.institutionId ||
          template.hospitalId !== scope.hospitalId ||
          (template.sectorId !== null &&
            !hospitalSectorIds.has(template.sectorId)),
      )
      .map((template) => template.id),
    shifts: validShiftRows
      .filter(
        (shift) =>
          sectorIds.has(shift.sectorId) &&
          (scope.sectorId === undefined || shift.sectorId === scope.sectorId),
      )
      .map((shift) => ({
        id: shift.id,
        sectorId: shift.sectorId,
        scheduleContextId: shift.scheduleContextId,
        label: shift.label,
        specialty: shift.specialty,
        status: shift.status,
        startAt: shift.startAt,
        endAt: shift.endAt,
        modality: shift.modality,
        coverageType: shift.coverageType,
        paymentModel: shift.paymentModel,
        productivityCapBrl: shift.productivityCapBrl,
      })),
    invalidShiftIds: shiftRows
      .filter(
        (shift) =>
          shift.institutionId !== scope.institutionId ||
          shift.hospitalId !== scope.hospitalId ||
          !hospitalSectorIds.has(shift.sectorId),
      )
      .map((shift) => shift.id),
    memberships,
    activeProfessionalAccesses: validAccessRows
      .filter(
        (access) => access.sectorId === null || sectorIds.has(access.sectorId),
      )
      .map((access) => ({
        professionalId: access.professionalId,
        sectorId: access.sectorId,
      })),
    invalidProfessionalAccessIds: accessRows
      .filter(
        (access) =>
          access.institutionId !== scope.institutionId ||
          access.hospitalId !== scope.hospitalId ||
          (access.sectorId !== null && !hospitalSectorIds.has(access.sectorId)),
      )
      .map((access) => access.id),
    staleProfessionalAccessIds: validAccessRows
      .filter(
        (access) =>
          (access.sectorId === null ||
            hospitalSectorIds.has(access.sectorId)) &&
          !membershipByProfessional.has(access.professionalId),
      )
      .map((access) => access.id),
    activeManagerScopes: validManagerRows
      .filter(
        (scopeRow) =>
          scopeRow.sectorId === null || sectorIds.has(scopeRow.sectorId),
      )
      .map((scopeRow) => ({
        id: scopeRow.id,
        managerProfessionalId: scopeRow.managerProfessionalId,
        sectorId: scopeRow.sectorId,
      })),
    invalidManagerScopeIds: managerRows
      .filter(
        (scopeRow) =>
          scopeRow.institutionId !== scope.institutionId ||
          scopeRow.hospitalId !== scope.hospitalId ||
          (scopeRow.sectorId !== null &&
            !hospitalSectorIds.has(scopeRow.sectorId)),
      )
      .map((scopeRow) => scopeRow.id),
    staleManagerScopeIds: validManagerRows
      .filter(
        (scopeRow) =>
          (scopeRow.sectorId === null ||
            hospitalSectorIds.has(scopeRow.sectorId)) &&
          !isOperationalManager(
            membershipByProfessional.get(scopeRow.managerProfessionalId),
          ),
      )
      .map((scopeRow) => scopeRow.id),
    activeAssignments: assignmentRows
      .filter((assignment) => {
        const shift = validShiftsById.get(assignment.shiftInstanceId);
        return (
          assignment.institutionId === scope.institutionId &&
          assignment.hospitalId === scope.hospitalId &&
          Boolean(shift) &&
          shift?.sectorId === assignment.sectorId
        );
      })
      .map((assignment) => ({
        id: assignment.id,
        shiftInstanceId: assignment.shiftInstanceId,
        professionalId: assignment.professionalId,
        sectorId: assignment.sectorId,
        status: assignment.status,
      })),
    invalidAssignmentIds: assignmentRows
      .filter((assignment) => {
        const shift = validShiftsById.get(assignment.shiftInstanceId);
        return (
          assignment.institutionId !== scope.institutionId ||
          assignment.hospitalId !== scope.hospitalId ||
          !shift ||
          shift.sectorId !== assignment.sectorId
        );
      })
      .map((assignment) => assignment.id),
    usersWithPushTokens: uniqueNumberIds(
      tokenRows.map((token) => token.userId),
    ),
  });
}

export function visibleSectorIdsForActor(
  report: CorporateReadinessReportV1,
  actor: TenantActor,
  scopes: readonly { hospitalId: number; sectorId: number | null }[],
): number[] {
  if (actor.isGlobalAdmin || actor.roleInInstitution === "GESTOR_PLUS") {
    return report.sectors.map((sector) => sector.sectorId);
  }
  return report.sectors
    .filter((sector) =>
      scopes.some(
        (scope) =>
          scope.hospitalId === report.scope.hospitalId &&
          (scope.sectorId === null || scope.sectorId === sector.sectorId),
      ),
    )
    .map((sector) => sector.sectorId);
}
