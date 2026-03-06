import * as Api from "@/lib/_core/api";
import * as Auth from "@/lib/_core/auth";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";
import { useTestUserId } from "./use-test-user-id";

type UseAuthOptions = {
  autoFetch?: boolean;
};

export function useAuth(options?: UseAuthOptions) {
  const { autoFetch = true } = options ?? {};
  const testUserId = useTestUserId();

  // 🧪 Calcular fakeUser no início (sem early return para manter ordem dos hooks)
  const fakeUser =
    Platform.OS === "web" && testUserId !== null
      ? ({
          id: testUserId,
          openId: `test-${testUserId}`,
          name: `Test User ${testUserId}`,
          email: `test${testUserId}@example.com`,
          loginMethod: "test",
          lastSignedIn: new Date(),
        } as Auth.User)
      : null;

  if (fakeUser) {
    console.log("[useAuth] 🧪 TEST MODE ACTIVATED", fakeUser);
  }

  const [user, setUser] = useState<Auth.User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // 🔍 LOG DEBUG OBRIGATÓRIO
  console.log("[useAuth] DEBUG", { testUserId, userId: user?.id });

  const fetchUser = useCallback(async () => {
    console.log("[useAuth] fetchUser called");
    try {
      setLoading(true);
      setError(null);

      // Web platform: use cookie-based auth, fetch user from API
      if (Platform.OS === "web") {
        console.log("[useAuth] Web platform: fetching user from API...");
        
        // MODO DE TESTE: Se testUserId presente, criar usuário fake (bypass de autenticação)
        if (testUserId !== null) {
          console.log(`[useAuth] 🧪 MODO DE TESTE: Criando usuário fake com userId=${testUserId}`);
          const fakeUser: Auth.User = {
            id: testUserId,
            openId: `test-${testUserId}`,
            name: `Test User ${testUserId}`,
            email: `test${testUserId}@example.com`,
            loginMethod: "test",
            lastSignedIn: new Date(),
          };
          setUser(fakeUser);
          await Auth.setUserInfo(fakeUser);
          console.log("[useAuth] 🧪 Usuário fake criado:", fakeUser);
          return;
        }
        
        const apiUser = await Api.getMe();
        console.log("[useAuth] API user response:", apiUser);

        if (apiUser) {
          const userInfo: Auth.User = {
            id: apiUser.id,
            openId: apiUser.openId,
            name: apiUser.name,
            email: apiUser.email,
            loginMethod: apiUser.loginMethod,
            lastSignedIn: new Date(apiUser.lastSignedIn),
          };
          setUser(userInfo);
          // Cache user info in localStorage for faster subsequent loads
          await Auth.setUserInfo(userInfo);
          console.log("[useAuth] Web user set from API:", userInfo);
        } else {
          console.log("[useAuth] Web: No authenticated user from API");
          setUser(null);
          await Auth.clearUserInfo();
        }
        return;
      }

      // Native platform: use token-based auth
      console.log("[useAuth] Native platform: checking for session token...");
      const sessionToken = await Auth.getSessionToken();
      console.log(
        "[useAuth] Session token:",
        sessionToken ? `present (${sessionToken.substring(0, 20)}...)` : "missing",
      );
      if (!sessionToken) {
        console.log("[useAuth] No session token, setting user to null");
        setUser(null);
        return;
      }

      // Use cached user info for native (token validates the session)
      const cachedUser = await Auth.getUserInfo();
      console.log("[useAuth] Cached user:", cachedUser);
      if (cachedUser) {
        console.log("[useAuth] Using cached user info");
        setUser(cachedUser);
      } else {
        console.log("[useAuth] No cached user, setting user to null");
        setUser(null);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Failed to fetch user");
      console.error("[useAuth] fetchUser error:", error);
      setError(error);
      setUser(null);
    } finally {
      setLoading(false);
      console.log("[useAuth] fetchUser completed, loading:", false);
    }
  }, [testUserId]);

  const logout = useCallback(async () => {
    try {
      await Api.logout();
    } catch (err) {
      console.error("[Auth] Logout API call failed:", err);
      // Continue with logout even if API call fails
    } finally {
      await Auth.removeSessionToken();
      await Auth.clearUserInfo();
      setUser(null);
      setError(null);
    }
  }, []);

  const isAuthenticated = useMemo(() => Boolean(user), [user]);

  // ❌ useEffect de modo de teste REMOVIDO (substituído por early return no início do hook)

  useEffect(() => {
    console.log("[useAuth] useEffect triggered, autoFetch:", autoFetch, "platform:", Platform.OS);

    // ✅ Se test mode ativo, NÃO chama fetchUser (prioridade absoluta)
    if (Platform.OS === "web" && testUserId !== null) {
      console.log("[useAuth] 🧪 TEST MODE DETECTED - skipping API fetch");
      return;
    }

    if (autoFetch) {
      if (Platform.OS === "web") {
        // Web: fetch user from API directly (user will login manually if needed)
        console.log("[useAuth] Web: fetching user from API...");
        fetchUser();
      } else {
        // Native: check for cached user info first for faster initial load
        Auth.getUserInfo().then((cachedUser) => {
          console.log("[useAuth] Native cached user check:", cachedUser);
          if (cachedUser) {
            console.log("[useAuth] Native: setting cached user immediately");
            setUser(cachedUser);
            setLoading(false);
          } else {
            // No cached user, check session token
            fetchUser();
          }
        });
      }
    } else {
      console.log("[useAuth] autoFetch disabled, setting loading to false");
      setLoading(false);
    }
  }, [autoFetch, fetchUser, testUserId]);

  useEffect(() => {
    console.log("[useAuth] State updated:", {
      hasUser: !!user,
      loading,
      isAuthenticated,
      error: error?.message,
    });
  }, [user, loading, isAuthenticated, error]);

  // 🧪 Usar fakeUser se presente, caso contrário usar user real
  const effectiveUser = fakeUser ?? user;
  const effectiveLoading = fakeUser ? false : loading;
  const effectiveError = fakeUser ? null : error;

  return {
    user: effectiveUser,
    loading: effectiveLoading,
    error: effectiveError,
    isAuthenticated: Boolean(effectiveUser),
    refresh: fakeUser ? async () => {} : fetchUser,
    logout: fakeUser ? async () => {} : logout,
  };
}
