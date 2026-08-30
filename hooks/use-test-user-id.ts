import { useEffect, useState } from "react";
import { Platform } from "react-native";
import { isTestModeEnabled } from "@/lib/test-mode";

/**
 * Hook para extrair testUserId da URL
 *
 * Uso: ?testUserId=30001
 *
 * Segurança:
 * - Permitido somente em __DEV__ com EXPO_PUBLIC_ENABLE_TEST_MODE=true
 * - Bloqueado em produção e em builds sem flag explícita
 */
export function useTestUserId(): number | null {
  const [testUserId, setTestUserId] = useState<number | null>(null);

  useEffect(() => {
    if (!isTestModeEnabled()) {
      setTestUserId(null);
      return;
    }

    if (Platform.OS !== "web") {
      setTestUserId(null);
      return;
    }

    try {
      const STORAGE_KEY = "comunica_testUserId";
      const href = typeof window !== "undefined" ? window.location.href : "";

      const match = href.match(/[?&]testUserId=([^&#]+)/i);
      const rawFromUrl = match ? decodeURIComponent(match[1]).trim() : null;

      const rawFromStorage =
        typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;

      const finalRaw = rawFromUrl || rawFromStorage;

      if (finalRaw) {
        const parsedId = parseInt(finalRaw, 10);
        if (!isNaN(parsedId)) {
          setTestUserId(parsedId);
          if (typeof window !== "undefined") {
            window.localStorage.setItem(STORAGE_KEY, String(parsedId));
          }
        } else {
          setTestUserId(null);
          if (typeof window !== "undefined") window.localStorage.removeItem(STORAGE_KEY);
        }
      } else {
        setTestUserId(null);
      }
    } catch (error) {
      console.error("[useTestUserId] Erro ao extrair testUserId:", error);
      setTestUserId(null);
    }
  }, []);

  return testUserId;
}
