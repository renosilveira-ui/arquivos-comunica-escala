import { beforeEach, describe, expect, it, vi } from "vitest";

function rejectedDeferred() {
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

type CapturedAuthValue = {
  login: (
    email: string,
    password: string,
  ) => Promise<{ ok: boolean; error?: string; admissionPending?: true }>;
  rotateSession: (
    operation: (
      credential: object,
      capabilityReceipt?: object,
    ) => Promise<{
      ok: boolean;
      token?: string;
      error?: string;
      status?: number;
      code?:
        | "EXPECTED_USER_MISMATCH"
        | "MALFORMED_EXPECTED_USER_ID"
        | "SESSION_INSTANCE_MISMATCH"
        | "SESSION_INSTANCE_REQUIRED";
    }>,
  ) => Promise<{ ok: boolean; error?: string }>;
  deleteAccount: (password: string) => Promise<{
    ok: boolean;
    status: number;
    error?: string;
    code?:
      | "EXPECTED_USER_MISMATCH"
      | "MALFORMED_EXPECTED_USER_ID"
      | "SESSION_INSTANCE_MISMATCH"
      | "SESSION_INSTANCE_REQUIRED";
  }>;
  logout: () => Promise<void>;
  refetch: () => Promise<void>;
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

type WebSessionGateState =
  | { state: "CLEAR" }
  | {
      state: "REVOKE_REQUIRED";
      expectedUserId?: number;
      sessionInstance?: string;
    }
  | { state: "ADMISSION"; expectedUserId: number };

type PersistentWebSessionGate = {
  beginLoginInProgress: () => void | Promise<void>;
  beginRevocation: (
    expectedUserId?: number,
    sessionInstance?: string,
  ) => void | Promise<void>;
  beginAdmission?: (expectedUserId: number) => void | Promise<void>;
  prepareAdmission: (expectedUserId: number) => void | Promise<void>;
  read: () => WebSessionGateState | Promise<WebSessionGateState>;
  clear: () => void | Promise<void>;
};

type AuthHarnessOptions = {
  logoutRequest: (
    expectedUserId?: number,
    sessionInstance?: string,
  ) => Promise<void>;
  clearPushFingerprint?: () => Promise<void>;
  bindingCapabilityRequest?: (
    purpose: "login" | "rotate-session" | "delete-account",
  ) => Promise<void>;
  loginRequest?: () => Promise<{
    ok: boolean;
    user?: { id: number; name: string; email: string; role: "doctor" };
    token?: string;
    sessionInstance?: string;
    error?: string;
  }>;
  deleteRequest?: (password: string) => Promise<{
    ok: boolean;
    status: number;
    error?: string;
    code?:
      | "EXPECTED_USER_MISMATCH"
      | "MALFORMED_EXPECTED_USER_ID"
      | "SESSION_INSTANCE_MISMATCH"
      | "SESSION_INSTANCE_REQUIRED";
  }>;
  meRequest?: () => Promise<{
    user: { id: number; name: string; email: string; role: "doctor" } | null;
    sessionInvalid: boolean;
    networkOrServerError: boolean;
    code?:
      | "EXPECTED_USER_MISMATCH"
      | "MALFORMED_EXPECTED_USER_ID"
      | "SESSION_BINDING_REAUTH_REQUIRED";
    revocationUserId?: number;
    sessionInstance?: string;
    validationReceipt?: object;
  }>;
  persistSessionToken?: (token: string) => Promise<void>;
  commitSessionToken?: () => Promise<void>;
  revokeTokenRequest?: (token: string) => Promise<void>;
  revalidateTokenRequest?: (
    token: string,
    expectedUserId: number,
  ) => Promise<{
    user: { id: number; name: string; email: string; role: "doctor" } | null;
    sessionInvalid: boolean;
    networkOrServerError: boolean;
  }>;
  persistUser?: (user: { id: number }) => Promise<void>;
  admittedSessionUserId?: number | null;
  admittedSessionToken?: string | null;
  platform?: "web" | "ios";
  trackWebLock?: boolean;
  webLockError?: Error;
  webLockInitiallyHeld?: Promise<void>;
  webSessionGate?: PersistentWebSessionGate;
  webRevocationBootstrap?: (expectedUserId?: number) => Promise<
    | { state: "LEGACY" }
    | {
        state: "BOUND";
        expectedUserId: number;
        sessionInstance: string;
      }
    | { state: "INVALID" }
  >;
  nativeSessionQuarantine?: {
    stage: (token: string) => void | Promise<void>;
    commit: () => void | Promise<void>;
    isActive: () => boolean | Promise<boolean>;
    getToken: () => string | null | Promise<string | null>;
  };
};

async function renderAuthHarness(options: AuthHarnessOptions) {
  const sequence: string[] = [];
  const visibleUser = {
    id: 31,
    name: "Usuário ainda autenticado",
    email: "ativo@example.com",
    role: "doctor",
  };
  const setUser = vi.fn((user: unknown) => {
    sequence.push(`set-user:${user === null ? "null" : "present"}`);
  });
  const setIsLoading = vi.fn();
  const setSessionValidation = vi.fn();
  let pushRegistrationRevision = 0;
  const setPushRegistrationRevision = vi.fn(
    (update: number | ((current: number) => number)) => {
      pushRegistrationRevision =
        typeof update === "function"
          ? update(pushRegistrationRevision)
          : update;
      sequence.push(`set-push-revision:${pushRegistrationRevision}`);
    },
  );
  const queryClient = {
    clear: vi.fn(() => {
      sequence.push("clear-query-memory");
    }),
  };
  const clearPersistedQueryCache = vi.fn(async () => {
    sequence.push("clear-query-persisted");
  });
  const fenceQueryCachePersistence = vi.fn(() => {
    sequence.push("fence-query");
  });
  const resumeQueryCachePersistence = vi.fn(() => {
    sequence.push("resume-query");
    return true;
  });
  const suspendQueryCachePersistence = vi.fn(() => {
    sequence.push("suspend-query");
    return resumeQueryCachePersistence;
  });
  const closePushRegistrationAdmission = vi.fn(() => {
    sequence.push("close-push");
  });
  const openPushRegistrationAdmission = vi.fn(() => {
    sequence.push("open-push");
  });
  const waitForPushRegistrationIdle = vi.fn(async () => {
    sequence.push("wait-push");
  });
  const clearPushRegistrationState = vi.fn(async () => {
    sequence.push("clear-push-fingerprint");
    await options.clearPushFingerprint?.();
  });
  const logoutApi = vi.fn(
    async (
      _pushToken?: string | null,
      expectedUserId?: number,
      expectedSessionInstance?: string,
    ) => {
      sequence.push("http-logout");
      await options.logoutRequest(expectedUserId, expectedSessionInstance);
      return {
        status: "ROTATED" as const,
        revocationUserId: expectedUserId ?? visibleUser.id,
      };
    },
  );
  const revokeSessionTokenApi = vi.fn(async (token: string) => {
    sequence.push(`http-revoke-token:${token}`);
    await options.revokeTokenRequest?.(token);
    return {
      status: "ROTATED" as const,
      revocationUserId: locallyQuarantinedUserId ?? visibleUser.id,
    };
  });
  const revalidateSessionTokenApi = vi.fn(
    async (token: string, expectedUserId: number) => {
      sequence.push(`http-revalidate-token:${token}:${expectedUserId}`);
      return (
        (await options.revalidateTokenRequest?.(token, expectedUserId)) ?? {
          user: null,
          sessionInvalid: false,
          networkOrServerError: true,
        }
      );
    },
  );
  const setLastPushToken = vi.fn((token: string | null) => {
    sequence.push(`set-last-push:${token ?? "null"}`);
  });
  let stagedExpectedUserId: number | null = null;
  let stagedSessionTokenValue: string | null = null;
  let admittedSessionUserId: number | null =
    options.admittedSessionUserId === undefined
      ? visibleUser.id
      : options.admittedSessionUserId;
  let admittedSessionToken: string | null =
    options.admittedSessionToken === undefined
      ? "token-A"
      : options.admittedSessionToken;
  let locallyQuarantinedToken: string | null = null;
  let locallyQuarantinedUserId: number | null = null;
  let locallyPreparedRevocation: PreparedRevocation | null = null;
  const revokePreparedSessionToken = vi.fn(
    async (prepared: PreparedRevocation) => {
      if (
        prepared !== locallyPreparedRevocation ||
        prepared.token !== locallyQuarantinedToken
      ) {
        throw new Error("binding de cleanup divergente");
      }
      const proof = await revokeSessionTokenApi(prepared.token);
      if (
        !Number.isSafeInteger(proof.revocationUserId) ||
        proof.revocationUserId <= 0 ||
        (prepared.expectedUserId !== undefined &&
          proof.revocationUserId !== prepared.expectedUserId)
      ) {
        throw new Error("binding de cleanup divergente");
      }
      sequence.push(`mark-revoked-cleanup:${proof.revocationUserId}`);
    },
  );
  const removeSessionToken = vi.fn(async () => {
    sequence.push("remove-session-token");
    admittedSessionUserId = null;
    admittedSessionToken = null;
    stagedExpectedUserId = null;
    stagedSessionTokenValue = null;
    locallyQuarantinedToken = null;
    locallyQuarantinedUserId = null;
    locallyPreparedRevocation = null;
  });
  let stagedTokenVersion = 0;
  const setSessionToken = vi.fn(
    async (token: string, expectedUserId: number) => {
      sequence.push("set-session-token");
      await options.persistSessionToken?.(token);
      await options.nativeSessionQuarantine?.stage(token);
      stagedExpectedUserId = expectedUserId;
      stagedSessionTokenValue = token;
      stagedTokenVersion += 1;
      return { version: stagedTokenVersion };
    },
  );
  const commitStagedSessionToken = vi.fn(async () => {
    sequence.push("commit-session-token");
    await options.commitSessionToken?.();
    await options.nativeSessionQuarantine?.commit();
    admittedSessionUserId = stagedExpectedUserId;
    admittedSessionToken = stagedSessionTokenValue;
    locallyQuarantinedToken = null;
    stagedExpectedUserId = null;
    stagedSessionTokenValue = null;
  });
  let persistedUserId: number | null = null;
  const clearUserInfo = vi.fn(async () => {
    persistedUserId = null;
    sequence.push("clear-user-info");
  });
  const getPersistedUserId = vi.fn(async () => persistedUserId);
  const closeSessionTokenTransportAdmission = vi.fn(() => {
    if (options.trackWebLock) sequence.push("close-transport");
  });
  let webSessionWorkflowRevision = 0;
  const captureWebSessionMutationIntent = vi.fn(() =>
    Object.freeze({ revision: webSessionWorkflowRevision }),
  );
  const beginWebSessionMutationIntent = vi.fn(
    (intent: { revision: number }) => {
      if (intent.revision !== webSessionWorkflowRevision) {
        throw new Error("A sessão web mudou em outra aba antes da operação");
      }
    },
  );
  const discardWebSessionMutationIntent = vi.fn();
  const advanceWebSessionWorkflowRevision = vi.fn(
    () => `workflow:test:${webSessionWorkflowRevision}`,
  );
  const transitionCredential = Object.freeze({});
  const captureSessionTransitionCredential = vi.fn(() => transitionCredential);
  const discardSessionTransitionCredential = vi.fn();
  const setUserInfo = vi.fn(async (user: { id: number }) => {
    persistedUserId = user.id;
    sequence.push(`set-user-info:${user.id}`);
    await options.persistUser?.(user);
  });
  const clearActiveInstitutionId = vi.fn(async () => {
    sequence.push("clear-active-tenant");
  });
  let localWebSessionGate: WebSessionGateState = { state: "CLEAR" };
  let activeWebLoginTicket: object | null = null;
  const beginWebLoginInProgress = vi.fn(async () => {
    if (options.trackWebLock) sequence.push("gate:login");
    await options.webSessionGate?.beginLoginInProgress();
    localWebSessionGate = { state: "REVOKE_REQUIRED" };
    activeWebLoginTicket = Object.freeze({});
    return activeWebLoginTicket;
  });
  const beginWebSessionQuarantine = vi.fn(
    async (expectedUserId?: number, sessionInstance?: string) => {
      if (options.trackWebLock) sequence.push("gate:revoke");
      await options.webSessionGate?.beginRevocation(
        expectedUserId,
        sessionInstance,
      );
      localWebSessionGate =
        expectedUserId === undefined
          ? { state: "REVOKE_REQUIRED" }
          : {
              state: "REVOKE_REQUIRED",
              expectedUserId,
              ...(sessionInstance ? { sessionInstance } : {}),
            };
    },
  );
  const beginWebSessionAdmission = vi.fn(async (expectedUserId: number) => {
    if (options.trackWebLock) sequence.push("gate:admission");
    if (options.webSessionGate?.beginAdmission) {
      await options.webSessionGate.beginAdmission(expectedUserId);
    } else {
      await options.webSessionGate?.prepareAdmission(expectedUserId);
    }
    localWebSessionGate = { state: "ADMISSION", expectedUserId };
  });
  const prepareWebSessionAdmission = vi.fn(async (expectedUserId: number) => {
    if (options.trackWebLock) sequence.push("gate:admission");
    await options.webSessionGate?.prepareAdmission(expectedUserId);
    localWebSessionGate = { state: "ADMISSION", expectedUserId };
  });
  const getWebSessionGateState = vi.fn(async () => {
    if (options.webSessionGate) return options.webSessionGate.read();
    return localWebSessionGate;
  });
  const bootstrapExactWebSessionRevocation = vi.fn(
    async (expectedUserId?: number) =>
      options.webRevocationBootstrap?.(expectedUserId) ?? {
        state: "LEGACY" as const,
      },
  );
  const isWebSessionQuarantined = vi.fn(
    async () => (await getWebSessionGateState()).state !== "CLEAR",
  );
  const clearLocalWebSessionGateAfterRemoteProof = vi.fn(async () => {
    if (options.trackWebLock) sequence.push("gate:clear");
    await options.webSessionGate?.clear();
    localWebSessionGate = { state: "CLEAR" };
  });
  const cancelWebLoginInProgress = vi.fn(async (ticket: object) => {
    if (ticket !== activeWebLoginTicket) {
      throw new Error("capability de login inválida");
    }
    activeWebLoginTicket = null;
    await clearLocalWebSessionGateAfterRemoteProof();
  });
  const consumeWebLoginInProgressForRequest = vi.fn((ticket: object) => {
    if (ticket !== activeWebLoginTicket) {
      throw new Error("capability de login inválida");
    }
    activeWebLoginTicket = null;
  });
  const revokeWebSessionQuarantine = vi.fn(
    async (expectedUserId?: number, sessionInstance?: string) => {
      try {
        const proof = await logoutApi(
          undefined,
          expectedUserId,
          sessionInstance,
        );
        await clearLocalWebSessionGateAfterRemoteProof();
        return { status: "REVOKED" as const, revocation: proof };
      } catch (error) {
        const code =
          typeof error === "object" && error !== null
            ? (error as { code?: unknown }).code
            : undefined;
        const currentSessionUserId =
          typeof error === "object" && error !== null
            ? (error as { currentSessionUserId?: unknown }).currentSessionUserId
            : undefined;
        if (
          expectedUserId !== undefined &&
          code === "EXPECTED_USER_MISMATCH" &&
          typeof currentSessionUserId === "number" &&
          Number.isSafeInteger(currentSessionUserId) &&
          currentSessionUserId > 0 &&
          currentSessionUserId !== expectedUserId
        ) {
          await clearLocalWebSessionGateAfterRemoteProof();
          return {
            status: "STALE_QUARANTINE_CLEARED" as const,
          };
        }
        throw error;
      }
    },
  );
  let reversibleWebDeletionTicket: object | null = null;
  let reversibleWebDeletionDispatched = false;
  const prepareReversibleWebSessionRevocation = vi.fn(
    async (expectedUserId: number, sessionInstance?: string) => {
      await beginWebSessionQuarantine(expectedUserId, sessionInstance);
      reversibleWebDeletionTicket = Object.freeze({});
      reversibleWebDeletionDispatched = false;
      return reversibleWebDeletionTicket;
    },
  );
  const consumeReversibleWebSessionRevocationForRequest = vi.fn(
    (ticket: object) => {
      if (
        ticket !== reversibleWebDeletionTicket ||
        reversibleWebDeletionDispatched
      ) {
        throw new Error("receipt web inválida");
      }
      reversibleWebDeletionDispatched = true;
    },
  );
  const cancelReversibleWebSessionRevocation = vi.fn(async (ticket: object) => {
    if (
      ticket !== reversibleWebDeletionTicket ||
      reversibleWebDeletionDispatched
    ) {
      throw new Error("receipt web inválida");
    }
    reversibleWebDeletionTicket = null;
    await clearLocalWebSessionGateAfterRemoteProof();
  });
  const discardReversibleWebSessionRevocation = vi.fn();
  const admitWebSessionTransport = vi.fn(async () => {
    if (localWebSessionGate.state === "REVOKE_REQUIRED") {
      throw new Error("receipt canônica não libera revoke-required");
    }
    if (localWebSessionGate.state === "ADMISSION") {
      await clearLocalWebSessionGateAfterRemoteProof();
    }
  });
  const reversibleNativeDeletionTicket = Object.freeze({});
  let reversibleNativeDeletion: {
    token: string;
    expectedUserId: number;
  } | null = null;
  const prepareReversibleSessionTokenRevocation = vi.fn(
    async (expectedUserId: number) => {
      if (!admittedSessionToken || admittedSessionUserId !== expectedUserId) {
        throw new Error("sessão nativa não reversível");
      }
      reversibleNativeDeletion = {
        token: admittedSessionToken,
        expectedUserId,
      };
      locallyQuarantinedToken = admittedSessionToken;
      admittedSessionToken = null;
      admittedSessionUserId = null;
      return reversibleNativeDeletionTicket;
    },
  );
  const getReversibleSessionTokenForRevocation = vi.fn((ticket: object) => {
    if (
      ticket !== reversibleNativeDeletionTicket ||
      !reversibleNativeDeletion
    ) {
      throw new Error("receipt nativa inválida");
    }
    return reversibleNativeDeletion.token;
  });
  const restoreReversibleSessionTokenAdmission = vi.fn(
    async (ticket: object) => {
      if (
        ticket !== reversibleNativeDeletionTicket ||
        !reversibleNativeDeletion
      ) {
        throw new Error("receipt nativa inválida");
      }
      admittedSessionToken = reversibleNativeDeletion.token;
      admittedSessionUserId = reversibleNativeDeletion.expectedUserId;
      locallyQuarantinedToken = null;
      reversibleNativeDeletion = null;
    },
  );
  const bindSessionTransitionCredentialToReversibleRevocation = vi.fn();
  const discardReversibleSessionTokenRevocation = vi.fn();
  let webLockTail = options.webLockInitiallyHeld ?? Promise.resolve();
  const runExclusiveWebSessionMutation = vi.fn(
    <T>(operation: () => Promise<T>): Promise<T> => {
      const result = webLockTail.then(async () => {
        if (options.webLockError) throw options.webLockError;
        if (options.trackWebLock) sequence.push("lock:start");
        try {
          return await operation();
        } finally {
          if (options.trackWebLock) sequence.push("lock:end");
        }
      });
      webLockTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  );
  const prepareSessionTokenRevocation = vi.fn(
    async (expectedToken?: string, expectedUserId?: number) => {
      const admittedUserIdBeforeQuarantine = admittedSessionUserId;
      if (options.nativeSessionQuarantine) {
        let active = await options.nativeSessionQuarantine.isActive();
        if (!active && expectedToken) {
          await options.nativeSessionQuarantine.stage(expectedToken);
          active = await options.nativeSessionQuarantine.isActive();
        }
        if (!active) throw new Error("binding nativo não confirmado");
        const token = await options.nativeSessionQuarantine.getToken();
        if (
          !token ||
          (expectedToken !== undefined && token !== expectedToken)
        ) {
          throw new Error("Bearer revogável divergente");
        }
        locallyQuarantinedToken = token;
        locallyQuarantinedUserId =
          expectedUserId ?? admittedUserIdBeforeQuarantine;
        admittedSessionUserId = null;
        admittedSessionToken = null;
      } else {
        const token =
          expectedToken ?? locallyQuarantinedToken ?? admittedSessionToken;
        if (!token) throw new Error("Bearer revogável ausente");
        locallyQuarantinedToken = token;
        locallyQuarantinedUserId =
          expectedUserId ?? admittedUserIdBeforeQuarantine;
        admittedSessionUserId = null;
        admittedSessionToken = null;
      }
      const token = locallyQuarantinedToken!;
      const physicalUserId = locallyQuarantinedUserId ?? undefined;
      if (
        locallyPreparedRevocation?.token === token &&
        locallyPreparedRevocation.expectedUserId === physicalUserId
      ) {
        return locallyPreparedRevocation;
      }
      locallyPreparedRevocation = Object.freeze(
        physicalUserId === undefined
          ? {
              token,
              phase: "LEGACY",
              fingerprint: "a".repeat(64),
              nonce: "1".repeat(32),
            }
          : {
              token,
              phase: "PENDING",
              fingerprint: "a".repeat(64),
              nonce: "1".repeat(32),
              expectedUserId: physicalUserId,
            },
      ) as PreparedRevocation;
      return locallyPreparedRevocation;
    },
  );
  const prepareSessionBindingMutation = vi.fn(
    async (purpose: "login" | "rotate-session" | "delete-account") => {
      sequence.push(`http-binding-capability:${purpose}`);
      await options.bindingCapabilityRequest?.(purpose);
      return Object.freeze({ purpose });
    },
  );
  const loginApi = vi.fn(
    async (
      _email?: string,
      _password?: string,
      _capabilityReceipt?: object,
      webLogin?: object,
    ) => {
      if ((options.platform ?? "web") === "web") {
        if (!webLogin) throw new Error("capability de login ausente");
        consumeWebLoginInProgressForRequest(webLogin);
      }
      sequence.push("http-login");
      return (
        options.loginRequest?.() ?? {
          ok: false,
          error: "login não configurado",
        }
      );
    },
  );
  const deleteAccountApi = vi.fn(
    async (
      password: string,
      _credential?: object,
      _capabilityReceipt?: object,
      reversibleWebRevocation?: object,
    ) => {
      if ((options.platform ?? "web") === "web") {
        if (!reversibleWebRevocation) {
          throw new Error("receipt DELETE web ausente");
        }
        consumeReversibleWebSessionRevocationForRequest(
          reversibleWebRevocation,
        );
      }
      sequence.push("http-delete-account");
      return (
        (await options.deleteRequest?.(password)) ?? {
          ok: false,
          status: 500,
          error: "exclusão não configurada",
        }
      );
    },
  );
  const deleteAccountWithReversibleSessionCleanup = vi.fn(
    async (password: string, _credential: object, ticket: object) => {
      if (
        ticket !== reversibleNativeDeletionTicket ||
        !reversibleNativeDeletion ||
        reversibleNativeDeletion.token !== locallyQuarantinedToken
      ) {
        throw new Error("receipt nativa inválida");
      }
      sequence.push("http-delete-account");
      const result = (await options.deleteRequest?.(password)) ?? {
        ok: false,
        status: 500,
        error: "exclusão não configurada",
      };
      if (result.ok) {
        sequence.push(
          `mark-revoked-cleanup:${reversibleNativeDeletion.expectedUserId}`,
        );
        reversibleNativeDeletion = null;
      }
      return result;
    },
  );
  const meDetailedApi = vi.fn(async (_expectedUserId?: number) => {
    sequence.push("http-me");
    const result = options.meRequest?.() ?? {
      user: null,
      sessionInvalid: false,
      networkOrServerError: true,
    };
    const settled = await result;
    return settled.user
      ? { ...settled, validationReceipt: Object.freeze({}) }
      : settled;
  });
  let capturedAuth: CapturedAuthValue | null = null;

  vi.doMock("react", () => ({
    createContext: () => ({ Provider: Symbol("AuthProvider") }),
    createElement: (_type: unknown, props: { value?: CapturedAuthValue }) => {
      if (props.value) capturedAuth = props.value;
      return null;
    },
    useCallback: (callback: unknown) => callback,
    useContext: vi.fn(),
    useEffect: vi.fn(),
    useMemo: (factory: () => unknown) => factory(),
    useRef: (initial: unknown) => ({ current: initial }),
    useState: vi
      .fn()
      .mockReturnValueOnce([visibleUser, setUser])
      .mockReturnValueOnce([false, setIsLoading])
      .mockReturnValueOnce([
        pushRegistrationRevision,
        setPushRegistrationRevision,
      ])
      .mockReturnValueOnce([
        { status: "CHECKING", sequence: 0 },
        setSessionValidation,
      ]),
  }));
  vi.doMock("react-native", () => ({
    Platform: { OS: options.platform ?? "web" },
  }));
  vi.doMock("@tanstack/react-query", () => ({
    useQueryClient: () => queryClient,
  }));
  vi.doMock("@/lib/push-token", () => ({
    getLastPushToken: () => null,
    setLastPushToken,
  }));
  vi.doMock("@/lib/_core/api", () => ({
    isExpectedUserMismatchError: (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      ((error as { code?: unknown }).code === "EXPECTED_USER_MISMATCH" ||
        (error as { code?: unknown }).code === "SESSION_INSTANCE_MISMATCH"),
    isSessionMutationMismatchCode: (code: unknown) =>
      code === "EXPECTED_USER_MISMATCH" || code === "SESSION_INSTANCE_MISMATCH",
    authApi: {
      prepareSessionBindingMutation,
      login: loginApi,
      deleteAccount: deleteAccountApi,
      logout: logoutApi,
      meDetailed: meDetailedApi,
      revalidateSessionToken: revalidateSessionTokenApi,
      revokeSessionToken: revokeSessionTokenApi,
    },
  }));
  vi.doMock("@/lib/_core/auth", () => ({
    admitSessionTokenTransport: vi.fn(async () => undefined),
    admitWebSessionTransport,
    beginWebLoginInProgress,
    beginWebSessionMutationIntent,
    beginWebSessionAdmission,
    beginWebSessionQuarantine,
    bootstrapExactWebSessionRevocation,
    bindSessionTransitionCredentialToReversibleRevocation,
    cancelReversibleWebSessionRevocation,
    cancelWebLoginInProgress,
    clearUserInfo,
    closeSessionTokenTransportAdmission,
    commitStagedSessionToken,
    captureSessionTransportTicket: vi.fn(() => 7),
    getSessionTransportExpectedUserId: vi.fn(() => visibleUser.id),
    getSessionTransportSessionInstance: vi.fn(() => `v1.${"a".repeat(43)}`),
    captureSessionTransitionCredential,
    captureWebSessionMutationIntent,
    discardSessionTransitionCredential,
    discardWebSessionMutationIntent,
    discardReversibleSessionTokenRevocation,
    discardReversibleWebSessionRevocation,
    consumeReversibleWebSessionRevocationForRequest,
    consumeWebLoginInProgressForRequest,
    getQuarantinedSessionTokenForRevocation: vi.fn(
      async () =>
        locallyQuarantinedToken ??
        (await options.nativeSessionQuarantine?.getToken()) ??
        null,
    ),
    getReversibleSessionTokenForRevocation,
    getSessionToken: vi.fn(async () =>
      locallyQuarantinedToken === null ? admittedSessionToken : null,
    ),
    getAdmittedSessionUserId: vi.fn(async () =>
      locallyQuarantinedToken !== null ||
      (await options.nativeSessionQuarantine?.isActive())
        ? null
        : admittedSessionUserId,
    ),
    getPersistedUserId,
    getWebSessionGateState,
    isWebSessionQuarantined,
    isSessionTokenQuarantined: vi.fn(
      async () =>
        locallyQuarantinedToken !== null ||
        (await options.nativeSessionQuarantine?.isActive()) ||
        false,
    ),
    isSessionTransportUserCurrent: vi.fn(() => true),
    deleteAccountWithReversibleSessionCleanup,
    revokeWebSessionQuarantine,
    revokePreparedSessionToken,
    advanceWebSessionWorkflowRevision,
    subscribeExternalWebSessionInvalidation: vi.fn(() => () => undefined),
    runExclusiveWebSessionMutation,
    prepareSessionTokenRevocation,
    prepareReversibleSessionTokenRevocation,
    prepareReversibleWebSessionRevocation,
    removeSessionToken,
    prepareWebSessionAdmission,
    restoreReversibleSessionTokenAdmission,
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
  vi.doMock("@/lib/push-registration", () => ({
    clearPushRegistrationState,
    closePushRegistrationAdmission,
    openPushRegistrationAdmission,
    waitForPushRegistrationIdle,
  }));
  vi.doMock("@/lib/session-events", () => ({
    onSessionUnauthorized: vi.fn(),
  }));

  const [{ AuthProvider }, { isSessionTerminationNotDurableError }] =
    await Promise.all([
      import("../hooks/use-auth"),
      import("../lib/session-cleanup"),
    ]);
  AuthProvider({ children: null });
  if (!capturedAuth) throw new Error("AuthProvider não publicou o contexto");

  return {
    auth: capturedAuth as CapturedAuthValue,
    sequence,
    isSessionTerminationNotDurableError,
    setUser,
    setIsLoading,
    setSessionValidation,
    setPushRegistrationRevision,
    queryClient,
    clearPersistedQueryCache,
    resumeQueryCachePersistence,
    openPushRegistrationAdmission,
    clearPushRegistrationState,
    prepareSessionBindingMutation,
    logoutApi,
    setLastPushToken,
    removeSessionToken,
    setSessionToken,
    setUserInfo,
    loginApi,
    deleteAccountApi,
    meDetailedApi,
    revokeSessionTokenApi,
    revokePreparedSessionToken,
    deleteAccountWithReversibleSessionCleanup,
    revalidateSessionTokenApi,
    commitStagedSessionToken,
    clearUserInfo,
    closeSessionTokenTransportAdmission,
    clearActiveInstitutionId,
    beginWebSessionQuarantine,
    bootstrapExactWebSessionRevocation,
    beginWebSessionAdmission,
    beginWebLoginInProgress,
    cancelReversibleWebSessionRevocation,
    cancelWebLoginInProgress,
    revokeWebSessionQuarantine,
    isWebSessionQuarantined,
    getWebSessionGateState,
    prepareWebSessionAdmission,
    runExclusiveWebSessionMutation,
    advanceExternalWebSessionRevision: () => {
      webSessionWorkflowRevision += 1;
    },
  };
}

describe("persistência local do logout web", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    delete process.env.EXPO_PUBLIC_SESSION_EXACT_BINDING_CLIENT_ACTIVE;
  });

  it("preflight exact indisponível bloqueia login antes de revogar A ou instalar marker", async () => {
    process.env.EXPO_PUBLIC_SESSION_EXACT_BINDING_CLIENT_ACTIVE = "1";
    const currentUser = {
      id: 31,
      name: "Usuário ainda autenticado",
      email: "ativo@example.com",
      role: "doctor" as const,
    };
    const logoutRequest = vi.fn(async () => undefined);
    const loginRequest = vi.fn(async () => ({ ok: false }));
    const harness = await renderAuthHarness({
      platform: "web",
      logoutRequest,
      loginRequest,
      bindingCapabilityRequest: async () => {
        throw new Error("capability indisponível");
      },
      meRequest: async () => ({
        user: currentUser,
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });

    await expect(
      harness.auth.login("novo@example.com", "segredo"),
    ).resolves.toMatchObject({ ok: false });

    expect(harness.prepareSessionBindingMutation).toHaveBeenCalledWith("login");
    expect(logoutRequest).not.toHaveBeenCalled();
    expect(loginRequest).not.toHaveBeenCalled();
    expect(harness.beginWebSessionQuarantine).not.toHaveBeenCalled();
    expect(harness.beginWebLoginInProgress).not.toHaveBeenCalled();
    expect(harness.clearPushRegistrationState).not.toHaveBeenCalled();
    expect(harness.meDetailedApi).toHaveBeenCalledTimes(1);
    expect(harness.setUser).not.toHaveBeenCalledWith(null);
    expect(harness.setUser).toHaveBeenCalledWith(currentUser);
  });

  it("preflight exact indisponível bloqueia rotação antes de push, admission e operação", async () => {
    process.env.EXPO_PUBLIC_SESSION_EXACT_BINDING_CLIENT_ACTIVE = "1";
    const currentUser = {
      id: 31,
      name: "Usuário ainda autenticado",
      email: "ativo@example.com",
      role: "doctor" as const,
    };
    const operation = vi.fn(async () => ({ ok: true, token: "token-B" }));
    const harness = await renderAuthHarness({
      platform: "web",
      logoutRequest: async () => undefined,
      bindingCapabilityRequest: async () => {
        throw new Error("capability indisponível");
      },
      meRequest: async () => ({
        user: currentUser,
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });

    await expect(harness.auth.rotateSession(operation)).resolves.toMatchObject({
      ok: false,
    });

    expect(harness.prepareSessionBindingMutation).toHaveBeenCalledWith(
      "rotate-session",
    );
    expect(operation).not.toHaveBeenCalled();
    expect(harness.clearPushRegistrationState).not.toHaveBeenCalled();
    expect(harness.beginWebSessionAdmission).not.toHaveBeenCalled();
    // BEGIN fecha também a superfície visual/local antes de o preflight
    // assíncrono decidir que a operação não pode prosseguir.
    expect(harness.sequence.slice(0, 2)).toEqual([
      "close-push",
      "fence-query",
    ]);
    expect(harness.meDetailedApi).toHaveBeenCalledTimes(1);
    expect(harness.setUser).toHaveBeenCalledWith(currentUser);
  });

  it("preflight exact indisponível bloqueia DELETE antes de marker, push e request", async () => {
    process.env.EXPO_PUBLIC_SESSION_EXACT_BINDING_CLIENT_ACTIVE = "1";
    const currentUser = {
      id: 31,
      name: "Usuário ainda autenticado",
      email: "ativo@example.com",
      role: "doctor" as const,
    };
    const deleteRequest = vi.fn(async () => ({ ok: true, status: 200 }));
    const harness = await renderAuthHarness({
      platform: "web",
      logoutRequest: async () => undefined,
      deleteRequest,
      bindingCapabilityRequest: async () => {
        throw new Error("capability indisponível");
      },
      meRequest: async () => ({
        user: currentUser,
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });

    await expect(harness.auth.deleteAccount("senha-atual")).resolves.toEqual(
      expect.objectContaining({
        ok: false,
        status: 0,
        code: "SESSION_BINDING_CAPABILITY_UNAVAILABLE",
      }),
    );

    expect(harness.prepareSessionBindingMutation).toHaveBeenCalledWith(
      "delete-account",
    );
    expect(deleteRequest).not.toHaveBeenCalled();
    expect(harness.deleteAccountApi).not.toHaveBeenCalled();
    expect(harness.beginWebSessionQuarantine).not.toHaveBeenCalled();
    expect(harness.clearPushRegistrationState).not.toHaveBeenCalled();
    expect(harness.sequence).not.toContain("suspend-query");
    expect(harness.meDetailedApi).toHaveBeenCalledTimes(1);
    expect(harness.setUser).toHaveBeenCalledWith(currentUser);
  });

  it("login web mantém marker, cookie, /me e clear dentro do mesmo workflow lock", async () => {
    const userB = {
      id: 44,
      name: "Usuário B",
      email: "b@example.com",
      role: "doctor" as const,
    };
    const harness = await renderAuthHarness({
      platform: "web",
      trackWebLock: true,
      logoutRequest: async () => undefined,
      loginRequest: async () => ({ ok: true, user: userB }),
      meRequest: async () => ({
        user: userB,
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });

    await expect(
      harness.auth.login("b@example.com", "segredo"),
    ).resolves.toEqual({ ok: true });

    expect(
      harness.sequence.filter(
        (entry) =>
          entry.startsWith("lock:") ||
          entry.startsWith("gate:") ||
          entry === "http-logout" ||
          entry === "http-login" ||
          entry === "http-me",
      ),
    ).toEqual([
      "lock:start",
      "gate:revoke",
      "http-logout",
      "gate:clear",
      "gate:login",
      "http-login",
      "gate:admission",
      "http-me",
      "gate:clear",
      "lock:end",
    ]);
    expect(harness.runExclusiveWebSessionMutation).toHaveBeenCalledTimes(1);
  });

  it("DELETE mantém request, logout tipado e cleanup no mesmo Web Lock", async () => {
    const remoteDelete = deferred<{
      ok: boolean;
      status: number;
      error?: string;
    }>();
    const harness = await renderAuthHarness({
      platform: "web",
      trackWebLock: true,
      logoutRequest: async () => undefined,
      deleteRequest: () => remoteDelete.promise,
    });

    const deletion = harness.auth.deleteAccount("senha-atual");
    await vi.waitFor(() =>
      expect(harness.deleteAccountApi).toHaveBeenCalledTimes(1),
    );
    const competingEffect = vi.fn();
    const competing = harness.runExclusiveWebSessionMutation(async () => {
      competingEffect();
    });
    expect(competingEffect).not.toHaveBeenCalled();

    remoteDelete.resolve({ ok: true, status: 200 });
    await expect(deletion).resolves.toEqual({ ok: true, status: 200 });
    await expect(competing).resolves.toBeUndefined();

    expect(harness.deleteAccountApi).toHaveBeenCalledWith(
      "senha-atual",
      expect.any(Object),
      undefined,
      expect.any(Object),
    );
    expect(harness.logoutApi).toHaveBeenCalledTimes(1);
    expect(competingEffect).toHaveBeenCalledTimes(1);
    expect(
      harness.sequence.filter(
        (entry) =>
          entry.startsWith("lock:") ||
          entry.startsWith("gate:") ||
          entry === "http-delete-account" ||
          entry === "http-logout" ||
          entry === "set-user:null",
      ),
    ).toEqual([
      "lock:start",
      "gate:revoke",
      "http-delete-account",
      "http-logout",
      "gate:clear",
      "set-user:null",
      "lock:end",
      "lock:start",
      "lock:end",
    ]);
  });

  it("DELETE nativo confirmado persiste a fase de cleanup antes de remover o Bearer", async () => {
    const harness = await renderAuthHarness({
      platform: "ios",
      logoutRequest: async () => undefined,
      deleteRequest: async () => ({ ok: true, status: 200 }),
    });

    await expect(harness.auth.deleteAccount("senha-atual")).resolves.toEqual({
      ok: true,
      status: 200,
    });

    expect(
      harness.deleteAccountWithReversibleSessionCleanup,
    ).toHaveBeenCalledWith(
      "senha-atual",
      expect.any(Object),
      expect.any(Object),
    );
    expect(harness.deleteAccountApi).not.toHaveBeenCalled();
    expect(harness.logoutApi).not.toHaveBeenCalled();
    expect(harness.revokeSessionTokenApi).not.toHaveBeenCalled();

    const deleteIndex = harness.sequence.indexOf("http-delete-account");
    const markIndex = harness.sequence.indexOf("mark-revoked-cleanup:31");
    const removeIndex = harness.sequence.indexOf("remove-session-token");
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(markIndex).toBeGreaterThan(deleteIndex);
    expect(removeIndex).toBeGreaterThan(markIndex);
  });

  it("revisão cross-tab stale cancela rotação antes de marker, push e HTTP", async () => {
    const releaseForeignWorkflow = deferred<void>();
    const harness = await renderAuthHarness({
      platform: "web",
      webLockInitiallyHeld: releaseForeignWorkflow.promise,
      logoutRequest: async () => undefined,
    });
    const changePassword = vi.fn(async () => ({ ok: true }));

    const rotation = harness.auth.rotateSession(changePassword);
    harness.advanceExternalWebSessionRevision();
    releaseForeignWorkflow.resolve();

    await expect(rotation).resolves.toEqual({
      ok: false,
      error: "A sessão mudou em outra aba antes da operação.",
    });
    expect(changePassword).not.toHaveBeenCalled();
    expect(harness.clearPushRegistrationState).not.toHaveBeenCalled();
    expect(harness.beginWebSessionAdmission).not.toHaveBeenCalled();
    expect(harness.beginWebSessionQuarantine).not.toHaveBeenCalled();
    expect(harness.logoutApi).not.toHaveBeenCalled();
  });

  it("revisão cross-tab stale cancela DELETE antes de marker, push e HTTP", async () => {
    const releaseForeignWorkflow = deferred<void>();
    const harness = await renderAuthHarness({
      platform: "web",
      webLockInitiallyHeld: releaseForeignWorkflow.promise,
      logoutRequest: async () => undefined,
      deleteRequest: async () => ({ ok: true, status: 200 }),
    });

    const deletion = harness.auth.deleteAccount("senha-atual");
    harness.advanceExternalWebSessionRevision();
    releaseForeignWorkflow.resolve();

    await expect(deletion).resolves.toEqual({
      ok: false,
      status: 0,
      error: "A sessão mudou em outra aba antes da exclusão.",
    });
    expect(harness.deleteAccountApi).not.toHaveBeenCalled();
    expect(harness.clearPushRegistrationState).not.toHaveBeenCalled();
    expect(harness.beginWebSessionAdmission).not.toHaveBeenCalled();
    expect(harness.beginWebSessionQuarantine).not.toHaveBeenCalled();
    expect(harness.logoutApi).not.toHaveBeenCalled();
  });

  it("DELETE 409 pós-dispatch encerra A somente após logout tipado", async () => {
    const userA = {
      id: 31,
      name: "Usuário ainda autenticado",
      email: "ativo@example.com",
      role: "doctor" as const,
    };
    const harness = await renderAuthHarness({
      platform: "web",
      logoutRequest: async () => undefined,
      deleteRequest: async () => ({
        ok: false,
        status: 409,
        error: "plantões futuros",
      }),
      meRequest: async () => ({
        user: userA,
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });

    await expect(harness.auth.deleteAccount("senha-atual")).resolves.toEqual({
      ok: false,
      status: 409,
      error: "plantões futuros",
    });

    expect(harness.meDetailedApi).not.toHaveBeenCalled();
    expect(harness.logoutApi).toHaveBeenCalledWith(
      undefined,
      userA.id,
      `v1.${"a".repeat(43)}`,
    );
    expect(harness.setUser).toHaveBeenCalledWith(null);
    expect(harness.setUser).not.toHaveBeenCalledWith(userA);
    expect(harness.resumeQueryCachePersistence).not.toHaveBeenCalled();
  });

  it("DELETE 428 pós-dispatch não recebe autoridade local para restaurar A", async () => {
    const userA = {
      id: 31,
      name: "Usuário que precisa atualizar",
      email: "atualize@example.com",
      role: "doctor" as const,
    };
    const harness = await renderAuthHarness({
      platform: "web",
      logoutRequest: async () => undefined,
      deleteRequest: async () => ({
        ok: false,
        status: 428,
        code: "SESSION_INSTANCE_REQUIRED",
        error: "Atualize a aplicação",
      }),
      meRequest: async () => ({
        user: userA,
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });

    await expect(harness.auth.deleteAccount("senha-atual")).resolves.toEqual({
      ok: false,
      status: 428,
      code: "SESSION_INSTANCE_REQUIRED",
      error: "Atualize a aplicação",
    });
    expect(harness.logoutApi).toHaveBeenCalledWith(
      undefined,
      userA.id,
      `v1.${"a".repeat(43)}`,
    );
    expect(harness.meDetailedApi).not.toHaveBeenCalled();
    expect(harness.setUser).toHaveBeenCalledWith(null);
    expect(harness.setUser).not.toHaveBeenCalledWith(userA);
    expect(harness.resumeQueryCachePersistence).not.toHaveBeenCalled();
  });

  it("DELETE ambíguo só libera o marker após logout tipado e nunca consulta /me", async () => {
    let gateState: WebSessionGateState = { state: "CLEAR" };
    const webGate: PersistentWebSessionGate = {
      beginLoginInProgress: async () => {
        gateState = { state: "REVOKE_REQUIRED" };
      },
      beginRevocation: async (expectedUserId) => {
        gateState =
          expectedUserId === undefined
            ? { state: "REVOKE_REQUIRED" }
            : { state: "REVOKE_REQUIRED", expectedUserId };
      },
      prepareAdmission: async (expectedUserId) => {
        gateState = { state: "ADMISSION", expectedUserId };
      },
      read: async () => gateState,
      clear: async () => {
        gateState = { state: "CLEAR" };
      },
    };
    const harness = await renderAuthHarness({
      platform: "web",
      webSessionGate: webGate,
      logoutRequest: async () => undefined,
      deleteRequest: async () => ({
        ok: false,
        status: 0,
        error: "resposta do DELETE perdida",
      }),
      meRequest: async () => ({
        user: {
          id: 31,
          name: "A ainda visível no servidor antes do commit",
          email: "ativo@example.com",
          role: "doctor",
        },
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });

    await expect(harness.auth.deleteAccount("senha-atual")).resolves.toEqual({
      ok: false,
      status: 0,
      error: "resposta do DELETE perdida",
    });

    expect(gateState).toEqual({ state: "CLEAR" });
    expect(harness.meDetailedApi).not.toHaveBeenCalled();
    expect(harness.revokeWebSessionQuarantine).toHaveBeenCalledWith(
      31,
      `v1.${"a".repeat(43)}`,
    );
    expect(harness.logoutApi).toHaveBeenCalledTimes(1);
    expect(harness.setUser).toHaveBeenCalledWith(null);
    expect(harness.resumeQueryCachePersistence).not.toHaveBeenCalled();
  });

  it("refetch enfileirado antes da intenção de login não readmite A ao adquirir o Web Lock", async () => {
    const externalLock = deferred<void>();
    const userB = {
      id: 44,
      name: "Usuário B",
      email: "b@example.com",
      role: "doctor" as const,
    };
    const harness = await renderAuthHarness({
      platform: "web",
      webLockInitiallyHeld: externalLock.promise,
      logoutRequest: async () => undefined,
      loginRequest: async () => ({ ok: true, user: userB }),
      meRequest: async () => ({
        user: userB,
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });

    const staleRefetch = harness.auth.refetch();
    await vi.waitFor(() =>
      expect(harness.runExclusiveWebSessionMutation).toHaveBeenCalledTimes(1),
    );
    const login = harness.auth.login(userB.email, "segredo");
    expect(harness.meDetailedApi).not.toHaveBeenCalled();
    expect(harness.loginApi).not.toHaveBeenCalled();

    externalLock.resolve();
    await expect(staleRefetch).resolves.toBeUndefined();
    await expect(login).resolves.toEqual({ ok: true });

    // Só o /me pós-login B pode certificar identidade. O refetch A que entrou
    // primeiro na fila perde autoridade antes de criar uma nova sequence.
    expect(harness.meDetailedApi).toHaveBeenCalledTimes(1);
    expect(harness.setUser).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 31 }),
    );
    expect(harness.setUser).toHaveBeenCalledWith(userB);
  });

  it("Web Lock indisponível fecha transporte e não inicia marker nem POST", async () => {
    const lockError = new Error("Bloqueio cross-tab indisponível");
    const harness = await renderAuthHarness({
      platform: "web",
      trackWebLock: true,
      webLockError: lockError,
      logoutRequest: async () => undefined,
      loginRequest: async () => ({
        ok: true,
        user: {
          id: 44,
          name: "Usuário B",
          email: "b@example.com",
          role: "doctor",
        },
      }),
    });

    await expect(harness.auth.login("b@example.com", "segredo")).rejects.toBe(
      lockError,
    );
    expect(harness.closeSessionTokenTransportAdmission).toHaveBeenCalled();
    expect(harness.beginWebLoginInProgress).not.toHaveBeenCalled();
    expect(harness.loginApi).not.toHaveBeenCalled();
  });

  it("dois refetch concorrentes compartilham um único logout REVOKE_REQUIRED", async () => {
    const remoteLogout = deferred<void>();
    let gateState: WebSessionGateState = { state: "REVOKE_REQUIRED" };
    const webGate: PersistentWebSessionGate = {
      beginLoginInProgress: async () => {
        gateState = { state: "REVOKE_REQUIRED" };
      },
      beginRevocation: async () => {
        gateState = { state: "REVOKE_REQUIRED" };
      },
      prepareAdmission: async (expectedUserId) => {
        gateState = { state: "ADMISSION", expectedUserId };
      },
      read: async () => gateState,
      clear: async () => {
        gateState = { state: "CLEAR" };
      },
    };
    const harness = await renderAuthHarness({
      platform: "web",
      webSessionGate: webGate,
      logoutRequest: () => remoteLogout.promise,
    });

    const first = harness.auth.refetch();
    await vi.waitFor(() => expect(harness.logoutApi).toHaveBeenCalledTimes(1));
    const second = harness.auth.refetch();
    await vi.waitFor(() => {
      expect(harness.beginWebSessionQuarantine).toHaveBeenCalledTimes(1);
      expect(harness.logoutApi).toHaveBeenCalledTimes(1);
    });
    expect(harness.meDetailedApi).not.toHaveBeenCalled();

    remoteLogout.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);

    expect(harness.logoutApi).toHaveBeenCalledTimes(1);
    expect(harness.clearPushRegistrationState).toHaveBeenCalledTimes(1);
    expect(harness.revokeWebSessionQuarantine).toHaveBeenCalledTimes(1);
    expect(harness.meDetailedApi).not.toHaveBeenCalled();
    expect(gateState).toEqual({ state: "CLEAR" });
  });

  it("mantém gate web bloqueado e nunca chama /me quando logout e retry falham", async () => {
    const logoutResponse = rejectedDeferred();
    const retryError = new Error("retry remoto indisponível");
    let logoutCalls = 0;
    let gateState: WebSessionGateState = { state: "CLEAR" };
    const webGate: PersistentWebSessionGate = {
      beginLoginInProgress: async () => {
        gateState = { state: "REVOKE_REQUIRED" };
      },
      beginRevocation: async () => {
        gateState = { state: "REVOKE_REQUIRED" };
      },
      prepareAdmission: async (expectedUserId) => {
        gateState = { state: "ADMISSION", expectedUserId };
      },
      read: async () => gateState,
      clear: async () => {
        gateState = { state: "CLEAR" };
      },
    };
    const harness = await renderAuthHarness({
      platform: "web",
      webSessionGate: webGate,
      logoutRequest: () => {
        logoutCalls += 1;
        return logoutCalls === 1
          ? logoutResponse.promise
          : Promise.reject(retryError);
      },
      meRequest: async () => ({
        user: {
          id: 31,
          name: "Usuário ainda autenticado",
          email: "ativo@example.com",
          role: "doctor",
        },
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });

    const logout = harness.auth.logout().catch((error) => error);
    await vi.waitFor(() => expect(harness.sequence).toContain("http-logout"));
    expect(harness.resumeQueryCachePersistence).not.toHaveBeenCalled();

    const networkError = new Error("rede indisponível");
    logoutResponse.reject(networkError);
    const error = await logout;

    expect(harness.isSessionTerminationNotDurableError(error)).toBe(true);
    expect(error).toMatchObject({ reason: networkError });
    expect(harness.logoutApi).toHaveBeenCalledTimes(2);
    expect(harness.meDetailedApi).not.toHaveBeenCalled();
    expect(gateState).toEqual({ state: "REVOKE_REQUIRED" });
    expect(harness.revokeWebSessionQuarantine).toHaveBeenCalledTimes(2);
    expect(harness.resumeQueryCachePersistence).not.toHaveBeenCalled();
    expect(harness.openPushRegistrationAdmission).not.toHaveBeenCalled();
    expect(harness.setUser).toHaveBeenCalledWith(null);
    expect(harness.setIsLoading).toHaveBeenCalledWith(false);
    expect(harness.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "UNAVAILABLE" }),
    );
  });

  it("logout stale de A nunca abandona expected-user nem revoga o cookie B", async () => {
    let gateState: WebSessionGateState = { state: "CLEAR" };
    let cookieBRevoked = false;
    const seenExpectedUsers: (number | undefined)[] = [];
    let freshSessionBAvailable = false;
    const webGate: PersistentWebSessionGate = {
      beginLoginInProgress: async () => {
        gateState = { state: "REVOKE_REQUIRED" };
      },
      beginRevocation: async (expectedUserId) => {
        gateState =
          expectedUserId === undefined
            ? { state: "REVOKE_REQUIRED" }
            : { state: "REVOKE_REQUIRED", expectedUserId };
      },
      prepareAdmission: async (expectedUserId) => {
        gateState = { state: "ADMISSION", expectedUserId };
      },
      read: async () => gateState,
      clear: async () => {
        gateState = { state: "CLEAR" };
      },
    };
    const harness = await renderAuthHarness({
      platform: "web",
      webSessionGate: webGate,
      logoutRequest: async (expectedUserId) => {
        seenExpectedUsers.push(expectedUserId);
        if (expectedUserId === undefined) {
          cookieBRevoked = true;
          return;
        }
        const mismatch = new Error(
          "cookie corrente pertence a B; expected-user A foi rejeitado",
        );
        Object.assign(mismatch, {
          code: "EXPECTED_USER_MISMATCH",
          currentSessionUserId: 32,
        });
        throw mismatch;
      },
      meRequest: async () =>
        freshSessionBAvailable
          ? {
              user: {
                id: 32,
                name: "Usuário B",
                email: "b@example.com",
                role: "doctor" as const,
              },
              sessionInvalid: false,
              networkOrServerError: false,
            }
          : {
              user: null,
              sessionInvalid: false,
              networkOrServerError: true,
            },
    });

    await expect(harness.auth.logout()).resolves.toBeUndefined();

    expect(harness.logoutApi).toHaveBeenCalledTimes(1);
    expect(harness.logoutApi).toHaveBeenCalledWith(
      undefined,
      31,
      `v1.${"a".repeat(43)}`,
    );
    expect(seenExpectedUsers).toEqual([31]);
    expect(cookieBRevoked).toBe(false);
    expect(harness.meDetailedApi).not.toHaveBeenCalled();
    expect(gateState).toEqual({ state: "CLEAR" });
    expect(harness.revokeWebSessionQuarantine).toHaveBeenCalledWith(
      31,
      `v1.${"a".repeat(43)}`,
    );
    expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
    expect(harness.setUser).toHaveBeenCalledWith(null);
    expect(harness.setUser).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 32 }),
    );
    expect(harness.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "UNAVAILABLE" }),
    );

    // O currentSessionUserId do 409 nunca vira autoridade de UI. Sem um /me
    // fresco de B, o transporte e o push continuam fechados.
    await harness.auth.refetch();
    expect(harness.setUser).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 32 }),
    );
    expect(harness.openPushRegistrationAdmission).not.toHaveBeenCalled();
    expect(harness.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "UNAVAILABLE" }),
    );

    freshSessionBAvailable = true;
    await harness.auth.refetch();
    expect(harness.setUser).toHaveBeenCalledWith(
      expect.objectContaining({ id: 32 }),
    );
    expect(harness.openPushRegistrationAdmission).toHaveBeenCalledTimes(1);
  });

  it("rotação stale de A remove somente sua ADMISSION e não consulta nem revoga B", async () => {
    let gateState: WebSessionGateState = { state: "CLEAR" };
    const webGate: PersistentWebSessionGate = {
      beginLoginInProgress: async () => {
        gateState = { state: "REVOKE_REQUIRED" };
      },
      beginRevocation: async (expectedUserId) => {
        gateState =
          expectedUserId === undefined
            ? { state: "REVOKE_REQUIRED" }
            : { state: "REVOKE_REQUIRED", expectedUserId };
      },
      beginAdmission: async (expectedUserId) => {
        gateState = { state: "ADMISSION", expectedUserId };
      },
      prepareAdmission: async (expectedUserId) => {
        gateState = { state: "ADMISSION", expectedUserId };
      },
      read: async () => gateState,
      clear: async () => {
        gateState = { state: "CLEAR" };
      },
    };
    const harness = await renderAuthHarness({
      platform: "web",
      webSessionGate: webGate,
      logoutRequest: async (expectedUserId) => {
        throw Object.assign(new Error("cookie pertence a B"), {
          code: "EXPECTED_USER_MISMATCH",
          currentSessionUserId: 32,
          expectedUserId,
        });
      },
      meRequest: async () => ({
        user: null,
        sessionInvalid: false,
        networkOrServerError: true,
        code: "EXPECTED_USER_MISMATCH",
      }),
    });

    await expect(
      harness.auth.rotateSession(async () => ({
        ok: false,
        status: 409,
        code: "EXPECTED_USER_MISMATCH",
        error: "cookie pertence a B",
      })),
    ).resolves.toEqual({
      ok: false,
      error: "A sessão mudou em outra aba antes da operação.",
    });

    expect(gateState).toEqual({ state: "CLEAR" });
    expect(harness.meDetailedApi).toHaveBeenCalledWith(31);
    expect(harness.logoutApi).toHaveBeenCalledWith(undefined, 31, undefined);
    expect(harness.setUser).toHaveBeenCalledWith(null);
    expect(harness.setUser).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 32 }),
    );
  });

  it("gate CLEAR revalida expected A e jamais publica ou revoga o cookie B", async () => {
    let gateState: WebSessionGateState = { state: "CLEAR" };
    const seenExpectedUsers: (number | undefined)[] = [];
    const webGate: PersistentWebSessionGate = {
      beginLoginInProgress: async () => {
        gateState = { state: "REVOKE_REQUIRED" };
      },
      beginRevocation: async (expectedUserId) => {
        gateState =
          expectedUserId === undefined
            ? { state: "REVOKE_REQUIRED" }
            : { state: "REVOKE_REQUIRED", expectedUserId };
      },
      beginAdmission: async () => {
        throw new Error("ADMISSION A foi removida por outra aba");
      },
      prepareAdmission: async (expectedUserId) => {
        gateState = { state: "ADMISSION", expectedUserId };
      },
      read: async () => gateState,
      clear: async () => {
        gateState = { state: "CLEAR" };
      },
    };
    const harness = await renderAuthHarness({
      platform: "web",
      webSessionGate: webGate,
      meRequest: async () => ({
        user: null,
        sessionInvalid: false,
        networkOrServerError: true,
        code: "EXPECTED_USER_MISMATCH",
      }),
      logoutRequest: async (expectedUserId) => {
        seenExpectedUsers.push(expectedUserId);
        const mismatch = new Error("cookie pertence a B");
        Object.assign(mismatch, {
          code: "EXPECTED_USER_MISMATCH",
          currentSessionUserId: 32,
        });
        throw mismatch;
      },
    });
    const operation = vi.fn(async () => ({ ok: true }));

    await expect(harness.auth.rotateSession(operation)).resolves.toMatchObject({
      ok: false,
      error: "Não foi possível preparar a revalidação da sessão web.",
    });

    expect(operation).not.toHaveBeenCalled();
    expect(harness.meDetailedApi).toHaveBeenCalledWith(31);
    expect(seenExpectedUsers).toEqual([31]);
    expect(harness.logoutApi).toHaveBeenCalledWith(undefined, 31, undefined);
    expect(gateState).toEqual({ state: "CLEAR" });
    expect(harness.setUser).toHaveBeenCalledWith(null);
  });

  it("DELETE stale de A abandona só sua receipt e nunca restaura ou revoga B", async () => {
    let gateState: WebSessionGateState = { state: "CLEAR" };
    let cookieBRevoked = false;
    const seenExpectedUsers: (number | undefined)[] = [];
    const webGate: PersistentWebSessionGate = {
      beginLoginInProgress: async () => {
        gateState = { state: "REVOKE_REQUIRED" };
      },
      beginRevocation: async (expectedUserId) => {
        gateState =
          expectedUserId === undefined
            ? { state: "REVOKE_REQUIRED" }
            : { state: "REVOKE_REQUIRED", expectedUserId };
      },
      prepareAdmission: async (expectedUserId) => {
        gateState = { state: "ADMISSION", expectedUserId };
      },
      read: async () => gateState,
      clear: async () => {
        gateState = { state: "CLEAR" };
      },
    };
    const harness = await renderAuthHarness({
      platform: "web",
      webSessionGate: webGate,
      logoutRequest: async (expectedUserId) => {
        seenExpectedUsers.push(expectedUserId);
        if (expectedUserId === undefined) {
          cookieBRevoked = true;
          return;
        }
        throw Object.assign(new Error("cookie pertence a B"), {
          code: "EXPECTED_USER_MISMATCH",
          currentSessionUserId: 32,
        });
      },
      deleteRequest: async () => ({
        ok: false,
        status: 409,
        code: "EXPECTED_USER_MISMATCH",
        error: "cookie pertence a B",
      }),
    });

    await expect(harness.auth.deleteAccount("senha-atual")).resolves.toEqual({
      ok: false,
      status: 409,
      code: "EXPECTED_USER_MISMATCH",
      error: "A sessão mudou em outra aba antes da exclusão.",
    });

    expect(harness.revokeWebSessionQuarantine).toHaveBeenCalledWith(
      31,
      `v1.${"a".repeat(43)}`,
    );
    expect(seenExpectedUsers).toEqual([31]);
    expect(cookieBRevoked).toBe(false);
    expect(gateState).toEqual({ state: "CLEAR" });
    expect(harness.meDetailedApi).not.toHaveBeenCalled();
    expect(harness.logoutApi).toHaveBeenCalledTimes(1);
    expect(harness.setUser).toHaveBeenCalledWith(null);
  });

  it("falha push pré-dispatch só cancela DELETE com sua capability e revalida A", async () => {
    let gateState: WebSessionGateState = { state: "CLEAR" };
    const userA = {
      id: 31,
      name: "Usuário A",
      email: "a@example.com",
      role: "doctor" as const,
    };
    const deleteRequest = vi.fn(async () => ({ ok: true, status: 200 }));
    const webGate: PersistentWebSessionGate = {
      beginLoginInProgress: async () => {
        gateState = { state: "REVOKE_REQUIRED" };
      },
      beginRevocation: async (expectedUserId) => {
        gateState =
          expectedUserId === undefined
            ? { state: "REVOKE_REQUIRED" }
            : { state: "REVOKE_REQUIRED", expectedUserId };
      },
      prepareAdmission: async (expectedUserId) => {
        gateState = { state: "ADMISSION", expectedUserId };
      },
      read: async () => gateState,
      clear: async () => {
        gateState = { state: "CLEAR" };
      },
    };
    const harness = await renderAuthHarness({
      platform: "web",
      webSessionGate: webGate,
      logoutRequest: async () => undefined,
      deleteRequest,
      clearPushFingerprint: async () => {
        throw new Error("prova push indisponível");
      },
      meRequest: async () => ({
        user: userA,
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });

    await expect(harness.auth.deleteAccount("senha-atual")).resolves.toEqual({
      ok: false,
      status: 0,
      error: "Não foi possível preparar a exclusão com segurança.",
    });
    expect(deleteRequest).not.toHaveBeenCalled();
    expect(harness.deleteAccountApi).not.toHaveBeenCalled();
    expect(harness.cancelReversibleWebSessionRevocation).toHaveBeenCalledTimes(
      1,
    );
    expect(harness.revokeWebSessionQuarantine).not.toHaveBeenCalled();
    expect(harness.logoutApi).not.toHaveBeenCalled();
    expect(harness.meDetailedApi).toHaveBeenCalledWith(userA.id);
    expect(harness.setUser).toHaveBeenCalledWith(userA);
    expect(harness.resumeQueryCachePersistence).toHaveBeenCalledTimes(1);
    expect(gateState).toEqual({ state: "CLEAR" });
  });

  it("resposta perdida do logout web resolve somente após retry remoto 2xx, sem /me", async () => {
    const logoutResponse = rejectedDeferred();
    let logoutCalls = 0;
    let gateState: WebSessionGateState = { state: "CLEAR" };
    const webGate: PersistentWebSessionGate = {
      beginLoginInProgress: async () => {
        gateState = { state: "REVOKE_REQUIRED" };
      },
      beginRevocation: async () => {
        gateState = { state: "REVOKE_REQUIRED" };
      },
      prepareAdmission: async (expectedUserId) => {
        gateState = { state: "ADMISSION", expectedUserId };
      },
      read: async () => gateState,
      clear: async () => {
        gateState = { state: "CLEAR" };
      },
    };
    const harness = await renderAuthHarness({
      platform: "web",
      webSessionGate: webGate,
      logoutRequest: () => {
        logoutCalls += 1;
        return logoutCalls === 1 ? logoutResponse.promise : Promise.resolve();
      },
      meRequest: async () => ({
        user: null,
        sessionInvalid: true,
        networkOrServerError: false,
      }),
    });

    const logout = harness.auth.logout();
    await vi.waitFor(() => expect(harness.logoutApi).toHaveBeenCalledTimes(1));
    logoutResponse.reject(new Error("resposta perdida após commit remoto"));

    await expect(logout).resolves.toBeUndefined();

    expect(harness.logoutApi).toHaveBeenCalledTimes(2);
    expect(harness.meDetailedApi).not.toHaveBeenCalled();
    expect(gateState).toEqual({ state: "CLEAR" });
    expect(harness.revokeWebSessionQuarantine).toHaveBeenCalledTimes(2);
    expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
    expect(harness.clearUserInfo).toHaveBeenCalledTimes(1);
    expect(harness.clearPersistedQueryCache).toHaveBeenCalledTimes(1);
    expect(harness.queryClient.clear).toHaveBeenCalledTimes(1);
    expect(harness.clearActiveInstitutionId).toHaveBeenCalledTimes(1);
    expect(harness.setUser).toHaveBeenCalledWith(null);
    expect(harness.openPushRegistrationAdmission).not.toHaveBeenCalled();
    expect(harness.setSessionValidation).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "VERIFIED" }),
    );
    expect(harness.logoutApi.mock.invocationCallOrder[0]).toBeLessThan(
      harness.logoutApi.mock.invocationCallOrder[1],
    );
    expect(harness.logoutApi.mock.invocationCallOrder[1]).toBeLessThan(
      harness.removeSessionToken.mock.invocationCallOrder[0],
    );
  });

  it("logout exact-v1 persiste a instância e o cold retry revoga somente S1", async () => {
    const sessionInstance = `v1.${"a".repeat(43)}`;
    let gateState: WebSessionGateState = { state: "CLEAR" };
    const webGate: PersistentWebSessionGate = {
      beginLoginInProgress: async () => {
        gateState = { state: "REVOKE_REQUIRED" };
      },
      beginRevocation: async (expectedUserId, proof) => {
        gateState = {
          state: "REVOKE_REQUIRED",
          ...(expectedUserId === undefined ? {} : { expectedUserId }),
          ...(proof === undefined ? {} : { sessionInstance: proof }),
        };
      },
      prepareAdmission: async (expectedUserId) => {
        gateState = { state: "ADMISSION", expectedUserId };
      },
      read: async () => gateState,
      clear: async () => {
        gateState = { state: "CLEAR" };
      },
    };
    const firstProcess = await renderAuthHarness({
      platform: "web",
      webSessionGate: webGate,
      logoutRequest: async (expectedUserId, proof) => {
        expect(expectedUserId).toBe(31);
        expect(proof).toBe(sessionInstance);
        throw new Error("500 ao revogar S1");
      },
    });

    const error = await firstProcess.auth.logout().catch((reason) => reason);
    expect(firstProcess.isSessionTerminationNotDurableError(error)).toBe(true);
    expect(gateState).toEqual({
      state: "REVOKE_REQUIRED",
      expectedUserId: 31,
      sessionInstance,
    });
    expect(firstProcess.logoutApi).toHaveBeenCalledTimes(2);
    expect(firstProcess.meDetailedApi).not.toHaveBeenCalled();

    vi.resetModules();
    const reload = await renderAuthHarness({
      platform: "web",
      webSessionGate: webGate,
      logoutRequest: async (expectedUserId, proof) => {
        expect(expectedUserId).toBe(31);
        expect(proof).toBe(sessionInstance);
      },
    });
    await reload.auth.refetch();

    expect(reload.logoutApi).toHaveBeenCalledWith(
      undefined,
      31,
      sessionInstance,
    );
    expect(reload.logoutApi).toHaveBeenCalledTimes(1);
    expect(reload.meDetailedApi).not.toHaveBeenCalled();
    expect(gateState).toEqual({ state: "CLEAR" });
  });

  it("não revoga no servidor se a prova push não puder ser invalidada antes", async () => {
    const fingerprintError = new Error("AsyncStorage indisponível");
    const harness = await renderAuthHarness({
      logoutRequest: async () => undefined,
      clearPushFingerprint: async () => {
        throw fingerprintError;
      },
    });

    const error = await harness.auth.logout().catch((caught) => caught);

    expect(error).toMatchObject({
      name: "SessionTerminationNotDurableError",
      reason: fingerprintError,
    });
    expect(harness.clearPushRegistrationState).toHaveBeenCalledTimes(1);
    expect(harness.logoutApi).not.toHaveBeenCalled();
    expect(harness.removeSessionToken).not.toHaveBeenCalled();
    expect(harness.clearUserInfo).not.toHaveBeenCalled();
    expect(harness.clearActiveInstitutionId).not.toHaveBeenCalled();
    expect(harness.clearPersistedQueryCache).not.toHaveBeenCalled();
    expect(harness.queryClient.clear).not.toHaveBeenCalled();
    expect(harness.setLastPushToken).not.toHaveBeenCalled();
    expect(harness.setUser).not.toHaveBeenCalled();
    expect(harness.openPushRegistrationAdmission).not.toHaveBeenCalled();
    expect(harness.setPushRegistrationRevision).not.toHaveBeenCalled();
    expect(harness.resumeQueryCachePersistence).not.toHaveBeenCalled();
    expect(harness.meDetailedApi).toHaveBeenCalledTimes(1);
    expect(harness.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "UNAVAILABLE" }),
    );
    expect(harness.sequence).toEqual([
      "close-push",
      "fence-query",
      "close-push",
      "suspend-query",
      "wait-push",
      "clear-push-fingerprint",
      "http-me",
    ]);
  });

  it("não aceita /me 401 como revogação quando a barreira push falha antes do logout", async () => {
    const harness = await renderAuthHarness({
      logoutRequest: async () => undefined,
      clearPushFingerprint: async () => {
        throw new Error("AsyncStorage indisponível");
      },
      meRequest: async () => ({
        user: null,
        sessionInvalid: true,
        networkOrServerError: false,
      }),
    });

    await expect(harness.auth.logout()).rejects.toMatchObject({
      name: "SessionTerminationNotDurableError",
    });

    expect(harness.logoutApi).not.toHaveBeenCalled();
    expect(harness.meDetailedApi).toHaveBeenCalledTimes(1);
    expect(harness.removeSessionToken).not.toHaveBeenCalled();
    expect(harness.clearUserInfo).not.toHaveBeenCalled();
    expect(harness.queryClient.clear).not.toHaveBeenCalled();
    expect(harness.clearActiveInstitutionId).not.toHaveBeenCalled();
    expect(harness.setUser).not.toHaveBeenCalledWith(null);
    expect(harness.openPushRegistrationAdmission).not.toHaveBeenCalled();
    expect(harness.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "UNAVAILABLE" }),
    );
  });

  it("após rotação nativa salva o novo Bearer e força re-registro push deste aparelho", async () => {
    const harness = await renderAuthHarness({
      logoutRequest: async () => undefined,
      platform: "ios",
      meRequest: async () => ({
        user: {
          id: 31,
          name: "Usuário revalidado",
          email: "ativo@example.com",
          role: "doctor",
        },
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });

    const result = await harness.auth.rotateSession(async () => {
      harness.sequence.push("http-change-password");
      return { ok: true, token: "sessão-nova" };
    });

    expect(result).toEqual({ ok: true });
    expect(harness.setSessionToken).toHaveBeenCalledWith("sessão-nova", 31);
    expect(harness.clearPushRegistrationState).toHaveBeenCalledTimes(1);
    expect(harness.openPushRegistrationAdmission).toHaveBeenCalledTimes(1);
    expect(harness.setPushRegistrationRevision).toHaveBeenCalledTimes(1);
    expect(harness.sequence).toEqual([
      "close-push",
      "fence-query",
      "close-push",
      "wait-push",
      "clear-push-fingerprint",
      "http-change-password",
      "set-session-token",
      "set-user-info:31",
      "commit-session-token",
      "http-me",
      "set-user-info:31",
      "set-user:present",
      "open-push",
      "set-push-revision:1",
    ]);
    expect(harness.queryClient.clear).not.toHaveBeenCalled();
    expect(harness.setUser).toHaveBeenCalledTimes(1);
    expect(harness.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "VERIFIED", userId: 31 }),
    );
  });

  it("não chama change-password se a barreira push não for durável", async () => {
    const fingerprintError = new Error("AsyncStorage indisponível");
    const harness = await renderAuthHarness({
      logoutRequest: async () => undefined,
      platform: "ios",
      clearPushFingerprint: async () => {
        throw fingerprintError;
      },
    });
    const changePassword = vi.fn(async () => ({
      ok: true,
      token: "sessão-nova",
    }));

    await expect(harness.auth.rotateSession(changePassword)).resolves.toEqual({
      ok: false,
      error: "Não foi possível preparar com segurança a troca de senha.",
    });

    expect(changePassword).not.toHaveBeenCalled();
    expect(harness.openPushRegistrationAdmission).not.toHaveBeenCalled();
    expect(harness.setPushRegistrationRevision).not.toHaveBeenCalled();
    expect(harness.sequence).toEqual([
      "close-push",
      "fence-query",
      "close-push",
      "wait-push",
      "clear-push-fingerprint",
      "http-me",
    ]);
  });

  it("encerra estado autenticado se rotação confirmada não devolver novo Bearer", async () => {
    const harness = await renderAuthHarness({
      logoutRequest: async () => undefined,
      platform: "ios",
    });

    await expect(
      harness.auth.rotateSession(async () => {
        harness.sequence.push("http-change-password");
        return { ok: true };
      }),
    ).resolves.toEqual({
      ok: false,
      error: "O servidor não devolveu uma sessão válida.",
    });

    expect(harness.setSessionToken).not.toHaveBeenCalled();
    expect(harness.setUser).toHaveBeenCalledWith(null);
    expect(harness.queryClient.clear).toHaveBeenCalledTimes(1);
    expect(harness.clearActiveInstitutionId).toHaveBeenCalledTimes(1);
    expect(harness.openPushRegistrationAdmission).not.toHaveBeenCalled();
    expect(harness.setPushRegistrationRevision).not.toHaveBeenCalled();
    expect(harness.sequence).toEqual([
      "close-push",
      "fence-query",
      "close-push",
      "wait-push",
      "clear-push-fingerprint",
      "http-change-password",
      "close-push",
      "fence-query",
      "set-last-push:null",
      "wait-push",
      "remove-session-token",
      "clear-user-info",
      "clear-query-persisted",
      "clear-query-memory",
      "clear-active-tenant",
      "set-user:null",
    ]);
  });

  it("encerra estado autenticado se novo Bearer não puder ser persistido", async () => {
    const secureStoreError = new Error("SecureStore indisponível");
    const harness = await renderAuthHarness({
      logoutRequest: async () => undefined,
      platform: "ios",
      persistSessionToken: async () => {
        throw secureStoreError;
      },
    });

    await expect(
      harness.auth.rotateSession(async () => {
        harness.sequence.push("http-change-password");
        return { ok: true, token: "sessão-nova" };
      }),
    ).resolves.toEqual({
      ok: false,
      error:
        "A senha foi alterada, mas a nova sessão não pôde ser salva com segurança.",
    });

    expect(harness.setSessionToken).toHaveBeenCalledWith("sessão-nova", 31);
    expect(harness.setUser).toHaveBeenCalledWith(null);
    expect(harness.queryClient.clear).toHaveBeenCalledTimes(1);
    expect(harness.clearActiveInstitutionId).toHaveBeenCalledTimes(1);
    expect(harness.openPushRegistrationAdmission).not.toHaveBeenCalled();
    expect(harness.setPushRegistrationRevision).not.toHaveBeenCalled();
    expect(harness.sequence).toEqual([
      "close-push",
      "fence-query",
      "close-push",
      "wait-push",
      "clear-push-fingerprint",
      "http-change-password",
      "set-session-token",
      "close-push",
      "fence-query",
      "wait-push",
      "http-revoke-token:sessão-nova",
      "mark-revoked-cleanup:31",
      "close-push",
      "fence-query",
      "set-last-push:null",
      "wait-push",
      "remove-session-token",
      "clear-user-info",
      "clear-query-persisted",
      "clear-query-memory",
      "clear-active-tenant",
      "set-user:null",
    ]);
  });

  it("serializa rotações e só a intenção mais recente pode reabrir após /me canônico", async () => {
    const remoteA = deferred<{ ok: boolean; token?: string; error?: string }>();
    const harness = await renderAuthHarness({
      logoutRequest: async () => undefined,
      platform: "ios",
      meRequest: async () => ({
        user: {
          id: 31,
          name: "Usuário atual",
          email: "ativo@example.com",
          role: "doctor",
        },
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });
    const operationA = vi.fn(() => {
      harness.sequence.push("http-change-password:A");
      return remoteA.promise;
    });
    const operationB = vi.fn(async () => {
      harness.sequence.push("http-change-password:B");
      return { ok: false, error: "senha anterior já revogada" };
    });

    const resultA = harness.auth.rotateSession(operationA);
    await vi.waitFor(() => expect(operationA).toHaveBeenCalledTimes(1));
    const resultB = harness.auth.rotateSession(operationB);
    expect(operationB).not.toHaveBeenCalled();

    remoteA.resolve({ ok: true, token: "token-A" });
    await expect(resultA).resolves.toEqual({
      ok: false,
      error:
        "A operação foi recebida, mas a nova sessão ainda não pôde ser revalidada.",
    });
    await expect(resultB).resolves.toEqual({
      ok: false,
      error: "A sessão anterior ainda está sendo reconciliada.",
    });

    expect(operationB).not.toHaveBeenCalled();
    expect(harness.clearPushRegistrationState).toHaveBeenCalledTimes(1);
    expect(harness.openPushRegistrationAdmission).toHaveBeenCalledTimes(1);
    expect(harness.setSessionToken).toHaveBeenCalledWith("token-A", 31);
    expect(harness.sequence).not.toContain("http-change-password:B");
    expect(harness.sequence.lastIndexOf("http-me")).toBeLessThan(
      harness.sequence.lastIndexOf("open-push"),
    );
  });

  it("rotação enfileirada não chama o servidor enquanto a anterior está UNAVAILABLE", async () => {
    const remoteA = deferred<{ ok: boolean; token?: string; error?: string }>();
    const harness = await renderAuthHarness({
      logoutRequest: async () => undefined,
      platform: "ios",
      meRequest: async () => ({
        user: null,
        sessionInvalid: false,
        networkOrServerError: true,
      }),
    });
    const operationA = vi.fn(() => remoteA.promise);
    const operationB = vi.fn(async () => ({ ok: true, token: "token-C" }));

    const resultA = harness.auth.rotateSession(operationA);
    await vi.waitFor(() => expect(operationA).toHaveBeenCalledTimes(1));
    const resultB = harness.auth.rotateSession(operationB);
    remoteA.resolve({ ok: false, error: "500 ambíguo" });

    await expect(resultA).resolves.toEqual({
      ok: false,
      error: "500 ambíguo",
    });
    await expect(resultB).resolves.toEqual({
      ok: false,
      error: "A sessão anterior ainda está sendo reconciliada.",
    });
    expect(operationB).not.toHaveBeenCalled();
    expect(harness.setSessionToken).not.toHaveBeenCalled();
    expect(harness.meDetailedApi).toHaveBeenCalledTimes(1);
    expect(harness.openPushRegistrationAdmission).not.toHaveBeenCalled();
    expect(harness.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "UNAVAILABLE" }),
    );
  });

  it("rotação negativa seguida de /me 401 encerra a sessão sem VERIFIED antigo", async () => {
    const harness = await renderAuthHarness({
      logoutRequest: async () => undefined,
      platform: "ios",
      meRequest: async () => ({
        user: null,
        sessionInvalid: true,
        networkOrServerError: false,
      }),
    });

    await expect(
      harness.auth.rotateSession(async () => ({
        ok: false,
        error: "401 após commit remoto",
      })),
    ).resolves.toEqual({ ok: false, error: "401 após commit remoto" });

    expect(harness.meDetailedApi).toHaveBeenCalledTimes(1);
    expect(harness.setUser).toHaveBeenCalledWith(null);
    expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
    expect(harness.openPushRegistrationAdmission).not.toHaveBeenCalled();
    expect(harness.setSessionValidation.mock.calls).not.toContainEqual([
      expect.objectContaining({ status: "VERIFIED" }),
    ]);
  });

  it("rotação negativa 500 com /me indisponível permanece bloqueada", async () => {
    const harness = await renderAuthHarness({
      logoutRequest: async () => undefined,
      platform: "ios",
      meRequest: async () => ({
        user: null,
        sessionInvalid: false,
        networkOrServerError: true,
      }),
    });

    await expect(
      harness.auth.rotateSession(async () => ({
        ok: false,
        error: "500 ambíguo",
      })),
    ).resolves.toEqual({
      ok: false,
      error: "Não foi possível confirmar o resultado da troca de senha.",
    });

    expect(harness.meDetailedApi).toHaveBeenCalledTimes(1);
    expect(harness.openPushRegistrationAdmission).not.toHaveBeenCalled();
    expect(harness.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "UNAVAILABLE" }),
    );
  });

  it("login B encerra transporte e UI se persistir identidade B falha após Bearer", async () => {
    const userB = {
      id: 32,
      name: "Usuário B",
      email: "b@example.com",
      role: "doctor" as const,
    };
    const harness = await renderAuthHarness({
      logoutRequest: async () => undefined,
      platform: "ios",
      admittedSessionUserId: null,
      admittedSessionToken: null,
      loginRequest: async () => ({ ok: true, user: userB, token: "token-B" }),
      persistUser: async () => {
        throw new Error("AsyncStorage indisponível");
      },
    });

    await expect(harness.auth.login(userB.email, "senha-B")).resolves.toEqual({
      ok: false,
      error: "Não foi possível concluir o login com segurança neste aparelho.",
    });

    expect(harness.setSessionToken).toHaveBeenCalledWith("token-B", 32);
    expect(harness.setUserInfo).toHaveBeenCalledWith(userB);
    expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
    expect(harness.setUser).toHaveBeenCalledWith(null);
    expect(harness.openPushRegistrationAdmission).not.toHaveBeenCalled();
    expect(harness.sequence).toEqual([
      "close-push",
      "fence-query",
      "close-push",
      "fence-query",
      "set-user:null",
      "http-login",
      "set-session-token",
      "clear-query-memory",
      "clear-active-tenant",
      "set-user-info:32",
      "close-push",
      "fence-query",
      "wait-push",
      "clear-push-fingerprint",
      "http-revoke-token:token-B",
      "mark-revoked-cleanup:32",
      "close-push",
      "fence-query",
      "set-last-push:null",
      "wait-push",
      "remove-session-token",
      "clear-user-info",
      "clear-query-persisted",
      "clear-query-memory",
      "clear-active-tenant",
      "set-user:null",
    ]);
  });

  it("rollback nativo 500 mantém B atrás do marker e cold restart revoga antes de /me", async () => {
    const userB = {
      id: 32,
      name: "Usuário B",
      email: "b@example.com",
      role: "doctor" as const,
    };
    let markerActive = false;
    let stagedToken: string | null = null;
    let revokeAvailable = false;
    const quarantine = {
      stage: vi.fn(async (token: string) => {
        markerActive = true;
        stagedToken = token;
      }),
      commit: vi.fn(async () => {
        markerActive = false;
      }),
      isActive: vi.fn(async () => markerActive),
      getToken: vi.fn(async () => stagedToken),
    };
    const firstProcess = await renderAuthHarness({
      logoutRequest: async () => undefined,
      platform: "ios",
      admittedSessionUserId: null,
      admittedSessionToken: null,
      nativeSessionQuarantine: quarantine,
      loginRequest: async () => ({ ok: true, user: userB, token: "token-B" }),
      persistUser: async () => {
        throw new Error("identidade indisponível");
      },
      revokeTokenRequest: async () => {
        if (!revokeAvailable) throw new Error("500 ambíguo");
      },
    });

    await expect(
      firstProcess.auth.login(userB.email, "senha-B"),
    ).resolves.toEqual({
      ok: false,
      error:
        "Login bloqueado: o servidor ainda não confirmou a revogação desta sessão.",
    });
    expect(firstProcess.revokeSessionTokenApi).toHaveBeenCalledWith("token-B");
    expect(markerActive).toBe(true);
    expect(stagedToken).toBe("token-B");
    expect(firstProcess.removeSessionToken).not.toHaveBeenCalled();
    expect(firstProcess.setUser).toHaveBeenCalledWith(null);

    revokeAvailable = true;
    vi.resetModules();
    const restarted = await renderAuthHarness({
      logoutRequest: async () => undefined,
      platform: "ios",
      nativeSessionQuarantine: quarantine,
      revokeTokenRequest: async (token) => {
        expect(token).toBe("token-B");
        stagedToken = null;
      },
      meRequest: async () => ({
        user: userB,
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });
    await restarted.auth.refetch();

    expect(restarted.revokeSessionTokenApi).toHaveBeenCalledWith("token-B");
    expect(restarted.meDetailedApi).not.toHaveBeenCalled();
    expect(restarted.setUser).toHaveBeenCalledWith(null);
    expect(restarted.setUser).not.toHaveBeenCalledWith(userB);
  });

  it("stage B falho sem binding não preserva o Bearer A quando revoke B também falha", async () => {
    const userB = {
      id: 32,
      name: "Usuário B",
      email: "b@example.com",
      role: "doctor" as const,
    };
    const harness = await renderAuthHarness({
      logoutRequest: async () => undefined,
      platform: "ios",
      admittedSessionUserId: null,
      admittedSessionToken: null,
      loginRequest: async () => ({ ok: true, user: userB, token: "token-B" }),
      persistSessionToken: async () => {
        // Falha antes de instalar marker/binding B: o slot durável ainda pode
        // conter A e, portanto, jamais deve ser preservado como se fosse B.
        throw new Error("marker B indisponível");
      },
      revokeTokenRequest: async () => {
        throw new Error("500 ambíguo ao revogar B");
      },
      nativeSessionQuarantine: {
        stage: async () => undefined,
        commit: async () => undefined,
        isActive: async () => false,
        getToken: async () => {
          throw new Error("nenhum binding B instalado");
        },
      },
    });

    await expect(harness.auth.login(userB.email, "senha-B")).resolves.toEqual({
      ok: false,
      error:
        "Login bloqueado: o servidor ainda não confirmou a revogação desta sessão.",
    });

    expect(harness.revokeSessionTokenApi).toHaveBeenCalledWith("token-B");
    expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
    expect(harness.clearUserInfo).toHaveBeenCalledTimes(1);
    expect(harness.clearActiveInstitutionId).toHaveBeenCalledTimes(1);
    expect(harness.setUser).toHaveBeenCalledWith(null);
    expect(harness.openPushRegistrationAdmission).not.toHaveBeenCalled();
  });

  it("marker nativo incerto nunca vira logout confirmado sem Bearer explícito", async () => {
    const harness = await renderAuthHarness({
      logoutRequest: async () => undefined,
      platform: "ios",
      nativeSessionQuarantine: {
        stage: async () => undefined,
        commit: async () => undefined,
        isActive: async () => true,
        getToken: async () => {
          throw new Error("marker mudou entre as leituras");
        },
      },
      meRequest: async () => ({
        user: null,
        sessionInvalid: true,
        networkOrServerError: false,
      }),
    });

    await harness.auth.refetch();

    expect(harness.revokeSessionTokenApi).not.toHaveBeenCalled();
    expect(harness.meDetailedApi).not.toHaveBeenCalled();
    expect(harness.removeSessionToken).not.toHaveBeenCalled();
    expect(harness.setUser).not.toHaveBeenCalledWith(null);
    expect(harness.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "UNAVAILABLE",
      }),
    );
  });

  it("quarentena ativa com getter vazio nunca fabrica revogação confirmada", async () => {
    const harness = await renderAuthHarness({
      logoutRequest: async () => undefined,
      platform: "ios",
      nativeSessionQuarantine: {
        stage: async () => undefined,
        commit: async () => undefined,
        isActive: async () => true,
        getToken: async () => null,
      },
    });

    await harness.auth.refetch();

    expect(harness.revokeSessionTokenApi).not.toHaveBeenCalled();
    expect(harness.meDetailedApi).not.toHaveBeenCalled();
    expect(harness.removeSessionToken).not.toHaveBeenCalled();
    expect(harness.setUser).not.toHaveBeenCalledWith(null);
    expect(harness.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "UNAVAILABLE",
      }),
    );
  });

  it("falha ao liberar marker após identidade B persistida revoga exatamente B e nunca publica React", async () => {
    const userB = {
      id: 32,
      name: "Usuário B",
      email: "b@example.com",
      role: "doctor" as const,
    };
    const harness = await renderAuthHarness({
      logoutRequest: async () => undefined,
      platform: "ios",
      loginRequest: async () => ({ ok: true, user: userB, token: "token-B" }),
      commitSessionToken: async () => {
        throw new Error("release indisponível");
      },
      revokeTokenRequest: async () => undefined,
    });

    await expect(harness.auth.login(userB.email, "senha-B")).resolves.toEqual({
      ok: false,
      error: "Não foi possível concluir o login com segurança neste aparelho.",
    });

    expect(harness.setUserInfo).toHaveBeenCalledWith(userB);
    expect(harness.commitStagedSessionToken).toHaveBeenCalledTimes(1);
    expect(harness.revokeSessionTokenApi).toHaveBeenCalledWith("token-B");
    expect(harness.setUser).not.toHaveBeenCalledWith(userB);
    expect(harness.setUser).toHaveBeenCalledWith(null);
  });

  it("gate web pendente repete logout e bloqueia todo POST de login até receber 2xx", async () => {
    const userB = {
      id: 32,
      name: "Usuário B",
      email: "b@example.com",
      role: "doctor" as const,
    };
    let gateState: WebSessionGateState = { state: "REVOKE_REQUIRED" };
    let remoteLogoutAvailable = false;
    const transitions: string[] = [];
    const webGate: PersistentWebSessionGate = {
      beginLoginInProgress: async () => {
        transitions.push("begin-login");
        gateState = { state: "REVOKE_REQUIRED" };
      },
      beginRevocation: async () => {
        gateState = { state: "REVOKE_REQUIRED" };
      },
      prepareAdmission: async (expectedUserId) => {
        transitions.push(`admission:${expectedUserId}`);
        gateState = { state: "ADMISSION", expectedUserId };
      },
      read: async () => gateState,
      clear: async () => {
        transitions.push("clear");
        gateState = { state: "CLEAR" };
      },
    };
    const harness = await renderAuthHarness({
      platform: "web",
      webSessionGate: webGate,
      logoutRequest: async () => {
        transitions.push("logout");
        if (!remoteLogoutAvailable)
          throw new Error("500 ao revogar cookie anterior");
      },
      loginRequest: async () => {
        transitions.push("login-post");
        return { ok: true, user: userB };
      },
      meRequest: async () => {
        transitions.push("me");
        return {
          user: userB,
          sessionInvalid: false,
          networkOrServerError: false,
        };
      },
    });
    const blocked = {
      ok: false,
      error: "Login bloqueado: a sessão anterior ainda exige revogação.",
    };

    await expect(harness.auth.login(userB.email, "senha-B")).resolves.toEqual(
      blocked,
    );
    await expect(harness.auth.login(userB.email, "senha-B")).resolves.toEqual(
      blocked,
    );

    expect(harness.logoutApi).toHaveBeenCalledTimes(2);
    expect(harness.loginApi).not.toHaveBeenCalled();
    expect(harness.beginWebLoginInProgress).not.toHaveBeenCalled();
    expect(harness.meDetailedApi).not.toHaveBeenCalled();
    expect(gateState).toEqual({ state: "REVOKE_REQUIRED" });

    remoteLogoutAvailable = true;
    await expect(harness.auth.login(userB.email, "senha-B")).resolves.toEqual({
      ok: true,
    });

    expect(harness.logoutApi).toHaveBeenCalledTimes(3);
    expect(harness.loginApi).toHaveBeenCalledTimes(1);
    expect(harness.beginWebLoginInProgress).toHaveBeenCalledTimes(1);
    expect(harness.prepareWebSessionAdmission).toHaveBeenCalledWith(userB.id);
    expect(harness.meDetailedApi).toHaveBeenCalledTimes(1);
    expect(gateState).toEqual({ state: "CLEAR" });
    expect(transitions.indexOf("begin-login")).toBeLessThan(
      transitions.indexOf("login-post"),
    );
    expect(transitions.indexOf(`admission:${userB.id}`)).toBeLessThan(
      transitions.indexOf("me"),
    );
    expect(harness.setUser).toHaveBeenCalledWith(userB);
  });

  it("ADMISSION web rejeita A e vira REVOKE_REQUIRED durável se logout der 500", async () => {
    const userB = {
      id: 32,
      name: "Usuário B",
      email: "b@example.com",
      role: "doctor" as const,
    };
    const userA = {
      id: 31,
      name: "Usuário A",
      email: "a@example.com",
      role: "doctor" as const,
    };
    let gateState: WebSessionGateState = { state: "CLEAR" };
    let logoutAvailable = false;
    const webGate: PersistentWebSessionGate = {
      beginLoginInProgress: async () => {
        gateState = { state: "REVOKE_REQUIRED" };
      },
      beginRevocation: async () => {
        gateState = { state: "REVOKE_REQUIRED" };
      },
      prepareAdmission: async (expectedUserId) => {
        gateState = { state: "ADMISSION", expectedUserId };
      },
      read: async () => gateState,
      clear: async () => {
        gateState = { state: "CLEAR" };
      },
    };
    const firstProcess = await renderAuthHarness({
      platform: "web",
      webSessionGate: webGate,
      loginRequest: async () => ({ ok: true, user: userB }),
      logoutRequest: async () => undefined,
      meRequest: async () => ({
        user: null,
        sessionInvalid: false,
        networkOrServerError: true,
      }),
    });

    await expect(
      firstProcess.auth.login(userB.email, "senha-B"),
    ).resolves.toEqual({
      ok: false,
      error:
        "O login foi recebido, mas a sessão ainda não pôde ser revalidada.",
      admissionPending: true,
    });
    expect(gateState).toEqual({ state: "ADMISSION", expectedUserId: userB.id });
    expect(firstProcess.setUser).not.toHaveBeenCalledWith(userB);
    expect(firstProcess.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "UNAVAILABLE",
        durableSession: true,
      }),
    );

    vi.resetModules();
    const mismatchReload = await renderAuthHarness({
      platform: "web",
      webSessionGate: webGate,
      logoutRequest: async () => {
        if (!logoutAvailable) throw new Error("500 ao revogar cookie B");
      },
      meRequest: async () => ({
        user: userA,
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });
    await mismatchReload.auth.refetch();

    expect(mismatchReload.meDetailedApi).toHaveBeenCalledTimes(1);
    expect(mismatchReload.logoutApi).toHaveBeenCalledTimes(1);
    expect(mismatchReload.revokeWebSessionQuarantine).toHaveBeenCalledTimes(1);
    expect(gateState).toEqual({ state: "REVOKE_REQUIRED" });
    expect(mismatchReload.setUser).not.toHaveBeenCalledWith(userA);
    expect(mismatchReload.setUser).not.toHaveBeenCalledWith(userB);

    logoutAvailable = true;
    vi.resetModules();
    const retry = await renderAuthHarness({
      platform: "web",
      webSessionGate: webGate,
      logoutRequest: async () => undefined,
      meRequest: async () => ({
        user: userA,
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });
    await retry.auth.refetch();

    expect(retry.meDetailedApi).not.toHaveBeenCalled();
    expect(retry.logoutApi).toHaveBeenCalledTimes(1);
    expect(gateState).toEqual({ state: "CLEAR" });
    expect(retry.setUser).not.toHaveBeenCalledWith(userA);
    expect(retry.setUser).not.toHaveBeenCalledWith(userB);
  });

  it("write no-op da ADMISSION após Set-Cookie mantém REVOKE_REQUIRED para o reload", async () => {
    const userB = {
      id: 32,
      name: "Usuário B",
      email: "b@example.com",
      role: "doctor" as const,
    };
    let gateState: WebSessionGateState = { state: "CLEAR" };
    let remoteLogoutAvailable = false;
    const webGate: PersistentWebSessionGate = {
      beginLoginInProgress: async () => {
        gateState = { state: "REVOKE_REQUIRED" };
      },
      beginRevocation: async () => {
        gateState = { state: "REVOKE_REQUIRED" };
      },
      prepareAdmission: async () => {
        // Simula setItem que retorna sem aplicar; a leitura de confirmação falha.
        throw new Error("ADMISSION não persistida");
      },
      read: async () => gateState,
      clear: async () => {
        gateState = { state: "CLEAR" };
      },
    };
    let logoutCalls = 0;
    const firstProcess = await renderAuthHarness({
      platform: "web",
      webSessionGate: webGate,
      loginRequest: async () => ({ ok: true, user: userB }),
      logoutRequest: async () => {
        logoutCalls += 1;
        if (logoutCalls > 1 && !remoteLogoutAvailable) {
          throw new Error("rede indisponível");
        }
      },
    });

    await expect(
      firstProcess.auth.login(userB.email, "senha-B"),
    ).resolves.toEqual({
      ok: false,
      error:
        "Login bloqueado: o servidor ainda não confirmou a revogação desta sessão.",
    });
    expect(firstProcess.loginApi).toHaveBeenCalledTimes(1);
    expect(firstProcess.prepareWebSessionAdmission).toHaveBeenCalledWith(
      userB.id,
    );
    expect(firstProcess.meDetailedApi).not.toHaveBeenCalled();
    expect(gateState).toEqual({ state: "REVOKE_REQUIRED" });

    remoteLogoutAvailable = true;
    vi.resetModules();
    const reload = await renderAuthHarness({
      platform: "web",
      webSessionGate: webGate,
      logoutRequest: async () => undefined,
      meRequest: async () => ({
        user: userB,
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });
    await reload.auth.refetch();

    expect(reload.logoutApi).toHaveBeenCalledTimes(1);
    expect(reload.meDetailedApi).not.toHaveBeenCalled();
    expect(gateState).toEqual({ state: "CLEAR" });
    expect(reload.setUser).not.toHaveBeenCalledWith(userB);
  });

  it("clear da ADMISSION aplicado com ACK perdido exige /me fresco no reload", async () => {
    const userB = {
      id: 32,
      name: "Usuário B",
      email: "b@example.com",
      role: "doctor" as const,
    };
    let gateState: WebSessionGateState = { state: "CLEAR" };
    let clearCalls = 0;
    const webGate: PersistentWebSessionGate = {
      beginLoginInProgress: async () => {
        gateState = { state: "REVOKE_REQUIRED" };
      },
      beginRevocation: async () => {
        gateState = { state: "REVOKE_REQUIRED" };
      },
      prepareAdmission: async (expectedUserId) => {
        gateState = { state: "ADMISSION", expectedUserId };
      },
      read: async () => gateState,
      clear: async () => {
        clearCalls += 1;
        gateState = { state: "CLEAR" };
        if (clearCalls === 2) throw new Error("ACK da remoção perdido");
      },
    };
    const firstProcess = await renderAuthHarness({
      platform: "web",
      webSessionGate: webGate,
      loginRequest: async () => ({ ok: true, user: userB }),
      logoutRequest: async () => undefined,
      meRequest: async () => ({
        user: userB,
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });

    await expect(
      firstProcess.auth.login(userB.email, "senha-B"),
    ).resolves.toEqual({
      ok: false,
      error:
        "O login foi recebido, mas a sessão ainda não pôde ser revalidada.",
      admissionPending: true,
    });
    expect(firstProcess.meDetailedApi).toHaveBeenCalledTimes(1);
    expect(firstProcess.setUser).not.toHaveBeenCalledWith(userB);
    expect(gateState).toEqual({ state: "CLEAR" });

    vi.resetModules();
    const reload = await renderAuthHarness({
      platform: "web",
      webSessionGate: webGate,
      logoutRequest: async () => undefined,
      meRequest: async () => ({
        user: userB,
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });
    await reload.auth.refetch();

    expect(reload.meDetailedApi).toHaveBeenCalledTimes(1);
    expect(reload.logoutApi).not.toHaveBeenCalled();
    expect(reload.setUser).toHaveBeenCalledWith(userB);
  });

  it("reload web com user_info e /me indisponível mantém admissão pendente até a prova", async () => {
    const userB = {
      id: 32,
      name: "Usuário B",
      email: "b@example.com",
      role: "doctor" as const,
    };
    const webGate: PersistentWebSessionGate = {
      beginLoginInProgress: async () => undefined,
      beginRevocation: async () => undefined,
      prepareAdmission: async () => undefined,
      read: async () => ({ state: "CLEAR" }),
      clear: async () => undefined,
    };

    const firstReload = await renderAuthHarness({
      platform: "web",
      webSessionGate: webGate,
      meRequest: async () => ({
        user: null,
        sessionInvalid: false,
        networkOrServerError: true,
      }),
    });
    await firstReload.setUserInfo(userB);
    await firstReload.auth.refetch();

    expect(firstReload.setUser).not.toHaveBeenCalledWith(userB);
    expect(firstReload.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: "UNAVAILABLE",
        durableSession: true,
      }),
    );

    vi.resetModules();
    const secondReload = await renderAuthHarness({
      platform: "web",
      webSessionGate: webGate,
      meRequest: async () => ({
        user: userB,
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });
    await secondReload.setUserInfo(userB);
    await secondReload.auth.refetch();

    expect(secondReload.setUser).toHaveBeenCalledWith(userB);
    expect(secondReload.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "VERIFIED", userId: userB.id }),
    );
  });

  it("login web revoga o cookie no servidor antes de liberar a quarentena após falha local", async () => {
    const userB = {
      id: 32,
      name: "Usuário B",
      email: "b@example.com",
      role: "doctor" as const,
    };
    let cookieBIsValid = false;
    let gateState: WebSessionGateState = { state: "CLEAR" };
    const webGate: PersistentWebSessionGate = {
      beginLoginInProgress: vi.fn(async () => {
        gateState = { state: "REVOKE_REQUIRED" };
      }),
      beginRevocation: vi.fn(async () => {
        gateState = { state: "REVOKE_REQUIRED" };
      }),
      prepareAdmission: vi.fn(async (expectedUserId) => {
        gateState = { state: "ADMISSION", expectedUserId };
      }),
      read: vi.fn(async () => gateState),
      clear: vi.fn(async () => {
        gateState = { state: "CLEAR" };
      }),
    };
    const harness = await renderAuthHarness({
      platform: "web",
      webSessionGate: webGate,
      loginRequest: async () => {
        cookieBIsValid = true;
        return { ok: true, user: userB };
      },
      persistUser: async () => {
        throw new Error("AsyncStorage indisponível");
      },
      logoutRequest: async () => {
        cookieBIsValid = false;
      },
    });

    await expect(harness.auth.login(userB.email, "senha-B")).resolves.toEqual({
      ok: false,
      error: "Não foi possível concluir o login com segurança neste aparelho.",
    });

    expect(harness.beginWebLoginInProgress).toHaveBeenCalledTimes(1);
    expect(harness.logoutApi).toHaveBeenCalledTimes(2);
    expect(harness.revokeWebSessionQuarantine).toHaveBeenCalledTimes(2);
    expect(harness.logoutApi.mock.invocationCallOrder[0]).toBeLessThan(
      harness.loginApi.mock.invocationCallOrder[0],
    );
    expect(
      harness.beginWebLoginInProgress.mock.invocationCallOrder[0],
    ).toBeLessThan(harness.loginApi.mock.invocationCallOrder[0]);
    expect(harness.loginApi.mock.invocationCallOrder[0]).toBeLessThan(
      harness.logoutApi.mock.invocationCallOrder[1],
    );
    expect(cookieBIsValid).toBe(false);
    expect(gateState).toEqual({ state: "CLEAR" });
    expect(harness.meDetailedApi).not.toHaveBeenCalled();
    expect(harness.setUser).toHaveBeenCalledWith(null);

    // Reload realístico: sem marker, /me observa que o fence servidor já
    // invalidou B e nunca volta a publicar a identidade do login interrompido.
    vi.resetModules();
    const reload = await renderAuthHarness({
      platform: "web",
      webSessionGate: webGate,
      logoutRequest: async () => undefined,
      meRequest: async () => ({
        user: cookieBIsValid ? userB : null,
        sessionInvalid: !cookieBIsValid,
        networkOrServerError: false,
      }),
    });
    await reload.auth.refetch();
    expect(reload.meDetailedApi).toHaveBeenCalledTimes(1);
    expect(reload.setUser).toHaveBeenCalledWith(null);
    expect(reload.setUser).not.toHaveBeenCalledWith(userB);
  });

  it("falha do rollback web mantém quarentena durável e o reload revoga antes de /me", async () => {
    const userB = {
      id: 32,
      name: "Usuário B",
      email: "b@example.com",
      role: "doctor" as const,
    };
    let gateState: WebSessionGateState = { state: "CLEAR" };
    let remoteLogoutAvailable = false;
    const webGate: PersistentWebSessionGate = {
      beginLoginInProgress: vi.fn(async () => {
        gateState = { state: "REVOKE_REQUIRED" };
      }),
      beginRevocation: vi.fn(async () => {
        gateState = { state: "REVOKE_REQUIRED" };
      }),
      prepareAdmission: vi.fn(async (expectedUserId) => {
        gateState = { state: "ADMISSION", expectedUserId };
      }),
      read: vi.fn(async () => gateState),
      clear: vi.fn(async () => {
        gateState = { state: "CLEAR" };
      }),
    };
    let logoutCalls = 0;
    const firstProcess = await renderAuthHarness({
      platform: "web",
      webSessionGate: webGate,
      loginRequest: async () => ({ ok: true, user: userB }),
      persistUser: async () => {
        throw new Error("AsyncStorage indisponível");
      },
      logoutRequest: async () => {
        logoutCalls += 1;
        if (logoutCalls > 1 && !remoteLogoutAvailable) {
          throw new Error("rede indisponível");
        }
      },
    });

    await expect(
      firstProcess.auth.login(userB.email, "senha-B"),
    ).resolves.toEqual({
      ok: false,
      error:
        "Login bloqueado: o servidor ainda não confirmou a revogação desta sessão.",
    });
    expect(firstProcess.logoutApi).toHaveBeenCalledTimes(2);
    expect(firstProcess.revokeWebSessionQuarantine).toHaveBeenCalledTimes(2);
    expect(firstProcess.setUser).toHaveBeenCalledWith(null);
    expect(firstProcess.meDetailedApi).not.toHaveBeenCalled();
    expect(gateState).toEqual({ state: "REVOKE_REQUIRED" });

    // Novo processo/reconnect: marker compartilhado barra /me, repete o
    // logout serializado e só então libera o cold start.
    remoteLogoutAvailable = true;
    vi.resetModules();
    const reload = await renderAuthHarness({
      platform: "web",
      webSessionGate: webGate,
      logoutRequest: async () => {
        if (!remoteLogoutAvailable) throw new Error("rede indisponível");
      },
      meRequest: async () => ({
        user: userB,
        sessionInvalid: false,
        networkOrServerError: false,
      }),
    });
    await reload.auth.refetch();

    // performRefetch lê o gate e o helper de revogação o relê dentro do mesmo
    // Web Lock antes de prender o expected-user ao POST terminal.
    expect(reload.getWebSessionGateState).toHaveBeenCalledTimes(2);
    expect(reload.logoutApi).toHaveBeenCalledTimes(1);
    expect(reload.revokeWebSessionQuarantine).toHaveBeenCalledTimes(1);
    expect(reload.meDetailedApi).not.toHaveBeenCalled();
    expect(reload.setUser).toHaveBeenCalledWith(null);
    expect(reload.setUser).not.toHaveBeenCalledWith(userB);
    expect(gateState).toEqual({ state: "CLEAR" });
  });

  it("mismatch de instância preserva o cookie trocado e mantém a quarentena fechada", async () => {
    process.env.EXPO_PUBLIC_SESSION_EXACT_BINDING_CLIENT_ACTIVE = "1";
    const sessionS1 = `v1.${"a".repeat(43)}`;
    let cookieS2IsValid = true;
    let gateState: WebSessionGateState = { state: "REVOKE_REQUIRED" };
    const webGate: PersistentWebSessionGate = {
      beginLoginInProgress: async () => undefined,
      beginRevocation: async (expectedUserId, sessionInstance) => {
        gateState = {
          state: "REVOKE_REQUIRED",
          ...(expectedUserId === undefined ? {} : { expectedUserId }),
          ...(sessionInstance === undefined ? {} : { sessionInstance }),
        };
      },
      prepareAdmission: async (expectedUserId) => {
        gateState = { state: "ADMISSION", expectedUserId };
      },
      read: async () => gateState,
      clear: async () => {
        gateState = { state: "CLEAR" };
      },
    };
    const harness = await renderAuthHarness({
      platform: "web",
      webSessionGate: webGate,
      webRevocationBootstrap: async () => ({
        state: "BOUND",
        expectedUserId: 31,
        sessionInstance: sessionS1,
      }),
      logoutRequest: async (expectedUserId, sessionInstance) => {
        expect(expectedUserId).toBe(31);
        expect(sessionInstance).toBe(sessionS1);
        // Outra aba instalou S2 entre o bootstrap read-only de S1 e o logout.
        // O servidor rejeita a proof S1 e jamais revoga S2.
        throw Object.assign(new Error("cookie mudou"), {
          code: "SESSION_INSTANCE_MISMATCH",
        });
      },
      meRequest: async () => {
        throw new Error("o bootstrap revoke-only não usa meDetailed do hook");
      },
    });

    await harness.auth.refetch();

    expect(harness.bootstrapExactWebSessionRevocation).toHaveBeenCalledTimes(1);
    expect(harness.logoutApi).toHaveBeenCalledWith(undefined, 31, sessionS1);
    expect(harness.meDetailedApi).not.toHaveBeenCalled();
    expect(harness.revokeWebSessionQuarantine).toHaveBeenCalledWith(
      31,
      sessionS1,
    );
    expect(gateState).toEqual({
      state: "REVOKE_REQUIRED",
      expectedUserId: 31,
      sessionInstance: sessionS1,
    });
    expect(cookieS2IsValid).toBe(true);
    expect(harness.setUser).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 31 }),
    );
    expect(harness.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "UNAVAILABLE" }),
    );
  });

  it("bootstrap exact 401 ainda exige logout idempotente e fence antes de limpar", async () => {
    process.env.EXPO_PUBLIC_SESSION_EXACT_BINDING_CLIENT_ACTIVE = "1";
    let gateState: WebSessionGateState = { state: "REVOKE_REQUIRED" };
    const webGate: PersistentWebSessionGate = {
      beginLoginInProgress: async () => undefined,
      beginRevocation: async (expectedUserId, sessionInstance) => {
        gateState = {
          state: "REVOKE_REQUIRED",
          ...(expectedUserId === undefined ? {} : { expectedUserId }),
          ...(sessionInstance === undefined ? {} : { sessionInstance }),
        };
      },
      prepareAdmission: async (expectedUserId) => {
        gateState = { state: "ADMISSION", expectedUserId };
      },
      read: async () => gateState,
      clear: async () => {
        gateState = { state: "CLEAR" };
      },
    };
    const harness = await renderAuthHarness({
      platform: "web",
      webSessionGate: webGate,
      webRevocationBootstrap: async () => ({ state: "INVALID" }),
      logoutRequest: async (expectedUserId, sessionInstance) => {
        expect(expectedUserId).toBeUndefined();
        expect(sessionInstance).toBeUndefined();
      },
    });

    await harness.auth.refetch();

    expect(harness.bootstrapExactWebSessionRevocation).toHaveBeenCalledTimes(1);
    expect(harness.beginWebSessionQuarantine).toHaveBeenCalledTimes(1);
    expect(harness.logoutApi).toHaveBeenCalledTimes(1);
    expect(harness.revokeWebSessionQuarantine).toHaveBeenCalledTimes(1);
    expect(gateState).toEqual({ state: "CLEAR" });
    expect(harness.meDetailedApi).not.toHaveBeenCalled();
  });

  it("refetch mais antigo não sobrescreve o 200 mais novo na mesma epoch", async () => {
    const first = deferred<{
      user: { id: number; name: string; email: string; role: "doctor" } | null;
      sessionInvalid: boolean;
      networkOrServerError: boolean;
    }>();
    const second = deferred<{
      user: { id: number; name: string; email: string; role: "doctor" } | null;
      sessionInvalid: boolean;
      networkOrServerError: boolean;
    }>();
    let calls = 0;
    const harness = await renderAuthHarness({
      logoutRequest: async () => undefined,
      platform: "ios",
      meRequest: () => (++calls === 1 ? first.promise : second.promise),
    });
    const stale = harness.auth.refetch();
    await vi.waitFor(() =>
      expect(harness.meDetailedApi).toHaveBeenCalledTimes(1),
    );
    const current = harness.auth.refetch();
    const approved = {
      id: 31,
      name: "Aprovado atual",
      email: "atual@example.com",
      role: "doctor" as const,
    };

    second.resolve({
      user: approved,
      sessionInvalid: false,
      networkOrServerError: false,
    });
    await current;
    first.resolve({
      user: { ...approved, name: "Resposta antiga" },
      sessionInvalid: false,
      networkOrServerError: false,
    });
    await stale;

    expect(harness.setUserInfo.mock.calls).toEqual([[approved]]);
    expect(harness.setUser.mock.calls).toEqual([[approved]]);
  });

  it("refetch 200 antigo não ressuscita usuário após 401 mais novo", async () => {
    const first = deferred<{
      user: { id: number; name: string; email: string; role: "doctor" } | null;
      sessionInvalid: boolean;
      networkOrServerError: boolean;
    }>();
    const second = deferred<{
      user: { id: number; name: string; email: string; role: "doctor" } | null;
      sessionInvalid: boolean;
      networkOrServerError: boolean;
    }>();
    let calls = 0;
    const harness = await renderAuthHarness({
      logoutRequest: async () => undefined,
      platform: "ios",
      meRequest: () => (++calls === 1 ? first.promise : second.promise),
    });
    const stale = harness.auth.refetch();
    await vi.waitFor(() =>
      expect(harness.meDetailedApi).toHaveBeenCalledTimes(1),
    );
    const current = harness.auth.refetch();

    second.resolve({
      user: null,
      sessionInvalid: true,
      networkOrServerError: false,
    });
    await current;
    first.resolve({
      user: {
        id: 31,
        name: "Resposta antiga",
        email: "antigo@example.com",
        role: "doctor",
      },
      sessionInvalid: false,
      networkOrServerError: false,
    });
    await stale;

    expect(harness.setUserInfo).not.toHaveBeenCalled();
    expect(harness.setUser.mock.calls).toEqual([[null]]);
    expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
  });

  it("phase2 web converte sessão legacy em revoke-only e revoga antes da limpeza local", async () => {
    process.env.EXPO_PUBLIC_SESSION_EXACT_BINDING_CLIENT_ACTIVE = "1";
    const sessionInstance = `v1.${"c".repeat(43)}`;
    const logoutRequest = vi.fn(
      async (expectedUserId?: number, expectedSessionInstance?: string) => {
        expect(expectedUserId).toBe(31);
        expect(expectedSessionInstance).toBe(sessionInstance);
      },
    );
    const harness = await renderAuthHarness({
      platform: "web",
      logoutRequest,
      meRequest: async () => ({
        user: null,
        sessionInvalid: false,
        networkOrServerError: false,
        code: "SESSION_BINDING_REAUTH_REQUIRED",
        revocationUserId: 31,
        sessionInstance,
      }),
    });

    await harness.auth.refetch();

    expect(harness.beginWebSessionQuarantine).toHaveBeenCalledWith(
      31,
      sessionInstance,
    );
    expect(logoutRequest).toHaveBeenCalledTimes(1);
    expect(harness.sequence.indexOf("http-logout")).toBeLessThan(
      harness.sequence.indexOf("remove-session-token"),
    );
    expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
    expect(harness.setUser).toHaveBeenCalledWith(null);
  });

  it("phase2 web mantém legacy revoke-only em 500 e o retry não consulta /me antes de revogar", async () => {
    process.env.EXPO_PUBLIC_SESSION_EXACT_BINDING_CLIENT_ACTIVE = "1";
    const sessionInstance = `v1.${"d".repeat(43)}`;
    let logoutCalls = 0;
    const harness = await renderAuthHarness({
      platform: "web",
      logoutRequest: async () => {
        logoutCalls += 1;
        if (logoutCalls === 1) throw new Error("500 ao revogar legacy");
      },
      meRequest: async () => ({
        user: null,
        sessionInvalid: false,
        networkOrServerError: false,
        code: "SESSION_BINDING_REAUTH_REQUIRED",
        revocationUserId: 31,
        sessionInstance,
      }),
    });

    await harness.auth.refetch();
    expect(harness.removeSessionToken).not.toHaveBeenCalled();
    expect(harness.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "UNAVAILABLE" }),
    );
    expect((await harness.getWebSessionGateState()).state).toBe(
      "REVOKE_REQUIRED",
    );

    await harness.auth.refetch();
    expect(logoutCalls).toBe(2);
    expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
  });

  it("phase2 web nunca aceita /me 401 como ACK e repete o logout tipado", async () => {
    process.env.EXPO_PUBLIC_SESSION_EXACT_BINDING_CLIENT_ACTIVE = "1";
    const sessionInstance = `v1.${"e".repeat(43)}`;
    let logoutCalls = 0;
    const harness = await renderAuthHarness({
      platform: "web",
      logoutRequest: async () => {
        logoutCalls += 1;
        if (logoutCalls === 1) throw new Error("ACK do logout perdido");
      },
      meRequest: async () => ({
        user: null,
        sessionInvalid: false,
        networkOrServerError: false,
        code: "SESSION_BINDING_REAUTH_REQUIRED" as const,
        revocationUserId: 31,
        sessionInstance,
      }),
    });

    await harness.auth.refetch();

    expect(harness.logoutApi).toHaveBeenCalledTimes(1);
    expect(harness.meDetailedApi).toHaveBeenCalledTimes(1);
    expect(harness.revokeWebSessionQuarantine).toHaveBeenCalledTimes(1);
    expect(harness.removeSessionToken).not.toHaveBeenCalled();

    await harness.auth.refetch();
    expect(harness.logoutApi).toHaveBeenCalledTimes(2);
    expect(harness.meDetailedApi).toHaveBeenCalledTimes(1);
    expect(harness.revokeWebSessionQuarantine).toHaveBeenCalledTimes(2);
    expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
  });

  it("phase2 nativo revoga o Bearer legacy exato e 500 permanece em quarentena", async () => {
    process.env.EXPO_PUBLIC_SESSION_EXACT_BINDING_CLIENT_ACTIVE = "1";
    let revokeCalls = 0;
    const harness = await renderAuthHarness({
      platform: "ios",
      logoutRequest: async () => undefined,
      admittedSessionUserId: 31,
      admittedSessionToken: "legacy-token-A",
      revokeTokenRequest: async (token) => {
        expect(token).toBe("legacy-token-A");
        revokeCalls += 1;
        if (revokeCalls === 1) throw new Error("rede indisponível");
      },
      revalidateTokenRequest: async () => ({
        user: {
          id: 31,
          name: "Usuário ainda autenticado",
          email: "ativo@example.com",
          role: "doctor",
        },
        sessionInvalid: false,
        networkOrServerError: false,
      }),
      meRequest: async () => ({
        user: null,
        sessionInvalid: false,
        networkOrServerError: false,
        code: "SESSION_BINDING_REAUTH_REQUIRED",
        revocationUserId: 31,
      }),
    });

    await harness.auth.refetch();
    expect(harness.removeSessionToken).not.toHaveBeenCalled();
    expect(harness.setSessionValidation).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "UNAVAILABLE" }),
    );

    await harness.auth.refetch();
    expect(revokeCalls).toBe(2);
    expect(
      harness.sequence.indexOf("http-revoke-token:legacy-token-A"),
    ).toBeLessThan(harness.sequence.indexOf("remove-session-token"));
    expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
  });

  it("phase2 nativo nunca aceita /me 401 como ACK e repete o Bearer logout", async () => {
    process.env.EXPO_PUBLIC_SESSION_EXACT_BINDING_CLIENT_ACTIVE = "1";
    let harnessRevokeCalls = 0;
    const harness = await renderAuthHarness({
      platform: "ios",
      logoutRequest: async () => undefined,
      admittedSessionUserId: 31,
      admittedSessionToken: "legacy-token-A",
      revokeTokenRequest: async (token) => {
        expect(token).toBe("legacy-token-A");
        if (harnessRevokeCalls++ === 0) {
          throw new Error("ACK do logout perdido");
        }
      },
      meRequest: async () => ({
        user: null,
        sessionInvalid: false,
        networkOrServerError: false,
        code: "SESSION_BINDING_REAUTH_REQUIRED",
        revocationUserId: 31,
      }),
    });

    await harness.auth.refetch();

    expect(harness.revokeSessionTokenApi).toHaveBeenCalledWith(
      "legacy-token-A",
    );
    expect(harness.revalidateSessionTokenApi).not.toHaveBeenCalled();
    expect(harness.removeSessionToken).not.toHaveBeenCalled();

    await harness.auth.refetch();
    expect(harness.revokeSessionTokenApi).toHaveBeenCalledTimes(2);
    expect(harness.revalidateSessionTokenApi).not.toHaveBeenCalled();
    expect(harness.removeSessionToken).toHaveBeenCalledTimes(1);
  });

  it("a revisão da sessão troca a chave do registrador push e força remount", async () => {
    let revision = 0;
    const useNotifications = vi.fn();
    const createElement = vi.fn((type: unknown, props: { key?: string }) => ({
      type,
      props,
      key: props.key,
    }));
    vi.stubGlobal("React", { createElement });
    vi.doMock("react", () => ({
      createElement,
      useCallback: (callback: unknown) => callback,
      useEffect: vi.fn(),
      useRef: (initial: unknown) => ({ current: initial }),
    }));
    vi.doMock("expo-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
    vi.doMock("expo-notifications", () => ({
      setNotificationHandler: vi.fn(),
      addNotificationResponseReceivedListener: vi.fn(),
      getLastNotificationResponse: vi.fn(() => null),
      clearLastNotificationResponse: vi.fn(),
      DEFAULT_ACTION_IDENTIFIER: "expo.modules.notifications.actions.DEFAULT",
    }));
    vi.doMock("@/hooks/use-auth", () => ({
      useAuth: () => ({
        user: { id: 31 },
        isAuthenticated: true,
        pushRegistrationRevision: revision,
      }),
    }));
    vi.doMock("@/hooks/use-notifications", () => ({ useNotifications }));
    vi.doMock("@/lib/tenant-state", () => ({
      getActiveTenantSnapshot: () => ({ institutionId: 9, revision: 1 }),
      useTenantState: () => ({ setActiveInstitutionId: vi.fn() }),
    }));
    vi.doMock("@/lib/trpc", () => ({
      trpc: {
        useUtils: () => ({ invalidate: vi.fn() }),
        professionals: {
          listMyInstitutions: {
            useQuery: () => ({ refetch: vi.fn() }),
          },
        },
      },
    }));

    try {
      const { NotificationListener } =
        await import("../components/NotificationListener");
      const first = NotificationListener() as unknown as {
        key?: string;
        type: (props: { userId: number }) => null;
        props: { userId: number };
      };
      first.type(first.props);
      revision = 1;
      const second = NotificationListener() as unknown as { key?: string };

      expect(useNotifications).toHaveBeenCalledWith(31);
      expect(first.key).toBe("31:0");
      expect(second.key).toBe("31:1");
      expect(second.key).not.toBe(first.key);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
