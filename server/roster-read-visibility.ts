import { and, eq, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { monthlyRosters } from "../drizzle/schema";
import type { getDb } from "./db";

type RosterReadDb = Pick<
  NonNullable<Awaited<ReturnType<typeof getDb>>>,
  "select"
>;
export type RosterMonthStatus = "DRAFT" | "PUBLISHED" | "LOCKED";

export function rosterMonthKey(hospitalId: number, yearMonth: string): string {
  return `${hospitalId}:${yearMonth}`;
}

/** Ausência ou estado desconhecido nunca comprova publicação. */
export function canReadRosterMonth(
  canManage: boolean,
  status: RosterMonthStatus | null | undefined,
): boolean {
  return canManage === true || status === "PUBLISHED" || status === "LOCKED";
}

/**
 * Predicado correlacionado para leitores que precisam filtrar antes de
 * ORDER/LIMIT. Evita que um DRAFT anterior esconda o próximo plantão oficial.
 */
export function officialRosterExistsSql(input: {
  institutionId: SQLWrapper;
  hospitalId: SQLWrapper;
  startAt: SQLWrapper;
}): SQL {
  return sql`EXISTS (
    SELECT 1 FROM monthly_rosters roster_visibility
    WHERE roster_visibility.institution_id = ${input.institutionId}
      AND roster_visibility.hospital_id = ${input.hospitalId}
      AND roster_visibility.year_month = DATE_FORMAT(DATE_SUB(${input.startAt}, INTERVAL 3 HOUR), '%Y-%m')
      AND roster_visibility.status IN ('PUBLISHED', 'LOCKED')
  )`;
}

/** Gestão de DRAFT exige contexto ativo e topologia exata, não só o FK id. */
export function managedScheduleContextExistsSql(input: {
  institutionId: SQLWrapper;
  hospitalId: SQLWrapper;
  sectorId: SQLWrapper;
  scheduleContextId: SQLWrapper;
  manageableContextIds: readonly number[];
}): SQL | undefined {
  if (input.manageableContextIds.length === 0) return undefined;
  return sql`EXISTS (
    SELECT 1 FROM schedule_contexts managed_roster_visibility
    WHERE managed_roster_visibility.id = ${input.scheduleContextId}
      AND managed_roster_visibility.institution_id = ${input.institutionId}
      AND managed_roster_visibility.hospital_id = ${input.hospitalId}
      AND managed_roster_visibility.sector_id = ${input.sectorId}
      AND managed_roster_visibility.active = 1
      AND managed_roster_visibility.id IN (${sql.join(
        input.manageableContextIds.map((contextId) => sql`${contextId}`),
        sql`, `,
      )})
  )`;
}

/** Uma consulta por leitura, mesmo em períodos com vários hospitais/meses. */
export async function loadRosterMonthStatuses(
  db: RosterReadDb,
  institutionId: number,
  scopes: readonly { hospitalId: number; yearMonth: string }[],
): Promise<ReadonlyMap<string, RosterMonthStatus>> {
  const uniqueScopes = new Map(
    scopes.map((scope) => [
      rosterMonthKey(scope.hospitalId, scope.yearMonth),
      scope,
    ]),
  );
  if (uniqueScopes.size === 0) return new Map();

  const rows = await db
    .select({
      hospitalId: monthlyRosters.hospitalId,
      yearMonth: monthlyRosters.yearMonth,
      status: monthlyRosters.status,
    })
    .from(monthlyRosters)
    .where(
      and(
        eq(monthlyRosters.institutionId, institutionId),
        or(
          ...Array.from(uniqueScopes.values(), (scope) =>
            and(
              eq(monthlyRosters.hospitalId, scope.hospitalId),
              eq(monthlyRosters.yearMonth, scope.yearMonth),
            ),
          ),
        ),
      ),
    );

  return new Map(
    rows.map((row) => [
      rosterMonthKey(row.hospitalId, row.yearMonth),
      row.status === "PUBLISHED" || row.status === "LOCKED"
        ? row.status
        : "DRAFT",
    ]),
  );
}
