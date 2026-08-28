import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN_KEY = "session_token";
const MARKER_KEY = "session_token_revoked_v1";
const ADMISSION_KEY = "session_token_admission_v3";
const BLOCKED_MARKER = "blocked:v3";
const LEGACY_REVOKE_PREFIX = "legacy-revoke-required:v1";
const LEGACY_REVOKE_V2_PREFIX = "legacy-revoke-required:v2";
const REVOKED_CLEANUP_PREFIX = "revoked-cleanup-required:v1";
const WEB_GATE_KEY = "web_session_quarantine_v1";
const WEB_WORKFLOW_REVISION_KEY = "web_session_workflow_revision_v1";
const WEB_LOGIN_MARKER = /^login-in-progress:v3:[0-9a-f]{32}$/;
const WEB_ADMISSION_MARKER = /^pending-admission:v3:202:[0-9a-f]{32}$/;
const WEB_REVOCATION_MARKER = /^pending-revocation:v2:[0-9a-f]{32}$/;
const WEB_EXACT_REVOCATION_MARKER =
  /^pending-revocation:v4:101:[0-9a-f]{32}:v1\.[A-Za-z0-9_-]{43}$/;
const WEB_WORKFLOW_REVISION = /^workflow:v1:[0-9a-f]{32}$/;
const SESSION_INSTANCE = `v1.${"a".repeat(43)}`;
const CLIENT_ACTIVE_ENV = "EXPO_PUBLIC_SESSION_EXACT_BINDING_CLIENT_ACTIVE";
const DEFAULT_USER_ID = 101;
const NEXT_USER_ID = 202;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function legacyRevocationMarker(token: string): string {
  return `${LEGACY_REVOKE_PREFIX}:${createHash("sha256").update(token).digest("hex")}`;
}

function legacyRevocationV2Pattern(token: string): RegExp {
  const fingerprint = createHash("sha256").update(token).digest("hex");
  return new RegExp(`^${LEGACY_REVOKE_V2_PREFIX}:[0-9a-f]{32}:${fingerprint}$`);
}

function expectedPreparedPending(token: string, expectedUserId: number) {
  return {
    token,
    phase: "PENDING",
    fingerprint: createHash("sha256").update(token).digest("hex"),
    nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
    expectedUserId,
  };
}

function expectedPreparedLegacy(token: string) {
  return {
    token,
    phase: "LEGACY",
    fingerprint: createHash("sha256").update(token).digest("hex"),
    nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
  };
}

function revokedCleanupPhasePattern(token: string, userId: number): RegExp {
  const fingerprint = createHash("sha256").update(token).digest("hex");
  return new RegExp(
    `^${REVOKED_CLEANUP_PREFIX}:${userId}:[0-9a-f]{32}:${fingerprint}$`,
  );
}

function anonymousRevokedCleanupPhasePattern(token: string): RegExp {
  const fingerprint = createHash("sha256").update(token).digest("hex");
  return new RegExp(
    `^${REVOKED_CLEANUP_PREFIX}:anonymous:[0-9a-f]{32}:${fingerprint}$`,
  );
}

type StorageApi = {
  getItem: ReturnType<typeof vi.fn>;
  setItem: ReturnType<typeof vi.fn>;
  removeItem: ReturnType<typeof vi.fn>;
};

type InspectableStorage = StorageApi & {
  values: Map<string, string>;
};

type BrowserStorage = {
  getItem: ReturnType<typeof vi.fn>;
  setItem: ReturnType<typeof vi.fn>;
  removeItem: ReturnType<typeof vi.fn>;
  values: Map<string, string>;
};

const browserStorageByAsyncStorage = new WeakMap<object, BrowserStorage>();

function availableStorage(
  initial: Record<string, string> = {},
): InspectableStorage {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
}

function browserStorage(initial: Record<string, string> = {}): BrowserStorage {
  return browserStorageFromValues(new Map(Object.entries(initial)));
}

function browserStorageFromValues(values: Map<string, string>): BrowserStorage {
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  };
}

function sharedWebLocks() {
  const tails = new Map<string, Promise<void>>();
  const request = vi.fn(
    async <T>(
      name: string,
      options: LockOptions,
      callback: (lock: Lock | null) => T | PromiseLike<T>,
    ): Promise<T> => {
      const previous = tails.get(name) ?? Promise.resolve();
      let release!: () => void;
      const occupied = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(
        name,
        previous.then(() => occupied),
      );
      const signal = options.signal;
      try {
        if (!signal) {
          await previous;
        } else if (signal.aborted) {
          throw signal.reason;
        } else {
          await Promise.race([
            previous,
            new Promise<never>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            }),
          ]);
        }
      } catch (error) {
        release();
        throw error;
      }
      try {
        return await callback({ name, mode: "exclusive" } as Lock);
      } finally {
        release();
      }
    },
  );
  return { request };
}

function installBrowser(
  storage: BrowserStorage,
  locks: ReturnType<typeof sharedWebLocks> | null,
) {
  const listeners = new Map<string, (event: StorageEvent) => void>();
  vi.stubGlobal("window", {
    localStorage: storage,
    addEventListener: vi.fn(
      (name: string, listener: (event: StorageEvent) => void) => {
        listeners.set(name, listener);
      },
    ),
  });
  vi.stubGlobal("navigator", locks ? { locks } : {});
  return listeners;
}

async function loadAuth(
  secureStorage: StorageApi,
  asyncStorage: StorageApi = availableStorage(),
  platform: "ios" | "web" = "ios",
  installWebRuntime = true,
) {
  if (
    platform === "web" &&
    installWebRuntime &&
    typeof window === "undefined" &&
    "values" in asyncStorage
  ) {
    const storage = browserStorageFromValues(
      (asyncStorage as InspectableStorage).values,
    );
    browserStorageByAsyncStorage.set(asyncStorage, storage);
    installBrowser(storage, sharedWebLocks());
  }
  vi.doMock("@react-native-async-storage/async-storage", () => ({
    default: asyncStorage,
  }));
  vi.doMock("react-native", () => ({ Platform: { OS: platform } }));
  vi.doMock("expo-secure-store", () => ({
    getItemAsync: secureStorage.getItem,
    setItemAsync: secureStorage.setItem,
    deleteItemAsync: secureStorage.removeItem,
  }));
  return import("../lib/_core/auth");
}

function installedBrowserStorage(storage: StorageApi): BrowserStorage {
  const browser = browserStorageByAsyncStorage.get(storage);
  if (!browser) throw new Error("Storage browser de teste não instalado");
  return browser;
}

async function admitSessionToken(
  auth: Awaited<ReturnType<typeof loadAuth>>,
  token: string,
  expectedUserId = DEFAULT_USER_ID,
): Promise<void> {
  const staged = await auth.stageSessionToken(token, expectedUserId);
  await auth.commitStagedSessionToken(staged);
  await auth.admitSessionTokenTransport(
    await canonicalValidationReceipt(auth, expectedUserId),
  );
}

async function canonicalValidationReceipt(
  auth: Awaited<ReturnType<typeof loadAuth>>,
  expectedUserId: number,
) {
  const previousFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            sessionInstance: SESSION_INSTANCE,
            user: {
              id: expectedUserId,
              name: `Usuário ${expectedUserId}`,
              email: null,
              role: "doctor",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    ),
  );
  try {
    const result = await auth.validateCanonicalSession(expectedUserId);
    expect(result).toMatchObject({
      user: { id: expectedUserId },
      sessionInvalid: false,
      networkOrServerError: false,
    });
    expect(result.validationReceipt).toBeDefined();
    return result.validationReceipt!;
  } finally {
    vi.stubGlobal("fetch", previousFetch);
  }
}

async function seedAdmittedSession(
  secureStorage: InspectableStorage,
  markerStorage: InspectableStorage,
  token = "token-A",
  expectedUserId = DEFAULT_USER_ID,
) {
  const auth = await loadAuth(secureStorage, markerStorage);
  await admitSessionToken(auth, token, expectedUserId);
  return auth;
}

async function markConfirmedDeleteCleanup(
  auth: Awaited<ReturnType<typeof loadAuth>>,
  expectedUserId = DEFAULT_USER_ID,
): Promise<void> {
  const prepared = await prepareConfirmedDeleteCleanup(auth, expectedUserId);
  await confirmPreparedDeleteCleanup(auth, prepared);
}

async function prepareConfirmedDeleteCleanup(
  auth: Awaited<ReturnType<typeof loadAuth>>,
  expectedUserId = DEFAULT_USER_ID,
) {
  const credential = auth.captureSessionTransitionCredential(
    "delete-account",
    expectedUserId,
  );
  if (!credential) throw new Error("Credencial DELETE de teste indisponível");
  const ticket =
    await auth.prepareReversibleSessionTokenRevocation(expectedUserId);
  auth.bindSessionTransitionCredentialToReversibleRevocation(
    credential,
    ticket,
  );
  return { credential, ticket };
}

async function confirmPreparedDeleteCleanup(
  auth: Awaited<ReturnType<typeof loadAuth>>,
  prepared: Awaited<ReturnType<typeof prepareConfirmedDeleteCleanup>>,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      expect(url.endsWith("/api/auth/me")).toBe(true);
      expect(options?.method).toBe("DELETE");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return auth.deleteAccountWithReversibleSessionCleanup(
    "senha-atual",
    prepared.credential,
    prepared.ticket,
  );
}

