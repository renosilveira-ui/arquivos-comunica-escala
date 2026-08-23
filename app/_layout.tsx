import "@/global.css";
import { theme } from "@/lib/theme";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Redirect, Stack, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import "react-native-reanimated";
import { ActivityIndicator, Platform, Text, TouchableOpacity, View } from "react-native";
import "@/lib/_core/nativewind-pressable";
import { ThemeProvider } from "@/lib/theme-provider";
import {
  SafeAreaFrameContext,
  SafeAreaInsetsContext,
  SafeAreaProvider,
  initialWindowMetrics,
} from "react-native-safe-area-context";
import type { EdgeInsets, Metrics, Rect } from "react-native-safe-area-context";

import { trpc, createTRPCClient } from "@/lib/trpc";
import { initManusRuntime, subscribeSafeAreaInsets } from "@/lib/_core/manus-runtime";
import { TenantStateProvider, useTenantState } from "@/lib/tenant-state";
import { IntegrationManagerProvider } from "@/components/IntegrationManagerProvider";
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { NotificationListener } from "@/components/NotificationListener";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { ToastProvider } from "@/components/ui/Toast";
import { BootScreen } from "@/components/BootScreen";
import { startQueryCachePersistence } from "@/lib/query-persist";
import { emitSessionUnauthorized, isUnauthorizedError } from "@/lib/session-events";
import Constants from "expo-constants";

const DEFAULT_WEB_INSETS: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 };
const DEFAULT_WEB_FRAME: Rect = { x: 0, y: 0, width: 0, height: 0 };

/**
 * Tela de bloqueio para contas do auto-cadastro ainda não aprovadas
 * pelo gestor. "Verificar novamente" refaz o /me — quando o admin
 * aprovar, o approvalStatus muda e o app libera.
 */
function PendingApprovalScreen() {
  const { logout, refetch } = useAuth();

  return (
    <View
      style={{
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: theme.colors.background,
        padding: theme.space[6],
        gap: theme.space[4],
      }}
    >
      <Text
        style={{
          color: theme.colors.textPrimary,
          fontSize: 20,
          fontWeight: "700",
          textAlign: "center",
        }}
      >
        Aguardando aprovação
      </Text>
      <Text
        style={{
          color: theme.colors.textSecondary,
          fontSize: 14,
          textAlign: "center",
          lineHeight: 20,
        }}
      >
        Sua conta foi criada e está aguardando aprovação do gestor da
        instituição. Você receberá acesso assim que for aprovado.
      </Text>
      <TouchableOpacity
        onPress={() => refetch()}
        activeOpacity={0.8}
        style={{
          paddingHorizontal: theme.space[5],
          paddingVertical: theme.space[3],
          borderRadius: theme.radius.md,
          backgroundColor: theme.colors.primary,
        }}
      >
        <Text style={{ color: theme.colors.surface, fontWeight: "600" }}>
          Verificar novamente
        </Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={() => logout()} activeOpacity={0.7}>
        <Text
          style={{
            color: theme.colors.textMuted,
            fontSize: 13,
            textDecorationLine: "underline",
          }}
        >
          Sair
        </Text>
      </TouchableOpacity>
    </View>
  );
}

