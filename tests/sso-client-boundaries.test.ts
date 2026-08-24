import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openComunica,
  openComunicaFromNotification,
  openComunicaViaLaunchCode,
} from "../lib/sso-launch";
import {
  createSsoHandoffFence,
  generateSsoClientNonce,
  runWebSsoHandoff,
} from "../hooks/use-sso-handoff";
import {
  createNotificationRoutingCoordinator,
  NOTIFICATION_ROUTING_ITEM_TIMEOUT_MS,
  routeNotificationData,
} from "../components/NotificationListener";

const clientMocks = vi.hoisted(() => ({
  openURL: vi.fn(async () => undefined),
  getSessionToken: vi.fn(async () => "session-token"),
  platform: { OS: "web" },
}));

type TestElement = Readonly<{
  type?: unknown;
  props?: Readonly<Record<string, unknown>>;
}>;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function collectTestElements(node: unknown, elements: TestElement[] = []): TestElement[] {
  if (Array.isArray(node)) {
    for (const child of node) collectTestElements(child, elements);
    return elements;
  }
  if (!node || typeof node !== "object") return elements;
  const element = node as TestElement;
  elements.push(element);
  collectTestElements(element.props?.children, elements);
  return elements;
}

function collectText(node: unknown, text: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, text);
    return text;
  }
  if (typeof node === "string") text.push(node);
  if (node && typeof node === "object") {
    collectText((node as TestElement).props?.children, text);
  }
  return text;
}

async function renderRealConfirmDutyScreen(options: {
  token: string;
  pending: Record<string, unknown> | null;
  pendingError?: boolean;
  nomination: Record<string, unknown> | null;
  nominationError?: boolean;
}) {
  vi.resetModules();
  const confirmMutate = vi.fn();
  const getPending = vi.fn(() => ({
    data: options.pending,
    isLoading: false,
    isError: options.pendingError ?? false,
    refetch: vi.fn(async () => undefined),
  }));
  const getNomination = vi.fn(() => ({
    data: options.nomination,
    isLoading: false,
    isError: options.nominationError ?? false,
    refetch: vi.fn(async () => undefined),
  }));
  const mutation = (mutate = vi.fn()) => ({ mutate, isPending: false });
  const PrimaryButton = function PrimaryButton() {
    return null;
  };
  const QueryErrorState = function QueryErrorState() {
    return null;
  };

  vi.doMock("react-native", () => ({
    View: "View",
    Text: "Text",
    ActivityIndicator: "ActivityIndicator",
    Platform: { OS: "web" },
  }));
  vi.doMock("expo-router", () => ({
    useLocalSearchParams: () => ({ token: options.token }),
    useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  }));
  vi.doMock("lucide-react-native", () => ({ Check: "Check", X: "X", Clock: "Clock" }));
  vi.doMock("expo-haptics", () => ({
    impactAsync: vi.fn(),
    notificationAsync: vi.fn(),
    ImpactFeedbackStyle: { Medium: "medium" },
    NotificationFeedbackType: { Warning: "warning" },
  }));
  vi.doMock("@/lib/ui/alert", () => ({ uiConfirmDestructive: vi.fn() }));
  vi.doMock("@/components/ui/ScreenGradient", () => ({ ScreenGradient: "ScreenGradient" }));
  vi.doMock("@/components/ui/TintedGlassCard", () => ({ TintedGlassCard: "TintedGlassCard" }));
  vi.doMock("@/components/ui/PrimaryButton", () => ({ PrimaryButton }));
  vi.doMock("@/components/ui/Badge", () => ({ Badge: "Badge" }));
  vi.doMock("@/components/ui/QueryErrorState", () => ({ QueryErrorState }));
  vi.doMock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: 7 } }) }));
  vi.doMock("@/hooks/use-action-feedback", () => ({
    useActionFeedback: () => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }),
  }));
  vi.doMock("@/lib/theme", () => ({
    theme: {
      colors: {
        primary: "#000",
        success: "#000",
        textPrimary: "#000",
        textSecondary: "#000",
      },
    },
  }));
  vi.doMock("@/lib/trpc", () => ({
    trpc: {
      confirmations: {
        getPending: { useQuery: getPending },
        getNomination: { useQuery: getNomination },
        acceptNomination: { useMutation: () => mutation() },
        declineNomination: { useMutation: () => mutation() },
        confirm: { useMutation: () => mutation(confirmMutate) },
        decline: { useMutation: () => mutation() },
      },
    },
  }));
  vi.stubGlobal("React", {
    createElement: (
      type: unknown,
      props: Record<string, unknown> | null,
      ...children: unknown[]
    ) => ({
      type,
      props: {
        ...(props ?? {}),
        ...(children.length > 0
          ? { children: children.length === 1 ? children[0] : children }
          : {}),
      },
    }),
  });

  const { default: ConfirmDutyScreen } = await import("../app/confirm-duty");
  const tree = ConfirmDutyScreen();
  return {
    tree,
    elements: collectTestElements(tree),
    text: collectText(tree),
    PrimaryButton,
    QueryErrorState,
    confirmMutate,
    getPending,
    getNomination,
  };
}

function notificationResponse(
  identifier: string,
  data: Record<string, unknown>,
  actionIdentifier = "expo.modules.notifications.actions.DEFAULT",
) {
  return {
    actionIdentifier,
    notification: {
      request: {
        identifier,
        content: { data },
      },
    },
  };
}

async function renderRealNotificationListener(options: {
  user?: { id: number } | null;
  activeTenant?: { institutionId: number | null; revision: number };
  allowedInstitutionIds?: number[];
  lastResponse?: ReturnType<typeof notificationResponse> | null;
  refetch?: () => Promise<{ isError: boolean; data: { id: number }[] }>;
}) {
  vi.resetModules();
  const effects: (() => void | (() => void))[] = [];
  const routingRef: { current: unknown } = { current: null };
  const routerPush = vi.fn();
  const removeSubscription = vi.fn();
  const invalidateQueries = vi.fn(async () => undefined);
  const setActiveInstitutionId = vi.fn(async (institutionId: number) => {
    activeTenant = { institutionId, revision: activeTenant.revision + 1 };
  });
  const clearLastNotificationResponse = vi.fn(() => {
    lastResponse = null;
  });
  const getLastNotificationResponse = vi.fn(() => lastResponse);
  let responseListener: ((response: ReturnType<typeof notificationResponse>) => void) | undefined;
  let user = options.user === undefined ? { id: 7 } : options.user;
  let activeTenant = options.activeTenant ?? { institutionId: 22, revision: 1 };
  let lastResponse = options.lastResponse ?? null;
  const allowedInstitutionIds = options.allowedInstitutionIds ?? [11, 22];
  const refetch = options.refetch ?? vi.fn(async () => ({
    isError: false,
    data: allowedInstitutionIds.map((id) => ({ id })),
  }));
  const createElement = (
    type: unknown,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ) => ({ type, props: { ...(props ?? {}), children } });

  vi.doMock("react", () => ({
    createElement,
    useCallback: (callback: unknown) => callback,
    useEffect: (effect: () => void | (() => void)) => {
      effects.push(effect);
    },
    useRef: () => routingRef,
  }));
  vi.doMock("expo-router", () => ({ useRouter: () => ({ push: routerPush }) }));
  vi.doMock("expo-notifications", () => ({
    DEFAULT_ACTION_IDENTIFIER: "expo.modules.notifications.actions.DEFAULT",
    addNotificationResponseReceivedListener: vi.fn((listener: typeof responseListener) => {
      responseListener = listener;
      return { remove: removeSubscription };
    }),
    getLastNotificationResponse,
    clearLastNotificationResponse,
  }));
  vi.doMock("@/hooks/use-auth", () => ({ useAuth: () => ({ user }) }));
  vi.doMock("@/hooks/use-notifications", () => ({ useNotifications: vi.fn() }));
  vi.doMock("@/lib/tenant-state", () => ({
    getActiveTenantSnapshot: () => activeTenant,
    useTenantState: () => ({ setActiveInstitutionId }),
  }));
  vi.doMock("@/lib/trpc", () => ({
    trpc: {
      useUtils: () => ({ invalidate: invalidateQueries }),
      professionals: {
        listMyInstitutions: { useQuery: () => ({ refetch }) },
      },
    },
  }));
  vi.stubGlobal("React", { createElement });

  const { NotificationListener: Component } = await import(
    "../components/NotificationListener"
  );
  return {
    render: () => Component(),
    runLatestEffect: () => effects.at(-1)?.(),
    effects,
    routerPush,
    removeSubscription,
    invalidateQueries,
    setActiveInstitutionId,
    getLastNotificationResponse,
    clearLastNotificationResponse,
    emit: (response: ReturnType<typeof notificationResponse>) => responseListener?.(response),
    setUser: (next: { id: number } | null) => {
      user = next;
    },
    activeTenant: () => activeTenant,
  };
}

