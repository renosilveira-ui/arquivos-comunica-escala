import NetInfo from "@react-native-community/netinfo";
import { useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { Platform } from "react-native";
import {
  isOperationalNetworkOnline,
  shouldRefreshOperationalQueriesOnNativeFocus,
  shouldRefreshOperationalQueriesOnNativeReconnect,
} from "@/lib/operational-query-refresh";
import type { OperationalQueryRefreshLease } from "@/hooks/use-operational-query-refresh";

/**
 * Recuperação limitada à tela operacional que está visível. Não altera as
 * políticas globais de React Query nem revalida sessão; apenas reconcilia
 * leituras já autorizadas sob uma lease de usuário + tenant capturada no foco.
 */
export function useNativeOperationalQueryRecovery({
  captureLease,
  refresh,
}: {
  captureLease: () => OperationalQueryRefreshLease | null;
  refresh: (lease: OperationalQueryRefreshLease) => Promise<boolean>;
}) {
  useFocusEffect(
    useCallback(() => {
      if (!shouldRefreshOperationalQueriesOnNativeFocus(Platform.OS)) {
        return undefined;
      }

      const lease = captureLease();
      if (!lease) return undefined;

      void refresh(lease);

      let networkStateKnown = false;
      let wasExplicitlyOffline = false;
      const unsubscribe = NetInfo.addEventListener((state) => {
        const isOnline = isOperationalNetworkOnline(state);
        const shouldRefresh =
          networkStateKnown &&
          shouldRefreshOperationalQueriesOnNativeReconnect({
            platform: Platform.OS,
            wasExplicitlyOffline,
            isOnline,
          });
        networkStateKnown = true;
        wasExplicitlyOffline = !isOnline;

        if (shouldRefresh) {
          void refresh(lease);
        }
      });

      return () => unsubscribe();
    }, [captureLease, refresh]),
  );
}
