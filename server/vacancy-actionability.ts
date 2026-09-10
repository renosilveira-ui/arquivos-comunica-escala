import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  managerScope,
  professionals,
  scheduleInvites,
} from "../drizzle/schema";
import { rowsFromExecute } from "./_core/db-results";
import { getDb } from "./db";
import { dayWindowBrt } from "./local-time";
import {
  listAssumableScheduleContextIds,
  qualificationMatches,
  selectActiveScheduleContexts,
  type ActiveScheduleContext,
} from "./schedule-contexts";

type VacancyDb = Pick<
  NonNullable<Awaited<ReturnType<typeof getDb>>>,
  "execute" | "select"
>;

/**
 * Shared input contract for every read that describes a vacancy the current
 * actor may actually request. Keep this narrower than managerial summaries:
 * the result is an actionable population, never a roster overview.
 */
export const actionableVacancyFiltersSchema = z.object({
  hospitalId: z.number().int().positive().optional(),
  sectorId: z.number().int().positive().optional(),
  date: z.string().optional(),
  shiftLabel: z.string().nullish(),
  modality: z.enum(["PLANTAO", "SOBREAVISO"]).optional(),
  coverageType: z.enum(["URGENCIA_EMERGENCIA", "ELETIVAS"]).optional(),
});

export type ActionableVacancyFilters = z.infer<
  typeof actionableVacancyFiltersSchema
> & {
  /** Internal-only exact target narrowing for route resolution. */
  shiftInstanceId?: number;
};

export type ActionableVacancyRow = {
  shiftInstanceId: number;
  startAt: Date | string;
  endAt: Date | string;
  label: string;
  status: string;
  modality: "PLANTAO" | "SOBREAVISO";
  coverageType: "URGENCIA_EMERGENCIA" | "ELETIVAS" | null;
  paymentModel:
    | "FIXO"
    | "FIXO_PRODUTIVIDADE_TETO"
    | "FIXO_PRODUTIVIDADE_SEM_TETO"
    | "PRODUTIVIDADE_PURA";
  productivityCapBrl: string | null;
  sectorName: string;
  hospitalName: string;
  hospitalId: number;
  sectorId: number;
  scheduleContextId: number;
  requiredCapacity?: number | null;
  activeCount?: number;
  remainingCapacity?: number;
};

export type ActionableVacancyCounts = {
  total: number;
  vacanciesByHospital: Record<number, number>;
  vacanciesBySector: Record<number, number>;
};

type VacancyActor = {
  userId: number;
  professionalId: number;
  isGlobalAdmin: boolean;
  /**
   * The caller has already been resolved by getTenantActorFromContext, which
   * proves active membership in this institution. Keep the role as a closed
   * value rather than accepting a caller-produced capability boolean.
   */
  roleInInstitution: "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";
};

/**
 * Contextos em que o ator pode *solicitar* a vaga (actionability).
 *
 * Admissão: `listAssumableScheduleContextIds` (ACL/scope) continua sem
 * qualification — é visibilidade topológica, reusada em swaps.
 * GESTOR_PLUS tem admissão tenant-wide; convite nominal pendente também
 * admite. Nenhum desses atalhos é ocupação.
 *
 * Occupancy: o mesmo `qualificationMatches` do write. A tela de Vagas
 * só lista o que o assumeVacancy pode aceitar; a agenda/editor continua
 * o panorama administrativo. Contextos com topologia ambígua saem: a
 * mutation recusa, então o card mentiria.
 */