describe("cache do token de sessão", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env[CLIENT_ACTIVE_ENV];
  });

  afterEach(() => {
    delete process.env[CLIENT_ACTIVE_ENV];
    vi.unstubAllGlobals();
  });

  it("cold start bloqueia toda wave normal até /me usar o Bearer de validação", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    await seedAdmittedSession(secureStorage, markerStorage, "token-inicial");
    vi.resetModules();
    secureStorage.getItem.mockClear();
    markerStorage.getItem.mockClear();

    const readsGate = deferred<void>();
    const token = secureStorage.values.get(TOKEN_KEY) ?? null;
    const admission = secureStorage.values.get(ADMISSION_KEY) ?? null;
    secureStorage.getItem.mockImplementation(async (key: string) => {
      await readsGate.promise;
      return key === TOKEN_KEY ? token : admission;
    });
    const auth = await loadAuth(secureStorage, markerStorage);

    const blockedReads = Array.from({ length: 12 }, () =>
      auth.getSessionToken(),
    );
    await expect(Promise.all(blockedReads)).resolves.toEqual(
      Array.from({ length: 12 }, () => null),
    );
    expect(secureStorage.getItem).not.toHaveBeenCalled();
    expect(markerStorage.getItem).not.toHaveBeenCalled();

    const validation = auth.getSessionTokenForValidation(DEFAULT_USER_ID);
    await vi.waitFor(() =>
      expect(secureStorage.getItem).toHaveBeenCalledTimes(2),
    );
    expect(markerStorage.getItem).toHaveBeenCalledTimes(1);
    readsGate.resolve();

    await expect(validation).resolves.toBe("token-inicial");
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await auth.admitSessionTokenTransport(
      await canonicalValidationReceipt(auth, DEFAULT_USER_ID),
    );
    await expect(auth.getSessionToken()).resolves.toBe("token-inicial");
  });

  it("401 sem Bearer apresentado permanece UNAVAILABLE e não autoriza limpeza", async () => {
    const auth = await loadAuth(availableStorage(), availableStorage());
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      const headers = options?.headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(auth.validateCanonicalSession()).resolves.toEqual({
      user: null,
      sessionInvalid: false,
      networkOrServerError: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("401 web sem prova de cookie no body não invalida a sessão", async () => {
    const storage = availableStorage();
    const auth = await loadAuth(storage, storage, "web");
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ error: "Não autenticado" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(auth.validateCanonicalSession(DEFAULT_USER_ID)).resolves.toEqual({
      user: null,
      sessionInvalid: false,
      networkOrServerError: true,
    });
  });

  it("401 web só invalida a sessão quando o servidor confirma o cookie", async () => {
    const storage = availableStorage();
    const auth = await loadAuth(storage, storage, "web");
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: "Não autenticado",
          credentialPresented: true,
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(auth.validateCanonicalSession(DEFAULT_USER_ID)).resolves.toEqual({
      user: null,
      sessionInvalid: true,
      networkOrServerError: false,
    });
  });

  it("401 só prova sessão inválida quando o `/me` recebeu o Bearer esperado", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);
    const staged = await auth.stageSessionToken("token-A", DEFAULT_USER_ID);
    await auth.commitStagedSessionToken(staged);
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      const headers = options?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer token-A");
      expect(headers["x-client-expected-user-id"]).toBe(
        String(DEFAULT_USER_ID),
      );
      expect(options?.cache).toBe("no-store");
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      auth.validateCanonicalSession(DEFAULT_USER_ID),
    ).resolves.toEqual({
      user: null,
      sessionInvalid: true,
      networkOrServerError: false,
    });
  });

  it("receipt nasce só do `/me` real, é one-shot e fica presa ao mesmo Bearer", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);
    const staged = await auth.stageSessionToken("token-B", NEXT_USER_ID);
    await auth.commitStagedSessionToken(staged);
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      const headers = options?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer token-B");
      expect(headers["x-client-expected-user-id"]).toBe(String(NEXT_USER_ID));
      return new Response(
        JSON.stringify({
          user: {
            id: NEXT_USER_ID,
            name: "Usuário B",
            email: "b@example.com",
            role: "doctor",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const canonical = await auth.validateCanonicalSession(
      NEXT_USER_ID,
      "token-B",
    );
    expect(canonical.validationReceipt).toBeDefined();
    await auth.admitSessionTokenTransport(canonical.validationReceipt!);
    await expect(auth.getSessionToken()).resolves.toBe("token-B");
    await expect(
      auth.admitSessionTokenTransport(canonical.validationReceipt!),
    ).rejects.toThrow("Receipt canônica inválida, stale ou já consumida");
    expect(auth).not.toHaveProperty("beginCanonicalSessionValidation");
    expect(auth).not.toHaveProperty("completeCanonicalSessionValidation");
  });

  it("cliente exact só cunha receipt web após /me v1 suportado", async () => {
    process.env[CLIENT_ACTIVE_ENV] = "1";
    const storage = availableStorage();
    const auth = await loadAuth(storage, storage, "web");
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      expect(options?.cache).toBe("no-store");
      return new Response(
        JSON.stringify({
          user: {
            id: DEFAULT_USER_ID,
            name: "Usuário exact",
            email: "exact@example.com",
            role: "doctor",
          },
          sessionInstance: SESSION_INSTANCE,
          sessionBinding: {
            capability: "exact-v1",
            supported: true,
            sessionVersion: 1,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const canonical = await auth.validateCanonicalSession(DEFAULT_USER_ID);
    expect(canonical).toMatchObject({
      user: { id: DEFAULT_USER_ID },
      sessionInvalid: false,
      networkOrServerError: false,
    });
    expect(canonical.validationReceipt).toBeDefined();
    await auth.admitWebSessionTransport(canonical.validationReceipt!);
    const ticket = auth.captureSessionTransportTicket();
    expect(ticket).not.toBeNull();
    expect(auth.getSessionTransportSessionInstance(ticket!)).toBe(
      SESSION_INSTANCE,
    );
  });

  it("cliente exact recusa promover sessão legacy e exige reautenticação", async () => {
    process.env[CLIENT_ACTIVE_ENV] = "1";
    const storage = availableStorage();
    const auth = await loadAuth(storage, storage, "web");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              user: {
                id: DEFAULT_USER_ID,
                name: "Usuário legacy",
                email: "legacy@example.com",
                role: "doctor",
              },
              sessionInstance: SESSION_INSTANCE,
              sessionBinding: {
                capability: "exact-v1",
                supported: true,
                sessionVersion: null,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    await expect(
      auth.validateCanonicalSession(DEFAULT_USER_ID),
    ).resolves.toEqual({
      user: null,
      sessionInvalid: false,
      networkOrServerError: false,
      code: "SESSION_BINDING_REAUTH_REQUIRED",
      revocationUserId: DEFAULT_USER_ID,
      sessionInstance: SESSION_INSTANCE,
    });
    expect(auth.captureSessionTransportTicket()).toBeNull();
  });

  it.each([
    ["ausente", undefined],
    ["unsupported", { capability: "exact-v1", supported: false }],
    ["malformado", { capability: "exact-v1", supported: "true" }],
  ])(
    "cliente exact mantém transporte fechado com capability /me %s",
    async (_label, sessionBinding) => {
      process.env[CLIENT_ACTIVE_ENV] = "1";
      const storage = availableStorage();
      const auth = await loadAuth(storage, storage, "web");
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                user: {
                  id: DEFAULT_USER_ID,
                  name: "Usuário",
                  email: "user@example.com",
                  role: "doctor",
                },
                sessionInstance: SESSION_INSTANCE,
                ...(sessionBinding === undefined ? {} : { sessionBinding }),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
        ),
      );

      const canonical = await auth.validateCanonicalSession(DEFAULT_USER_ID);
      expect(canonical).toEqual({
        user: null,
        sessionInvalid: false,
        networkOrServerError: true,
      });
      expect(auth.captureSessionTransportTicket()).toBeNull();
    },
  );

  it("receipt de um Bearer diferente não admite o COMMITTED físico do mesmo usuário", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);
    const staged = await auth.stageSessionToken("token-B", NEXT_USER_ID);
    await auth.commitStagedSessionToken(staged);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              user: {
                id: NEXT_USER_ID,
                name: "Usuário B",
                email: "b@example.com",
                role: "doctor",
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
      ),
    );

    const canonical = await auth.validateCanonicalSession(
      NEXT_USER_ID,
      "token-C",
    );
    expect(canonical.validationReceipt).toBeDefined();
    await expect(
      auth.admitSessionTokenTransport(canonical.validationReceipt!),
    ).rejects.toThrow("Sessão nativa não pôde ser admitida no transporte");
    await expect(auth.getSessionToken()).resolves.toBeNull();
  });

  it("resposta `/me` tardia não emite receipt depois que a geração fechou", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);
    const staged = await auth.stageSessionToken("token-A", DEFAULT_USER_ID);
    await auth.commitStagedSessionToken(staged);
    const response = deferred<Response>();
    const fetchMock = vi.fn(() => response.promise);
    vi.stubGlobal("fetch", fetchMock);

    const validation = auth.validateCanonicalSession(DEFAULT_USER_ID);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    auth.closeSessionTokenTransportAdmission();
    response.resolve(
      new Response(
        JSON.stringify({
          user: {
            id: DEFAULT_USER_ID,
            name: "Usuário A",
            email: "a@example.com",
            role: "doctor",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(validation).resolves.toEqual({
      user: null,
      sessionInvalid: false,
      networkOrServerError: true,
    });
  });

  it("change-password usa capability opaca do Bearer A mesmo após o BEGIN fechar o canal normal", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await seedAdmittedSession(
      secureStorage,
      markerStorage,
      "token-A",
      DEFAULT_USER_ID,
    );
    const credential = auth.captureSessionTransitionCredential(
      "rotate-session",
      DEFAULT_USER_ID,
    );
    expect(credential).not.toBeNull();
    auth.closeSessionTokenTransportAdmission();
    await expect(auth.getSessionToken()).resolves.toBeNull();

    vi.doMock("../lib/tenant-state", () => ({
      getActiveInstitutionId: vi.fn(async () => 77),
    }));
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      const headers = options?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer token-A");
      expect(headers["x-client-expected-user-id"]).toBe(
        String(DEFAULT_USER_ID),
      );
      expect(headers["x-tenant-id"]).toBe("77");
      return new Response(JSON.stringify({ ok: true, token: "token-B" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { authApi } = await import("../lib/_core/api");
    await expect(
      authApi.changePassword("antiga", "nova-segura", credential!),
    ).resolves.toEqual({ ok: true, token: "token-B" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("capability de transição é one-shot e não atravessa endpoint ou purpose", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await seedAdmittedSession(secureStorage, markerStorage);
    const credential = auth.captureSessionTransitionCredential(
      "delete-account",
      DEFAULT_USER_ID,
    );
    expect(credential).not.toBeNull();
    auth.closeSessionTokenTransportAdmission();

    expect(() =>
      auth.consumeSessionTransitionCredentialForRequest(
        credential!,
        "/api/auth/change-password",
        "POST",
      ),
    ).toThrow("fora do endpoint autorizado");
    expect(() =>
      auth.consumeSessionTransitionCredentialForRequest(
        credential!,
        "/api/auth/me",
        "DELETE",
      ),
    ).toThrow("inválida ou reutilizada");
  });

  it("DELETE nativo põe A em PENDING antes do request e cold restart nunca o readmite", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await seedAdmittedSession(
      secureStorage,
      markerStorage,
      "token-A",
      DEFAULT_USER_ID,
    );
    const credential = auth.captureSessionTransitionCredential(
      "delete-account",
      DEFAULT_USER_ID,
    );
    expect(credential).not.toBeNull();
    auth.closeSessionTokenTransportAdmission();
    const reversible =
      await auth.prepareReversibleSessionTokenRevocation(DEFAULT_USER_ID);
    auth.bindSessionTransitionCredentialToReversibleRevocation(
      credential!,
      reversible,
    );

    expect(
      auth.consumeSessionTransitionCredentialForRequest(
        credential!,
        "/api/auth/me",
        "DELETE",
      ),
    ).toEqual({
      expectedUserId: DEFAULT_USER_ID,
      authorization: "Bearer token-A",
    });
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.isSessionTokenQuarantined()).resolves.toBe(true);

    vi.resetModules();
    const restarted = await loadAuth(secureStorage, markerStorage);
    await expect(restarted.getSessionToken()).resolves.toBeNull();
    await expect(restarted.isSessionTokenQuarantined()).resolves.toBe(true);
    await expect(
      restarted.getQuarantinedSessionTokenForRevocation(),
    ).resolves.toBe("token-A");
  });

  it("não deixa uma admissão antiga abrir o transporte de um token substituído", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    await seedAdmittedSession(secureStorage, markerStorage, "token-A");
    vi.resetModules();
    secureStorage.getItem.mockClear();
    markerStorage.getItem.mockClear();

    const oldReadGate = deferred<void>();
    const oldToken = secureStorage.values.get(TOKEN_KEY) ?? null;
    const oldAdmission = secureStorage.values.get(ADMISSION_KEY) ?? null;
    let oldReadsRemaining = 2;
    const auth = await loadAuth(secureStorage, markerStorage);
    const staleReceipt = await canonicalValidationReceipt(
      auth,
      DEFAULT_USER_ID,
    );
    secureStorage.getItem.mockClear();
    markerStorage.getItem.mockClear();
    secureStorage.getItem.mockImplementation(async (key: string) => {
      if (oldReadsRemaining > 0) {
        oldReadsRemaining -= 1;
        await oldReadGate.promise;
        return key === TOKEN_KEY ? oldToken : oldAdmission;
      }
      return secureStorage.values.get(key) ?? null;
    });

    const staleAdmission = auth.admitSessionTokenTransport(staleReceipt);
    await vi.waitFor(() =>
      expect(secureStorage.getItem).toHaveBeenCalledTimes(2),
    );
    const receipt = await auth.stageSessionToken("token-B", DEFAULT_USER_ID);
    await auth.commitStagedSessionToken(receipt);
    oldReadGate.resolve();

    await expect(staleAdmission).rejects.toThrow(
      "Receipt canônica inválida, stale ou já consumida",
    );
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(
      auth.getSessionTokenForValidation(DEFAULT_USER_ID),
    ).resolves.toBe("token-B");
    await auth.admitSessionTokenTransport(
      await canonicalValidationReceipt(auth, DEFAULT_USER_ID),
    );
    await expect(auth.getSessionToken()).resolves.toBe("token-B");
  });

  it("serializa stage, confirmação remota e cleanup sem publicar preparação substituída", async () => {
    const firstWrite = deferred<void>();
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const calls: string[] = [];
    secureStorage.setItem.mockImplementation(
      async (key: string, value: string) => {
        calls.push(`set:${key}:${value}`);
        if (key === TOKEN_KEY && value === "token-B") await firstWrite.promise;
        secureStorage.values.set(key, value);
      },
    );
    secureStorage.removeItem.mockImplementation(async (key: string) => {
      calls.push(`remove:${key}`);
      secureStorage.values.delete(key);
    });
    const auth = await loadAuth(secureStorage, markerStorage);

    const write = admitSessionToken(auth, "token-B");
    await vi.waitFor(() =>
      expect(secureStorage.setItem).toHaveBeenCalledTimes(1),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              revocation: "ROTATED",
              revocationUserId: DEFAULT_USER_ID,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const removal = (async () => {
      const prepared = await auth.prepareSessionTokenRevocation(
        "token-B",
        DEFAULT_USER_ID,
      );
      await auth.revokePreparedSessionToken(prepared);
      await auth.removeSessionToken();
    })();
    expect(secureStorage.removeItem).not.toHaveBeenCalled();
    firstWrite.resolve();

    const [writeResult, removeResult] = await Promise.allSettled([
      write,
      removal,
    ]);
    expect(writeResult).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: "A preparação do token foi substituída por outra transição",
      }),
    });
    expect(removeResult).toEqual({ status: "fulfilled", value: undefined });
    expect(calls).toContain(`remove:${TOKEN_KEY}`);
    expect(calls).toContain(`remove:${ADMISSION_KEY}`);
    await expect(auth.getSessionToken()).resolves.toBeNull();
  });

  it("remove nativo sem admission cleanup jamais apaga uma sessão admitida", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await seedAdmittedSession(secureStorage, markerStorage);
    const committedAdmission = secureStorage.values.get(ADMISSION_KEY);
    secureStorage.removeItem.mockClear();

    await expect(auth.removeSessionToken()).rejects.toThrow(
      "Cleanup local não possui confirmação remota durável",
    );
    expect(secureStorage.removeItem).not.toHaveBeenCalled();
    expect(secureStorage.values.get(TOKEN_KEY)).toBe("token-A");
    expect(secureStorage.values.get(ADMISSION_KEY)).toBe(committedAdmission);
    expect(markerStorage.values.has(MARKER_KEY)).toBe(false);
    await expect(auth.getSessionToken()).resolves.toBeNull();
  });

  it("substitui por tombstone confirmado quando o delete do Bearer falha", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await seedAdmittedSession(secureStorage, markerStorage);
    await markConfirmedDeleteCleanup(auth);
    secureStorage.removeItem.mockImplementation(async (key: string) => {
      if (key === TOKEN_KEY) throw new Error("delete indisponível");
      secureStorage.values.delete(key);
    });

    await expect(auth.removeSessionToken()).resolves.toBeUndefined();
    expect(secureStorage.values.get(TOKEN_KEY)).toBe("");
    await expect(auth.getSessionToken()).resolves.toBeNull();
    vi.resetModules();
    const restarted = await loadAuth(secureStorage, markerStorage);
    await expect(restarted.getSessionToken()).resolves.toBeNull();
    await expect(
      restarted.stageSessionToken("token-B", NEXT_USER_ID),
    ).resolves.toBeDefined();
    expect(secureStorage.values.get(TOKEN_KEY)).toBe("token-B");
  });

  it("raw delete e tombstone falhos preservam cleanup bindado para retry local", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await seedAdmittedSession(secureStorage, markerStorage);
    await markConfirmedDeleteCleanup(auth);
    const originalRemove = secureStorage.removeItem.getMockImplementation()!;
    const originalSet = secureStorage.setItem.getMockImplementation()!;
    secureStorage.removeItem.mockRejectedValue(
      new Error("delete indisponível"),
    );
    secureStorage.setItem.mockRejectedValue(
      new Error("overwrite indisponível"),
    );

    await expect(auth.removeSessionToken()).rejects.toThrow(
      "Raw revogado não pôde ser removido nem tombstonado",
    );
    expect(markerStorage.values.get(MARKER_KEY)).toBe(BLOCKED_MARKER);
    expect(secureStorage.values.get(TOKEN_KEY)).toBe("token-A");
    expect(secureStorage.values.get(ADMISSION_KEY)).toMatch(
      revokedCleanupPhasePattern("token-A", DEFAULT_USER_ID),
    );
    await expect(auth.getNativeSessionGateState()).resolves.toEqual({
      state: "REVOKED_CLEANUP_REQUIRED",
    });
    await expect(
      auth.getQuarantinedSessionTokenForRevocation(),
    ).rejects.toThrow("resta somente cleanup local");

    secureStorage.removeItem.mockImplementation(originalRemove);
    secureStorage.setItem.mockImplementation(originalSet);
    vi.resetModules();
    const restarted = await loadAuth(secureStorage, markerStorage);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(restarted.isSessionTokenQuarantined()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(markerStorage.values.has(MARKER_KEY)).toBe(false);
    expect(secureStorage.values.has(TOKEN_KEY)).toBe(false);
    expect(secureStorage.values.has(ADMISSION_KEY)).toBe(false);
  });

  it.each(["no-op", "throw"] as const)(
    "admission cleanup set %s impede marker e não toca raw",
    async (failureMode) => {
      const secureStorage = availableStorage();
      const markerStorage = availableStorage();
      const auth = await seedAdmittedSession(secureStorage, markerStorage);
      const prepared = await prepareConfirmedDeleteCleanup(auth);
      const originalSet = secureStorage.setItem.getMockImplementation()!;
      secureStorage.setItem.mockImplementation(
        async (key: string, value: string) => {
          if (
            key === ADMISSION_KEY &&
            value.startsWith(`${REVOKED_CLEANUP_PREFIX}:`)
          ) {
            if (failureMode === "throw") {
              throw new Error("admission cleanup indisponível");
            }
            return;
          }
          await originalSet(key, value);
        },
      );
      markerStorage.setItem.mockClear();
      secureStorage.removeItem.mockClear();

      await expect(
        confirmPreparedDeleteCleanup(auth, prepared),
      ).rejects.toThrow(
        "Admission REVOKED_CLEANUP_REQUIRED não foi confirmada",
      );
      expect(markerStorage.setItem).not.toHaveBeenCalled();
      expect(secureStorage.removeItem).not.toHaveBeenCalled();
      expect(secureStorage.values.get(TOKEN_KEY)).toBe("token-A");
      expect(secureStorage.values.get(ADMISSION_KEY)).toMatch(/^pending:v3:/);
      expect(markerStorage.values.get(MARKER_KEY)).toBe(
        secureStorage.values.get(ADMISSION_KEY),
      );
      await expect(auth.getSessionToken()).resolves.toBeNull();
    },
  );

  it.each(["no-op", "throw"] as const)(
    "marker blocked %s deixa admission cleanup recuperável e não deleta raw",
    async (failureMode) => {
      const secureStorage = availableStorage();
      const markerStorage = availableStorage();
      const auth = await seedAdmittedSession(secureStorage, markerStorage);
      const prepared = await prepareConfirmedDeleteCleanup(auth);
      const originalMarkerSet = markerStorage.setItem.getMockImplementation()!;
      if (failureMode === "throw") {
        markerStorage.setItem.mockRejectedValue(
          new Error("marker indisponível"),
        );
      } else {
        markerStorage.setItem.mockResolvedValue(undefined);
      }

      await expect(
        confirmPreparedDeleteCleanup(auth, prepared),
      ).rejects.toThrow(
        "Marker bloqueado do cleanup revogado não foi confirmado",
      );
      expect(secureStorage.removeItem).not.toHaveBeenCalled();
      expect(secureStorage.values.get(TOKEN_KEY)).toBe("token-A");
      expect(secureStorage.values.get(ADMISSION_KEY)).toMatch(
        revokedCleanupPhasePattern("token-A", DEFAULT_USER_ID),
      );
      expect(markerStorage.values.get(MARKER_KEY)).toMatch(/^pending:v3:/);
      // A prova remota já fechou a memória; a falha de persistência jamais
      // restaura o transporte por conveniência.
      await expect(auth.getSessionToken()).resolves.toBeNull();

      markerStorage.setItem.mockImplementation(originalMarkerSet);
      vi.resetModules();
      const restarted = await loadAuth(secureStorage, markerStorage);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(restarted.isSessionTokenQuarantined()).resolves.toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(markerStorage.values.has(MARKER_KEY)).toBe(false);
      expect(secureStorage.values.has(TOKEN_KEY)).toBe(false);
      expect(secureStorage.values.has(ADMISSION_KEY)).toBe(false);
    },
  );

  it.each(["admission", "marker"] as const)(
    "ACK perdido aplicado em %s confirma a fase sem deletar raw",
    async (lostAckAt) => {
      const secureStorage = availableStorage();
      const markerStorage = availableStorage();
      const auth = await seedAdmittedSession(secureStorage, markerStorage);
      const prepared = await prepareConfirmedDeleteCleanup(auth);
      if (lostAckAt === "admission") {
        const originalSet = secureStorage.setItem.getMockImplementation()!;
        secureStorage.setItem.mockImplementation(
          async (key: string, value: string) => {
            await originalSet(key, value);
            if (
              key === ADMISSION_KEY &&
              value.startsWith(`${REVOKED_CLEANUP_PREFIX}:`)
            ) {
              throw new Error("ACK da admission perdido");
            }
          },
        );
      } else {
        const originalMarkerSet =
          markerStorage.setItem.getMockImplementation()!;
        markerStorage.setItem.mockImplementation(
          async (key: string, value: string) => {
            await originalMarkerSet(key, value);
            if (value === BLOCKED_MARKER) {
              throw new Error("ACK do marker perdido");
            }
          },
        );
      }
      secureStorage.removeItem.mockClear();

      await expect(
        confirmPreparedDeleteCleanup(auth, prepared),
      ).resolves.toEqual({ ok: true, status: 200 });
      expect(markerStorage.values.get(MARKER_KEY)).toBe(BLOCKED_MARKER);
      expect(secureStorage.values.get(ADMISSION_KEY)).toMatch(
        revokedCleanupPhasePattern("token-A", DEFAULT_USER_ID),
      );
      expect(secureStorage.values.get(TOKEN_KEY)).toBe("token-A");
      expect(secureStorage.removeItem).not.toHaveBeenCalled();
    },
  );

  it("preserva o binding PENDING na admission cleanup se o raw não puder ser neutralizado", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);
    await auth.stageSessionToken("token-B", NEXT_USER_ID);
    const pendingBinding = secureStorage.values.get(ADMISSION_KEY);
    expect(markerStorage.values.get(MARKER_KEY)).toBe(pendingBinding);
    const prepared = await auth.prepareSessionTokenRevocation(
      "token-B",
      NEXT_USER_ID,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              revocation: "ROTATED",
              revocationUserId: NEXT_USER_ID,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    await auth.revokePreparedSessionToken(prepared);

    markerStorage.setItem.mockImplementation(async () => undefined);
    secureStorage.removeItem.mockImplementation(async (key: string) => {
      if (key === TOKEN_KEY) throw new Error("delete do raw indisponível");
      secureStorage.values.delete(key);
    });
    secureStorage.setItem.mockImplementation(
      async (key: string, value: string) => {
        if (key === TOKEN_KEY && value === "") {
          throw new Error("tombstone do raw indisponível");
        }
        secureStorage.values.set(key, value);
      },
    );

    await expect(auth.removeSessionToken()).rejects.toThrow(
      "Raw revogado não pôde ser removido nem tombstonado",
    );
    expect(secureStorage.removeItem).not.toHaveBeenCalledWith(ADMISSION_KEY);
    expect(secureStorage.values.get(TOKEN_KEY)).toBe("token-B");
    expect(markerStorage.values.get(MARKER_KEY)).toBe(BLOCKED_MARKER);
    expect(secureStorage.values.get(ADMISSION_KEY)).toBe(
      pendingBinding!.replace(/^pending:v3:/, `${REVOKED_CLEANUP_PREFIX}:`),
    );
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.getAdmittedSessionUserId()).resolves.toBeNull();
    await expect(
      auth.getQuarantinedSessionTokenForRevocation(),
    ).rejects.toThrow("resta somente cleanup local");

    vi.resetModules();
    const restarted = await loadAuth(secureStorage, markerStorage);
    await expect(restarted.getSessionToken()).resolves.toBeNull();
    await expect(restarted.getAdmittedSessionUserId()).resolves.toBeNull();
    await expect(restarted.getNativeSessionGateState()).resolves.toEqual({
      state: "REVOKED_CLEANUP_REQUIRED",
    });
  });

  it("não sobrescreve um Bearer PENDING com uma nova tentativa de login", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);
    await auth.stageSessionToken("token-B", NEXT_USER_ID);
    const pendingMarker = markerStorage.values.get(MARKER_KEY);
    const pendingAdmission = secureStorage.values.get(ADMISSION_KEY);

    await expect(
      auth.stageSessionToken("token-C", NEXT_USER_ID + 1),
    ).rejects.toThrow("sessão pendente que ainda exige reconciliação");
    expect(markerStorage.values.get(MARKER_KEY)).toBe(pendingMarker);
    expect(secureStorage.values.get(ADMISSION_KEY)).toBe(pendingAdmission);
    expect(secureStorage.values.get(TOKEN_KEY)).toBe("token-B");
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.getQuarantinedSessionTokenForRevocation()).resolves.toBe(
      "token-B",
    );
  });

  it("ACK perdido ao remover marker mantém memória fechada e restart conclui localmente", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await seedAdmittedSession(secureStorage, markerStorage);
    await markConfirmedDeleteCleanup(auth);
    let loseClearAck = true;
    markerStorage.removeItem.mockImplementation(async (key: string) => {
      markerStorage.values.delete(key);
    });
    markerStorage.getItem.mockImplementation(async (key: string) => {
      if (loseClearAck && !markerStorage.values.has(key)) {
        loseClearAck = false;
        throw new Error("ACK do clear perdido");
      }
      return markerStorage.values.get(key) ?? null;
    });

    await expect(auth.removeSessionToken()).rejects.toThrow(
      "Marker mudou durante o cleanup revogado",
    );
    expect(markerStorage.values.has(MARKER_KEY)).toBe(false);
    expect(secureStorage.values.has(TOKEN_KEY)).toBe(false);
    expect(secureStorage.values.has(ADMISSION_KEY)).toBe(false);
    await expect(auth.getSessionToken()).resolves.toBeNull();

    vi.resetModules();
    const restarted = await loadAuth(secureStorage, markerStorage);
    await expect(restarted.getSessionToken()).resolves.toBeNull();
    await expect(restarted.isSessionTokenQuarantined()).resolves.toBe(false);
  });

  it.each(["no-op", "throw"] as const)(
    "clear final do marker %s deixa tail inerte e restart conclui localmente",
    async (failureMode) => {
      const secureStorage = availableStorage();
      const markerStorage = availableStorage();
      const auth = await seedAdmittedSession(secureStorage, markerStorage);
      await markConfirmedDeleteCleanup(auth);
      const originalMarkerRemove =
        markerStorage.removeItem.getMockImplementation()!;
      if (failureMode === "throw") {
        markerStorage.removeItem.mockRejectedValue(
          new Error("clear marker indisponível"),
        );
      } else {
        markerStorage.removeItem.mockResolvedValue(undefined);
      }

      await expect(auth.removeSessionToken()).rejects.toThrow(
        "Marker bloqueado do cleanup revogado não pôde ser removido",
      );
      expect(markerStorage.values.get(MARKER_KEY)).toBe(BLOCKED_MARKER);
      expect(secureStorage.values.has(TOKEN_KEY)).toBe(false);
      expect(secureStorage.values.has(ADMISSION_KEY)).toBe(false);

      markerStorage.removeItem.mockImplementation(originalMarkerRemove);
      vi.resetModules();
      const restarted = await loadAuth(secureStorage, markerStorage);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(restarted.isSessionTokenQuarantined()).resolves.toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(markerStorage.values.has(MARKER_KEY)).toBe(false);
    },
  );

  it("novo login só começa depois do cleanup revogado concluir", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    let auth = await seedAdmittedSession(secureStorage, markerStorage);
    await markConfirmedDeleteCleanup(auth);
    await auth.removeSessionToken();
    vi.resetModules();
    auth = await loadAuth(secureStorage, markerStorage);
    await expect(auth.getSessionToken()).resolves.toBeNull();

    await admitSessionToken(auth, "token-B");
    await expect(auth.getSessionToken()).resolves.toBe("token-B");
    vi.resetModules();
    auth = await loadAuth(secureStorage, markerStorage);
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(
      auth.getSessionTokenForValidation(DEFAULT_USER_ID),
    ).resolves.toBe("token-B");
    await auth.admitSessionTokenTransport(
      await canonicalValidationReceipt(auth, DEFAULT_USER_ID),
    );
    await expect(auth.getSessionToken()).resolves.toBe("token-B");
  });

  it("admission cleanup que aparece após o preflight nunca é sobrescrita pelo novo login", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    let auth = await seedAdmittedSession(secureStorage, markerStorage);
    await markConfirmedDeleteCleanup(auth);
    secureStorage.values.delete(TOKEN_KEY);
    const cleanupMarker = markerStorage.values.get(MARKER_KEY)!;
    const cleanupAdmission = secureStorage.values.get(ADMISSION_KEY)!;

    vi.resetModules();
    auth = await loadAuth(secureStorage, markerStorage);
    let markerReads = 0;
    let cleanupAdmissionReads = 0;
    markerStorage.getItem.mockImplementation(async (key: string) => {
      markerReads += 1;
      // O preflight observa a snapshot anterior; a revalidação serializada
      // precisa detectar a prova concorrente antes de gravar PENDING.
      if (key === MARKER_KEY && markerReads === 1) return null;
      return markerStorage.values.get(key) ?? null;
    });
    const originalSecureGet = secureStorage.getItem.getMockImplementation()!;
    secureStorage.getItem.mockImplementation(async (key: string) => {
      if (key === ADMISSION_KEY) {
        cleanupAdmissionReads += 1;
        if (cleanupAdmissionReads === 1) return null;
      }
      return originalSecureGet(key);
    });

    await expect(
      auth.stageSessionToken("token-B", NEXT_USER_ID),
    ).rejects.toThrow("Cleanup revogado precisa concluir");
    expect(markerStorage.values.get(MARKER_KEY)).toBe(cleanupMarker);
    expect(secureStorage.values.get(ADMISSION_KEY)).toBe(cleanupAdmission);
    expect(secureStorage.values.has(TOKEN_KEY)).toBe(false);
  });

  it("admission delete/set throw mantém marker e bloqueia login até retry local", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    let auth = await seedAdmittedSession(secureStorage, markerStorage);
    await markConfirmedDeleteCleanup(auth);
    const originalSet = secureStorage.setItem.getMockImplementation()!;
    const originalRemove = secureStorage.removeItem.getMockImplementation()!;
    secureStorage.removeItem.mockImplementation(async (key: string) => {
      if (key === ADMISSION_KEY) {
        throw new Error("delete da admission indisponível");
      }
      secureStorage.values.delete(key);
    });
    secureStorage.setItem.mockImplementation(
      async (key: string, value: string) => {
        if (key === ADMISSION_KEY && value === "") {
          throw new Error("tombstone da admission indisponível");
        }
        await originalSet(key, value);
      },
    );

    await expect(auth.removeSessionToken()).rejects.toThrow(
      "Admission revogada não pôde ser removida nem tombstonada",
    );
    expect(secureStorage.values.has(TOKEN_KEY)).toBe(false);
    expect(secureStorage.values.get(ADMISSION_KEY)).toMatch(
      revokedCleanupPhasePattern("token-A", DEFAULT_USER_ID),
    );
    expect(markerStorage.values.get(MARKER_KEY)).toBe(BLOCKED_MARKER);
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.isSessionTokenQuarantined()).rejects.toThrow(
      "Admission revogada não pôde ser removida nem tombstonada",
    );

    vi.resetModules();
    auth = await loadAuth(secureStorage, markerStorage);
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(
      auth.stageSessionToken("token-B", NEXT_USER_ID),
    ).rejects.toThrow("Admission revogada não pôde ser removida");
    expect(secureStorage.values.has(TOKEN_KEY)).toBe(false);

    secureStorage.removeItem.mockImplementation(originalRemove);
    secureStorage.setItem.mockImplementation(originalSet);
    vi.resetModules();
    auth = await loadAuth(secureStorage, markerStorage);
    await expect(
      auth.stageSessionToken("token-B", NEXT_USER_ID),
    ).resolves.toBeDefined();
    await expect(auth.getSessionToken()).resolves.toBeNull();
  });

  it("admission delete/set no-op mantém cleanup e retry recupera sem rede", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    let auth = await seedAdmittedSession(secureStorage, markerStorage);
    await markConfirmedDeleteCleanup(auth);
    const originalSecureRemove =
      secureStorage.removeItem.getMockImplementation()!;
    const originalSecureSet = secureStorage.setItem.getMockImplementation()!;
    secureStorage.removeItem.mockImplementation(async (key: string) => {
      if (key === ADMISSION_KEY) return;
      secureStorage.values.delete(key);
    });
    secureStorage.setItem.mockImplementation(
      async (key: string, value: string) => {
        if (key === ADMISSION_KEY && value === "") return;
        await originalSecureSet(key, value);
      },
    );

    await expect(auth.removeSessionToken()).rejects.toThrow(
      "Admission revogada não pôde ser removida nem tombstonada",
    );
    expect(markerStorage.values.get(MARKER_KEY)).toBe(BLOCKED_MARKER);
    expect(secureStorage.values.get(ADMISSION_KEY)).toMatch(
      revokedCleanupPhasePattern("token-A", DEFAULT_USER_ID),
    );
    expect(secureStorage.values.has(TOKEN_KEY)).toBe(false);

    secureStorage.removeItem.mockImplementation(originalSecureRemove);
    secureStorage.setItem.mockImplementation(originalSecureSet);
    vi.resetModules();
    auth = await loadAuth(secureStorage, markerStorage);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.isSessionTokenQuarantined()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      auth.stageSessionToken("token-B", NEXT_USER_ID),
    ).resolves.toBeDefined();
    expect(markerStorage.values.get(MARKER_KEY)).toMatch(/^pending:v3:202:/);
    expect(secureStorage.values.get(TOKEN_KEY)).toBe("token-B");
  });

  it("crash após fase cleanup retoma só limpeza local e nunca revogação", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    let auth = await seedAdmittedSession(secureStorage, markerStorage);
    await markConfirmedDeleteCleanup(auth);
    expect(markerStorage.values.get(MARKER_KEY)).toBe(BLOCKED_MARKER);
    expect(secureStorage.values.get(ADMISSION_KEY)).toMatch(
      revokedCleanupPhasePattern("token-A", DEFAULT_USER_ID),
    );

    vi.resetModules();
    auth = await loadAuth(secureStorage, markerStorage);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.isSessionTokenQuarantined()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(markerStorage.values.has(MARKER_KEY)).toBe(false);
    expect(secureStorage.values.has(TOKEN_KEY)).toBe(false);
    expect(secureStorage.values.has(ADMISSION_KEY)).toBe(false);
  });

  it("admission user/fingerprint e marker blocked são confirmados antes de tocar raw", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await seedAdmittedSession(secureStorage, markerStorage);
    const prepared = await prepareConfirmedDeleteCleanup(auth);
    secureStorage.removeItem.mockClear();
    secureStorage.setItem.mockClear();
    markerStorage.setItem.mockClear();

    await confirmPreparedDeleteCleanup(auth, prepared);

    const cleanupAdmission = secureStorage.values.get(ADMISSION_KEY)!;
    expect(markerStorage.values.get(MARKER_KEY)).toBe(BLOCKED_MARKER);
    expect(cleanupAdmission).toMatch(
      revokedCleanupPhasePattern("token-A", DEFAULT_USER_ID),
    );
    expect(secureStorage.values.get(TOKEN_KEY)).toBe("token-A");
    expect(secureStorage.removeItem).not.toHaveBeenCalled();
    expect(secureStorage.setItem).toHaveBeenCalledWith(
      ADMISSION_KEY,
      cleanupAdmission,
    );
    expect(secureStorage.setItem).not.toHaveBeenCalledWith(
      TOKEN_KEY,
      expect.anything(),
    );
    expect(secureStorage.setItem.mock.invocationCallOrder[0]).toBeLessThan(
      markerStorage.setItem.mock.invocationCallOrder[0],
    );
    await expect(
      auth.getQuarantinedSessionTokenForRevocation(),
    ).rejects.toThrow("resta somente cleanup local");
  });

  it("prepare reversível sem request nunca autoemite cleanup", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await seedAdmittedSession(secureStorage, markerStorage);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    secureStorage.removeItem.mockClear();

    await prepareConfirmedDeleteCleanup(auth);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(markerStorage.values.get(MARKER_KEY)).toMatch(/^pending:v3:101:/);
    expect(secureStorage.values.get(TOKEN_KEY)).toBe("token-A");
    expect(secureStorage.values.get(ADMISSION_KEY)).toBe(
      markerStorage.values.get(MARKER_KEY),
    );
    expect(secureStorage.values.get(ADMISSION_KEY)).not.toMatch(
      /^revoked-cleanup-required:/,
    );
    expect(secureStorage.removeItem).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "body 2xx sem ok:true e code desconhecido",
      body: JSON.stringify({ code: "UNKNOWN" }),
    },
    { name: "JSON 2xx malformado", body: "{" },
  ])("DELETE real rejeita $name sem persistir cleanup", async ({ body }) => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await seedAdmittedSession(secureStorage, markerStorage);
    const prepared = await prepareConfirmedDeleteCleanup(auth);
    const pendingAdmission = secureStorage.values.get(ADMISSION_KEY);
    const pendingMarker = markerStorage.values.get(MARKER_KEY);
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      expect(url.endsWith("/api/auth/me")).toBe(true);
      expect(options?.method).toBe("DELETE");
      expect((options?.headers as Record<string, string>).Authorization).toBe(
        "Bearer token-A",
      );
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    secureStorage.removeItem.mockClear();

    await expect(
      auth.deleteAccountWithReversibleSessionCleanup(
        "senha-atual",
        prepared.credential,
        prepared.ticket,
      ),
    ).resolves.toEqual({
      ok: false,
      status: 200,
      error: "Erro ao excluir conta",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(secureStorage.values.get(TOKEN_KEY)).toBe("token-A");
    expect(secureStorage.values.get(ADMISSION_KEY)).toBe(pendingAdmission);
    expect(markerStorage.values.get(MARKER_KEY)).toBe(pendingMarker);
    expect(pendingAdmission).toMatch(/^pending:v3:101:/);
    expect(pendingMarker).toBe(pendingAdmission);
    expect(secureStorage.removeItem).not.toHaveBeenCalled();
    await expect(auth.getSessionToken()).resolves.toBeNull();
  });

  it.each(["userId", "fingerprint"] as const)(
    "receipt reversível com %s físico divergente não cria cleanup nem apaga raw",
    async (field) => {
      const secureStorage = availableStorage();
      const markerStorage = availableStorage();
      const auth = await seedAdmittedSession(secureStorage, markerStorage);
      const prepared = await prepareConfirmedDeleteCleanup(auth);
      if (field === "userId") {
        const admission = secureStorage.values.get(ADMISSION_KEY)!;
        secureStorage.values.set(
          ADMISSION_KEY,
          admission.replace(/^pending:v3:101:/, "pending:v3:202:"),
        );
      } else {
        secureStorage.values.set(TOKEN_KEY, "token-divergente");
      }
      const rawBefore = secureStorage.values.get(TOKEN_KEY);
      secureStorage.removeItem.mockClear();

      await expect(
        confirmPreparedDeleteCleanup(auth, prepared),
      ).rejects.toThrow();
      expect(markerStorage.values.get(MARKER_KEY)).toMatch(/^pending:v3:101:/);
      expect(secureStorage.values.get(TOKEN_KEY)).toBe(rawBefore);
      expect(secureStorage.values.get(ADMISSION_KEY)).toMatch(/^pending:v3:/);
      expect(secureStorage.removeItem).not.toHaveBeenCalled();
      await expect(auth.getSessionToken()).resolves.toBeNull();
    },
  );

  it("raw delete no-op é detectado e o tombstone confirmado permite cleanup", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await seedAdmittedSession(secureStorage, markerStorage);
    await markConfirmedDeleteCleanup(auth);
    const originalRemove = secureStorage.removeItem.getMockImplementation()!;
    secureStorage.removeItem.mockImplementation(async (key: string) => {
      if (key === TOKEN_KEY) return;
      await originalRemove(key);
    });

    await expect(auth.removeSessionToken()).resolves.toBeUndefined();
    expect(secureStorage.setItem).toHaveBeenCalledWith(TOKEN_KEY, "");
    expect(secureStorage.values.get(TOKEN_KEY)).toBe("");
    expect(secureStorage.values.has(ADMISSION_KEY)).toBe(false);
    expect(markerStorage.values.has(MARKER_KEY)).toBe(false);
  });

  it.each(["no-op", "throw"] as const)(
    "tombstone raw %s preserva marker e admission recuperável",
    async (failureMode) => {
      const secureStorage = availableStorage();
      const markerStorage = availableStorage();
      const auth = await seedAdmittedSession(secureStorage, markerStorage);
      await markConfirmedDeleteCleanup(auth);
      const originalSet = secureStorage.setItem.getMockImplementation()!;
      secureStorage.removeItem.mockImplementation(async (key: string) => {
        if (key === TOKEN_KEY) return;
        secureStorage.values.delete(key);
      });
      secureStorage.setItem.mockImplementation(
        async (key: string, value: string) => {
          if (key === TOKEN_KEY && value === "") {
            if (failureMode === "throw") {
              throw new Error("tombstone raw indisponível");
            }
            return;
          }
          await originalSet(key, value);
        },
      );

      await expect(auth.removeSessionToken()).rejects.toThrow(
        "Raw revogado não pôde ser removido nem tombstonado",
      );
      expect(secureStorage.values.get(TOKEN_KEY)).toBe("token-A");
      expect(secureStorage.values.get(ADMISSION_KEY)).toMatch(
        revokedCleanupPhasePattern("token-A", DEFAULT_USER_ID),
      );
      expect(markerStorage.values.get(MARKER_KEY)).toBe(BLOCKED_MARKER);
      expect(secureStorage.removeItem).not.toHaveBeenCalledWith(ADMISSION_KEY);
    },
  );

  it("admission cleanup malformada bloqueia boot e login sem rede nem deleção", async () => {
    const raw = "token-corrupt-cleanup";
    const secureStorage = availableStorage({
      [TOKEN_KEY]: raw,
      [ADMISSION_KEY]: `${REVOKED_CLEANUP_PREFIX}:corrupt`,
    });
    const markerStorage = availableStorage({
      [MARKER_KEY]: BLOCKED_MARKER,
    });
    const auth = await loadAuth(secureStorage, markerStorage);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(auth.isSessionTokenQuarantined()).rejects.toThrow(
      "REVOKED_CLEANUP_REQUIRED corrompida",
    );
    await expect(auth.getNativeSessionGateState()).resolves.toEqual({
      state: "BLOCKED",
    });
    await expect(
      auth.stageSessionToken("token-B", NEXT_USER_ID),
    ).rejects.toThrow("REVOKED_CLEANUP_REQUIRED corrompida");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(secureStorage.values.get(TOKEN_KEY)).toBe(raw);
    expect(secureStorage.removeItem).not.toHaveBeenCalled();
  });

  it("marker PENDING contém nonce e SHA-256 de B, nunca o Bearer", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);

    await auth.stageSessionToken("token-B-super-secreto", NEXT_USER_ID);
    const marker = markerStorage.values.get(MARKER_KEY)!;
    const expectedFingerprint = createHash("sha256")
      .update("token-B-super-secreto")
      .digest("hex");

    expect(marker).toMatch(/^pending:v3:202:[0-9a-f]{32}:[0-9a-f]{64}$/);
    expect(marker.endsWith(expectedFingerprint)).toBe(true);
    expect(marker).not.toContain("token-B-super-secreto");
    expect(secureStorage.values.get(TOKEN_KEY)).toBe("token-B-super-secreto");
    expect(secureStorage.values.get(ADMISSION_KEY)).toBe(marker);
  });

  it("rejeita userId não positivo ou não canônico antes de tocar storage", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);

    for (const invalidUserId of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      await expect(
        auth.stageSessionToken("token-B", invalidUserId),
      ).rejects.toThrow("Usuário esperado da sessão inválido");
    }

    expect(markerStorage.setItem).not.toHaveBeenCalled();
    expect(secureStorage.setItem).not.toHaveBeenCalled();
  });

  it("marker PENDING setItem no-op rejeita stage antes do receipt e nunca publica B", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    markerStorage.setItem.mockImplementation(async () => undefined);
    const auth = await loadAuth(secureStorage, markerStorage);

    await expect(
      auth.stageSessionToken("token-B", NEXT_USER_ID),
    ).rejects.toThrow("Marcador pendente da sessão não foi confirmado");
    expect(secureStorage.setItem).not.toHaveBeenCalled();
    expect(markerStorage.values.has(MARKER_KEY)).toBe(false);
    await expect(auth.getSessionToken()).resolves.toBeNull();

    vi.resetModules();
    const restarted = await loadAuth(secureStorage, markerStorage);
    await expect(restarted.getSessionToken()).resolves.toBeNull();
    await expect(restarted.isSessionTokenQuarantined()).resolves.toBe(false);
  });

  it("admission PENDING SecureStore no-op rejeita stage e mantém B apenas no escape bindado", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    secureStorage.setItem.mockImplementation(
      async (key: string, value: string) => {
        if (key === ADMISSION_KEY && value.startsWith("pending:v3:")) return;
        secureStorage.values.set(key, value);
      },
    );
    const auth = await loadAuth(secureStorage, markerStorage);

    await expect(
      auth.stageSessionToken("token-B", NEXT_USER_ID),
    ).rejects.toThrow("Barreira positiva do token não foi confirmada");
    const marker = markerStorage.values.get(MARKER_KEY)!;
    expect(marker).toMatch(/^pending:v3:202:[0-9a-f]{32}:[0-9a-f]{64}$/);
    expect(
      marker.endsWith(createHash("sha256").update("token-B").digest("hex")),
    ).toBe(true);
    expect(secureStorage.values.get(TOKEN_KEY)).toBe("token-B");
    expect(secureStorage.values.has(ADMISSION_KEY)).toBe(false);
    await expect(auth.getSessionToken()).resolves.toBeNull();

    vi.resetModules();
    const restarted = await loadAuth(secureStorage, markerStorage);
    await expect(restarted.getSessionToken()).resolves.toBeNull();
    await expect(
      restarted.getQuarantinedSessionTokenForRevocation(),
    ).resolves.toBe("token-B");
  });

  it("stage mantém B invisível no processo e no cold restart até o receipt commitar", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);

    const receipt = await auth.stageSessionToken("token-B", NEXT_USER_ID);
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.getAdmittedSessionUserId()).resolves.toBeNull();
    vi.resetModules();
    const restarted = await loadAuth(secureStorage, markerStorage);
    await expect(restarted.getSessionToken()).resolves.toBeNull();
    await expect(restarted.getAdmittedSessionUserId()).resolves.toBeNull();
    await expect(restarted.commitStagedSessionToken(receipt)).rejects.toThrow(
      "Token preparado não é mais o atual",
    );

    await auth.commitStagedSessionToken(receipt);
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.getSessionTokenForValidation(NEXT_USER_ID)).resolves.toBe(
      "token-B",
    );
    await auth.admitSessionTokenTransport(
      await canonicalValidationReceipt(auth, NEXT_USER_ID),
    );
    await expect(auth.getSessionToken()).resolves.toBe("token-B");
    await expect(auth.getAdmittedSessionUserId()).resolves.toBe(NEXT_USER_ID);
  });

  it("cold restart recupera token e identidade esperada da mesma prova COMMITTED", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);

    await admitSessionToken(auth, "token-B", NEXT_USER_ID);
    expect(secureStorage.values.get(ADMISSION_KEY)).toMatch(
      /^committed:v3:202:[0-9a-f]{32}:[0-9a-f]{64}$/,
    );
    await expect(auth.getAdmittedSessionUserId()).resolves.toBe(NEXT_USER_ID);

    vi.resetModules();
    const restarted = await loadAuth(secureStorage, markerStorage);
    await expect(restarted.getSessionToken()).resolves.toBeNull();
    await expect(
      restarted.getSessionTokenForValidation(NEXT_USER_ID),
    ).resolves.toBe("token-B");
    await expect(restarted.getAdmittedSessionUserId()).resolves.toBe(
      NEXT_USER_ID,
    );
    await restarted.admitSessionTokenTransport(
      await canonicalValidationReceipt(restarted, NEXT_USER_ID),
    );
    await expect(restarted.getSessionToken()).resolves.toBe("token-B");
  });

  it("userId adulterado em uma metade PENDING invalida o binding inteiro", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);
    const receipt = await auth.stageSessionToken("token-B", NEXT_USER_ID);
    const admission = secureStorage.values.get(ADMISSION_KEY)!;
    secureStorage.values.set(
      ADMISSION_KEY,
      admission.replace(/^pending:v3:202:/, "pending:v3:303:"),
    );

    await expect(auth.commitStagedSessionToken(receipt)).rejects.toThrow(
      "Token preparado perdeu a barreira de admissão",
    );
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.getAdmittedSessionUserId()).resolves.toBeNull();

    vi.resetModules();
    const restarted = await loadAuth(secureStorage, markerStorage);
    await expect(restarted.getSessionToken()).resolves.toBeNull();
    await expect(restarted.getAdmittedSessionUserId()).resolves.toBeNull();
  });

  it("receipt forjado ou stale jamais libera B", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);
    const receipt = await auth.stageSessionToken("token-B", NEXT_USER_ID);

    await expect(
      auth.commitStagedSessionToken(Object.freeze({}) as typeof receipt),
    ).rejects.toThrow("Token preparado não é mais o atual");
    await expect(auth.getSessionToken()).resolves.toBeNull();
    const prepared = await auth.prepareSessionTokenRevocation(
      "token-B",
      NEXT_USER_ID,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              revocation: "ROTATED",
              revocationUserId: NEXT_USER_ID,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    await auth.revokePreparedSessionToken(prepared);
    await auth.removeSessionToken();
    await expect(auth.commitStagedSessionToken(receipt)).rejects.toThrow(
      "Token preparado não é mais o atual",
    );
  });

  it("release remove o marker e confirma null antes de publicar B", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);
    const receipt = await auth.stageSessionToken("token-B", NEXT_USER_ID);
    markerStorage.removeItem.mockClear();
    markerStorage.getItem.mockClear();

    await auth.commitStagedSessionToken(receipt);

    expect(markerStorage.removeItem).toHaveBeenCalledWith(MARKER_KEY);
    expect(markerStorage.values.has(MARKER_KEY)).toBe(false);
    expect(markerStorage.getItem).toHaveBeenLastCalledWith(MARKER_KEY);
    expect(markerStorage.removeItem.mock.invocationCallOrder[0]).toBeLessThan(
      markerStorage.getItem.mock.invocationCallOrder.at(-1)!,
    );
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await auth.admitSessionTokenTransport(
      await canonicalValidationReceipt(auth, NEXT_USER_ID),
    );
    await expect(auth.getSessionToken()).resolves.toBe("token-B");
  });

  it("release removeItem no-op não publica B", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);
    const receipt = await auth.stageSessionToken("token-B", NEXT_USER_ID);
    markerStorage.removeItem.mockImplementation(async () => undefined);

    await expect(auth.commitStagedSessionToken(receipt)).rejects.toThrow(
      "Commit do token de sessão não foi confirmado",
    );
    expect(secureStorage.values.get(ADMISSION_KEY)).toMatch(/^pending:v3:/);
    await expect(auth.getSessionToken()).resolves.toBeNull();
    vi.resetModules();
    const restarted = await loadAuth(secureStorage, markerStorage);
    await expect(restarted.getSessionToken()).resolves.toBeNull();
  });

  it("release com ACK perdido e reblock confirmado preserva raw B revogável", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);
    const receipt = await auth.stageSessionToken("token-B", NEXT_USER_ID);
    let loseReleaseAck = false;
    markerStorage.removeItem.mockImplementation(async (key: string) => {
      markerStorage.values.delete(key);
      loseReleaseAck = true;
    });
    markerStorage.getItem.mockImplementation(async (key: string) => {
      if (loseReleaseAck) {
        loseReleaseAck = false;
        throw new Error("ACK do release perdido");
      }
      return markerStorage.values.get(key) ?? null;
    });

    await expect(auth.commitStagedSessionToken(receipt)).rejects.toThrow(
      "ACK do release perdido",
    );
    expect(markerStorage.values.get(MARKER_KEY)).toMatch(/^pending:v3:/);
    expect(secureStorage.values.get(TOKEN_KEY)).toBe("token-B");
    expect(secureStorage.values.get(ADMISSION_KEY)).toMatch(/^pending:v3:/);
    vi.resetModules();
    const restarted = await loadAuth(secureStorage, markerStorage);
    await expect(restarted.getSessionToken()).resolves.toBeNull();
    await expect(
      restarted.getQuarantinedSessionTokenForRevocation(),
    ).resolves.toBe("token-B");
  });

  it("release aplicado segue bloqueado pela prova PENDING se o reblock falha", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);
    const receipt = await auth.stageSessionToken("token-B", NEXT_USER_ID);
    let releaseApplied = false;
    markerStorage.removeItem.mockImplementation(async (key: string) => {
      if (!releaseApplied) {
        releaseApplied = true;
        markerStorage.values.delete(key);
        return;
      }
      throw new Error("remoção indisponível");
    });
    markerStorage.setItem.mockRejectedValue(new Error("reblock indisponível"));
    markerStorage.getItem.mockImplementation(async (key: string) => {
      if (releaseApplied) throw new Error("confirmação indisponível");
      return markerStorage.values.get(key) ?? null;
    });
    secureStorage.setItem.mockImplementation(
      async (key: string, value: string) => {
        if (key === TOKEN_KEY && value === "")
          throw new Error("tombstone indisponível");
        secureStorage.values.set(key, value);
      },
    );
    secureStorage.removeItem.mockRejectedValue(
      new Error("remoção indisponível"),
    );

    await expect(auth.commitStagedSessionToken(receipt)).rejects.toThrow(
      "confirmação indisponível",
    );
    expect(markerStorage.values.get(MARKER_KEY)).toBeUndefined();
    expect(secureStorage.values.get(ADMISSION_KEY)).toMatch(/^pending:v3:/);

    markerStorage.getItem.mockImplementation(
      async (key: string) => markerStorage.values.get(key) ?? null,
    );
    vi.resetModules();
    let restarted = await loadAuth(secureStorage, markerStorage);
    await expect(restarted.getSessionToken()).resolves.toBeNull();
    await expect(restarted.isSessionTokenQuarantined()).resolves.toBe(true);
    await expect(
      restarted.getQuarantinedSessionTokenForRevocation(),
    ).resolves.toBe("token-B");

    markerStorage.setItem.mockRejectedValue(
      new Error("revogação indisponível"),
    );
    const prepared = await restarted.prepareSessionTokenRevocation(
      "token-B",
      NEXT_USER_ID,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              revocation: "ROTATED",
              revocationUserId: NEXT_USER_ID,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    await expect(
      restarted.revokePreparedSessionToken(prepared),
    ).rejects.toThrow(
      "Marker bloqueado do cleanup revogado não foi confirmado",
    );
    vi.resetModules();
    restarted = await loadAuth(secureStorage, markerStorage);
    await expect(restarted.getSessionToken()).resolves.toBeNull();
  });

  it("release aplicado sem nenhuma compensação lança ambiguidade tipada e reinicia bloqueado", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);
    const receipt = await auth.stageSessionToken("token-B", NEXT_USER_ID);
    let sabotage = true;
    let releaseApplied = false;
    markerStorage.removeItem.mockImplementation(async (key: string) => {
      markerStorage.values.delete(key);
      releaseApplied = true;
    });
    markerStorage.getItem.mockImplementation(async (key: string) => {
      if (sabotage && releaseApplied) {
        throw new Error("readback do release indisponível");
      }
      return markerStorage.values.get(key) ?? null;
    });
    markerStorage.setItem.mockImplementation(async () => {
      throw new Error("reblock indisponível");
    });
    secureStorage.getItem.mockImplementation(async (key: string) => {
      if (sabotage && releaseApplied && key === ADMISSION_KEY) {
        throw new Error("prova PENDING ilegível");
      }
      return secureStorage.values.get(key) ?? null;
    });
    secureStorage.setItem.mockImplementation(
      async (key: string, value: string) => {
        if (sabotage && key === TOKEN_KEY && value === "") {
          throw new Error("tombstone indisponível");
        }
        secureStorage.values.set(key, value);
      },
    );

    const error = await auth
      .commitStagedSessionToken(receipt)
      .catch((commitError: unknown) => commitError);
    expect(auth.isSessionTokenCommitAmbiguousError(error)).toBe(true);
    expect(error).toMatchObject({ code: "SESSION_TOKEN_COMMIT_AMBIGUOUS" });
    expect(markerStorage.values.has(MARKER_KEY)).toBe(false);
    expect(secureStorage.values.get(TOKEN_KEY)).toBe("token-B");
    expect(secureStorage.values.get(ADMISSION_KEY)).toMatch(/^pending:v3:/);

    sabotage = false;
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.getAdmittedSessionUserId()).resolves.toBeNull();
    vi.resetModules();
    const restarted = await loadAuth(secureStorage, markerStorage);
    await expect(restarted.getSessionToken()).resolves.toBeNull();
    await expect(restarted.getAdmittedSessionUserId()).resolves.toBeNull();
    await expect(
      restarted.getQuarantinedSessionTokenForRevocation(),
    ).resolves.toBe("token-B");
  });

  it("crash depois do marker e antes de B nunca devolve raw A para revogação", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    await seedAdmittedSession(secureStorage, markerStorage, "token-A");
    secureStorage.setItem.mockImplementation(
      async (key: string, value: string) => {
        if (key === TOKEN_KEY && value === "token-B") {
          throw new Error("processo morto antes de B");
        }
        secureStorage.values.set(key, value);
      },
    );
    vi.resetModules();
    const auth = await loadAuth(secureStorage, markerStorage);

    await expect(
      auth.stageSessionToken("token-B", NEXT_USER_ID),
    ).rejects.toThrow("processo morto antes de B");
    vi.resetModules();
    const restarted = await loadAuth(secureStorage, markerStorage);
    await expect(restarted.getSessionToken()).resolves.toBeNull();
    await expect(restarted.isSessionTokenQuarantined()).resolves.toBe(true);
    await expect(
      restarted.getQuarantinedSessionTokenForRevocation(),
    ).rejects.toThrow("quarentena do token não pôde ser confirmada");
    expect(secureStorage.values.get(TOKEN_KEY)).toBe("token-A");
  });

  it("crash depois do marker com raw ausente é não confirmável", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    secureStorage.setItem.mockImplementation(
      async (key: string, value: string) => {
        if (key === TOKEN_KEY && value === "token-B") throw new Error("kill");
        secureStorage.values.set(key, value);
      },
    );
    const auth = await loadAuth(secureStorage, markerStorage);

    await expect(
      auth.stageSessionToken("token-B", NEXT_USER_ID),
    ).rejects.toThrow("kill");
    vi.resetModules();
    const restarted = await loadAuth(secureStorage, markerStorage);
    await expect(restarted.getSessionToken()).resolves.toBeNull();
    await expect(
      restarted.getQuarantinedSessionTokenForRevocation(),
    ).rejects.toThrow("quarentena do token não pôde ser confirmada");
  });

  it("SecureStore set no-op é detectado e não transforma A em B", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    await seedAdmittedSession(secureStorage, markerStorage, "token-A");
    secureStorage.setItem.mockImplementation(
      async (key: string, value: string) => {
        if (key === TOKEN_KEY && value === "token-B") return;
        secureStorage.values.set(key, value);
      },
    );
    vi.resetModules();
    const auth = await loadAuth(secureStorage, markerStorage);

    await expect(
      auth.stageSessionToken("token-B", NEXT_USER_ID),
    ).rejects.toThrow("Token preparado não foi confirmado no SecureStore");
    vi.resetModules();
    const restarted = await loadAuth(secureStorage, markerStorage);
    await expect(restarted.getSessionToken()).resolves.toBeNull();
    await expect(
      restarted.getQuarantinedSessionTokenForRevocation(),
    ).rejects.toThrow("quarentena do token não pôde ser confirmada");
  });

  it("prova COMMITTED no-op é detectada e B segue revogável, não publicável", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);
    const receipt = await auth.stageSessionToken("token-B", NEXT_USER_ID);
    secureStorage.setItem.mockImplementation(
      async (key: string, value: string) => {
        if (key === ADMISSION_KEY && value.startsWith("committed:v3:")) return;
        secureStorage.values.set(key, value);
      },
    );

    await expect(auth.commitStagedSessionToken(receipt)).rejects.toThrow(
      "Autorização positiva do token não foi confirmada",
    );
    vi.resetModules();
    const restarted = await loadAuth(secureStorage, markerStorage);
    await expect(restarted.getSessionToken()).resolves.toBeNull();
    await expect(
      restarted.getQuarantinedSessionTokenForRevocation(),
    ).resolves.toBe("token-B");
  });

  it("falha COMMITTED restaura admission PENDING antes de tombstone se marker reblock falha", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);
    const receipt = await auth.stageSessionToken("token-B", NEXT_USER_ID);
    markerStorage.setItem.mockRejectedValue(new Error("reblock indisponível"));
    secureStorage.setItem.mockImplementation(
      async (key: string, value: string) => {
        if (key === ADMISSION_KEY && value.startsWith("committed:v3:")) return;
        secureStorage.values.set(key, value);
      },
    );

    await expect(auth.commitStagedSessionToken(receipt)).rejects.toThrow(
      "Autorização positiva do token não foi confirmada",
    );
    expect(markerStorage.values.has(MARKER_KEY)).toBe(false);
    expect(secureStorage.values.get(ADMISSION_KEY)).toMatch(/^pending:v3:/);
    expect(secureStorage.values.get(TOKEN_KEY)).toBe("token-B");
    expect(secureStorage.setItem).not.toHaveBeenCalledWith(TOKEN_KEY, "");
    vi.resetModules();
    const restarted = await loadAuth(secureStorage, markerStorage);
    await expect(restarted.getSessionToken()).resolves.toBeNull();
    await expect(
      restarted.getQuarantinedSessionTokenForRevocation(),
    ).resolves.toBe("token-B");
  });

  it("prova COMMITTED com set e read falhos reativa marker PENDING antes de rejeitar", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);
    const receipt = await auth.stageSessionToken("token-B", NEXT_USER_ID);
    let failCommittedRead = false;
    let committedReadAttempted = false;
    secureStorage.setItem.mockImplementation(
      async (key: string, value: string) => {
        secureStorage.values.set(key, value);
        if (key === ADMISSION_KEY && value.startsWith("committed:v3:")) {
          failCommittedRead = true;
          throw new Error("set COMMITTED ambíguo");
        }
      },
    );
    secureStorage.getItem.mockImplementation(async (key: string) => {
      if (key === ADMISSION_KEY && failCommittedRead) {
        committedReadAttempted = true;
        failCommittedRead = false;
        throw new Error("read COMMITTED indisponível");
      }
      return secureStorage.values.get(key) ?? null;
    });

    await expect(auth.commitStagedSessionToken(receipt)).rejects.toThrow(
      "Autorização positiva do token não foi confirmada",
    );
    expect(committedReadAttempted).toBe(true);
    expect(markerStorage.values.get(MARKER_KEY)).toMatch(/^pending:v3:/);
    vi.resetModules();
    const restarted = await loadAuth(secureStorage, markerStorage);
    await expect(restarted.getSessionToken()).resolves.toBeNull();
    await expect(
      restarted.getQuarantinedSessionTokenForRevocation(),
    ).resolves.toBe("token-B");
  });

  it("COMMITTED aplicado sem ACK nem compensação lança ambiguidade tipada e reinicia em B coerente", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);
    const receipt = await auth.stageSessionToken("token-B", NEXT_USER_ID);
    let sabotage = true;
    markerStorage.setItem.mockImplementation(async () => {
      throw new Error("reblock indisponível");
    });
    secureStorage.setItem.mockImplementation(
      async (key: string, value: string) => {
        if (
          sabotage &&
          key === ADMISSION_KEY &&
          value.startsWith("committed:v3:")
        ) {
          secureStorage.values.set(key, value);
          throw new Error("ACK do COMMITTED perdido");
        }
        if (
          sabotage &&
          ((key === ADMISSION_KEY && value.startsWith("pending:v3:")) ||
            (key === TOKEN_KEY && value === ""))
        ) {
          throw new Error("compensação indisponível");
        }
        secureStorage.values.set(key, value);
      },
    );
    secureStorage.getItem.mockImplementation(async (key: string) => {
      if (
        sabotage &&
        key === ADMISSION_KEY &&
        secureStorage.values.get(key)?.startsWith("committed:v3:")
      ) {
        throw new Error("readback do COMMITTED indisponível");
      }
      return secureStorage.values.get(key) ?? null;
    });

    const error = await auth
      .commitStagedSessionToken(receipt)
      .catch((commitError: unknown) => commitError);
    expect(auth.isSessionTokenCommitAmbiguousError(error)).toBe(true);
    expect(error).toMatchObject({ code: "SESSION_TOKEN_COMMIT_AMBIGUOUS" });
    expect(markerStorage.values.has(MARKER_KEY)).toBe(false);
    expect(secureStorage.values.get(TOKEN_KEY)).toBe("token-B");
    expect(secureStorage.values.get(ADMISSION_KEY)).toMatch(/^committed:v3:/);

    sabotage = false;
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.getSessionTokenForValidation(NEXT_USER_ID)).resolves.toBe(
      "token-B",
    );
    await expect(auth.getAdmittedSessionUserId()).resolves.toBe(NEXT_USER_ID);
    vi.resetModules();
    const restarted = await loadAuth(secureStorage, markerStorage);
    await expect(restarted.getSessionToken()).resolves.toBeNull();
    await expect(
      restarted.getSessionTokenForValidation(NEXT_USER_ID),
    ).resolves.toBe("token-B");
    await expect(restarted.getAdmittedSessionUserId()).resolves.toBe(
      NEXT_USER_ID,
    );
    await restarted.admitSessionTokenTransport(
      await canonicalValidationReceipt(restarted, NEXT_USER_ID),
    );
    expect(await restarted.getSessionToken()).toBe("token-B");
  });

  it("marker vazio presente bloqueia uma prova que seria COMMITTED", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    await seedAdmittedSession(secureStorage, markerStorage, "token-A");
    markerStorage.values.set(MARKER_KEY, "");
    vi.resetModules();
    const restarted = await loadAuth(secureStorage, markerStorage);

    await expect(restarted.getSessionToken()).resolves.toBeNull();
    await expect(restarted.getAdmittedSessionUserId()).resolves.toBeNull();
    await expect(restarted.isSessionTokenQuarantined()).resolves.toBe(true);
    await expect(
      restarted.getQuarantinedSessionTokenForRevocation(),
    ).rejects.toThrow("quarentena do token não pôde ser confirmada");
  });

  it("whitespace no marker bloqueia uma prova que seria COMMITTED", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    await seedAdmittedSession(secureStorage, markerStorage, "token-A");
    markerStorage.values.set(MARKER_KEY, " ");
    vi.resetModules();
    const restarted = await loadAuth(secureStorage, markerStorage);

    await expect(restarted.getSessionToken()).resolves.toBeNull();
    await expect(restarted.getAdmittedSessionUserId()).resolves.toBeNull();
    await expect(restarted.isSessionTokenQuarantined()).resolves.toBe(true);
    await expect(
      restarted.getQuarantinedSessionTokenForRevocation(),
    ).rejects.toThrow("quarentena do token não pôde ser confirmada");
  });

  it("marker legado não esconde admission PENDING e raw B exatos do escape de revogação", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    let auth = await seedAdmittedSession(
      secureStorage,
      markerStorage,
      "token-A",
    );
    markerStorage.values.set(MARKER_KEY, " ");
    markerStorage.setItem.mockImplementation(async () => undefined);

    await expect(
      auth.prepareSessionTokenRevocation("token-B", NEXT_USER_ID),
    ).resolves.toEqual(expectedPreparedPending("token-B", NEXT_USER_ID));
    expect(markerStorage.values.get(MARKER_KEY)).toBe(" ");
    expect(secureStorage.values.get(ADMISSION_KEY)).toMatch(/^pending:v3:202:/);
    expect(secureStorage.values.get(TOKEN_KEY)).toBe("token-B");
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.getQuarantinedSessionTokenForRevocation()).resolves.toBe(
      "token-B",
    );

    vi.resetModules();
    auth = await loadAuth(secureStorage, markerStorage);
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.getQuarantinedSessionTokenForRevocation()).resolves.toBe(
      "token-B",
    );
  });

  it("raw divergente do binding nunca é tratado como revogação confirmável", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);
    await auth.stageSessionToken("token-B", NEXT_USER_ID);
    secureStorage.values.set(TOKEN_KEY, "token-C");
    vi.resetModules();
    const restarted = await loadAuth(secureStorage, markerStorage);

    await expect(restarted.getSessionToken()).resolves.toBeNull();
    await expect(restarted.getAdmittedSessionUserId()).resolves.toBeNull();
    await expect(
      restarted.getQuarantinedSessionTokenForRevocation(),
    ).rejects.toThrow("quarentena do token não pôde ser confirmada");
  });

  it("converte COMMITTED em PENDING antes da revogação e sobrevive ao restart", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    let auth = await seedAdmittedSession(
      secureStorage,
      markerStorage,
      "token-B",
      NEXT_USER_ID,
    );

    await expect(
      auth.prepareSessionTokenRevocation("token-B", NEXT_USER_ID),
    ).resolves.toEqual(expectedPreparedPending("token-B", NEXT_USER_ID));
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.getAdmittedSessionUserId()).resolves.toBeNull();
    await expect(auth.isSessionTokenQuarantined()).resolves.toBe(true);
    await expect(auth.getQuarantinedSessionTokenForRevocation()).resolves.toBe(
      "token-B",
    );

    vi.resetModules();
    auth = await loadAuth(secureStorage, markerStorage);
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.getQuarantinedSessionTokenForRevocation()).resolves.toBe(
      "token-B",
    );
  });

  it("restaura somente o PENDING reversível da receipt opaca do mesmo processo", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    let auth = await seedAdmittedSession(
      secureStorage,
      markerStorage,
      "token-B",
      NEXT_USER_ID,
    );
    const receipt =
      await auth.prepareReversibleSessionTokenRevocation(NEXT_USER_ID);
    expect(auth.getReversibleSessionTokenForRevocation(receipt)).toBe(
      "token-B",
    );
    await expect(auth.getSessionToken()).resolves.toBeNull();

    await expect(
      auth.restoreReversibleSessionTokenAdmission(receipt),
    ).resolves.toBeUndefined();
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await auth.admitSessionTokenTransport(
      await canonicalValidationReceipt(auth, NEXT_USER_ID),
    );
    await expect(auth.getSessionToken()).resolves.toBe("token-B");
    await expect(auth.getAdmittedSessionUserId()).resolves.toBe(NEXT_USER_ID);

    vi.resetModules();
    auth = await loadAuth(secureStorage, markerStorage);
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await auth.admitSessionTokenTransport(
      await canonicalValidationReceipt(auth, NEXT_USER_ID),
    );
    await expect(auth.getSessionToken()).resolves.toBe("token-B");
    await expect(auth.getAdmittedSessionUserId()).resolves.toBe(NEXT_USER_ID);
  });

  it("cold restart e PENDING genérico não recebem autoridade reversível", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    let auth = await seedAdmittedSession(
      secureStorage,
      markerStorage,
      "token-B",
      NEXT_USER_ID,
    );
    const receipt =
      await auth.prepareReversibleSessionTokenRevocation(NEXT_USER_ID);
    vi.resetModules();
    auth = await loadAuth(secureStorage, markerStorage);

    expect(() => auth.getReversibleSessionTokenForRevocation(receipt)).toThrow(
      "Receipt reversível",
    );
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.getQuarantinedSessionTokenForRevocation()).resolves.toBe(
      "token-B",
    );
  });

  it("marker reversível set-no-op não emite receipt e mantém B revoke-only", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    let auth = await seedAdmittedSession(
      secureStorage,
      markerStorage,
      "token-B",
      NEXT_USER_ID,
    );
    markerStorage.setItem.mockImplementation(async () => undefined);

    await expect(
      auth.prepareReversibleSessionTokenRevocation(NEXT_USER_ID),
    ).rejects.toThrow("Marcador pendente");
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.getQuarantinedSessionTokenForRevocation()).resolves.toBe(
      "token-B",
    );

    vi.resetModules();
    auth = await loadAuth(secureStorage, markerStorage);
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.getQuarantinedSessionTokenForRevocation()).resolves.toBe(
      "token-B",
    );
  });

  it("release reversível no-op rejeita e preserva B PENDING no restart", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    let auth = await seedAdmittedSession(
      secureStorage,
      markerStorage,
      "token-B",
      NEXT_USER_ID,
    );
    const receipt =
      await auth.prepareReversibleSessionTokenRevocation(NEXT_USER_ID);
    markerStorage.removeItem.mockImplementation(async () => undefined);

    await expect(
      auth.restoreReversibleSessionTokenAdmission(receipt),
    ).rejects.toThrow("Commit do token");
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.getQuarantinedSessionTokenForRevocation()).resolves.toBe(
      "token-B",
    );

    vi.resetModules();
    auth = await loadAuth(secureStorage, markerStorage);
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.getQuarantinedSessionTokenForRevocation()).resolves.toBe(
      "token-B",
    );
  });

  it("marker PENDING no-op não reexpõe COMMITTED porque admission PENDING ancora B", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    let auth = await seedAdmittedSession(
      secureStorage,
      markerStorage,
      "token-B",
      NEXT_USER_ID,
    );
    markerStorage.setItem.mockImplementation(async () => undefined);

    await expect(
      auth.prepareSessionTokenRevocation("token-B", NEXT_USER_ID),
    ).resolves.toEqual(expectedPreparedPending("token-B", NEXT_USER_ID));
    expect(markerStorage.values.has(MARKER_KEY)).toBe(false);
    expect(secureStorage.values.get(ADMISSION_KEY)).toMatch(/^pending:v3:202:/);
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.getQuarantinedSessionTokenForRevocation()).resolves.toBe(
      "token-B",
    );

    vi.resetModules();
    auth = await loadAuth(secureStorage, markerStorage);
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.getQuarantinedSessionTokenForRevocation()).resolves.toBe(
      "token-B",
    );
  });

  it("ACK perdido do marker aplicado mantém B fechado e revogável", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await seedAdmittedSession(
      secureStorage,
      markerStorage,
      "token-B",
      NEXT_USER_ID,
    );
    markerStorage.setItem.mockImplementation(
      async (key: string, value: string) => {
        markerStorage.values.set(key, value);
        throw new Error("ACK do marker perdido");
      },
    );

    await expect(
      auth.prepareSessionTokenRevocation("token-B", NEXT_USER_ID),
    ).resolves.toEqual(expectedPreparedPending("token-B", NEXT_USER_ID));
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.getQuarantinedSessionTokenForRevocation()).resolves.toBe(
      "token-B",
    );
  });

  it("retry recupera stage revogável parcial com marker B e raw A", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await seedAdmittedSession(
      secureStorage,
      markerStorage,
      "token-A",
      DEFAULT_USER_ID,
    );
    const originalSet = secureStorage.setItem.getMockImplementation()!;
    let loseRawB = true;
    secureStorage.setItem.mockImplementation(
      async (key: string, value: string) => {
        if (key === TOKEN_KEY && value === "token-B" && loseRawB) {
          loseRawB = false;
          return;
        }
        await originalSet(key, value);
      },
    );

    await expect(
      auth.prepareSessionTokenRevocation("token-B", NEXT_USER_ID),
    ).rejects.toThrow("Bearer de revogação não foi confirmado");
    await expect(auth.getSessionToken()).resolves.toBeNull();
    expect(secureStorage.values.get(TOKEN_KEY)).toBe("token-A");
    expect(markerStorage.values.get(MARKER_KEY)).toMatch(/^pending:v3:202:/);

    await expect(
      auth.prepareSessionTokenRevocation("token-B", NEXT_USER_ID),
    ).resolves.toEqual(expectedPreparedPending("token-B", NEXT_USER_ID));
    expect(secureStorage.values.get(TOKEN_KEY)).toBe("token-B");
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.getQuarantinedSessionTokenForRevocation()).resolves.toBe(
      "token-B",
    );
  });

  it("admission COMMITTED não canônica não concede token nem identidade", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    await seedAdmittedSession(
      secureStorage,
      markerStorage,
      "token-B",
      NEXT_USER_ID,
    );
    const admission = secureStorage.values.get(ADMISSION_KEY)!;
    secureStorage.values.set(
      ADMISSION_KEY,
      admission.replace(/^committed:v3:202:/, "committed:v3:0202:"),
    );
    vi.resetModules();
    const restarted = await loadAuth(secureStorage, markerStorage);

    await expect(restarted.getSessionToken()).resolves.toBeNull();
    await expect(restarted.getAdmittedSessionUserId()).resolves.toBeNull();
    await expect(restarted.isSessionTokenQuarantined()).resolves.toBe(true);
  });

  it("falha ao ler a prova de identidade rejeita sem autoridade e permite retry", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    await seedAdmittedSession(
      secureStorage,
      markerStorage,
      "token-B",
      NEXT_USER_ID,
    );
    vi.resetModules();
    let failAdmissionRead = true;
    secureStorage.getItem.mockImplementation(async (key: string) => {
      if (key === ADMISSION_KEY && failAdmissionRead) {
        failAdmissionRead = false;
        throw new Error("admission indisponível");
      }
      return secureStorage.values.get(key) ?? null;
    });
    const auth = await loadAuth(secureStorage, markerStorage);

    await expect(auth.getAdmittedSessionUserId()).rejects.toThrow(
      "admission indisponível",
    );
    await expect(auth.getAdmittedSessionUserId()).resolves.toBe(NEXT_USER_ID);
  });

  it("falha de leitura não vira prova cacheada e uma leitura saudável recupera", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    await seedAdmittedSession(secureStorage, markerStorage, "token-A");
    vi.resetModules();
    secureStorage.getItem.mockClear();
    markerStorage.getItem.mockClear();
    markerStorage.getItem
      .mockRejectedValueOnce(new Error("AsyncStorage indisponível"))
      .mockImplementation(
        async (key: string) => markerStorage.values.get(key) ?? null,
      );
    const auth = await loadAuth(secureStorage, markerStorage);

    await expect(
      auth.getSessionTokenForValidation(DEFAULT_USER_ID),
    ).rejects.toThrow("AsyncStorage indisponível");
    await expect(
      auth.getSessionTokenForValidation(DEFAULT_USER_ID),
    ).resolves.toBe("token-A");
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await auth.admitSessionTokenTransport(
      await canonicalValidationReceipt(auth, DEFAULT_USER_ID),
    );
    await expect(auth.getSessionToken()).resolves.toBe("token-A");
    // 2 leituras por snapshot: falha, retry manual, `/me` real e admissão.
    expect(secureStorage.getItem).toHaveBeenCalledTimes(8);
  });

  it("marker desconhecido seguido de ausência não fabrica revogação confirmada", async () => {
    const secureStorage = availableStorage({ [TOKEN_KEY]: "token-A" });
    const markerStorage = availableStorage();
    markerStorage.getItem
      .mockRejectedValueOnce(new Error("marker indisponível"))
      .mockResolvedValueOnce(null);
    const auth = await loadAuth(secureStorage, markerStorage);

    await expect(auth.isSessionTokenQuarantined()).resolves.toBe(true);
    await expect(
      auth.getQuarantinedSessionTokenForRevocation(),
    ).rejects.toThrow("quarentena do token não pôde ser confirmada");
  });

  it("marker-write falho impede qualquer escrita de B", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    markerStorage.setItem.mockRejectedValue(new Error("marker indisponível"));
    const auth = await loadAuth(secureStorage, markerStorage);

    await expect(
      auth.stageSessionToken("token-B", NEXT_USER_ID),
    ).rejects.toThrow("marker indisponível");
    expect(secureStorage.setItem).not.toHaveBeenCalled();
    await expect(auth.getSessionToken()).resolves.toBeNull();
  });

  it("estado virgem sem token não é confundido com sessão em quarentena", async () => {
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);

    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.isSessionTokenQuarantined()).resolves.toBe(false);
  });

  it("cold boot raw-only vira LEGACY_REVOKE_REQUIRED e uma única wave o torna revoke-only", async () => {
    const legacyToken = "legacy-opaque-token-A";
    const expectedMarker = legacyRevocationV2Pattern(legacyToken);
    const secureStorage = availableStorage({ [TOKEN_KEY]: legacyToken });
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      expect(markerStorage.values.get(MARKER_KEY)).toMatch(expectedMarker);
      expect(secureStorage.values.get(ADMISSION_KEY)).toBe(
        markerStorage.values.get(MARKER_KEY),
      );
      expect((options?.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${legacyToken}`,
      );
      return new Response(
        JSON.stringify({
          user: {
            id: DEFAULT_USER_ID,
            name: "Usuário legacy",
            email: null,
            role: "doctor",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(auth.getNativeSessionGateState()).resolves.toEqual({
      state: "LEGACY_REVOKE_REQUIRED",
    });
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.getAdmittedSessionUserId()).resolves.toBeNull();

    const [first, second] = await Promise.all([
      auth.prepareSessionTokenRevocation(),
      auth.prepareSessionTokenRevocation(),
    ]);
    expect(first).toEqual(
      expectedPreparedPending(legacyToken, DEFAULT_USER_ID),
    );
    expect(second).toEqual(
      expectedPreparedPending(legacyToken, DEFAULT_USER_ID),
    );
    expect(second.nonce).toBe(first.nonce);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(auth.getNativeSessionGateState()).resolves.toEqual({
      state: "REVOKE_REQUIRED",
    });
    await expect(auth.getQuarantinedSessionTokenForRevocation()).resolves.toBe(
      legacyToken,
    );
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.getAdmittedSessionUserId()).resolves.toBeNull();
  });

  it("raw-only bloqueia novo login sem sobrescrever a única credencial revogável", async () => {
    const legacyToken = "legacy-opaque-token-A";
    const secureStorage = availableStorage({ [TOKEN_KEY]: legacyToken });
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);

    await expect(
      auth.stageSessionToken("token-B", NEXT_USER_ID),
    ).rejects.toThrow("sessão pendente");
    expect(secureStorage.values.get(TOKEN_KEY)).toBe(legacyToken);
    expect(secureStorage.values.has(ADMISSION_KEY)).toBe(false);
    await expect(auth.getNativeSessionGateState()).resolves.toEqual({
      state: "LEGACY_REVOKE_REQUIRED",
    });
    await expect(auth.getSessionToken()).resolves.toBeNull();
  });

  it("userId legacy nasce somente do /me revoke-only e nunca é publicado como UI", async () => {
    const legacyToken = "legacy-opaque-token-user";
    const secureStorage = availableStorage({ [TOKEN_KEY]: legacyToken });
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            user: {
              id: NEXT_USER_ID,
              name: "Usuário legacy",
              email: null,
              role: "doctor",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(auth.prepareSessionTokenRevocation()).resolves.toEqual(
      expectedPreparedPending(legacyToken, NEXT_USER_ID),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(auth.getNativeSessionGateState()).resolves.toEqual({
      state: "REVOKE_REQUIRED",
    });
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.getAdmittedSessionUserId()).resolves.toBeNull();
    expect(auth.captureSessionTransportTicket()).toBeNull();
    expect(auth.isSessionTransportUserCurrent(NEXT_USER_ID)).toBe(false);
  });

  it("rede/5xx no /me legacy preserva fingerprint e o retry retoma sem admissão", async () => {
    const legacyToken = "legacy-opaque-token-retry";
    const expectedMarker = legacyRevocationV2Pattern(legacyToken);
    const secureStorage = availableStorage({ [TOKEN_KEY]: legacyToken });
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("rede indisponível"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "indisponível" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            user: {
              id: DEFAULT_USER_ID,
              name: "Usuário legacy",
              email: null,
              role: "doctor",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(auth.prepareSessionTokenRevocation()).rejects.toThrow(
      "/me legacy não confirmou",
    );
    await expect(auth.prepareSessionTokenRevocation()).rejects.toThrow(
      "/me legacy não confirmou",
    );
    expect(markerStorage.values.get(MARKER_KEY)).toMatch(expectedMarker);
    expect(secureStorage.values.get(ADMISSION_KEY)).toBe(
      markerStorage.values.get(MARKER_KEY),
    );
    await expect(auth.getQuarantinedSessionTokenForRevocation()).resolves.toBe(
      legacyToken,
    );
    await expect(auth.getNativeSessionGateState()).resolves.toEqual({
      state: "LEGACY_REVOKE_REQUIRED",
    });

    await expect(auth.prepareSessionTokenRevocation()).resolves.toEqual(
      expectedPreparedPending(legacyToken, DEFAULT_USER_ID),
    );
    await expect(auth.getNativeSessionGateState()).resolves.toEqual({
      state: "REVOKE_REQUIRED",
    });
    await expect(auth.getSessionToken()).resolves.toBeNull();
  });

  it("401 canônico mantém raw explicitamente revogável e logout usa o mesmo Bearer", async () => {
    const legacyToken = "legacy-opaque-token-invalid";
    const secureStorage = availableStorage({ [TOKEN_KEY]: legacyToken });
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);
    vi.doMock("../lib/tenant-state", () => ({
      getActiveInstitutionId: vi.fn(async () => null),
    }));
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      const headers = options?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${legacyToken}`);
      if (url.endsWith("/api/auth/me")) {
        return new Response(JSON.stringify({ error: "Não autenticado" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      expect(url.endsWith("/api/auth/logout")).toBe(true);
      return new Response(
        JSON.stringify({
          ok: true,
          revocation: "ALREADY_INVALID",
          revocationUserId: DEFAULT_USER_ID,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const prepared = await auth.prepareSessionTokenRevocation();
    expect(prepared).toEqual(expectedPreparedLegacy(legacyToken));
    await expect(auth.getNativeSessionGateState()).resolves.toEqual({
      state: "LEGACY_REVOKE_REQUIRED",
    });
    await auth.revokePreparedSessionToken(prepared);
    expect(markerStorage.values.get(MARKER_KEY)).toBe(BLOCKED_MARKER);
    expect(secureStorage.values.get(ADMISSION_KEY)).toMatch(
      revokedCleanupPhasePattern(legacyToken, DEFAULT_USER_ID),
    );
    expect(secureStorage.values.get(TOKEN_KEY)).toBe(legacyToken);
    await auth.removeSessionToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.getAdmittedSessionUserId()).resolves.toBeNull();
  });

  it("ALREADY_INVALID 2xx sem userId cria cleanup anônimo e o restart só limpa o raw de mesmo SHA", async () => {
    const legacyToken = "legacy-opaque-token-already-invalid";
    const secureStorage = availableStorage({ [TOKEN_KEY]: legacyToken });
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);
    vi.doMock("../lib/tenant-state", () => ({
      getActiveInstitutionId: vi.fn(async () => null),
    }));
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      expect((options?.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${legacyToken}`,
      );
      if (url.endsWith("/api/auth/me")) {
        return new Response(JSON.stringify({ error: "Não autenticado" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ ok: true, revocation: "ALREADY_INVALID" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const prepared = await auth.prepareSessionTokenRevocation();
    expect(prepared).toEqual(expectedPreparedLegacy(legacyToken));
    const forgedLegacyMetadata = {
      ...prepared,
      expectedUserId: DEFAULT_USER_ID,
    } as unknown as typeof prepared;
    await expect(
      auth.revokePreparedSessionToken(forgedLegacyMetadata),
    ).rejects.toThrow("Binding preparado da revogação é inválido");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(markerStorage.values.get(MARKER_KEY)).toMatch(
      legacyRevocationV2Pattern(legacyToken),
    );
    expect(secureStorage.values.get(ADMISSION_KEY)).toBe(
      markerStorage.values.get(MARKER_KEY),
    );
    await auth.revokePreparedSessionToken(prepared);

    expect(markerStorage.values.get(MARKER_KEY)).toBe(BLOCKED_MARKER);
    expect(secureStorage.values.get(ADMISSION_KEY)).toMatch(
      anonymousRevokedCleanupPhasePattern(legacyToken),
    );
    expect(secureStorage.values.get(ADMISSION_KEY)?.split(":")[2]).toBe(
      "anonymous",
    );
    expect(secureStorage.values.get(TOKEN_KEY)).toBe(legacyToken);
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.getAdmittedSessionUserId()).resolves.toBeNull();
    expect(auth.captureSessionTransportTicket()).toBeNull();
    await expect(
      auth.getQuarantinedSessionTokenForRevocation(),
    ).rejects.toThrow("resta somente cleanup local");

    vi.resetModules();
    const restarted = await loadAuth(secureStorage, markerStorage);
    fetchMock.mockClear();
    await expect(restarted.isSessionTokenQuarantined()).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(markerStorage.values.has(MARKER_KEY)).toBe(false);
    expect(secureStorage.values.has(TOKEN_KEY)).toBe(false);
    expect(secureStorage.values.has(ADMISSION_KEY)).toBe(false);

    const next = await restarted.stageSessionToken("token-B", NEXT_USER_ID);
    await restarted.commitStagedSessionToken(next);
    await expect(restarted.getNativeSessionGateState()).resolves.toEqual({
      state: "ADMITTED",
      expectedUserId: NEXT_USER_ID,
    });
    await expect(restarted.getSessionToken()).resolves.toBeNull();
  });

  it("PENDING reiniciado + ALREADY_INVALID sem id recupera cleanup parcial local e libera novo login", async () => {
    const revokedToken = "token-A-pending-restart";
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    let auth = await loadAuth(secureStorage, markerStorage);
    const staged = await auth.stageSessionToken(revokedToken, DEFAULT_USER_ID);
    await auth.commitStagedSessionToken(staged);
    const beforeRestart = await auth.prepareSessionTokenRevocation(
      revokedToken,
      DEFAULT_USER_ID,
    );
    expect(beforeRestart).toEqual(
      expectedPreparedPending(revokedToken, DEFAULT_USER_ID),
    );

    vi.resetModules();
    auth = await loadAuth(secureStorage, markerStorage);
    const prepared = await auth.prepareSessionTokenRevocation();
    expect(prepared).toEqual(
      expectedPreparedPending(revokedToken, DEFAULT_USER_ID),
    );
    expect(prepared.nonce).toBe(beforeRestart.nonce);
    expect(prepared.fingerprint).toBe(beforeRestart.fingerprint);
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.getAdmittedSessionUserId()).resolves.toBeNull();
    expect(auth.captureSessionTransportTicket()).toBeNull();

    vi.doMock("../lib/tenant-state", () => ({
      getActiveInstitutionId: vi.fn(async () => null),
    }));
    const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      expect(url.endsWith("/api/auth/logout")).toBe(true);
      expect((options?.headers as Record<string, string>).Authorization).toBe(
        `Bearer ${revokedToken}`,
      );
      return new Response(
        JSON.stringify({ ok: true, revocation: "ALREADY_INVALID" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const persistMarker = markerStorage.setItem.getMockImplementation()!;
    markerStorage.setItem.mockImplementation(
      async (key: string, value: string) => {
        if (key === MARKER_KEY && value === BLOCKED_MARKER) return;
        await persistMarker(key, value);
      },
    );
    await expect(auth.revokePreparedSessionToken(prepared)).rejects.toThrow(
      "Marker bloqueado do cleanup revogado",
    );
    expect(secureStorage.values.get(ADMISSION_KEY)).toMatch(
      revokedCleanupPhasePattern(revokedToken, DEFAULT_USER_ID),
    );
    expect(secureStorage.values.get(TOKEN_KEY)).toBe(revokedToken);
    expect(markerStorage.values.get(MARKER_KEY)).toMatch(/^pending:v3:101:/);

    markerStorage.setItem.mockImplementation(persistMarker);
    vi.resetModules();
    const recovered = await loadAuth(secureStorage, markerStorage);
    await expect(recovered.isSessionTokenQuarantined()).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).endsWith("/api/auth/me"),
      ),
    ).toBe(false);
    expect(secureStorage.values.has(TOKEN_KEY)).toBe(false);
    expect(secureStorage.values.has(ADMISSION_KEY)).toBe(false);
    expect(markerStorage.values.has(MARKER_KEY)).toBe(false);

    const next = await recovered.stageSessionToken("token-B", NEXT_USER_ID);
    await recovered.commitStagedSessionToken(next);
    await expect(recovered.getNativeSessionGateState()).resolves.toEqual({
      state: "ADMITTED",
      expectedUserId: NEXT_USER_ID,
    });
    await expect(
      recovered.getSessionTokenForValidation(NEXT_USER_ID),
    ).resolves.toBe("token-B");
    await expect(recovered.getSessionToken()).resolves.toBeNull();
  });

  it.each([
    {
      name: "ALREADY_INVALID com id null",
      revocation: "ALREADY_INVALID",
      revocationUserId: null,
    },
    {
      name: "ALREADY_INVALID com id string",
      revocation: "ALREADY_INVALID",
      revocationUserId: String(DEFAULT_USER_ID),
    },
    {
      name: "ALREADY_INVALID com id zero",
      revocation: "ALREADY_INVALID",
      revocationUserId: 0,
    },
    {
      name: "ALREADY_INVALID com id fracionário",
      revocation: "ALREADY_INVALID",
      revocationUserId: 1.5,
    },
    {
      name: "ALREADY_INVALID com id inteiro inseguro",
      revocation: "ALREADY_INVALID",
      revocationUserId: Number.MAX_SAFE_INTEGER + 1,
    },
    {
      name: "ALREADY_INVALID com id presente malformado",
      revocation: "ALREADY_INVALID",
      revocationUserId: { value: DEFAULT_USER_ID },
    },
    {
      name: "ROTATED sem id",
      revocation: "ROTATED",
    },
    {
      name: "ROTATED com id null",
      revocation: "ROTATED",
      revocationUserId: null,
    },
    {
      name: "ROTATED com id string",
      revocation: "ROTATED",
      revocationUserId: String(DEFAULT_USER_ID),
    },
    {
      name: "ROTATED com id zero",
      revocation: "ROTATED",
      revocationUserId: 0,
    },
    {
      name: "ROTATED com id fracionário",
      revocation: "ROTATED",
      revocationUserId: 1.5,
    },
    {
      name: "ROTATED com id inteiro inseguro",
      revocation: "ROTATED",
      revocationUserId: Number.MAX_SAFE_INTEGER + 1,
    },
    {
      name: "ROTATED com id presente malformado",
      revocation: "ROTATED",
      revocationUserId: { value: DEFAULT_USER_ID },
    },
  ] as const)(
    "revokePreparedSessionToken rejeita $name sem alterar as provas PENDING",
    async (testCase) => {
      const revokedToken = `token-parser-${testCase.name}`;
      const secureStorage = availableStorage();
      const markerStorage = availableStorage();
      const auth = await loadAuth(secureStorage, markerStorage);
      const staged = await auth.stageSessionToken(
        revokedToken,
        DEFAULT_USER_ID,
      );
      await auth.commitStagedSessionToken(staged);
      const prepared = await auth.prepareSessionTokenRevocation(
        revokedToken,
        DEFAULT_USER_ID,
      );
      const pendingRaw = secureStorage.values.get(TOKEN_KEY);
      const pendingAdmission = secureStorage.values.get(ADMISSION_KEY);
      const pendingMarker = markerStorage.values.get(MARKER_KEY);

      expect(prepared).toEqual(
        expectedPreparedPending(revokedToken, DEFAULT_USER_ID),
      );
      expect(pendingRaw).toBe(revokedToken);
      expect(pendingAdmission).toMatch(/^pending:v3:101:/);
      expect(pendingMarker).toBe(pendingAdmission);

      const payload: Record<string, unknown> = {
        ok: true,
        revocation: testCase.revocation,
      };
      if ("revocationUserId" in testCase) {
        payload.revocationUserId = testCase.revocationUserId;
      }
      const fetchMock = vi.fn(
        async () =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      );
      vi.stubGlobal("fetch", fetchMock);
      secureStorage.setItem.mockClear();
      secureStorage.removeItem.mockClear();
      markerStorage.setItem.mockClear();
      markerStorage.removeItem.mockClear();

      await expect(auth.revokePreparedSessionToken(prepared)).rejects.toThrow(
        "O servidor não confirmou a revogação do token em quarentena",
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(secureStorage.values.get(TOKEN_KEY)).toBe(pendingRaw);
      expect(secureStorage.values.get(ADMISSION_KEY)).toBe(pendingAdmission);
      expect(markerStorage.values.get(MARKER_KEY)).toBe(pendingMarker);
      expect(secureStorage.values.get(ADMISSION_KEY)).not.toMatch(
        /^revoked-cleanup-required:/,
      );
      expect(markerStorage.values.get(MARKER_KEY)).not.toBe(BLOCKED_MARKER);
      expect(secureStorage.setItem).not.toHaveBeenCalled();
      expect(secureStorage.removeItem).not.toHaveBeenCalled();
      expect(markerStorage.setItem).not.toHaveBeenCalled();
      expect(markerStorage.removeItem).not.toHaveBeenCalled();
      await expect(auth.getNativeSessionGateState()).resolves.toEqual({
        state: "REVOKE_REQUIRED",
      });
      await expect(auth.getSessionToken()).resolves.toBeNull();
      await expect(auth.getAdmittedSessionUserId()).resolves.toBeNull();
      expect(auth.captureSessionTransportTicket()).toBeNull();
    },
  );

  it("binding preparado bloqueia clones, prova 2xx malformada, ROTATED sem id e raw divergente", async () => {
    const revokedToken = "token-A-mutation-sensitive";
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);
    const staged = await auth.stageSessionToken(revokedToken, DEFAULT_USER_ID);
    await auth.commitStagedSessionToken(staged);
    const prepared = await auth.prepareSessionTokenRevocation(
      revokedToken,
      DEFAULT_USER_ID,
    );
    const revocationResponse = (
      revocation: "ROTATED" | "ALREADY_INVALID",
      revocationUserId?: number,
    ) =>
      new Response(
        JSON.stringify({
          ok: true,
          revocation,
          ...(revocationUserId === undefined ? {} : { revocationUserId }),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ revocation: "ALREADY_INVALID" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, revocation: "UNKNOWN" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(revocationResponse("ROTATED"))
      .mockResolvedValueOnce(revocationResponse("ROTATED", NEXT_USER_ID))
      .mockResolvedValueOnce(
        revocationResponse("ALREADY_INVALID", NEXT_USER_ID),
      );
    vi.stubGlobal("fetch", fetchMock);

    const forgedUserBinding = {
      ...prepared,
      expectedUserId: NEXT_USER_ID,
    };
    const forgedNonceBinding = {
      ...prepared,
      nonce:
        prepared.nonce === "f".repeat(32) ? "e".repeat(32) : "f".repeat(32),
    };
    const forgedPhaseBinding = {
      token: prepared.token,
      phase: "LEGACY" as const,
      fingerprint: prepared.fingerprint,
      nonce: prepared.nonce,
    } as unknown as typeof prepared;
    await expect(
      auth.revokePreparedSessionToken(forgedUserBinding),
    ).rejects.toThrow("Binding PENDING físico divergiu");
    await expect(
      auth.revokePreparedSessionToken(forgedNonceBinding),
    ).rejects.toThrow("Binding PENDING físico divergiu");
    await expect(
      auth.revokePreparedSessionToken(forgedPhaseBinding),
    ).rejects.toThrow("Binding legacy v2 físico divergiu");
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(auth.revokePreparedSessionToken(prepared)).rejects.toThrow(
      "servidor não confirmou a revogação",
    );
    await expect(auth.revokePreparedSessionToken(prepared)).rejects.toThrow(
      "servidor não confirmou a revogação",
    );
    await expect(auth.revokePreparedSessionToken(prepared)).rejects.toThrow(
      "servidor não confirmou a revogação",
    );
    await expect(auth.revokePreparedSessionToken(prepared)).rejects.toThrow(
      "revocationUserId remoto divergiu",
    );
    await expect(auth.revokePreparedSessionToken(prepared)).rejects.toThrow(
      "revocationUserId remoto divergiu",
    );
    expect(fetchMock).toHaveBeenCalledTimes(5);

    secureStorage.values.set(TOKEN_KEY, "token-fingerprint-divergente");
    await expect(auth.revokePreparedSessionToken(prepared)).rejects.toThrow(
      "raw físico mudou",
    );
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(secureStorage.values.get(ADMISSION_KEY)).toMatch(/^pending:v3:101:/);
    expect(markerStorage.values.get(MARKER_KEY)).toMatch(/^pending:v3:101:/);
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.getAdmittedSessionUserId()).resolves.toBeNull();
    expect(auth.captureSessionTransportTicket()).toBeNull();
    await expect(
      auth.getQuarantinedSessionTokenForRevocation(),
    ).rejects.toThrow("quarentena do token não pôde ser confirmada");
  });

  it("cleanup durável de A bloqueia no restart e nunca apaga um raw C posterior", async () => {
    const revokedToken = "token-A-cleanup-durable";
    const replacementToken = "token-C-posterior";
    const secureStorage = availableStorage();
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);
    const staged = await auth.stageSessionToken(revokedToken, DEFAULT_USER_ID);
    await auth.commitStagedSessionToken(staged);
    const prepared = await auth.prepareSessionTokenRevocation(
      revokedToken,
      DEFAULT_USER_ID,
    );
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ ok: true, revocation: "ALREADY_INVALID" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await auth.revokePreparedSessionToken(prepared);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const cleanupAdmission = secureStorage.values.get(ADMISSION_KEY)!;
    expect(cleanupAdmission).toMatch(
      revokedCleanupPhasePattern(revokedToken, DEFAULT_USER_ID),
    );
    expect(markerStorage.values.get(MARKER_KEY)).toBe(BLOCKED_MARKER);

    secureStorage.values.set(TOKEN_KEY, replacementToken);
    vi.resetModules();
    const restarted = await loadAuth(secureStorage, markerStorage);
    fetchMock.mockClear();

    await expect(restarted.isSessionTokenQuarantined()).rejects.toThrow(
      "Raw divergiu da admission REVOKED_CLEANUP_REQUIRED",
    );
    await expect(restarted.removeSessionToken()).rejects.toThrow(
      "Raw divergiu da admission REVOKED_CLEANUP_REQUIRED",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(secureStorage.values.get(TOKEN_KEY)).toBe(replacementToken);
    expect(secureStorage.values.get(ADMISSION_KEY)).toBe(cleanupAdmission);
    expect(markerStorage.values.get(MARKER_KEY)).toBe(BLOCKED_MARKER);
    await expect(
      restarted.stageSessionToken("token-D", NEXT_USER_ID),
    ).rejects.toThrow("Raw divergiu da admission REVOKED_CLEANUP_REQUIRED");
  });

  it("logout 5xx preserva PENDING para retry e nunca readmite o raw", async () => {
    const legacyToken = "legacy-opaque-token-logout-5xx";
    const secureStorage = availableStorage({ [TOKEN_KEY]: legacyToken });
    const markerStorage = availableStorage();
    const auth = await loadAuth(secureStorage, markerStorage);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              user: {
                id: DEFAULT_USER_ID,
                name: "Usuário legacy",
                email: null,
                role: "doctor",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    const prepared = await auth.prepareSessionTokenRevocation();
    expect(prepared).toEqual(
      expectedPreparedPending(legacyToken, DEFAULT_USER_ID),
    );
    vi.doMock("../lib/tenant-state", () => ({
      getActiveInstitutionId: vi.fn(async () => null),
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "falha" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            revocation: "ROTATED",
            revocationUserId: DEFAULT_USER_ID,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(auth.revokePreparedSessionToken(prepared)).rejects.toThrow(
      "não confirmou",
    );
    await expect(auth.getNativeSessionGateState()).resolves.toEqual({
      state: "REVOKE_REQUIRED",
    });
    await expect(auth.getQuarantinedSessionTokenForRevocation()).resolves.toBe(
      legacyToken,
    );
    await expect(auth.getSessionToken()).resolves.toBeNull();

    await auth.revokePreparedSessionToken(prepared);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // O raw só sai do cofre depois da confirmação remota. A partir desse
    // cleanup conclusivo, um novo login pode instalar B sem sobrescrever A.
    expect(secureStorage.values.get(TOKEN_KEY)).toBe(legacyToken);
    await auth.removeSessionToken();
    await expect(auth.getNativeSessionGateState()).resolves.toEqual({
      state: "CLEAR",
    });
    const next = await auth.stageSessionToken("token-B", NEXT_USER_ID);
    await expect(auth.commitStagedSessionToken(next)).resolves.toBeUndefined();
    await expect(auth.getNativeSessionGateState()).resolves.toEqual({
      state: "ADMITTED",
      expectedUserId: NEXT_USER_ID,
    });
    await expect(auth.getSessionTokenForValidation(NEXT_USER_ID)).resolves.toBe(
      "token-B",
    );
    // Mesmo B COMMITTED continua fora do canal normal até seu `/me` canônico.
    await expect(auth.getSessionToken()).resolves.toBeNull();
  });

  it("ACK perdido da barreira legacy é confirmado por readback e o recovery continua", async () => {
    const legacyToken = "legacy-opaque-token-ack-lost";
    const secureStorage = availableStorage({ [TOKEN_KEY]: legacyToken });
    const markerStorage = availableStorage();
    markerStorage.setItem.mockImplementation(
      async (key: string, value: string) => {
        markerStorage.values.set(key, value);
        throw new Error("ACK do marker legacy perdido");
      },
    );
    const auth = await loadAuth(secureStorage, markerStorage);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              user: {
                id: DEFAULT_USER_ID,
                name: "Usuário legacy",
                email: null,
                role: "doctor",
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    await expect(auth.prepareSessionTokenRevocation()).resolves.toEqual(
      expectedPreparedPending(legacyToken, DEFAULT_USER_ID),
    );
    await expect(auth.getNativeSessionGateState()).resolves.toEqual({
      state: "REVOKE_REQUIRED",
    });
    await expect(auth.getSessionToken()).resolves.toBeNull();
  });

  it.each(["marker", "admission"] as const)(
    "crash após persistir somente %s legacy retoma pelo fingerprint exato",
    async (durableHalf) => {
      const legacyToken = `legacy-opaque-token-crash-${durableHalf}`;
      const marker = legacyRevocationMarker(legacyToken);
      const secureStorage = availableStorage({
        [TOKEN_KEY]: legacyToken,
        ...(durableHalf === "admission" ? { [ADMISSION_KEY]: marker } : {}),
      });
      const markerStorage = availableStorage(
        durableHalf === "marker" ? { [MARKER_KEY]: marker } : {},
      );
      const auth = await loadAuth(secureStorage, markerStorage);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, options?: RequestInit) => {
          expect(markerStorage.values.get(MARKER_KEY)).toMatch(
            legacyRevocationV2Pattern(legacyToken),
          );
          expect(secureStorage.values.get(ADMISSION_KEY)).toBe(
            markerStorage.values.get(MARKER_KEY),
          );
          expect(
            (options?.headers as Record<string, string>).Authorization,
          ).toBe(`Bearer ${legacyToken}`);
          return new Response(
            JSON.stringify({
              user: {
                id: DEFAULT_USER_ID,
                name: "Usuário legacy",
                email: null,
                role: "doctor",
              },
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }),
      );

      await expect(auth.getNativeSessionGateState()).resolves.toEqual({
        state: "LEGACY_REVOKE_REQUIRED",
      });
      await expect(auth.prepareSessionTokenRevocation()).resolves.toEqual(
        expectedPreparedPending(legacyToken, DEFAULT_USER_ID),
      );
      await expect(auth.getNativeSessionGateState()).resolves.toEqual({
        state: "REVOKE_REQUIRED",
      });
      await expect(
        auth.getQuarantinedSessionTokenForRevocation(),
      ).resolves.toBe(legacyToken);
      await expect(auth.getSessionToken()).resolves.toBeNull();
    },
  );

  it("marker legacy v2 no-op bloqueia /me/logout mesmo após admission v2 confirmada", async () => {
    const legacyToken = "legacy-opaque-token-marker-noop";
    const secureStorage = availableStorage({ [TOKEN_KEY]: legacyToken });
    const markerStorage = availableStorage();
    markerStorage.setItem.mockImplementation(async () => undefined);
    const auth = await loadAuth(secureStorage, markerStorage);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(auth.prepareSessionTokenRevocation()).rejects.toThrow(
      "marker legacy v2 não pôde ser confirmado",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(secureStorage.values.get(ADMISSION_KEY)).toMatch(
      legacyRevocationV2Pattern(legacyToken),
    );
    expect(markerStorage.values.has(MARKER_KEY)).toBe(false);
    expect(secureStorage.values.get(TOKEN_KEY)).toBe(legacyToken);
    await expect(auth.getNativeSessionGateState()).resolves.toEqual({
      state: "LEGACY_REVOKE_REQUIRED",
    });
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(auth.getAdmittedSessionUserId()).resolves.toBeNull();
    await expect(auth.getQuarantinedSessionTokenForRevocation()).resolves.toBe(
      legacyToken,
    );

    vi.resetModules();
    const restarted = await loadAuth(secureStorage, markerStorage);
    await expect(restarted.prepareSessionTokenRevocation()).rejects.toThrow(
      "marker legacy v2 não pôde ser confirmado",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("setItem no-op em ambos os stores bloqueia /me/logout e preserva raw-only para retry", async () => {
    const legacyToken = "legacy-opaque-token-noop";
    const secureStorage = availableStorage({ [TOKEN_KEY]: legacyToken });
    const markerStorage = availableStorage();
    secureStorage.setItem.mockImplementation(async () => undefined);
    markerStorage.setItem.mockImplementation(async () => undefined);
    const auth = await loadAuth(secureStorage, markerStorage);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(auth.prepareSessionTokenRevocation()).rejects.toThrow(
      "admission legacy v2 não pôde ser confirmada",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(secureStorage.values.get(TOKEN_KEY)).toBe(legacyToken);
    await expect(auth.getNativeSessionGateState()).resolves.toEqual({
      state: "LEGACY_REVOKE_REQUIRED",
    });
    await expect(
      auth.getQuarantinedSessionTokenForRevocation(),
    ).rejects.toThrow("quarentena do token não pôde ser confirmada");
    await expect(auth.getSessionToken()).resolves.toBeNull();
    await expect(
      auth.stageSessionToken("token-B", NEXT_USER_ID),
    ).rejects.toThrow("sessão pendente");
  });

  it.each([
    ["ausente", undefined],
    ["malformada", "v1.prova-invalida"],
  ])(
    "/me web com sessionInstance %s não cunha receipt nem abre transporte",
    async (_label, sessionInstance) => {
      const asyncStorage = availableStorage();
      const auth = await loadAuth(asyncStorage, asyncStorage, "web");
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                ...(sessionInstance === undefined ? {} : { sessionInstance }),
                user: {
                  id: DEFAULT_USER_ID,
                  name: "Usuário sem proof canônica",
                  email: null,
                  role: "doctor",
                },
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            ),
        ),
      );

      const result = await auth.validateCanonicalSession(DEFAULT_USER_ID);

      expect(result).toEqual({
        user: null,
        sessionInvalid: false,
        networkOrServerError: true,
      });
      expect(auth.captureSessionTransportTicket()).toBeNull();
      expect(auth.isSessionTransportUserCurrent(DEFAULT_USER_ID)).toBe(false);
    },
  );

  it("Web Lock compartilhado serializa o workflow completo entre duas abas", async () => {
    const storage = browserStorage();
    const locks = sharedWebLocks();
    installBrowser(storage, locks);
    const asyncStorage = availableStorage();
    const authA = await loadAuth(asyncStorage, asyncStorage, "web");
    vi.resetModules();
    const authB = await loadAuth(asyncStorage, asyncStorage, "web");
    const cookieResponse = deferred<void>();
    const order: string[] = [];

    const workflowA = authA.runExclusiveWebSessionMutation(async () => {
      order.push("A:begin");
      const login = await authA.beginWebLoginInProgress();
      authA.consumeWebLoginInProgressForRequest(login);
      order.push("A:cookie");
      await cookieResponse.promise;
      await authA.prepareWebSessionAdmission(DEFAULT_USER_ID);
      await authA.admitWebSessionTransport(
        await canonicalValidationReceipt(authA, DEFAULT_USER_ID),
      );
      order.push("A:end");
    });
    await vi.waitFor(() => expect(order).toEqual(["A:begin", "A:cookie"]));

    const workflowB = authB.runExclusiveWebSessionMutation(async () => {
      order.push("B:begin");
      await authB.beginWebLoginInProgress();
      order.push("B:login");
    });
    await Promise.resolve();
    expect(order).toEqual(["A:begin", "A:cookie"]);

    cookieResponse.resolve();
    await workflowA;
    await workflowB;
    expect(order).toEqual([
      "A:begin",
      "A:cookie",
      "A:end",
      "B:begin",
      "B:login",
    ]);
  });

  it("revisão física cancela intent A sob cookie A2 mesmo sem StorageEvent entregue", async () => {
    const storage = browserStorage();
    const locks = sharedWebLocks();
    // Os listeners ficam deliberadamente sem dispatch: a prova precisa vir da
    // leitura física, não da entrega assíncrona do evento entre abas.
    installBrowser(storage, locks);
    const asyncStorage = availableStorage();
    const authA = await loadAuth(asyncStorage, asyncStorage, "web");
    await authA.admitWebSessionTransport(
      await canonicalValidationReceipt(authA, DEFAULT_USER_ID),
    );
    const ticketA = authA.captureSessionTransportTicket();
    const intentA = authA.captureWebSessionMutationIntent(
      DEFAULT_USER_ID,
      true,
    );
    expect(ticketA).not.toBeNull();
    expect(intentA).not.toBeNull();
    const revisionA = storage.values.get(WEB_WORKFLOW_REVISION_KEY);
    expect(revisionA).toMatch(WEB_WORKFLOW_REVISION);

    vi.resetModules();
    const authB = await loadAuth(asyncStorage, asyncStorage, "web");
    const intentB = authB.captureWebSessionMutationIntent();
    expect(intentB).not.toBeNull();
    const bHoldingLock = deferred<void>();
    const releaseB = deferred<void>();
    const workflowB = authB.runExclusiveWebSessionMutation(async () => {
      authB.beginWebSessionMutationIntent(intentB!);
      await authB.admitWebSessionTransport(
        await canonicalValidationReceipt(authB, DEFAULT_USER_ID),
      );
      bHoldingLock.resolve();
      await releaseB.promise;
    });
    await bHoldingLock.promise;

    const revisionB = storage.values.get(WEB_WORKFLOW_REVISION_KEY);
    expect(revisionB).toMatch(WEB_WORKFLOW_REVISION);
    expect(revisionB).not.toBe(revisionA);
    expect(authA.captureSessionTransportTicket()).toBeNull();
    expect(authA.isSessionTransportTicketCurrent(ticketA!)).toBe(false);
    expect(authA.isSessionTransportUserCurrent(DEFAULT_USER_ID)).toBe(false);

    const irreversibleEffect = vi.fn();
    const workflowA = authA.runExclusiveWebSessionMutation(async () => {
      authA.beginWebSessionMutationIntent(intentA!);
      irreversibleEffect();
    });
    await Promise.resolve();
    expect(irreversibleEffect).not.toHaveBeenCalled();
    releaseB.resolve();
    await workflowB;
    await expect(workflowA).rejects.toThrow(
      "A sessão web mudou em outra aba antes da operação",
    );
    expect(irreversibleEffect).not.toHaveBeenCalled();
  });

  it("write no-op da revisão bloqueia marker e efeito remoto", async () => {
    const storage = browserStorage();
    installBrowser(storage, sharedWebLocks());
    const asyncStorage = availableStorage();
    const auth = await loadAuth(asyncStorage, asyncStorage, "web");
    await auth.admitWebSessionTransport(
      await canonicalValidationReceipt(auth, DEFAULT_USER_ID),
    );
    const intent = auth.captureWebSessionMutationIntent(DEFAULT_USER_ID, true);
    expect(intent).not.toBeNull();
    const originalSet = storage.setItem.getMockImplementation();
    storage.setItem.mockImplementation((key: string, value: string) => {
      if (key === WEB_WORKFLOW_REVISION_KEY) return;
      originalSet?.(key, value);
    });
    const markerEffect = vi.fn();
    const remoteEffect = vi.fn();

    await expect(
      auth.runExclusiveWebSessionMutation(async () => {
        auth.beginWebSessionMutationIntent(intent!);
        markerEffect();
        remoteEffect();
      }),
    ).rejects.toThrow("Revisão da sessão web não foi confirmada");
    expect(markerEffect).not.toHaveBeenCalled();
    expect(remoteEffect).not.toHaveBeenCalled();
    expect(storage.values.has(WEB_GATE_KEY)).toBe(false);
  });

  it("ACK perdido da revisão aplicada ainda bloqueia marker e efeito remoto", async () => {
    const storage = browserStorage();
    installBrowser(storage, sharedWebLocks());
    const asyncStorage = availableStorage();
    const auth = await loadAuth(asyncStorage, asyncStorage, "web");
    await auth.admitWebSessionTransport(
      await canonicalValidationReceipt(auth, DEFAULT_USER_ID),
    );
    const intent = auth.captureWebSessionMutationIntent(DEFAULT_USER_ID, true);
    expect(intent).not.toBeNull();
    const originalSet = storage.setItem.getMockImplementation();
    storage.setItem.mockImplementation((key: string, value: string) => {
      originalSet?.(key, value);
      if (key === WEB_WORKFLOW_REVISION_KEY) {
        throw new Error("ACK da revisão perdido");
      }
    });
    const markerEffect = vi.fn();
    const remoteEffect = vi.fn();

    await expect(
      auth.runExclusiveWebSessionMutation(async () => {
        auth.beginWebSessionMutationIntent(intent!);
        markerEffect();
        remoteEffect();
      }),
    ).rejects.toThrow("ACK da revisão perdido");
    expect(markerEffect).not.toHaveBeenCalled();
    expect(remoteEffect).not.toHaveBeenCalled();
    expect(storage.values.get(WEB_WORKFLOW_REVISION_KEY)).toMatch(
      WEB_WORKFLOW_REVISION,
    );
    expect(storage.values.has(WEB_GATE_KEY)).toBe(false);
  });

  it("capability web só é consumida pelo workflow que avançou sua revisão", async () => {
    const storage = browserStorage();
    installBrowser(storage, sharedWebLocks());
    const asyncStorage = availableStorage();
    const auth = await loadAuth(asyncStorage, asyncStorage, "web");
    await auth.admitWebSessionTransport(
      await canonicalValidationReceipt(auth, DEFAULT_USER_ID),
    );

    const outsideCredential = auth.captureSessionTransitionCredential(
      "rotate-session",
      DEFAULT_USER_ID,
    );
    expect(outsideCredential).not.toBeNull();
    expect(() =>
      auth.consumeSessionTransitionCredentialForRequest(
        outsideCredential!,
        "/api/auth/change-password",
        "POST",
      ),
    ).toThrow("fora do workflow que cercou a sessão");

    const intent = auth.captureWebSessionMutationIntent(DEFAULT_USER_ID, true);
    const credential = auth.captureSessionTransitionCredential(
      "rotate-session",
      DEFAULT_USER_ID,
    );
    expect(intent).not.toBeNull();
    expect(credential).not.toBeNull();
    await expect(
      auth.runExclusiveWebSessionMutation(async () => {
        auth.beginWebSessionMutationIntent(intent!);
        return auth.consumeSessionTransitionCredentialForRequest(
          credential!,
          "/api/auth/change-password",
          "POST",
        );
      }),
    ).resolves.toEqual({
      expectedUserId: DEFAULT_USER_ID,
      sessionInstance: SESSION_INSTANCE,
    });
  });

  it("capability web rejeita mudança física da revisão durante o workflow", async () => {
    const storage = browserStorage();
    installBrowser(storage, sharedWebLocks());
    const asyncStorage = availableStorage();
    const auth = await loadAuth(asyncStorage, asyncStorage, "web");
    await auth.admitWebSessionTransport(
      await canonicalValidationReceipt(auth, DEFAULT_USER_ID),
    );
    const intent = auth.captureWebSessionMutationIntent(DEFAULT_USER_ID, true);
    const credential = auth.captureSessionTransitionCredential(
      "delete-account",
      DEFAULT_USER_ID,
    );
    expect(intent).not.toBeNull();
    expect(credential).not.toBeNull();

    await expect(
      auth.runExclusiveWebSessionMutation(async () => {
        auth.beginWebSessionMutationIntent(intent!);
        storage.values.set(
          WEB_WORKFLOW_REVISION_KEY,
          "workflow:v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        );
        return auth.consumeSessionTransitionCredentialForRequest(
          credential!,
          "/api/auth/me",
          "DELETE",
        );
      }),
    ).rejects.toThrow("fora do workflow que cercou a sessão");
  });

  it("deadline aborta fetch pendurado e libera o workflow da segunda aba", async () => {
    vi.useFakeTimers();
    try {
      const storage = browserStorage();
      const locks = sharedWebLocks();
      installBrowser(storage, locks);
      const asyncStorage = availableStorage();
      const auth = await loadAuth(asyncStorage, asyncStorage, "web");
      await auth.admitWebSessionTransport(
        await canonicalValidationReceipt(auth, DEFAULT_USER_ID),
      );
      vi.doMock("../lib/tenant-state", () => ({
        getActiveInstitutionId: vi.fn(async () => null),
      }));

      const fetchStarted = deferred<void>();
      const fetchMock = vi.fn(
        async (_url: string, options?: RequestInit): Promise<Response> => {
          fetchStarted.resolve();
          const signal = options?.signal;
          if (!signal) throw new Error("signal do workflow ausente");
          return new Promise<Response>((_resolve, reject) => {
            const rejectAbort = () =>
              reject(signal.reason ?? new Error("workflow abortado"));
            if (signal.aborted) rejectAbort();
            else signal.addEventListener("abort", rejectAbort, { once: true });
          });
        },
      );
      vi.stubGlobal("fetch", fetchMock);
      const { apiFetch } = await import("../lib/_core/api");
      const order: string[] = [];

      const workflowA = auth.runExclusiveWebSessionMutation(async () => {
        order.push("A:begin");
        const response = await apiFetch("/api/protected");
        order.push(`A:${response.status}`);
      });
      await fetchStarted.promise;

      const workflowB = auth.runExclusiveWebSessionMutation(async () => {
        order.push("B:begin");
      });
      await vi.waitFor(() => expect(order).toEqual(["A:begin"]));

      await vi.advanceTimersByTimeAsync(auth.WEB_SESSION_MUTATION_DEADLINE_MS);
      await workflowA;
      await workflowB;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["A:begin", "A:0", "B:begin"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deadline inclui a espera pelo Web Lock de mutação e nunca executa callback vencida", async () => {
    vi.useFakeTimers();
    try {
      const storage = browserStorage();
      const locks = sharedWebLocks();
      installBrowser(storage, locks);
      const asyncStorage = availableStorage();
      const auth = await loadAuth(asyncStorage, asyncStorage, "web");
      const holderStarted = deferred<void>();
      const releaseHolder = deferred<void>();
      const holder = locks.request(
        "escalas-web-session-mutation-v1",
        { mode: "exclusive" },
        async () => {
          holderStarted.resolve();
          await releaseHolder.promise;
        },
      );
      await holderStarted.promise;
      const expiredEffect = vi.fn();

      const expired = auth.runExclusiveWebSessionMutation(async () => {
        expiredEffect();
      });
      const expiredResult = expired.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(auth.WEB_SESSION_MUTATION_DEADLINE_MS);
      const expiredError = await expiredResult;
      expect(expiredError).toBeInstanceOf(
        auth.WebSessionMutationCancelledError,
      );
      expect(expiredError).toMatchObject({
        message: "Workflow de sessão web excedeu o prazo seguro",
      });
      expect(expiredEffect).not.toHaveBeenCalled();

      releaseHolder.resolve();
      await holder;
      const nextEffect = vi.fn();
      await auth.runExclusiveWebSessionMutation(async () => {
        nextEffect();
      });
      expect(nextEffect).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deadline inclui a espera pelo Web Lock pontual do gate", async () => {
    vi.useFakeTimers();
    try {
      const storage = browserStorage();
      const locks = sharedWebLocks();
      installBrowser(storage, locks);
      const asyncStorage = availableStorage();
      const auth = await loadAuth(asyncStorage, asyncStorage, "web");
      const holderStarted = deferred<void>();
      const releaseHolder = deferred<void>();
      const holder = locks.request(
        "escalas-web-session-gate-v1",
        { mode: "exclusive" },
        async () => {
          holderStarted.resolve();
          await releaseHolder.promise;
        },
      );
      await holderStarted.promise;

      const expired = auth.runExclusiveWebSessionMutation(() =>
        auth.beginWebLoginInProgress(),
      );
      const expiredResult = expect(expired).rejects.toThrow(
        "Workflow de sessão web excedeu o prazo seguro",
      );
      await vi.advanceTimersByTimeAsync(auth.WEB_SESSION_MUTATION_DEADLINE_MS);
      await expiredResult;
      expect(storage.values.has(WEB_GATE_KEY)).toBe(false);

      releaseHolder.resolve();
      await holder;
      await auth.runExclusiveWebSessionMutation(() =>
        auth.beginWebLoginInProgress(),
      );
      expect(storage.values.get(WEB_GATE_KEY)).toMatch(WEB_LOGIN_MARKER);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deadline permanece ligado durante body pendurado e libera a segunda aba", async () => {
    vi.useFakeTimers();
    try {
      const storage = browserStorage();
      const locks = sharedWebLocks();
      installBrowser(storage, locks);
      const asyncStorage = availableStorage();
      const auth = await loadAuth(asyncStorage, asyncStorage, "web");
      await auth.admitWebSessionTransport(
        await canonicalValidationReceipt(auth, DEFAULT_USER_ID),
      );
      vi.doMock("../lib/tenant-state", () => ({
        getActiveInstitutionId: vi.fn(async () => null),
      }));

      const headersReceived = deferred<void>();
      const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
        const signal = options?.signal;
        if (!signal) throw new Error("signal do workflow ausente");
        headersReceived.resolve();
        return {
          ok: true,
          status: 200,
          json: () =>
            new Promise<never>((_resolve, reject) => {
              const rejectAbort = () =>
                reject(signal.reason ?? new Error("workflow abortado"));
              if (signal.aborted) rejectAbort();
              else
                signal.addEventListener("abort", rejectAbort, { once: true });
            }),
        } as Response;
      });
      vi.stubGlobal("fetch", fetchMock);
      const { apiFetch } = await import("../lib/_core/api");
      const order: string[] = [];

      const workflowA = auth.runExclusiveWebSessionMutation(async () => {
        order.push("A:begin");
        const response = await apiFetch("/api/protected");
        order.push(`A:${response.status}`);
      });
      await headersReceived.promise;
      const workflowB = auth.runExclusiveWebSessionMutation(async () => {
        order.push("B:begin");
      });
      await vi.waitFor(() => expect(order).toEqual(["A:begin"]));

      await vi.advanceTimersByTimeAsync(auth.WEB_SESSION_MUTATION_DEADLINE_MS);
      await workflowA;
      await workflowB;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["A:begin", "A:0", "B:begin"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deadline cancela idle push pendurado, libera o lock e cerca a resposta tardia", async () => {
    vi.useFakeTimers();
    try {
      const storage = browserStorage();
      const locks = sharedWebLocks();
      installBrowser(storage, locks);
      const asyncStorage = availableStorage();
      const auth = await loadAuth(asyncStorage, asyncStorage, "web");
      vi.doMock("@/lib/push-token", () => ({
        clearServerRegisteredPushTokenVault: vi.fn(async () => undefined),
      }));
      const registration = await import("../lib/push-registration");
      const serverResponse = deferred<{ success: boolean }>();
      const postStarted = deferred<void>();
      const context = {
        userId: DEFAULT_USER_ID,
        token: "ExponentPushToken[deadline-registration]",
        platform: "ios" as const,
      };
      const inFlight = registration.ensurePushRegistration(
        context,
        vi.fn(async () => {
          postStarted.resolve();
          return serverResponse.promise;
        }),
      );
      await postStarted.promise;
      registration.closePushRegistrationAdmission();
      const order: string[] = [];

      const workflowA = auth.runExclusiveWebSessionMutation(async () => {
        order.push("A:begin");
        await expect(
          registration.waitForPushRegistrationIdle(),
        ).rejects.toThrow("Workflow de sessão web excedeu o prazo seguro");
        order.push("A:timeout");
      });
      const workflowB = auth.runExclusiveWebSessionMutation(async () => {
        order.push("B:begin");
      });
      await vi.waitFor(() => expect(order).toEqual(["A:begin"]));

      await vi.advanceTimersByTimeAsync(auth.WEB_SESSION_MUTATION_DEADLINE_MS);
      await workflowA;
      await workflowB;
      expect(order).toEqual(["A:begin", "A:timeout", "B:begin"]);

      serverResponse.resolve({ success: true });
      await expect(inFlight).resolves.toBe(true);
      expect(registration.hasFreshPushRegistrationProof(context)).toBe(false);
      expect(asyncStorage.values.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("capability stale de uma aba nunca remove o nonce que outra aba substituiu", async () => {
    const storage = browserStorage();
    const locks = sharedWebLocks();
    installBrowser(storage, locks);
    const asyncStorage = availableStorage();
    const authA = await loadAuth(asyncStorage, asyncStorage, "web");
    let loginA: Awaited<ReturnType<typeof authA.beginWebLoginInProgress>>;
    await authA.runExclusiveWebSessionMutation(async () => {
      loginA = await authA.beginWebLoginInProgress();
    });
    const markerA = storage.values.get(WEB_GATE_KEY);
    vi.resetModules();
    const authB = await loadAuth(asyncStorage, asyncStorage, "web");
    await authB.runExclusiveWebSessionMutation(() =>
      authB.beginWebSessionQuarantine(),
    );
    const markerB = storage.values.get(WEB_GATE_KEY);

    expect(markerA).toMatch(WEB_LOGIN_MARKER);
    expect(markerB).toMatch(WEB_REVOCATION_MARKER);
    expect(markerB).not.toBe(markerA);
    await expect(
      authA.runExclusiveWebSessionMutation(() =>
        authA.cancelWebLoginInProgress(loginA),
      ),
    ).rejects.toThrow("Capability de cancelamento do login inválida");
    expect(storage.values.get(WEB_GATE_KEY)).toBe(markerB);
  });

  it("uma única quarentena fresca preserva o binding da ADMISSION em revoke-only", async () => {
    const storage = availableStorage({
      [WEB_GATE_KEY]:
        "pending-admission:v3:202:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const auth = await loadAuth(storage, storage, "web");

    await auth.beginWebSessionQuarantine();

    expect(storage.values.get(WEB_GATE_KEY)).toMatch(
      /^pending-revocation:v3:202:[0-9a-f]{32}$/,
    );
    await expect(auth.getWebSessionGateState()).resolves.toEqual({
      state: "REVOKE_REQUIRED",
      expectedUserId: NEXT_USER_ID,
    });
  });

  it("/me mismatch nunca limpa ADMISSION; só o logout tipado pode finalizar A", async () => {
    const markerA = "pending-admission:v3:101:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const markerB = "pending-admission:v3:202:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const storage = availableStorage({ [WEB_GATE_KEY]: markerA });
    let auth = await loadAuth(storage, storage, "web");

    await expect(auth.getWebSessionGateState()).resolves.toEqual({
      state: "ADMISSION",
      expectedUserId: DEFAULT_USER_ID,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: "EXPECTED_USER_MISMATCH",
              currentSessionUserId: NEXT_USER_ID,
            }),
            {
              status: 409,
              headers: { "Content-Type": "application/json" },
            },
          ),
      ),
    );
    await expect(
      auth.validateCanonicalSession(DEFAULT_USER_ID),
    ).resolves.toMatchObject({
      user: null,
      code: "EXPECTED_USER_MISMATCH",
    });
    expect(storage.values.get(WEB_GATE_KEY)).toBe(markerA);

    storage.values.set(WEB_GATE_KEY, markerA);
    vi.resetModules();
    auth = await loadAuth(storage, storage, "web");
    await expect(auth.getWebSessionGateState()).resolves.toEqual({
      state: "ADMISSION",
      expectedUserId: DEFAULT_USER_ID,
    });
    storage.values.set(WEB_GATE_KEY, markerB);

    await expect(
      auth.validateCanonicalSession(DEFAULT_USER_ID),
    ).resolves.toMatchObject({
      user: null,
      code: "EXPECTED_USER_MISMATCH",
    });
    expect(storage.values.get(WEB_GATE_KEY)).toBe(markerB);
  });

  it("localStorage.clear invalida ticket e receipt vivos antes do rerender", async () => {
    const storage = browserStorage();
    const locks = sharedWebLocks();
    const listeners = installBrowser(storage, locks);
    const asyncStorage = availableStorage();
    const auth = await loadAuth(asyncStorage, asyncStorage, "web");
    const invalidated = vi.fn();
    await auth.admitWebSessionTransport(
      await canonicalValidationReceipt(auth, DEFAULT_USER_ID),
    );
    const ticket = auth.captureSessionTransportTicket();
    auth.subscribeExternalWebSessionInvalidation(invalidated);

    listeners.get("storage")?.({
      key: null,
      newValue: null,
    } as StorageEvent);

    expect(ticket).not.toBeNull();
    expect(auth.isSessionTransportTicketCurrent(ticket!)).toBe(false);
    expect(auth.isSessionTransportUserCurrent(DEFAULT_USER_ID)).toBe(false);
    expect(invalidated).toHaveBeenCalledTimes(1);
  });

  it("browser sem Web Locks falha fechado antes de marker ou efeito remoto", async () => {
    const storage = browserStorage();
    installBrowser(storage, null);
    const asyncStorage = availableStorage();
    const auth = await loadAuth(asyncStorage, asyncStorage, "web");
    const effect = vi.fn(async () => undefined);

    await expect(
      auth.runExclusiveWebSessionMutation(async () => {
        await auth.beginWebLoginInProgress();
        await effect();
      }),
    ).rejects.toThrow("Bloqueio cross-tab da sessão web indisponível");
    expect(storage.values.has(WEB_GATE_KEY)).toBe(false);
    expect(effect).not.toHaveBeenCalled();
  });

  it("browser sem localStorage falha fechado antes de operação ou efeito", async () => {
    const locks = sharedWebLocks();
    vi.stubGlobal("window", {
      localStorage: null,
      addEventListener: vi.fn(),
    });
    vi.stubGlobal("navigator", { locks });
    const asyncStorage = availableStorage();
    const auth = await loadAuth(asyncStorage, asyncStorage, "web");
    const effect = vi.fn(async () => undefined);

    await expect(
      auth.runExclusiveWebSessionMutation(async () => {
        await auth.beginWebLoginInProgress();
        await effect();
      }),
    ).rejects.toThrow("Storage cross-tab da sessão web indisponível");
    await expect(auth.getWebSessionGateState()).resolves.toEqual({
      state: "REVOKE_REQUIRED",
    });
    expect(asyncStorage.setItem).not.toHaveBeenCalled();
    expect(effect).not.toHaveBeenCalled();
  });

  it("runtime web sem window falha fechado e nunca executa o workflow", async () => {
    vi.unstubAllGlobals();
    const storage = availableStorage();
    const auth = await loadAuth(storage, storage, "web", false);
    const effect = vi.fn(async () => undefined);

    await expect(
      auth.runExclusiveWebSessionMutation(async () => {
        await auth.beginWebLoginInProgress();
        await effect();
      }),
    ).rejects.toThrow("Storage cross-tab da sessão web indisponível");
    expect(effect).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("LOGIN_IN_PROGRESS sobrevive ao crash anterior ao POST e exige revogação", async () => {
    const storage = availableStorage();
    let auth = await loadAuth(storage, storage, "web");

    await auth.runExclusiveWebSessionMutation(() =>
      auth.beginWebLoginInProgress(),
    );
    expect(storage.values.get(WEB_GATE_KEY)).toMatch(WEB_LOGIN_MARKER);
    await expect(auth.getWebSessionGateState()).resolves.toEqual({
      state: "REVOKE_REQUIRED",
    });
    await expect(auth.isWebSessionQuarantined()).resolves.toBe(true);

    vi.resetModules();
    auth = await loadAuth(storage, storage, "web");
    await expect(auth.getWebSessionGateState()).resolves.toEqual({
      state: "REVOKE_REQUIRED",
    });
    await expect(auth.isWebSessionQuarantined()).resolves.toBe(true);
    expect("clearWebSessionQuarantine" in auth).toBe(false);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "indisponível" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            revocation: "ALREADY_INVALID",
            sessionFenceRotated: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      auth.runExclusiveWebSessionMutation(async () => {
        await auth.beginWebSessionQuarantine();
        await auth.revokeWebSessionQuarantine();
      }),
    ).rejects.toThrow("não confirmou a revogação");
    expect(storage.values.get(WEB_GATE_KEY)).toMatch(WEB_REVOCATION_MARKER);

    await auth.runExclusiveWebSessionMutation(async () => {
      await auth.beginWebSessionQuarantine();
      await auth.revokeWebSessionQuarantine();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(storage.values.has(WEB_GATE_KEY)).toBe(false);
    await expect(auth.isWebSessionQuarantined()).resolves.toBe(false);
  });

  it("crash pós-Set-Cookie exact converte LOGIN_IN_PROGRESS em v4 só para revogação", async () => {
    process.env[CLIENT_ACTIVE_ENV] = "1";
    const storage = availableStorage();
    const auth = await loadAuth(storage, storage, "web");
    await auth.runExclusiveWebSessionMutation(() =>
      auth.beginWebLoginInProgress(),
    );
    const loginMarker = storage.values.get(WEB_GATE_KEY);
    expect(loginMarker).toMatch(WEB_LOGIN_MARKER);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              user: {
                id: DEFAULT_USER_ID,
                name: "Usuário exact",
                email: "exact@example.com",
                role: "doctor",
              },
              sessionInstance: SESSION_INSTANCE,
              // Uma sessão legacy também pode ser identificada para logout, mas
              // jamais promovida pelo cliente exact.
              sessionBinding: {
                capability: "exact-v1",
                supported: true,
                sessionVersion: null,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    const result = await auth.runExclusiveWebSessionMutation(() =>
      auth.bootstrapExactWebSessionRevocation(),
    );

    expect(result).toEqual({
      state: "BOUND",
      expectedUserId: DEFAULT_USER_ID,
      sessionInstance: SESSION_INSTANCE,
    });
    expect(storage.values.get(WEB_GATE_KEY)).toMatch(
      WEB_EXACT_REVOCATION_MARKER,
    );
    await expect(auth.getWebSessionGateState()).resolves.toEqual({
      state: "REVOKE_REQUIRED",
      expectedUserId: DEFAULT_USER_ID,
      sessionInstance: SESSION_INSTANCE,
    });
    expect(auth.captureSessionTransportTicket()).toBeNull();
  });

  it("rede no bootstrap exact mantém o marker físico e nunca cunha autoridade", async () => {
    process.env[CLIENT_ACTIVE_ENV] = "1";
    const storage = availableStorage();
    const auth = await loadAuth(storage, storage, "web");
    await auth.runExclusiveWebSessionMutation(() =>
      auth.beginWebLoginInProgress(),
    );
    const loginMarker = storage.values.get(WEB_GATE_KEY);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("rede indisponível");
      }),
    );

    await expect(
      auth.runExclusiveWebSessionMutation(() =>
        auth.bootstrapExactWebSessionRevocation(),
      ),
    ).rejects.toThrow("/me não confirmou a instância revogável");
    expect(storage.values.get(WEB_GATE_KEY)).toBe(loginMarker);
    expect(auth.captureSessionTransportTicket()).toBeNull();
  });

  it("401 no bootstrap exact mantém a barreira para logout idempotente com fence", async () => {
    process.env[CLIENT_ACTIVE_ENV] = "1";
    const storage = availableStorage();
    const auth = await loadAuth(storage, storage, "web");
    await auth.runExclusiveWebSessionMutation(() =>
      auth.beginWebLoginInProgress(),
    );
    const loginMarker = storage.values.get(WEB_GATE_KEY);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: "unauthorized",
              credentialPresented: true,
            }),
            {
              status: 401,
              headers: { "Content-Type": "application/json" },
            },
          ),
      ),
    );

    await expect(
      auth.runExclusiveWebSessionMutation(() =>
        auth.bootstrapExactWebSessionRevocation(),
      ),
    ).resolves.toEqual({ state: "INVALID" });
    expect(storage.values.get(WEB_GATE_KEY)).toBe(loginMarker);
    expect(auth.captureSessionTransportTicket()).toBeNull();
  });

  it("LOGIN_IN_PROGRESS exige gate CLEAR e nunca sobrescreve recovery anterior", async () => {
    const storage = availableStorage();
    const auth = await loadAuth(storage, storage, "web");
    await auth.runExclusiveWebSessionMutation(async () => {
      const login = await auth.beginWebLoginInProgress();
      const loginMarker = storage.values.get(WEB_GATE_KEY);
      auth.consumeWebLoginInProgressForRequest(login);

      await expect(auth.beginWebLoginInProgress()).rejects.toThrow(
        "A sessão web mudou em outra aba",
      );
      expect(storage.values.get(WEB_GATE_KEY)).toBe(loginMarker);

      await auth.prepareWebSessionAdmission(NEXT_USER_ID);
      const admissionMarker = storage.values.get(WEB_GATE_KEY);
      await expect(auth.beginWebLoginInProgress()).rejects.toThrow(
        "A sessão web mudou em outra aba",
      );
      expect(admissionMarker).toMatch(WEB_ADMISSION_MARKER);
      expect(storage.values.get(WEB_GATE_KEY)).toBe(admissionMarker);
    });
  });

  it("LOGIN_IN_PROGRESS detecta setItem no-op antes do POST", async () => {
    const storage = availableStorage();
    const auth = await loadAuth(storage, storage, "web");
    installedBrowserStorage(storage).setItem.mockImplementation(
      () => undefined,
    );

    await expect(
      auth.runExclusiveWebSessionMutation(() => auth.beginWebLoginInProgress()),
    ).rejects.toThrow("Início do login web não foi confirmado");
    await expect(auth.getWebSessionGateState()).resolves.toEqual({
      state: "CLEAR",
    });
  });

  it("rotação web instala ADMISSION diretamente de CLEAR", async () => {
    const storage = availableStorage();
    const auth = await loadAuth(storage, storage, "web");

    await auth.beginWebSessionAdmission(NEXT_USER_ID);
    const admissionMarker = storage.values.get(WEB_GATE_KEY);
    expect(admissionMarker).toMatch(WEB_ADMISSION_MARKER);
    await expect(auth.getWebSessionGateState()).resolves.toEqual({
      state: "ADMISSION",
      expectedUserId: NEXT_USER_ID,
    });
    await expect(
      auth.beginWebSessionAdmission(DEFAULT_USER_ID),
    ).rejects.toThrow("A sessão web mudou em outra aba");
    expect(storage.values.get(WEB_GATE_KEY)).toBe(admissionMarker);
  });

  it("rotação web com write no-op falha e deixa gate CLEAR", async () => {
    const storage = availableStorage();
    const auth = await loadAuth(storage, storage, "web");
    installedBrowserStorage(storage).setItem.mockImplementation(
      () => undefined,
    );

    await expect(auth.beginWebSessionAdmission(NEXT_USER_ID)).rejects.toThrow(
      "Admissão esperada da sessão web não foi confirmada",
    );
    await expect(auth.getWebSessionGateState()).resolves.toEqual({
      state: "CLEAR",
    });
  });

  it("ADMISSION persiste expectedUserId canônico no reload", async () => {
    const storage = availableStorage();
    let auth = await loadAuth(storage, storage, "web");

    await auth.runExclusiveWebSessionMutation(async () => {
      const login = await auth.beginWebLoginInProgress();
      auth.consumeWebLoginInProgressForRequest(login);
      await auth.prepareWebSessionAdmission(NEXT_USER_ID);
    });
    expect(storage.values.get(WEB_GATE_KEY)).toMatch(WEB_ADMISSION_MARKER);
    await expect(auth.getWebSessionGateState()).resolves.toEqual({
      state: "ADMISSION",
      expectedUserId: NEXT_USER_ID,
    });

    vi.resetModules();
    auth = await loadAuth(storage, storage, "web");
    await expect(auth.getWebSessionGateState()).resolves.toEqual({
      state: "ADMISSION",
      expectedUserId: NEXT_USER_ID,
    });
    await expect(auth.isWebSessionQuarantined()).resolves.toBe(true);
  });

  it("prepare ADMISSION detecta setItem no-op e mantém LOGIN_IN_PROGRESS", async () => {
    const storage = availableStorage();
    const auth = await loadAuth(storage, storage, "web");
    let loginMarker: string | undefined;
    await auth.runExclusiveWebSessionMutation(async () => {
      const login = await auth.beginWebLoginInProgress();
      auth.consumeWebLoginInProgressForRequest(login);
      loginMarker = storage.values.get(WEB_GATE_KEY);
      installedBrowserStorage(storage).setItem.mockImplementation(
        () => undefined,
      );

      await expect(
        auth.prepareWebSessionAdmission(NEXT_USER_ID),
      ).rejects.toThrow("Admissão esperada da sessão web não foi confirmada");
    });
    expect(loginMarker).toMatch(WEB_LOGIN_MARKER);
    expect(storage.values.get(WEB_GATE_KEY)).toBe(loginMarker);
    await expect(auth.getWebSessionGateState()).resolves.toEqual({
      state: "REVOKE_REQUIRED",
    });
  });

  it("prepare ADMISSION não sobrescreve marker de revogação", async () => {
    const storage = availableStorage();
    const auth = await loadAuth(storage, storage, "web");
    await auth.beginWebSessionQuarantine();

    await expect(auth.prepareWebSessionAdmission(NEXT_USER_ID)).rejects.toThrow(
      "Login web em andamento não pôde ser confirmado",
    );
    expect(storage.values.get(WEB_GATE_KEY)).toMatch(WEB_REVOCATION_MARKER);
    await expect(auth.getWebSessionGateState()).resolves.toEqual({
      state: "REVOKE_REQUIRED",
    });
  });

  it("rejeita expectedUserId web inválido antes de tocar storage", async () => {
    const storage = availableStorage();
    const auth = await loadAuth(storage, storage, "web");

    for (const invalidUserId of [0, -1, 1.5, Number.NaN]) {
      await expect(
        auth.prepareWebSessionAdmission(invalidUserId),
      ).rejects.toThrow("Usuário esperado da sessão web inválido");
      await expect(
        auth.beginWebSessionAdmission(invalidUserId),
      ).rejects.toThrow("Usuário esperado da sessão web inválido");
    }
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("API livre de clear inexiste e capability de login cancela uma única vez antes do request", async () => {
    const storage = availableStorage();
    const auth = await loadAuth(storage, storage, "web");
    expect("clearWebSessionQuarantine" in auth).toBe(false);
    await auth.runExclusiveWebSessionMutation(async () => {
      const login = await auth.beginWebLoginInProgress();
      await expect(
        auth.cancelWebLoginInProgress(Object.freeze({}) as typeof login),
      ).rejects.toThrow("Capability de cancelamento do login inválida");
      expect(storage.values.get(WEB_GATE_KEY)).toMatch(WEB_LOGIN_MARKER);

      await auth.cancelWebLoginInProgress(login);
      expect(storage.values.has(WEB_GATE_KEY)).toBe(false);
      await expect(auth.cancelWebLoginInProgress(login)).rejects.toThrow(
        "Capability de cancelamento do login inválida",
      );
    });
  });

  it("LOGIN consumido só sai por logout tipado e a confirmação não é replayável", async () => {
    const storage = availableStorage();
    const auth = await loadAuth(storage, storage, "web");
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            revocation: "ALREADY_INVALID",
            sessionFenceRotated: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await auth.runExclusiveWebSessionMutation(async () => {
      const login = await auth.beginWebLoginInProgress();
      auth.consumeWebLoginInProgressForRequest(login);
      await expect(auth.cancelWebLoginInProgress(login)).rejects.toThrow(
        "Capability de cancelamento do login inválida",
      );
      await auth.beginWebSessionQuarantine();
      await expect(auth.revokeWebSessionQuarantine()).resolves.toEqual({
        status: "REVOKED",
        revocation: { status: "ALREADY_INVALID" },
      });
      await expect(auth.revokeWebSessionQuarantine()).rejects.toThrow(
        "Quarentena web ausente",
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storage.values.has(WEB_GATE_KEY)).toBe(false);
  });

  it("409 canônico limpa uma única vez somente o marker A e preserva a sessão B", async () => {
    const storage = availableStorage();
    const auth = await loadAuth(storage, storage, "web");
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      const headers = options?.headers as Record<string, string>;
      expect(headers["x-client-expected-user-id"]).toBe(
        String(DEFAULT_USER_ID),
      );
      return new Response(
        JSON.stringify({
          code: "EXPECTED_USER_MISMATCH",
          currentSessionUserId: NEXT_USER_ID,
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await auth.runExclusiveWebSessionMutation(async () => {
      await auth.beginWebSessionQuarantine(DEFAULT_USER_ID);
      const marker = storage.values.get(WEB_GATE_KEY);
      expect(marker).toMatch(/^pending-revocation:v3:101:[0-9a-f]{32}$/);
      await auth.beginWebSessionQuarantine();
      expect(storage.values.get(WEB_GATE_KEY)).toBe(marker);
      const outcome = await auth.revokeWebSessionQuarantine();
      expect(outcome).toEqual({
        status: "STALE_QUARANTINE_CLEARED",
      });
      expect("currentSessionUserId" in outcome).toBe(false);
      expect(storage.values.has(WEB_GATE_KEY)).toBe(false);
      await expect(auth.revokeWebSessionQuarantine()).rejects.toThrow(
        "Quarentena web ausente",
      );
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect("consumeWebStaleQuarantineReceipt" in auth).toBe(false);
    expect("requestPreparedWebSessionRevocation" in auth).toBe(false);
  });

  it("marker v4 físico preserva binding e proof quando begin/revoke omitem argumentos", async () => {
    const storage = availableStorage();
    const auth = await loadAuth(storage, storage, "web");
    const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
      const headers = options?.headers as Record<string, string>;
      expect(headers["x-client-expected-user-id"]).toBe(
        String(DEFAULT_USER_ID),
      );
      expect(headers["x-client-session-instance"]).toBe(SESSION_INSTANCE);
      return new Response(
        JSON.stringify({
          ok: true,
          revocation: "ALREADY_INVALID",
          revocationUserId: DEFAULT_USER_ID,
          sessionFenceRotated: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await auth.runExclusiveWebSessionMutation(async () => {
      await auth.beginWebSessionQuarantine(DEFAULT_USER_ID, SESSION_INSTANCE);
      const marker = storage.values.get(WEB_GATE_KEY);
      await auth.beginWebSessionQuarantine();
      expect(storage.values.get(WEB_GATE_KEY)).toBe(marker);
      await expect(auth.revokeWebSessionQuarantine()).resolves.toEqual({
        status: "REVOKED",
        revocation: {
          status: "ALREADY_INVALID",
          revocationUserId: DEFAULT_USER_ID,
        },
      });
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storage.values.has(WEB_GATE_KEY)).toBe(false);
  });

  it("caller divergente não retargeta nem degrada marker v4 físico", async () => {
    const storage = availableStorage();
    const auth = await loadAuth(storage, storage, "web");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await auth.runExclusiveWebSessionMutation(async () => {
      await auth.beginWebSessionQuarantine(DEFAULT_USER_ID, SESSION_INSTANCE);
      const marker = storage.values.get(WEB_GATE_KEY);
      await expect(
        auth.beginWebSessionQuarantine(NEXT_USER_ID),
      ).rejects.toThrow("Binding físico da revogação web divergiu");
      await expect(
        auth.beginWebSessionQuarantine(DEFAULT_USER_ID, `v1.${"b".repeat(43)}`),
      ).rejects.toThrow("Binding físico da revogação web divergiu");
      await expect(
        auth.revokeWebSessionQuarantine(NEXT_USER_ID),
      ).rejects.toThrow("Binding físico da revogação web divergiu");
      await expect(
        auth.revokeWebSessionQuarantine(
          DEFAULT_USER_ID,
          `v1.${"b".repeat(43)}`,
        ),
      ).rejects.toThrow("Binding físico da revogação web divergiu");
      expect(storage.values.get(WEB_GATE_KEY)).toBe(marker);
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["código genérico", { code: "CONFLICT", currentSessionUserId: 202 }],
    ["identidade ausente", { code: "EXPECTED_USER_MISMATCH" }],
    [
      "identidade null",
      { code: "EXPECTED_USER_MISMATCH", currentSessionUserId: null },
    ],
    [
      "identidade string",
      { code: "EXPECTED_USER_MISMATCH", currentSessionUserId: "202" },
    ],
    [
      "identidade zero",
      { code: "EXPECTED_USER_MISMATCH", currentSessionUserId: 0 },
    ],
    [
      "identidade fracionária",
      { code: "EXPECTED_USER_MISMATCH", currentSessionUserId: 202.5 },
    ],
    [
      "identidade unsafe",
      {
        code: "EXPECTED_USER_MISMATCH",
        currentSessionUserId: Number.MAX_SAFE_INTEGER + 1,
      },
    ],
    [
      "mesma identidade A",
      {
        code: "EXPECTED_USER_MISMATCH",
        currentSessionUserId: DEFAULT_USER_ID,
      },
    ],
  ])("409 %s não emite receipt nem limpa o marker", async (_label, body) => {
    const storage = availableStorage();
    const auth = await loadAuth(storage, storage, "web");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(body), {
            status: 409,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    await expect(
      auth.runExclusiveWebSessionMutation(async () => {
        await auth.beginWebSessionQuarantine(DEFAULT_USER_ID);
        const marker = storage.values.get(WEB_GATE_KEY);
        installedBrowserStorage(storage).removeItem.mockClear();
        await expect(
          auth.revokeWebSessionQuarantine(DEFAULT_USER_ID),
        ).rejects.toThrow();
        expect(storage.values.get(WEB_GATE_KEY)).toBe(marker);
        expect(
          installedBrowserStorage(storage).removeItem,
        ).not.toHaveBeenCalled();
      }),
    ).resolves.toBeUndefined();
  });

  it("receipt 409 não limpa nonce substituído por outra aba", async () => {
    const storage = availableStorage();
    const auth = await loadAuth(storage, storage, "web");
    const response = deferred<Response>();
    const fetchMock = vi.fn(() => response.promise);
    vi.stubGlobal("fetch", fetchMock);

    const workflow = auth.runExclusiveWebSessionMutation(async () => {
      await auth.beginWebSessionQuarantine(DEFAULT_USER_ID);
      return auth.revokeWebSessionQuarantine(DEFAULT_USER_ID);
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const markerB =
      "pending-revocation:v3:202:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    storage.values.set(WEB_GATE_KEY, markerB);
    response.resolve(
      new Response(
        JSON.stringify({
          code: "EXPECTED_USER_MISMATCH",
          currentSessionUserId: NEXT_USER_ID,
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(workflow).rejects.toThrow("A sessão web mudou em outra aba");
    expect(storage.values.get(WEB_GATE_KEY)).toBe(markerB);
  });

  it("receipt 409 perde autoridade se a geração muda enquanto o CAS aguarda o gate lock", async () => {
    const storage = availableStorage();
    const browser = browserStorageFromValues(storage.values);
    const locks = sharedWebLocks();
    browserStorageByAsyncStorage.set(storage, browser);
    installBrowser(browser, locks);
    const auth = await loadAuth(storage, storage, "web");
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: "EXPECTED_USER_MISMATCH",
            currentSessionUserId: NEXT_USER_ID,
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const gateAcquired = deferred<void>();
    const releaseGate = deferred<void>();
    let marker: string | undefined;
    const workflow = auth.runExclusiveWebSessionMutation(async () => {
      await auth.beginWebSessionQuarantine(DEFAULT_USER_ID);
      marker = storage.values.get(WEB_GATE_KEY);
      const blocker = locks.request(
        "escalas-web-session-gate-v1",
        { mode: "exclusive" },
        async () => {
          gateAcquired.resolve(undefined);
          await releaseGate.promise;
        },
      );
      await gateAcquired.promise;
      try {
        return await auth.revokeWebSessionQuarantine(DEFAULT_USER_ID);
      } finally {
        await blocker;
      }
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(
        locks.request.mock.calls.filter(
          ([name]) => name === "escalas-web-session-gate-v1",
        ),
      ).toHaveLength(3),
    );
    auth.closeSessionTokenTransportAdmission();
    releaseGate.resolve(undefined);

    await expect(workflow).rejects.toThrow(
      "Prova remota da revogação web ficou stale",
    );
    expect(storage.values.get(WEB_GATE_KEY)).toBe(marker);
  });

  it("prova remota de outro usuário e clear no-op mantêm a quarentena", async () => {
    const storage = availableStorage();
    const auth = await loadAuth(storage, storage, "web");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            revocation: "ROTATED",
            revocationUserId: NEXT_USER_ID,
            sessionFenceRotated: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: true,
            revocation: "ROTATED",
            revocationUserId: DEFAULT_USER_ID,
            sessionFenceRotated: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await auth.runExclusiveWebSessionMutation(async () => {
      await auth.beginWebSessionQuarantine(DEFAULT_USER_ID);
      await expect(auth.revokeWebSessionQuarantine()).rejects.toThrow(
        "pertence a outro usuário",
      );
      const marker = storage.values.get(WEB_GATE_KEY);
      expect(marker).toBeDefined();

      installedBrowserStorage(storage).removeItem.mockImplementation(
        () => undefined,
      );
      await expect(auth.revokeWebSessionQuarantine()).rejects.toThrow(
        "Liberação da sessão web não foi confirmada",
      );
      expect(storage.values.get(WEB_GATE_KEY)).toBe(marker);
    });
  });

  it("marker explícito de revogação sobrevive ao reload", async () => {
    const storage = availableStorage();
    let auth = await loadAuth(storage, storage, "web");

    await auth.beginWebSessionQuarantine();
    expect(storage.values.get(WEB_GATE_KEY)).toMatch(WEB_REVOCATION_MARKER);
    vi.resetModules();
    auth = await loadAuth(storage, storage, "web");
    await expect(auth.getWebSessionGateState()).resolves.toEqual({
      state: "REVOKE_REQUIRED",
    });
  });

  it("marker exact-v1 preserva a instância no cold restart revoke-only", async () => {
    const storage = availableStorage();
    let auth = await loadAuth(storage, storage, "web");

    await auth.beginWebSessionQuarantine(DEFAULT_USER_ID, SESSION_INSTANCE);
    expect(storage.values.get(WEB_GATE_KEY)).toMatch(
      WEB_EXACT_REVOCATION_MARKER,
    );
    await expect(auth.getWebSessionGateState()).resolves.toEqual({
      state: "REVOKE_REQUIRED",
      expectedUserId: DEFAULT_USER_ID,
      sessionInstance: SESSION_INSTANCE,
    });

    vi.resetModules();
    auth = await loadAuth(storage, storage, "web");
    await expect(auth.getWebSessionGateState()).resolves.toEqual({
      state: "REVOKE_REQUIRED",
      expectedUserId: DEFAULT_USER_ID,
      sessionInstance: SESSION_INSTANCE,
    });
  });

  it("DELETE web só cancela antes do dispatch; depois exige logout tipado", async () => {
    const storage = availableStorage();
    const auth = await loadAuth(storage, storage, "web");
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            revocation: "ALREADY_INVALID",
            revocationUserId: DEFAULT_USER_ID,
            sessionFenceRotated: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await auth.runExclusiveWebSessionMutation(async () => {
      const receipt = await auth.prepareReversibleWebSessionRevocation(
        DEFAULT_USER_ID,
        SESSION_INSTANCE,
      );
      await expect(
        auth.cancelReversibleWebSessionRevocation(
          Object.freeze({}) as typeof receipt,
        ),
      ).rejects.toThrow("Receipt reversível do DELETE web inválida");
      await auth.cancelReversibleWebSessionRevocation(receipt);
      await expect(
        auth.cancelReversibleWebSessionRevocation(receipt),
      ).rejects.toThrow("Receipt reversível do DELETE web inválida");

      const dispatched = await auth.prepareReversibleWebSessionRevocation(
        DEFAULT_USER_ID,
        SESSION_INSTANCE,
      );
      auth.consumeReversibleWebSessionRevocationForRequest(dispatched);
      await expect(
        auth.cancelReversibleWebSessionRevocation(dispatched),
      ).rejects.toThrow("Receipt reversível do DELETE web inválida");
      await auth.revokeWebSessionQuarantine(DEFAULT_USER_ID, SESSION_INSTANCE);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storage.values.has(WEB_GATE_KEY)).toBe(false);
  });

  it("proof web malformada rejeita antes de tocar o marker", async () => {
    const storage = availableStorage();
    const auth = await loadAuth(storage, storage, "web");

    await expect(
      auth.beginWebSessionQuarantine(DEFAULT_USER_ID, "proof-forjada"),
    ).rejects.toThrow("Instância esperada da revogação web inválida");
    await expect(
      auth.prepareReversibleWebSessionRevocation(
        DEFAULT_USER_ID,
        "proof-forjada",
      ),
    ).rejects.toThrow("Instância esperada da revogação web inválida");
    expect(storage.values.has(WEB_GATE_KEY)).toBe(false);
  });

  it("valor desconhecido e falha de leitura web permanecem fail-closed", async () => {
    const storage = availableStorage();
    storage.values.set(WEB_GATE_KEY, "estado-futuro-desconhecido");
    let auth = await loadAuth(storage, storage, "web");
    const browser = installedBrowserStorage(storage);

    await expect(auth.getWebSessionGateState()).resolves.toEqual({
      state: "REVOKE_REQUIRED",
    });
    await expect(auth.beginWebSessionQuarantine()).rejects.toThrow(
      "Marker web desconhecido",
    );
    expect(storage.values.get(WEB_GATE_KEY)).toBe("estado-futuro-desconhecido");

    vi.resetModules();
    browser.getItem.mockImplementation(() => {
      throw new Error("localStorage indisponível");
    });
    auth = await loadAuth(storage, storage, "web");

    await expect(auth.getWebSessionGateState()).resolves.toEqual({
      state: "REVOKE_REQUIRED",
    });
    await expect(auth.isWebSessionQuarantined()).resolves.toBe(true);
  });
});
