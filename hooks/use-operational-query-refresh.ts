import { useCallback, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/hooks/use-auth";
import {
  getActiveTenantSnapshot,
  useTenantState,
} from "@/lib/tenant-state";
import {
  isCurrentOperationalQueryContext,
  type OperationalTenantSnapshot,
} from "@/lib/operational-query-refresh";

export type OperationalQueryRefreshLease = Readonly<{
  userId: number;
  tenant: OperationalTenantSnapshot;
}>;

/**
 * Revalida somente leituras operacionais depois que o caller provou que a
 * sessão e o tenant ainda são os mesmos. Nunca revalida /me e nunca limpa o
 * QueryClient: essas transições pertencem ao boundary de autorização.
 */
export function useOperationalQueryRefresh() {
  const { user, isSessionAuthorizationCurrent } = useAuth();
  const { activeInstitutionId, tenantRevision } = useTenantState();
  const utils = trpc.useUtils();

  const latestContextRef = useRef({
    userId: user?.id,
    activeInstitutionId,
    tenantRevision,
    isSessionAuthorizationCurrent,
  });
  latestContextRef.current = {
    userId: user?.id,
    activeInstitutionId,
    tenantRevision,
    isSessionAuthorizationCurrent,
  };

  const sessionIsAuthorized = useCallback((): boolean => {
    let sessionAuthorized = false;
    try {
      sessionAuthorized = latestContextRef.current.isSessionAuthorizationCurrent();
    } catch {
      return false;
    }
    return sessionAuthorized;
  }, []);

  /**
   * Captura a identidade que abriu a tela. O efeito de foco/rede só pode
   * invalidar enquanto esta mesma identidade e esta mesma revisão do tenant
   * continuarem vigentes; A → B → A não passa pela revisão.
   */
  const captureLease = useCallback((): OperationalQueryRefreshLease | null => {
    const context = latestContextRef.current;
    const userId = context.userId;
    const tenant = getActiveTenantSnapshot();
    if (
      typeof userId !== "number" ||
      !isCurrentOperationalQueryContext({
        userId,
        sessionAuthorized: sessionIsAuthorized(),
        expectedTenant: {
          institutionId: context.activeInstitutionId,
          revision: context.tenantRevision,
        },
        currentTenant: tenant,
      })
    ) {
      return null;
    }
    return {
      userId,
      tenant,
    };
  }, [sessionIsAuthorized]);

  const isLeaseCurrent = useCallback(
    (lease: OperationalQueryRefreshLease): boolean => {
      const context = latestContextRef.current;
      return (
        context.userId === lease.userId &&
        isCurrentOperationalQueryContext({
          userId: context.userId,
          sessionAuthorized: sessionIsAuthorized(),
          expectedTenant: lease.tenant,
          currentTenant: getActiveTenantSnapshot(),
        })
      );
    },
    [sessionIsAuthorized],
  );

  const refreshSwapQueries = useCallback(
    async (lease: OperationalQueryRefreshLease): Promise<boolean> => {
      if (!isLeaseCurrent(lease)) return false;
      await Promise.all([
        utils.swaps.countActionable.invalidate(),
        utils.swaps.listAvailable.invalidate(),
        utils.swaps.list.invalidate(),
      ]);
      return true;
    },
    [isLeaseCurrent, utils],
  );

  const refreshVacancyQueries = useCallback(
    async (lease: OperationalQueryRefreshLease): Promise<boolean> => {
      if (!isLeaseCurrent(lease)) return false;
      await Promise.all([
        utils.professionals.getByUserId.invalidate(),
        utils.professionals.getManagerScope.invalidate(),
        utils.hospitals.list.invalidate(),
        utils.sectors.list.invalidate(),
        utils.shiftInstances.listVacancies.invalidate(),
        utils.shiftAssignments.listPending.invalidate(),
        utils.filters.summaryCounts.invalidate(),
        utils.filters.actionableVacancyCounts.invalidate(),
        utils.shiftAssignments.listMyVacancyRequests.invalidate(),
      ]);
      return true;
    },
    [isLeaseCurrent, utils],
  );

  return {
    captureLease,
    isLeaseCurrent,
    refreshSwapQueries,
    refreshVacancyQueries,
  };
}