async function renderRealUseNotifications(options: {
  userId: number;
  initialToken: string;
  mutateAsync: (input: Record<string, unknown>) => Promise<{ success: boolean }>;
}) {
  vi.resetModules();
  vi.doUnmock("@/hooks/use-notifications");
  vi.doUnmock("../hooks/use-notifications");
  const effects: (() => void | (() => void))[] = [];
  const setExpoPushToken = vi.fn();
  const setNotification = vi.fn();
  const setLastPushToken = vi.fn();
  const removeReceived = vi.fn();
  const removePushToken = vi.fn();
  let pushTokenListener: ((token: { type: string; data: string }) => void) | undefined;
  let stateIndex = 0;
  const getPermissionsAsync = vi.fn(async () => ({ status: "granted" }));
  const getExpoPushTokenAsync = vi.fn(async (
    input?: { devicePushToken?: { data: string } },
  ) => ({
    data: input?.devicePushToken ? `Expo-${input.devicePushToken.data}` : options.initialToken,
  }));

  vi.doMock("react", () => ({
    useEffect: (effect: () => void | (() => void)) => effects.push(effect),
    useRef: (initial: unknown) => ({ current: initial }),
    useState: (initial: unknown) => {
      const setter = stateIndex++ === 0 ? setExpoPushToken : setNotification;
      return [initial, setter];
    },
  }));
  vi.doMock("expo-device", () => ({ isDevice: true, default: { isDevice: true } }));
  vi.doMock("react-native", () => ({ Platform: { OS: "ios" } }));
  vi.doMock("expo-constants", () => ({
    default: { expoConfig: { extra: { eas: { projectId: "project-id" } } } },
  }));
  vi.doMock("expo-notifications", () => ({
    AndroidImportance: { MAX: 5 },
    setNotificationHandler: vi.fn(),
    setNotificationChannelAsync: vi.fn(async () => undefined),
    getPermissionsAsync,
    requestPermissionsAsync: vi.fn(async () => ({ status: "granted" })),
    getExpoPushTokenAsync,
    addNotificationReceivedListener: vi.fn(() => ({ remove: removeReceived })),
    addPushTokenListener: vi.fn((listener: typeof pushTokenListener) => {
      pushTokenListener = listener;
      return { remove: removePushToken };
    }),
    scheduleNotificationAsync: vi.fn(),
    cancelAllScheduledNotificationsAsync: vi.fn(),
  }));
  vi.doMock("@/lib/trpc", () => ({
    trpc: {
      confirmations: {
        registerPushToken: {
          useMutation: () => ({ mutateAsync: options.mutateAsync }),
        },
      },
    },
  }));
  vi.doMock("@/lib/push-token", () => ({ setLastPushToken }));

  const { useNotifications: useRealNotifications } = await import("../hooks/use-notifications");
  function NotificationsHarness() {
    useRealNotifications(options.userId);
    return null;
  }
  NotificationsHarness();
  return {
    runEffect: () => effects[0]?.(),
    emitRollover: (token: string) => pushTokenListener?.({ type: "ios", data: token }),
    setExpoPushToken,
    setLastPushToken,
    removeReceived,
    removePushToken,
    getPermissionsAsync,
    getExpoPushTokenAsync,
    effectCount: () => effects.length,
  };
}

vi.mock("react-native", () => ({
  Platform: clientMocks.platform,
  Linking: { openURL: clientMocks.openURL },
}));

vi.mock("@/lib/_core/auth", () => ({
  getSessionToken: clientMocks.getSessionToken,
}));

vi.mock("@/lib/_core/api", () => ({
  getApiBaseUrl: () => "https://escala.example",
}));

vi.mock("expo-notifications", () => ({
  DEFAULT_ACTION_IDENTIFIER: "expo.modules.notifications.actions.DEFAULT",
  addNotificationResponseReceivedListener: vi.fn(() => ({ remove: vi.fn() })),
  getLastNotificationResponse: vi.fn(() => null),
  clearLastNotificationResponse: vi.fn(),
}));

vi.mock("expo-router", () => ({ useRouter: vi.fn() }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: vi.fn() }));
vi.mock("@/hooks/use-notifications", () => ({ useNotifications: vi.fn() }));
vi.mock("@/lib/tenant-state", () => ({
  getActiveTenantSnapshot: vi.fn(() => ({ institutionId: null, revision: 0 })),
  useTenantState: vi.fn(),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: vi.fn(),
    professionals: { listMyInstitutions: { useQuery: vi.fn() } },
  },
}));

