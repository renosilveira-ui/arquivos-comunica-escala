import "@/global.css";
import { theme } from "@/lib/theme";
import { MutationCache, QueryCache, QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Redirect, Stack, usePathname, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import "react-native-reanimated";
import {
  ActivityIndicator,
  AppState,
  Platform,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import NetInfo from "@react-native-community/netinfo";
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
import {
  getActiveTenantSnapshot,
  TenantStateProvider,
  useTenantState,
} from "@/lib/tenant-state";
import { IntegrationManagerProvider } from "@/components/IntegrationManagerProvider";
import { AppErrorBoundary } from "@/components/AppErrorBoundary";
import { NotificationListener } from "@/components/NotificationListener";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { ToastProvider } from "@/components/ui/Toast";
import { BootScreen } from "@/components/BootScreen";
import {
  AUTHORIZATION_GATE_STALL_MS,
  REQUEST_DEADLINE_MS,
  isNetInfoOnline,
} from "@/lib/request-deadline";
import {
  fenceQueryCachePersistence,
  startQueryCachePersistence,
} from "@/lib/query-persist";
import {
  canStartTenantAuthorizationHandshake,
  runTenantAuthorizationAttempt,
  tenantAuthorityMatchesMembership,
  TenantAuthorizationCoordinator,
  transitionTenantAuthorizationActivity,
  type AuthorizedInstitution,
  type TenantAuthorizationActivity,
  type TenantAuthorizationReceipt,
  type TenantAuthorizationSubject,
} from "@/lib/tenant-authorization";
import { emitSessionUnauthorized, isUnauthorizedError } from "@/lib/session-events";
import { uiAlert } from "@/lib/ui/alert";
import { isSessionTerminationNotDurableError } from "@/lib/session-cleanup";
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
      <TouchableOpacity
        onPress={() => {
          void logout().catch((error) => {
            console.warn("[Auth] logout failed", error);
            if (isSessionTerminationNotDurableError(error)) {
              uiAlert(
                "Não foi possível sair com segurança",
                "A sessão continua aberta neste aparelho. Tente novamente em instantes.",
              );
            } else {
              uiAlert(
                "Sessão encerrada com limpeza incompleta",
                "Você saiu da conta, mas parte dos dados locais não pôde ser removida.",
              );
            }
          });
        }}
        activeOpacity={0.7}
      >
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

function WaitingForScheduleScreen() {
  const { logout } = useAuth();
  const router = useRouter();

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
        Aguardando convite da escala
      </Text>
      <Text
        style={{
          color: theme.colors.textSecondary,
          fontSize: 14,
          textAlign: "center",
          lineHeight: 20,
        }}
      >
        Sua conta está criada. O gestor vai enviar um convite de 24 horas,
        só seu, para o e-mail do cadastro.
      </Text>
      <TouchableOpacity
        onPress={() => router.push("/join-schedule")}
        activeOpacity={0.8}
        style={{
          paddingHorizontal: theme.space[5],
          paddingVertical: theme.space[3],
          borderRadius: theme.radius.md,
          backgroundColor: theme.colors.primary,
          minHeight: 44,
          justifyContent: "center",
        }}
      >
        <Text style={{ color: theme.colors.surface, fontWeight: "600" }}>
          Já tenho o convite
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={() => {
          void logout().catch((error) => {
            console.warn("[Auth] logout failed", error);
          });
        }}
        activeOpacity={0.7}
      >
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

type TenantAuthorizationAttestation = Readonly<{
  receipt: TenantAuthorizationReceipt;
  isCurrent: () => boolean;
}>;

const TenantAuthorizationContext = createContext<TenantAuthorizationAttestation | null>(null);

function AuthorizationUnavailableScreen({
  retry,
  title = "Conectando ao servidor…",
  body = "Não foi possível confirmar seu vínculo institucional. Nenhum dado local foi aberto.",
}: {
  retry: () => void;
  title?: string;
  body?: string;
}) {
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
        {title}
      </Text>
      <Text
        style={{
          color: theme.colors.textSecondary,
          fontSize: 13,
          textAlign: "center",
        }}
      >
        {body}
      </Text>
      <TouchableOpacity
        onPress={retry}
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

type AuthorizationGateState =
  | Readonly<{ status: "CHECKING"; subjectKey: string }>
  | Readonly<{ status: "UNAVAILABLE"; subjectKey: string }>
  | Readonly<{
      status: "VERIFIED";
      subjectKey: string;
      attestation: TenantAuthorizationAttestation;
    }>;

function subjectKeyOf(subject: TenantAuthorizationSubject): string {
  return `${subject.userId}:${subject.tenant.institutionId ?? "none"}:${subject.tenant.revision}`;
}

/**
 * Fronteira real do cache tenant-bound: nem Stack, nem integrações, nem o
 * restore montam antes de uma prova fresca de sessão + membership.
 */
function TenantAuthorizationBoundary({ children }: { children: React.ReactNode }) {
  const { user, refetch, sessionValidation } = useAuth();
  const {
    activeInstitutionId,
    tenantRevision,
    isHydrating,
    clearInstitutionSelection,
  } = useTenantState();
  const queryClient = useQueryClient();
  const utils = trpc.useUtils();
  const coordinatorRef = useRef(new TenantAuthorizationCoordinator());
  const currentSubjectRef = useRef<TenantAuthorizationSubject>({
    userId: -1,
    tenant: { institutionId: null, revision: -1 },
  });
  const initialActivity = useMemo<TenantAuthorizationActivity>(() => ({
    visible: Platform.OS === "web"
      ? typeof document === "undefined" || document.visibilityState !== "hidden"
      : AppState.currentState === "active",
    // Nativo: assume online até o NetInfo negar. Começar offline bloqueava o
    // handshake pós-login no Android enquanto o probe demorava ou falhava.
    online: Platform.OS === "web"
      ? typeof navigator === "undefined" || navigator.onLine
      : true,
    revision: 0,
  }), []);
  const activityRef = useRef(initialActivity);
  const [activity, setActivity] = useState(initialActivity);

  const currentSubject: TenantAuthorizationSubject = {
    userId: user?.id ?? -1,
    tenant: { institutionId: activeInstitutionId, revision: tenantRevision },
  };
  currentSubjectRef.current = currentSubject;
  const subjectKey = subjectKeyOf(currentSubject);
  const [gateState, setGateState] = useState<AuthorizationGateState>({
    status: "CHECKING",
    subjectKey,
  });
  const currentSessionProof = sessionValidation.status === "VERIFIED" &&
    user?.id === sessionValidation.userId &&
    sessionValidation.isCurrent()
    ? sessionValidation
    : null;
  const requiresHandshake = canStartTenantAuthorizationHandshake({
    user,
    sessionValidation,
  });

  const getCurrentSubject = useCallback((): TenantAuthorizationSubject => ({
    userId: currentSubjectRef.current.userId,
    // O módulo muda antes do React. Consultá-lo aqui fecha também a janela
    // entre a publicação B e o rerender do boundary.
    tenant: getActiveTenantSnapshot(),
  }), []);

  const updateActivity = useCallback((
    patch: Partial<Pick<TenantAuthorizationActivity, "visible" | "online">>,
  ) => {
    const transition = transitionTenantAuthorizationActivity(activityRef.current, patch);
    if (transition.action === "NONE") return;
    activityRef.current = transition.state;

    if (transition.action === "CLOSE") {
      // O evento de lifecycle fecha a autoridade antes do próximo paint.
      coordinatorRef.current.invalidate();
      fenceQueryCachePersistence();
      queryClient.clear();
      setGateState({
        status: "CHECKING",
        subjectKey: subjectKeyOf(currentSubjectRef.current),
      });
    } else if (transition.action === "REVALIDATE") {
      // Reconnect de rede exige /me fresco. Voltar à aba só reabre o handshake
      // institucional — refetch de sessão aqui derrubava VERIFIED em 401/abort
      // transitório ao trocar de aba por ~1s no desktop.
      if (patch.online === true) {
        void refetch();
      }
    }
    setActivity(transition.state);
  }, [queryClient, refetch]);

  useEffect(() => {
    // Sem polling contínuo: revogação ocorrida enquanto o app permanece
    // foreground/online segue bloqueada no backend por request. O residual
    // visual até um evento de lifecycle/rede fica explicitamente fora do SLA
    // desta frente; resume/reconnect sempre reatesta antes de reabrir a UI.
    const appStateSubscription = AppState.addEventListener("change", (nextState) => {
      updateActivity({ visible: nextState === "active" });
    });
    const netInfoUnsubscribe = NetInfo.addEventListener((state) => {
      updateActivity({
        online: isNetInfoOnline(state),
      });
    });
    void NetInfo.fetch().then((state) => {
      updateActivity({
        online: isNetInfoOnline(state),
      });
    }).catch(() => {
      // Probe falhou: mantém online otimista para não travar o handshake.
      updateActivity({ online: true });
    });

    const handleVisibility = () => {
      updateActivity({ visible: document.visibilityState !== "hidden" });
    };
    const handleOnline = () => updateActivity({ online: true });
    const handleOffline = () => updateActivity({ online: false });
    if (Platform.OS === "web" && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibility);
      globalThis.addEventListener?.("online", handleOnline);
      globalThis.addEventListener?.("offline", handleOffline);
    }

    return () => {
      appStateSubscription.remove();
      netInfoUnsubscribe();
      if (Platform.OS === "web" && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibility);
        globalThis.removeEventListener?.("online", handleOnline);
        globalThis.removeEventListener?.("offline", handleOffline);
      }
    };
  }, [updateActivity]);

  useEffect(() => {
    const coordinator = coordinatorRef.current;
    if (
      !requiresHandshake ||
      !currentSessionProof ||
      isHydrating ||
      !activity.visible ||
      !activity.online
    ) {
      coordinator.invalidate();
      fenceQueryCachePersistence();
      if (!user) {
        queryClient.clear();
      }
      setGateState((current) => {
        const nextStatus =
          user && sessionValidation.status === "UNAVAILABLE"
            ? "UNAVAILABLE"
            : "CHECKING";
        return current.subjectKey === subjectKey && current.status === nextStatus
          ? current
          : { status: nextStatus, subjectKey };
      });
      return;
    }

    const ticket = coordinator.begin(getCurrentSubject());
    let cancelled = false;
    fenceQueryCachePersistence();
    queryClient.clear();
    setGateState({ status: "CHECKING", subjectKey });

    void (async () => {
      let capabilities: Awaited<ReturnType<typeof utils.client.professionals.getMyCapabilities.query>> | undefined;
      let managerScope: Awaited<ReturnType<typeof utils.client.professionals.getManagerScope.query>> | undefined;
      try {
        const result = await runTenantAuthorizationAttempt({
          coordinator,
          ticket,
          currentSubject: getCurrentSubject,
          loadInstitutions: () =>
            utils.client.professionals.listMyInstitutions.query() as Promise<readonly AuthorizedInstitution[]>,
          loadCurrentTenantAuthority: async () => {
            [capabilities, managerScope] = await Promise.all([
              utils.client.professionals.getMyCapabilities.query(),
              utils.client.professionals.getManagerScope.query(),
            ]);
          },
          clearRevokedTenant: clearInstitutionSelection,
        });
        if (cancelled || result.status !== "VERIFIED") return;
        if (!coordinator.isCurrent(ticket, getCurrentSubject())) return;

        const activeId = ticket.subject.tenant.institutionId;
        if (activeId !== null) {
          const membership = result.receipt.institutions.find(({ id }) => id === activeId);
          if (!membership || !capabilities || !managerScope) {
            throw new Error("Prova institucional incompleta.");
          }
          if (!tenantAuthorityMatchesMembership({
            institutionId: activeId,
            membership,
            capabilities,
            managerScope,
          })) {
            throw new Error("Autoridade institucional mudou durante o handshake.");
          }
        }

        if (!coordinator.isCurrent(ticket, getCurrentSubject())) return;
        utils.professionals.listMyInstitutions.setData(
          undefined,
          [...result.receipt.institutions],
        );
        if (capabilities) {
          utils.professionals.getMyCapabilities.setData(undefined, capabilities);
        }
        if (managerScope) {
          utils.professionals.getManagerScope.setData(undefined, managerScope);
        }

        const isCurrent = () => (
          currentSessionProof.isCurrent() &&
          coordinator.isCurrent(ticket, getCurrentSubject())
        );
        setGateState({
          status: "VERIFIED",
          subjectKey,
          attestation: { receipt: result.receipt, isCurrent },
        });
      } catch (error) {
        if (cancelled || !coordinator.isCurrent(ticket, getCurrentSubject())) return;
        if (isUnauthorizedError(error)) emitSessionUnauthorized();
        setGateState({ status: "UNAVAILABLE", subjectKey });
      }
    })();

    return () => {
      cancelled = true;
      if (coordinator.isCurrent(ticket, getCurrentSubject())) {
        coordinator.invalidate();
      }
    };
  }, [
    clearInstitutionSelection,
    activity.online,
    activity.revision,
    activity.visible,
    currentSubject.userId,
    currentSubject.tenant.institutionId,
    currentSubject.tenant.revision,
    getCurrentSubject,
    isHydrating,
    queryClient,
    requiresHandshake,
    currentSessionProof,
    sessionValidation.status,
    sessionValidation.sequence,
    subjectKey,
    user,
    utils,
  ]);

  useEffect(() => {
    if (gateState.status !== "CHECKING") return;
    const timer = setTimeout(() => {
      setGateState((current) =>
        current.status === "CHECKING" && current.subjectKey === subjectKey
          ? { status: "UNAVAILABLE", subjectKey }
          : current,
      );
    }, AUTHORIZATION_GATE_STALL_MS);
    return () => clearTimeout(timer);
  }, [gateState.status, subjectKey]);

  const [sessionProofStalled, setSessionProofStalled] = useState(false);
  useEffect(() => {
    if (!user || currentSessionProof) {
      setSessionProofStalled(false);
      return;
    }
    if (sessionValidation.status !== "CHECKING") {
      setSessionProofStalled(false);
      return;
    }
    const timer = setTimeout(
      () => setSessionProofStalled(true),
      REQUEST_DEADLINE_MS,
    );
    return () => clearTimeout(timer);
  }, [
    currentSessionProof,
    user,
    sessionValidation.status,
    sessionValidation.sequence,
  ]);

  if (user && !currentSessionProof) {
    if (
      sessionValidation.status === "UNAVAILABLE" ||
      sessionProofStalled
    ) {
      return <AuthorizationUnavailableScreen retry={() => { void refetch(); }} />;
    }
    return <BootScreen />;
  }

  if (!requiresHandshake) {
    return (
      <TenantAuthorizationContext.Provider value={null}>
        {children}
      </TenantAuthorizationContext.Provider>
    );
  }

  if (gateState.status === "UNAVAILABLE") {
    return <AuthorizationUnavailableScreen retry={() => { void refetch(); }} />;
  }
  if (
    isHydrating ||
    !activity.visible ||
    !activity.online ||
    gateState.subjectKey !== subjectKey ||
    gateState.status === "CHECKING"
  ) {
    return <BootScreen />;
  }
  if (!gateState.attestation.isCurrent()) return <BootScreen />;

  return (
    <TenantAuthorizationContext.Provider value={gateState.attestation}>
      {activeInstitutionId !== null ? (
        <QueryCachePersistence attestation={gateState.attestation} />
      ) : null}
      {children}
    </TenantAuthorizationContext.Provider>
  );
}

/** Handles auth-gated navigation. Must be rendered inside providers. */
function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, refetch, sessionValidation } = useAuth();
  const pathname = usePathname();
  const { activeInstitutionId, setActiveInstitutionId } = useTenantState();
  const attestation = useContext(TenantAuthorizationContext);
  const institutions = attestation?.receipt.institutions;
  const [admissionStalled, setAdmissionStalled] = useState(false);
  const waitingDurableAdmission =
    !user &&
    sessionValidation.status === "CHECKING" &&
    "durableSession" in sessionValidation &&
    sessionValidation.durableSession === true;

  useEffect(() => {
    if (!waitingDurableAdmission) {
      setAdmissionStalled(false);
      return;
    }
    const timer = setTimeout(() => setAdmissionStalled(true), AUTHORIZATION_GATE_STALL_MS);
    return () => clearTimeout(timer);
  }, [sessionValidation.sequence, waitingDurableAdmission]);

  useEffect(() => {
    if (!user || !institutions || activeInstitutionId !== null) return;
    if (institutions.length === 1) {
      void setActiveInstitutionId(institutions[0].id);
    }
  }, [activeInstitutionId, institutions, setActiveInstitutionId, user]);

  if (!user) {
    const durableAdmissionPending =
      (sessionValidation.status === "CHECKING" ||
        sessionValidation.status === "UNAVAILABLE") &&
      "durableSession" in sessionValidation &&
      sessionValidation.durableSession === true;
    if (durableAdmissionPending) {
      if (sessionValidation.status === "UNAVAILABLE" || admissionStalled) {
        return (
          <AuthorizationUnavailableScreen
            retry={() => {
              void refetch();
            }}
            title="O servidor está acordando"
            body="Sua sessão já foi recebida. Nenhum dado local foi aberto. Toque em tentar novamente em instantes."
          />
        );
      }
      return <BootScreen />;
    }
    if (
      pathname === "/login" ||
      pathname === "/signup" ||
      pathname === "/forgot-password" ||
      pathname === "/reset-password" ||
      pathname === "/oauth/callback" ||
      (__DEV__ && pathname === "/ui-preview")
    ) {
      return <>{children}</>;
    }
    return <Redirect href="/login" />;
  }

  if (user.approvalStatus === "PENDING") {
    return <PendingApprovalScreen />;
  }

  if (user.mustChangePassword) {
    return pathname === "/change-password"
      ? <>{children}</>
      : <Redirect href="/change-password" />;
  }

  if (!attestation || !attestation.isCurrent()) return <BootScreen />;
  if (institutions?.length === 0) {
    if (pathname === "/join-schedule") return <>{children}</>;
    return <WaitingForScheduleScreen />;
  }

  if (activeInstitutionId === null && pathname !== "/select-institution") {
    return <Redirect href={"/select-institution" as any} />;
  }
  if (activeInstitutionId !== null && pathname === "/select-institution") {
    return <Redirect href="/(tabs)" />;
  }

  return <>{children}</>;
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
  const queryClient = useQueryClient();
  const clearTenantBoundMemory = useCallback(() => queryClient.clear(), [queryClient]);
  // Só monta a árvore (Stack, guard, listeners) quando já se sabe quem é
  // o usuário. Antes, o provider nascia como "anon" e era REMONTADO meio
  // segundo depois com o id vindo do cache local — o navigator inteiro
  // montava duas vezes a cada abertura do app.
  if (isLoading) return <BootScreen />;
  return (
    <TenantStateProvider
      key={user?.id ?? "anon"}
      onBeforeTenantChange={clearTenantBoundMemory}
    >
      {children}
    </TenantStateProvider>
  );
}

