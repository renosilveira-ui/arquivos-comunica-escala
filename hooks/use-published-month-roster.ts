import { trpc } from "@/lib/trpc";

export type MonthlyRosterStatus = "DRAFT" | "PUBLISHED" | "LOCKED";

export function requiresPublishedMonthReason(
  status: MonthlyRosterStatus | undefined,
): boolean {
  return status === "PUBLISHED" || status === "LOCKED";
}

export function validatePublishedMonthReason(
  status: MonthlyRosterStatus | undefined,
  reason: string,
): string | null {
  if (!requiresPublishedMonthReason(status)) return null;
  if (reason.trim().length < 5) {
    return "Informe o motivo da edição (mínimo 5 caracteres) para meses publicados ou bloqueados.";
  }
  return null;
}

export function usePublishedMonthRoster(
  hospitalId: number | undefined,
  dateKey: string | undefined,
) {
  const yearMonth = dateKey?.slice(0, 7);
  return trpc.shifts.rosterStatus.useQuery(
    { hospitalId: hospitalId ?? 0, yearMonth: yearMonth ?? "0000-00" },
    {
      enabled: !!hospitalId && !!yearMonth && /^\d{4}-\d{2}$/.test(yearMonth),
      staleTime: 30_000,
    },
  );
}
