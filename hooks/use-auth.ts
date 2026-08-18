import { authApi, type AuthUser } from "@/lib/_core/api";
import * as Auth from "@/lib/_core/auth";
import { clearActiveInstitutionId } from "@/lib/tenant-state";
import { useCallback, useEffect, useState } from "react";
import { Platform } from "react-native";

export type { AuthUser as User };

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    try {
      const result = await authApi.meDetailed();
      if (result.user) {
        setUser(result.user);
        await Auth.setUserInfo(result.user);
      } else if (result.sessionInvalid) {
        // Sessão realmente expirada/revogada: desloga e limpa cache.
        setUser(null);
        await Auth.clearUserInfo();
      } else {
        // Falha de rede/servidor (ex.: cold start do Render): NÃO
        // deslogar — mantém o usuário do cache local. Antes disso,
        // qualquer timeout expulsava o usuário logado e apagava o
        // SecureStore ("volta pra seleção/login sozinho").
        console.warn("[Auth] me() falhou por rede/servidor — mantendo sessão em cache");
      }
    } catch {
      // Erro inesperado: também não desloga — só rede confirmada 401 desloga.
      console.warn("[Auth] me() lançou erro — mantendo sessão em cache");
    } finally {
      setIsLoading(false);
    }
  }, []);

  // On mount: check existing session (cookie on web, SecureStore on native)
  useEffect(() => {
    if (Platform.OS === "web") {
      // Web: cookie is sent automatically — just hit /api/auth/me
      refetch();
    } else {
      // Native: restore from SecureStore cache first, then validate with server
      Auth.getUserInfo().then((cached) => {
        if (cached) {
          setUser(cached);
          setIsLoading(false);
        } else {
          refetch();
        }
      });
    }
  }, [refetch]);

  const login = useCallback(
    async (
      email: string,
      password: string,
    ): Promise<{ ok: boolean; error?: string }> => {
      const result = await authApi.login(email, password);
      if (result.ok && result.user) {
        setUser(result.user);
        await Auth.setUserInfo(result.user);
        await clearActiveInstitutionId();
      }
      return result.ok
        ? { ok: true }
        : { ok: false, error: result.error };
    },
    [],
  );

  const logout = useCallback(async () => {
    await authApi.logout();
    await Auth.removeSessionToken();
    await Auth.clearUserInfo();
    await clearActiveInstitutionId();
    setUser(null);
  }, []);

  return {
    user,
    isLoading,
    isAuthenticated: Boolean(user),
    login,
    logout,
    refetch,
  };
}
