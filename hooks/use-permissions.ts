import { useAuth } from "./use-auth";
import { trpc } from "@/lib/trpc";

type Role = "admin" | "manager" | "doctor" | "nurse" | "tech";

export type Permission =
  | "view:dashboard"
  | "view:reports"
  | "view:vacancies"
  | "view:admin"
  | "view:weekly"
  | "create:shift"
  | "edit:shift"
  | "approve:swaps"
  | "request:swap";

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: [
    "view:dashboard",
    "view:reports",
    "view:vacancies",
    "view:admin",
    "view:weekly",
    "create:shift",
    "edit:shift",
    "approve:swaps",
    "request:swap",
  ],
  manager: [
    "view:dashboard",
    "view:reports",
    "view:vacancies",
    "view:weekly",
    "create:shift",
    "edit:shift",
    "approve:swaps",
    "request:swap",
  ],
  doctor: ["view:vacancies", "request:swap"],
  nurse: ["view:vacancies", "request:swap"],
  tech: [],
};

export function usePermissions() {
  const { user, isLoading } = useAuth();
  const role = user?.role as Role | undefined;
  const { data: capabilities } = trpc.professionals.getMyCapabilities.useQuery(undefined, {
    enabled: !!user,
    staleTime: 60_000,
  });

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
        "approve:swaps": capabilities.canApproveSwaps,
        "request:swap": capabilities.canRequestSwap,
      };
      return map[permission];
    }
    if (!role) return false;
    return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
  };

  const isAdmin = capabilities ? capabilities.canViewAdmin : role === "admin";
  const isManager = capabilities
    ? capabilities.canCreateShift || capabilities.canApproveAssignments
    : role === "admin" || role === "manager";

  return { can, role, isAdmin, isManager, isLoading };
}
