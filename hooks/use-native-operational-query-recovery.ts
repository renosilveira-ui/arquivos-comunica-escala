import NetInfo from "@react-native-community/netinfo";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef } from "react";
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
  const hasFocusedRef = useRef(false);

  useFocusEffect(
    useCallback(() => {
      const shouldRefreshOnFocus = shouldRefreshOperationalQueriesOnNativeFocus(
        {
          platform: Platform.OS,
          hasFocusedBefore: hasFocusedRef.current,
        },
      );
      hasFocusedRef.current = true;
      if (Platform.OS === "web") {
        return undefined;
      }

      const lease = captureLease();
      if (!lease) return undefined;

      // A montagem inicial já dispara as queries do React Query. Invalidá-las
      // aqui duplicava todas as chamadas; a reconciliação por foco começa
      // somente quando o usuário volta à tela.
      if (shouldRefreshOnFocus) {
        void refresh(lease);
      }

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
