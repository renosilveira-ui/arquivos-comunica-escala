import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { scheduleInvites } from "../drizzle/schema";
import { rowsFromExecute } from "./_core/db-results";
import { getDb } from "./db";
import { dayWindowBrt } from "./local-time";
import {
  listAssumableScheduleContextIds,
  selectActiveScheduleContexts,
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
};

export type ActionableVacancyCounts = {
  total: number;
  vacanciesByHospital: Record<number, number>;
  vacanciesBySector: Record<number, number>;
};

type VacancyActor = {
  userId: number;
  professionalId: number;
  /**
   * The caller has already been resolved by getTenantActorFromContext, which
   * proves active membership in this institution. Keep the role as a closed
   * value rather than accepting a caller-produced capability boolean.
   */
  roleInInstitution: "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";
};

/**
 * Resolve the exact schedule-context grant used by the Vagas write path.
 *
 * `listAssumableScheduleContextIds` intentionally remains unchanged for
 * swaps. Vagas additionally needs GESTOR_PLUS' tenant-wide write grant and
 * a still-valid named invite. Contexts with ambiguous active topology are
 * omitted: the mutation rejects them, so advertising a card would be false.
 */
async function listActionableScheduleContextIds(input: {
  db: VacancyDb;
  institutionId: number;
  actor: VacancyActor;
}): Promise<Set<number>> {
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
  if (canonicalContexts.length === 0) return new Set();

  if (input.actor.roleInInstitution === "GESTOR_PLUS") {
    return new Set(canonicalContexts.map((context) => context.id));
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
  return contextIds;
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

  const assumableContextIds = await listActionableScheduleContextIds({
    db: input.db,
    institutionId: input.institutionId,
    actor: input.actor,
  });
  if (assumableContextIds.size === 0) return [];
  const assumableContextIdList = sql.join(
    [...assumableContextIds].map((contextId) => sql`${contextId}`),
    sql`, `,
  );

  const rows = await input.db.execute<ActionableVacancyRow>(
    sql`SELECT
          si.id          AS shiftInstanceId,
          si.start_at    AS startAt,
          si.end_at      AS endAt,
          si.label,
          si.status,
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
        WHERE si.status = 'VAGO'
          AND si.institution_id = ${input.institutionId}
          -- A lista de IDs é resolvida exclusivamente pelo servidor a partir
          -- do vínculo e da ACL do ator. Restringir aqui evita ler e montar
          -- em memória vagas de contextos que jamais poderiam ser assumidos.
          AND si.schedule_context_id IN (${assumableContextIdList})
          -- Mês trancado não oferece vagas (start_at em UTC → mês do hospital, -03:00)
          AND NOT EXISTS (
            SELECT 1 FROM monthly_rosters mr
            WHERE mr.institution_id = si.institution_id
              AND mr.hospital_id = si.hospital_id
              AND mr.year_month = DATE_FORMAT(DATE_SUB(si.start_at, INTERVAL 3 HOUR), '%Y-%m')
              AND mr.status = 'LOCKED'
          )
          -- A target with any active assignment will fail the same locked
          -- capacity guard in assumeVacancy. Do not expose even a malformed
          -- legacy assignment as an apparent vacancy.
          AND NOT EXISTS (
            SELECT 1 FROM shift_assignments_v2 target_assignment
            WHERE target_assignment.shift_instance_id = si.id
              AND target_assignment.is_active = true
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
    const hospitalId = Number(row.hospitalId);
    const sectorId = Number(row.sectorId);
    vacanciesByHospital[hospitalId] =
      (vacanciesByHospital[hospitalId] ?? 0) + 1;
    vacanciesBySector[sectorId] = (vacanciesBySector[sectorId] ?? 0) + 1;
  }

  return {
    total: rows.length,
    vacanciesByHospital,
    vacanciesBySector,
  };
}
