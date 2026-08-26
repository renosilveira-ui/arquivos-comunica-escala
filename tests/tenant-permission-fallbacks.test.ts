import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  canLoadEditShift,
  resolveEditShiftPermissionState,
  resolvePendingContentState,
} from "../lib/permission-screen-state";

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
  it("mantém pendências em loading até a capability institucional terminar", () => {
    expect(
      resolvePendingContentState({
        pendingLoading: false,
        permissionsLoading: true,
        professionalLoading: false,
        myShiftsLoading: false,
        hasProfessional: false,
        canApproveAssignments: false,
      }),
    ).toBe("LOADING");
    expect(
      resolvePendingContentState({
        pendingLoading: false,
        permissionsLoading: false,
        professionalLoading: false,
        myShiftsLoading: false,
        hasProfessional: false,
        canApproveAssignments: false,
      }),
    ).toBe("MISSING_PROFESSIONAL");

    const pending = readFileSync("app/(tabs)/pending.tsx", "utf8");
    const loadingIndex = pending.indexOf('pendingContentState === "LOADING"');
    const missingIndex = pending.indexOf(
      'pendingContentState === "MISSING_PROFESSIONAL"',
    );
    expect(loadingIndex).toBeGreaterThanOrEqual(0);
    expect(missingIndex).toBeGreaterThanOrEqual(0);
    expect(loadingIndex).toBeLessThan(missingIndex);
  });

  it("edit-shift não volta nem libera o formulário durante loading/refetch", () => {
    expect(
      resolveEditShiftPermissionState({
        authLoading: false,
        hasUser: true,
        permissionsLoading: true,
        canEditShift: false,
      }),
    ).toBe("LOADING");
    expect(
      resolveEditShiftPermissionState({
        authLoading: false,
        hasUser: true,
        permissionsLoading: false,
        canEditShift: false,
      }),
    ).toBe("DENIED");
    expect(
      resolveEditShiftPermissionState({
        authLoading: false,
        hasUser: true,
        permissionsLoading: false,
        canEditShift: true,
      }),
    ).toBe("ALLOWED");
    expect(
      resolveEditShiftPermissionState({
        authLoading: true,
        hasUser: false,
        permissionsLoading: false,
        canEditShift: false,
      }),
    ).toBe("LOADING");
    expect(
      resolveEditShiftPermissionState({
        authLoading: false,
        hasUser: false,
        permissionsLoading: false,
        canEditShift: false,
      }),
    ).toBe("UNAUTHENTICATED");
    expect(canLoadEditShift("UNAUTHENTICATED", true)).toBe(false);
    expect(canLoadEditShift("LOADING", true)).toBe(false);
    expect(canLoadEditShift("DENIED", true)).toBe(false);
    expect(canLoadEditShift("ALLOWED", false)).toBe(false);
    expect(canLoadEditShift("ALLOWED", true)).toBe(true);

    const editShift = readFileSync("app/edit-shift.tsx", "utf8");
    expect(editShift).toContain('permissionState === "DENIED"');
    expect(editShift).toContain('permissionState === "LOADING"');
    expect(editShift).toContain('permissionState === "UNAUTHENTICATED"');
    expect(editShift).toContain(
      "enabled: canLoadEditShift(permissionState, !!shiftId)",
    );
    expect(editShift).not.toContain("if (!canEditShift) router.back()");
  });

});