/**
 * Liga o cache persistido do react-query ao par usuário + instituição
 * ativos (chave própria no disco; trocar qualquer um dos dois desliga o
 * anterior e restaura o certo). A whitelist contém só hospitais/setores;
 * escalas e ações operacionais sempre aguardam resposta fresca.
 */
function QueryCachePersistence({
  attestation,
}: {
  attestation: TenantAuthorizationAttestation;
}) {
  const { user } = useAuth();
  const { activeInstitutionId } = useTenantState();
  const queryClient = useQueryClient();
  const userId = user?.id ?? null;

  useEffect(() => {
    if (userId === null || activeInstitutionId === null) return;
    return startQueryCachePersistence({
      queryClient,
      userId,
      institutionId: activeInstitutionId,
      buster: Constants.expoConfig?.version ?? "dev",
      isAuthorizationCurrent: attestation.isCurrent,
    });
  }, [activeInstitutionId, attestation, queryClient, userId]);

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
                {/* Account-scoped e estável: a troca A→B não pode desmontar
                    o próprio listener antes de ele concluir a navegação. */}
                <NotificationListener />
                <TenantAuthorizationBoundary>
                  <AuthGuard>
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
                      <StatusBar style="auto" />
                    </IntegrationManagerProvider>
                  </AuthGuard>
                </TenantAuthorizationBoundary>
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
