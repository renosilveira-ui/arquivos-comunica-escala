import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canStartTenantAuthorizationHandshake } from "../lib/tenant-authorization";

const restoredUser = {
  id: 7,
  name: "Ana",
  email: "ana@example.com",
  role: "doctor" as const,
  approvalStatus: "APPROVED" as const,
  mustChangePassword: false,
};

type CapturedAuthValue = {
  user: typeof restoredUser | null;
  isAuthenticated: boolean;
  isSessionAuthorizationCurrent: () => boolean;
  sessionValidation: {
    status: "CHECKING" | "UNAVAILABLE" | "VERIFIED";
    sequence: number;
    userId?: number;
    isCurrent?: () => boolean;
  };
  refetch: () => Promise<void>;
};

async function renderWebAuthProvider(options: {
  meRequest?: () => Promise<{
    user: typeof restoredUser | null;
    sessionInvalid: boolean;
    networkOrServerError: boolean;
  }>;
}) {
  const effects: (() => void | (() => void))[] = [];
  const setUser = vi.fn();
  const setIsLoading = vi.fn();
  const setPushRegistrationRevision = vi.fn();
  const setSessionValidation = vi.fn();
  const setters = [
    setUser,
    setIsLoading,
    setPushRegistrationRevision,
    setSessionValidation,
  ];
  let stateIndex = 0;
  let capturedAuth: CapturedAuthValue | null = null;
  const meDetailedApi = vi.fn(async () => {
    const settled = (await options.meRequest?.()) ?? {
      user: restoredUser,
      sessionInvalid: false,
      networkOrServerError: false,
    };
    return settled.user
      ? { ...settled, validationReceipt: Object.freeze({}) }
      : settled;
  });
  const logoutApi = vi.fn(async () => ({
    status: "ROTATED" as const,
    revocationUserId: restoredUser.id,
  }));
  const closeSessionTokenTransportAdmission = vi.fn();
  const beginWebSessionQuarantine = vi.fn();
  const revokeWebSessionQuarantine = vi.fn();

  vi.doMock("react", () => ({
    createContext: () => ({ Provider: Symbol("AuthProvider") }),
    createElement: (_type: unknown, props: { value?: CapturedAuthValue }) => {
      if (props.value) capturedAuth = props.value;
      return null;
    },
    useCallback: (callback: unknown) => callback,
    useContext: vi.fn(),
    useEffect: vi.fn((effect: () => void | (() => void)) => {
      effects.push(effect);
    }),
    useMemo: (factory: () => unknown) => factory(),
    useRef: (initial: unknown) => ({ current: initial }),
    useState: (initial: unknown) => {
      const setter = setters[stateIndex % setters.length];
      stateIndex += 1;
      return [initial, setter];
    },
  }));
  vi.doMock("react-native", () => ({ Platform: { OS: "web" } }));
  vi.doMock("@tanstack/react-query", () => ({
    useQueryClient: () => ({ clear: vi.fn() }),
  }));
  vi.doMock("@/lib/push-token", () => ({
    getLastPushToken: () => null,
    setLastPushToken: vi.fn(),
  }));
  vi.doMock("@/lib/_core/api", () => ({
    isSessionMutationMismatchCode: () => false,
    authApi: {
      meDetailed: meDetailedApi,
      logout: logoutApi,
      login: vi.fn(),
      deleteAccount: vi.fn(),
      prepareSessionBindingMutation: vi.fn(),
    },
  }));
  vi.doMock("@/lib/_core/auth", () => ({
    admitWebSessionTransport: vi.fn(async () => true),
    admitSessionTokenTransport: vi.fn(),
    closeSessionTokenTransportAdmission,
    getPersistedUserId: vi.fn(async () => restoredUser.id),
    getWebSessionGateState: vi.fn(async () => ({ state: "CLEAR" })),
    isSessionTransportUserCurrent: vi.fn(() => true),
    isWebSessionQuarantined: vi.fn(async () => false),
    isSessionTokenQuarantined: vi.fn(async () => false),
    runExclusiveWebSessionMutation: vi.fn(
      async <T>(operation: () => Promise<T>) => operation(),
    ),
    subscribeExternalWebSessionInvalidation: vi.fn(() => () => undefined),
    setUserInfo: vi.fn(async () => undefined),
    clearUserInfo: vi.fn(),
    removeSessionToken: vi.fn(),
    captureSessionTransportTicket: vi.fn(() => null),
    getSessionTransportExpectedUserId: vi.fn(),
    getSessionTransportSessionInstance: vi.fn(),
    captureWebSessionMutationIntent: vi.fn(() => ({ revision: 0 })),
    beginWebSessionMutationIntent: vi.fn(),
    discardWebSessionMutationIntent: vi.fn(),
    beginWebSessionQuarantine,
    revokeWebSessionQuarantine,
    getAdmittedSessionUserId: vi.fn(async () => restoredUser.id),
  }));
  vi.doMock("@/lib/tenant-state", () => ({
    clearActiveInstitutionId: vi.fn(),
  }));
  vi.doMock("@/lib/query-persist", () => ({
    clearPersistedQueryCache: vi.fn(),
    fenceQueryCachePersistence: vi.fn(),
    suspendQueryCachePersistence: vi.fn(() => vi.fn()),
  }));
  vi.doMock("@/lib/push-registration", () => ({
    clearPushRegistrationState: vi.fn(),
    closePushRegistrationAdmission: vi.fn(),
    openPushRegistrationAdmission: vi.fn(),
    waitForPushRegistrationIdle: vi.fn(async () => undefined),
  }));
  vi.doMock("@/lib/session-events", () => ({
    onSessionUnauthorized: vi.fn(() => () => undefined),
  }));
  vi.doMock("@/lib/_core/session-binding-protocol", () => ({
    exactSessionBindingClientActive: () => false,
  }));

  const [{ AuthProvider }, sessionEpoch, webSession] = await Promise.all([
    import("../hooks/use-auth"),
    import("../lib/session-epoch"),
    import("../lib/web-verified-session"),
  ]);

  const mount = () => {
    const firstEffect = effects.length;
    capturedAuth = null;
    AuthProvider({ children: null });
    if (!capturedAuth) {
      throw new Error("AuthProvider não publicou o contexto");
    }
    return {
      auth: capturedAuth,
      flushMountEffects: () => {
        for (const effect of effects.slice(firstEffect)) effect();
      },
    };
  };

  return {
    mount,
    meDetailedApi,
    logoutApi,
    setSessionValidation,
    closeSessionTokenTransportAdmission,
    beginWebSessionQuarantine,
    revokeWebSessionQuarantine,
    sessionEpoch,
    webSession,
  };
}

