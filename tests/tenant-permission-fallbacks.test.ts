import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const ALL_PERMISSIONS = [
  "view:dashboard",
  "view:reports",
  "view:vacancies",
  "view:admin",
  "view:weekly",
  "create:shift",
  "edit:shift",
  "view:swap-history",
  "request:swap",
] as const;

const managerCapabilities = {
  institutionId: 11,
  roleInInstitution: "GESTOR_MEDICO" as const,
  isGlobalAdmin: false,
  canViewDashboard: true,
  canViewReports: true,
  canViewVacancies: true,
  canViewAdmin: false,
  canViewWeekly: true,
  canCreateShift: true,
  canEditShift: true,
  canViewSwapHistory: true,
  canApproveSwaps: false,
  canRequestSwap: true,
  canApproveAssignments: true,
};

async function loadHook(options: {
  globalRole: "admin" | "manager";
  data?: typeof managerCapabilities;
  isLoading?: boolean;
  isFetching?: boolean;
  isError?: boolean;
}) {
  vi.resetModules();
  vi.doMock("../hooks/use-auth", () => ({
    useAuth: () => ({
      user: { id: 7, role: options.globalRole },
      isLoading: false,
    }),
  }));
  vi.doMock("@/lib/trpc", () => ({
    trpc: {
      professionals: {
        getMyCapabilities: {
          useQuery: () => ({
            data: options.data,
            isLoading: options.isLoading ?? false,
            isFetching: options.isFetching ?? false,
            isError: options.isError ?? false,
          }),
        },
      },
    },
  }));
  const { usePermissions } = await import("../hooks/use-permissions");
  let captured: ReturnType<typeof usePermissions> | undefined;
  function PermissionsProbe() {
    captured = usePermissions();
    return null;
  }
  PermissionsProbe();
  if (!captured) throw new Error("usePermissions não publicou o resultado");
  return captured;
}

describe("autoridade visual exclusivamente institucional", () => {
  it.each(["admin", "manager"] as const)(
    "nega toda permissão tenant-bound sem capability mesmo com users.role=%s",
    async (globalRole) => {
      const permissions = await loadHook({ globalRole });
      ALL_PERMISSIONS.forEach((permission) => {
        expect(permissions.can(permission)).toBe(false);
      });
      expect(permissions.isAdmin).toBe(false);
      expect(permissions.isManager).toBe(false);
      expect(permissions.canApproveAssignments).toBe(false);
      expect(permissions.isGlobalAdmin).toBe(false);
      expect(permissions.roleInInstitution).toBeUndefined();
    },
  );

  it.each([
    { name: "loading", isLoading: true, isError: false },
    { name: "background refetch", isLoading: false, isFetching: true, isError: false },
    { name: "error", isLoading: false, isError: true },
  ])("não reutiliza capability stale durante $name", async ({
    isLoading,
    isFetching,
    isError,
  }) => {
    const permissions = await loadHook({
      globalRole: "admin",
      data: { ...managerCapabilities, isGlobalAdmin: true },
      isLoading,
      isFetching,
      isError,
    });
    ALL_PERMISSIONS.forEach((permission) => {
      expect(permissions.can(permission)).toBe(false);
    });
    expect(permissions.isManager).toBe(false);
    expect(permissions.canApproveAssignments).toBe(false);
    expect(permissions.isGlobalAdmin).toBe(false);
  });

  it("capability fresca concede granularmente e preserva manager_scope", async () => {
    const permissions = await loadHook({
      globalRole: "manager",
      data: managerCapabilities,
    });
    expect(permissions.can("create:shift")).toBe(true);
    expect(permissions.can("view:admin")).toBe(false);
    expect(permissions.isManager).toBe(true);
    expect(permissions.canApproveAssignments).toBe(true);
    expect(permissions.roleInInstitution).toBe("GESTOR_MEDICO");
    expect(
      permissions.isGlobalAdmin || permissions.roleInInstitution === "GESTOR_PLUS",
    ).toBe(false);

    const plus = await loadHook({
      globalRole: "manager",
      data: { ...managerCapabilities, roleInInstitution: "GESTOR_PLUS" },
    });
    expect(plus.isGlobalAdmin || plus.roleInInstitution === "GESTOR_PLUS").toBe(true);
  });

  it("consumidores não reintroduzem users.role/professional.userRole como autorização", () => {
    const pending = readFileSync("app/(tabs)/pending.tsx", "utf8");
    const vacancies = readFileSync("app/(tabs)/vacancies.tsx", "utf8");
    const profile = readFileSync("app/(tabs)/profile.tsx", "utf8");
    const tabsLayout = readFileSync("app/(tabs)/_layout.tsx", "utf8");

    expect(pending).not.toMatch(/user\?\.role|professional\?\.userRole/);
    expect(vacancies).not.toMatch(/user\?\.role|professional\?\.userRole/);
    expect(profile).not.toMatch(/professional\?\.userRole/);
    expect(pending).toContain("canApproveAssignments");
    expect(vacancies).toContain("disabled={!vacancy.canAssume");
    expect(profile).toContain("if (isManager) return true");
    expect(profile).toContain("enabled: !!user?.id && canApproveAssignments");
    expect(tabsLayout).toContain("showManagementTabs && canApproveAssignments");
  });
});
