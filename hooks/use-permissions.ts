import { useAuth } from "./use-auth";
import { trpc } from "@/lib/trpc";

export type Permission =
  | "view:dashboard"
  | "view:reports"
  | "view:vacancies"
  | "view:admin"
  | "view:weekly"
  | "create:shift"
  | "edit:shift"
  | "view:swap-history"
  | "request:swap";

export function usePermissions() {
  const { user, isLoading } = useAuth();
  const capabilitiesQuery = trpc.professionals.getMyCapabilities.useQuery(undefined, {
    enabled: !!user,
    staleTime: 60_000,
  });
  const capabilities = !capabilitiesQuery.isLoading &&
    !capabilitiesQuery.isFetching &&
    !capabilitiesQuery.isError
    ? capabilitiesQuery.data
    : undefined;

  const can = (permission: Permission): boolean => {
    if (capabilities) {
      const map: Record<Permission, boolean> = {
        "view:dashboard": capabilities.canViewDashboard,
        "view:reports": capabilities.canViewReports,
        "view:vacancies": capabilities.canViewVacancies,
        "view:admin": capabilities.canViewAdmin,
        "view:weekly": capabilities.canViewWeekly,
        "create:shift": capabilities.canCreateShift,
        "edit:shift": capabilities.canEditShift,
        "view:swap-history": capabilities.canViewSwapHistory,
        "request:swap": capabilities.canRequestSwap,
      };
      return map[permission];
    }
    // Toda permissão acima é tenant-bound. users.role é papel global e jamais
    // substitui uma capability institucional ausente, carregando ou em erro.
    return false;
  };

  const isAdmin = capabilities?.canViewAdmin ?? false;
  const isManager = capabilities
    ? capabilities.canCreateShift || capabilities.canApproveAssignments
    : false;

  return {
    can,
    role: capabilities?.roleInInstitution,
    roleInInstitution: capabilities?.roleInInstitution,
    isGlobalAdmin: capabilities?.isGlobalAdmin ?? false,
    isAdmin,
    isManager,
    canApproveAssignments: capabilities?.canApproveAssignments ?? false,
    isLoading: isLoading || (
      !!user && (capabilitiesQuery.isLoading || capabilitiesQuery.isFetching)
    ),
  };
}