async function listActionableScheduleContextIds(input: {
  db: VacancyDb;
  institutionId: number;
  actor: VacancyActor;
}): Promise<{
  actionableContextIds: Set<number>;
  manageableContextIds: Set<number>;
}> {
  const activeContexts = await selectActiveScheduleContexts(
    input.db,
    input.institutionId,
  );
  const contextsPerTopology = new Map<string, number>();
  for (const context of activeContexts) {
    const topology = `${context.hospitalId}:${context.sectorId}`;
    contextsPerTopology.set(
      topology,
      (contextsPerTopology.get(topology) ?? 0) + 1,
    );
  }
  const canonicalContexts = activeContexts.filter(
    (context) =>
      contextsPerTopology.get(`${context.hospitalId}:${context.sectorId}`) ===
      1,
  );
  if (canonicalContexts.length === 0) {
    return {
      actionableContextIds: new Set(),
      manageableContextIds: new Set(),
    };
  }

  const manageableContextIds = new Set<number>();
  if (
    input.actor.isGlobalAdmin ||
    input.actor.roleInInstitution === "GESTOR_PLUS"
  ) {
    for (const context of canonicalContexts) {
      manageableContextIds.add(context.id);
    }
  } else if (input.actor.roleInInstitution === "GESTOR_MEDICO") {
    const scopes = await input.db
      .select({
        hospitalId: managerScope.hospitalId,
        sectorId: managerScope.sectorId,
      })
      .from(managerScope)
      .where(
        and(
          eq(managerScope.institutionId, input.institutionId),
          eq(managerScope.managerProfessionalId, input.actor.professionalId),
          eq(managerScope.active, true),
        ),
      );
    for (const context of canonicalContexts) {
      if (
        scopes.some(
          (scope) =>
            scope.hospitalId === context.hospitalId &&
            (scope.sectorId === null || scope.sectorId === context.sectorId),
        )
      ) {
        manageableContextIds.add(context.id);
      }
    }
  }

  if (
    input.actor.isGlobalAdmin ||
    input.actor.roleInInstitution === "GESTOR_PLUS"
  ) {
    return {
      actionableContextIds: await filterOccupiableScheduleContextIds(
        input.db,
        input.actor.professionalId,
        canonicalContexts,
        new Set(canonicalContexts.map((context) => context.id)),
      ),
      manageableContextIds,
    };
  }

  const assumedContextIds = new Set(
    await listAssumableScheduleContextIds(
      input.institutionId,
      input.actor.professionalId,
      input.db,
    ),
  );
  const contextIds = new Set(
    canonicalContexts
      .filter((context) => assumedContextIds.has(context.id))
      .map((context) => context.id),
  );

  // A named invite is an explicit temporary write grant. The mutation checks
  // the same tenant/topology/user/expiry/redemption predicates; no client
  // filter participates in this decision.
  const pendingInviteTopologies = new Set(
    (
      await input.db
        .select({
          hospitalId: scheduleInvites.hospitalId,
          sectorId: scheduleInvites.sectorId,
        })
        .from(scheduleInvites)
        .where(
          and(
            eq(scheduleInvites.institutionId, input.institutionId),
            eq(scheduleInvites.invitedUserId, input.actor.userId),
            isNull(scheduleInvites.revokedAt),
            isNull(scheduleInvites.declinedAt),
            gt(scheduleInvites.expiresAt, new Date()),
            sql`${scheduleInvites.redeemedCount} < ${scheduleInvites.maxRedemptions}`,
          ),
        )
    ).map((invite) => `${invite.hospitalId}:${invite.sectorId}`),
  );
  for (const context of canonicalContexts) {
    if (
      pendingInviteTopologies.has(`${context.hospitalId}:${context.sectorId}`)
    ) {
      contextIds.add(context.id);
    }
  }
  return {
    actionableContextIds: await filterOccupiableScheduleContextIds(
      input.db,
      input.actor.professionalId,
      canonicalContexts,
      contextIds,
    ),
    manageableContextIds,
  };
}

/**
 * Admissão ∩ qualificationMatches. O write revalida o mesmo predicado;
 * este recorte só impede a UI de oferecer o que o servidor recusará.
 */
async function filterOccupiableScheduleContextIds(
  db: VacancyDb,
  professionalId: number,
  canonicalContexts: readonly ActiveScheduleContext[],
  admittedContextIds: ReadonlySet<number>,
): Promise<Set<number>> {
  if (admittedContextIds.size === 0) return new Set();
  const [professional] = await db
    .select({
      medicalSpecialtyId: professionals.medicalSpecialtyId,
      operationalProfileCode: professionals.operationalProfileCode,
    })
    .from(professionals)
    .where(eq(professionals.id, professionalId))
    .limit(1);
  if (!professional) return new Set();
  const occupiable = new Set<number>();
  for (const context of canonicalContexts) {
    if (!admittedContextIds.has(context.id)) continue;
    if (
      qualificationMatches(
        {
          medicalSpecialtyId: professional.medicalSpecialtyId,
          operationalProfileCode: professional.operationalProfileCode as
            "MEDICO_GENERALISTA" | "RESIDENTE_ANESTESIOLOGIA" | null,
        },
        context,
      )
    ) {
      occupiable.add(context.id);
    }
  }
  return occupiable;
}

