import { and, eq, or } from "drizzle-orm";
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
