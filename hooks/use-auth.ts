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
import { clearPersistedQueryCache } from "@/lib/query-persist";
import { onSessionUnauthorized } from "@/lib/session-events";
import { useQueryClient } from "@tanstack/react-query";
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
  // Cache de consultas em memória: zerado no login e no logout, aqui, e
  // não no AuthGuard — o guard é REMONTADO a cada troca de usuário
  // (TenantScope) e nunca via a transição.
  const queryClient = useQueryClient();

  // Encerra a sessão LOCAL por completo: instituição ativa, cache
  // persistido em disco, cache em memória, usuário em cache e estado.
  // Usado pelo logout e por sessão revogada — o cache de um usuário que
  // já não tem sessão não pode sobrar no aparelho.
  const endSession = useCallback(async () => {
    await Auth.removeSessionToken();
    await Auth.clearUserInfo();
    await clearActiveInstitutionId();
    await clearPersistedQueryCache();
    queryClient.clear();
    setUser(null);
  }, [queryClient]);

  const refetch = useCallback(async () => {
    try {
      const result = await authApi.meDetailed();
      if (result.user) {
        setUser(result.user);
        await Auth.setUserInfo(result.user);
      } else if (result.sessionInvalid) {
        // Sessão realmente expirada/revogada: desloga e limpa TUDO.
        await endSession();
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
  }, [endSession]);

  // Qualquer UNAUTHORIZED do tRPC (ver lib/session-events.ts) revalida a
  // sessão — no máximo uma vez a cada 10 s, para um lote de consultas
  // falhando junto não virar dez chamadas a /me.
  useEffect(() => {
    let lastCheck = 0;
    return onSessionUnauthorized(() => {
      const now = Date.now();
      if (now - lastCheck < 10_000) return;
      lastCheck = now;
      void refetch();
    });
  }, [refetch]);

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
          // Revalida em segundo plano SEM bloquear a interface: só um
          // 401/403 real (senha trocada, sessão revogada, conta excluída)
          // desloga; falha de rede/cold start mantém o cache. Antes, o
          // cache nunca era revalidado — uma sessão revogada (B3) seguia
          // "logada" no aparelho até cada tela falhar por conta própria.
          void refetch();
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
        // Limpa ANTES de publicar o usuário: o TenantScope remonta no
        // setUser e hidrataria a instituição da sessão anterior.
        queryClient.clear();
        await clearActiveInstitutionId();
        await Auth.setUserInfo(result.user);
        setUser(result.user);
      }
      return result.ok
        ? { ok: true }
        : { ok: false, error: result.error };
    },
    [queryClient],
  );

  const logout = useCallback(async () => {
    await authApi.logout(getLastPushToken());
    setLastPushToken(null);
    await endSession();
  }, [endSession]);

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