/** Handles auth-gated navigation. Must be rendered inside providers. */
function AuthGuard() {
  const { user } = useAuth();
  const pathname = usePathname();
  const {
    activeInstitutionId,
    isHydrating: isHydratingTenant,
    setActiveInstitutionId,
    clearInstitutionSelection,
  } = useTenantState();

  // O cache em memória é zerado no login e no logout (hooks/use-auth.ts).
  // O invalidateQueries() que rodava aqui a cada mudança de usuário
  // cancelava e reenviava o lote de abertura inteiro na hidratação do
  // cache local — duas requisições idênticas a cada boot, as duas presas
  // atrás do cold start do servidor (logs do Render, 23/08).
  const hasCachedTenant = activeInstitutionId !== null;

  const {
    data: institutions,
    isLoading: institutionsLoading,
    isError: institutionsError,
    refetch: refetchInstitutions,
  } = trpc.professionals.listMyInstitutions.useQuery(undefined, {
    enabled: !!user,
    // Cold start do Render free leva 30-60s: retries com backoff seguram
    // a maior parte; o resto cai na tela de reconexão abaixo.
    retry: 3,
    retryDelay: (attempt) => Math.min(2000 * 2 ** attempt, 15000),
  });

  useEffect(() => {
    if (!user || institutionsLoading || !institutions || activeInstitutionId) return;
    if (institutions.length === 1) {
      void setActiveInstitutionId(institutions[0].id);
    }
  }, [activeInstitutionId, institutions, institutionsLoading, setActiveInstitutionId, user]);

  // Resposta REAL do servidor diz que a instituição em cache já não é do
  // usuário (desvinculado, desativada): limpa a seleção e o guard abaixo
  // manda para a escolha de instituição.
  useEffect(() => {
    if (!user || !institutions || activeInstitutionId === null) return;
    if (!institutions.some((i) => i.id === activeInstitutionId)) {
      void clearInstitutionSelection();
    }
  }, [activeInstitutionId, clearInstitutionSelection, institutions, user]);

  // Com usuário E instituição em cache, a interface NÃO espera o servidor:
  // a Agenda pinta com o último estado conhecido (cache persistido, ver
  // lib/query-persist.ts) e revalida em segundo plano. Só bloqueia quem
  // ainda não tem contexto (primeiro acesso, pós-logout, sem instituição).
  // (`isLoading` do auth já é tratado em TenantScope: o guard só monta
  // com o usuário conhecido.)
  if (isHydratingTenant || (!!user && institutionsLoading && !hasCachedTenant)) {
    return <BootScreen />;
  }

  if (!user) {
    // Rotas públicas: login, auto-cadastro e recuperação de senha.
    // /ui-preview é a galeria do sistema de UI — só em desenvolvimento.
    if (
      pathname === "/signup" ||
      pathname === "/forgot-password" ||
      pathname === "/reset-password" ||
      (__DEV__ && pathname === "/ui-preview")
    ) {
      return null;
    }
    return <Redirect href="/login" />;
  }

  // Conta pendente de aprovação (auto-cadastro): bloqueia o app inteiro
  // até o gestor aprovar. Precisa vir ANTES da lógica de instituições —
  // o vínculo do pendente é inativo e cairia no "sem instituições".
  if (user.approvalStatus === "PENDING") {
    return <PendingApprovalScreen />;
  }

  // Senha temporária definida pelo admin: obriga a troca antes de
  // qualquer outra tela (mesmo padrão do PENDING — vem antes da lógica
  // de instituições). change-password refaz o /me e libera o app.
  if (user.mustChangePassword && pathname !== "/change-password") {
    return <Redirect href="/change-password" />;
  }

  // Falha de REDE ao listar instituições (ex.: staging hibernado
  // acordando) NÃO pode ser tratada como "sem instituições" — antes
  // disso, o guard expulsava o usuário logado pro login/seleção toda
  // vez que o servidor demorava. Sem instituição em cache, mostra
  // reconexão com retry; com cache, o app segue e revalida depois.
  if (institutionsError && !hasCachedTenant) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: theme.colors.background,
          padding: theme.space[6],
          gap: theme.space[4],
        }}
      >
        <ActivityIndicator size="large" color={theme.colors.primary} />
        <Text
          style={{
            color: theme.colors.textPrimary,
            fontSize: 16,
            fontWeight: "600",
            textAlign: "center",
          }}
        >
          Conectando ao servidor…
        </Text>
        <Text
          style={{
            color: theme.colors.textSecondary,
            fontSize: 13,
            textAlign: "center",
          }}
        >
          O primeiro acesso pode levar até um minuto.
        </Text>
        <TouchableOpacity
          onPress={() => refetchInstitutions()}
          activeOpacity={0.8}
          style={{
            paddingHorizontal: theme.space[5],
            paddingVertical: theme.space[3],
            borderRadius: theme.radius.md,
            backgroundColor: theme.colors.primary,
          }}
        >
          <Text style={{ color: theme.colors.surface, fontWeight: "600" }}>Tentar novamente</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // "Sem instituições" só é decisão válida com resposta REAL do servidor.
  const hasInstitutions = (institutions?.length ?? 0) > 0;
  if (institutions && !hasInstitutions) {
    return <Redirect href="/login" />;
  }

  if (!activeInstitutionId && pathname !== "/select-institution") {
    return <Redirect href={"/select-institution" as any} />;
  }

  if (activeInstitutionId && pathname === "/select-institution") {
    return <Redirect href="/(tabs)" />;
  }

  return null;
}

export const unstable_settings = {
  anchor: "(tabs)",
};

/**
 * O estado do tenant vive por usuário: ao trocar de conta (logout/login) o
 * provider é REMONTADO e re-hidrata do storage já limpo. Antes, o contexto
 * guardava a instituição do usuário anterior — o AuthGuard pulava a
 * seleção e a UI apontava para um tenant que o novo usuário nem tinha
 * (auditoria 22/08, parte 2).
 */
