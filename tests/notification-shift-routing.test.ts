import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-router", () => ({ useRouter: vi.fn() }));
vi.mock("expo-notifications", () => ({
  DEFAULT_ACTION_IDENTIFIER: "default",
  addNotificationResponseReceivedListener: vi.fn(),
}));
vi.mock("@/hooks/use-auth", () => ({ useAuth: vi.fn() }));
vi.mock("@/hooks/use-notifications", () => ({ useNotifications: vi.fn() }));
vi.mock("@/lib/trpc", () => ({ trpc: {} }));
vi.mock("@/lib/tenant-state", () => ({
  getActiveTenantSnapshot: vi.fn(),
  useTenantState: vi.fn(),
}));

let routeNotificationData: (typeof import("../components/NotificationListener"))["routeNotificationData"];

beforeAll(async () => {
  ({ routeNotificationData } =
    await import("../components/NotificationListener"));
});

describe("roteamento de push para o plantão exato", () => {
  it("troca B para A, invalida caches e só então abre o shift A", async () => {
    const calls: string[] = [];
    let activeTenant = { institutionId: 22, revision: 3 };

    await expect(
      routeNotificationData(
        {
          type: "replacement_accepted",
          institutionId: 11,
          shiftInstanceId: 909,
        },
        {
          isSessionAuthorizationCurrent: () => true,
          getActiveTenantSnapshot: () => activeTenant,
          loadAllowedInstitutionIds: async () => {
            calls.push("allowed");
            return [11, 22];
          },
          setActiveInstitutionId: async (institutionId) => {
            calls.push(`set:${institutionId}`);
            activeTenant = {
              institutionId,
              revision: activeTenant.revision + 1,
            };
          },
          invalidateQueries: async () => {
            calls.push("invalidate");
          },
          navigateToConfirmation: vi.fn(),
          navigateToAgenda: vi.fn(),
          navigateToShiftDetails: (shiftInstanceId) => {
            calls.push(
              `shift:${shiftInstanceId}:tenant:${activeTenant.institutionId}`,
            );
          },
          openComunica: vi.fn(async () => ({ ok: true })),
        },
      ),
    ).resolves.toBe(true);

    expect(calls).toEqual([
      "allowed",
      "set:11",
      "invalidate",
      "shift:909:tenant:11",
    ]);
  });

  it("falha fechado antes de trocar tenant quando shiftInstanceId é inválido", async () => {
    const setActiveInstitutionId = vi.fn(async () => undefined);
    const navigateToShiftDetails = vi.fn();

    await expect(
      routeNotificationData(
        {
          type: "manager_confirmation_escalation",
          institutionId: 11,
          shiftInstanceId: "909x",
        },
        {
          isSessionAuthorizationCurrent: () => true,
          getActiveTenantSnapshot: () => ({ institutionId: 22, revision: 1 }),
          loadAllowedInstitutionIds: async () => [11, 22],
          setActiveInstitutionId,
          invalidateQueries: vi.fn(async () => undefined),
          navigateToConfirmation: vi.fn(),
          navigateToAgenda: vi.fn(),
          navigateToShiftDetails,
          openComunica: vi.fn(async () => ({ ok: true })),
        },
      ),
    ).resolves.toBe(false);

    expect(setActiveInstitutionId).not.toHaveBeenCalled();
    expect(navigateToShiftDetails).not.toHaveBeenCalled();
  });

  it("troca o tenant e abre Trocas quando a oferta de plantão chega", async () => {
    const calls: string[] = [];
    let activeTenant = { institutionId: 22, revision: 3 };

    await expect(
      routeNotificationData(
        {
          type: "swap_offer",
          institutionId: 11,
          shiftInstanceId: 404,
          swapRequestId: 7,
        },
        {
          isSessionAuthorizationCurrent: () => true,
          getActiveTenantSnapshot: () => activeTenant,
          loadAllowedInstitutionIds: async () => {
            calls.push("allowed");
            return [11, 22];
          },
          setActiveInstitutionId: async (institutionId) => {
            calls.push(`set:${institutionId}`);
            activeTenant = {
              institutionId,
              revision: activeTenant.revision + 1,
            };
          },
          invalidateQueries: async () => {
            calls.push("invalidate");
          },
          navigateToConfirmation: vi.fn(),
          navigateToAgenda: () => {
            calls.push("agenda");
          },
          navigateToTrocas: () => {
            calls.push(`trocas:tenant:${activeTenant.institutionId}`);
          },
          openComunica: vi.fn(async () => ({ ok: true })),
        },
      ),
    ).resolves.toBe(true);

    expect(calls).toEqual([
      "allowed",
      "set:11",
      "invalidate",
      "trocas:tenant:11",
    ]);
  });
});
