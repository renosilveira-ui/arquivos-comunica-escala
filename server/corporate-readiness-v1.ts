import { createHash } from "node:crypto";
import { and, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";
import {
  managerScope,
  monthlyRosters,
  professionalAccess,
  professionalInstitutions,
  professionals,
  pushTokens,
  scheduleContexts,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  shiftTemplates,
  users,
} from "../drizzle/schema";
import { monthWindowBrt } from "./local-time";
import {
  isSectorServiceSpecialtiesTableMissing,
  loadSectorServiceSpecialtiesByTopology,
} from "./sector-service-specialties";
import type { getDb } from "./db";

/**
 * Relatório administrativo de prontidão corporativa. Esta V1 é somente
 * leitura: não reconhece ciência do gestor, não bloqueia publicação e não
 * aciona nenhum canal de notificação.
 */
export const CORPORATE_READINESS_REPORT_VERSION = "v1" as const;

export const CORPORATE_READINESS_SEVERITIES = [
  "SECURITY_BLOCKER",
  "OPERATIONAL_WARNING",
  "INFO",
] as const;

export type CorporateReadinessSeverity =
  (typeof CORPORATE_READINESS_SEVERITIES)[number];

export type CorporateReadinessScope = Readonly<{
  institutionId: number;
  hospitalId: number;
  sectorId?: number;
  yearMonth: string;
}>;

export type CorporateReadinessIssue = Readonly<{
  code: string;
  severity: CorporateReadinessSeverity;
  scope: Readonly<{
    institutionId: number;
    hospitalId: number;
    sectorId?: number;
  }>;
}>;

export type SectorReadinessMetricsV1 = Readonly<{
  activeScheduleContextCount: number;
  resolvedActiveTemplateCount: number;
  calendarMonthShiftCount: number;
  vacantShiftCount: number;
  pendingShiftCount: number;
  allocatedShiftCount: number;
  activeManagerCount: number;
  /**
   * Pessoas que a porta de alocação atual pode cobrir por GESTOR_PLUS,
   * manager_scope ou professional_access. Não consulta especialidade,
   * qualificação ou texto livre do plantão.
   */
  activeProfessionalCoverageCount: number;
  allocatedProfessionalCount: number;
  allocatedProfessionalsWithPushTokenCount: number;
  confirmationCompatibleShiftCount: number;
  serviceSpecialtyCount: number;
}>;

export type SectorReadinessV1 = Readonly<{
  sectorId: number;
  sectorName: string;
  metrics: SectorReadinessMetricsV1;
  issues: readonly CorporateReadinessIssue[];
}>;

export type CorporateReadinessSummary = Readonly<
  Record<CorporateReadinessSeverity, number>
>;

export type CorporateReadinessReportV1 = Readonly<{
  version: typeof CORPORATE_READINESS_REPORT_VERSION;
  scope: CorporateReadinessScope;
  rosterStatus: "DRAFT" | "PUBLISHED" | "LOCKED";
  generatedAt: string;
  snapshotHash: string;
  summary: CorporateReadinessSummary;
  hospitalIssues: readonly CorporateReadinessIssue[];
  sectors: readonly SectorReadinessV1[];
  integrations: Readonly<{
    /** A relação descritiva setor ↔ especialidade está disponível neste ambiente. */
    serviceSpecialties: "AVAILABLE" | "MIGRATION_PENDING";
    /** A fundação existe, mas ainda não há writer/worker de e-mail ativado. */
    emailTrust: "NOT_ACTIVATED";
  }>;
  /** A ciência auditada só será adicionada junto ao bloqueio transacional de publicação. */
  acknowledgement: Readonly<{ supported: false }>;
}>;

type ReadinessDb = Pick<
  NonNullable<Awaited<ReturnType<typeof getDb>>>,
  "select"
>;

type ReadinessMembership = Readonly<{
  professionalId: number;
  userId: number;
  roleInInstitution: "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";
}>;

type ReadinessScheduleContext = Readonly<{
  id: number;
  sectorId: number;
  active: boolean;
}>;

type ReadinessSource = Readonly<{
  scope: CorporateReadinessScope;
  rosterStatus: "DRAFT" | "PUBLISHED" | "LOCKED";
  sectors: readonly { id: number; name: string }[];
  scheduleContexts: readonly ReadinessScheduleContext[];
  activeTemplates: readonly { id: number; sectorId: number | null }[];
  shifts: readonly {
    id: number;
    sectorId: number;
    scheduleContextId: number | null;
    status: string;
    startAt: Date;
    endAt: Date;
  }[];
  memberships: readonly ReadinessMembership[];
  activeProfessionalAccesses: readonly {
    id: number;
    professionalId: number;
    sectorId: number | null;
  }[];
  activeManagerScopes: readonly {
    id: number;
    managerProfessionalId: number;
    sectorId: number | null;
  }[];
  activeAssignments: readonly {
    id: number;
    shiftInstanceId: number;
    professionalId: number;
    sectorId: number;
    status: string;
  }[];
  usersWithPushTokens: readonly number[];
  topology: Readonly<{
    invalidScheduleContextIds: readonly number[];
    invalidTemplateIds: readonly number[];
    invalidShiftIds: readonly number[];
    invalidProfessionalAccessIds: readonly number[];
    invalidManagerScopeIds: readonly number[];
    invalidAssignmentIds: readonly number[];
  }>;
  stale: Readonly<{
    professionalAccessIds: readonly number[];
    managerScopeIds: readonly number[];
  }>;
  serviceSpecialties: Readonly<{
    availability: "AVAILABLE" | "MIGRATION_PENDING";
    /** Apenas IDs de catálogo: a relação não altera elegibilidade. */
    medicalSpecialtyIdsBySector: ReadonlyMap<number, readonly number[]>;
  }>;
}>;

const CONFIRMATION_START_MINUTES = [7 * 60, 13 * 60, 19 * 60] as const;
const CONFIRMATION_TOLERANCE_MINUTES = 30;

function emptySummary(): Record<CorporateReadinessSeverity, number> {
  return {
    SECURITY_BLOCKER: 0,
    OPERATIONAL_WARNING: 0,
    INFO: 0,
  };
}

function numericAscending(left: number, right: number): number {
  return left - right;
}

function compareCanonicalStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function uniquePositiveIntegers(values: Iterable<number>): number[] {
  return [...new Set(values)].filter(
    (value) => Number.isSafeInteger(value) && value > 0,
  );
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareCanonicalStrings)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function hashSnapshot(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function dateIso(value: Date): string {
  const time = value.getTime();
  if (!Number.isFinite(time)) {
    throw new Error("CORPORATE_READINESS_INVALID_SHIFT_TIME");
  }
  return value.toISOString();
}

function hospitalClockMinutes(value: Date): number {
  const wallClock = new Date(value.getTime() - 3 * 60 * 60 * 1000);
  return wallClock.getUTCHours() * 60 + wallClock.getUTCMinutes();
}

/** A dispatcher atual aceita o início exato ou até 30 min de tolerância. */
export function isCurrentConfirmationCompatibleStart(value: Date): boolean {
  const start = hospitalClockMinutes(value);
  return CONFIRMATION_START_MINUTES.some(
    (expected) => Math.abs(start - expected) <= CONFIRMATION_TOLERANCE_MINUTES,
  );
}

function buildSnapshotFingerprint(source: ReadinessSource) {
  return {
    scope: source.scope,
    rosterStatus: source.rosterStatus,
    sectors: source.sectors.map((sector) => sector.id).sort(numericAscending),
    scheduleContexts: source.scheduleContexts
      .map((context) => ({
        id: context.id,
        sectorId: context.sectorId,
        active: context.active,
      }))
      .sort((left, right) => left.id - right.id),
    activeTemplates: source.activeTemplates
      .map((template) => ({ id: template.id, sectorId: template.sectorId }))
      .sort((left, right) => left.id - right.id),
    shifts: source.shifts
      .map((shift) => ({
        id: shift.id,
        sectorId: shift.sectorId,
        scheduleContextId: shift.scheduleContextId,
        status: shift.status,
        startAt: dateIso(shift.startAt),
        endAt: dateIso(shift.endAt),
      }))
      .sort((left, right) => left.id - right.id),
    memberships: source.memberships
      .map((membership) => ({
        professionalId: membership.professionalId,
        userId: membership.userId,
        roleInInstitution: membership.roleInInstitution,
      }))
      .sort(
        (left, right) =>
          left.professionalId - right.professionalId ||
          left.userId - right.userId,
      ),
    professionalAccesses: source.activeProfessionalAccesses
      .map((access) => ({
        id: access.id,
        professionalId: access.professionalId,
        sectorId: access.sectorId,
      }))
      .sort((left, right) => left.id - right.id),
    managerScopes: source.activeManagerScopes
      .map((scope) => ({
        id: scope.id,
        professionalId: scope.managerProfessionalId,
        sectorId: scope.sectorId,
      }))
      .sort((left, right) => left.id - right.id),
    assignments: source.activeAssignments
      .map((assignment) => ({
        id: assignment.id,
        shiftInstanceId: assignment.shiftInstanceId,
        professionalId: assignment.professionalId,
        sectorId: assignment.sectorId,
        status: assignment.status,
      }))
      .sort((left, right) => left.id - right.id),
    usersWithPushTokens: uniquePositiveIntegers(
      source.usersWithPushTokens,
    ).sort(numericAscending),
    topology: Object.fromEntries(
      Object.entries(source.topology).map(([key, values]) => [
        key,
        uniquePositiveIntegers(values).sort(numericAscending),
      ]),
    ),
    stale: Object.fromEntries(
      Object.entries(source.stale).map(([key, values]) => [
        key,
        uniquePositiveIntegers(values).sort(numericAscending),
      ]),
    ),
    serviceSpecialties: {
      availability: source.serviceSpecialties.availability,
      medicalSpecialtyIdsBySector: [
        ...source.serviceSpecialties.medicalSpecialtyIdsBySector,
      ]
        .map(([sectorId, specialtyIds]) => ({
          sectorId,
          medicalSpecialtyIds:
            uniquePositiveIntegers(specialtyIds).sort(numericAscending),
        }))
        .sort((left, right) => left.sectorId - right.sectorId),
    },
  };
}

function addTopologyIssues(
  source: ReadinessSource,
  addIssue: (
    code: string,
    severity: CorporateReadinessSeverity,
    sectorId?: number,
  ) => void,
): void {
  const cases: readonly [readonly number[], string][] = [
    [
      source.topology.invalidScheduleContextIds,
      "INVALID_SCHEDULE_CONTEXT_TOPOLOGY",
    ],
    [source.topology.invalidTemplateIds, "INVALID_SHIFT_TEMPLATE_TOPOLOGY"],
    [source.topology.invalidShiftIds, "INVALID_SHIFT_TOPOLOGY"],
    [
      source.topology.invalidProfessionalAccessIds,
      "INVALID_PROFESSIONAL_ACCESS_TOPOLOGY",
    ],
    [source.topology.invalidManagerScopeIds, "INVALID_MANAGER_SCOPE_TOPOLOGY"],
    [source.topology.invalidAssignmentIds, "INVALID_ASSIGNMENT_TOPOLOGY"],
  ];
  for (const [ids, code] of cases) {
    if (ids.length > 0) addIssue(code, "SECURITY_BLOCKER");
  }
}

/**
 * Projeta o relatório a partir de uma fonte já limitada ao escopo autorizado.
 * Este motor não recebe nem consulta a especialidade profissional, pois a
 * especialidade assistencial é metadado descritivo, não regra de elegibilidade.
 */
export function buildCorporateReadinessReport(
  source: ReadinessSource,
  generatedAt = new Date().toISOString(),
): CorporateReadinessReportV1 {
  const sectorsById = new Map(
    source.sectors.map((sector) => [sector.id, sector]),
  );
  const membershipByProfessional = new Map(
    source.memberships.map((membership) => [
      membership.professionalId,
      membership,
    ]),
  );
  const pushUserIds = new Set(source.usersWithPushTokens);
  const contextById = new Map(
    source.scheduleContexts.map((context) => [context.id, context]),
  );
  const assignmentsByShift = new Map<
    number,
    (typeof source.activeAssignments)[number][]
  >();
  for (const assignment of source.activeAssignments) {
    const entries = assignmentsByShift.get(assignment.shiftInstanceId) ?? [];
    entries.push(assignment);
    assignmentsByShift.set(assignment.shiftInstanceId, entries);
  }

  const issueByKey = new Map<string, CorporateReadinessIssue>();
  const addIssue = (
    code: string,
    severity: CorporateReadinessSeverity,
    sectorId?: number,
  ) => {
    const key = `${severity}:${code}:${sectorId ?? "hospital"}`;
    if (issueByKey.has(key)) return;
    issueByKey.set(key, {
      code,
      severity,
      scope: {
        institutionId: source.scope.institutionId,
        hospitalId: source.scope.hospitalId,
        ...(sectorId === undefined ? {} : { sectorId }),
      },
    });
  };

  if (source.sectors.length === 0) {
    addIssue("NO_SECTORS_CONFIGURED", "OPERATIONAL_WARNING");
  }
  addTopologyIssues(source, addIssue);
  if (source.stale.professionalAccessIds.length > 0) {
    addIssue("STALE_PROFESSIONAL_ACCESS", "OPERATIONAL_WARNING");
  }
  if (source.stale.managerScopeIds.length > 0) {
    addIssue("STALE_MANAGER_SCOPE", "OPERATIONAL_WARNING");
  }
  // A fundação de confiança foi criada, mas ainda não existe writer nem worker
  // de e-mail. O relatório não pode prometer entrega confiável antes disso.
  addIssue("EMAIL_TRUST_NOT_ACTIVATED", "INFO");

  const validAccesses = source.activeProfessionalAccesses.filter(
    (access) =>
      (access.sectorId === null || sectorsById.has(access.sectorId)) &&
      membershipByProfessional.has(access.professionalId),
  );
  const validManagerScopes = source.activeManagerScopes.filter((scope) => {
    const membership = membershipByProfessional.get(
      scope.managerProfessionalId,
    );
    return (
      (scope.sectorId === null || sectorsById.has(scope.sectorId)) &&
      membership?.roleInInstitution === "GESTOR_MEDICO"
    );
  });
  const gestorPlusProfessionalIds = new Set(
    source.memberships
      .filter((membership) => membership.roleInInstitution === "GESTOR_PLUS")
      .map((membership) => membership.professionalId),
  );

  const sectorReports: SectorReadinessV1[] = source.sectors
    .slice()
    .sort((left, right) => left.id - right.id)
    .map((sector) => {
      const sectorContexts = source.scheduleContexts.filter(
        (context) => context.sectorId === sector.id && context.active,
      );
      const sectorSpecificTemplates = source.activeTemplates.filter(
        (template) => template.sectorId === sector.id,
      );
      const hospitalTemplates = source.activeTemplates.filter(
        (template) => template.sectorId === null,
      );
      const resolvedTemplates =
        sectorSpecificTemplates.length > 0
          ? sectorSpecificTemplates
          : hospitalTemplates;
      const sectorShifts = source.shifts.filter(
        (shift) => shift.sectorId === sector.id,
      );
      const managerProfessionalIds = new Set([
        ...gestorPlusProfessionalIds,
        ...validManagerScopes
          .filter(
            (scope) => scope.sectorId === null || scope.sectorId === sector.id,
          )
          .map((scope) => scope.managerProfessionalId),
      ]);
      const professionalCoverageIds = new Set([
        ...managerProfessionalIds,
        ...validAccesses
          .filter(
            (access) =>
              access.sectorId === null || access.sectorId === sector.id,
          )
          .map((access) => access.professionalId),
      ]);
      const allocatedProfessionalIds = new Set<number>();
      let allocatedShiftCount = 0;
      let pendingShiftCount = 0;

      if (sectorContexts.length === 0) {
        addIssue(
          "MISSING_ACTIVE_SCHEDULE_CONTEXT",
          "OPERATIONAL_WARNING",
          sector.id,
        );
      }
      if (resolvedTemplates.length === 0) {
        addIssue(
          "MISSING_ACTIVE_SHIFT_TEMPLATE",
          "OPERATIONAL_WARNING",
          sector.id,
        );
      }
      if (sectorShifts.length === 0) {
        addIssue("NO_CALENDAR_FOR_MONTH", "INFO", sector.id);
      }
      if (managerProfessionalIds.size === 0) {
        addIssue(
          "NO_ACTIVE_MANAGER_COVERAGE",
          "OPERATIONAL_WARNING",
          sector.id,
        );
      }
      if (professionalCoverageIds.size === 0) {
        addIssue("NO_ACTIVE_PROFESSIONAL_COVERAGE", "INFO", sector.id);
      }

      const serviceSpecialtyIds =
        source.serviceSpecialties.medicalSpecialtyIdsBySector.get(sector.id) ??
        [];
      if (source.serviceSpecialties.availability === "MIGRATION_PENDING") {
        addIssue(
          "SERVICE_SPECIALTY_METADATA_MIGRATION_PENDING",
          "INFO",
          sector.id,
        );
      } else if (serviceSpecialtyIds.length === 0) {
        addIssue("SERVICE_SPECIALTY_METADATA_PENDING", "INFO", sector.id);
      }

      for (const shift of sectorShifts) {
        const assignments = assignmentsByShift.get(shift.id) ?? [];
        const occupiedAssignments = assignments.filter(
          (assignment) => assignment.status === "OCUPADO",
        );
        const allocatedMembers = occupiedAssignments
          .map((assignment) =>
            membershipByProfessional.get(assignment.professionalId),
          )
          .filter((membership): membership is ReadinessMembership =>
            Boolean(membership),
          );
        if (allocatedMembers.length > 0) {
          allocatedShiftCount += 1;
          for (const membership of allocatedMembers) {
            allocatedProfessionalIds.add(membership.professionalId);
          }
        }
        if (
          shift.status === "PENDENTE" ||
          assignments.some((assignment) => assignment.status === "PENDENTE")
        ) {
          pendingShiftCount += 1;
          addIssue(
            "PENDING_ALLOCATION_REQUIRES_REVIEW",
            "OPERATIONAL_WARNING",
            sector.id,
          );
        }
        if (
          assignments.some(
            (assignment) =>
              !membershipByProfessional.has(assignment.professionalId),
          )
        ) {
          addIssue(
            "ASSIGNED_PROFESSIONAL_MEMBERSHIP_NOT_ACTIVE",
            "OPERATIONAL_WARNING",
            sector.id,
          );
        }
        if (
          assignments.some(
            (assignment) =>
              assignment.status !== "OCUPADO" &&
              assignment.status !== "PENDENTE",
          )
        ) {
          addIssue(
            "ASSIGNMENT_STATUS_REQUIRES_REVIEW",
            "OPERATIONAL_WARNING",
            sector.id,
          );
        }

        if (shift.status === "VAGO") {
          addIssue(
            "VACANT_SHIFT_REQUIRES_ALLOCATION",
            "OPERATIONAL_WARNING",
            sector.id,
          );
        } else if (
          shift.status === "OCUPADO" &&
          allocatedMembers.length === 0
        ) {
          addIssue(
            "OCCUPIED_SHIFT_WITHOUT_ACTIVE_ASSIGNMENT",
            "OPERATIONAL_WARNING",
            sector.id,
          );
        } else if (shift.status !== "OCUPADO" && shift.status !== "PENDENTE") {
          addIssue(
            "SHIFT_STATUS_REQUIRES_REVIEW",
            "OPERATIONAL_WARNING",
            sector.id,
          );
        }

        if (shift.scheduleContextId === null) {
          addIssue(
            "UNCLASSIFIED_SHIFT_CONTEXT",
            "OPERATIONAL_WARNING",
            sector.id,
          );
        } else {
          const context = contextById.get(shift.scheduleContextId);
          if (!context || context.sectorId !== sector.id) {
            addIssue(
              "INVALID_SHIFT_CONTEXT_REFERENCE",
              "SECURITY_BLOCKER",
              sector.id,
            );
          } else if (!context.active) {
            addIssue(
              "INACTIVE_SHIFT_CONTEXT",
              "OPERATIONAL_WARNING",
              sector.id,
            );
          }
        }
        if (!isCurrentConfirmationCompatibleStart(shift.startAt)) {
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
      const allocatedProfessionalsWithPushTokenCount =
        allocatedMemberships.filter((membership) =>
          pushUserIds.has(membership.userId),
        ).length;
      if (
        allocatedMemberships.length > allocatedProfessionalsWithPushTokenCount
      ) {
        addIssue(
          "PUSH_DELIVERY_COVERAGE_PARTIAL",
          "OPERATIONAL_WARNING",
          sector.id,
        );
      }

      return {
        sectorId: sector.id,
        sectorName: sector.name,
        metrics: {
          activeScheduleContextCount: sectorContexts.length,
          resolvedActiveTemplateCount: resolvedTemplates.length,
          calendarMonthShiftCount: sectorShifts.length,
          vacantShiftCount: sectorShifts.filter(
            (shift) => shift.status === "VAGO",
          ).length,
          pendingShiftCount,
          allocatedShiftCount,
          activeManagerCount: managerProfessionalIds.size,
          activeProfessionalCoverageCount: professionalCoverageIds.size,
          allocatedProfessionalCount: allocatedMemberships.length,
          allocatedProfessionalsWithPushTokenCount,
          confirmationCompatibleShiftCount: sectorShifts.filter((shift) =>
            isCurrentConfirmationCompatibleStart(shift.startAt),
          ).length,
          serviceSpecialtyCount: serviceSpecialtyIds.length,
        },
        issues: [],
      };
    });

  const allIssues = [...issueByKey.values()].sort(
    (left, right) =>
      (left.scope.sectorId ?? 0) - (right.scope.sectorId ?? 0) ||
      compareCanonicalStrings(left.severity, right.severity) ||
      compareCanonicalStrings(left.code, right.code),
  );
  const issuesBySector = new Map<number, CorporateReadinessIssue[]>();
  for (const issue of allIssues) {
    if (issue.scope.sectorId === undefined) continue;
    const issues = issuesBySector.get(issue.scope.sectorId) ?? [];
    issues.push(issue);
    issuesBySector.set(issue.scope.sectorId, issues);
  }
  const sectorsWithIssues = sectorReports.map((sector) => ({
    ...sector,
    issues: issuesBySector.get(sector.sectorId) ?? [],
  }));
  const summary = emptySummary();
  for (const issue of allIssues) summary[issue.severity] += 1;

  return {
    version: CORPORATE_READINESS_REPORT_VERSION,
    scope: source.scope,
    rosterStatus: source.rosterStatus,
    generatedAt,
    snapshotHash: hashSnapshot(buildSnapshotFingerprint(source)),
    summary,
    hospitalIssues: allIssues.filter(
      (issue) => issue.scope.sectorId === undefined,
    ),
    sectors: sectorsWithIssues,
    integrations: {
      serviceSpecialties: source.serviceSpecialties.availability,
      emailTrust: "NOT_ACTIVATED",
    },
    acknowledgement: { supported: false },
  };
}

function rowBelongsToHospitalTopology(
  row: { institutionId: number; hospitalId: number; sectorId: number | null },
  scope: CorporateReadinessScope,
  hospitalSectorIds: ReadonlySet<number>,
): boolean {
  return (
    row.institutionId === scope.institutionId &&
    row.hospitalId === scope.hospitalId &&
    (row.sectorId === null || hospitalSectorIds.has(row.sectorId))
  );
}

async function loadRelevantMemberships(
  db: ReadinessDb,
  institutionId: number,
  relevantProfessionalIds: readonly number[],
): Promise<ReadinessMembership[]> {
  const relevant = uniquePositiveIntegers(relevantProfessionalIds);
  const membershipPredicate =
    relevant.length > 0
      ? or(
          eq(professionalInstitutions.roleInInstitution, "GESTOR_PLUS"),
          inArray(professionalInstitutions.professionalId, relevant),
        )
      : eq(professionalInstitutions.roleInInstitution, "GESTOR_PLUS");
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
        membershipPredicate,
      ),
    );
  if (membershipRows.length === 0) return [];

  const professionalIds = uniquePositiveIntegers(
    membershipRows.map((membership) => membership.professionalId),
  );
  const userIds = uniquePositiveIntegers(
    membershipRows.map((membership) => membership.userId),
  );
  const professionalRows = await db
    .select({ id: professionals.id, userId: professionals.userId })
    .from(professionals)
    .where(inArray(professionals.id, professionalIds));
  const userRows = await db
    .select({
      id: users.id,
      approvalStatus: users.approvalStatus,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(inArray(users.id, userIds));
  const professionalUserIdById = new Map(
    professionalRows.map((professional) => [
      professional.id,
      professional.userId,
    ]),
  );
  const activeUserIds = new Set(
    userRows
      .filter(
        (user) => user.approvalStatus === "APPROVED" && user.deletedAt === null,
      )
      .map((user) => user.id),
  );

  return membershipRows
    .filter(
      (membership) =>
        professionalUserIdById.get(membership.professionalId) ===
          membership.userId && activeUserIds.has(membership.userId),
    )
    .map((membership) => ({
      professionalId: membership.professionalId,
      userId: membership.userId,
      roleInInstitution: membership.roleInInstitution,
    }));
}

async function loadServiceSpecialtyMetadata(
  db: ReadinessDb,
  scope: CorporateReadinessScope,
  selectedSectors: readonly { id: number; name: string }[],
): Promise<ReadinessSource["serviceSpecialties"]> {
  try {
    const rows = await loadSectorServiceSpecialtiesByTopology(
      db,
      selectedSectors.map((sector) => ({
        institutionId: scope.institutionId,
        hospitalId: scope.hospitalId,
        sectorId: sector.id,
      })),
    );
    return {
      availability: "AVAILABLE",
      medicalSpecialtyIdsBySector: new Map(
        selectedSectors.map((sector) => [
          sector.id,
          (
            rows.get(
              `${scope.institutionId}:${scope.hospitalId}:${sector.id}`,
            ) ?? []
          ).map((specialty) => specialty.medicalSpecialtyId),
        ]),
      ),
    };
  } catch (error) {
    if (!isSectorServiceSpecialtiesTableMissing(error)) throw error;
    return {
      availability: "MIGRATION_PENDING",
      medicalSpecialtyIdsBySector: new Map(),
    };
  }
}

/**
 * Carrega apenas dados do hospital/setor autorizado. A consulta ainda procura
 * referências que usam o mesmo setor com instituição/hospital divergente para
 * conseguir expor corrupção topológica como SECURITY_BLOCKER, sem abrir a
 * cardinalidade de outros setores para um gestor setorial.
 */
async function loadCorporateReadinessSource(
  db: ReadinessDb,
  scope: CorporateReadinessScope,
): Promise<ReadinessSource> {
  const allHospitalSectors = await db
    .select({ id: sectors.id, name: sectors.name })
    .from(sectors)
    .where(
      and(
        eq(sectors.institutionId, scope.institutionId),
        eq(sectors.hospitalId, scope.hospitalId),
      ),
    );
  const selectedSectors =
    scope.sectorId === undefined
      ? allHospitalSectors
      : allHospitalSectors.filter((sector) => sector.id === scope.sectorId);
  const selectedSectorIds = uniquePositiveIntegers(
    selectedSectors.map((sector) => sector.id),
  );
  const hospitalSectorIds = new Set(
    allHospitalSectors.map((sector) => sector.id),
  );
  const selectedSectorIdSet = new Set(selectedSectorIds);
  const contextScopePredicate =
    scope.sectorId !== undefined
      ? eq(scheduleContexts.sectorId, scope.sectorId)
      : selectedSectorIds.length > 0
        ? or(
            eq(scheduleContexts.hospitalId, scope.hospitalId),
            inArray(scheduleContexts.sectorId, selectedSectorIds),
          )
        : eq(scheduleContexts.hospitalId, scope.hospitalId);
  const templateScopePredicate =
    scope.sectorId !== undefined
      ? or(
          eq(shiftTemplates.sectorId, scope.sectorId),
          and(
            eq(shiftTemplates.hospitalId, scope.hospitalId),
            isNull(shiftTemplates.sectorId),
          ),
        )
      : selectedSectorIds.length > 0
        ? or(
            eq(shiftTemplates.hospitalId, scope.hospitalId),
            inArray(shiftTemplates.sectorId, selectedSectorIds),
          )
        : eq(shiftTemplates.hospitalId, scope.hospitalId);
  const shiftScopePredicate =
    scope.sectorId !== undefined
      ? eq(shiftInstances.sectorId, scope.sectorId)
      : selectedSectorIds.length > 0
        ? or(
            eq(shiftInstances.hospitalId, scope.hospitalId),
            inArray(shiftInstances.sectorId, selectedSectorIds),
          )
        : eq(shiftInstances.hospitalId, scope.hospitalId);
  const accessScopePredicate =
    scope.sectorId !== undefined
      ? or(
          eq(professionalAccess.sectorId, scope.sectorId),
          and(
            eq(professionalAccess.hospitalId, scope.hospitalId),
            isNull(professionalAccess.sectorId),
          ),
        )
      : selectedSectorIds.length > 0
        ? or(
            eq(professionalAccess.hospitalId, scope.hospitalId),
            inArray(professionalAccess.sectorId, selectedSectorIds),
          )
        : eq(professionalAccess.hospitalId, scope.hospitalId);
  const managerScopePredicate =
    scope.sectorId !== undefined
      ? or(
          eq(managerScope.sectorId, scope.sectorId),
          and(
            eq(managerScope.hospitalId, scope.hospitalId),
            isNull(managerScope.sectorId),
          ),
        )
      : selectedSectorIds.length > 0
        ? or(
            eq(managerScope.hospitalId, scope.hospitalId),
            inArray(managerScope.sectorId, selectedSectorIds),
          )
        : eq(managerScope.hospitalId, scope.hospitalId);
  const month = monthWindowBrt(scope.yearMonth);

  const contextRows = await db
    .select({
      id: scheduleContexts.id,
      institutionId: scheduleContexts.institutionId,
      hospitalId: scheduleContexts.hospitalId,
      sectorId: scheduleContexts.sectorId,
      active: scheduleContexts.active,
    })
    .from(scheduleContexts)
    .where(contextScopePredicate);
  const templateRows = await db
    .select({
      id: shiftTemplates.id,
      institutionId: shiftTemplates.institutionId,
      hospitalId: shiftTemplates.hospitalId,
      sectorId: shiftTemplates.sectorId,
      active: shiftTemplates.isActive,
    })
    .from(shiftTemplates)
    .where(templateScopePredicate);
  const shiftRows = await db
    .select({
      id: shiftInstances.id,
      institutionId: shiftInstances.institutionId,
      hospitalId: shiftInstances.hospitalId,
      sectorId: shiftInstances.sectorId,
      scheduleContextId: shiftInstances.scheduleContextId,
      status: shiftInstances.status,
      startAt: shiftInstances.startAt,
      endAt: shiftInstances.endAt,
    })
    .from(shiftInstances)
    .where(
      and(
        shiftScopePredicate,
        gte(shiftInstances.startAt, month.start),
        lt(shiftInstances.startAt, month.end),
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
  const accessRows = await db
    .select({
      id: professionalAccess.id,
      institutionId: professionalAccess.institutionId,
      hospitalId: professionalAccess.hospitalId,
      professionalId: professionalAccess.professionalId,
      sectorId: professionalAccess.sectorId,
    })
    .from(professionalAccess)
    .where(and(eq(professionalAccess.canAccess, true), accessScopePredicate));
  const managerRows = await db
    .select({
      id: managerScope.id,
      institutionId: managerScope.institutionId,
      hospitalId: managerScope.hospitalId,
      managerProfessionalId: managerScope.managerProfessionalId,
      sectorId: managerScope.sectorId,
    })
    .from(managerScope)
    .where(and(eq(managerScope.active, true), managerScopePredicate));

  const validContexts = contextRows.filter(
    (row) =>
      rowBelongsToHospitalTopology(row, scope, hospitalSectorIds) &&
      selectedSectorIdSet.has(row.sectorId),
  );
  const validTemplates = templateRows.filter(
    (row) =>
      row.active &&
      rowBelongsToHospitalTopology(row, scope, hospitalSectorIds) &&
      (row.sectorId === null || selectedSectorIdSet.has(row.sectorId)),
  );
  const validShifts = shiftRows.filter(
    (row) =>
      rowBelongsToHospitalTopology(row, scope, hospitalSectorIds) &&
      selectedSectorIdSet.has(row.sectorId),
  );
  const validAccesses = accessRows.filter(
    (row) =>
      rowBelongsToHospitalTopology(row, scope, hospitalSectorIds) &&
      (row.sectorId === null || selectedSectorIdSet.has(row.sectorId)),
  );
  const validManagerScopes = managerRows.filter(
    (row) =>
      rowBelongsToHospitalTopology(row, scope, hospitalSectorIds) &&
      (row.sectorId === null || selectedSectorIdSet.has(row.sectorId)),
  );
  const validShiftById = new Map(validShifts.map((shift) => [shift.id, shift]));
  const validShiftIds = uniquePositiveIntegers(
    validShifts.map((shift) => shift.id),
  );
  const assignmentRows =
    validShiftIds.length === 0
      ? []
      : await db
          .select({
            id: shiftAssignmentsV2.id,
            institutionId: shiftAssignmentsV2.institutionId,
            hospitalId: shiftAssignmentsV2.hospitalId,
            shiftInstanceId: shiftAssignmentsV2.shiftInstanceId,
            professionalId: shiftAssignmentsV2.professionalId,
            sectorId: shiftAssignmentsV2.sectorId,
            status: shiftAssignmentsV2.status,
          })
          .from(shiftAssignmentsV2)
          .where(
            and(
              eq(shiftAssignmentsV2.isActive, true),
              inArray(shiftAssignmentsV2.shiftInstanceId, validShiftIds),
            ),
          );
  const validAssignments = assignmentRows.filter((row) => {
    const shift = validShiftById.get(row.shiftInstanceId);
    return (
      row.institutionId === scope.institutionId &&
      row.hospitalId === scope.hospitalId &&
      shift !== undefined &&
      shift.sectorId === row.sectorId
    );
  });
  const memberships = await loadRelevantMemberships(db, scope.institutionId, [
    ...validAccesses.map((access) => access.professionalId),
    ...validManagerScopes.map((manager) => manager.managerProfessionalId),
    ...validAssignments.map((assignment) => assignment.professionalId),
  ]);
  const membershipByProfessional = new Map(
    memberships.map((membership) => [membership.professionalId, membership]),
  );
  const allocatedUserIds = uniquePositiveIntegers(
    validAssignments
      .filter((assignment) => assignment.status === "OCUPADO")
      .map(
        (assignment) =>
          membershipByProfessional.get(assignment.professionalId)?.userId,
      )
      .filter((userId): userId is number => userId !== undefined),
  );
  const tokenRows =
    allocatedUserIds.length === 0
      ? []
      : await db
          .select({ userId: pushTokens.userId })
          .from(pushTokens)
          .where(inArray(pushTokens.userId, allocatedUserIds));
  const serviceSpecialties = await loadServiceSpecialtyMetadata(
    db,
    scope,
    selectedSectors,
  );

  return {
    scope,
    rosterStatus: (rosterRows[0]?.status ?? "DRAFT") as
      "DRAFT" | "PUBLISHED" | "LOCKED",
    sectors: selectedSectors,
    scheduleContexts: validContexts.map((context) => ({
      id: context.id,
      sectorId: context.sectorId,
      active: context.active,
    })),
    activeTemplates: validTemplates.map((template) => ({
      id: template.id,
      sectorId: template.sectorId,
    })),
    shifts: validShifts.map((shift) => ({
      id: shift.id,
      sectorId: shift.sectorId,
      scheduleContextId: shift.scheduleContextId,
      status: shift.status,
      startAt: shift.startAt,
      endAt: shift.endAt,
    })),
    memberships,
    activeProfessionalAccesses: validAccesses.map((access) => ({
      id: access.id,
      professionalId: access.professionalId,
      sectorId: access.sectorId,
    })),
    activeManagerScopes: validManagerScopes.map((manager) => ({
      id: manager.id,
      managerProfessionalId: manager.managerProfessionalId,
      sectorId: manager.sectorId,
    })),
    activeAssignments: validAssignments.map((assignment) => ({
      id: assignment.id,
      shiftInstanceId: assignment.shiftInstanceId,
      professionalId: assignment.professionalId,
      sectorId: assignment.sectorId,
      status: assignment.status,
    })),
    usersWithPushTokens: uniquePositiveIntegers(
      tokenRows.map((token) => token.userId),
    ),
    topology: {
      invalidScheduleContextIds: contextRows
        .filter(
          (row) =>
            !rowBelongsToHospitalTopology(row, scope, hospitalSectorIds) ||
            !selectedSectorIdSet.has(row.sectorId),
        )
        .map((row) => row.id),
      invalidTemplateIds: templateRows
        .filter(
          (row) =>
            !rowBelongsToHospitalTopology(row, scope, hospitalSectorIds) ||
            (row.sectorId !== null && !selectedSectorIdSet.has(row.sectorId)),
        )
        .map((row) => row.id),
      invalidShiftIds: shiftRows
        .filter(
          (row) =>
            !rowBelongsToHospitalTopology(row, scope, hospitalSectorIds) ||
            !selectedSectorIdSet.has(row.sectorId),
        )
        .map((row) => row.id),
      invalidProfessionalAccessIds: accessRows
        .filter(
          (row) =>
            !rowBelongsToHospitalTopology(row, scope, hospitalSectorIds) ||
            (row.sectorId !== null && !selectedSectorIdSet.has(row.sectorId)),
        )
        .map((row) => row.id),
      invalidManagerScopeIds: managerRows
        .filter(
          (row) =>
            !rowBelongsToHospitalTopology(row, scope, hospitalSectorIds) ||
            (row.sectorId !== null && !selectedSectorIdSet.has(row.sectorId)),
        )
        .map((row) => row.id),
      invalidAssignmentIds: assignmentRows
        .filter(
          (assignment) =>
            !validAssignments.some((valid) => valid.id === assignment.id),
        )
        .map((assignment) => assignment.id),
    },
    stale: {
      professionalAccessIds: validAccesses
        .filter(
          (access) => !membershipByProfessional.has(access.professionalId),
        )
        .map((access) => access.id),
      managerScopeIds: validManagerScopes
        .filter((manager) => {
          const membership = membershipByProfessional.get(
            manager.managerProfessionalId,
          );
          return (
            membership?.roleInInstitution !== "GESTOR_MEDICO" &&
            membership?.roleInInstitution !== "GESTOR_PLUS"
          );
        })
        .map((manager) => manager.id),
    },
    serviceSpecialties,
  };
}

export async function getCorporateReadinessReport(
  db: ReadinessDb,
  scope: CorporateReadinessScope,
): Promise<CorporateReadinessReportV1> {
  return buildCorporateReadinessReport(
    await loadCorporateReadinessSource(db, scope),
  );
}
