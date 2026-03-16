import { useAuth } from "./use-auth";

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
  const { user } = useAuth();
  const role = user?.role as Role | undefined;

  const can = (permission: Permission): boolean => {
    if (!role) return false;
    return ROLE_PERMISSIONS[role].includes(permission);
  };

  const isAdmin = role === "admin";
  const isManager = role === "admin" || role === "manager";

  return { can, role, isAdmin, isManager };
}
