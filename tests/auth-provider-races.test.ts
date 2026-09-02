import { beforeEach, describe, expect, it, vi } from "vitest";

type TestUser = {
  id: number;
  name: string;
  email: string;
  role: "doctor";
  approvalStatus?: "PENDING" | "APPROVED";
  mustChangePassword?: boolean;
};

type LoginResult = {
  ok: boolean;
  user?: TestUser;
  token?: string;
  error?: string;
};

type RevocationProof = {
  status: "ROTATED" | "ALREADY_INVALID";
  revocationUserId: number | null;
};

type PreparedRevocation =
  | Readonly<{
      token: string;
      phase: "PENDING";
      fingerprint: string;
      nonce: string;
      expectedUserId: number;
    }>
  | Readonly<{
      token: string;
      phase: "LEGACY";
      fingerprint: string;
      nonce: string;
      expectedUserId?: never;
    }>;

type NativeSessionGateState =
  | { state: "CLEAR" }
  | { state: "ADMITTED"; expectedUserId: number }
  | { state: "REVOKE_REQUIRED" }
  | { state: "LEGACY_REVOKE_REQUIRED" }
  | { state: "REVOKED_CLEANUP_REQUIRED" }
  | { state: "BLOCKED" };

type MeResult = {
  user: TestUser | null;
  sessionInvalid: boolean;
  networkOrServerError: boolean;
  code?: "EXPECTED_USER_MISMATCH" | "MALFORMED_EXPECTED_USER_ID";
  validationReceipt?: object;
};

type CapturedAuthValue = {
  isAuthenticated: boolean;
  login: (
    email: string,
    password: string,
  ) => Promise<{ ok: boolean; error?: string; admissionPending?: true }>;
  rotateSession: (
    operation: (
      credential: object,
    ) => Promise<{ ok: boolean; token?: string; error?: string }>,
  ) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
  refetch: () => Promise<void>;
};