describe("remount web com receipt VERIFIED e sequence stale", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("react");
    vi.doUnmock("react-native");
  });

  it("alinha a sequence, mantém o gate aberto e refetch /me sem CHECKING/logout", async () => {
    const harness = await renderWebAuthProvider({
      meRequest: async () => ({
        user: null,
        sessionInvalid: false,
        networkOrServerError: true,
      }),
    });
    harness.webSession.rememberPreservedWebVerifiedSession({
      user: restoredUser,
      ticket: harness.sessionEpoch.appSessionEpoch.capture(),
      sequence: 11,
    });

    const first = harness.mount();

    expect(first.auth.user).toEqual(restoredUser);
    expect(first.auth.sessionValidation.status).toBe("VERIFIED");
    expect(first.auth.sessionValidation.sequence).toBe(11);
    expect(first.auth.isSessionAuthorizationCurrent()).toBe(true);
    expect(first.auth.sessionValidation.isCurrent?.()).toBe(true);
    expect(
      canStartTenantAuthorizationHandshake({
        user: first.auth.user,
        sessionValidation: first.auth.sessionValidation,
      }),
    ).toBe(true);

    first.flushMountEffects();
    await vi.waitFor(() =>
      expect(harness.meDetailedApi).toHaveBeenCalledTimes(1),
    );

    expect(harness.logoutApi).not.toHaveBeenCalled();
    expect(harness.beginWebSessionQuarantine).not.toHaveBeenCalled();
    expect(harness.revokeWebSessionQuarantine).not.toHaveBeenCalled();
    expect(harness.closeSessionTokenTransportAdmission).not.toHaveBeenCalled();
    expect(harness.setSessionValidation).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "CHECKING" }),
    );
    expect(harness.setSessionValidation).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "UNAVAILABLE" }),
    );
    expect(harness.setSessionValidation).toHaveBeenCalledWith(
      expect.objectContaining({ status: "VERIFIED", userId: restoredUser.id }),
    );
  });

  it("remount após refetch soft com /me indisponível continua atual e consulta /me de novo", async () => {
    const harness = await renderWebAuthProvider({
      meRequest: async () => ({
        user: null,
        sessionInvalid: false,
        networkOrServerError: true,
      }),
    });
    harness.webSession.rememberPreservedWebVerifiedSession({
      user: restoredUser,
      ticket: harness.sessionEpoch.appSessionEpoch.capture(),
      sequence: 4,
    });

    const first = harness.mount();
    expect(first.auth.isSessionAuthorizationCurrent()).toBe(true);
    first.flushMountEffects();
    await vi.waitFor(() =>
      expect(harness.meDetailedApi).toHaveBeenCalledTimes(1),
    );

    const remounted = harness.mount();
    expect(remounted.auth.user).toEqual(restoredUser);
    expect(remounted.auth.sessionValidation.status).toBe("VERIFIED");
    expect(remounted.auth.isSessionAuthorizationCurrent()).toBe(true);
    expect(
      canStartTenantAuthorizationHandshake({
        user: remounted.auth.user,
        sessionValidation: remounted.auth.sessionValidation,
      }),
    ).toBe(true);

    remounted.flushMountEffects();
    await vi.waitFor(() =>
      expect(harness.meDetailedApi).toHaveBeenCalledTimes(2),
    );
    expect(harness.logoutApi).not.toHaveBeenCalled();
    expect(harness.setSessionValidation).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "CHECKING" }),
    );
  });
});