function TenantScope({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  // Só monta a árvore (Stack, guard, listeners) quando já se sabe quem é
  // o usuário. Antes, o provider nascia como "anon" e era REMONTADO meio
  // segundo depois com o id vindo do cache local — o navigator inteiro
  // montava duas vezes a cada abertura do app.
  if (isLoading) return <BootScreen />;
  return (
    <TenantStateProvider key={user?.id ?? "anon"}>
      <QueryCachePersistence />
      {children}
    </TenantStateProvider>
  );
}

/**
 * Liga o cache persistido do react-query ao par usuário + instituição
 * ativos (chave própria no disco; trocar qualquer um dos dois desliga o
 * anterior e restaura o certo). É o que faz a Agenda abrir na hora mesmo
 * com o servidor dormindo.
 */
function QueryCachePersistence() {
  const { user } = useAuth();
  const { activeInstitutionId } = useTenantState();
  const queryClient = useQueryClient();
  const userId = user?.id ?? null;
  const prevContext = useRef<string | null>(null);

  useEffect(() => {
    if (userId === null || activeInstitutionId === null) return;
    const context = `${userId}:${activeInstitutionId}`;
    if (prevContext.current !== null && prevContext.current !== context) {
      // Trocou de instituição com as telas montadas: as consultas não
      // levam o tenant na chave, então zera os dados da anterior e refaz
      // as ativas — senão a Agenda mostrava a instituição antiga até o
      // próximo refetch (e o cache dela seria gravado na chave da nova).
      void queryClient.resetQueries();
    }
    prevContext.current = context;
    return startQueryCachePersistence({
      queryClient,
      userId,
      institutionId: activeInstitutionId,
      buster: Constants.expoConfig?.version ?? "dev",
    });
  }, [activeInstitutionId, queryClient, userId]);

  return null;
}

export default function RootLayout() {
  const initialInsets = initialWindowMetrics?.insets ?? DEFAULT_WEB_INSETS;
  const initialFrame = initialWindowMetrics?.frame ?? DEFAULT_WEB_FRAME;

  const [insets, setInsets] = useState<EdgeInsets>(initialInsets);
  const [frame, setFrame] = useState<Rect>(initialFrame);

  // Initialize Manus runtime for cookie injection from parent container
  useEffect(() => {
    initManusRuntime();
  }, []);

  const handleSafeAreaUpdate = useCallback((metrics: Metrics) => {
    setInsets(metrics.insets);
    setFrame(metrics.frame);
  }, []);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const unsubscribe = subscribeSafeAreaInsets(handleSafeAreaUpdate);
    return () => unsubscribe();
  }, [handleSafeAreaUpdate]);

  // Create clients once and reuse them
  const [queryClient] = useState(
    () =>
      new QueryClient({
        // Sessão revogada não pode ficar escondida atrás do cache: qualquer
        // UNAUTHORIZED dispara a revalidação em /api/auth/me (use-auth).
        queryCache: new QueryCache({
          onError: (error) => {
            if (isUnauthorizedError(error)) emitSessionUnauthorized();
          },
        }),
        mutationCache: new MutationCache({
          onError: (error) => {
            if (isUnauthorizedError(error)) emitSessionUnauthorized();
          },
        }),
        defaultOptions: {
          queries: {
            // Disable automatic refetching on window focus for mobile
            refetchOnWindowFocus: false,
            // Retry failed requests once
            retry: 1,
          },
        },
      }),
  );
  const [trpcClient] = useState(() => createTRPCClient());

  // Ensure minimum 8px padding for top and bottom on mobile
  const providerInitialMetrics = useMemo(() => {
    const metrics = initialWindowMetrics ?? { insets: initialInsets, frame: initialFrame };
    return {
      ...metrics,
      insets: {
        ...metrics.insets,
        top: Math.max(metrics.insets.top, 16),
        bottom: Math.max(metrics.insets.bottom, 12),
      },
    };
  }, [initialInsets, initialFrame]);

  const content = (
    <AppErrorBoundary>
    <GestureHandlerRootView style={{ flex: 1 }}>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
          <ToastProvider>
          <TenantScope>
            <IntegrationManagerProvider>
          {/* Default to hiding native headers so raw route segments don't appear (e.g. "(tabs)", "products/[id]"). */}
          {/* If a screen needs the native header, explicitly enable it and set a human title via Stack.Screen options. */}
          {/* in order for ios apps tab switching to work properly, use presentation: "fullScreenModal" for login page, whenever you decide to use presentation: "modal*/}
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="login" options={{ presentation: "fullScreenModal", animation: "fade" }} />
            <Stack.Screen name="signup" options={{ presentation: "fullScreenModal", animation: "fade" }} />
            <Stack.Screen name="forgot-password" options={{ presentation: "fullScreenModal", animation: "fade" }} />
            <Stack.Screen name="reset-password" options={{ presentation: "fullScreenModal", animation: "fade" }} />
            <Stack.Screen name="select-institution" options={{ presentation: "fullScreenModal", animation: "fade" }} />
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="oauth/callback" />
          </Stack>
          <AuthGuard />
          <StatusBar style="auto" />
          <NotificationListener />
            </IntegrationManagerProvider>
          </TenantScope>
          </ToastProvider>
          </AuthProvider>
        </QueryClientProvider>
      </trpc.Provider>
    </GestureHandlerRootView>
    </AppErrorBoundary>
  );

  const shouldOverrideSafeArea = Platform.OS === "web";

  if (shouldOverrideSafeArea) {
    return (
      <ThemeProvider>
        <SafeAreaProvider initialMetrics={providerInitialMetrics}>
          <SafeAreaFrameContext.Provider value={frame}>
            <SafeAreaInsetsContext.Provider value={insets}>
              {content}
            </SafeAreaInsetsContext.Provider>
          </SafeAreaFrameContext.Provider>
        </SafeAreaProvider>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <SafeAreaProvider initialMetrics={providerInitialMetrics}>{content}</SafeAreaProvider>
    </ThemeProvider>
  );
}
