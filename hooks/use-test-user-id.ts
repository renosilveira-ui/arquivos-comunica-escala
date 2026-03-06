import { useEffect, useState } from "react";
import { Platform } from "react-native";

/**
 * Hook para extrair testUserId da URL
 * 
 * Uso: ?testUserId=30001
 * 
 * Segurança:
 * - Permitido quando EXPO_PUBLIC_ENABLE_TEST_MODE=true OU hostname.endsWith(".manus.computer")
 * - Bloqueado em domínio real de produção (ex: comunica+.com.br)
 */
export function useTestUserId(): number | null {
  const [testUserId, setTestUserId] = useState<number | null>(null);

  useEffect(() => {
    // Verificar se modo de teste está habilitado via env (NEXT_PUBLIC_ ou EXPO_PUBLIC_)
    const enableTestMode = 
      process.env.NEXT_PUBLIC_ENABLE_TEST_MODE === "true" ||
      process.env.EXPO_PUBLIC_ENABLE_TEST_MODE === "true";
    
    // Verificar se está em preview do Manus (hostname.endsWith(".manus.computer"))
    const isManusPreview = Platform.OS === "web" && 
      typeof window !== "undefined" && 
      window.location.hostname.endsWith(".manus.computer");
    
    // Permitir modo de teste se ENABLE_TEST_MODE=true OU preview do Manus
    const isTestModeAllowed = enableTestMode || isManusPreview;
    
    if (!isTestModeAllowed) {
      console.log("[useTestUserId] Modo de teste BLOQUEADO (produção real)");
      setTestUserId(null);
      return;
    }
    
    console.log(`[useTestUserId] Modo de teste PERMITIDO (enableTestMode=${enableTestMode}, isManusPreview=${isManusPreview})`);

    // Apenas funciona na web (URL query params)
    if (Platform.OS !== "web") {
      console.log("[useTestUserId] Modo de teste disponível apenas na web");
      setTestUserId(null);
      return;
    }

    try {
      const STORAGE_KEY = "comunica_testUserId";
      const href = typeof window !== "undefined" ? window.location.href : "";

      // pega de qualquer lugar (query normal ou hash)
      const match = href.match(/[?&]testUserId=([^&#]+)/i);
      const rawFromUrl = match ? decodeURIComponent(match[1]).trim() : null;

      // fallback: último testUserId salvo (não perde em redirect/login)
      const rawFromStorage =
        typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;

      const finalRaw = rawFromUrl || rawFromStorage;

      if (finalRaw) {
        const parsedId = parseInt(finalRaw, 10);
        if (!isNaN(parsedId)) {
          console.log(`[useTestUserId] Modo de teste ativado: testUserId=${parsedId}`);
          setTestUserId(parsedId);
          // persistir para sobreviver a redirects
          if (typeof window !== "undefined") {
            window.localStorage.setItem(STORAGE_KEY, String(parsedId));
          }
        } else {
          console.warn(`[useTestUserId] testUserId inválido: ${finalRaw}`);
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