describe("SSO client tenant boundaries", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    clientMocks.platform.OS = "web";
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([undefined, null, 0, -1, 1.5, Number.NaN])(
    "falha fechado sem tenant canônico e não toca sessão, rede ou Linking (%s)",
    async (institutionId) => {
      await expect(openComunica(institutionId as number)).resolves.toMatchObject({ ok: false });
      await expect(openComunicaViaLaunchCode(institutionId as number)).resolves.toMatchObject({
        ok: false,
      });
      await expect(
        openComunicaFromNotification({
          type: "sso_ready",
          institutionId,
          comunicaUrl: "javascript:alert(1)",
        }),
      ).resolves.toMatchObject({ ok: false });

      expect(clientMocks.getSessionToken).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(clientMocks.openURL).not.toHaveBeenCalled();
    },
  );

  it("propaga o tenant do push no launch-code e abre somente a URL emitida pelo servidor", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn(async () => ({
        launchUrl: "https://escala.example/api/sso/launch?code=trusted",
      })),
    });

    await expect(
      openComunicaFromNotification({
        type: "sso_ready",
        institutionId: 42,
        comunicaUrl: "https://attacker.example/phish",
      }),
    ).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://escala.example/api/sso/launch-code",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer session-token",
          "x-tenant-id": "42",
        }),
      }),
    );
    expect(clientMocks.openURL).toHaveBeenCalledTimes(1);
    expect(clientMocks.openURL).toHaveBeenCalledWith(
      "https://escala.example/api/sso/launch?code=trusted",
    );
    expect(clientMocks.openURL).not.toHaveBeenCalledWith("https://attacker.example/phish");
  });

  it("no native também exige launch-code tenant-bound e nunca abre scheme nu", async () => {
    clientMocks.platform.OS = "ios";
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn(async () => ({
        launchUrl: "https://escala.example/api/sso/launch?code=tenant-a",
      })),
    });

    await expect(openComunica(73)).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://escala.example/api/sso/launch-code",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer session-token",
          "x-tenant-id": "73",
        }),
      }),
    );
    expect(clientMocks.openURL).toHaveBeenCalledTimes(1);
    expect(clientMocks.openURL).toHaveBeenCalledWith(
      "https://escala.example/api/sso/launch?code=tenant-a",
    );
    expect(clientMocks.openURL).not.toHaveBeenCalledWith("comunicamais://");
  });

  it("aborta launch-code deferred antes de openURL e não devolve URL/código do erro", async () => {
    let resolveFetch!: (response: unknown) => void;
    fetchMock.mockReturnValue(new Promise((resolve) => {
      resolveFetch = resolve;
    }));
    const controller = new AbortController();
    const launch = openComunicaViaLaunchCode(42, { signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    controller.abort();
    resolveFetch({
      ok: true,
      status: 200,
      json: vi.fn(async () => ({
        launchUrl: "https://escala.example/api/sso/launch?code=STALE_LAUNCH_CODE_SENTINEL",
      })),
    });

    const result = await launch;
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("STALE_LAUNCH_CODE_SENTINEL");
    expect(clientMocks.openURL).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("fence de geração invalida a chamada anterior e bloqueia form POST deferred", async () => {
    const fence = createSsoHandoffFence();
    const first = fence.begin();
    const second = fence.begin();
    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);

    let resolveFetch!: (response: unknown) => void;
    fetchMock.mockReturnValue(new Promise((resolve) => {
      resolveFetch = resolve;
    }));
    const submit = vi.fn(() => true);
    const handoff = runWebSsoHandoff(42, second, submit);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fence.invalidate();
    resolveFetch({
      ok: true,
      status: 200,
      json: vi.fn(async () => ({
        targetUrl: "https://comunica.example/auth/sso/exchange?code=STALE_WEB_CODE",
        handoffToken: "STALE_WEB_TOKEN",
      })),
    });

    await expect(handoff).resolves.toEqual({ ok: false, cancelled: true });
    expect(second.signal.aborted).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });

  it("falhas de sessão, fetch e openURL retornam somente mensagens controladas", async () => {
    const sentinel = "launchUrl=https://evil.test/?code=RAW_ERROR_SENTINEL";
    clientMocks.getSessionToken.mockRejectedValueOnce(new Error(sentinel));
    const sessionFailure = await openComunicaViaLaunchCode(42);
    expect(sessionFailure.ok).toBe(false);
    expect(JSON.stringify(sessionFailure)).not.toContain("RAW_ERROR_SENTINEL");

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn(async () => ({
        launchUrl: "https://escala.example/api/sso/launch?code=trusted",
      })),
    });
    clientMocks.openURL.mockRejectedValueOnce(new Error(sentinel));
    const openFailure = await openComunicaViaLaunchCode(42);
    expect(openFailure.ok).toBe(false);
    expect(JSON.stringify(openFailure)).not.toContain("RAW_ERROR_SENTINEL");
  });

  it("descarta error, launchUrl e code brutos de respostas HTTP de SSO", async () => {
    const sentinel = "RAW_HTTP_SSO_SENTINEL";
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: vi.fn(async () => ({
        error: `database=${sentinel}`,
        launchUrl: `https://evil.test/?code=${sentinel}`,
        code: sentinel,
      })),
    });

    const mobileFailure = await openComunicaViaLaunchCode(42);
    expect(mobileFailure.ok).toBe(false);
    expect(JSON.stringify(mobileFailure)).not.toContain(sentinel);

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: vi.fn(async () => ({
        error: `database=${sentinel}`,
        launchUrl: `https://evil.test/?code=${sentinel}`,
        code: sentinel,
      })),
    });
    const fence = createSsoHandoffFence();
    const webFailure = await runWebSsoHandoff(42, fence.begin(), vi.fn(() => true));
    expect(webFailure.ok).toBe(false);
    expect(JSON.stringify(webFailure)).not.toContain(sentinel);
  });

  it("push A com tenant B ativo troca, invalida e só então navega para o token A", async () => {
    const calls: string[] = [];
    let activeTenant = { institutionId: 22, revision: 1 };
    const navigateToConfirmation = vi.fn((token: string) => calls.push(`navigate:${token}`));
    const setActiveInstitutionId = vi.fn(async (id: number) => {
      calls.push(`set:${id}`);
      activeTenant = { institutionId: id, revision: activeTenant.revision + 1 };
    });
    const invalidateQueries = vi.fn(async () => {
      calls.push("invalidate");
    });

    await expect(routeNotificationData({
      type: "duty_confirmation",
      institutionId: 11,
      confirmationToken: "confirmation-a",
    }, {
      getActiveTenantSnapshot: () => activeTenant,
      loadAllowedInstitutionIds: async () => {
        calls.push("allowed");
        return [11, 22];
      },
      setActiveInstitutionId,
      invalidateQueries,
      navigateToConfirmation,
      navigateToAgenda: vi.fn(),
      openComunica: vi.fn(async () => ({ ok: true })),
    })).resolves.toBe(true);

    expect(calls).toEqual([
      "allowed",
      "set:11",
      "invalidate",
      "navigate:confirmation-a",
    ]);
    expect(navigateToConfirmation).toHaveBeenCalledWith("confirmation-a");
  });

  it.each([
    { label: "ausente", institutionId: undefined, allowed: [11, 22] },
    { label: "zero", institutionId: 0, allowed: [11, 22] },
    { label: "fracionário", institutionId: 11.5, allowed: [11, 22] },
    { label: "string malformada", institutionId: "11x", allowed: [11, 22] },
    { label: "alheio", institutionId: 99, allowed: [11, 22] },
  ])("push com tenant $label falha fechado sem troca ou navegação", async ({
    institutionId,
    allowed,
  }) => {
    const setActiveInstitutionId = vi.fn(async () => undefined);
    const invalidateQueries = vi.fn(async () => undefined);
    const navigateToConfirmation = vi.fn();
    const navigateToAgenda = vi.fn();
    const openComunica = vi.fn(async () => ({ ok: true }));

    await expect(routeNotificationData({
      type: "duty_nomination",
      institutionId,
      confirmationToken: "confirmation-a",
    }, {
      getActiveTenantSnapshot: () => ({ institutionId: 22, revision: 1 }),
      loadAllowedInstitutionIds: async () => allowed,
      setActiveInstitutionId,
      invalidateQueries,
      navigateToConfirmation,
      navigateToAgenda,
      openComunica,
    })).resolves.toBe(false);

    expect(setActiveInstitutionId).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(navigateToConfirmation).not.toHaveBeenCalled();
    expect(navigateToAgenda).not.toHaveBeenCalled();
    expect(openComunica).not.toHaveBeenCalled();
  });

  it("payload legado sem tenant não usa o tenant B atual como fallback", async () => {
    const navigateToAgenda = vi.fn();
    await expect(routeNotificationData({ type: "duty_auto_confirmed" }, {
      getActiveTenantSnapshot: () => ({ institutionId: 22, revision: 1 }),
      loadAllowedInstitutionIds: async () => [22],
      setActiveInstitutionId: vi.fn(async () => undefined),
      invalidateQueries: vi.fn(async () => undefined),
      navigateToConfirmation: vi.fn(),
      navigateToAgenda,
      openComunica: vi.fn(async () => ({ ok: true })),
    })).resolves.toBe(false);
    expect(navigateToAgenda).not.toHaveBeenCalled();
  });

  it("sync_error legado de conta anterior falha fechado sem fila ou efeito externo", async () => {
    const loadAllowedInstitutionIds = vi.fn(async () => [11, 22]);
    const setActiveInstitutionId = vi.fn(async () => undefined);
    const invalidateQueries = vi.fn(async () => undefined);
    const navigateToConfirmation = vi.fn();
    const navigateToAgenda = vi.fn();
    const openComunica = vi.fn(async () => ({ ok: true }));

    // Cold-start já sob a conta B, com payload/queue persistida pelo login A.
    // O tipo legado é terminal e não toca sequer a allowlist do usuário atual.
    await expect(routeNotificationData({
      type: "sync_error",
      institutionId: 11,
      previousUserId: 1001,
    }, {
      getActiveTenantSnapshot: () => ({ institutionId: 22, revision: 9 }),
      loadAllowedInstitutionIds,
      setActiveInstitutionId,
      invalidateQueries,
      navigateToConfirmation,
      navigateToAgenda,
      openComunica,
    })).resolves.toBe(true);

    expect(loadAllowedInstitutionIds).not.toHaveBeenCalled();
    expect(setActiveInstitutionId).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(navigateToConfirmation).not.toHaveBeenCalled();
    expect(navigateToAgenda).not.toHaveBeenCalled();
    expect(openComunica).not.toHaveBeenCalled();
  });

  it("serializa taps A/B e lê o tenant vivo antes de cada rota", async () => {
    const coordinator = createNotificationRoutingCoordinator();
    const scope = coordinator.beginScope();
    const aSetterReached = deferred();
    const releaseASetter = deferred();
    const calls: string[] = [];
    let activeTenant = { institutionId: 22, revision: 1 };

    const dependencies = {
      getActiveTenantSnapshot: () => activeTenant,
      loadAllowedInstitutionIds: async () => {
        calls.push(`allowed:${activeTenant.institutionId}`);
        return [11, 22];
      },
      setActiveInstitutionId: async (institutionId: number) => {
        calls.push(`set:${institutionId}`);
        activeTenant = {
          institutionId,
          revision: activeTenant.revision + 1,
        };
        if (institutionId === 11) {
          aSetterReached.resolve();
          await releaseASetter.promise;
        }
      },
      invalidateQueries: async () => {
        calls.push(`invalidate:${activeTenant.institutionId}`);
      },
      navigateToConfirmation: (token: string) => {
        calls.push(`navigate:${token}:tenant:${activeTenant.institutionId}`);
      },
      navigateToAgenda: vi.fn(),
      openComunica: vi.fn(async () => ({ ok: true })),
    };

    const routeA = scope.enqueue({
      type: "duty_confirmation",
      institutionId: 11,
      confirmationToken: "token-a",
    }, dependencies);
    await aSetterReached.promise;

    const routeB = scope.enqueue({
      type: "duty_confirmation",
      institutionId: 22,
      confirmationToken: "token-b",
    }, dependencies);
    await Promise.resolve();
    expect(calls).toEqual(["allowed:22", "set:11"]);

    releaseASetter.resolve();
    await expect(Promise.all([routeA, routeB])).resolves.toEqual([true, true]);
    expect(calls).toEqual([
      "allowed:22",
      "set:11",
      "invalidate:11",
      "navigate:token-a:tenant:11",
      "allowed:11",
      "set:22",
      "invalidate:22",
      "navigate:token-b:tenant:22",
    ]);
  });

  it("aborta a rota A quando uma troca manual para B vence durante invalidate", async () => {
    const invalidateReached = deferred();
    const releaseInvalidate = deferred();
    const navigateToConfirmation = vi.fn();
    let activeTenant = { institutionId: 22, revision: 1 };

    const route = routeNotificationData({
      type: "duty_confirmation",
      institutionId: 11,
      confirmationToken: "token-a",
    }, {
      getActiveTenantSnapshot: () => activeTenant,
      loadAllowedInstitutionIds: async () => [11, 22],
      setActiveInstitutionId: async (institutionId) => {
        activeTenant = { institutionId, revision: activeTenant.revision + 1 };
      },
      invalidateQueries: async () => {
        invalidateReached.resolve();
        await releaseInvalidate.promise;
      },
      navigateToConfirmation,
      navigateToAgenda: vi.fn(),
      openComunica: vi.fn(async () => ({ ok: true })),
    });

    await invalidateReached.promise;
    activeTenant = { institutionId: 22, revision: activeTenant.revision + 1 };
    releaseInvalidate.resolve();

    await expect(route).resolves.toBe(false);
    expect(navigateToConfirmation).not.toHaveBeenCalled();
  });

  it("mantém a fila viva após rejeições de refetch, setter e invalidate sem vazar erro", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    for (const failingStep of ["refetch", "setter", "invalidate"] as const) {
      const coordinator = createNotificationRoutingCoordinator();
      const scope = coordinator.beginScope();
      let activeTenant = { institutionId: 22, revision: 1 };
      const firstNavigation = vi.fn();
      const nextNavigation = vi.fn();
      const failure = new Error(`RAW_ROUTING_SENTINEL_${failingStep}`);

      const failed = scope.enqueue({
        type: "duty_confirmation",
        institutionId: 11,
        confirmationToken: `secret-${failingStep}`,
      }, {
        getActiveTenantSnapshot: () => activeTenant,
        loadAllowedInstitutionIds: async () => {
          if (failingStep === "refetch") throw failure;
          return [11, 22];
        },
        setActiveInstitutionId: async (institutionId) => {
          if (failingStep === "setter") throw failure;
          activeTenant = { institutionId, revision: activeTenant.revision + 1 };
        },
        invalidateQueries: async () => {
          if (failingStep === "invalidate") throw failure;
        },
        navigateToConfirmation: firstNavigation,
        navigateToAgenda: vi.fn(),
        openComunica: vi.fn(async () => ({ ok: true })),
      });

      const next = scope.enqueue({
        type: "duty_confirmation",
        institutionId: 22,
        confirmationToken: "next-token",
      }, {
        getActiveTenantSnapshot: () => activeTenant,
        loadAllowedInstitutionIds: async () => [11, 22],
        setActiveInstitutionId: async (institutionId) => {
          activeTenant = { institutionId, revision: activeTenant.revision + 1 };
        },
        invalidateQueries: async () => undefined,
        navigateToConfirmation: nextNavigation,
        navigateToAgenda: vi.fn(),
        openComunica: vi.fn(async () => ({ ok: true })),
      });

      await expect(Promise.all([failed, next])).resolves.toEqual([false, true]);
      expect(firstNavigation).not.toHaveBeenCalled();
      expect(nextNavigation).toHaveBeenCalledWith("next-token");
    }

    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls).toEqual([
      ["[NotificationListener] ROUTING_FAILED"],
      ["[NotificationListener] ROUTING_FAILED"],
      ["[NotificationListener] ROUTING_FAILED"],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("RAW_ROUTING_SENTINEL");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-");
    warn.mockRestore();
  });

  it.each(["allowlist", "invalidate", "openComunica"] as const)(
    "deadline por item libera a fila após %s pendente e cerca a continuação tardia",
    async (pendingStep) => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const coordinator = createNotificationRoutingCoordinator();
      const scope = coordinator.beginScope();
      const pendingReached = deferred();
      const releasePending = deferred<readonly number[]>();
      const firstNavigation = vi.fn();
      const firstOpenEffect = vi.fn();
      const nextNavigation = vi.fn();
      let activeTenant = { institutionId: 22, revision: 1 };

      try {
        const first = scope.enqueue({
          type: pendingStep === "openComunica" ? "sso_ready" : "duty_confirmation",
          institutionId: 11,
          confirmationToken: `secret-${pendingStep}`,
        }, {
          getActiveTenantSnapshot: () => activeTenant,
          loadAllowedInstitutionIds: async () => {
            if (pendingStep === "allowlist") {
              pendingReached.resolve();
              return releasePending.promise;
            }
            return [11, 22];
          },
          setActiveInstitutionId: async (institutionId) => {
            activeTenant = {
              institutionId,
              revision: activeTenant.revision + 1,
            };
          },
          invalidateQueries: async () => {
            if (pendingStep === "invalidate") {
              pendingReached.resolve();
              await releasePending.promise;
            }
          },
          navigateToConfirmation: firstNavigation,
          navigateToAgenda: firstNavigation,
          openComunica: async (_data, canNavigate) => {
            pendingReached.resolve();
            await releasePending.promise;
            if (canNavigate()) firstOpenEffect();
            return { ok: true };
          },
        });
        await pendingReached.promise;

        const next = scope.enqueue({
          type: "duty_confirmation",
          institutionId: 22,
          confirmationToken: "next-token",
        }, {
          getActiveTenantSnapshot: () => activeTenant,
          loadAllowedInstitutionIds: async () => [11, 22],
          setActiveInstitutionId: async (institutionId) => {
            activeTenant = {
              institutionId,
              revision: activeTenant.revision + 1,
            };
          },
          invalidateQueries: async () => undefined,
          navigateToConfirmation: nextNavigation,
          navigateToAgenda: vi.fn(),
          openComunica: vi.fn(async () => ({ ok: true })),
        });

        await vi.advanceTimersByTimeAsync(NOTIFICATION_ROUTING_ITEM_TIMEOUT_MS);
        await expect(first).resolves.toBe(false);
        await expect(next).resolves.toBe(true);
        expect(nextNavigation).toHaveBeenCalledWith("next-token");

        if (pendingStep === "allowlist") {
          releasePending.reject(new Error("RAW_LATE_ROUTING_SENTINEL"));
        } else {
          releasePending.resolve([11, 22]);
        }
        await vi.runAllTimersAsync();
        await Promise.resolve();
        expect(firstNavigation).not.toHaveBeenCalled();
        expect(firstOpenEffect).not.toHaveBeenCalled();
        expect(warn.mock.calls).toEqual([
          ["[NotificationListener] ROUTING_TIMEOUT"],
        ]);
        expect(JSON.stringify(warn.mock.calls)).not.toContain(`secret-${pendingStep}`);
        expect(JSON.stringify(warn.mock.calls)).not.toContain("RAW_LATE_ROUTING_SENTINEL");
      } finally {
        releasePending.resolve([11, 22]);
        scope.invalidate();
        warn.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it("cleanup real do Listener invalida a fila no unmount/logout e impede rota tardia", async () => {
    vi.resetModules();
    const effects: (() => void | (() => void))[] = [];
    const routingRef: { current: unknown } = { current: null };
    const refetchStarted = deferred();
    const releaseRefetch = deferred<{
      isError: boolean;
      data: { id: number }[];
    }>();
    const routerPush = vi.fn();
    const removeSubscription = vi.fn();
    const setActiveInstitutionId = vi.fn(async () => undefined);
    const invalidateQueries = vi.fn(async () => undefined);
    let responseListener: ((response: any) => void) | undefined;
    let activeTenant = { institutionId: 22, revision: 1 };
    const createElement = (
      type: unknown,
      props: Record<string, unknown> | null,
      ...children: unknown[]
    ) => ({ type, props: { ...(props ?? {}), children } });

    vi.doMock("react", () => ({
      createElement,
      useCallback: (callback: unknown) => callback,
      useEffect: (effect: () => void | (() => void)) => {
        effects.push(effect);
      },
      useRef: () => routingRef,
    }));
    vi.doMock("expo-router", () => ({ useRouter: () => ({ push: routerPush }) }));
    vi.doMock("expo-notifications", () => ({
      DEFAULT_ACTION_IDENTIFIER: "expo.modules.notifications.actions.DEFAULT",
      addNotificationResponseReceivedListener: vi.fn((listener: (response: any) => void) => {
        responseListener = listener;
        return { remove: removeSubscription };
      }),
      getLastNotificationResponse: vi.fn(() => null),
      clearLastNotificationResponse: vi.fn(),
    }));
    vi.doMock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: 7 } }) }));
    vi.doMock("@/hooks/use-notifications", () => ({ useNotifications: vi.fn() }));
    vi.doMock("@/lib/tenant-state", () => ({
      getActiveTenantSnapshot: () => activeTenant,
      useTenantState: () => ({
        setActiveInstitutionId: async (institutionId: number) => {
          await setActiveInstitutionId(institutionId);
          activeTenant = { institutionId, revision: activeTenant.revision + 1 };
        },
      }),
    }));
    vi.doMock("@/lib/trpc", () => ({
      trpc: {
        useUtils: () => ({ invalidate: invalidateQueries }),
        professionals: {
          listMyInstitutions: {
            useQuery: () => ({
              refetch: vi.fn(async () => {
                refetchStarted.resolve();
                return releaseRefetch.promise;
              }),
            }),
          },
        },
      },
    }));
    vi.stubGlobal("React", { createElement });

    const { NotificationListener: RealNotificationListener } = await import(
      "../components/NotificationListener"
    );
    RealNotificationListener();
    expect(effects).toHaveLength(1);
    const cleanup = effects[0]?.();
    expect(typeof responseListener).toBe("function");
    responseListener?.({
      actionIdentifier: "expo.modules.notifications.actions.DEFAULT",
      notification: {
        request: {
          identifier: "cleanup-response",
          content: {
            data: {
              type: "duty_confirmation",
              institutionId: 11,
              confirmationToken: "stale-token",
            },
          },
        },
      },
    });
    await refetchStarted.promise;

    expect(typeof cleanup).toBe("function");
    (cleanup as () => void)();
    releaseRefetch.resolve({ isError: false, data: [{ id: 11 }, { id: 22 }] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(removeSubscription).toHaveBeenCalledTimes(1);
    expect(setActiveInstitutionId).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("Listener real consome cold-start A sob tenant B, limpa antes do await e navega uma vez", async () => {
    const last = notificationResponse("cold-a", {
      type: "duty_confirmation",
      institutionId: 11,
      confirmationToken: "cold-token-a",
    });
    const refetchStarted = deferred();
    const releaseRefetch = deferred<{ isError: boolean; data: { id: number }[] }>();
    const harness = await renderRealNotificationListener({
      activeTenant: { institutionId: 22, revision: 4 },
      lastResponse: last,
      refetch: async () => {
        refetchStarted.resolve();
        return releaseRefetch.promise;
      },
    });

    harness.render();
    const cleanup = harness.runLatestEffect();
    await refetchStarted.promise;
    // A resposta device-global some antes do refetch/tenant alignment terminar.
    expect(harness.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
    releaseRefetch.resolve({ isError: false, data: [{ id: 11 }, { id: 22 }] });
    await vi.waitFor(() => expect(harness.routerPush).toHaveBeenCalledTimes(1));

    expect(harness.activeTenant().institutionId).toBe(11);
    expect(harness.routerPush).toHaveBeenCalledWith({
      pathname: "/confirm-duty",
      params: { token: "cold-token-a" },
    });
    (cleanup as (() => void) | undefined)?.();
  });

  it("Listener real descarta cold sync_error da conta A após logout e login B", async () => {
    const staleResponse = notificationResponse("cold-sync-error-a", {
      type: "sync_error",
      institutionId: 11,
      previousUserId: 7,
    });
    const refetch = vi.fn(async () => ({
      isError: false,
      data: [{ id: 11 }, { id: 22 }],
    }));
    const harness = await renderRealNotificationListener({
      user: null,
      activeTenant: { institutionId: 22, revision: 6 },
      lastResponse: staleResponse,
      refetch,
    });

    // Entre logout de A e hidratação de B, a resposta física não é consumida.
    harness.render();
    const loggedOutCleanup = harness.runLatestEffect();
    expect(harness.getLastNotificationResponse).not.toHaveBeenCalled();
    (loggedOutCleanup as (() => void) | undefined)?.();

    // Após o login B, o cold tap legado é limpo e termina sem sequer consultar
    // a allowlist, trocar tenant, invalidar cache ou alcançar uma rota.
    harness.setUser({ id: 8 });
    harness.render();
    const accountBCleanup = harness.runLatestEffect();
    await vi.waitFor(() => {
      expect(harness.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Mesmo identifier/action, agora com conteúdo roteável: se sync_error
    // tivesse sido liberado como retryable, este evento LIVE consultaria a
    // allowlist e abriria a confirmação sob a conta B.
    harness.emit(notificationResponse("cold-sync-error-a", {
      type: "duty_confirmation",
      institutionId: 11,
      confirmationToken: "must-not-open",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(refetch).not.toHaveBeenCalled();
    expect(harness.setActiveInstitutionId).not.toHaveBeenCalled();
    expect(harness.invalidateQueries).not.toHaveBeenCalled();
    expect(harness.routerPush).not.toHaveBeenCalled();
    expect(harness.activeTenant()).toEqual({ institutionId: 22, revision: 6 });
    (accountBCleanup as (() => void) | undefined)?.();
  });

  it("Listener real deduplica last+LIVE enquanto in-flight e só navega uma vez", async () => {
    const response = notificationResponse("cold-live-same", {
      type: "duty_nomination",
      institutionId: 11,
      confirmationToken: "same-token",
    });
    const refetchStarted = deferred();
    const releaseRefetch = deferred<{ isError: boolean; data: { id: number }[] }>();
    const harness = await renderRealNotificationListener({
      lastResponse: response,
      refetch: async () => {
        refetchStarted.resolve();
        return releaseRefetch.promise;
      },
    });

    harness.render();
    const cleanup = harness.runLatestEffect();
    await refetchStarted.promise;
    harness.emit(response);
    releaseRefetch.resolve({ isError: false, data: [{ id: 11 }, { id: 22 }] });
    await vi.waitFor(() => expect(harness.routerPush).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(harness.setActiveInstitutionId).toHaveBeenCalledTimes(1);
    (cleanup as (() => void) | undefined)?.();
  });

  it("Listener real rejeita custom action e tenant alheio sem efeito", async () => {
    const harness = await renderRealNotificationListener({ allowedInstitutionIds: [11] });
    harness.render();
    const cleanup = harness.runLatestEffect();
    harness.emit(notificationResponse("custom", {
      type: "duty_confirmation",
      institutionId: 11,
      confirmationToken: "custom-token",
    }, "CUSTOM_ACTION"));
    harness.emit(notificationResponse("foreign", {
      type: "duty_confirmation",
      institutionId: 99,
      confirmationToken: "foreign-token",
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.setActiveInstitutionId).not.toHaveBeenCalled();
    expect(harness.invalidateQueries).not.toHaveBeenCalled();
    expect(harness.routerPush).not.toHaveBeenCalled();
    (cleanup as (() => void) | undefined)?.();
  });

  it("Listener real libera resposta false para um novo tap LIVE", async () => {
    let attempt = 0;
    const response = notificationResponse("retry-after-false", {
      type: "duty_confirmation",
      institutionId: 11,
      confirmationToken: "retry-token",
    });
    const harness = await renderRealNotificationListener({
      refetch: async () => ({
        isError: false,
        data: (++attempt === 1 ? [{ id: 22 }] : [{ id: 11 }, { id: 22 }]),
      }),
    });
    harness.render();
    const cleanup = harness.runLatestEffect();
    harness.emit(response);
    await vi.waitFor(() => expect(attempt).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.routerPush).not.toHaveBeenCalled();

    harness.emit(response);
    await vi.waitFor(() => expect(harness.routerPush).toHaveBeenCalledTimes(1));
    (cleanup as (() => void) | undefined)?.();
  });

  it("Listener não consome durante hidratação e cold claimado não reaparece após logout/remount", async () => {
    const response = notificationResponse("cold-logout", {
      type: "duty_confirmation",
      institutionId: 11,
      confirmationToken: "logout-token",
    });
    const refetchStarted = deferred();
    const releaseRefetch = deferred<{ isError: boolean; data: { id: number }[] }>();
    const harness = await renderRealNotificationListener({
      user: null,
      lastResponse: response,
      refetch: async () => {
        refetchStarted.resolve();
        return releaseRefetch.promise;
      },
    });

    harness.render();
    const hydrationCleanup = harness.runLatestEffect();
    expect(harness.getLastNotificationResponse).not.toHaveBeenCalled();
    expect(harness.clearLastNotificationResponse).not.toHaveBeenCalled();
    (hydrationCleanup as (() => void) | undefined)?.();

    harness.setUser({ id: 7 });
    harness.render();
    const authenticatedCleanup = harness.runLatestEffect();
    await refetchStarted.promise;
    expect(harness.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
    (authenticatedCleanup as (() => void) | undefined)?.();

    harness.setUser({ id: 8 });
    harness.render();
    const nextUserCleanup = harness.runLatestEffect();
    releaseRefetch.resolve({ isError: false, data: [{ id: 11 }] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.routerPush).not.toHaveBeenCalled();
    // O remount do usuário 8 lê null; a resposta física já foi consumida.
    expect(harness.getLastNotificationResponse).toHaveBeenLastCalledWith();
    (nextUserCleanup as (() => void) | undefined)?.();
  });

  it("useNotifications real cerca usuário/unmount e registra rollover apenas na sessão atual", async () => {
    const staleRegistration = deferred<{ success: boolean }>();
    const staleMutate = vi.fn(() => staleRegistration.promise);
    const stale = await renderRealUseNotifications({
      userId: 7,
      initialToken: "Expo-stale-a",
      mutateAsync: staleMutate,
    });
    const staleCleanup = stale.runEffect();
    expect(stale.effectCount()).toBe(1);
    await vi.waitFor(() => expect(stale.getPermissionsAsync).toHaveBeenCalledTimes(1));
    expect(stale.getExpoPushTokenAsync).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(staleMutate).toHaveBeenCalledWith({
      token: "Expo-stale-a",
      platform: "ios",
      expectedUserId: 7,
    }));
    (staleCleanup as (() => void) | undefined)?.();
    staleRegistration.resolve({ success: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(stale.setExpoPushToken).not.toHaveBeenCalled();
    expect(stale.setLastPushToken).not.toHaveBeenCalled();
    stale.emitRollover("late-device-a");
    await Promise.resolve();
    expect(staleMutate).toHaveBeenCalledTimes(1);

    const currentMutate = vi.fn(async () => ({ success: true }));
    const current = await renderRealUseNotifications({
      userId: 8,
      initialToken: "Expo-current-b",
      mutateAsync: currentMutate,
    });
    const currentCleanup = current.runEffect();
    await vi.waitFor(() => expect(current.setLastPushToken).toHaveBeenCalledWith("Expo-current-b"));
    current.emitRollover("rollover-b");
    await vi.waitFor(() => expect(currentMutate).toHaveBeenCalledWith({
      token: "Expo-rollover-b",
      platform: "ios",
      expectedUserId: 8,
    }));
    expect(current.setLastPushToken).toHaveBeenLastCalledWith("Expo-rollover-b");
    (currentCleanup as (() => void) | undefined)?.();
    current.emitRollover("after-logout-b");
    await Promise.resolve();
    expect(currentMutate).toHaveBeenCalledTimes(2);
    expect(current.removeReceived).toHaveBeenCalledTimes(1);
    expect(current.removePushToken).toHaveBeenCalledTimes(1);
  });

  it("scope novo não aguarda refetch pendente da sessão invalidada", async () => {
    const coordinator = createNotificationRoutingCoordinator();
    const staleScope = coordinator.beginScope();
    const staleRefetchStarted = deferred();
    const releaseStaleRefetch = deferred<readonly number[]>();
    const calls: string[] = [];
    let activeTenant = { institutionId: 22, revision: 1 };

    const staleRoute = staleScope.enqueue({
      type: "duty_confirmation",
      institutionId: 11,
      confirmationToken: "stale-token",
    }, {
      getActiveTenantSnapshot: () => activeTenant,
      loadAllowedInstitutionIds: async () => {
        staleRefetchStarted.resolve();
        return releaseStaleRefetch.promise;
      },
      setActiveInstitutionId: async () => {
        calls.push("stale:set");
      },
      invalidateQueries: async () => {
        calls.push("stale:invalidate");
      },
      navigateToConfirmation: () => {
        calls.push("stale:navigate");
      },
      navigateToAgenda: vi.fn(),
      openComunica: vi.fn(async () => ({ ok: true })),
    });
    await staleRefetchStarted.promise;

    staleScope.invalidate();
    const currentScope = coordinator.beginScope();
    const currentRoute = currentScope.enqueue({
      type: "duty_confirmation",
      institutionId: 33,
      confirmationToken: "current-token",
    }, {
      getActiveTenantSnapshot: () => activeTenant,
      loadAllowedInstitutionIds: async () => [33],
      setActiveInstitutionId: async (institutionId) => {
        calls.push(`current:set:${institutionId}`);
        activeTenant = { institutionId, revision: activeTenant.revision + 1 };
      },
      invalidateQueries: async () => {
        calls.push("current:invalidate");
      },
      navigateToConfirmation: (token) => {
        calls.push(`current:navigate:${token}`);
      },
      navigateToAgenda: vi.fn(),
      openComunica: vi.fn(async () => ({ ok: true })),
    });

    await expect(currentRoute).resolves.toBe(true);
    expect(calls).toEqual([
      "current:set:33",
      "current:invalidate",
      "current:navigate:current-token",
    ]);

    releaseStaleRefetch.resolve([11]);
    await expect(staleRoute).resolves.toBe(false);
    expect(calls).toEqual([
      "current:set:33",
      "current:invalidate",
      "current:navigate:current-token",
    ]);
  });

  it("usa getRandomValues quando randomUUID não existe", () => {
    const getRandomValues = vi.fn((target: Uint8Array) => {
      target.set(Array.from({ length: 16 }, (_, index) => index));
      return target;
    });

    expect(generateSsoClientNonce({ getRandomValues })).toBe(
      "000102030405060708090a0b0c0d0e0f",
    );
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });

  it("falha fechado sem CSPRNG e não toca a rede", () => {
    expect(() => generateSsoClientNonce({})).toThrow("Gerador criptográfico indisponível");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ConfirmDutyScreen real consulta, exibe e responde exatamente o token B dirigido", async () => {
    const tokenA = "11111111-1111-4111-8111-111111111111";
    const tokenB = "22222222-2222-4222-8222-222222222222";
    const harness = await renderRealConfirmDutyScreen({
      token: tokenB,
      pending: {
        confirmationToken: tokenB,
        shiftLabel: "Plantão B",
        shiftStartAt: "2032-05-12T10:00:00.000Z",
        shiftEndAt: "2032-05-12T16:00:00.000Z",
        sectorName: "Setor B",
      },
      nomination: null,
    });

    expect(harness.getPending).toHaveBeenCalledWith(
      { confirmationToken: tokenB },
      expect.objectContaining({ enabled: true }),
    );
    expect(harness.getNomination).toHaveBeenCalledWith(
      { confirmationToken: tokenB },
      expect.objectContaining({ enabled: true }),
    );
    expect(harness.text).toContain("Plantão B");
    expect(JSON.stringify(harness.tree)).not.toContain(tokenA);

    const confirmButton = harness.elements.find(
      (element) =>
        element.type === harness.PrimaryButton &&
        element.props?.label === "Sim, confirmo",
    );
    expect(confirmButton).toBeDefined();
    (confirmButton?.props?.onPress as (() => void))();
    expect(harness.confirmMutate).toHaveBeenCalledWith({ confirmationToken: tokenB });
  });

  it("ConfirmDutyScreen real nunca converte nominationQuery.isError em sucesso verde", async () => {
    const tokenB = "22222222-2222-4222-8222-222222222222";
    const harness = await renderRealConfirmDutyScreen({
      token: tokenB,
      pending: null,
      nomination: null,
      nominationError: true,
    });

    const errorState = harness.elements.find(
      (element) => element.type === harness.QueryErrorState,
    );
    expect(errorState?.props?.title).toBe("Não foi possível verificar suas confirmações");
    expect(harness.text).not.toContain("Nenhuma confirmação pendente");
    expect(harness.elements).not.toContainEqual(
      expect.objectContaining({ props: expect.objectContaining({ label: "Voltar à Agenda" }) }),
    );
  });

  it("useSsoHandoff real bloqueia form submit quando o tenant vivo muda sem rerender", async () => {
    vi.resetModules();
    const setState = vi.fn();
    const fenceRef: { current: unknown } = { current: null };
    let activeTenant = { institutionId: 11, revision: 1 };
    vi.doMock("react", () => ({
      useCallback: (callback: unknown) => callback,
      useEffect: vi.fn(),
      useRef: () => fenceRef,
      useState: (initial: unknown) => [initial, setState],
    }));
    vi.doMock("react-native", () => ({ Platform: { OS: "web" } }));
    vi.doMock("@/lib/_core/api", () => ({ getApiBaseUrl: () => "https://escala.example" }));
    vi.doMock("@/lib/tenant-state", () => ({
      getActiveTenantSnapshot: () => activeTenant,
    }));
    vi.doMock("@/lib/sso-launch", () => ({
      isValidSsoTenantId: (value: unknown) =>
        Number.isSafeInteger(value) && Number(value) > 0,
    }));

    let resolveStaleFetch!: (response: unknown) => void;
    const deferredFetch = new Promise((resolve) => {
      resolveStaleFetch = resolve;
    });
    const hookFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn(async () => ({
          targetUrl: "https://comunica.example/entry",
          handoffToken: "STABLE_WEB_TOKEN",
        })),
      })
      .mockReturnValueOnce(deferredFetch);
    vi.stubGlobal("fetch", hookFetch);
    const formSubmit = vi.fn();
    vi.stubGlobal("document", {
      createElement: vi.fn((tagName: string) => tagName === "form"
        ? {
            method: "",
            action: "",
            style: {},
            appendChild: vi.fn(),
            remove: vi.fn(),
            submit: formSubmit,
          }
        : { type: "", name: "", value: "" }),
      body: { appendChild: vi.fn() },
    });

    const { useSsoHandoff } = await import("../hooks/use-sso-handoff");
    const hook = useSsoHandoff(11);
    await hook.launch();
    expect(formSubmit).toHaveBeenCalledTimes(1);

    const staleLaunch = hook.launch();
    await vi.waitFor(() => expect(hookFetch).toHaveBeenCalledTimes(2));
    activeTenant = { institutionId: 22, revision: 2 };
    resolveStaleFetch({
      ok: true,
      json: vi.fn(async () => ({
        targetUrl: "https://comunica.example/entry",
        handoffToken: "STALE_WEB_TOKEN",
      })),
    });
    await staleLaunch;

    expect(formSubmit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(setState.mock.calls)).not.toContain("STALE_WEB_TOKEN");
  });

  it("useSsoHandoff real bloqueia openURL quando o tenant vivo muda sem rerender", async () => {
    vi.resetModules();
    vi.doUnmock("@/lib/sso-launch");
    const setState = vi.fn();
    const fenceRef: { current: unknown } = { current: null };
    let activeTenant = { institutionId: 11, revision: 1 };
    const openURL = vi.fn(async () => undefined);
    vi.doMock("react", () => ({
      useCallback: (callback: unknown) => callback,
      useEffect: vi.fn(),
      useRef: () => fenceRef,
      useState: (initial: unknown) => [initial, setState],
    }));
    vi.doMock("react-native", () => ({
      Platform: { OS: "ios" },
      Linking: { openURL },
    }));
    vi.doMock("@/lib/_core/api", () => ({ getApiBaseUrl: () => "https://escala.example" }));
    vi.doMock("@/lib/_core/auth", () => ({
      getSessionToken: vi.fn(async () => "session-token"),
    }));
    vi.doMock("@/lib/tenant-state", () => ({
      getActiveTenantSnapshot: () => activeTenant,
    }));

    let resolveStaleFetch!: (response: unknown) => void;
    const deferredFetch = new Promise((resolve) => {
      resolveStaleFetch = resolve;
    });
    const hookFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn(async () => ({
          launchUrl: "https://escala.example/api/sso/launch?code=stable",
        })),
      })
      .mockReturnValueOnce(deferredFetch);
    vi.stubGlobal("fetch", hookFetch);

    const { useSsoHandoff } = await import("../hooks/use-sso-handoff");
    const hook = useSsoHandoff(11);
    await hook.launch();
    expect(openURL).toHaveBeenCalledTimes(1);

    const staleLaunch = hook.launch();
    await vi.waitFor(() => expect(hookFetch).toHaveBeenCalledTimes(2));
    activeTenant = { institutionId: 22, revision: 2 };
    resolveStaleFetch({
      ok: true,
      json: vi.fn(async () => ({
        launchUrl: "https://escala.example/api/sso/launch?code=STALE_NATIVE_CODE",
      })),
    });
    await staleLaunch;

    expect(openURL).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(openURL.mock.calls)).not.toContain("STALE_NATIVE_CODE");
  });

  it("cleanup real de useSsoHandoff aborta a geração e impede navegação tardia", async () => {
    vi.resetModules();
    const effects: (() => void | (() => void))[] = [];
    const setState = vi.fn();
    const fenceRef: { current: unknown } = { current: null };
    vi.doMock("react", () => ({
      useCallback: (callback: unknown) => callback,
      useEffect: (effect: () => void | (() => void)) => {
        effects.push(effect);
      },
      useRef: () => fenceRef,
      useState: (initial: unknown) => [initial, setState],
    }));
    vi.doMock("react-native", () => ({ Platform: { OS: "web" } }));
    vi.doMock("@/lib/_core/api", () => ({ getApiBaseUrl: () => "https://escala.example" }));
    vi.doMock("@/lib/tenant-state", () => ({
      getActiveTenantSnapshot: () => ({ institutionId: 11, revision: 1 }),
    }));
    vi.doMock("@/lib/sso-launch", () => ({
      isValidSsoTenantId: (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0,
    }));

    let resolveFetch!: (response: unknown) => void;
    const deferredFetch = vi.fn(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));
    vi.stubGlobal("fetch", deferredFetch);
    const createElement = vi.fn();
    vi.stubGlobal("document", {
      createElement,
      body: { appendChild: vi.fn() },
    });

    const { useSsoHandoff } = await import("../hooks/use-sso-handoff");
    const hook = useSsoHandoff(11);
    const cleanup = effects[0]?.();
    const launch = hook.launch();
    await vi.waitFor(() => expect(deferredFetch).toHaveBeenCalledTimes(1));
    const requestSignal = (deferredFetch.mock.calls[0]?.[1] as RequestInit).signal;
    const stateCallsBeforeCleanup = setState.mock.calls.length;

    expect(typeof cleanup).toBe("function");
    (cleanup as () => void)();
    expect(requestSignal?.aborted).toBe(true);
    resolveFetch({
      ok: true,
      json: vi.fn(async () => ({
        targetUrl: "https://comunica.example/entry",
        handoffToken: "STALE_HOOK_TOKEN",
      })),
    });
    await launch;

    expect(createElement).not.toHaveBeenCalled();
    expect(setState).toHaveBeenCalledTimes(stateCallsBeforeCleanup);
  });

  async function loadRealTenantStateHarness(storage: {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
    removeItem: (key: string) => Promise<void>;
  }) {
    vi.resetModules();
    vi.doUnmock("@/lib/tenant-state");
    vi.doUnmock("../lib/tenant-state");
    const state: unknown[] = [];
    let stateCursor = 0;
    let contextValue: {
      activeInstitutionId: number | null;
      setActiveInstitutionId: (id: number) => Promise<void>;
      clearInstitutionSelection: () => Promise<void>;
    } | null = null;
    const Provider = Symbol("TenantStateProvider");

    vi.doMock("react", () => ({
      createContext: () => ({ Provider }),
      createElement: (type: unknown, props: Record<string, unknown> | null) => {
        if (type === Provider) {
          contextValue = props?.value as typeof contextValue;
        }
        return { type, props };
      },
      useCallback: (callback: unknown) => callback,
      useContext: () => contextValue,
      useEffect: vi.fn(),
      useMemo: (factory: () => unknown) => factory(),
      useState: (initial: unknown) => {
        const index = stateCursor++;
        state[index] = initial;
        return [
          state[index],
          (value: unknown) => {
            state[index] = typeof value === "function"
              ? (value as (current: unknown) => unknown)(state[index])
              : value;
          },
        ];
      },
    }));
    vi.doMock("react-native", () => ({ Platform: { OS: "ios" } }));
    vi.doMock("@react-native-async-storage/async-storage", () => ({
      default: storage,
    }));

    const tenantState = await import("../lib/tenant-state");
    tenantState.TenantStateProvider({ children: null });
    if (!contextValue) throw new Error("TenantStateProvider não publicou contexto");
    return {
      tenantState,
      context: contextValue,
      reactState: () => state[0] as number | null,
    };
  }

  it("Provider real não deixa storage A tardio reverter B após timeout da rota", async () => {
    vi.useFakeTimers();
    const stored = new Map<string, string>();
    const aWriteStarted = deferred();
    const releaseAWrite = deferred();
    const aInvalidateStarted = deferred();
    const releaseAInvalidate = deferred();
    const writes: string[] = [];
    const navigate = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const harness = await loadRealTenantStateHarness({
        getItem: async (key) => stored.get(key) ?? null,
        setItem: async (key, value) => {
          writes.push(value);
          if (value === "11" && !stored.has("delayed-a")) {
            stored.set("delayed-a", "1");
            aWriteStarted.resolve();
            await releaseAWrite.promise;
          }
          stored.set(key, value);
        },
        removeItem: async (key) => {
          stored.delete(key);
        },
      });
      await harness.context.setActiveInstitutionId(22);

      const coordinator = createNotificationRoutingCoordinator();
      const scope = coordinator.beginScope();
      const dependencies = {
        getActiveTenantSnapshot: harness.tenantState.getActiveTenantSnapshot,
        loadAllowedInstitutionIds: async () => [11, 22],
        setActiveInstitutionId: harness.context.setActiveInstitutionId,
        invalidateQueries: async () => {
          if (harness.tenantState.getActiveTenantSnapshot().institutionId === 11) {
            aInvalidateStarted.resolve();
            await releaseAInvalidate.promise;
          }
        },
        navigateToConfirmation: navigate,
        navigateToAgenda: vi.fn(),
        openComunica: vi.fn(async () => ({ ok: true })),
      };

      const routeA = scope.enqueue({
        type: "duty_confirmation",
        institutionId: 11,
        confirmationToken: "token-a",
      }, dependencies);
      await aWriteStarted.promise;
      await aInvalidateStarted.promise;
      const routeB = scope.enqueue({
        type: "duty_confirmation",
        institutionId: 22,
        confirmationToken: "token-b",
      }, dependencies);

      await vi.advanceTimersByTimeAsync(NOTIFICATION_ROUTING_ITEM_TIMEOUT_MS);
      await expect(routeA).resolves.toBe(false);
      await expect(routeB).resolves.toBe(true);
      expect(navigate).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenCalledWith("token-b");
      expect(harness.reactState()).toBe(22);
      expect(harness.tenantState.getActiveTenantSnapshot().institutionId).toBe(22);

      releaseAWrite.resolve();
      releaseAInvalidate.resolve();
      await vi.runAllTimersAsync();
      await Promise.resolve();
      await Promise.resolve();

      expect(harness.reactState()).toBe(22);
      expect(harness.tenantState.getActiveTenantSnapshot().institutionId).toBe(22);
      expect(stored.get("activeInstitutionId")).toBe("22");
      expect(writes.at(-1)).toBe("22");
      expect(navigate).toHaveBeenCalledTimes(1);
    } finally {
      releaseAWrite.resolve();
      releaseAInvalidate.resolve();
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("clear real vence uma persistência anterior que termina fora de ordem", async () => {
    const stored = new Map<string, string>([["activeInstitutionId", "22"]]);
    const aWriteStarted = deferred();
    const releaseAWrite = deferred();
    let delayA = true;
    const operations: string[] = [];
    const harness = await loadRealTenantStateHarness({
      getItem: async (key) => stored.get(key) ?? null,
      setItem: async (key, value) => {
        operations.push(`set:${value}`);
        if (value === "11" && delayA) {
          delayA = false;
          aWriteStarted.resolve();
          await releaseAWrite.promise;
        }
        stored.set(key, value);
      },
      removeItem: async (key) => {
        operations.push("clear");
        stored.delete(key);
      },
    });

    await harness.context.setActiveInstitutionId(11);
    await aWriteStarted.promise;
    await harness.context.clearInstitutionSelection();
    expect(harness.reactState()).toBeNull();
    expect(harness.tenantState.getActiveTenantSnapshot().institutionId).toBeNull();

    releaseAWrite.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.reactState()).toBeNull();
    expect(harness.tenantState.getActiveTenantSnapshot().institutionId).toBeNull();
    expect(stored.has("activeInstitutionId")).toBe(false);
    expect(operations.at(-1)).toBe("clear");
  });

  it("falha de storage é best-effort e não reverte memória nem estado React", async () => {
    const sentinel = "RAW_TENANT_STORAGE_SENTINEL";
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const harness = await loadRealTenantStateHarness({
        getItem: async () => null,
        setItem: async () => {
          throw new Error(sentinel);
        },
        removeItem: async () => {
          throw new Error(sentinel);
        },
      });

      await expect(harness.context.setActiveInstitutionId(33)).resolves.toBeUndefined();
      await Promise.resolve();
      expect(harness.reactState()).toBe(33);
      expect(harness.tenantState.getActiveTenantSnapshot().institutionId).toBe(33);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
