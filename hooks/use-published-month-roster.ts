import { trpc } from "@/lib/trpc";
import {
  requiresPublishedMonthReason,
  validatePublishedMonthReason,
  type MonthlyRosterStatus,
} from "@/lib/published-month-reason";

export type { MonthlyRosterStatus };
export { requiresPublishedMonthReason, validatePublishedMonthReason };

export function usePublishedMonthRoster(
  hospitalId: number | undefined,
  dateKey: string | undefined,
  sectorId?: number,
) {
  const yearMonth = dateKey?.slice(0, 7);
  const enabled = !!hospitalId && !!yearMonth && /^\d{4}-\d{2}$/.test(yearMonth);
  const roster = trpc.shifts.rosterStatus.useQuery(
    { hospitalId: hospitalId ?? 0, yearMonth: yearMonth ?? "0000-00" },
    {
      enabled,
      staleTime: 30_000,
    },
  );
  const monthShifts = trpc.filters.hasMonthShifts.useQuery(
    {
      hospitalId: hospitalId ?? 0,
      ...(sectorId === undefined ? {} : { sectorId }),
      yearMonth: yearMonth ?? "0000-00",
    },
    {
      enabled,
      staleTime: 30_000,
    },
  );
  return {
    ...roster,
    hasShifts: monthShifts.data?.hasShifts,
  };
}
