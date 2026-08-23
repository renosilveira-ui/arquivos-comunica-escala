// hooks/use-auth.ts — estado de autenticação COMPARTILHADO via Context.
//
// A versão anterior era um hook com useState local: CADA componente que
// chamava useAuth() tinha sua PRÓPRIA cópia de `user`. Ao logar, a tela
// de login atualizava a cópia dela, mas o AuthGuard (montado no root
// layout) continuava com user=null e redirecionava de volta pro /login
// — bounce reproduzido no web em 2026-08-19. O mesmo defeito deixava
// telas com estados de sessão divergentes entre si.
//
// Agora o estado vive UMA vez no AuthProvider (root layout); useAuth()
// consome o contexto. A API pública do hook é idêntica à anterior.

import { getLastPushToken, setLastPushToken } from "@/lib/push-token";
import { authApi, type AuthUser } from "@/lib/_core/api";
import * as Auth from "@/lib/_core/auth";
import { clearActiveInstitutionId } from "@/lib/tenant-state";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Platform } from "react-native";

export type { AuthUser as User };

type AuthContextValue = {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
  refetch: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
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
    await authApi.logout(getLastPushToken());
    setLastPushToken(null);
    await Auth.removeSessionToken();
    await Auth.clearUserInfo();
    await clearActiveInstitutionId();
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading,
      isAuthenticated: Boolean(user),
      login,
      logout,
      refetch,
    }),
    [user, isLoading, login, logout, refetch],
  );

  return createElement(AuthContext.Provider, { value }, children);
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