type AuthProviderHarnessOptions = {
  initialUser?: TestUser | null;
  runMountEffects?: boolean;
  loginRequest?: (email: string, password: string) => Promise<LoginResult>;
  meRequest?: () => Promise<MeResult>;
  revalidateTokenRequest?: (
    token: string,
    expectedUserId: number,
  ) => Promise<MeResult>;
  logoutRequest?: () => Promise<void>;
  revokeTokenRequest?: (token: string) => Promise<void | RevocationProof>;
  persistRevokedCleanup?: () => Promise<void>;
  persistSessionToken?: (token: string) => Promise<void>;
  commitSessionToken?: () => Promise<void>;
  admittedSessionUserId?: () => number | null | Promise<number | null>;
  admittedSessionToken?: () => string | null | Promise<string | null>;
  sessionTokenQuarantined?: () => boolean | Promise<boolean>;
  nativeSessionGateState?: () =>
    | NativeSessionGateState
    | Promise<NativeSessionGateState>;
  quarantinedSessionToken?: () => string | null | Promise<string | null>;
  persistUser?: (user: TestUser) => Promise<void>;
  removeSessionToken?: () => Promise<void>;
  clearUserInfo?: () => Promise<void>;
  clearActiveInstitution?: () => Promise<void>;
  clearPersistedQueryCache?: () => Promise<void>;
  clearPushRegistrationState?: () => Promise<void>;
  clearQueryMemory?: () => void;
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const userA: TestUser = {
  id: 41,
  name: "Profissional A",
  email: "a@example.com",
  role: "doctor",
};

const userB: TestUser = {
  id: 42,
  name: "Profissional B",
  email: "b@example.com",
  role: "doctor",
};

const staleMeResponses: readonly (readonly [string, MeResult])[] = [
  [
    "200 antigo",
    {
      user: userA,
      sessionInvalid: false,
      networkOrServerError: false,
    },
  ],
  [
    "401 antigo",
    {
      user: null,
      sessionInvalid: true,
      networkOrServerError: false,
    },
  ],
];

async function renderRealAuthProvider(
  options: AuthProviderHarnessOptions = {},
) {
  let capturedAuth: CapturedAuthValue | null = null;
  let pushRegistrationRevision = 0;
  const effects: (() => void | (() => void))[] = [];

  const setUser = vi.fn<(user: TestUser | null) => void>();
  const setIsLoading = vi.fn<(loading: boolean) => void>();
  const setSessionValidation = vi.fn();
  const setPushRegistrationRevision = vi.fn(
    (update: number | ((current: number) => number)) => {
      pushRegistrationRevision =
        typeof update === "function"
          ? update(pushRegistrationRevision)
          : update;
    },
  );
  const useStateMock = vi
    .fn()
    .mockReturnValueOnce([
      options.initialUser === undefined ? userA : options.initialUser,
      setUser,
    ])
    .mockReturnValueOnce([false, setIsLoading])
    .mockReturnValueOnce([
      pushRegistrationRevision,
      setPushRegistrationRevision,
    ])
    .mockReturnValueOnce([
      { status: "CHECKING", sequence: 0 },
      setSessionValidation,
    ]);
  const queryClient = {
    clear: vi.fn(() => {
      options.clearQueryMemory?.();
    }),
  };
  let stagedTokenVersion = 0;
  let stagedExpectedUserId: number | null = null;
  let stagedSessionTokenValue: string | null = null;
  let admittedSessionUserId =
    options.initialUser === undefined
      ? userA.id
      : (options.initialUser?.id ?? null);
  let admittedSessionToken = admittedSessionUserId === null ? null : "token-A";
  let locallyQuarantinedToken: string | null = null;
  let locallyQuarantinedUserId: number | null = null;
  let locallyPreparedRevocation: PreparedRevocation | null = null;
  const setSessionToken = vi.fn(
    async (token: string, expectedUserId: number) => {
      await options.persistSessionToken?.(token);
      stagedExpectedUserId = expectedUserId;
      stagedSessionTokenValue = token;
      stagedTokenVersion += 1;
      return { version: stagedTokenVersion };
    },
  );
  const commitStagedSessionToken = vi.fn(async () => {
    await options.commitSessionToken?.();
    admittedSessionUserId = stagedExpectedUserId;
    admittedSessionToken = stagedSessionTokenValue;
    locallyQuarantinedToken = null;
    stagedExpectedUserId = null;
    stagedSessionTokenValue = null;
  });
  let persistedUserId =
    options.initialUser === undefined
      ? userA.id
      : (options.initialUser?.id ?? null);
  const setUserInfo = vi.fn(async (user: TestUser) => {
    persistedUserId = user.id;
    await options.persistUser?.(user);
  });
  const getPersistedUserId = vi.fn(async () => persistedUserId);
  const getNativeSessionGateState = vi.fn(async () => {
    const explicit = await options.nativeSessionGateState?.();
    if (explicit) return explicit;
    const quarantined =
      locallyQuarantinedToken !== null ||
      (await options.sessionTokenQuarantined?.()) === true;
    if (quarantined) return { state: "REVOKE_REQUIRED" } as const;
    const currentAdmittedUserId = options.admittedSessionUserId
      ? await options.admittedSessionUserId()
      : admittedSessionUserId;
    return currentAdmittedUserId === null
      ? ({ state: "CLEAR" } as const)
      : ({
          state: "ADMITTED",
          expectedUserId: currentAdmittedUserId,
        } as const);
  });
  const clearActiveInstitutionId = vi.fn(async () => {
    await options.clearActiveInstitution?.();
  });
  const removeSessionToken = vi.fn(async () => {
    await options.removeSessionToken?.();
    admittedSessionUserId = null;
    admittedSessionToken = null;
    locallyQuarantinedToken = null;
    locallyQuarantinedUserId = null;
    stagedExpectedUserId = null;
    stagedSessionTokenValue = null;
  });
  const clearUserInfo = vi.fn(async () => {
    persistedUserId = null;
    await options.clearUserInfo?.();
  });
  const clearPersistedQueryCache = vi.fn(
    options.clearPersistedQueryCache ?? (async () => undefined),
  );
  const clearPushRegistrationState = vi.fn(
    options.clearPushRegistrationState ?? (async () => undefined),
  );
  const closePushRegistrationAdmission = vi.fn();
  const openPushRegistrationAdmission = vi.fn();
  const waitForPushRegistrationIdle = vi.fn(async () => undefined);
  const fenceQueryCachePersistence = vi.fn();
  const clearVerifiedNotificationForegroundSubject = vi.fn();
  const resumeQueryCachePersistence = vi.fn(() => true);
  const suspendQueryCachePersistence = vi.fn(() => resumeQueryCachePersistence);
  const loginApi = vi.fn(
    options.loginRequest ??
      (async () => ({ ok: false, error: "login não configurado" })),
  );
  const withValidationReceipt = (result: MeResult): MeResult =>
    result.user ? { ...result, validationReceipt: Object.freeze({}) } : result;
  const meDetailedApi = vi.fn(async () =>
    withValidationReceipt(
      await (options.meRequest?.() ??
        Promise.resolve({
          user: null,
          sessionInvalid: false,
          networkOrServerError: true,
        })),
    ),
  );
  const logoutApi = vi.fn(async () => {
    await options.logoutRequest?.();
    return {
      status: "ROTATED" as const,
      revocationUserId: locallyQuarantinedUserId ?? userA.id,
    };
  });
  const revokeSessionTokenApi = vi.fn(async (token: string) => {
    const proof = await options.revokeTokenRequest?.(token);
    if (proof) return proof;
    return {
      status: "ROTATED" as const,
      revocationUserId:
        locallyQuarantinedUserId ??
        (token.toLowerCase().includes("b") ? userB.id : userA.id),
    };
  });
  const revalidateSessionTokenApi = vi.fn(
    async (token: string, expectedUserId: number) =>
      withValidationReceipt(
        await (options.revalidateTokenRequest?.(token, expectedUserId) ??
          Promise.resolve({
            user: null,
            sessionInvalid: false,
            networkOrServerError: true,
          })),
      ),
  );
  const prepareSessionTokenRevocation = vi.fn(
    async (expectedToken?: string, expectedUserId?: number) => {
      const admittedUserIdBeforeQuarantine = options.admittedSessionUserId
        ? await options.admittedSessionUserId()
        : admittedSessionUserId;
      const token =
        expectedToken ??
        locallyQuarantinedToken ??
        (options.quarantinedSessionToken
          ? await options.quarantinedSessionToken()
          : null) ??
        (options.admittedSessionToken
          ? await options.admittedSessionToken()
          : admittedSessionToken);
      if (!token) throw new Error("Bearer revogável ausente");
      locallyQuarantinedToken = token;
      locallyQuarantinedUserId =
        expectedUserId ?? admittedUserIdBeforeQuarantine;
      admittedSessionUserId = null;
      admittedSessionToken = null;
      const physicalUserId = locallyQuarantinedUserId ?? undefined;
      if (
        locallyPreparedRevocation?.token === token &&
        locallyPreparedRevocation.expectedUserId === physicalUserId
      ) {
        return locallyPreparedRevocation;
      }
      const fingerprint = token.toLowerCase().includes("b")
        ? "b".repeat(64)
        : "a".repeat(64);
      const nonce = token.toLowerCase().includes("b")
        ? "2".repeat(32)
        : "1".repeat(32);
      locallyPreparedRevocation = Object.freeze(
        physicalUserId === undefined
          ? { token, phase: "LEGACY", fingerprint, nonce }
          : {
              token,
              phase: "PENDING",
              fingerprint,
              nonce,
              expectedUserId: physicalUserId,
            },
      ) as PreparedRevocation;
      return locallyPreparedRevocation;
    },
  );
  const revokePreparedSessionToken = vi.fn(
    async (prepared: PreparedRevocation) => {
      if (
        prepared !== locallyPreparedRevocation ||
        prepared.token !== locallyQuarantinedToken
      ) {
        throw new Error("binding de cleanup divergente");
      }
      const proof = await revokeSessionTokenApi(prepared.token);
      const revocationUserId = proof.revocationUserId;
      const hasValidServerUserId =
        typeof revocationUserId === "number" &&
        Number.isSafeInteger(revocationUserId) &&
        revocationUserId > 0;
      if (
        (proof.status === "ROTATED" && !hasValidServerUserId) ||
        (revocationUserId !== null && !hasValidServerUserId) ||
        (hasValidServerUserId &&
          prepared.expectedUserId !== undefined &&
          revocationUserId !== prepared.expectedUserId)
      ) {
        throw new Error("binding de cleanup divergente");
      }
      locallyQuarantinedUserId =
        revocationUserId ?? prepared.expectedUserId ?? null;
      try {
        await options.persistRevokedCleanup?.();
      } catch (cause) {
        throw Object.assign(
          new Error(
            "O servidor confirmou a revogação, mas o estado local não foi persistido",
          ),
          {
            name: "ConfirmedSessionRevocationLocalCleanupError",
            code: "SESSION_REVOCATION_CONFIRMED_LOCAL_CLEANUP_FAILED",
            cause,
          },
        );
      }
    },
  );
  let reversibleRevocation: {
    receipt: object;
    token: string;
    expectedUserId: number;
  } | null = null;
  const prepareReversibleSessionTokenRevocation = vi.fn(
    async (expectedUserId: number) => {
      const token = options.admittedSessionToken
        ? await options.admittedSessionToken()
        : admittedSessionToken;
      const admittedUserId = options.admittedSessionUserId
        ? await options.admittedSessionUserId()
        : admittedSessionUserId;
      if (!token || admittedUserId !== expectedUserId) {
        throw new Error("sessão não reversível");
      }
      const receipt = Object.freeze({});
      reversibleRevocation = { receipt, token, expectedUserId };
      locallyQuarantinedToken = token;
      admittedSessionUserId = null;
      admittedSessionToken = null;
      return receipt;
    },
  );
  const getReversibleSessionTokenForRevocation = vi.fn((receipt: object) => {
    if (reversibleRevocation?.receipt !== receipt) {
      throw new Error("receipt inválida");
    }
    return reversibleRevocation.token;
  });
  const restoreReversibleSessionTokenAdmission = vi.fn(
    async (receipt: object) => {
      if (
        reversibleRevocation?.receipt !== receipt ||
        locallyQuarantinedToken !== reversibleRevocation.token
      ) {
        throw new Error("binding PENDING divergente");
      }
      admittedSessionUserId = reversibleRevocation.expectedUserId;
      admittedSessionToken = reversibleRevocation.token;
      locallyQuarantinedToken = null;
      reversibleRevocation = null;
    },
  );
  const setLastPushToken = vi.fn();
  const setBadgeCountAsync = vi.fn(async () => true);
  const dismissAllNotificationsAsync = vi.fn(async () => undefined);
  const cancelAllScheduledNotificationsAsync = vi.fn(async () => undefined);
  const clearLastNotificationResponse = vi.fn();
  const closeSessionTokenTransportAdmission = vi.fn();
  const admitSessionTokenTransport = vi.fn(async () => undefined);
  const admitWebSessionTransport = vi.fn();
  const transitionCredential = Object.freeze({});
  const captureSessionTransitionCredential = vi.fn(() => transitionCredential);
  const discardSessionTransitionCredential = vi.fn();

  // O componente e seus callbacks são os de produção. Só o runtime mínimo de
  // hooks é substituído para expor o valor do Context sem adicionar renderer.
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
    useState: useStateMock,
  }));
  vi.doMock("react-native", () => ({ Platform: { OS: "ios" } }));
  vi.doMock("@tanstack/react-query", () => ({
    useQueryClient: () => queryClient,
  }));
  vi.doMock("@/lib/push-token", () => ({
    getLastPushToken: () => null,
    setLastPushToken,
  }));
  vi.doMock("@/lib/_core/api", () => ({
    authApi: {
      login: loginApi,
      logout: logoutApi,
      meDetailed: meDetailedApi,
      revalidateSessionToken: revalidateSessionTokenApi,
      revokeSessionToken: revokeSessionTokenApi,
    },
  }));
  vi.doMock("@/lib/_core/auth", () => ({
    admitSessionTokenTransport,
    admitWebSessionTransport,
    captureSessionTransitionCredential,
    clearUserInfo,
    closeSessionTokenTransportAdmission,
    commitStagedSessionToken,
    discardSessionTransitionCredential,
    getQuarantinedSessionTokenForRevocation: vi.fn(
      async () =>
        locallyQuarantinedToken ?? options.quarantinedSessionToken?.() ?? null,
    ),
    getSessionToken: vi.fn(async () =>
      locallyQuarantinedToken !== null
        ? null
        : options.admittedSessionToken
          ? await options.admittedSessionToken()
          : admittedSessionToken,
    ),
    getAdmittedSessionUserId: vi.fn(async () =>
      locallyQuarantinedToken !== null
        ? null
        : options.admittedSessionUserId
          ? await options.admittedSessionUserId()
          : admittedSessionUserId,
    ),
    getPersistedUserId,
    getNativeSessionGateState,
    isSessionTokenQuarantined: vi.fn(
      async () =>
        locallyQuarantinedToken !== null ||
        (options.sessionTokenQuarantined?.() ?? false),
    ),
    isConfirmedSessionRevocationLocalCleanupError: (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code ===
        "SESSION_REVOCATION_CONFIRMED_LOCAL_CLEANUP_FAILED",
    revokePreparedSessionToken,
    isSessionTransportUserCurrent: vi.fn(() => true),
    subscribeExternalWebSessionInvalidation: vi.fn(() => () => undefined),
    runExclusiveWebSessionMutation: vi.fn(
      async <T>(operation: () => Promise<T>) => operation(),
    ),
    getReversibleSessionTokenForRevocation,
    prepareSessionTokenRevocation,
    prepareReversibleSessionTokenRevocation,
    restoreReversibleSessionTokenAdmission,
    removeSessionToken,
    setSessionToken,
    stageSessionToken: setSessionToken,
    setUserInfo,
  }));
  vi.doMock("@/lib/tenant-state", () => ({ clearActiveInstitutionId }));
  vi.doMock("@/lib/query-persist", () => ({
    clearPersistedQueryCache,
    fenceQueryCachePersistence,
    suspendQueryCachePersistence,
  }));
  vi.doMock("@/lib/notification-foreground-subject", () => ({
    clearVerifiedNotificationForegroundSubject,
  }));
  vi.doMock("@/lib/push-registration", () => ({
    clearPushRegistrationState,
    closePushRegistrationAdmission,
    openPushRegistrationAdmission,
    waitForPushRegistrationIdle,
  }));
  vi.doMock("@/lib/session-events", () => ({ onSessionUnauthorized: vi.fn() }));
  vi.doMock("expo-notifications", () => ({
    setBadgeCountAsync,
    dismissAllNotificationsAsync,
    cancelAllScheduledNotificationsAsync,
    clearLastNotificationResponse,
  }));

  const [{ AuthProvider }, { appSessionEpoch }] = await Promise.all([
    import("../hooks/use-auth"),
    import("../lib/session-epoch"),
  ]);
  AuthProvider({ children: null });
  if (!capturedAuth)
    throw new Error("AuthProvider real não publicou o contexto");
  if (options.runMountEffects) {
    for (const effect of effects) effect();
  }

  const remount = (
    remountOptions: Pick<
      AuthProviderHarnessOptions,
      "initialUser" | "runMountEffects"
    > = {},
  ) => {
    let remountedPushRegistrationRevision = 0;
    const remountedSetUser = vi.fn<(user: TestUser | null) => void>();
    const remountedSetIsLoading = vi.fn<(loading: boolean) => void>();
    const remountedSetSessionValidation = vi.fn();
    const remountedSetPushRegistrationRevision = vi.fn(
      (update: number | ((current: number) => number)) => {
        remountedPushRegistrationRevision =
          typeof update === "function"
            ? update(remountedPushRegistrationRevision)
            : update;
      },
    );
    useStateMock
      .mockReturnValueOnce([
        remountOptions.initialUser === undefined
          ? userA
          : remountOptions.initialUser,
        remountedSetUser,
      ])
      .mockReturnValueOnce([false, remountedSetIsLoading])
      .mockReturnValueOnce([
        remountedPushRegistrationRevision,
        remountedSetPushRegistrationRevision,
      ])
      .mockReturnValueOnce([
        { status: "CHECKING", sequence: 0 },
        remountedSetSessionValidation,
      ]);

    const firstRemountedEffect = effects.length;
    capturedAuth = null;
    AuthProvider({ children: null });
    if (!capturedAuth)
      throw new Error("AuthProvider remontado não publicou o contexto");
    if (remountOptions.runMountEffects) {
      for (const effect of effects.slice(firstRemountedEffect)) effect();
    }

    return {
      auth: capturedAuth as CapturedAuthValue,
      setUser: remountedSetUser,
      setIsLoading: remountedSetIsLoading,
      setSessionValidation: remountedSetSessionValidation,
      setPushRegistrationRevision: remountedSetPushRegistrationRevision,
    };
  };

  return {
    auth: capturedAuth as CapturedAuthValue,
    remount,
    appSessionEpoch,
    setUser,
    setIsLoading,
    setSessionValidation,
    setPushRegistrationRevision,
    setSessionToken,
    setUserInfo,
    clearActiveInstitutionId,
    removeSessionToken,
    clearUserInfo,
    clearPersistedQueryCache,
    clearPushRegistrationState,
    queryClient,
    openPushRegistrationAdmission,
    resumeQueryCachePersistence,
    loginApi,
    logoutApi,
    meDetailedApi,
    revokeSessionTokenApi,
    revalidateSessionTokenApi,
    commitStagedSessionToken,
    prepareSessionTokenRevocation,
    getNativeSessionGateState,
    revokePreparedSessionToken,
    setLastPushToken,
    setBadgeCountAsync,
    dismissAllNotificationsAsync,
    cancelAllScheduledNotificationsAsync,
    clearLastNotificationResponse,
    closeSessionTokenTransportAdmission,
    clearVerifiedNotificationForegroundSubject,
    admitSessionTokenTransport,
  };
}