/**
 * Canonical actionability selector for Vagas. Both the cards and their filter
 * counters must use this exact population, otherwise the UI can promise a
 * vacancy that the mutation path will not expose to the professional.
 */
export async function listActionableVacancyRows(input: {
  db: VacancyDb;
  institutionId: number;
  actor: VacancyActor;
  filters?: ActionableVacancyFilters;
}): Promise<ActionableVacancyRow[]> {
  let startOfDay: Date | undefined;
  let endOfDay: Date | undefined;
  if (input.filters?.date) {
    ({ start: startOfDay, end: endOfDay } = dayWindowBrt(input.filters.date));
  }

  const { actionableContextIds, manageableContextIds } =
    await listActionableScheduleContextIds({
      db: input.db,
      institutionId: input.institutionId,
      actor: input.actor,
    });
  if (actionableContextIds.size === 0) return [];
  const assumableContextIdList = sql.join(
    [...actionableContextIds].map((contextId) => sql`${contextId}`),
    sql`, `,
  );
  const draftManagerPredicate =
    manageableContextIds.size > 0
      ? sql`OR si.schedule_context_id IN (${sql.join(
          [...manageableContextIds].map((contextId) => sql`${contextId}`),
          sql`, `,
        )})`
      : sql``;

  const rows = await input.db.execute<ActionableVacancyRow>(
    sql`SELECT
          si.id          AS shiftInstanceId,
          si.start_at    AS startAt,
          si.end_at      AS endAt,
          si.label,
          si.status,
          si.required_capacity AS requiredCapacity,
          (SELECT COUNT(*) FROM shift_assignments_v2 a WHERE a.shift_instance_id = si.id AND a.is_active = true) AS activeCount,
          GREATEST(0, COALESCE(si.required_capacity, 1) - (SELECT COUNT(*) FROM shift_assignments_v2 a WHERE a.shift_instance_id = si.id AND a.is_active = true)) AS remainingCapacity,
          si.modality            AS modality,
          si.coverage_type       AS coverageType,
          si.payment_model       AS paymentModel,
          si.productivity_cap_brl AS productivityCapBrl,
          s.name         AS sectorName,
          h.name         AS hospitalName,
          si.hospital_id AS hospitalId,
          si.sector_id   AS sectorId,
          si.schedule_context_id AS scheduleContextId
        FROM shift_instances si
        JOIN hospitals h ON h.id = si.hospital_id
          AND h.institution_id = si.institution_id
        JOIN sectors s ON s.id = si.sector_id
          AND s.institution_id = si.institution_id
          AND s.hospital_id = si.hospital_id
        JOIN schedule_contexts sc ON sc.id = si.schedule_context_id
          AND sc.institution_id = si.institution_id
          AND sc.hospital_id = si.hospital_id
          AND sc.sector_id = si.sector_id
          AND sc.active = true
        WHERE (si.required_capacity IS NOT NULL OR si.status = 'VAGO')
          AND si.institution_id = ${input.institutionId}
          -- IDs = admissão topológica ∩ qualificationMatches do ator.
          -- assumeVacancy revalida; a lista não substitui o write.
          AND si.schedule_context_id IN (${assumableContextIdList})
          -- USER só age em PUBLISHED. Gestor pode operar o próprio DRAFT;
          -- LOCKED permanece bloqueado para todos.
          AND NOT EXISTS (
            SELECT 1 FROM monthly_rosters mr
            WHERE mr.institution_id = si.institution_id
              AND mr.hospital_id = si.hospital_id
              AND mr.year_month = DATE_FORMAT(DATE_SUB(si.start_at, INTERVAL 3 HOUR), '%Y-%m')
              AND mr.status = 'LOCKED'
          )
          AND (
            EXISTS (
              SELECT 1 FROM monthly_rosters mr
              WHERE mr.institution_id = si.institution_id
                AND mr.hospital_id = si.hospital_id
                AND mr.year_month = DATE_FORMAT(DATE_SUB(si.start_at, INTERVAL 3 HOUR), '%Y-%m')
                AND mr.status = 'PUBLISHED'
            )
            ${draftManagerPredicate}
          )
          AND (SELECT COUNT(*) FROM shift_assignments_v2 a
            WHERE a.shift_instance_id = si.id AND a.is_active = true) < COALESCE(si.required_capacity, 1)
          -- A malformed active assignment makes the whole target unavailable.
          AND NOT EXISTS (
            SELECT 1 FROM shift_assignments_v2 target_assignment
            WHERE target_assignment.shift_instance_id = si.id
              AND target_assignment.is_active = true
              AND (target_assignment.institution_id <> si.institution_id
                OR target_assignment.hospital_id <> si.hospital_id
                OR target_assignment.sector_id <> si.sector_id)
          )
          -- The writer rejects a professional whose existing active
          -- assignment has contaminated tenant/hospital/sector topology.
          -- Hide every candidate until that data is repaired (fail closed).
          AND NOT EXISTS (
            SELECT 1
            FROM shift_assignments_v2 active_assignment
            JOIN shift_instances active_shift
              ON active_shift.id = active_assignment.shift_instance_id
            JOIN hospitals active_hospital
              ON active_hospital.id = active_shift.hospital_id
            JOIN sectors active_sector
              ON active_sector.id = active_shift.sector_id
            WHERE active_assignment.professional_id = ${input.actor.professionalId}
              AND active_assignment.is_active = true
              AND (
                active_assignment.institution_id <> active_shift.institution_id
                OR active_assignment.hospital_id <> active_shift.hospital_id
                OR active_assignment.sector_id <> active_shift.sector_id
                OR active_hospital.institution_id <> active_shift.institution_id
                OR active_sector.institution_id <> active_shift.institution_id
                OR active_sector.hospital_id <> active_shift.hospital_id
              )
          )
          -- Match assertAssignmentWritesAllowedForUpdate: an active schedule
          -- in any institution blocks an overlapping vacancy. This predicate
          -- never selects or returns the foreign assignment's details.
          AND NOT EXISTS (
            SELECT 1
            FROM shift_assignments_v2 active_assignment
            JOIN shift_instances active_shift
              ON active_shift.id = active_assignment.shift_instance_id
            JOIN hospitals active_hospital
              ON active_hospital.id = active_shift.hospital_id
            JOIN sectors active_sector
              ON active_sector.id = active_shift.sector_id
            WHERE active_assignment.professional_id = ${input.actor.professionalId}
              AND active_assignment.is_active = true
              AND active_assignment.institution_id = active_shift.institution_id
              AND active_assignment.hospital_id = active_shift.hospital_id
              AND active_assignment.sector_id = active_shift.sector_id
              AND active_hospital.institution_id = active_shift.institution_id
              AND active_sector.institution_id = active_shift.institution_id
              AND active_sector.hospital_id = active_shift.hospital_id
              AND active_shift.start_at < si.end_at
              AND active_shift.end_at > si.start_at
          )
          ${input.filters?.shiftInstanceId ? sql`AND si.id = ${input.filters.shiftInstanceId}` : sql``}
          ${input.filters?.hospitalId ? sql`AND si.hospital_id = ${input.filters.hospitalId}` : sql``}
          ${input.filters?.sectorId ? sql`AND si.sector_id   = ${input.filters.sectorId}` : sql``}
          ${input.filters?.shiftLabel ? sql`AND si.label       = ${input.filters.shiftLabel}` : sql``}
          ${input.filters?.modality ? sql`AND si.modality    = ${input.filters.modality}` : sql``}
          ${input.filters?.coverageType ? sql`AND si.coverage_type = ${input.filters.coverageType}` : sql``}
          ${startOfDay && endOfDay ? sql`AND si.start_at >= ${startOfDay} AND si.start_at < ${endOfDay}` : sql``}
        ORDER BY si.start_at ASC`,
  );

  return rowsFromExecute<ActionableVacancyRow>(rows);
}

export function countActionableVacancies(
  rows: readonly ActionableVacancyRow[],
): ActionableVacancyCounts {
  const vacanciesByHospital: Record<number, number> = {};
  const vacanciesBySector: Record<number, number> = {};

  for (const row of rows) {
    const remaining = Number(row.remainingCapacity ?? 1);
    const hospitalId = Number(row.hospitalId);
    const sectorId = Number(row.sectorId);
    vacanciesByHospital[hospitalId] =
      (vacanciesByHospital[hospitalId] ?? 0) + remaining;
    vacanciesBySector[sectorId] =
      (vacanciesBySector[sectorId] ?? 0) + remaining;
  }

  return {
    total: rows.reduce(
      (sum, row) => sum + Number(row.remainingCapacity ?? 1),
      0,
    ),
    vacanciesByHospital,
    vacanciesBySector,
  };
}
