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
  captureSessionTransportTicket: vi.fn(() => 7 as number | null),
  isSessionTransportTicketCurrent: vi.fn((ticket: number) => ticket === 7),
  runExclusiveWebSessionMutation: vi.fn(
    async (operation: (signal: AbortSignal) => Promise<unknown>) =>
      operation(new AbortController().signal),
  ),
  WebSessionMutationCancelledError: class extends Error {
    readonly code = "WEB_SESSION_MUTATION_CANCELLED";

    constructor() {
      super("Workflow de sessão web excedeu o prazo seguro");
      this.name = "WebSessionMutationCancelledError";
    }
  },
  apiFetch: vi.fn(),
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

function collectTestElements(
  node: unknown,
  elements: TestElement[] = [],
): TestElement[] {
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
  vi.doMock("lucide-react-native", () => ({
    Check: "Check",
    X: "X",
    Clock: "Clock",
  }));
  vi.doMock("expo-haptics", () => ({
    impactAsync: vi.fn(),
    notificationAsync: vi.fn(),
    ImpactFeedbackStyle: { Medium: "medium" },
    NotificationFeedbackType: { Warning: "warning" },
  }));
  vi.doMock("@/lib/ui/alert", () => ({ uiConfirmDestructive: vi.fn() }));
  vi.doMock("@/components/ui/ScreenGradient", () => ({
    ScreenGradient: "ScreenGradient",
  }));
  vi.doMock("@/components/ui/TintedGlassCard", () => ({
    TintedGlassCard: "TintedGlassCard",
  }));
  vi.doMock("@/components/ui/PrimaryButton", () => ({ PrimaryButton }));
  vi.doMock("@/components/ui/Badge", () => ({ Badge: "Badge" }));
  vi.doMock("@/components/ui/QueryErrorState", () => ({ QueryErrorState }));
  vi.doMock("@/hooks/use-auth", () => ({
    useAuth: () => ({ user: { id: 7 } }),
  }));
  vi.doMock("@/hooks/use-action-feedback", () => ({
    useActionFeedback: () => ({
      success: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    }),
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
  sessionVerified?: boolean;
  sessionAuthorizationCurrent?: boolean;
  activeTenant?: { institutionId: number | null; revision: number };
  allowedInstitutionIds?: number[];
  lastResponse?: ReturnType<typeof notificationResponse> | null;
  refetch?: () => Promise<{ isError: boolean; data: { id: number }[] }>;
  platform?: "ios" | "web";
  runWebSsoHandoff?: (
    tenantId: number,
    request: { signal: AbortSignal; isCurrent: () => boolean },
  ) => Promise<{ ok: boolean; cancelled?: true }>;
}) {
  vi.resetModules();
  clientMocks.platform.OS = options.platform ?? "ios";
  const effects: (() => void | (() => void))[] = [];
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
  const openComunicaFromNotification = vi.fn(async () => ({ ok: true }));
  const notificationWebHandoff = vi.fn(
    options.runWebSsoHandoff ?? (async () => ({ ok: true })),
  );
  let responseListener:
    ((response: ReturnType<typeof notificationResponse>) => void) | undefined;
  let receivedListener:
    | ((notification: { request: { content: { data: Record<string, unknown> } } }) => void)
    | undefined;
  let user = options.user === undefined ? { id: 7 } : options.user;
  let sessionVerified = options.sessionVerified ?? true;
  let sessionAuthorizationCurrent =
    options.sessionAuthorizationCurrent ?? sessionVerified;
  const sessionValidationIsCurrent = vi.fn(() => sessionAuthorizationCurrent);
  const sessionValidation = {
    status: "VERIFIED" as const,
    sequence: 1,
    userId: user?.id ?? 7,
    ticket: { generation: 1 },
    isCurrent: sessionValidationIsCurrent,
  };
  const isSessionAuthorizationCurrent = vi.fn(
    () =>
      user !== null &&
      sessionValidation.userId === user.id &&
      sessionValidation.isCurrent(),
  );
  let activeTenant = options.activeTenant ?? { institutionId: 22, revision: 1 };
  let lastResponse = options.lastResponse ?? null;
  const allowedInstitutionIds = options.allowedInstitutionIds ?? [11, 22];
  const refetch =
    options.refetch ??
    vi.fn(async () => ({
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
    useRef: (initial: unknown) => ({ current: initial }),
  }));
  vi.doMock("expo-router", () => ({ useRouter: () => ({ push: routerPush }) }));
  vi.doMock("expo-notifications", () => ({
    DEFAULT_ACTION_IDENTIFIER: "expo.modules.notifications.actions.DEFAULT",
    addNotificationResponseReceivedListener: vi.fn(
      (listener: typeof responseListener) => {
        responseListener = listener;
        return { remove: removeSubscription };
      },
    ),
    addNotificationReceivedListener: vi.fn(
      (listener: typeof receivedListener) => {
        receivedListener = listener;
        return { remove: vi.fn() };
      },
    ),
    getLastNotificationResponse,
    clearLastNotificationResponse,
  }));
  vi.doMock("@/hooks/use-auth", () => ({
    useAuth: () => ({
      user,
      isAuthenticated: sessionVerified,
      isSessionAuthorizationCurrent,
      sessionValidation,
      pushRegistrationRevision: 0,
    }),
  }));
  vi.doMock("@/hooks/use-notifications", () => ({ useNotifications: vi.fn() }));
  vi.doMock("@/lib/sso-launch", () => ({
    openComunica: openComunicaFromNotification,
  }));
  vi.doUnmock("@/hooks/use-sso-handoff");
  if (options.platform === "web") {
    vi.doMock("@/hooks/use-sso-handoff", () => ({
      runWebSsoHandoff: notificationWebHandoff,
    }));
  }
  vi.doMock("@/lib/tenant-state", () => ({
    getActiveTenantSnapshot: () => activeTenant,
    useTenantState: () => ({ setActiveInstitutionId }),
  }));
  const invalidateCountActionable = vi.fn(async () => undefined);
  const invalidateListAvailable = vi.fn(async () => undefined);
  const invalidateSwapList = vi.fn(async () => undefined);
  vi.doMock("@/lib/trpc", () => ({
    trpc: {
      useUtils: () => ({
        invalidate: invalidateQueries,
        swaps: {
          countActionable: { invalidate: invalidateCountActionable },
          listAvailable: { invalidate: invalidateListAvailable },
          list: { invalidate: invalidateSwapList },
        },
      }),
      professionals: {
        listMyInstitutions: { useQuery: () => ({ refetch }) },
      },
    },
  }));
  vi.stubGlobal("React", { createElement });

  const { NotificationListener: Component } =
    await import("../components/NotificationListener");
  return {
    render: () => Component(),
    runLatestEffect: () => {
      const cleanups = effects
        .map((effect) => effect())
        .filter(
          (cleanup): cleanup is () => void => typeof cleanup === "function",
        );
      return () => {
        for (const cleanup of [...cleanups].reverse()) cleanup();
      };
    },
    effects,
    routerPush,
    removeSubscription,
    refetch,
    invalidateQueries,
    invalidateCountActionable,
    invalidateListAvailable,
    invalidateSwapList,
    setActiveInstitutionId,
    openComunicaFromNotification,
    notificationWebHandoff,
    isSessionAuthorizationCurrent,
    sessionValidationIsCurrent,
    getLastNotificationResponse,
    clearLastNotificationResponse,
    emit: (response: ReturnType<typeof notificationResponse>) =>
      responseListener?.(response),
    emitReceived: (data: Record<string, unknown>) =>
      receivedListener?.({
        request: { content: { data } },
      }),
    setUser: (next: { id: number } | null) => {
      user = next;
    },
    setSessionVerified: (next: boolean) => {
      sessionVerified = next;
      sessionAuthorizationCurrent = next;
    },
    setSessionAuthorizationCurrent: (next: boolean) => {
      sessionAuthorizationCurrent = next;
    },
    activeTenant: () => activeTenant,
  };
}

async function renderRealUseNotifications(options: {
  userId: number;
  initialToken: string;
  mutateAsync: (
    input: Record<string, unknown>,
  ) => Promise<{ success: boolean }>;
  getExpoPushTokenAsync?: (input?: {
    devicePushToken?: { data: string };
  }) => Promise<{ data: string }>;
  seedFreshProofToken?: string;
  proofReadGate?: Promise<void>;
  failProofInvalidation?: boolean;
  legacyProofWithoutVault?: boolean;
  initialServerRegisteredPushToken?: { userId: number; token: string };
  hydrateServerRegisteredPushToken?: (
    userId: number,
    platform: "ios" | "android" | "web",
  ) => Promise<string | null>;
  persistServerRegisteredPushToken?: (context: {
    userId: number;
    token: string;
    platform: "ios" | "android" | "web";
  }) => Promise<void>;
  realPushTokenStorage?: {
    asyncValues: Map<string, string>;
    secureValues: Map<string, string>;
  };
}) {
  vi.resetModules();
  vi.doUnmock("@/hooks/use-notifications");
  vi.doUnmock("../hooks/use-notifications");
  const effects: (() => void | (() => void))[] = [];
  const setExpoPushToken = vi.fn();
  const setNotification = vi.fn();
  let lastPushToken: string | null = null;
  const getLastPushToken = vi.fn(() => lastPushToken);
  const setLastPushToken = vi.fn((token: string | null) => {
    lastPushToken = token;
    if (token === null) serverRegisteredPushToken = null;
  });
  let serverRegisteredPushToken: { userId: number; token: string } | null =
    options.initialServerRegisteredPushToken ??
    (!options.legacyProofWithoutVault && options.seedFreshProofToken
      ? { userId: options.userId, token: options.seedFreshProofToken }
      : null);
  const getServerRegisteredPushToken = vi.fn((userId: number) =>
    serverRegisteredPushToken?.userId === userId
      ? serverRegisteredPushToken.token
      : null,
  );
  const recordServerRegisteredPushToken = vi.fn(
    (userId: number, token: string) => {
      serverRegisteredPushToken = { userId, token };
    },
  );
  const hydrateServerRegisteredPushToken = vi.fn(
    options.hydrateServerRegisteredPushToken ??
      (async (userId: number, _platform: "ios" | "android" | "web") =>
        serverRegisteredPushToken?.userId === userId
          ? serverRegisteredPushToken.token
          : null),
  );
  const persistServerRegisteredPushToken = vi.fn(
    options.persistServerRegisteredPushToken ??
      (async (context: {
        userId: number;
        token: string;
        platform: "ios" | "android" | "web";
      }) => {
        serverRegisteredPushToken = {
          userId: context.userId,
          token: context.token,
        };
      }),
  );
  const removeReceived = vi.fn();
  const removePushToken = vi.fn();
  let pushTokenListener:
    ((token: { type: string; data: string }) => void) | undefined;
  let stateIndex = 0;
  const getPermissionsAsync = vi.fn(async () => ({ status: "granted" }));
  const getExpoPushTokenAsync = vi.fn(
    options.getExpoPushTokenAsync ??
      (async (input?: { devicePushToken?: { data: string } }) => ({
        data: input?.devicePushToken
          ? `Expo-${input.devicePushToken.data}`
          : options.initialToken,
      })),
  );

  vi.doMock("react", () => ({
    useEffect: (effect: () => void | (() => void)) => effects.push(effect),
    useRef: (initial: unknown) => ({ current: initial }),
    useState: (initial: unknown) => {
      const setter = stateIndex++ === 0 ? setExpoPushToken : setNotification;
      return [initial, setter];
    },
  }));
  vi.doMock("expo-device", () => ({
    isDevice: true,
    default: { isDevice: true },
  }));
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
  const pushProofStorage =
    options.realPushTokenStorage?.asyncValues ?? new Map<string, string>();
  let gateProofReads = false;
  let failProofInvalidation = false;
  vi.doMock("@react-native-async-storage/async-storage", () => ({
    default: {
      getItem: vi.fn(async (key: string) => {
        if (gateProofReads) await options.proofReadGate;
        return pushProofStorage.get(key) ?? null;
      }),
      setItem: vi.fn(async (key: string, value: string) => {
        if (
          failProofInvalidation &&
          value.includes('"contextKey":"INVALIDATED"')
        ) {
          throw new Error("tombstone push indisponível");
        }
        pushProofStorage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        if (failProofInvalidation) throw new Error("remove push indisponível");
        pushProofStorage.delete(key);
      }),
    },
  }));
  if (options.realPushTokenStorage) {
    const secureValues = options.realPushTokenStorage.secureValues;
    vi.doMock("expo-secure-store", () => ({
      isAvailableAsync: vi.fn(async () => true),
      getItemAsync: vi.fn(async (key: string) => secureValues.get(key) ?? null),
      setItemAsync: vi.fn(async (key: string, value: string) => {
        secureValues.set(key, value);
      }),
      deleteItemAsync: vi.fn(async (key: string) => {
        secureValues.delete(key);
      }),
    }));
    vi.doUnmock("@/lib/push-token");
    vi.doUnmock("../lib/push-token");
  } else {
    vi.doMock("@/lib/push-token", () => ({
      clearServerRegisteredPushTokenVault: vi.fn(async () => undefined),
      getLastPushToken,
      getServerRegisteredPushToken,
      hydrateServerRegisteredPushToken,
      persistServerRegisteredPushToken,
      recordServerRegisteredPushToken,
      setLastPushToken,
    }));
  }

  if (options.seedFreshProofToken) {
    const registration = await import("../lib/push-registration");
    await registration.ensurePushRegistration(
      {
        userId: options.userId,
        token: options.seedFreshProofToken,
        platform: "ios",
      },
      async () => ({ success: true }),
    );
    // O hook abaixo precisa provar hidratação de cold start real, não
    // reutilizar a memória do módulo que criou o fixture.
    vi.resetModules();
    gateProofReads = Boolean(options.proofReadGate);
    failProofInvalidation = Boolean(options.failProofInvalidation);
  }

  const { useNotifications: useRealNotifications } =
    await import("../hooks/use-notifications");
  function NotificationsHarness() {
    useRealNotifications(options.userId);
    return null;
  }
  NotificationsHarness();
  return {
    runEffect: () => effects[0]?.(),
    remount: () => {
      stateIndex = 0;
      NotificationsHarness();
      return effects.at(-1)?.();
    },
    emitRollover: (token: string) =>
      pushTokenListener?.({ type: "ios", data: token }),
    setExpoPushToken,
    getLastPushToken,
    getServerRegisteredPushToken,
    hydrateServerRegisteredPushToken,
    persistServerRegisteredPushToken,
    recordServerRegisteredPushToken,
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
  captureSessionTransportTicket: clientMocks.captureSessionTransportTicket,
  isSessionTransportTicketCurrent: clientMocks.isSessionTransportTicketCurrent,
  runExclusiveWebSessionMutation: clientMocks.runExclusiveWebSessionMutation,
  WebSessionMutationCancelledError:
    clientMocks.WebSessionMutationCancelledError,
}));

vi.mock("@/lib/_core/api", () => ({
  getApiBaseUrl: () => "https://escala.example",
  apiFetch: clientMocks.apiFetch,
}));

vi.mock("expo-notifications", () => ({
  DEFAULT_ACTION_IDENTIFIER: "expo.modules.notifications.actions.DEFAULT",
  addNotificationResponseReceivedListener: vi.fn(() => ({ remove: vi.fn() })),
  addNotificationReceivedListener: vi.fn(() => ({ remove: vi.fn() })),
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
    clientMocks.platform.OS = "ios";
    clientMocks.captureSessionTransportTicket.mockReturnValue(7);
    clientMocks.isSessionTransportTicketCurrent.mockImplementation(
      (ticket: number) => ticket === 7,
    );
    clientMocks.runExclusiveWebSessionMutation.mockImplementation(
      async (operation: (signal: AbortSignal) => Promise<unknown>) =>
        operation(new AbortController().signal),
    );
    vi.stubGlobal("fetch", fetchMock);
    clientMocks.apiFetch.mockImplementation(
      async (path: string, options?: RequestInit) => {
        const response = await fetch(`https://escala.example${path}`, {
          ...options,
          headers: {
            Authorization: "Bearer session-token",
            ...(options?.headers as Record<string, string> | undefined),
          },
          credentials:
            clientMocks.platform.OS === "web" ? "include" : undefined,
        });
        let data: unknown = null;
        try {
          data = await response.json();
        } catch {
          // resposta sem JSON
        }
        return {
          ok: response.ok,
          status: response.status,
          data,
          credentialPresented: true,
        };
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([undefined, null, 0, -1, 1.5, Number.NaN])(
    "falha fechado sem tenant canônico e não toca sessão, rede ou Linking (%s)",
    async (institutionId) => {
      await expect(
        openComunica(institutionId as number),
      ).resolves.toMatchObject({ ok: false });
      await expect(
        openComunicaViaLaunchCode(institutionId as number),
      ).resolves.toMatchObject({
        ok: false,
      });
      await expect(
        openComunicaFromNotification({
          type: "sso_ready",
          institutionId,
          comunicaUrl: "javascript:alert(1)",
        }),
      ).resolves.toMatchObject({ ok: false });

      expect(clientMocks.captureSessionTransportTicket).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(clientMocks.openURL).not.toHaveBeenCalled();
    },
  );

  it("web rejeita o launch-code mobile e não abre URL fora do form protegido", async () => {
    clientMocks.platform.OS = "web";

    await expect(
      openComunicaFromNotification({
        type: "sso_ready",
        institutionId: 42,
      }),
    ).resolves.toMatchObject({ ok: false });

    expect(clientMocks.captureSessionTransportTicket).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(clientMocks.openURL).not.toHaveBeenCalled();
  });

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
    expect(clientMocks.openURL).not.toHaveBeenCalledWith(
      "https://attacker.example/phish",
    );
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
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const controller = new AbortController();
    const launch = openComunicaViaLaunchCode(42, { signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    controller.abort();
    resolveFetch({
      ok: true,
      status: 200,
      json: vi.fn(async () => ({
        launchUrl:
          "https://escala.example/api/sso/launch?code=STALE_LAUNCH_CODE_SENTINEL",
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

  it("BEGIN de sessão durante launch-code impede openURL mesmo com resposta 200", async () => {
    let resolveFetch!: (response: unknown) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const launch = openComunicaViaLaunchCode(42);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    clientMocks.isSessionTransportTicketCurrent.mockReturnValue(false);
    resolveFetch({
      ok: true,
      status: 200,
      json: vi.fn(async () => ({
        launchUrl:
          "https://escala.example/api/sso/launch?code=STALE_SESSION_SENTINEL",
      })),
    });

    await expect(launch).resolves.toMatchObject({ ok: false });
    expect(clientMocks.openURL).not.toHaveBeenCalled();
  });

  it("fence de geração invalida a chamada anterior e bloqueia form POST deferred", async () => {
    const fence = createSsoHandoffFence();
    const first = fence.begin();
    const second = fence.begin();
    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(second.isCurrent()).toBe(true);

    let resolveFetch!: (response: unknown) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const submit = vi.fn(() => true);
    const handoff = runWebSsoHandoff(42, second, submit);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fence.invalidate();
    resolveFetch({
      ok: true,
      status: 200,
      json: vi.fn(async () => ({
        targetUrl:
          "https://comunica.example/auth/sso/exchange?code=STALE_WEB_CODE",
        handoffToken: "STALE_WEB_TOKEN",
      })),
    });

    await expect(handoff).resolves.toEqual({ ok: false, cancelled: true });
    expect(second.signal.aborted).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });

  it("BEGIN de sessão durante generate bloqueia form POST sob o cookie seguinte", async () => {
    const fence = createSsoHandoffFence();
    const request = fence.begin();
    let resolveFetch!: (response: unknown) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const submit = vi.fn(() => true);
    const handoff = runWebSsoHandoff(42, request, submit);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    clientMocks.isSessionTransportTicketCurrent.mockReturnValue(false);
    resolveFetch({
      ok: true,
      status: 200,
      json: vi.fn(async () => ({
        targetUrl: "https://comunica.example/auth/sso/exchange",
        handoffToken: "STALE_WEB_SESSION_TOKEN",
      })),
    });

    await expect(handoff).resolves.toEqual({ ok: false, cancelled: true });
    expect(submit).not.toHaveBeenCalled();
  });

  it("mantém o Web Lock até o form submit antes de liberar uma mutação de sessão", async () => {
    let lockTail: Promise<unknown> = Promise.resolve();
    clientMocks.runExclusiveWebSessionMutation.mockImplementation(
      (operation: () => Promise<unknown>) => {
        const result = lockTail.then(operation);
        lockTail = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    );
    const response = deferred<unknown>();
    fetchMock.mockReturnValue(response.promise);
    const events: string[] = [];
    const submit = vi.fn(() => {
      events.push("submit-A");
      return true;
    });
    const request = createSsoHandoffFence().begin();

    const handoff = runWebSsoHandoff(42, request, submit);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const mutationB = clientMocks.runExclusiveWebSessionMutation(async () => {
      events.push("mutation-B");
    });
    expect(events).toEqual([]);

    response.resolve({
      ok: true,
      status: 200,
      json: vi.fn(async () => ({
        targetUrl: "https://comunica.example/auth/sso/exchange",
        handoffToken: "HANDOFF_A",
      })),
    });
    await expect(handoff).resolves.toEqual({ ok: true });
    await mutationB;

    expect(events).toEqual(["submit-A", "mutation-B"]);
  });

  it("não captura ticket nem envia generate A quando a mutação B vence o Web Lock", async () => {
    let lockTail: Promise<unknown> = Promise.resolve();
    clientMocks.runExclusiveWebSessionMutation.mockImplementation(
      (operation: () => Promise<unknown>) => {
        const result = lockTail.then(operation);
        lockTail = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    );
    const releaseMutationB = deferred<void>();
    const mutationStarted = deferred<void>();
    const mutationB = clientMocks.runExclusiveWebSessionMutation(async () => {
      mutationStarted.resolve();
      await releaseMutationB.promise;
    });
    await mutationStarted.promise;
    const submit = vi.fn(() => true);
    const request = createSsoHandoffFence().begin();
    const handoff = runWebSsoHandoff(42, request, submit);

    clientMocks.isSessionTransportTicketCurrent.mockReturnValue(false);
    releaseMutationB.resolve();
    await mutationB;
    await expect(handoff).resolves.toEqual({ ok: false, cancelled: true });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("falhas de sessão, fetch e openURL retornam somente mensagens controladas", async () => {
    const sentinel = "launchUrl=https://evil.test/?code=RAW_ERROR_SENTINEL";
    clientMocks.captureSessionTransportTicket.mockReturnValueOnce(null);
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
    const webFailure = await runWebSsoHandoff(
      42,
      fence.begin(),
      vi.fn(() => true),
    );
    expect(webFailure.ok).toBe(false);
    expect(JSON.stringify(webFailure)).not.toContain(sentinel);
  });

  it("classifica mismatch da instância de sessão como autoridade inválida", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: vi.fn(async () => ({
        error: "A instância da sessão mudou",
        code: "SESSION_INSTANCE_MISMATCH",
      })),
    });

    const result = await runWebSsoHandoff(
      42,
      createSsoHandoffFence().begin(),
      vi.fn(() => true),
    );

    expect(result).toEqual({
      ok: false,
      error: "Sua sessão ou vínculo institucional mudou. Entre novamente.",
      errorCode: "authority_invalid",
    });
  });

  it("push A com tenant B ativo troca, invalida e só então navega para o token A", async () => {
    const calls: string[] = [];
    let activeTenant = { institutionId: 22, revision: 1 };
    const navigateToConfirmation = vi.fn((token: string) =>
      calls.push(`navigate:${token}`),
    );
    const setActiveInstitutionId = vi.fn(async (id: number) => {
      calls.push(`set:${id}`);
      activeTenant = { institutionId: id, revision: activeTenant.revision + 1 };
    });
    const invalidateQueries = vi.fn(async () => {
      calls.push("invalidate");
    });

    await expect(
      routeNotificationData(
        {
          type: "duty_confirmation",
          institutionId: 11,
          confirmationToken: "confirmation-a",
        },
        {
          isSessionAuthorizationCurrent: () => true,
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
        },
      ),
    ).resolves.toBe(true);

    expect(calls).toEqual([
      "allowed",
      "set:11",
      "invalidate",
      "navigate:confirmation-a",
    ]);
    expect(navigateToConfirmation).toHaveBeenCalledWith("confirmation-a");
  });

  it("sso_ready usa o tenant normalizado do snapshot alinhado e propaga o signal do item", async () => {
    const controller = new AbortController();
    let activeTenant = { institutionId: 22, revision: 1 };
    const openComunica = vi.fn(async () => ({ ok: true }));

    await expect(
      routeNotificationData(
        { type: "sso_ready", institutionId: "11" },
        {
          isSessionAuthorizationCurrent: () => true,
          getActiveTenantSnapshot: () => activeTenant,
          loadAllowedInstitutionIds: async () => [11, 22],
          setActiveInstitutionId: async (institutionId) => {
            activeTenant = {
              institutionId,
              revision: activeTenant.revision + 1,
            };
          },
          invalidateQueries: async () => undefined,
          navigateToConfirmation: vi.fn(),
          navigateToAgenda: vi.fn(),
          openComunica,
        },
        () => true,
        controller.signal,
      ),
    ).resolves.toBe(true);

    expect(openComunica).toHaveBeenCalledWith(
      11,
      expect.any(Function),
      controller.signal,
    );
  });

  it.each([
    { label: "ausente", institutionId: undefined, allowed: [11, 22] },
    { label: "zero", institutionId: 0, allowed: [11, 22] },
    { label: "fracionário", institutionId: 11.5, allowed: [11, 22] },
    { label: "string malformada", institutionId: "11x", allowed: [11, 22] },
    { label: "alheio", institutionId: 99, allowed: [11, 22] },
  ])(
    "push com tenant $label falha fechado sem troca ou navegação",
    async ({ institutionId, allowed }) => {
      const setActiveInstitutionId = vi.fn(async () => undefined);
      const invalidateQueries = vi.fn(async () => undefined);
      const navigateToConfirmation = vi.fn();
      const navigateToAgenda = vi.fn();
      const openComunica = vi.fn(async () => ({ ok: true }));

      await expect(
        routeNotificationData(
          {
            type: "duty_nomination",
            institutionId,
            confirmationToken: "confirmation-a",
          },
          {
            isSessionAuthorizationCurrent: () => true,
            getActiveTenantSnapshot: () => ({ institutionId: 22, revision: 1 }),
            loadAllowedInstitutionIds: async () => allowed,
            setActiveInstitutionId,
            invalidateQueries,
            navigateToConfirmation,
            navigateToAgenda,
            openComunica,
          },
        ),
      ).resolves.toBe(false);

      expect(setActiveInstitutionId).not.toHaveBeenCalled();
      expect(invalidateQueries).not.toHaveBeenCalled();
      expect(navigateToConfirmation).not.toHaveBeenCalled();
      expect(navigateToAgenda).not.toHaveBeenCalled();
      expect(openComunica).not.toHaveBeenCalled();
    },
  );

  it("payload legado sem tenant não usa o tenant B atual como fallback", async () => {
    const navigateToAgenda = vi.fn();
    await expect(
      routeNotificationData(
        { type: "duty_auto_confirmed" },
        {
          isSessionAuthorizationCurrent: () => true,
          getActiveTenantSnapshot: () => ({ institutionId: 22, revision: 1 }),
          loadAllowedInstitutionIds: async () => [22],
          setActiveInstitutionId: vi.fn(async () => undefined),
          invalidateQueries: vi.fn(async () => undefined),
          navigateToConfirmation: vi.fn(),
          navigateToAgenda,
          openComunica: vi.fn(async () => ({ ok: true })),
        },
      ),
    ).resolves.toBe(false);
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
    await expect(
      routeNotificationData(
        {
          type: "sync_error",
          institutionId: 11,
          previousUserId: 1001,
        },
        {
          isSessionAuthorizationCurrent: () => true,
          getActiveTenantSnapshot: () => ({ institutionId: 22, revision: 9 }),
          loadAllowedInstitutionIds,
          setActiveInstitutionId,
          invalidateQueries,
          navigateToConfirmation,
          navigateToAgenda,
          openComunica,
        },
      ),
    ).resolves.toBe(true);

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
      isSessionAuthorizationCurrent: () => true,
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

    const routeA = scope.enqueue(
      {
        type: "duty_confirmation",
        institutionId: 11,
        confirmationToken: "token-a",
      },
      dependencies,
    );
    await aSetterReached.promise;

    const routeB = scope.enqueue(
      {
        type: "duty_confirmation",
        institutionId: 22,
        confirmationToken: "token-b",
      },
      dependencies,
    );
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

    const route = routeNotificationData(
      {
        type: "duty_confirmation",
        institutionId: 11,
        confirmationToken: "token-a",
      },
      {
        isSessionAuthorizationCurrent: () => true,
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
      },
    );

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

      const failed = scope.enqueue(
        {
          type: "duty_confirmation",
          institutionId: 11,
          confirmationToken: `secret-${failingStep}`,
        },
        {
          isSessionAuthorizationCurrent: () => true,
          getActiveTenantSnapshot: () => activeTenant,
          loadAllowedInstitutionIds: async () => {
            if (failingStep === "refetch") throw failure;
            return [11, 22];
          },
          setActiveInstitutionId: async (institutionId) => {
            if (failingStep === "setter") throw failure;
            activeTenant = {
              institutionId,
              revision: activeTenant.revision + 1,
            };
          },
          invalidateQueries: async () => {
            if (failingStep === "invalidate") throw failure;
          },
          navigateToConfirmation: firstNavigation,
          navigateToAgenda: vi.fn(),
          openComunica: vi.fn(async () => ({ ok: true })),
        },
      );

      const next = scope.enqueue(
        {
          type: "duty_confirmation",
          institutionId: 22,
          confirmationToken: "next-token",
        },
        {
          isSessionAuthorizationCurrent: () => true,
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
        },
      );

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
    expect(JSON.stringify(warn.mock.calls)).not.toContain(
      "RAW_ROUTING_SENTINEL",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-");
    warn.mockRestore();
  });

  it.each(["allowlist", "invalidate", "openComunica"] as const)(
    "deadline por item libera a fila após %s pendente e cerca a continuação tardia",
    async (pendingStep) => {
      vi.useFakeTimers();
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const coordinator = createNotificationRoutingCoordinator();
      const scope = coordinator.beginScope();
      const pendingReached = deferred();
      const releasePending = deferred<readonly number[]>();
      const firstNavigation = vi.fn();
      const firstOpenEffect = vi.fn();
      const nextNavigation = vi.fn();
      let openSignal: AbortSignal | undefined;
      let activeTenant = { institutionId: 22, revision: 1 };

      try {
        const first = scope.enqueue(
          {
            type:
              pendingStep === "openComunica"
                ? "sso_ready"
                : "duty_confirmation",
            institutionId: 11,
            confirmationToken: `secret-${pendingStep}`,
          },
          {
            isSessionAuthorizationCurrent: () => true,
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
            openComunica: async (_institutionId, canNavigate, signal) => {
              openSignal = signal;
              pendingReached.resolve();
              await releasePending.promise;
              if (canNavigate()) firstOpenEffect();
              return { ok: true };
            },
          },
        );
        await pendingReached.promise;

        const next = scope.enqueue(
          {
            type: "duty_confirmation",
            institutionId: 22,
            confirmationToken: "next-token",
          },
          {
            isSessionAuthorizationCurrent: () => true,
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
          },
        );

        await vi.advanceTimersByTimeAsync(NOTIFICATION_ROUTING_ITEM_TIMEOUT_MS);
        await expect(first).resolves.toBe(false);
        await expect(next).resolves.toBe(true);
        expect(nextNavigation).toHaveBeenCalledWith("next-token");
        if (pendingStep === "openComunica") {
          expect(openSignal?.aborted).toBe(true);
        }

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
        expect(JSON.stringify(warn.mock.calls)).not.toContain(
          `secret-${pendingStep}`,
        );
        expect(JSON.stringify(warn.mock.calls)).not.toContain(
          "RAW_LATE_ROUTING_SENTINEL",
        );
      } finally {
        releasePending.resolve([11, 22]);
        scope.invalidate();
        warn.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it("timeout aborta o generate web real, libera o Web Lock e impede form/fallback tardio", async () => {
    vi.useFakeTimers();
    clientMocks.platform.OS = "web";
    const coordinator = createNotificationRoutingCoordinator();
    const scope = coordinator.beginScope();
    const generateStarted = deferred<AbortSignal>();
    const submit = vi.fn(() => true);
    const navigateToAgenda = vi.fn();
    let activeTenant = { institutionId: 11, revision: 1 };

    clientMocks.apiFetch.mockImplementationOnce(
      async (_path: string, options?: RequestInit) => {
        const signal = options?.signal;
        if (!signal) throw new Error("signal do routing item ausente");
        generateStarted.resolve(signal);
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          ok: false,
          status: 0,
          data: null,
          credentialPresented: true,
        };
      },
    );

    try {
      const routed = scope.enqueue(
        { type: "sso_ready", institutionId: "11" },
        {
          isSessionAuthorizationCurrent: () => true,
          getActiveTenantSnapshot: () => activeTenant,
          loadAllowedInstitutionIds: async () => [11],
          setActiveInstitutionId: async (institutionId) => {
            activeTenant = {
              institutionId,
              revision: activeTenant.revision + 1,
            };
          },
          invalidateQueries: async () => undefined,
          navigateToConfirmation: vi.fn(),
          navigateToAgenda,
          openComunica: (institutionId, canNavigate, signal) =>
            runWebSsoHandoff(
              institutionId,
              { signal, isCurrent: canNavigate },
              submit,
            ),
        },
      );
      const signal = await generateStarted.promise;

      await vi.advanceTimersByTimeAsync(NOTIFICATION_ROUTING_ITEM_TIMEOUT_MS);
      await expect(routed).resolves.toBe(false);
      expect(signal.aborted).toBe(true);
      expect(submit).not.toHaveBeenCalled();
      expect(navigateToAgenda).not.toHaveBeenCalled();
      await vi.waitFor(() =>
        expect(
          clientMocks.runExclusiveWebSessionMutation.mock.results[0]?.value,
        ).resolves.toMatchObject({ ok: false }),
      );
    } finally {
      scope.invalidate();
      vi.useRealTimers();
    }
  });

  it("deadline de 15 s do workflow preserva cancelled antes do item de 20 s e libera o próximo Web Lock", async () => {
    vi.useFakeTimers();
    clientMocks.platform.OS = "web";
    const coordinator = createNotificationRoutingCoordinator();
    const scope = coordinator.beginScope();
    const workflowController = new AbortController();
    const generateStarted = deferred<AbortSignal>();
    const submit = vi.fn(() => true);
    const navigateToAgenda = vi.fn();
    let activeTenant = { institutionId: 11, revision: 1 };

    clientMocks.runExclusiveWebSessionMutation.mockImplementationOnce(
      async (operation: (signal: AbortSignal) => Promise<unknown>) => {
        const deadline = setTimeout(() => workflowController.abort(), 15_000);
        try {
          return await operation(workflowController.signal);
        } finally {
          clearTimeout(deadline);
        }
      },
    );
    clientMocks.apiFetch
      .mockImplementationOnce(async (_path: string, options?: RequestInit) => {
        const itemSignal = options?.signal;
        if (!itemSignal) throw new Error("signal do routing item ausente");
        generateStarted.resolve(itemSignal);
        await new Promise<void>((resolve) => {
          workflowController.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        throw new DOMException("workflow abortado", "AbortError");
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          targetUrl: "https://comunica.example/sso",
          handoffToken: "next-lock-token",
        },
        credentialPresented: true,
      });

    try {
      const routed = scope.enqueue(
        { type: "sso_ready", institutionId: "11" },
        {
          isSessionAuthorizationCurrent: () => true,
          getActiveTenantSnapshot: () => activeTenant,
          loadAllowedInstitutionIds: async () => [11],
          setActiveInstitutionId: async (institutionId) => {
            activeTenant = {
              institutionId,
              revision: activeTenant.revision + 1,
            };
          },
          invalidateQueries: async () => undefined,
          navigateToConfirmation: vi.fn(),
          navigateToAgenda,
          openComunica: async (institutionId, canNavigate, signal) => {
            const result = await runWebSsoHandoff(
              institutionId,
              { signal, isCurrent: canNavigate },
              submit,
            );
            return "cancelled" in result ? result : { ok: result.ok };
          },
        },
      );
      const itemSignal = await generateStarted.promise;

      expect(15_000).toBeLessThan(NOTIFICATION_ROUTING_ITEM_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(routed).resolves.toBe(false);
      expect(itemSignal.aborted).toBe(false);
      expect(navigateToAgenda).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();

      const nextRequest = new AbortController();
      await expect(
        runWebSsoHandoff(
          11,
          { signal: nextRequest.signal, isCurrent: () => true },
          submit,
        ),
      ).resolves.toEqual({ ok: true });
      expect(submit).toHaveBeenCalledTimes(1);
    } finally {
      scope.invalidate();
      vi.useRealTimers();
    }
  });

  it("timeout esperando o Web Lock cancela sem iniciar callback nem cair na Agenda", async () => {
    vi.useFakeTimers();
    clientMocks.platform.OS = "web";
    const coordinator = createNotificationRoutingCoordinator();
    const scope = coordinator.beginScope();
    const submit = vi.fn(() => true);
    const navigateToAgenda = vi.fn();
    let itemSignal: AbortSignal | undefined;
    const lockTimeout = new clientMocks.WebSessionMutationCancelledError();
    clientMocks.runExclusiveWebSessionMutation.mockImplementationOnce(
      async () =>
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(lockTimeout), 15_000);
        }),
    );
    clientMocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        targetUrl: "https://comunica.example/sso",
        handoffToken: "after-lock-timeout",
      },
      credentialPresented: true,
    });

    try {
      const routed = scope.enqueue(
        { type: "sso_ready", institutionId: "11" },
        {
          isSessionAuthorizationCurrent: () => true,
          getActiveTenantSnapshot: () => ({ institutionId: 11, revision: 1 }),
          loadAllowedInstitutionIds: async () => [11],
          setActiveInstitutionId: async () => undefined,
          invalidateQueries: async () => undefined,
          navigateToConfirmation: vi.fn(),
          navigateToAgenda,
          openComunica: async (institutionId, canNavigate, signal) => {
            itemSignal = signal;
            const result = await runWebSsoHandoff(
              institutionId,
              { signal, isCurrent: canNavigate },
              submit,
            );
            return "cancelled" in result ? result : { ok: result.ok };
          },
        },
      );
      await vi.advanceTimersByTimeAsync(15_000);

      await expect(routed).resolves.toBe(false);
      expect(itemSignal?.aborted).toBe(false);
      expect(clientMocks.apiFetch).not.toHaveBeenCalled();
      expect(navigateToAgenda).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();

      const nextRequest = new AbortController();
      await expect(
        runWebSsoHandoff(
          11,
          { signal: nextRequest.signal, isCurrent: () => true },
          submit,
        ),
      ).resolves.toEqual({ ok: true });
      expect(clientMocks.apiFetch).toHaveBeenCalledTimes(1);
      expect(submit).toHaveBeenCalledTimes(1);
    } finally {
      scope.invalidate();
      vi.useRealTimers();
    }
  });

  it("não trata um objeto impostor com o mesmo code como cancelamento do Web Lock", async () => {
    clientMocks.platform.OS = "web";
    clientMocks.runExclusiveWebSessionMutation.mockRejectedValueOnce({
      code: "WEB_SESSION_MUTATION_CANCELLED",
    });

    const request = new AbortController();
    await expect(
      runWebSsoHandoff(11, {
        signal: request.signal,
        isCurrent: () => true,
      }),
    ).resolves.toEqual({
      ok: false,
      error: "Não foi possível conectar ao Comunica+. Tente novamente.",
      errorCode: null,
    });
    expect(clientMocks.apiFetch).not.toHaveBeenCalled();
  });

  it("invalidate aborta generate imediatamente, não cai na Agenda e libera o próximo Web Lock", async () => {
    clientMocks.platform.OS = "web";
    const coordinator = createNotificationRoutingCoordinator();
    const scope = coordinator.beginScope();
    const generateStarted = deferred<AbortSignal>();
    const submit = vi.fn(() => true);
    const navigateToAgenda = vi.fn();
    let activeTenant = { institutionId: 11, revision: 1 };

    clientMocks.apiFetch
      .mockImplementationOnce(async (_path: string, options?: RequestInit) => {
        const signal = options?.signal;
        if (!signal) throw new Error("signal do routing item ausente");
        generateStarted.resolve(signal);
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return {
          ok: false,
          status: 0,
          data: null,
          credentialPresented: true,
        };
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          targetUrl: "https://comunica.example/sso",
          handoffToken: "post-invalidate-token",
        },
        credentialPresented: true,
      });

    const routed = scope.enqueue(
      { type: "sso_ready", institutionId: "11" },
      {
        isSessionAuthorizationCurrent: () => true,
        getActiveTenantSnapshot: () => activeTenant,
        loadAllowedInstitutionIds: async () => [11],
        setActiveInstitutionId: async (institutionId) => {
          activeTenant = {
            institutionId,
            revision: activeTenant.revision + 1,
          };
        },
        invalidateQueries: async () => undefined,
        navigateToConfirmation: vi.fn(),
        navigateToAgenda,
        openComunica: async (institutionId, canNavigate, signal) => {
          const result = await runWebSsoHandoff(
            institutionId,
            { signal, isCurrent: canNavigate },
            submit,
          );
          return "cancelled" in result ? result : { ok: result.ok };
        },
      },
    );
    const signal = await generateStarted.promise;
    scope.invalidate();

    expect(signal.aborted).toBe(true);
    await expect(routed).resolves.toBe(false);
    expect(navigateToAgenda).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();

    const nextRequest = new AbortController();
    await expect(
      runWebSsoHandoff(
        11,
        { signal: nextRequest.signal, isCurrent: () => true },
        submit,
      ),
    ).resolves.toEqual({ ok: true });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("cleanup real do Listener invalida a fila no unmount/logout e impede rota tardia", async () => {
    vi.resetModules();
    const effects: (() => void | (() => void))[] = [];
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
      useRef: (initial: unknown) => ({ current: initial }),
    }));
    vi.doMock("expo-router", () => ({
      useRouter: () => ({ push: routerPush }),
    }));
    vi.doMock("expo-notifications", () => ({
      DEFAULT_ACTION_IDENTIFIER: "expo.modules.notifications.actions.DEFAULT",
      addNotificationResponseReceivedListener: vi.fn(
        (listener: (response: any) => void) => {
          responseListener = listener;
          return { remove: removeSubscription };
        },
      ),
      addNotificationReceivedListener: vi.fn(() => ({ remove: vi.fn() })),
      getLastNotificationResponse: vi.fn(() => null),
      clearLastNotificationResponse: vi.fn(),
    }));
    vi.doMock("@/hooks/use-auth", () => ({
      useAuth: () => ({
        user: { id: 7 },
        isAuthenticated: true,
        isSessionAuthorizationCurrent: () => true,
        pushRegistrationRevision: 0,
      }),
    }));
    vi.doMock("@/hooks/use-notifications", () => ({
      useNotifications: vi.fn(),
    }));
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
        useUtils: () => ({
          invalidate: invalidateQueries,
          swaps: {
            countActionable: { invalidate: vi.fn(async () => undefined) },
            listAvailable: { invalidate: vi.fn(async () => undefined) },
            list: { invalidate: vi.fn(async () => undefined) },
          },
        }),
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

    const { NotificationListener: RealNotificationListener } =
      await import("../components/NotificationListener");
    RealNotificationListener();
    expect(effects).toHaveLength(2);
    const cleanups = effects
      .map((effect) => effect())
      .filter(
        (cleanup): cleanup is () => void => typeof cleanup === "function",
      );
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

    expect(cleanups).toHaveLength(2);
    for (const cleanup of [...cleanups].reverse()) cleanup();
    releaseRefetch.resolve({ isError: false, data: [{ id: 11 }, { id: 22 }] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(removeSubscription).toHaveBeenCalledTimes(1);
    expect(setActiveInstitutionId).not.toHaveBeenCalled();
    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("Listener real mantém usuário cached inerte sem /me VERIFIED corrente", async () => {
    const last = notificationResponse("blocked-receipt", {
      type: "duty_confirmation",
      institutionId: 11,
      confirmationToken: "blocked-token",
    });
    const harness = await renderRealNotificationListener({
      sessionVerified: false,
      lastResponse: last,
    });

    expect(harness.render()).toBeNull();
    const cleanup = harness.runLatestEffect();
    expect(typeof cleanup).toBe("function");
    harness.emit(last);
    await Promise.resolve();

    expect(harness.refetch).not.toHaveBeenCalled();
    expect(harness.setActiveInstitutionId).not.toHaveBeenCalled();
    expect(harness.invalidateQueries).not.toHaveBeenCalled();
    expect(harness.routerPush).not.toHaveBeenCalled();
    expect(harness.clearLastNotificationResponse).not.toHaveBeenCalled();
    (cleanup as () => void)();
  });

  it("push swap_offer recebido invalida countActionable e listAvailable sem navegar", async () => {
    const harness = await renderRealNotificationListener({
      user: { id: 7 },
      sessionVerified: true,
      sessionAuthorizationCurrent: true,
      activeTenant: { institutionId: 22, revision: 1 },
    });

    expect(harness.render()).not.toBeNull();
    const cleanup = harness.runLatestEffect();
    harness.emitReceived({
      type: "swap_offer",
      institutionId: 22,
      swapRequestId: 91,
    });
    await Promise.resolve();

    expect(harness.invalidateCountActionable).toHaveBeenCalledTimes(1);
    expect(harness.invalidateListAvailable).toHaveBeenCalledTimes(1);
    expect(harness.invalidateSwapList).toHaveBeenCalledTimes(1);
    expect(harness.invalidateQueries).not.toHaveBeenCalled();
    expect(harness.routerPush).not.toHaveBeenCalled();
    expect(harness.setActiveInstitutionId).not.toHaveBeenCalled();

    harness.emitReceived({ type: "duty_confirmation", institutionId: 22 });
    await Promise.resolve();
    expect(harness.invalidateCountActionable).toHaveBeenCalledTimes(1);
    (cleanup as () => void)();
  });

  it("Listener LIVE consulta a proof VERIFIED atual sem depender de rerender ou remount", async () => {
    const harness = await renderRealNotificationListener({
      user: { id: 7 },
      sessionVerified: true,
      sessionAuthorizationCurrent: true,
      activeTenant: { institutionId: 22, revision: 1 },
      allowedInstitutionIds: [11, 22],
    });

    expect(harness.render()).not.toBeNull();
    expect(harness.effects).toHaveLength(2);
    const cleanup = harness.runLatestEffect();
    expect(harness.removeSubscription).not.toHaveBeenCalled();

    // BEGIN invalida sincronamente o receipt VERIFIED A, mas o React ainda não
    // rerenderizou: `isAuthenticated` capturado no render continua true e o
    // listener device-global permanece exatamente o mesmo.
    harness.setSessionAuthorizationCurrent(false);
    const staleResponse = notificationResponse("live-after-begin-a", {
      type: "sso_ready",
      institutionId: 11,
    });
    const proofChecksBeforeLive =
      harness.sessionValidationIsCurrent.mock.calls.length;
    harness.emit(staleResponse);
    // O check precisa ocorrer sincronicamente no consumer; o coordinator só
    // roda em microtask e não pode compensar um boolean stale capturado.
    expect(harness.sessionValidationIsCurrent).toHaveBeenCalledTimes(
      proofChecksBeforeLive + 1,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(harness.refetch).not.toHaveBeenCalled();
    expect(harness.setActiveInstitutionId).not.toHaveBeenCalled();
    expect(harness.invalidateQueries).not.toHaveBeenCalled();
    expect(harness.openComunicaFromNotification).not.toHaveBeenCalled();
    expect(harness.routerPush).not.toHaveBeenCalled();
    expect(harness.activeTenant()).toEqual({ institutionId: 22, revision: 1 });
    expect(harness.removeSubscription).not.toHaveBeenCalled();

    // O tap observado durante BEGIN é terminal: restaurar a proof não pode
    // conferir autoridade retroativa ao mesmo receipt. Esse replay falharia se
    // o consumer usasse só `isAuthenticated` capturado e deixasse o coordinator
    // liberar o claim como retryable.
    harness.setSessionAuthorizationCurrent(true);
    harness.emit(staleResponse);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.refetch).not.toHaveBeenCalled();
    expect(harness.setActiveInstitutionId).not.toHaveBeenCalled();
    expect(harness.invalidateQueries).not.toHaveBeenCalled();
    expect(harness.openComunicaFromNotification).not.toHaveBeenCalled();

    // Um receipt novamente VERIFIED autoriza somente um novo evento LIVE no
    // mesmo listener, sem reinstalar a subscription nem executar cleanup.
    harness.emit(
      notificationResponse("live-after-verified-a", {
        type: "sso_ready",
        institutionId: 11,
      }),
    );
    await vi.waitFor(() =>
      expect(harness.openComunicaFromNotification).toHaveBeenCalledTimes(1),
    );

    expect(harness.refetch).toHaveBeenCalledTimes(1);
    expect(harness.setActiveInstitutionId).toHaveBeenCalledTimes(1);
    expect(harness.invalidateQueries).toHaveBeenCalledTimes(1);
    expect(harness.routerPush).not.toHaveBeenCalled();
    expect(harness.activeTenant().institutionId).toBe(11);
    expect(harness.removeSubscription).not.toHaveBeenCalled();

    (cleanup as (() => void) | undefined)?.();
    expect(harness.removeSubscription).toHaveBeenCalledTimes(1);
  });

  it("Listener real usa o handoff web cercado e mantém o launch-code apenas no mobile", async () => {
    const notificationWebHandoff = vi.fn(async () => ({ ok: true }));
    const harness = await renderRealNotificationListener({
      platform: "web",
      sessionVerified: true,
      activeTenant: { institutionId: 22, revision: 1 },
      allowedInstitutionIds: [11, 22],
      runWebSsoHandoff: notificationWebHandoff,
    });

    expect(harness.render()).not.toBeNull();
    const cleanup = harness.runLatestEffect();
    harness.emit(
      notificationResponse("web-sso-ready", {
        type: "sso_ready",
        institutionId: "11",
      }),
    );

    await vi.waitFor(() =>
      expect(harness.notificationWebHandoff).toHaveBeenCalledTimes(1),
    );
    expect(harness.notificationWebHandoff).toHaveBeenCalledWith(
      11,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        isCurrent: expect.any(Function),
      }),
    );
    expect(harness.openComunicaFromNotification).not.toHaveBeenCalled();
    expect(harness.routerPush).not.toHaveBeenCalled();

    cleanup?.();
    vi.doUnmock("@/hooks/use-sso-handoff");
  });

  it("Listener real preserva cancelled do handoff web e não faz fallback tardio para Agenda", async () => {
    const harness = await renderRealNotificationListener({
      platform: "web",
      sessionVerified: true,
      activeTenant: { institutionId: 11, revision: 1 },
      allowedInstitutionIds: [11],
      runWebSsoHandoff: async () => ({ ok: false, cancelled: true }),
    });

    expect(harness.render()).not.toBeNull();
    const cleanup = harness.runLatestEffect();
    harness.emit(
      notificationResponse("web-sso-cancelled", {
        type: "sso_ready",
        institutionId: "11",
      }),
    );

    await vi.waitFor(() =>
      expect(harness.notificationWebHandoff).toHaveBeenCalledTimes(1),
    );
    expect(harness.routerPush).not.toHaveBeenCalled();
    expect(harness.openComunicaFromNotification).not.toHaveBeenCalled();

    cleanup?.();
    vi.doUnmock("@/hooks/use-sso-handoff");
  });

  it("Listener real consome cold-start A sob tenant B, limpa antes do await e navega uma vez", async () => {
    const last = notificationResponse("cold-a", {
      type: "duty_confirmation",
      institutionId: 11,
      confirmationToken: "cold-token-a",
    });
    const refetchStarted = deferred();
    const releaseRefetch = deferred<{
      isError: boolean;
      data: { id: number }[];
    }>();
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
    harness.emit(
      notificationResponse("cold-sync-error-a", {
        type: "duty_confirmation",
        institutionId: 11,
        confirmationToken: "must-not-open",
      }),
    );
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
    const releaseRefetch = deferred<{
      isError: boolean;
      data: { id: number }[];
    }>();
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
    const harness = await renderRealNotificationListener({
      allowedInstitutionIds: [11],
    });
    harness.render();
    const cleanup = harness.runLatestEffect();
    harness.emit(
      notificationResponse(
        "custom",
        {
          type: "duty_confirmation",
          institutionId: 11,
          confirmationToken: "custom-token",
        },
        "CUSTOM_ACTION",
      ),
    );
    harness.emit(
      notificationResponse("foreign", {
        type: "duty_confirmation",
        institutionId: 99,
        confirmationToken: "foreign-token",
      }),
    );
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
        data: ++attempt === 1 ? [{ id: 22 }] : [{ id: 11 }, { id: 22 }],
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
    const releaseRefetch = deferred<{
      isError: boolean;
      data: { id: number }[];
    }>();
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
    await vi.waitFor(() =>
      expect(stale.getPermissionsAsync).toHaveBeenCalledTimes(1),
    );
    expect(stale.getExpoPushTokenAsync).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(staleMutate).toHaveBeenCalledWith({
        token: "Expo-stale-a",
        platform: "ios",
        expectedUserId: 7,
      }),
    );
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
    await vi.waitFor(() =>
      expect(current.setLastPushToken).toHaveBeenCalledWith("Expo-current-b"),
    );
    current.emitRollover("rollover-b");
    await vi.waitFor(() =>
      expect(currentMutate).toHaveBeenCalledWith({
        token: "Expo-rollover-b",
        previousToken: "Expo-current-b",
        platform: "ios",
        expectedUserId: 8,
      }),
    );
    await vi.waitFor(() =>
      expect(current.setLastPushToken).toHaveBeenLastCalledWith(
        "Expo-rollover-b",
      ),
    );
    current.emitRollover("rollover-c");
    await vi.waitFor(() =>
      expect(currentMutate).toHaveBeenCalledWith({
        token: "Expo-rollover-c",
        previousToken: "Expo-rollover-b",
        platform: "ios",
        expectedUserId: 8,
      }),
    );
    await vi.waitFor(() =>
      expect(current.setLastPushToken).toHaveBeenLastCalledWith(
        "Expo-rollover-c",
      ),
    );
    (currentCleanup as (() => void) | undefined)?.();
    current.emitRollover("after-logout-b");
    await Promise.resolve();
    expect(currentMutate).toHaveBeenCalledTimes(3);
    expect(current.removeReceived).toHaveBeenCalledTimes(1);
    expect(current.removePushToken).toHaveBeenCalledTimes(1);
  });

  it("só publica depois de persistir o envelope confirmado pelo servidor", async () => {
    const order: string[] = [];
    const harness = await renderRealUseNotifications({
      userId: 16,
      initialToken: "Expo-vault-order",
      mutateAsync: async () => {
        order.push("post");
        return { success: true };
      },
      persistServerRegisteredPushToken: async () => {
        order.push("vault");
      },
    });
    const cleanup = harness.runEffect();
    await vi.waitFor(() =>
      expect(harness.setLastPushToken).toHaveBeenCalledWith("Expo-vault-order"),
    );
    order.push("published");

    expect(order).toEqual(["post", "vault", "published"]);
    expect(harness.persistServerRegisteredPushToken).toHaveBeenCalledWith({
      userId: 16,
      token: "Expo-vault-order",
      platform: "ios",
    });
    (cleanup as (() => void) | undefined)?.();
  });

  it.each(["set-no-op", "write-throw"] as const)(
    "falha durável do cofre após POST (%s) não publica nem repete efeito remoto",
    async (failureKind) => {
      let quarantined = false;
      const persist = vi.fn(async () => {
        quarantined = true;
        throw new Error(`vault-${failureKind}`);
      });
      const mutateAsync = vi.fn(async () => ({ success: true }));
      const harness = await renderRealUseNotifications({
        userId: 17,
        initialToken: `Expo-vault-${failureKind}`,
        mutateAsync,
        persistServerRegisteredPushToken: persist,
        hydrateServerRegisteredPushToken: async () => {
          if (quarantined) throw new Error("PUSH_TOKEN_VAULT_QUARANTINED");
          return null;
        },
      });
      const cleanup = harness.runEffect();
      await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
      (cleanup as (() => void) | undefined)?.();
      await new Promise((resolve) => setTimeout(resolve, 550));

      expect(mutateAsync).toHaveBeenCalledTimes(1);
      expect(harness.setExpoPushToken).not.toHaveBeenCalled();
      expect(harness.setLastPushToken).not.toHaveBeenCalled();
    },
  );

  it("falha transitória do cofre repete POST idempotente e publica só após readback", async () => {
    let persistAttempt = 0;
    const persist = vi.fn(async () => {
      persistAttempt += 1;
      if (persistAttempt === 1) throw new Error("bridge transitório");
    });
    const mutateAsync = vi.fn(async () => ({ success: true }));
    const harness = await renderRealUseNotifications({
      userId: 21,
      initialToken: "Expo-vault-transient",
      mutateAsync,
      persistServerRegisteredPushToken: persist,
    });
    const cleanup = harness.runEffect();
    await vi.waitFor(
      () =>
        expect(harness.setLastPushToken).toHaveBeenCalledWith(
          "Expo-vault-transient",
        ),
      { timeout: 2_000 },
    );

    expect(mutateAsync).toHaveBeenCalledTimes(2);
    expect(persist).toHaveBeenCalledTimes(2);
    expect(harness.setExpoPushToken).toHaveBeenCalledTimes(1);
    expect(harness.setLastPushToken).toHaveBeenCalledTimes(1);
    (cleanup as (() => void) | undefined)?.();
  });

  it("cofre corrompido bloqueia antes do POST e nunca publica", async () => {
    const mutateAsync = vi.fn(async () => ({ success: true }));
    const harness = await renderRealUseNotifications({
      userId: 18,
      initialToken: "Expo-corrupt-blocked",
      mutateAsync,
      hydrateServerRegisteredPushToken: async () => {
        throw new Error("PUSH_TOKEN_VAULT_INVALID");
      },
    });
    const cleanup = harness.runEffect();
    await vi.waitFor(() =>
      expect(harness.getExpoPushTokenAsync).toHaveBeenCalledTimes(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mutateAsync).not.toHaveBeenCalled();
    expect(harness.setExpoPushToken).not.toHaveBeenCalled();
    expect(harness.setLastPushToken).not.toHaveBeenCalled();
    (cleanup as (() => void) | undefined)?.();
  });

  it("troca de usuário nunca envia o predecessor bruto da conta A", async () => {
    const tokenA = "Expo-user-a-secret";
    const mutateAsync = vi.fn(async () => ({ success: true }));
    const harness = await renderRealUseNotifications({
      userId: 20,
      initialToken: "Expo-user-b",
      initialServerRegisteredPushToken: { userId: 19, token: tokenA },
      mutateAsync,
      hydrateServerRegisteredPushToken: async () => {
        throw new Error("PUSH_TOKEN_VAULT_INVALID");
      },
    });
    const cleanup = harness.runEffect();
    await vi.waitFor(() =>
      expect(harness.getExpoPushTokenAsync).toHaveBeenCalledTimes(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mutateAsync).not.toHaveBeenCalledWith(
      expect.objectContaining({
        previousToken: tokenA,
      }),
    );
    expect(harness.setLastPushToken).not.toHaveBeenCalled();
    (cleanup as (() => void) | undefined)?.();
  });

  it("rollover T3→T2 reserva ordem no evento e impede T2 tardio de vencer", async () => {
    const t2 = deferred<{ data: string }>();
    const t3 = deferred<{ data: string }>();
    const mutateAsync = vi.fn(async () => ({ success: true }));
    const harness = await renderRealUseNotifications({
      userId: 9,
      initialToken: "Expo-initial-t1",
      mutateAsync,
      getExpoPushTokenAsync: async (input) => {
        const deviceToken = input?.devicePushToken?.data;
        if (deviceToken === "device-t2") return t2.promise;
        if (deviceToken === "device-t3") return t3.promise;
        return { data: "Expo-initial-t1" };
      },
    });
    const cleanup = harness.runEffect();
    await vi.waitFor(() =>
      expect(harness.setLastPushToken).toHaveBeenCalledWith("Expo-initial-t1"),
    );
    mutateAsync.mockClear();
    harness.setExpoPushToken.mockClear();
    harness.setLastPushToken.mockClear();

    harness.emitRollover("device-t2");
    harness.emitRollover("device-t3");
    t3.resolve({ data: "Expo-rollover-t3" });
    await vi.waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        token: "Expo-rollover-t3",
        previousToken: "Expo-initial-t1",
        platform: "ios",
        expectedUserId: 9,
      }),
    );
    await vi.waitFor(() =>
      expect(harness.setLastPushToken).toHaveBeenCalledWith("Expo-rollover-t3"),
    );

    t2.resolve({ data: "Expo-rollover-t2" });
    await Promise.resolve();
    await Promise.resolve();

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).not.toHaveBeenCalledWith(
      expect.objectContaining({
        token: "Expo-rollover-t2",
      }),
    );
    expect(harness.setLastPushToken).toHaveBeenCalledTimes(1);
    expect(harness.setLastPushToken).toHaveBeenLastCalledWith(
      "Expo-rollover-t3",
    );
    (cleanup as (() => void) | undefined)?.();
  });

  it("rollover atual remove o token cujo POST antigo confirmou durante a troca", async () => {
    const t2Post = deferred<{ success: boolean }>();
    const mutateAsync = vi.fn(async (input: Record<string, unknown>) => {
      if (input.token === "Expo-overlap-t2") return t2Post.promise;
      return { success: true };
    });
    const harness = await renderRealUseNotifications({
      userId: 11,
      initialToken: "Expo-overlap-t1",
      mutateAsync,
    });
    const cleanup = harness.runEffect();
    await vi.waitFor(() =>
      expect(harness.setLastPushToken).toHaveBeenCalledWith("Expo-overlap-t1"),
    );
    mutateAsync.mockClear();
    harness.setExpoPushToken.mockClear();
    harness.setLastPushToken.mockClear();

    harness.emitRollover("overlap-t2");
    await vi.waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        token: "Expo-overlap-t2",
        previousToken: "Expo-overlap-t1",
        platform: "ios",
        expectedUserId: 11,
      }),
    );
    harness.emitRollover("overlap-t3");

    t2Post.resolve({ success: true });
    await vi.waitFor(
      () =>
        expect(mutateAsync).toHaveBeenCalledWith({
          token: "Expo-overlap-t3",
          previousToken: "Expo-overlap-t2",
          platform: "ios",
          expectedUserId: 11,
        }),
      { timeout: 5_000 },
    );

    expect(mutateAsync).toHaveBeenCalledTimes(2);
    expect(harness.setExpoPushToken).toHaveBeenCalledTimes(1);
    expect(harness.setExpoPushToken).toHaveBeenLastCalledWith(
      "Expo-overlap-t3",
    );
    expect(harness.setLastPushToken).toHaveBeenCalledTimes(1);
    expect(harness.setLastPushToken).toHaveBeenLastCalledWith(
      "Expo-overlap-t3",
    );
    (cleanup as (() => void) | undefined)?.();
  }, 10_000);

  it("replacement stale invalida proof T1 e força POST quando o token atual volta a T1", async () => {
    const tokenT1 = "Expo-proof-return-t1";
    const tokenT2 = "Expo-proof-return-t2";
    const t2Post = deferred<void>();
    const serverRows = new Set([tokenT1]);
    const mutateAsync = vi.fn(async (input: Record<string, unknown>) => {
      if (input.token === tokenT2) await t2Post.promise;
      const previousToken = input.previousToken;
      if (typeof previousToken === "string") serverRows.delete(previousToken);
      serverRows.add(String(input.token));
      return { success: true };
    });
    const harness = await renderRealUseNotifications({
      userId: 12,
      initialToken: tokenT1,
      seedFreshProofToken: tokenT1,
      mutateAsync,
      getExpoPushTokenAsync: async (input) => ({
        data: input?.devicePushToken?.data === "device-t2" ? tokenT2 : tokenT1,
      }),
    });
    const cleanup = harness.runEffect();
    await vi.waitFor(() =>
      expect(harness.setLastPushToken).toHaveBeenCalledWith(tokenT1),
    );
    mutateAsync.mockClear();
    harness.setLastPushToken.mockClear();

    harness.emitRollover("device-t2");
    await vi.waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        token: tokenT2,
        previousToken: tokenT1,
        platform: "ios",
        expectedUserId: 12,
      }),
    );
    harness.emitRollover("device-t1-return");
    t2Post.resolve();

    await vi.waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        token: tokenT1,
        previousToken: tokenT2,
        platform: "ios",
        expectedUserId: 12,
      }),
    );
    expect(serverRows).toEqual(new Set([tokenT1]));
    expect(harness.setLastPushToken).toHaveBeenCalledTimes(1);
    expect(harness.setLastPushToken).toHaveBeenCalledWith(tokenT1);
    (cleanup as (() => void) | undefined)?.();
  });

  it("legacy proof fresca sem envelope força POST e migra o cofre", async () => {
    const token = "Expo-legacy-proof-no-vault";
    const mutateAsync = vi.fn(async () => ({ success: true }));
    const harness = await renderRealUseNotifications({
      userId: 22,
      initialToken: token,
      seedFreshProofToken: token,
      legacyProofWithoutVault: true,
      mutateAsync,
    });
    const cleanup = harness.runEffect();
    await vi.waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        token,
        platform: "ios",
        expectedUserId: 22,
      }),
    );
    await vi.waitFor(() =>
      expect(harness.setLastPushToken).toHaveBeenCalledWith(token),
    );

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(harness.persistServerRegisteredPushToken).toHaveBeenCalledWith({
      userId: 22,
      token,
      platform: "ios",
    });
    (cleanup as (() => void) | undefined)?.();
  });

  it("proof T2 fresca com envelope T1 força replacement T2+previous T1", async () => {
    const tokenT1 = "Expo-proof-vault-different-t1";
    const tokenT2 = "Expo-proof-vault-different-t2";
    const serverRows = new Set([tokenT1, tokenT2]);
    const mutateAsync = vi.fn(async (input: Record<string, unknown>) => {
      if (typeof input.previousToken === "string") {
        serverRows.delete(input.previousToken);
      }
      serverRows.add(String(input.token));
      return { success: true };
    });
    const harness = await renderRealUseNotifications({
      userId: 23,
      initialToken: tokenT2,
      seedFreshProofToken: tokenT2,
      initialServerRegisteredPushToken: { userId: 23, token: tokenT1 },
      mutateAsync,
    });
    const cleanup = harness.runEffect();
    await vi.waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        token: tokenT2,
        previousToken: tokenT1,
        platform: "ios",
        expectedUserId: 23,
      }),
    );
    await vi.waitFor(() =>
      expect(harness.setLastPushToken).toHaveBeenCalledWith(tokenT2),
    );

    expect(serverRows).toEqual(new Set([tokenT2]));
    expect(harness.persistServerRegisteredPushToken).toHaveBeenCalledWith({
      userId: 23,
      token: tokenT2,
      platform: "ios",
    });
    (cleanup as (() => void) | undefined)?.();
  });

  it("replacement não toca servidor se a proof T1 não puder ser invalidada antes", async () => {
    const tokenT1 = "Expo-proof-block-t1";
    const tokenT2 = "Expo-proof-block-t2";
    const mutateAsync = vi.fn(async () => ({ success: true }));
    const harness = await renderRealUseNotifications({
      userId: 15,
      initialToken: tokenT1,
      seedFreshProofToken: tokenT1,
      failProofInvalidation: true,
      mutateAsync,
      getExpoPushTokenAsync: async (input) => ({
        data: input?.devicePushToken ? tokenT2 : tokenT1,
      }),
    });
    const cleanup = harness.runEffect();
    await vi.waitFor(() =>
      expect(harness.setLastPushToken).toHaveBeenCalledWith(tokenT1),
    );
    mutateAsync.mockClear();

    harness.emitRollover("device-t2");
    await vi.waitFor(() =>
      expect(harness.getExpoPushTokenAsync).toHaveBeenCalledTimes(2),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mutateAsync).not.toHaveBeenCalled();
    expect(harness.setLastPushToken).not.toHaveBeenCalledWith(tokenT2);
    expect(harness.getServerRegisteredPushToken(15)).toBe(tokenT1);
    (cleanup as (() => void) | undefined)?.();
  });

  it("remount durante POST T1 transfere predecessor e replacement deixa só T2", async () => {
    const tokenT1 = "Expo-remount-t1";
    const tokenT2 = "Expo-remount-t2";
    const firstPost = deferred<void>();
    const serverRows = new Set<string>();
    let setupAcquisition = 0;
    const mutateAsync = vi.fn(async (input: Record<string, unknown>) => {
      if (input.token === tokenT1) await firstPost.promise;
      const previousToken = input.previousToken;
      if (typeof previousToken === "string") serverRows.delete(previousToken);
      serverRows.add(String(input.token));
      return { success: true };
    });
    const harness = await renderRealUseNotifications({
      userId: 13,
      initialToken: tokenT1,
      mutateAsync,
      getExpoPushTokenAsync: async () => ({
        data: ++setupAcquisition === 1 ? tokenT1 : tokenT2,
      }),
    });
    const firstCleanup = harness.runEffect();
    await vi.waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        token: tokenT1,
        platform: "ios",
        expectedUserId: 13,
      }),
    );

    (firstCleanup as (() => void) | undefined)?.();
    const secondCleanup = harness.remount();
    await vi.waitFor(() =>
      expect(harness.getExpoPushTokenAsync).toHaveBeenCalledTimes(2),
    );
    expect(mutateAsync).toHaveBeenCalledTimes(1);

    firstPost.resolve();
    await vi.waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        token: tokenT2,
        previousToken: tokenT1,
        platform: "ios",
        expectedUserId: 13,
      }),
    );
    await vi.waitFor(() =>
      expect(harness.setLastPushToken).toHaveBeenCalledWith(tokenT2),
    );

    expect(serverRows).toEqual(new Set([tokenT2]));
    expect(harness.setLastPushToken).not.toHaveBeenCalledWith(tokenT1);
    (secondCleanup as (() => void) | undefined)?.();
  });

  it("cold hydrate T1 lento atravessa remount e T2 substitui a única row", async () => {
    const tokenT1 = "Expo-cold-remount-t1";
    const tokenT2 = "Expo-cold-remount-t2";
    const releaseProofRead = deferred<void>();
    const serverRows = new Set([tokenT1]);
    let setupAcquisition = 0;
    const mutateAsync = vi.fn(async (input: Record<string, unknown>) => {
      const previousToken = input.previousToken;
      if (typeof previousToken === "string") serverRows.delete(previousToken);
      serverRows.add(String(input.token));
      return { success: true };
    });
    const harness = await renderRealUseNotifications({
      userId: 14,
      initialToken: tokenT1,
      seedFreshProofToken: tokenT1,
      proofReadGate: releaseProofRead.promise,
      mutateAsync,
      getExpoPushTokenAsync: async () => ({
        data: ++setupAcquisition === 1 ? tokenT1 : tokenT2,
      }),
    });
    const firstCleanup = harness.runEffect();
    await vi.waitFor(() =>
      expect(harness.getExpoPushTokenAsync).toHaveBeenCalledTimes(1),
    );
    await Promise.resolve();
    expect(mutateAsync).not.toHaveBeenCalled();

    (firstCleanup as (() => void) | undefined)?.();
    const secondCleanup = harness.remount();
    await vi.waitFor(() =>
      expect(harness.getExpoPushTokenAsync).toHaveBeenCalledTimes(2),
    );
    expect(mutateAsync).not.toHaveBeenCalled();

    releaseProofRead.resolve();
    await vi.waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        token: tokenT2,
        previousToken: tokenT1,
        platform: "ios",
        expectedUserId: 14,
      }),
    );
    await vi.waitFor(() =>
      expect(harness.setLastPushToken).toHaveBeenCalledWith(tokenT2),
    );

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(serverRows).toEqual(new Set([tokenT2]));
    expect(harness.setLastPushToken).not.toHaveBeenCalledWith(tokenT1);
    (secondCleanup as (() => void) | undefined)?.();
  });

  it("cold process real T1→T2 preserva SecureStore e deixa somente T2", async () => {
    const tokenT1 = "Expo-process-vault-t1";
    const tokenT2 = "Expo-process-vault-t2";
    const physicalStorage = {
      asyncValues: new Map<string, string>(),
      secureValues: new Map<string, string>(),
    };
    const serverRows = new Set<string>();
    const firstPost = vi.fn(async (input: Record<string, unknown>) => {
      serverRows.add(String(input.token));
      return { success: true };
    });
    const first = await renderRealUseNotifications({
      userId: 24,
      initialToken: tokenT1,
      mutateAsync: firstPost,
      realPushTokenStorage: physicalStorage,
    });
    const firstCleanup = first.runEffect();
    await vi.waitFor(() =>
      expect(first.setExpoPushToken).toHaveBeenCalledWith(tokenT1),
    );
    expect(serverRows).toEqual(new Set([tokenT1]));
    expect(JSON.stringify([...physicalStorage.asyncValues])).not.toContain(
      tokenT1,
    );
    (firstCleanup as (() => void) | undefined)?.();

    // renderRealUseNotifications executa resetModules: só os maps físicos
    // sobrevivem, reproduzindo um novo processo do app.
    const secondPost = vi.fn(async (input: Record<string, unknown>) => {
      if (typeof input.previousToken === "string") {
        serverRows.delete(input.previousToken);
      }
      serverRows.add(String(input.token));
      return { success: true };
    });
    const second = await renderRealUseNotifications({
      userId: 24,
      initialToken: tokenT2,
      mutateAsync: secondPost,
      realPushTokenStorage: physicalStorage,
    });
    const secondCleanup = second.runEffect();
    await vi.waitFor(() =>
      expect(secondPost).toHaveBeenCalledWith({
        token: tokenT2,
        previousToken: tokenT1,
        platform: "ios",
        expectedUserId: 24,
      }),
    );
    await vi.waitFor(() =>
      expect(second.setExpoPushToken).toHaveBeenCalledWith(tokenT2),
    );

    expect(serverRows).toEqual(new Set([tokenT2]));
    expect(JSON.stringify([...physicalStorage.asyncValues])).not.toContain(
      tokenT1,
    );
    expect(JSON.stringify([...physicalStorage.asyncValues])).not.toContain(
      tokenT2,
    );
    expect(JSON.stringify([...physicalStorage.secureValues])).toContain(
      tokenT2,
    );
    (secondCleanup as (() => void) | undefined)?.();
  });

  it.each(["setup-first", "rollover-first"] as const)(
    "setup↔rollover (%s) mantém o rollover mais novo como único registro",
    async (completionOrder) => {
      const setup = deferred<{ data: string }>();
      const rollover = deferred<{ data: string }>();
      const mutateAsync = vi.fn(async () => ({ success: true }));
      const harness = await renderRealUseNotifications({
        userId: 10,
        initialToken: "unused",
        mutateAsync,
        getExpoPushTokenAsync: async (input) =>
          input?.devicePushToken ? rollover.promise : setup.promise,
      });
      const cleanup = harness.runEffect();
      await vi.waitFor(() =>
        expect(harness.getExpoPushTokenAsync).toHaveBeenCalledWith({
          projectId: "project-id",
        }),
      );

      harness.emitRollover("device-rollover");
      await vi.waitFor(() =>
        expect(harness.getExpoPushTokenAsync).toHaveBeenCalledWith({
          projectId: "project-id",
          devicePushToken: { type: "ios", data: "device-rollover" },
        }),
      );

      if (completionOrder === "setup-first") {
        setup.resolve({ data: "Expo-stale-setup" });
        await Promise.resolve();
        await Promise.resolve();
        expect(mutateAsync).not.toHaveBeenCalled();
        rollover.resolve({ data: "Expo-current-rollover" });
      } else {
        rollover.resolve({ data: "Expo-current-rollover" });
        await Promise.resolve();
        expect(mutateAsync).not.toHaveBeenCalled();
        setup.resolve({ data: "Expo-stale-setup" });
      }

      await vi.waitFor(() =>
        expect(mutateAsync).toHaveBeenCalledWith({
          token: "Expo-current-rollover",
          platform: "ios",
          expectedUserId: 10,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();

      expect(mutateAsync).toHaveBeenCalledTimes(1);
      expect(mutateAsync).not.toHaveBeenCalledWith(
        expect.objectContaining({
          token: "Expo-stale-setup",
        }),
      );
      expect(harness.setExpoPushToken).toHaveBeenCalledTimes(1);
      expect(harness.setExpoPushToken).toHaveBeenLastCalledWith(
        "Expo-current-rollover",
      );
      expect(harness.setLastPushToken).toHaveBeenCalledTimes(1);
      expect(harness.setLastPushToken).toHaveBeenLastCalledWith(
        "Expo-current-rollover",
      );
      (cleanup as (() => void) | undefined)?.();
    },
  );

  it("scope novo não aguarda refetch pendente da sessão invalidada", async () => {
    const coordinator = createNotificationRoutingCoordinator();
    const staleScope = coordinator.beginScope();
    const staleRefetchStarted = deferred();
    const releaseStaleRefetch = deferred<readonly number[]>();
    const calls: string[] = [];
    let activeTenant = { institutionId: 22, revision: 1 };

    const staleRoute = staleScope.enqueue(
      {
        type: "duty_confirmation",
        institutionId: 11,
        confirmationToken: "stale-token",
      },
      {
        isSessionAuthorizationCurrent: () => true,
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
      },
    );
    await staleRefetchStarted.promise;

    staleScope.invalidate();
    const currentScope = coordinator.beginScope();
    const currentRoute = currentScope.enqueue(
      {
        type: "duty_confirmation",
        institutionId: 33,
        confirmationToken: "current-token",
      },
      {
        isSessionAuthorizationCurrent: () => true,
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
      },
    );

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
    expect(() => generateSsoClientNonce({})).toThrow(
      "Gerador criptográfico indisponível",
    );
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
    (confirmButton?.props?.onPress as () => void)();
    expect(harness.confirmMutate).toHaveBeenCalledWith({
      confirmationToken: tokenB,
    });
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
    expect(errorState?.props?.title).toBe(
      "Não foi possível verificar suas confirmações",
    );
    expect(harness.text).not.toContain("Nenhuma confirmação pendente");
    expect(harness.elements).not.toContainEqual(
      expect.objectContaining({
        props: expect.objectContaining({ label: "Voltar à Agenda" }),
      }),
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
    vi.doMock("@/lib/_core/api", () => ({
      apiFetch: async (path: string, options?: RequestInit) => {
        const response = await fetch(`https://escala.example${path}`, options);
        return {
          ok: response.ok,
          status: response.status ?? (response.ok ? 200 : 500),
          data: await response.json(),
          credentialPresented: true,
        };
      },
    }));
    vi.doMock("@/lib/_core/auth", () => ({
      captureSessionTransportTicket: () => 7,
      isSessionTransportTicketCurrent: (ticket: number) => ticket === 7,
      runExclusiveWebSessionMutation: async <T>(operation: () => Promise<T>) =>
        operation(),
    }));
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
      createElement: vi.fn((tagName: string) =>
        tagName === "form"
          ? {
              method: "",
              action: "",
              style: {},
              appendChild: vi.fn(),
              remove: vi.fn(),
              submit: formSubmit,
            }
          : { type: "", name: "", value: "" },
      ),
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
    expect(JSON.stringify(setState.mock.calls)).not.toContain(
      "STALE_WEB_TOKEN",
    );
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
    vi.doMock("@/lib/_core/api", () => ({
      apiFetch: async (path: string, options?: RequestInit) => {
        const response = await fetch(`https://escala.example${path}`, options);
        return {
          ok: response.ok,
          status: response.status ?? (response.ok ? 200 : 500),
          data: await response.json(),
          credentialPresented: true,
        };
      },
    }));
    vi.doMock("@/lib/_core/auth", () => ({
      captureSessionTransportTicket: () => 7,
      isSessionTransportTicketCurrent: (ticket: number) => ticket === 7,
      runExclusiveWebSessionMutation: async <T>(operation: () => Promise<T>) =>
        operation(),
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
        launchUrl:
          "https://escala.example/api/sso/launch?code=STALE_NATIVE_CODE",
      })),
    });
    await staleLaunch;

    expect(openURL).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(openURL.mock.calls)).not.toContain(
      "STALE_NATIVE_CODE",
    );
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
    vi.doMock("@/lib/_core/api", () => ({
      apiFetch: async (path: string, options?: RequestInit) => {
        const response = await fetch(`https://escala.example${path}`, options);
        return {
          ok: response.ok,
          status: response.status ?? (response.ok ? 200 : 500),
          data: await response.json(),
          credentialPresented: true,
        };
      },
    }));
    vi.doMock("@/lib/_core/auth", () => ({
      captureSessionTransportTicket: () => 7,
      isSessionTransportTicketCurrent: (ticket: number) => ticket === 7,
      runExclusiveWebSessionMutation: async <T>(operation: () => Promise<T>) =>
        operation(),
    }));
    vi.doMock("@/lib/tenant-state", () => ({
      getActiveTenantSnapshot: () => ({ institutionId: 11, revision: 1 }),
    }));
    vi.doMock("@/lib/sso-launch", () => ({
      isValidSsoTenantId: (value: unknown) =>
        Number.isSafeInteger(value) && Number(value) > 0,
    }));

    let resolveFetch!: (response: unknown) => void;
    const deferredFetch = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
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
    const requestSignal = (deferredFetch.mock.calls[0]?.[1] as RequestInit)
      .signal;
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

  async function loadRealTenantStateHarness(
    storage: {
      getItem: (key: string) => Promise<string | null>;
      setItem: (key: string, value: string) => Promise<void>;
      removeItem: (key: string) => Promise<void>;
    },
    onBeforeTenantChange?: () => void,
  ) {
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
            state[index] =
              typeof value === "function"
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
    tenantState.TenantStateProvider({ children: null, onBeforeTenantChange });
    if (!contextValue)
      throw new Error("TenantStateProvider não publicou contexto");
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
        isSessionAuthorizationCurrent: () => true,
        getActiveTenantSnapshot: harness.tenantState.getActiveTenantSnapshot,
        loadAllowedInstitutionIds: async () => [11, 22],
        setActiveInstitutionId: harness.context.setActiveInstitutionId,
        invalidateQueries: async () => {
          if (
            harness.tenantState.getActiveTenantSnapshot().institutionId === 11
          ) {
            aInvalidateStarted.resolve();
            await releaseAInvalidate.promise;
          }
        },
        navigateToConfirmation: navigate,
        navigateToAgenda: vi.fn(),
        openComunica: vi.fn(async () => ({ ok: true })),
      };

      const routeA = scope.enqueue(
        {
          type: "duty_confirmation",
          institutionId: 11,
          confirmationToken: "token-a",
        },
        dependencies,
      );
      await aWriteStarted.promise;
      await aInvalidateStarted.promise;
      const routeB = scope.enqueue(
        {
          type: "duty_confirmation",
          institutionId: 22,
          confirmationToken: "token-b",
        },
        dependencies,
      );

      await vi.advanceTimersByTimeAsync(NOTIFICATION_ROUTING_ITEM_TIMEOUT_MS);
      await expect(routeA).resolves.toBe(false);
      await expect(routeB).resolves.toBe(true);
      expect(navigate).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenCalledWith("token-b");
      expect(harness.reactState()).toBe(22);
      expect(harness.tenantState.getActiveTenantSnapshot().institutionId).toBe(
        22,
      );

      releaseAWrite.resolve();
      releaseAInvalidate.resolve();
      // Drena apenas continuações imediatas deste fluxo. `runAllTimers`
      // também percorre timers recorrentes de dependências carregadas após
      // resetModules e pode nunca estabilizar, sem relação com o fence tenant.
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();

      expect(harness.reactState()).toBe(22);
      expect(harness.tenantState.getActiveTenantSnapshot().institutionId).toBe(
        22,
      );
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

  it("limpa/fenceia antes de publicar B ou null e aborta se a limpeza síncrona falhar", async () => {
    const observedBeforePublish: (number | null)[] = [];
    let tenantStateModule:
      | Awaited<ReturnType<typeof loadRealTenantStateHarness>>["tenantState"]
      | undefined;
    const harness = await loadRealTenantStateHarness(
      {
        getItem: async () => null,
        setItem: async () => undefined,
        removeItem: async () => undefined,
      },
      () => {
        observedBeforePublish.push(
          tenantStateModule?.getActiveTenantSnapshot().institutionId ?? null,
        );
      },
    );
    tenantStateModule = harness.tenantState;

    await harness.context.setActiveInstitutionId(44);
    expect(observedBeforePublish).toEqual([null]);
    expect(harness.tenantState.getActiveTenantSnapshot().institutionId).toBe(
      44,
    );
    expect(harness.reactState()).toBe(44);

    await harness.context.clearInstitutionSelection();
    expect(observedBeforePublish).toEqual([null, 44]);
    expect(
      harness.tenantState.getActiveTenantSnapshot().institutionId,
    ).toBeNull();
    expect(harness.reactState()).toBeNull();

    const blocked = await loadRealTenantStateHarness(
      {
        getItem: async () => null,
        setItem: async () => undefined,
        removeItem: async () => undefined,
      },
      () => {
        throw new Error("queryClient.clear falhou");
      },
    );
    const before = blocked.tenantState.getActiveTenantSnapshot();
    await expect(blocked.context.setActiveInstitutionId(55)).rejects.toThrow(
      "queryClient.clear falhou",
    );
    expect(blocked.tenantState.getActiveTenantSnapshot()).toEqual(before);
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
    expect(
      harness.tenantState.getActiveTenantSnapshot().institutionId,
    ).toBeNull();

    releaseAWrite.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.reactState()).toBeNull();
    expect(
      harness.tenantState.getActiveTenantSnapshot().institutionId,
    ).toBeNull();
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

      await expect(
        harness.context.setActiveInstitutionId(33),
      ).resolves.toBeUndefined();
      await Promise.resolve();
      expect(harness.reactState()).toBe(33);
      expect(harness.tenantState.getActiveTenantSnapshot().institutionId).toBe(
        33,
      );
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