describe("AuthProvider real — CAS temporal da sessão", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("identidade cached não concede isAuthenticated antes de /me VERIFIED", async () => {
    const harness = await renderRealAuthProvider({ initialUser: userA });

    expect(harness.auth.isAuthenticated).toBe(false);
    expect(harness.meDetailedApi).not.toHaveBeenCalled();
  });

  it("BEGIN de runSessionMutation limpa o sujeito visual antes da operação assíncrona", async () => {
    const loginReply = deferred<LoginResult>();
    const harness = await renderRealAuthProvider({
      loginRequest: () => loginReply.promise,
    });

    const login = harness.auth.login(userB.email, "senha-B");
    await vi.waitFor(() => expect(harness.loginApi).toHaveBeenCalledTimes(1));

    expect(
      harness.clearVerifiedNotificationForegroundSubject.mock.invocationCallOrder[0],
    ).toBeLessThan(harness.loginApi.mock.invocationCallOrder[0]);

    loginReply.resolve({ ok: false, error: "Credenciais inválidas" });
    await expect(login).resolves.toEqual({
      ok: false,
      error: "Credenciais inválidas",
    });
  });

  it("cold boot com cleanup remoto confirmado encerra A e limpa artefatos sem novo POST", async () => {
    const harness = await renderRealAuthProvider({
      initialUser: userA,
      runMountEffects: true,
      nativeSessionGateState: () => ({
        state: "REVOKED_CLEANUP_REQUIRED",
      }),
    });

    await vi.waitFor(() => expect(harness.setUser).toHaveBeenCalledWith(null));

    expect(harness.getNativeSessionGateState).toHaveBeenCalledTimes(1);
    expect(harness.revokeSessionTokenApi).not.toHaveBeenCalled();
    expect(harness.logoutApi).not.toHaveBeenCalled();
    expect(harness.meDetailedApi).not.toHaveBeenCalled();
    expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
    expect(harness.clearUserInfo).toHaveBeenCalledTimes(1);
    expect(harness.clearPersistedQueryCache).toHaveBeenCalledTimes(1);
    expect(harness.queryClient.clear).toHaveBeenCalledTimes(1);
    expect(harness.clearActiveInstitutionId).toHaveBeenCalledTimes(1);
    expect(harness.setBadgeCountAsync).toHaveBeenCalledWith(0);
    expect(harness.dismissAllNotificationsAsync).toHaveBeenCalledTimes(1);
    expect(harness.cancelAllScheduledNotificationsAsync).toHaveBeenCalledTimes(
      1,
    );
    expect(harness.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
  });

  it("intenção de login invalida /me A que já estava aguardando o workflow", async () => {
    const oldMe = deferred<MeResult>();
    let meCalls = 0;
    const harness = await renderRealAuthProvider({
      initialUser: userA,
      loginRequest: async () => ({
        ok: true,
        user: userB,
        token: "token-B",
      }),
      meRequest: async () => {
        meCalls += 1;
        if (meCalls === 1) return oldMe.promise;
        return {
          user: userB,
          sessionInvalid: false,
          networkOrServerError: false,
        };
      },
    });

    const staleRefetch = harness.auth.refetch();
    await vi.waitFor(() =>
      expect(harness.meDetailedApi).toHaveBeenCalledTimes(1),
    );
    const login = harness.auth.login("b@example.com", "segredo");
    await expect(login).resolves.toEqual({ ok: true });
    expect(harness.admitSessionTokenTransport).toHaveBeenCalledWith(
      expect.any(Object),
    );

    oldMe.resolve({
      user: userA,
      sessionInvalid: false,
      networkOrServerError: false,
    });
    await staleRefetch;

    expect(harness.admitSessionTokenTransport).toHaveBeenCalledTimes(1);
    expect(harness.setUser).not.toHaveBeenCalledWith(userA);
  });

  it("logout servidor confirmado encerra a UI mesmo se o token local não puder ser removido", async () => {
    const secureStoreError = new Error("SecureStore indisponível");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const harness = await renderRealAuthProvider({
      removeSessionToken: async () => {
        throw secureStoreError;
      },
    });

    const error = await harness.auth.logout().catch((caught) => caught);

    expect(error).toMatchObject({
      name: "SessionTerminationLocalCleanupError",
      reason: {
        name: "AggregateError",
        errors: [secureStoreError],
      },
    });
    expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
    expect(harness.clearUserInfo).toHaveBeenCalledTimes(1);
    expect(harness.clearActiveInstitutionId).toHaveBeenCalledTimes(1);
    expect(harness.clearPersistedQueryCache).toHaveBeenCalledTimes(1);
    expect(harness.queryClient.clear).toHaveBeenCalledTimes(1);
    expect(harness.setLastPushToken).toHaveBeenCalledWith(null);
    expect(harness.setUser).toHaveBeenCalledWith(null);
    expect(harness.setBadgeCountAsync).toHaveBeenCalledWith(0);
    expect(harness.dismissAllNotificationsAsync).toHaveBeenCalledTimes(1);
    expect(harness.cancelAllScheduledNotificationsAsync).toHaveBeenCalledTimes(
      1,
    );
    expect(harness.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
    expect(harness.openPushRegistrationAdmission).not.toHaveBeenCalled();
  });

  it("falha física do cache é reportada, mas memória é apagada antes de publicar tenant null", async () => {
    const cacheError = new Error("multiRemove indisponível");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const harness = await renderRealAuthProvider({
      clearPersistedQueryCache: async () => {
        throw cacheError;
      },
    });

    const error = await harness.auth.logout().catch((caught) => caught);

    expect(error).toMatchObject({
      name: "SessionTerminationLocalCleanupError",
      reason: {
        name: "AggregateError",
        errors: [cacheError],
      },
    });
    expect(harness.queryClient.clear).toHaveBeenCalledTimes(1);
    expect(harness.clearActiveInstitutionId).toHaveBeenCalledTimes(1);
    expect(harness.setUser).toHaveBeenCalledWith(null);
    expect(
      harness.clearPersistedQueryCache.mock.invocationCallOrder[0],
    ).toBeLessThan(harness.queryClient.clear.mock.invocationCallOrder[0]);
    expect(harness.queryClient.clear.mock.invocationCallOrder[0]).toBeLessThan(
      harness.clearActiveInstitutionId.mock.invocationCallOrder[0],
    );
  });

  it("2xx seguido de falha da prova local mantém a fase confirmada e conclui toda a higiene", async () => {
    const proofError = new Error("admission revogada sem readback");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const harness = await renderRealAuthProvider({
      persistRevokedCleanup: async () => {
        throw proofError;
      },
    });

    const error = await harness.auth.logout().catch((caught) => caught);

    expect(error).toMatchObject({
      name: "SessionTerminationLocalCleanupError",
      reason: {
        code: "SESSION_REVOCATION_CONFIRMED_LOCAL_CLEANUP_FAILED",
        cause: proofError,
      },
    });
    expect(harness.revokeSessionTokenApi).toHaveBeenCalledTimes(1);
    expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
    expect(harness.setBadgeCountAsync).toHaveBeenCalledWith(0);
    expect(harness.dismissAllNotificationsAsync).toHaveBeenCalledTimes(1);
    expect(harness.cancelAllScheduledNotificationsAsync).toHaveBeenCalledTimes(
      1,
    );
    expect(harness.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
    expect(harness.setUser).toHaveBeenCalledWith(null);
  });

  it("2xx com falha da prova e da remoção agrega ambas sem reabrir a sessão", async () => {
    const proofError = new Error("admission revogada sem readback");
    const secureStoreError = new Error("SecureStore indisponível");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const harness = await renderRealAuthProvider({
      persistRevokedCleanup: async () => {
        throw proofError;
      },
      removeSessionToken: async () => {
        throw secureStoreError;
      },
    });

    const error = await harness.auth.logout().catch((caught) => caught);

    expect(error).toMatchObject({
      name: "SessionTerminationLocalCleanupError",
      reason: {
        name: "AggregateError",
        errors: [
          {
            code: "SESSION_REVOCATION_CONFIRMED_LOCAL_CLEANUP_FAILED",
            cause: proofError,
          },
          secureStoreError,
        ],
      },
    });
    expect(harness.revokeSessionTokenApi).toHaveBeenCalledTimes(1);
    expect(harness.openPushRegistrationAdmission).not.toHaveBeenCalled();
    expect(harness.setUser).toHaveBeenCalledWith(null);
    expect(harness.setBadgeCountAsync).toHaveBeenCalledWith(0);
    expect(harness.dismissAllNotificationsAsync).toHaveBeenCalledTimes(1);
    expect(harness.cancelAllScheduledNotificationsAsync).toHaveBeenCalledTimes(
      1,
    );
    expect(harness.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
  });

  it("/me 401 nunca confirma revogação quando a barreira local impede o logout", async () => {
    const storageError = new Error("storage indisponível");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const rejectStorage = async () => {
      throw storageError;
    };
    const harness = await renderRealAuthProvider({
      meRequest: async () => ({
        user: null,
        sessionInvalid: true,
        networkOrServerError: false,
      }),
      removeSessionToken: rejectStorage,
      clearPushRegistrationState: rejectStorage,
      clearUserInfo: rejectStorage,
      clearActiveInstitution: rejectStorage,
      clearPersistedQueryCache: rejectStorage,
      clearQueryMemory: () => {
        throw storageError;
      },
    });

    await harness.auth.refetch();

    expect(harness.removeSessionToken).not.toHaveBeenCalled();
    expect(harness.clearPushRegistrationState).toHaveBeenCalledTimes(1);
    expect(harness.revokeSessionTokenApi).not.toHaveBeenCalled();
    expect(harness.clearUserInfo).not.toHaveBeenCalled();
    expect(harness.clearActiveInstitutionId).not.toHaveBeenCalled();
    expect(harness.clearPersistedQueryCache).not.toHaveBeenCalled();
    expect(harness.queryClient.clear).not.toHaveBeenCalled();
    expect(harness.setLastPushToken).not.toHaveBeenCalled();
    expect(harness.setUser).not.toHaveBeenCalledWith(null);
    expect(harness.setBadgeCountAsync).not.toHaveBeenCalled();
    expect(harness.dismissAllNotificationsAsync).not.toHaveBeenCalled();
    expect(harness.cancelAllScheduledNotificationsAsync).not.toHaveBeenCalled();
    expect(harness.clearLastNotificationResponse).not.toHaveBeenCalled();
    expect(harness.setIsLoading).toHaveBeenCalledWith(false);
    expect(harness.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "UNAVAILABLE" }),
    );
    expect(consoleError).toHaveBeenCalled();
  });

  it("/me 401 só limpa notificações depois do logout tipado confirmado", async () => {
    const harness = await renderRealAuthProvider({
      meRequest: async () => ({
        user: null,
        sessionInvalid: true,
        networkOrServerError: false,
      }),
    });

    await expect(harness.auth.refetch()).resolves.toBeUndefined();

    expect(harness.revokeSessionTokenApi).toHaveBeenCalledWith("token-A");
    expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
    expect(harness.setBadgeCountAsync).toHaveBeenCalledWith(0);
    expect(harness.dismissAllNotificationsAsync).toHaveBeenCalledTimes(1);
    expect(harness.cancelAllScheduledNotificationsAsync).toHaveBeenCalledTimes(
      1,
    );
    expect(harness.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
  });

  it("logout HTTP 500 mantém transporte revoke-only e não reabre por /me", async () => {
    const networkError = new Error("rede indisponível");
    const harness = await renderRealAuthProvider({
      revokeTokenRequest: async () => {
        throw networkError;
      },
      revalidateTokenRequest: async () => ({
        user: userA,
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });

    const error = await harness.auth.logout().catch((caught) => caught);

    expect(error).toMatchObject({
      name: "SessionTerminationNotDurableError",
      reason: networkError,
    });
    expect(harness.openPushRegistrationAdmission).not.toHaveBeenCalled();
    expect(harness.setPushRegistrationRevision).not.toHaveBeenCalled();
    expect(harness.resumeQueryCachePersistence).not.toHaveBeenCalled();
    expect(harness.revalidateSessionTokenApi).not.toHaveBeenCalled();
    expect(harness.meDetailedApi).not.toHaveBeenCalled();
    expect(harness.removeSessionToken).not.toHaveBeenCalled();
    expect(harness.queryClient.clear).not.toHaveBeenCalled();
    expect(harness.setBadgeCountAsync).not.toHaveBeenCalled();
    expect(harness.dismissAllNotificationsAsync).not.toHaveBeenCalled();
    expect(harness.cancelAllScheduledNotificationsAsync).not.toHaveBeenCalled();
    expect(harness.clearLastNotificationResponse).not.toHaveBeenCalled();
    expect(harness.setUserInfo).not.toHaveBeenCalled();
    expect(harness.setUser).not.toHaveBeenCalledWith(null);
    expect(harness.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "UNAVAILABLE" }),
    );
  });

  it("resposta perdida nunca usa /me 401 e repete o logout tipado", async () => {
    let revokeCalls = 0;
    const harness = await renderRealAuthProvider({
      revokeTokenRequest: async () => {
        revokeCalls += 1;
        if (revokeCalls === 1) throw new Error("ACK do logout perdido");
      },
      revalidateTokenRequest: async () => ({
        user: null,
        sessionInvalid: true,
        networkOrServerError: false,
      }),
    });

    await expect(harness.auth.logout()).rejects.toMatchObject({
      name: "SessionTerminationNotDurableError",
    });

    expect(harness.revalidateSessionTokenApi).not.toHaveBeenCalled();
    expect(harness.removeSessionToken).not.toHaveBeenCalled();
    expect(harness.revokeSessionTokenApi).toHaveBeenCalledTimes(1);

    await expect(harness.auth.logout()).resolves.toBeUndefined();

    expect(harness.revokeSessionTokenApi).toHaveBeenCalledTimes(2);
    expect(harness.revokePreparedSessionToken).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "token-A",
        phase: "PENDING",
        expectedUserId: userA.id,
      }),
    );
    expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
    expect(harness.setUser).toHaveBeenLastCalledWith(null);
    expect(harness.openPushRegistrationAdmission).not.toHaveBeenCalled();
    expect(harness.meDetailedApi).not.toHaveBeenCalled();
  });

  it("logout ambíguo permanece PENDING e o retry revoga B explicitamente antes da limpeza", async () => {
    let revokeCalls = 0;
    const harness = await renderRealAuthProvider({
      revokeTokenRequest: async () => {
        revokeCalls += 1;
        if (revokeCalls === 1) throw new Error("500 ambíguo");
      },
      revalidateTokenRequest: async () => ({
        user: null,
        sessionInvalid: false,
        networkOrServerError: true,
      }),
    });

    await expect(harness.auth.logout()).rejects.toMatchObject({
      name: "SessionTerminationNotDurableError",
    });
    expect(harness.removeSessionToken).not.toHaveBeenCalled();
    expect(harness.openPushRegistrationAdmission).not.toHaveBeenCalled();

    await expect(harness.auth.logout()).resolves.toBeUndefined();
    expect(harness.revokeSessionTokenApi).toHaveBeenNthCalledWith(1, "token-A");
    expect(harness.revokeSessionTokenApi).toHaveBeenNthCalledWith(2, "token-A");
    expect(harness.logoutApi).not.toHaveBeenCalled();
    expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
    expect(harness.setUser).toHaveBeenLastCalledWith(null);
  });

  it("cold start nativo offline não publica o usuário persistido sem prova do servidor", async () => {
    const consoleWarn = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const harness = await renderRealAuthProvider({
      initialUser: null,
      runMountEffects: true,
      admittedSessionUserId: () => userB.id,
      admittedSessionToken: () => "token-B",
      meRequest: async () => ({
        user: null,
        sessionInvalid: false,
        networkOrServerError: true,
      }),
    });

    await vi.waitFor(() =>
      expect(harness.setIsLoading).toHaveBeenCalledWith(false),
    );

    expect(harness.setUserInfo).not.toHaveBeenCalled();
    expect(harness.setUser).not.toHaveBeenCalled();
    expect(harness.closeSessionTokenTransportAdmission).toHaveBeenCalled();
    expect(harness.admitSessionTokenTransport).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledWith(
      "[Auth] me() falhou por rede/servidor — sessão não revalidada",
    );
    expect(harness.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "UNAVAILABLE",
        durableSession: true,
      }),
    );
  });

  it("login nativo com /me indisponível após commit não publica usuário e marca admissão pendente", async () => {
    const harness = await renderRealAuthProvider({
      initialUser: null,
      loginRequest: async () => ({
        ok: true,
        user: userB,
        token: "token-B",
      }),
      meRequest: async () => ({
        user: null,
        sessionInvalid: false,
        networkOrServerError: true,
      }),
    });

    await expect(harness.auth.login(userB.email, "senha-B")).resolves.toEqual({
      ok: false,
      error:
        "O login foi recebido, mas a sessão ainda não pôde ser revalidada.",
      admissionPending: true,
    });
    expect(harness.commitStagedSessionToken).toHaveBeenCalledTimes(1);
    expect(harness.setUser).not.toHaveBeenCalledWith(userB);
    expect(harness.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "UNAVAILABLE",
        durableSession: true,
      }),
    );
  });

  it("rollback nativo pós-ACK limpa notificações antes de devolver o erro local", async () => {
    const storageError = new Error("SecureStore indisponível no stage");
    const harness = await renderRealAuthProvider({
      initialUser: null,
      loginRequest: async () => ({
        ok: true,
        user: userB,
        token: "token-B",
      }),
      persistSessionToken: async () => {
        throw storageError;
      },
    });

    await expect(harness.auth.login(userB.email, "senha-B")).resolves.toEqual({
      ok: false,
      error: "Não foi possível concluir o login com segurança neste aparelho.",
    });

    expect(harness.revokeSessionTokenApi).toHaveBeenCalledWith("token-B");
    expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
    expect(harness.setBadgeCountAsync).toHaveBeenCalledWith(0);
    expect(harness.dismissAllNotificationsAsync).toHaveBeenCalledTimes(1);
    expect(harness.cancelAllScheduledNotificationsAsync).toHaveBeenCalledTimes(
      1,
    );
    expect(harness.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
  });

  it("rollback nativo sem ACK preserva a quarentena e não toca notificações", async () => {
    const harness = await renderRealAuthProvider({
      initialUser: null,
      loginRequest: async () => ({
        ok: true,
        user: userB,
        token: "token-B",
      }),
      persistSessionToken: async () => {
        throw new Error("SecureStore indisponível no stage");
      },
      revokeTokenRequest: async () => {
        throw new Error("500 ao revogar B");
      },
    });

    await expect(harness.auth.login(userB.email, "senha-B")).resolves.toEqual({
      ok: false,
      error:
        "Login bloqueado: o servidor ainda não confirmou a revogação desta sessão.",
    });

    expect(harness.revokeSessionTokenApi).toHaveBeenCalledWith("token-B");
    expect(harness.removeSessionToken).not.toHaveBeenCalled();
    expect(harness.setBadgeCountAsync).not.toHaveBeenCalled();
    expect(harness.dismissAllNotificationsAsync).not.toHaveBeenCalled();
    expect(harness.cancelAllScheduledNotificationsAsync).not.toHaveBeenCalled();
    expect(harness.clearLastNotificationResponse).not.toHaveBeenCalled();
  });

  it("/me pendente mantém receipt CHECKING e zero identidade publicada", async () => {
    const me = deferred<MeResult>();
    const harness = await renderRealAuthProvider({
      initialUser: null,
      runMountEffects: true,
      admittedSessionUserId: () => userB.id,
      admittedSessionToken: () => "token-B",
      meRequest: () => me.promise,
    });

    await vi.waitFor(() =>
      expect(harness.meDetailedApi).toHaveBeenCalledTimes(1),
    );
    expect(harness.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "CHECKING", durableSession: true }),
    );
    expect(harness.setUserInfo).not.toHaveBeenCalled();
    expect(harness.setUser).not.toHaveBeenCalled();

    me.resolve({
      user: { ...userB, approvalStatus: "APPROVED", mustChangePassword: false },
      sessionInvalid: false,
      networkOrServerError: false,
    });
    await vi.waitFor(() =>
      expect(harness.setSessionValidation).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: "VERIFIED", userId: userB.id }),
      ),
    );
    expect(harness.admitSessionTokenTransport).toHaveBeenCalledWith(
      expect.any(Object),
    );
  });

  it("cold start não publica /me validado se a identidade não puder ser persistida", async () => {
    const storageError = new Error("AsyncStorage indisponível");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const harness = await renderRealAuthProvider({
      initialUser: null,
      runMountEffects: true,
      admittedSessionUserId: () => userB.id,
      meRequest: async () => ({
        user: userB,
        sessionInvalid: false,
        networkOrServerError: false,
      }),
      persistUser: async () => {
        throw storageError;
      },
    });

    await vi.waitFor(() =>
      expect(harness.setIsLoading).toHaveBeenCalledWith(false),
    );

    expect(harness.setUserInfo).toHaveBeenCalledWith(userB);
    expect(harness.setUser).not.toHaveBeenCalled();
  });

  it("cold start publica a identidade somente depois de persistir um /me válido", async () => {
    const harness = await renderRealAuthProvider({
      initialUser: null,
      runMountEffects: true,
      admittedSessionUserId: () => userB.id,
      meRequest: async () => ({
        user: userB,
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });

    await vi.waitFor(() => expect(harness.setUser).toHaveBeenCalledWith(userB));

    expect(harness.setUserInfo).toHaveBeenCalledTimes(1);
    expect(harness.setUserInfo).toHaveBeenCalledWith(userB);
    expect(harness.setIsLoading).toHaveBeenCalledWith(false);
  });

  it("login não emite receipt VERIFIED enquanto o /me canônico está pendente", async () => {
    const me = deferred<MeResult>();
    const harness = await renderRealAuthProvider({
      loginRequest: async () => ({ ok: true, user: userB, token: "token-B" }),
      meRequest: () => me.promise,
    });
    let settled = false;

    const login = harness.auth.login(userB.email, "senha-B").then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() =>
      expect(harness.meDetailedApi).toHaveBeenCalledTimes(1),
    );

    expect(settled).toBe(false);
    expect(harness.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "CHECKING" }),
    );
    expect(harness.setSessionValidation.mock.calls).not.toContainEqual([
      expect.objectContaining({ status: "VERIFIED" }),
    ]);
    expect(harness.setUser).not.toHaveBeenCalledWith(userB);

    me.resolve({
      user: { ...userB, approvalStatus: "APPROVED", mustChangePassword: false },
      sessionInvalid: false,
      networkOrServerError: false,
    });
    await expect(login).resolves.toEqual({ ok: true });
    expect(harness.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "VERIFIED", userId: userB.id }),
    );
  });

  it("serializa dois logins e só publica a identidade da intenção mais recente", async () => {
    const loginA = deferred<LoginResult>();
    const loginB = deferred<LoginResult>();
    const harness = await renderRealAuthProvider({
      loginRequest: (email) =>
        email === userA.email ? loginA.promise : loginB.promise,
      meRequest: async () => ({
        user: userB,
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });

    const resultA = harness.auth.login(userA.email, "senha-A");
    await vi.waitFor(() => expect(harness.loginApi).toHaveBeenCalledTimes(1));
    const resultB = harness.auth.login(userB.email, "senha-B");
    expect(harness.loginApi).toHaveBeenCalledTimes(1);

    loginA.resolve({ ok: true, user: userA, token: "token-A" });
    await expect(resultA).resolves.toEqual({
      ok: false,
      error:
        "O login foi recebido, mas a sessão ainda não pôde ser revalidada.",
    });
    await vi.waitFor(() => expect(harness.loginApi).toHaveBeenCalledTimes(2));
    loginB.resolve({ ok: true, user: userB, token: "token-B" });
    await expect(resultB).resolves.toEqual({ ok: true });

    expect(harness.setSessionToken.mock.calls).toEqual([
      ["token-A", userA.id],
      ["token-B", userB.id],
    ]);
    expect(harness.commitStagedSessionToken).toHaveBeenCalledTimes(2);
    expect(harness.setUser).not.toHaveBeenCalledWith(userA);
    expect(harness.setUser).toHaveBeenLastCalledWith(userB);
    expect(harness.revokeSessionTokenApi.mock.calls).toEqual([
      ["token-A"],
      ["token-A"],
    ]);
  });

  it("refetch solicitado durante login espera END e só valida o Bearer final", async () => {
    const loginResponse = deferred<LoginResult>();
    const harness = await renderRealAuthProvider({
      loginRequest: () => loginResponse.promise,
      meRequest: async () => ({
        user: userB,
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });

    const login = harness.auth.login(userB.email, "senha-B");
    await vi.waitFor(() => expect(harness.loginApi).toHaveBeenCalledTimes(1));
    const queuedRefetch = harness.auth.refetch();
    expect(harness.meDetailedApi).not.toHaveBeenCalled();

    loginResponse.resolve({ ok: true, user: userB, token: "token-B" });
    await expect(login).resolves.toEqual({ ok: true });
    await queuedRefetch;

    expect(harness.meDetailedApi).toHaveBeenCalledTimes(2);
    expect(harness.setUser.mock.calls).toEqual([
      [null],
      [null],
      [userB],
      [userB],
    ]);
    expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
  });

  it("refetch solicitado durante rotação não inicia /me antes do END", async () => {
    const remoteRotation = deferred<{
      ok: boolean;
      token?: string;
      error?: string;
    }>();
    const harness = await renderRealAuthProvider({
      meRequest: async () => ({
        user: userA,
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });

    const rotation = harness.auth.rotateSession(() => remoteRotation.promise);
    await vi.waitFor(() =>
      expect(harness.clearPushRegistrationState).toHaveBeenCalledTimes(1),
    );
    const queuedRefetch = harness.auth.refetch();
    expect(harness.meDetailedApi).not.toHaveBeenCalled();

    remoteRotation.resolve({ ok: true, token: "token-B" });
    await expect(rotation).resolves.toEqual({ ok: true });
    await queuedRefetch;

    expect(harness.meDetailedApi).toHaveBeenCalledTimes(2);
    expect(harness.setSessionToken).toHaveBeenCalledWith("token-B", userA.id);
    expect(harness.removeSessionToken).not.toHaveBeenCalled();
  });

  it("refetch solicitado durante logout só observa o transporte pós-END", async () => {
    const remoteLogout = deferred<void>();
    const harness = await renderRealAuthProvider({
      revokeTokenRequest: () => remoteLogout.promise,
      meRequest: async () => ({
        user: null,
        sessionInvalid: true,
        networkOrServerError: false,
      }),
    });

    const logout = harness.auth.logout();
    await vi.waitFor(() =>
      expect(harness.revokeSessionTokenApi).toHaveBeenCalledTimes(1),
    );
    const queuedRefetch = harness.auth.refetch();
    expect(harness.meDetailedApi).not.toHaveBeenCalled();

    remoteLogout.resolve();
    await expect(logout).resolves.toBeUndefined();
    await queuedRefetch;

    expect(harness.meDetailedApi).not.toHaveBeenCalled();
    expect(harness.setUser).toHaveBeenCalledWith(null);
  });

  it.each(staleMeResponses)(
    "remount durante login descarta %s e só consulta /me após o END final",
    async (_label, staleResponse) => {
      const staleMe = deferred<MeResult>();
      const remoteLogin = deferred<LoginResult>();
      let meCalls = 0;
      const harness = await renderRealAuthProvider({
        loginRequest: () => remoteLogin.promise,
        meRequest: () => {
          meCalls += 1;
          if (meCalls === 1) return staleMe.promise;
          return Promise.resolve({
            user: userB,
            sessionInvalid: false,
            networkOrServerError: false,
          });
        },
      });

      const staleRefetch = harness.auth.refetch();
      await vi.waitFor(() =>
        expect(harness.meDetailedApi).toHaveBeenCalledTimes(1),
      );
      const generationBeforeLogin =
        harness.appSessionEpoch.capture().generation;
      const beginTransition = vi.spyOn(
        harness.appSessionEpoch,
        "beginTransition",
      );
      const login = harness.auth.login(userB.email, "senha-B");
      await vi.waitFor(() => expect(harness.loginApi).toHaveBeenCalledTimes(1));

      const remounted = harness.remount({
        initialUser: null,
        runMountEffects: true,
      });
      staleMe.resolve(staleResponse);
      await staleRefetch;

      expect(beginTransition).toHaveBeenCalledTimes(1);
      expect(harness.meDetailedApi).toHaveBeenCalledTimes(1);
      expect(harness.setUserInfo).not.toHaveBeenCalled();
      expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
      expect(remounted.setSessionValidation).not.toHaveBeenCalled();

      remoteLogin.resolve({ ok: true, user: userB, token: "token-B" });
      await expect(login).resolves.toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(harness.meDetailedApi).toHaveBeenCalledTimes(3),
      );
      await vi.waitFor(() =>
        expect(remounted.setSessionValidation).toHaveBeenLastCalledWith(
          expect.objectContaining({ status: "VERIFIED", userId: userB.id }),
        ),
      );

      expect(beginTransition).toHaveBeenCalledTimes(2);
      expect(harness.appSessionEpoch.capture().generation).toBe(
        generationBeforeLogin + 2,
      );
      expect(harness.setUserInfo).not.toHaveBeenCalledWith(userA);
      expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
    },
  );

  it.each(staleMeResponses)(
    "remount durante rotação descarta %s e só consulta /me após o END final",
    async (_label, staleResponse) => {
      const staleMe = deferred<MeResult>();
      const remoteRotation = deferred<{
        ok: boolean;
        token?: string;
        error?: string;
      }>();
      let meCalls = 0;
      const harness = await renderRealAuthProvider({
        meRequest: () => {
          meCalls += 1;
          if (meCalls === 1) return staleMe.promise;
          return Promise.resolve({
            user: userA,
            sessionInvalid: false,
            networkOrServerError: false,
          });
        },
      });

      const staleRefetch = harness.auth.refetch();
      await vi.waitFor(() =>
        expect(harness.meDetailedApi).toHaveBeenCalledTimes(1),
      );
      const generationBeforeRotation =
        harness.appSessionEpoch.capture().generation;
      const beginTransition = vi.spyOn(
        harness.appSessionEpoch,
        "beginTransition",
      );
      const rotation = harness.auth.rotateSession(() => remoteRotation.promise);
      await vi.waitFor(() =>
        expect(harness.clearPushRegistrationState).toHaveBeenCalledTimes(1),
      );

      const remounted = harness.remount({
        initialUser: null,
        runMountEffects: true,
      });
      staleMe.resolve(staleResponse);
      await staleRefetch;

      expect(beginTransition).toHaveBeenCalledTimes(1);
      expect(harness.meDetailedApi).toHaveBeenCalledTimes(1);
      expect(harness.setUserInfo).not.toHaveBeenCalled();
      expect(harness.removeSessionToken).not.toHaveBeenCalled();
      expect(remounted.setSessionValidation).not.toHaveBeenCalled();

      remoteRotation.resolve({ ok: true, token: "token-B" });
      await expect(rotation).resolves.toEqual({ ok: true });
      await vi.waitFor(() =>
        expect(harness.meDetailedApi).toHaveBeenCalledTimes(3),
      );
      await vi.waitFor(() =>
        expect(remounted.setSessionValidation).toHaveBeenLastCalledWith(
          expect.objectContaining({ status: "VERIFIED", userId: userA.id }),
        ),
      );

      expect(beginTransition).toHaveBeenCalledTimes(2);
      expect(harness.appSessionEpoch.capture().generation).toBe(
        generationBeforeRotation + 2,
      );
      expect(harness.setUserInfo).not.toHaveBeenCalledWith(userB);
      expect(harness.removeSessionToken).not.toHaveBeenCalled();
    },
  );

  it.each(staleMeResponses)(
    "remount durante logout descarta %s e só consulta /me após o END final",
    async (_label, staleResponse) => {
      const staleMe = deferred<MeResult>();
      const remoteLogout = deferred<void>();
      let meCalls = 0;
      const harness = await renderRealAuthProvider({
        revokeTokenRequest: () => remoteLogout.promise,
        meRequest: () => {
          meCalls += 1;
          if (meCalls === 1) return staleMe.promise;
          return Promise.resolve({
            user: null,
            sessionInvalid: false,
            networkOrServerError: true,
          });
        },
      });

      const staleRefetch = harness.auth.refetch();
      await vi.waitFor(() =>
        expect(harness.meDetailedApi).toHaveBeenCalledTimes(1),
      );
      const generationBeforeLogout =
        harness.appSessionEpoch.capture().generation;
      const beginTransition = vi.spyOn(
        harness.appSessionEpoch,
        "beginTransition",
      );
      const logout = harness.auth.logout();
      await vi.waitFor(() =>
        expect(harness.revokeSessionTokenApi).toHaveBeenCalledTimes(1),
      );

      const remounted = harness.remount({
        initialUser: null,
        runMountEffects: true,
      });
      staleMe.resolve(staleResponse);
      await staleRefetch;

      expect(beginTransition).toHaveBeenCalledTimes(1);
      expect(harness.meDetailedApi).toHaveBeenCalledTimes(1);
      expect(harness.setUserInfo).not.toHaveBeenCalled();
      expect(harness.removeSessionToken).not.toHaveBeenCalled();
      expect(remounted.setSessionValidation).not.toHaveBeenCalled();

      remoteLogout.resolve();
      await expect(logout).resolves.toBeUndefined();
      expect(harness.meDetailedApi).toHaveBeenCalledTimes(1);
      await vi.waitFor(() =>
        expect(remounted.setSessionValidation).toHaveBeenLastCalledWith(
          expect.objectContaining({ status: "UNAVAILABLE" }),
        ),
      );

      expect(beginTransition).toHaveBeenCalledTimes(2);
      expect(harness.appSessionEpoch.capture().generation).toBe(
        generationBeforeLogout + 2,
      );
      expect(harness.setUserInfo).not.toHaveBeenCalled();
      expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
    },
  );

  it("logout enfileirado deixa a rotação física assentar sem republicar a sessão", async () => {
    const remoteRotation = deferred<{
      ok: boolean;
      token?: string;
      error?: string;
    }>();
    const harness = await renderRealAuthProvider({
      meRequest: async () => ({
        user: userA,
        sessionInvalid: false,
        networkOrServerError: false,
      }),
      revokeTokenRequest: async () => undefined,
    });

    const rotation = harness.auth.rotateSession(() => remoteRotation.promise);
    await vi.waitFor(() =>
      expect(harness.clearPushRegistrationState).toHaveBeenCalledTimes(1),
    );
    const logout = harness.auth.logout();
    expect(harness.revokeSessionTokenApi).not.toHaveBeenCalled();

    remoteRotation.resolve({ ok: true, token: "token-B" });
    await expect(rotation).resolves.toEqual({
      ok: false,
      error:
        "A operação foi recebida, mas a nova sessão ainda não pôde ser revalidada.",
    });
    await expect(logout).resolves.toBeUndefined();

    expect(harness.revokeSessionTokenApi).toHaveBeenCalledTimes(1);
    expect(
      harness.commitStagedSessionToken.mock.invocationCallOrder[0],
    ).toBeLessThan(harness.revokeSessionTokenApi.mock.invocationCallOrder[0]);
    expect(harness.setUser).toHaveBeenLastCalledWith(null);
  });

  it("exceção de mutação ainda executa exatamente os bumps BEGIN e END", async () => {
    const failure = new Error("resposta perdida");
    const harness = await renderRealAuthProvider({
      meRequest: async () => ({
        user: null,
        sessionInvalid: false,
        networkOrServerError: true,
      }),
    });
    const before = harness.appSessionEpoch.capture().generation;
    const beginTransition = vi.spyOn(
      harness.appSessionEpoch,
      "beginTransition",
    );

    await expect(
      harness.auth.rotateSession(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(beginTransition).toHaveBeenCalledTimes(2);
    expect(harness.appSessionEpoch.capture().generation).toBe(before + 2);
    expect(harness.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "UNAVAILABLE" }),
    );
  });

  it("/me 200 de A tardio após logout e login B é descartado antes de persistir", async () => {
    const meA = deferred<MeResult>();
    const meB = deferred<MeResult>();
    let meCalls = 0;
    const harness = await renderRealAuthProvider({
      meRequest: () => (++meCalls === 1 ? meA.promise : meB.promise),
      loginRequest: async () => ({ ok: true, user: userB, token: "token-B" }),
    });
    const runIfCurrent = vi.spyOn(harness.appSessionEpoch, "runIfCurrent");

    const staleRefetch = harness.auth.refetch();
    await vi.waitFor(() =>
      expect(harness.meDetailedApi).toHaveBeenCalledTimes(1),
    );
    await harness.auth.logout();
    const loginB = harness.auth.login(userB.email, "senha-B");
    await vi.waitFor(() =>
      expect(harness.meDetailedApi).toHaveBeenCalledTimes(2),
    );
    meB.resolve({
      user: userB,
      sessionInvalid: false,
      networkOrServerError: false,
    });
    await expect(loginB).resolves.toEqual({ ok: true });
    const callsBeforeStaleResponse = runIfCurrent.mock.calls.length;
    const loadingCallsBeforeStaleResponse =
      harness.setIsLoading.mock.calls.length;

    meA.resolve({
      user: userA,
      sessionInvalid: false,
      networkOrServerError: false,
    });
    await staleRefetch;

    expect(runIfCurrent).toHaveBeenCalledTimes(callsBeforeStaleResponse);
    expect(harness.setIsLoading).toHaveBeenCalledTimes(
      loadingCallsBeforeStaleResponse,
    );
    expect(harness.setUserInfo.mock.calls).toEqual([[userB], [userB]]);
    expect(harness.setUser.mock.calls).toEqual([[null], [null], [userB]]);
  });

  it("/me 401 de A tardio após logout e login B não inicia nova limpeza", async () => {
    const meA = deferred<MeResult>();
    const meB = deferred<MeResult>();
    let meCalls = 0;
    const harness = await renderRealAuthProvider({
      meRequest: () => (++meCalls === 1 ? meA.promise : meB.promise),
      loginRequest: async () => ({ ok: true, user: userB, token: "token-B" }),
    });
    const beginTransitionIfCurrent = vi.spyOn(
      harness.appSessionEpoch,
      "beginTransitionIfCurrent",
    );

    const staleRefetch = harness.auth.refetch();
    await vi.waitFor(() =>
      expect(harness.meDetailedApi).toHaveBeenCalledTimes(1),
    );
    await harness.auth.logout();
    const loginB = harness.auth.login(userB.email, "senha-B");
    await vi.waitFor(() =>
      expect(harness.meDetailedApi).toHaveBeenCalledTimes(2),
    );
    meB.resolve({
      user: userB,
      sessionInvalid: false,
      networkOrServerError: false,
    });
    await expect(loginB).resolves.toEqual({ ok: true });
    const cleanupAttemptsBeforeStaleResponse =
      beginTransitionIfCurrent.mock.calls.length;
    const tokenRemovalsBeforeStaleResponse =
      harness.removeSessionToken.mock.calls.length;
    const loadingCallsBeforeStaleResponse =
      harness.setIsLoading.mock.calls.length;

    meA.resolve({
      user: null,
      sessionInvalid: true,
      networkOrServerError: false,
    });
    await staleRefetch;

    expect(beginTransitionIfCurrent).toHaveBeenCalledTimes(
      cleanupAttemptsBeforeStaleResponse,
    );
    expect(harness.removeSessionToken).toHaveBeenCalledTimes(
      tokenRemovalsBeforeStaleResponse,
    );
    expect(harness.setIsLoading).toHaveBeenCalledTimes(
      loadingCallsBeforeStaleResponse,
    );
    expect(harness.setUser.mock.calls).toEqual([[null], [null], [userB]]);
    expect(harness.setSessionToken).toHaveBeenLastCalledWith(
      "token-B",
      userB.id,
    );
  });

  it("/me 401 do token antigo não apaga a sessão B rotacionada", async () => {
    const meA = deferred<MeResult>();
    const meB = deferred<MeResult>();
    let meCalls = 0;
    const harness = await renderRealAuthProvider({
      meRequest: () => (++meCalls === 1 ? meA.promise : meB.promise),
    });
    const beginTransitionIfCurrent = vi.spyOn(
      harness.appSessionEpoch,
      "beginTransitionIfCurrent",
    );

    const staleRefetch = harness.auth.refetch();
    await vi.waitFor(() =>
      expect(harness.meDetailedApi).toHaveBeenCalledTimes(1),
    );
    const rotation = harness.auth.rotateSession(async () => ({
      ok: true,
      token: "token-B",
    }));
    await vi.waitFor(() =>
      expect(harness.meDetailedApi).toHaveBeenCalledTimes(2),
    );
    meB.resolve({
      user: userA,
      sessionInvalid: false,
      networkOrServerError: false,
    });
    await expect(rotation).resolves.toEqual({ ok: true });
    const loadingCallsBeforeStaleResponse =
      harness.setIsLoading.mock.calls.length;

    meA.resolve({
      user: null,
      sessionInvalid: true,
      networkOrServerError: false,
    });
    await staleRefetch;

    expect(beginTransitionIfCurrent).not.toHaveBeenCalled();
    expect(harness.setSessionToken.mock.calls).toEqual([["token-B", userA.id]]);
    expect(harness.removeSessionToken).not.toHaveBeenCalled();
    expect(harness.clearUserInfo).not.toHaveBeenCalled();
    expect(harness.clearPersistedQueryCache).not.toHaveBeenCalled();
    expect(harness.setUser).not.toHaveBeenCalledWith(null);
    expect(harness.setIsLoading).toHaveBeenCalledTimes(
      loadingCallsBeforeStaleResponse,
    );
    expect(harness.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "VERIFIED", userId: userA.id }),
    );
  });

  it("preflight nativo mantém A em quarentena e bloqueia o POST quando revoke 500", async () => {
    let revokeAvailable = false;
    let markerActive = true;
    const harness = await renderRealAuthProvider({
      initialUser: userA,
      loginRequest: async () => ({ ok: true, user: userB, token: "token-B" }),
      sessionTokenQuarantined: () => markerActive,
      quarantinedSessionToken: () => (markerActive ? "token-A" : null),
      revokeTokenRequest: async () => {
        if (!revokeAvailable) throw new Error("500 ambíguo ao revogar A");
      },
      removeSessionToken: async () => {
        markerActive = false;
      },
      meRequest: async () => ({
        user: userB,
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });

    const blockedResult = {
      ok: false,
      error: "Login bloqueado: a sessão anterior ainda exige revogação.",
    };
    await expect(harness.auth.login(userB.email, "senha-B")).resolves.toEqual(
      blockedResult,
    );
    await expect(harness.auth.login(userB.email, "senha-B")).resolves.toEqual(
      blockedResult,
    );
    expect(harness.revokeSessionTokenApi.mock.calls).toEqual([
      ["token-A"],
      ["token-A"],
    ]);
    expect(harness.loginApi).not.toHaveBeenCalled();
    expect(harness.removeSessionToken).not.toHaveBeenCalled();
    expect(harness.setBadgeCountAsync).not.toHaveBeenCalled();
    expect(harness.dismissAllNotificationsAsync).not.toHaveBeenCalled();
    expect(harness.cancelAllScheduledNotificationsAsync).not.toHaveBeenCalled();
    expect(harness.clearLastNotificationResponse).not.toHaveBeenCalled();

    revokeAvailable = true;
    await expect(harness.auth.login(userB.email, "senha-B")).resolves.toEqual({
      ok: true,
    });

    expect(harness.revokeSessionTokenApi).toHaveBeenNthCalledWith(3, "token-A");
    expect(harness.loginApi).toHaveBeenCalledTimes(1);
    expect(harness.setSessionToken).toHaveBeenCalledWith("token-B", userB.id);
    expect(harness.setUser).not.toHaveBeenCalledWith(userA);
    expect(harness.setUser).toHaveBeenCalledWith(userB);
    expect(harness.setBadgeCountAsync).toHaveBeenCalledWith(0);
    expect(harness.dismissAllNotificationsAsync).toHaveBeenCalledTimes(1);
    expect(harness.cancelAllScheduledNotificationsAsync).toHaveBeenCalledTimes(
      1,
    );
    expect(harness.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
  });

  it("commit B ambíguo só conclui login após /me fresco do mesmo usuário", async () => {
    const ambiguousCommit = Object.assign(new Error("ACK do commit perdido"), {
      code: "SESSION_TOKEN_COMMIT_AMBIGUOUS",
    });
    let commitAttempted = false;
    const harness = await renderRealAuthProvider({
      initialUser: null,
      loginRequest: async () => ({ ok: true, user: userB, token: "token-B" }),
      commitSessionToken: async () => {
        commitAttempted = true;
        throw ambiguousCommit;
      },
      admittedSessionUserId: () => (commitAttempted ? userB.id : null),
      admittedSessionToken: () => (commitAttempted ? "token-B" : null),
      meRequest: async () => ({
        user: userB,
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });

    await expect(harness.auth.login(userB.email, "senha-B")).resolves.toEqual({
      ok: true,
    });

    expect(harness.commitStagedSessionToken).toHaveBeenCalledTimes(1);
    expect(harness.meDetailedApi).toHaveBeenCalledTimes(1);
    expect(harness.revokeSessionTokenApi).not.toHaveBeenCalled();
    expect(harness.setUser.mock.calls).toEqual([[null], [null], [userB]]);
    expect(harness.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "VERIFIED", userId: userB.id }),
    );
  });

  it("commit ambíguo não aceita /me de outro usuário nem republica A", async () => {
    let commitAttempted = false;
    const harness = await renderRealAuthProvider({
      initialUser: null,
      loginRequest: async () => ({ ok: true, user: userB, token: "token-B" }),
      commitSessionToken: async () => {
        commitAttempted = true;
        throw Object.assign(new Error("commit incerto"), {
          code: "SESSION_TOKEN_COMMIT_AMBIGUOUS",
        });
      },
      admittedSessionUserId: () => (commitAttempted ? userB.id : null),
      admittedSessionToken: () => (commitAttempted ? "token-B" : null),
      meRequest: async () => ({
        user: null,
        sessionInvalid: false,
        networkOrServerError: false,
        code: "EXPECTED_USER_MISMATCH",
      }),
    });

    await expect(harness.auth.login(userB.email, "senha-B")).resolves.toEqual({
      ok: false,
      error: "A sessão ambígua foi encerrada com segurança.",
    });

    expect(harness.meDetailedApi).toHaveBeenCalledTimes(1);
    expect(harness.setUser).not.toHaveBeenCalledWith(userA);
    expect(harness.setUser).not.toHaveBeenCalledWith(userB);
    expect(harness.revokeSessionTokenApi).toHaveBeenCalledWith("token-B");
    expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
    expect(harness.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "UNAVAILABLE" }),
    );
  });

  it("mismatch B para A com revoke 500 preserva binding B e o remount repete a revogação", async () => {
    let commitAttempted = false;
    let revokeAvailable = false;
    const harness = await renderRealAuthProvider({
      initialUser: null,
      loginRequest: async () => ({ ok: true, user: userB, token: "token-B" }),
      commitSessionToken: async () => {
        commitAttempted = true;
        throw Object.assign(new Error("ACK do commit perdido"), {
          code: "SESSION_TOKEN_COMMIT_AMBIGUOUS",
        });
      },
      admittedSessionUserId: () => (commitAttempted ? userB.id : null),
      admittedSessionToken: () => (commitAttempted ? "token-B" : null),
      revokeTokenRequest: async (token) => {
        expect(token).toBe("token-B");
        if (!revokeAvailable) throw new Error("500 ao revogar B");
      },
      meRequest: async () => ({
        user: null,
        sessionInvalid: false,
        networkOrServerError: false,
        code: "EXPECTED_USER_MISMATCH",
      }),
    });

    await expect(harness.auth.login(userB.email, "senha-B")).resolves.toEqual({
      ok: false,
      error:
        "Não foi possível confirmar a sessão local; a revalidação permanece bloqueada.",
      admissionPending: true,
    });
    expect(harness.revokeSessionTokenApi).toHaveBeenCalledTimes(1);
    expect(harness.prepareSessionTokenRevocation).toHaveBeenCalledWith(
      undefined,
      undefined,
    );
    expect(harness.removeSessionToken).not.toHaveBeenCalled();
    expect(harness.setUser).not.toHaveBeenCalledWith(userA);
    expect(harness.setUser).not.toHaveBeenCalledWith(userB);

    revokeAvailable = true;
    const restarted = harness.remount({
      initialUser: null,
      runMountEffects: true,
    });
    await vi.waitFor(() =>
      expect(harness.revokeSessionTokenApi).toHaveBeenCalledTimes(2),
    );

    expect(harness.revokeSessionTokenApi.mock.calls).toEqual([
      ["token-B"],
      ["token-B"],
    ]);
    // O remount encontra PENDING e revoga antes de qualquer nova /me.
    expect(harness.meDetailedApi).toHaveBeenCalledTimes(1);
    expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
    expect(restarted.setUser).toHaveBeenCalledWith(null);
    expect(restarted.setUser).not.toHaveBeenCalledWith(userA);
    expect(restarted.setUser).not.toHaveBeenCalledWith(userB);
  });

  it("raw-only com ALREADY_INVALID sem userId usa binding físico e não fabrica identidade", async () => {
    const harness = await renderRealAuthProvider({
      initialUser: null,
      sessionTokenQuarantined: () => true,
      quarantinedSessionToken: () => "legacy-token-A",
      revokeTokenRequest: async () => ({
        status: "ALREADY_INVALID",
        revocationUserId: null,
      }),
    });

    await expect(harness.auth.refetch()).resolves.toBeUndefined();

    expect(harness.revokeSessionTokenApi).toHaveBeenCalledWith(
      "legacy-token-A",
    );
    expect(harness.revokePreparedSessionToken).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "legacy-token-A",
        phase: "LEGACY",
        fingerprint: "a".repeat(64),
        nonce: "1".repeat(32),
      }),
    );
    expect(
      harness.revokePreparedSessionToken.mock.calls[0]?.[0],
    ).not.toHaveProperty("expectedUserId");
    expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
    expect(harness.meDetailedApi).not.toHaveBeenCalled();
    expect(harness.setUser).toHaveBeenCalledWith(null);
    expect(harness.setBadgeCountAsync).toHaveBeenCalledWith(0);
    expect(harness.dismissAllNotificationsAsync).toHaveBeenCalledTimes(1);
    expect(harness.cancelAllScheduledNotificationsAsync).toHaveBeenCalledTimes(
      1,
    );
    expect(harness.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
  });

  it("ROTATED sem userId não usa expectedUserId local do PENDING nem remove o raw", async () => {
    const harness = await renderRealAuthProvider({
      sessionTokenQuarantined: () => true,
      quarantinedSessionToken: () => "legacy-token-A",
      revokeTokenRequest: async () => ({
        status: "ROTATED",
        revocationUserId: null,
      }),
    });

    await expect(harness.auth.refetch()).resolves.toBeUndefined();

    expect(harness.revokeSessionTokenApi).toHaveBeenCalledWith(
      "legacy-token-A",
    );
    expect(harness.revokePreparedSessionToken).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "legacy-token-A",
        phase: "PENDING",
        expectedUserId: userA.id,
      }),
    );
    expect(harness.removeSessionToken).not.toHaveBeenCalled();
    expect(harness.meDetailedApi).not.toHaveBeenCalled();
    expect(harness.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "UNAVAILABLE" }),
    );
  });

  it("dois refetch concorrentes compartilham uma única revogação PENDING", async () => {
    const remoteRevocation = deferred<void>();
    const harness = await renderRealAuthProvider({
      initialUser: null,
      sessionTokenQuarantined: () => true,
      quarantinedSessionToken: () => "token-B",
      revokeTokenRequest: () => remoteRevocation.promise,
    });

    const first = harness.auth.refetch();
    await vi.waitFor(() => {
      expect(harness.revokeSessionTokenApi).toHaveBeenCalledTimes(1);
    });
    const second = harness.auth.refetch();
    await vi.waitFor(() => {
      expect(harness.prepareSessionTokenRevocation).toHaveBeenCalledTimes(1);
      expect(harness.revokeSessionTokenApi).toHaveBeenCalledTimes(1);
    });
    expect(harness.meDetailedApi).not.toHaveBeenCalled();

    remoteRevocation.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);

    expect(harness.revokeSessionTokenApi.mock.calls).toEqual([["token-B"]]);
    expect(harness.clearPushRegistrationState).toHaveBeenCalledTimes(1);
    expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
    expect(harness.meDetailedApi).not.toHaveBeenCalled();
  });

  it("login em nova epoch herda o ACK 2xx da revogação já em voo", async () => {
    const remoteRevocation = deferred<void>();
    let pending = true;
    const harness = await renderRealAuthProvider({
      initialUser: null,
      sessionTokenQuarantined: () => pending,
      quarantinedSessionToken: () => (pending ? "token-B" : null),
      removeSessionToken: async () => {
        pending = false;
      },
      revokeTokenRequest: () => remoteRevocation.promise,
      loginRequest: async () => ({ ok: false, error: "Credenciais inválidas" }),
    });

    const staleRefetch = harness.auth.refetch();
    await vi.waitFor(() => {
      expect(harness.revokeSessionTokenApi).toHaveBeenCalledTimes(1);
    });
    const login = harness.auth.login(userA.email, "senha-incorreta");
    expect(harness.loginApi).not.toHaveBeenCalled();

    remoteRevocation.resolve();
    await expect(staleRefetch).resolves.toBeUndefined();
    await expect(login).resolves.toEqual({
      ok: false,
      error: "Credenciais inválidas",
    });

    expect(harness.revokeSessionTokenApi.mock.calls).toEqual([["token-B"]]);
    expect(harness.loginApi).toHaveBeenCalledTimes(1);
    expect(harness.clearPushRegistrationState).toHaveBeenCalled();
    expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
  });

  it("refetch que fica stale durante leitura do gate não cria revogação após BEGIN do logout", async () => {
    const quarantineRead = deferred<boolean>();
    const remoteRevocation = deferred<void>();
    const harness = await renderRealAuthProvider({
      sessionTokenQuarantined: () => quarantineRead.promise,
      revokeTokenRequest: () => remoteRevocation.promise,
    });

    const staleRefetch = harness.auth.refetch();
    const logout = harness.auth.logout();
    await vi.waitFor(() =>
      expect(harness.revokeSessionTokenApi).toHaveBeenCalledTimes(1),
    );

    quarantineRead.resolve(true);
    await staleRefetch;
    expect(harness.revokeSessionTokenApi).toHaveBeenCalledTimes(1);

    remoteRevocation.resolve();
    await expect(logout).resolves.toBeUndefined();
    expect(harness.logoutApi).not.toHaveBeenCalled();
    expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
  });

  it("logout em nova epoch junta a revogação explícita sem segundo POST", async () => {
    const remoteRevocation = deferred<void>();
    const harness = await renderRealAuthProvider({
      initialUser: null,
      sessionTokenQuarantined: () => true,
      quarantinedSessionToken: () => "token-B",
      revokeTokenRequest: () => remoteRevocation.promise,
    });

    const staleRefetch = harness.auth.refetch();
    await vi.waitFor(() => {
      expect(harness.revokeSessionTokenApi).toHaveBeenCalledTimes(1);
    });
    const logout = harness.auth.logout();
    expect(harness.logoutApi).not.toHaveBeenCalled();

    remoteRevocation.resolve();
    await expect(Promise.all([staleRefetch, logout])).resolves.toEqual([
      undefined,
      undefined,
    ]);

    expect(harness.revokeSessionTokenApi.mock.calls).toEqual([["token-B"]]);
    expect(harness.logoutApi).not.toHaveBeenCalled();
    expect(harness.clearPushRegistrationState).toHaveBeenCalledTimes(1);
    expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
    expect(harness.setUser).toHaveBeenCalledWith(null);
  });

  it("reconciliação UNAVAILABLE bloqueia rotação enfileirada por provider remontado", async () => {
    const firstRotation = deferred<{
      ok: boolean;
      token?: string;
      error?: string;
    }>();
    const secondOperation = vi.fn(async () => ({ ok: true, token: "token-C" }));
    const harness = await renderRealAuthProvider({
      initialUser: userA,
      meRequest: async () => ({
        user: null,
        sessionInvalid: false,
        networkOrServerError: true,
      }),
    });

    const first = harness.auth.rotateSession(() => firstRotation.promise);
    const restarted = harness.remount({ initialUser: userA });
    const second = restarted.auth.rotateSession(secondOperation);
    firstRotation.resolve({ ok: false, error: "resposta remota ambígua" });

    await expect(first).resolves.toEqual({
      ok: false,
      error: "resposta remota ambígua",
    });
    await expect(second).resolves.toEqual({
      ok: false,
      error: "A sessão anterior ainda está sendo reconciliada.",
    });
    expect(secondOperation).not.toHaveBeenCalled();
    expect(harness.meDetailedApi).toHaveBeenCalledTimes(1);
    expect(restarted.setUser).not.toHaveBeenCalledWith(userA);
  });

  it("commit ambíguo ainda em PENDING mantém B fechado quando a revogação falha", async () => {
    let commitAttempted = false;
    const harness = await renderRealAuthProvider({
      initialUser: null,
      loginRequest: async () => ({ ok: true, user: userB, token: "token-B" }),
      commitSessionToken: async () => {
        commitAttempted = true;
        throw Object.assign(new Error("release incerto"), {
          code: "SESSION_TOKEN_COMMIT_AMBIGUOUS",
        });
      },
      sessionTokenQuarantined: () => commitAttempted,
      admittedSessionUserId: () => null,
      admittedSessionToken: () => null,
      quarantinedSessionToken: () => (commitAttempted ? "token-B" : null),
      revokeTokenRequest: async () => {
        throw new Error("500 ao revogar B");
      },
      meRequest: async () => ({
        user: userB,
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });

    await expect(harness.auth.login(userB.email, "senha-B")).resolves.toEqual({
      ok: false,
      error:
        "Não foi possível confirmar a sessão local; a revalidação permanece bloqueada.",
      admissionPending: true,
    });

    expect(harness.revokeSessionTokenApi).toHaveBeenCalledWith("token-B");
    expect(harness.meDetailedApi).not.toHaveBeenCalled();
    expect(harness.removeSessionToken).not.toHaveBeenCalled();
    expect(harness.setUser).not.toHaveBeenCalledWith(userA);
    expect(harness.setUser).not.toHaveBeenCalledWith(userB);
    expect(harness.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "UNAVAILABLE" }),
    );
  });

  it("rotação com commit B ambíguo só reabre após /me da mesma conta", async () => {
    const harness = await renderRealAuthProvider({
      initialUser: userA,
      commitSessionToken: async () => {
        throw Object.assign(new Error("ACK do commit perdido"), {
          code: "SESSION_TOKEN_COMMIT_AMBIGUOUS",
        });
      },
      admittedSessionUserId: () => userA.id,
      admittedSessionToken: () => "token-B",
      meRequest: async () => ({
        user: userA,
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });

    await expect(
      harness.auth.rotateSession(async () => ({
        ok: true,
        token: "token-B",
      })),
    ).resolves.toEqual({ ok: true });

    expect(harness.commitStagedSessionToken).toHaveBeenCalledTimes(1);
    expect(harness.meDetailedApi).toHaveBeenCalledTimes(1);
    expect(harness.revokeSessionTokenApi).not.toHaveBeenCalled();
    expect(harness.setUser.mock.calls).toEqual([[null], [userA]]);
    expect(harness.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "VERIFIED", userId: userA.id }),
    );
  });
});
