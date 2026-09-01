import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  canStartTenantAuthorizationHandshake,
  runTenantAuthorizationAttempt,
  tenantAuthorityMatchesMembership,
  TenantAuthorizationCoordinator,
  transitionTenantAuthorizationActivity,
  type AuthorizedInstitution,
  type TenantAuthorizationSubject,
} from "../lib/tenant-authorization";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const institution = (
  id: number,
  roleInInstitution: AuthorizedInstitution["roleInInstitution"] = "USER",
): AuthorizedInstitution => ({
  id,
  name: `Hospital ${id}`,
  roleInInstitution,
  isPrimary: id === 11,
});

const subject = (
  userId: number,
  institutionId: number | null,
  revision: number,
): TenantAuthorizationSubject => ({
  userId,
  tenant: { institutionId, revision },
});

describe("gate fresco de autorização antes do cache tenant-bound", () => {
  it("exige /me VERIFIED atual antes de qualquer handshake ou render tenant", () => {
    const approved = {
      id: 7,
      approvalStatus: "APPROVED" as const,
      mustChangePassword: false,
    };
    const currentReceipt = {
      status: "VERIFIED" as const,
      userId: 7,
      isCurrent: () => true,
    };

    expect(
      canStartTenantAuthorizationHandshake({
        user: approved,
        sessionValidation: { status: "CHECKING" },
      }),
    ).toBe(false);
    expect(
      canStartTenantAuthorizationHandshake({
        user: approved,
        sessionValidation: { status: "UNAVAILABLE" },
      }),
    ).toBe(false);
    expect(
      canStartTenantAuthorizationHandshake({
        user: approved,
        sessionValidation: { ...currentReceipt, userId: 8 },
      }),
    ).toBe(false);
    expect(
      canStartTenantAuthorizationHandshake({
        user: approved,
        sessionValidation: { ...currentReceipt, isCurrent: () => false },
      }),
    ).toBe(false);
    expect(
      canStartTenantAuthorizationHandshake({
        user: { ...approved, approvalStatus: "PENDING" },
        sessionValidation: currentReceipt,
      }),
    ).toBe(false);
    expect(
      canStartTenantAuthorizationHandshake({
        user: { ...approved, mustChangePassword: true },
        sessionValidation: currentReceipt,
      }),
    ).toBe(false);
    expect(
      canStartTenantAuthorizationHandshake({
        user: { id: approved.id, approvalStatus: "APPROVED" },
        sessionValidation: currentReceipt,
      }),
    ).toBe(false);
    expect(
      canStartTenantAuthorizationHandshake({
        user: approved,
        sessionValidation: currentReceipt,
      }),
    ).toBe(true);
  });

  it("mantém Listener fora do subtree bloqueado e gateia Stack", () => {
    const layout = readFileSync("app/_layout.tsx", "utf8");
    const tree = layout.slice(
      layout.indexOf("<TenantScope>"),
      layout.indexOf("</TenantScope>"),
    );
    const listener = tree.indexOf("<NotificationListener />");
    const boundary = tree.indexOf("<TenantAuthorizationBoundary>");
    const guard = tree.indexOf("<AuthGuard>");
    const stack = tree.indexOf("<Stack screenOptions");

    expect(listener).toBeGreaterThanOrEqual(0);
    expect(listener).toBeLessThan(boundary);
    expect(boundary).toBeLessThan(guard);
    expect(guard).toBeLessThan(stack);
  });

  it("background/offline fecha e visible/reconnect exige nova attestation", () => {
    let activity = { visible: true, online: true, revision: 0 };
    const background = transitionTenantAuthorizationActivity(activity, {
      visible: false,
    });
    expect(background.action).toBe("CLOSE");
    activity = background.state;

    const offlineWhileHidden = transitionTenantAuthorizationActivity(activity, {
      online: false,
    });
    expect(offlineWhileHidden.action).toBe("CLOSE");
    activity = offlineWhileHidden.state;

    const visibleStillOffline = transitionTenantAuthorizationActivity(
      activity,
      { visible: true },
    );
    expect(visibleStillOffline.action).toBe("CLOSE");
    activity = visibleStillOffline.state;

    const reconnect = transitionTenantAuthorizationActivity(activity, {
      online: true,
    });
    expect(reconnect.action).toBe("REVALIDATE");
    expect(reconnect.state.revision).toBe(4);
  });

  it("resposta anterior ao background nunca reabre o gate no resume", async () => {
    const coordinator = new TenantAuthorizationCoordinator();
    const current = subject(7, 11, 4);
    const oldTicket = coordinator.begin(current);
    const oldAllowlist = deferred<readonly AuthorizedInstitution[]>();
    const oldAttempt = runTenantAuthorizationAttempt({
      coordinator,
      ticket: oldTicket,
      currentSubject: () => current,
      loadInstitutions: () => oldAllowlist.promise,
      loadCurrentTenantAuthority: async () => undefined,
      clearRevokedTenant: async () => undefined,
    });
    coordinator.invalidate();
    const resumedTicket = coordinator.begin(current);
    oldAllowlist.resolve([institution(11)]);
    await expect(oldAttempt).resolves.toEqual({ status: "STALE" });
    await expect(
      runTenantAuthorizationAttempt({
        coordinator,
        ticket: resumedTicket,
        currentSubject: () => current,
        loadInstitutions: async () => [institution(11)],
        loadCurrentTenantAuthority: async () => undefined,
        clearRevokedTenant: async () => undefined,
      }),
    ).resolves.toMatchObject({ status: "VERIFIED" });
  });

  it("handshake pendente/erro não promove cache nem libera children", async () => {
    const coordinator = new TenantAuthorizationCoordinator();
    const current = subject(7, 11, 4);
    const ticket = coordinator.begin(current);
    const pending = deferred<readonly AuthorizedInstitution[]>();
    let promoted = false;
    let rendered = false;

    const attempt = runTenantAuthorizationAttempt({
      coordinator,
      ticket,
      currentSubject: () => current,
      loadInstitutions: () => pending.promise,
      loadCurrentTenantAuthority: async () => undefined,
      clearRevokedTenant: async () => undefined,
    }).then(() => {
      promoted = true;
      rendered = true;
    });
    await Promise.resolve();
    expect(promoted).toBe(false);
    expect(rendered).toBe(false);

    pending.reject(new Error("offline"));
    await expect(attempt).rejects.toThrow("offline");
    expect(promoted).toBe(false);
    expect(rendered).toBe(false);
  });

  it("PI/tenant revogado limpa a seleção e nunca produz receipt", async () => {
    const coordinator = new TenantAuthorizationCoordinator();
    let current = subject(7, 11, 4);
    const ticket = coordinator.begin(current);
    const clearRevokedTenant = vi.fn(async () => {
      current = subject(7, null, 5);
    });
    const loadAuthority = vi.fn(async () => undefined);

    const result = await runTenantAuthorizationAttempt({
      coordinator,
      ticket,
      currentSubject: () => current,
      loadInstitutions: async () => [institution(22)],
      loadCurrentTenantAuthority: loadAuthority,
      clearRevokedTenant,
    });

    expect(result).toEqual({ status: "TENANT_REVOKED" });
    expect(clearRevokedTenant).toHaveBeenCalledTimes(1);
    expect(loadAuthority).not.toHaveBeenCalled();
  });

  it("resposta antiga perde para B e também para ABA A→B→A", async () => {
    const coordinator = new TenantAuthorizationCoordinator();
    let current = subject(7, 11, 1);
    const oldA = coordinator.begin(current);
    const releaseOldA = deferred<readonly AuthorizedInstitution[]>();
    const oldAttempt = runTenantAuthorizationAttempt({
      coordinator,
      ticket: oldA,
      currentSubject: () => current,
      loadInstitutions: () => releaseOldA.promise,
      loadCurrentTenantAuthority: async () => undefined,
      clearRevokedTenant: async () => undefined,
    });

    current = subject(7, 22, 2);
    coordinator.begin(current);
    current = subject(7, 11, 3);
    const currentA = coordinator.begin(current);
    releaseOldA.resolve([institution(11), institution(22)]);

    await expect(oldAttempt).resolves.toEqual({ status: "STALE" });
    await expect(
      runTenantAuthorizationAttempt({
        coordinator,
        ticket: currentA,
        currentSubject: () => current,
        loadInstitutions: async () => [institution(11), institution(22)],
        loadCurrentTenantAuthority: async () => undefined,
        clearRevokedTenant: async () => undefined,
      }),
    ).resolves.toMatchObject({ status: "VERIFIED" });
  });

  it("resposta da sessão A não admite a sessão B", async () => {
    const coordinator = new TenantAuthorizationCoordinator();
    let current = subject(7, 11, 1);
    const ticketA = coordinator.begin(current);
    const allowlistA = deferred<readonly AuthorizedInstitution[]>();
    const attemptA = runTenantAuthorizationAttempt({
      coordinator,
      ticket: ticketA,
      currentSubject: () => current,
      loadInstitutions: () => allowlistA.promise,
      loadCurrentTenantAuthority: async () => undefined,
      clearRevokedTenant: async () => undefined,
    });
    current = subject(8, 11, 1);
    coordinator.begin(current);
    allowlistA.resolve([institution(11)]);
    await expect(attemptA).resolves.toEqual({ status: "STALE" });
  });

  it("downgrade institucional rejeita capabilities/scope gerenciais stale", () => {
    const membership = institution(11, "USER");
    expect(
      tenantAuthorityMatchesMembership({
        institutionId: 11,
        membership,
        capabilities: {
          institutionId: 11,
          roleInInstitution: "GESTOR_PLUS",
          isGlobalAdmin: false,
        },
        managerScope: { role: "GESTOR_PLUS" },
      }),
    ).toBe(false);
    expect(
      tenantAuthorityMatchesMembership({
        institutionId: 11,
        membership,
        capabilities: {
          institutionId: 11,
          roleInInstitution: "USER",
          isGlobalAdmin: false,
        },
        managerScope: { role: "USER" },
      }),
    ).toBe(true);
  });

  it("push A sob B atravessa o gate sem perder navegação e só libera UI após attestation A", async () => {
    vi.resetModules();
    vi.doMock("expo-router", () => ({ useRouter: vi.fn() }));
    vi.doMock("expo-notifications", () => ({
      setNotificationHandler: vi.fn(),
      addNotificationResponseReceivedListener: vi.fn(),
    }));
    vi.doMock("@/hooks/use-auth", () => ({ useAuth: vi.fn() }));
    vi.doMock("@/hooks/use-notifications", () => ({
      useNotifications: vi.fn(),
    }));
    vi.doMock("@/lib/tenant-state", () => ({
      getActiveTenantSnapshot: vi.fn(),
      useTenantState: vi.fn(),
    }));
    vi.doMock("@/lib/trpc", () => ({ trpc: {} }));
    const { routeNotificationData } =
      await import("../components/NotificationListener");
    const coordinator = new TenantAuthorizationCoordinator();
    let activeTenant = { institutionId: 22, revision: 4 };
    let childrenReleased = true;
    let gateAttempt: Promise<unknown> | undefined;
    const allowHandshakeA = deferred<readonly AuthorizedInstitution[]>();
    const navigate = vi.fn(() => {
      expect(childrenReleased).toBe(false);
    });

    const routed = routeNotificationData(
      {
        type: "duty_confirmation",
        institutionId: 11,
        confirmationToken: "push-a",
      },
      {
        isSessionAuthorizationCurrent: () => true,
        getActiveTenantSnapshot: () => activeTenant,
        loadAllowedInstitutionIds: async () => [11, 22],
        setActiveInstitutionId: async (institutionId) => {
          childrenReleased = false;
          activeTenant = { institutionId, revision: activeTenant.revision + 1 };
          const current = subject(7, institutionId, activeTenant.revision);
          const ticket = coordinator.begin(current);
          gateAttempt = runTenantAuthorizationAttempt({
            coordinator,
            ticket,
            currentSubject: () =>
              subject(7, activeTenant.institutionId, activeTenant.revision),
            loadInstitutions: () => allowHandshakeA.promise,
            loadCurrentTenantAuthority: async () => undefined,
            clearRevokedTenant: async () => undefined,
          }).then((result) => {
            if (result.status === "VERIFIED") childrenReleased = true;
          });
        },
        invalidateQueries: async () => undefined,
        navigateToConfirmation: navigate,
        navigateToAgenda: vi.fn(),
        openComunica: vi.fn(async () => ({ ok: true })),
      },
    );

    await expect(routed).resolves.toBe(true);
    expect(navigate).toHaveBeenCalledWith("push-a");
    expect(childrenReleased).toBe(false);
    allowHandshakeA.resolve([institution(11), institution(22)]);
    await gateAttempt;
    expect(childrenReleased).toBe(true);
  });
});
