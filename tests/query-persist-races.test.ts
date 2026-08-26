import { dehydrate, hashKey, QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushPromises(turns = 20) {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
}

const QUERY_KEY = [["hospitals", "list"], { type: "query" }] as const;
const TOMBSTONE_KEY = "escala.query-cache.v1.revoked";
const LEGACY_AUTHORITY_QUERIES = [
  [["professionals", "listMyInstitutions"], { type: "query" }],
  [["professionals", "getMyCapabilities"], { type: "query" }],
  [["professionals", "getByUserId"], { input: { userId: 77 }, type: "query" }],
  [["professionals", "getManagerScope"], { type: "query" }],
  [["confirmations", "getPending"], { type: "query" }],
  [["swaps", "listAvailable"], { type: "query" }],
  [["shifts", "getNextShift"], { type: "query" }],
  [["shifts", "listAgenda"], { type: "query" }],
  [["shifts", "listByPeriod"], { type: "query" }],
] as const;
const MUTATION_INPUT_SENTINEL = "input-nao-pode-ir-ao-disco";
const MUTATION_TOKEN_SENTINEL = "token-nao-pode-ir-ao-disco";
const AUTHORIZATION_CURRENT = () => true;

function addPausedMutation(
  client: QueryClient,
  inputSentinel = MUTATION_INPUT_SENTINEL,
  tokenSentinel = MUTATION_TOKEN_SENTINEL,
) {
  client.getMutationCache().build(
    client,
    {
      mutationKey: ["confirmations", "registerPushToken", tokenSentinel],
      mutationFn: async () => undefined,
    },
    {
      context: { token: tokenSentinel },
      data: undefined,
      error: null,
      failureCount: 0,
      failureReason: null,
      isPaused: true,
      status: "pending",
      variables: { input: inputSentinel, token: tokenSentinel },
      submittedAt: Date.now(),
    },
  );
}

function persistedPayload(value: string, buster = "test") {
  const source = new QueryClient();
  source.setQueryData(QUERY_KEY, value);
  return JSON.stringify({
    buster,
    timestamp: Date.now(),
    clientState: dehydrate(source),
  });
}

function createStorage(
  getItem: (key: string) => Promise<string | null>,
) {
  let tombstone: string | null = null;
  return {
    getItem: vi.fn((key: string) => (
      key === TOMBSTONE_KEY ? Promise.resolve(tombstone) : getItem(key)
    )),
    setItem: vi.fn(async (key: string, value: string) => {
      if (key === TOMBSTONE_KEY) tombstone = value;
    }),
    removeItem: vi.fn(async () => undefined),
    getAllKeys: vi.fn(async () => (
      tombstone === null ? [] as string[] : [TOMBSTONE_KEY]
    )),
    multiRemove: vi.fn(async () => undefined),
  };
}

async function loadPersistence(storage: ReturnType<typeof createStorage>) {
  vi.doUnmock("@tanstack/react-query");
  vi.doMock("@react-native-async-storage/async-storage", () => ({ default: storage }));
  return import("../lib/query-persist");
}

async function loadPersistenceTrackingStaging(
  storage: ReturnType<typeof createStorage>,
  stagingSnapshots: string[],
) {
  vi.doMock("@react-native-async-storage/async-storage", () => ({ default: storage }));
  vi.doMock("@tanstack/react-query", async () => {
    const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
      "@tanstack/react-query",
    );

    class TrackingQueryClient extends actual.QueryClient {
      override clear(): void {
        stagingSnapshots.push(JSON.stringify(actual.dehydrate(this)));
        super.clear();
      }
    }

    return { ...actual, QueryClient: TrackingQueryClient };
  });
  return import("../lib/query-persist");
}

describe("barreira temporal do cache persistido", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doUnmock("@tanstack/react-query");
    vi.useRealTimers();
  });

  it("nunca grava uma mutação pausada nem seus inputs/tokens", async () => {
    const stored = new Map<string, string>();
    const storage = {
      getItem: vi.fn(async (key: string) => stored.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        stored.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        stored.delete(key);
      }),
      getAllKeys: vi.fn(async () => [...stored.keys()]),
      multiRemove: vi.fn(async (keys: string[]) => {
        for (const key of keys) stored.delete(key);
      }),
    };
    const persistence = await loadPersistence(storage);
    const queryClient = new QueryClient();
    const key = persistence.persistedCacheKey(8, 101);

    const stop = persistence.startQueryCachePersistence({
      queryClient,
      userId: 8,
      institutionId: 101,
      buster: "test",
      isAuthorizationCurrent: AUTHORIZATION_CURRENT,
    });
    await flushPromises();

    addPausedMutation(queryClient);
    await vi.waitFor(() => expect(stored.has(key)).toBe(true));

    const serialized = stored.get(key) ?? "";
    const persisted = JSON.parse(serialized) as {
      clientState?: { mutations?: unknown[] };
    };
    expect(persisted.clientState?.mutations).toEqual([]);
    expect(serialized).not.toContain(MUTATION_INPUT_SENTINEL);
    expect(serialized).not.toContain(MUTATION_TOKEN_SENTINEL);
    stop();
  });

  it("expurga mutações de payload legado antes do staging e da promoção", async () => {
    const source = new QueryClient();
    source.setQueryData(QUERY_KEY, "consulta legítima");
    addPausedMutation(source);
    const legacyPayload = JSON.stringify({
      buster: "test",
      timestamp: Date.now(),
      clientState: dehydrate(source),
    });
    expect(legacyPayload).toContain(MUTATION_INPUT_SENTINEL);
    expect(legacyPayload).toContain(MUTATION_TOKEN_SENTINEL);

    const stored = new Map<string, string>();
    const storage = {
      getItem: vi.fn(async (key: string) => stored.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        stored.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        stored.delete(key);
      }),
      getAllKeys: vi.fn(async () => [...stored.keys()]),
      multiRemove: vi.fn(async (keys: string[]) => {
        for (const key of keys) stored.delete(key);
      }),
    };
    const stagingSnapshots: string[] = [];
    const persistence = await loadPersistenceTrackingStaging(
      storage,
      stagingSnapshots,
    );
    const key = persistence.persistedCacheKey(9, 101);
    stored.set(TOMBSTONE_KEY, "");
    stored.set(key, legacyPayload);
    const finalClient = new QueryClient();

    const stop = persistence.startQueryCachePersistence({
      queryClient: finalClient,
      userId: 9,
      institutionId: 101,
      buster: "test",
      isAuthorizationCurrent: AUTHORIZATION_CURRENT,
    });
    await vi.waitFor(() => {
      expect(finalClient.getQueryData(QUERY_KEY)).toBe("consulta legítima");
      expect(stagingSnapshots).toHaveLength(1);
    });

    const rewrittenPayload = stored.get(key) ?? "";
    const rewritten = JSON.parse(rewrittenPayload) as {
      clientState?: { mutations?: unknown[] };
    };
    expect(rewritten.clientState?.mutations).toEqual([]);
    expect(rewrittenPayload).not.toContain(MUTATION_INPUT_SENTINEL);
    expect(rewrittenPayload).not.toContain(MUTATION_TOKEN_SENTINEL);

    const stagingState = JSON.parse(stagingSnapshots[0] ?? "{}") as {
      mutations?: unknown[];
    };
    expect(stagingState.mutations).toEqual([]);
    expect(stagingSnapshots[0]).not.toContain(MUTATION_INPUT_SENTINEL);
    expect(stagingSnapshots[0]).not.toContain(MUTATION_TOKEN_SENTINEL);

    const finalState = JSON.stringify(dehydrate(finalClient));
    expect(finalClient.getMutationCache().getAll()).toEqual([]);
    expect(JSON.parse(finalState)).toMatchObject({ mutations: [] });
    expect(finalState).not.toContain(MUTATION_INPUT_SENTINEL);
    expect(finalState).not.toContain(MUTATION_TOKEN_SENTINEL);
    stop();
  });

  it("expurga autoridades/shifts legados e promove só a topologia permitida", async () => {
    const source = new QueryClient();
    source.setQueryData(QUERY_KEY, "topologia autorizada");
    LEGACY_AUTHORITY_QUERIES.forEach((queryKey, index) => {
      source.setQueryData(queryKey, `AUTHORITY_SENTINEL_${index}`);
    });
    const legacyPayload = JSON.stringify({
      buster: "test",
      timestamp: Date.now(),
      clientState: dehydrate(source),
    });
    expect(legacyPayload).toContain("AUTHORITY_SENTINEL_0");
    expect(legacyPayload).toContain("AUTHORITY_SENTINEL_8");

    const stored = new Map<string, string>();
    const storage = {
      getItem: vi.fn(async (key: string) => stored.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        stored.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        stored.delete(key);
      }),
      getAllKeys: vi.fn(async () => [...stored.keys()]),
      multiRemove: vi.fn(async (keys: string[]) => {
        keys.forEach((key) => stored.delete(key));
      }),
    };
    const persistence = await loadPersistence(storage);
    const key = persistence.persistedCacheKey(91, 901);
    stored.set(TOMBSTONE_KEY, "");
    stored.set(key, legacyPayload);
    const finalClient = new QueryClient();

    const stop = persistence.startQueryCachePersistence({
      queryClient: finalClient,
      userId: 91,
      institutionId: 901,
      buster: "test",
      isAuthorizationCurrent: AUTHORIZATION_CURRENT,
    });
    await vi.waitFor(() => {
      expect(finalClient.getQueryData(QUERY_KEY)).toBe("topologia autorizada");
    });

    for (const queryKey of LEGACY_AUTHORITY_QUERIES) {
      expect(finalClient.getQueryData(queryKey)).toBeUndefined();
    }
    const rewritten = stored.get(key) ?? "";
    expect(rewritten).not.toContain("AUTHORITY_SENTINEL");
    expect(rewritten).toContain("topologia autorizada");
    stop();
  });

  it("rejeita alias queryKey permitida + queryHash de autoridade", async () => {
    const authorityKey = [["professionals", "getMyCapabilities"], {
      type: "query",
    }] as const;
    const source = new QueryClient();
    source.setQueryData(QUERY_KEY, "AUTHORITY_FORGED");
    const dehydrated = dehydrate(source);
    expect(dehydrated.queries).toHaveLength(1);
    dehydrated.queries[0].queryHash = hashKey(authorityKey);
    const forgedPayload = JSON.stringify({
      buster: "test",
      timestamp: Date.now(),
      clientState: dehydrated,
    });

    const stored = new Map<string, string>();
    const storage = {
      getItem: vi.fn(async (key: string) => stored.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        stored.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        stored.delete(key);
      }),
      getAllKeys: vi.fn(async () => [...stored.keys()]),
      multiRemove: vi.fn(async (keys: string[]) => {
        keys.forEach((key) => stored.delete(key));
      }),
    };
    const persistence = await loadPersistence(storage);
    const key = persistence.persistedCacheKey(92, 902);
    stored.set(TOMBSTONE_KEY, "");
    stored.set(key, forgedPayload);
    const finalClient = new QueryClient();
    finalClient.setQueryData(authorityKey, "AUTORIDADE_FRESCA");

    const stop = persistence.startQueryCachePersistence({
      queryClient: finalClient,
      userId: 92,
      institutionId: 902,
      buster: "test",
      isAuthorizationCurrent: AUTHORIZATION_CURRENT,
    });
    await vi.waitFor(() => {
      expect(stored.get(key)).not.toContain("AUTHORITY_FORGED");
    });

    expect(finalClient.getQueryData(authorityKey)).toBe("AUTORIDADE_FRESCA");
    expect(finalClient.getQueryData(QUERY_KEY)).toBeUndefined();
    stop();
  });

  it("não recria a chave limpa quando um write throttled já estava enfileirado", async () => {
    vi.useFakeTimers();
    const stored = new Map<string, string>();
    const storage = {
      getItem: vi.fn(async (key: string) => stored.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        stored.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        stored.delete(key);
      }),
      getAllKeys: vi.fn(async () => [...stored.keys()]),
      multiRemove: vi.fn(async (keys: string[]) => {
        for (const key of keys) stored.delete(key);
      }),
    };
    const persistence = await loadPersistence(storage);
    const queryClient = new QueryClient();
    const key = persistence.persistedCacheKey(9, 101);

    const stop = persistence.startQueryCachePersistence({
      queryClient,
      userId: 9,
      institutionId: 101,
      buster: "test",
      isAuthorizationCurrent: AUTHORIZATION_CURRENT,
    });
    await flushPromises();

    queryClient.setQueryData(QUERY_KEY, "primeiro write");
    await vi.advanceTimersByTimeAsync(0);
    expect(stored.has(key)).toBe(true);

    // A segunda alteração fica aguardando o throttle de 1 s. O unsubscribe
    // não cancela essa Promise já criada pelo persister da TanStack.
    queryClient.setQueryData(QUERY_KEY, "write enfileirado");
    await vi.advanceTimersByTimeAsync(0);
    await persistence.clearPersistedQueryCache();
    expect(stored.has(key)).toBe(false);

    await vi.advanceTimersByTimeAsync(1_100);
    await flushPromises();

    expect(stored.has(key)).toBe(false);
    stop();
  });

  it("ordena a limpeza depois de um write físico que já começou", async () => {
    const physicalWrite = deferred<void>();
    const stored = new Map<string, string>();
    const storage = {
      getItem: vi.fn(async (key: string) => stored.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        await physicalWrite.promise;
        stored.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        stored.delete(key);
      }),
      getAllKeys: vi.fn(async () => [...stored.keys()]),
      multiRemove: vi.fn(async (keys: string[]) => {
        for (const key of keys) stored.delete(key);
      }),
    };
    const persistence = await loadPersistence(storage);
    const queryClient = new QueryClient();
    const key = persistence.persistedCacheKey(10, 101);

    const stop = persistence.startQueryCachePersistence({
      queryClient,
      userId: 10,
      institutionId: 101,
      buster: "test",
      isAuthorizationCurrent: AUTHORIZATION_CURRENT,
    });
    await flushPromises();
    queryClient.setQueryData(QUERY_KEY, "write em andamento");
    await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalled());

    const clearing = persistence.clearPersistedQueryCache();
    physicalWrite.resolve();
    await clearing;

    expect(stored.has(key)).toBe(false);
    stop();
  });

  it("lease antiga não remove o cache atual ao concluir restore inválido", async () => {
    const restoreA = deferred<string | null>();
    let readCount = 0;
    const storage = createStorage(async () => {
      readCount += 1;
      return readCount === 1
        ? restoreA.promise
        : persistedPayload("sessão atual");
    });
    const persistence = await loadPersistence(storage);
    const sharedClient = new QueryClient();
    const key = persistence.persistedCacheKey(11, 101);

    const stopA = persistence.startQueryCachePersistence({
      queryClient: sharedClient,
      userId: 11,
      institutionId: 101,
      buster: "test",
      isAuthorizationCurrent: AUTHORIZATION_CURRENT,
    });
    await vi.waitFor(() => expect(storage.getItem).toHaveBeenCalledWith(key));

    const stopB = persistence.startQueryCachePersistence({
      queryClient: sharedClient,
      userId: 11,
      institutionId: 101,
      buster: "test",
      isAuthorizationCurrent: AUTHORIZATION_CURRENT,
    });
    await vi.waitFor(() => {
      expect(sharedClient.getQueryData(QUERY_KEY)).toBe("sessão atual");
    });

    restoreA.resolve(persistedPayload("restore antigo", "buster-obsoleto"));
    await flushPromises();

    expect(storage.removeItem).not.toHaveBeenCalled();
    stopA();
    stopB();
  });

  it("retoma imediatamente a mesma lease após uma suspensão reversível", async () => {
    const stored = new Map<string, string>();
    const storage = {
      getItem: vi.fn(async (key: string) => stored.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        stored.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        stored.delete(key);
      }),
      getAllKeys: vi.fn(async () => [...stored.keys()]),
      multiRemove: vi.fn(async (keys: string[]) => {
        for (const key of keys) stored.delete(key);
      }),
    };
    const persistence = await loadPersistence(storage);
    const queryClient = new QueryClient();
    const key = persistence.persistedCacheKey(12, 101);

    const stop = persistence.startQueryCachePersistence({
      queryClient,
      userId: 12,
      institutionId: 101,
      buster: "test",
      isAuthorizationCurrent: AUTHORIZATION_CURRENT,
    });
    await flushPromises();

    const resume = persistence.suspendQueryCachePersistence();
    queryClient.setQueryData(QUERY_KEY, "alterado durante logout falho");
    addPausedMutation(queryClient);
    await flushPromises();
    expect(stored.has(key)).toBe(false);

    expect(resume()).toBe(true);
    await vi.waitFor(() => expect(stored.has(key)).toBe(true));
    const serialized = stored.get(key) ?? "";
    const persisted = JSON.parse(serialized) as {
      clientState?: {
        mutations?: unknown[];
        queries?: { state?: { data?: string } }[];
      };
    };
    expect(persisted.clientState?.mutations).toEqual([]);
    expect(persisted.clientState?.queries?.[0]?.state?.data).toBe(
      "alterado durante logout falho",
    );
    expect(serialized).not.toContain(MUTATION_INPUT_SENTINEL);
    expect(serialized).not.toContain(MUTATION_TOKEN_SENTINEL);
    expect(resume()).toBe(false);
    stop();
  });

  it("resume antigo não substitui uma lease aberta depois da suspensão", async () => {
    const storage = createStorage(async () => null);
    const persistence = await loadPersistence(storage);
    const queryClient = new QueryClient();

    const stopA = persistence.startQueryCachePersistence({
      queryClient,
      userId: 13,
      institutionId: 101,
      buster: "test",
      isAuthorizationCurrent: AUTHORIZATION_CURRENT,
    });
    await flushPromises();
    const resumeA = persistence.suspendQueryCachePersistence();

    const stopB = persistence.startQueryCachePersistence({
      queryClient,
      userId: 13,
      institutionId: 202,
      buster: "test",
      isAuthorizationCurrent: AUTHORIZATION_CURRENT,
    });
    await flushPromises();

    expect(resumeA()).toBe(false);
    queryClient.setQueryData(QUERY_KEY, "tenant B");
    const keyB = persistence.persistedCacheKey(13, 202);
    await vi.waitFor(() => expect(storage.setItem).toHaveBeenCalledWith(
      keyB,
      expect.any(String),
    ));
    expect(storage.setItem.mock.calls.at(-1)?.[0]).toBe(
      keyB,
    );
    stopA();
    stopB();
  });

  it("não promove restore A liberado depois do logout e preserva cache novo", async () => {
    const restoreA = deferred<string | null>();
    const stored = new Map<string, string>();
    const storage = {
      getItem: vi.fn(async (key: string) => {
        if (key === TOMBSTONE_KEY) return stored.get(key) ?? null;
        return restoreA.promise;
      }),
      setItem: vi.fn(async (key: string, value: string) => {
        stored.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        stored.delete(key);
      }),
      getAllKeys: vi.fn(async () => [...stored.keys()]),
      multiRemove: vi.fn(async (keys: string[]) => {
        keys.forEach((key) => stored.delete(key));
      }),
    };
    const persistence = await loadPersistence(storage);
    const sharedClient = new QueryClient();
    const key = persistence.persistedCacheKey(1, 101);

    const stopA = persistence.startQueryCachePersistence({
      queryClient: sharedClient,
      userId: 1,
      institutionId: 101,
      buster: "test",
      isAuthorizationCurrent: AUTHORIZATION_CURRENT,
    });
    await vi.waitFor(() => expect(storage.getItem).toHaveBeenCalledWith(key));

    // Mesma ordem do logout: fecha a lease antes de limpar/publicar outro
    // contexto. O dado B representa atividade ocorrida depois da barreira.
    await persistence.clearPersistedQueryCache();
    sharedClient.clear();
    sharedClient.setQueryData(QUERY_KEY, "B depois do logout");

    restoreA.resolve(persistedPayload("A antigo"));
    await vi.waitFor(() => {
      expect(sharedClient.getQueryData(QUERY_KEY)).toBe("B depois do logout");
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(sharedClient.getQueryData(QUERY_KEY)).toBe("B depois do logout");
    stopA();
  });

  it("troca A→B enquanto A restaura e mantém somente o tenant B", async () => {
    const restoreA = deferred<string | null>();
    const storage = createStorage(async (key) => {
      if (key.endsWith(".u7.i101")) return restoreA.promise;
      if (key.endsWith(".u7.i202")) return persistedPayload("tenant B");
      return null;
    });
    const persistence = await loadPersistence(storage);
    const sharedClient = new QueryClient();
    const keyA = persistence.persistedCacheKey(7, 101);

    const stopA = persistence.startQueryCachePersistence({
      queryClient: sharedClient,
      userId: 7,
      institutionId: 101,
      buster: "test",
      isAuthorizationCurrent: AUTHORIZATION_CURRENT,
    });
    await vi.waitFor(() => expect(storage.getItem).toHaveBeenCalledWith(keyA));

    persistence.fenceQueryCachePersistence();
    sharedClient.clear();
    const stopB = persistence.startQueryCachePersistence({
      queryClient: sharedClient,
      userId: 7,
      institutionId: 202,
      buster: "test",
      isAuthorizationCurrent: AUTHORIZATION_CURRENT,
    });
    await vi.waitFor(() => {
      expect(sharedClient.getQueryData(QUERY_KEY)).toBe("tenant B");
    });

    restoreA.resolve(persistedPayload("tenant A antigo"));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(sharedClient.getQueryData(QUERY_KEY)).toBe("tenant B");
    stopA();
    stopB();
  });

  it("não promove nem assina se a autorização expira durante o restore", async () => {
    const restore = deferred<string | null>();
    const storage = createStorage(() => restore.promise);
    const persistence = await loadPersistence(storage);
    const sharedClient = new QueryClient();
    const key = persistence.persistedCacheKey(20, 101);
    let authorized = true;

    const stop = persistence.startQueryCachePersistence({
      queryClient: sharedClient,
      userId: 20,
      institutionId: 101,
      buster: "test",
      isAuthorizationCurrent: () => authorized,
    });
    await vi.waitFor(() => expect(storage.getItem).toHaveBeenCalledWith(key));
    authorized = false;
    restore.resolve(persistedPayload("não pode promover"));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(sharedClient.getQueryData(QUERY_KEY)).toBeUndefined();
    sharedClient.setQueryData(QUERY_KEY, "também não pode gravar");
    await flushPromises();
    expect(storage.setItem).not.toHaveBeenCalledWith(key, expect.any(String));
    stop();
  });

  it("mantém tombstone após delete parcial e reconcilia antes do cold restore", async () => {
    const stored = new Map<string, string>();
    const storage = {
      getItem: vi.fn(async (key: string) => stored.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        stored.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        stored.delete(key);
      }),
      getAllKeys: vi.fn(async () => [...stored.keys()]),
      multiRemove: vi.fn(async (keys: string[]) => {
        if (storage.multiRemove.mock.calls.length === 1) {
          stored.delete(keys[0]);
          throw new Error("delete parcial");
        }
        keys.forEach((key) => stored.delete(key));
      }),
    };
    let persistence = await loadPersistence(storage);
    const key = persistence.persistedCacheKey(21, 101);
    const otherKey = persistence.persistedCacheKey(22, 202);
    stored.set(key, persistedPayload("cache revogado"));
    stored.set(otherKey, persistedPayload("outro resíduo"));

    await expect(persistence.clearPersistedQueryCache()).rejects.toThrow("delete parcial");
    expect(stored.get(TOMBSTONE_KEY)).toBe("revoked");
    expect([...stored.keys()].some((candidate) => candidate !== TOMBSTONE_KEY)).toBe(true);

    // Novo módulo/processo: a primeira leitura encontra a barreira e termina
    // a limpeza antes de sequer consultar a chave tenant-bound.
    vi.resetModules();
    persistence = await loadPersistence(storage);
    const coldClient = new QueryClient();
    const stop = persistence.startQueryCachePersistence({
      queryClient: coldClient,
      userId: 21,
      institutionId: 101,
      buster: "test",
      isAuthorizationCurrent: AUTHORIZATION_CURRENT,
    });
    await vi.waitFor(() => expect(stored.get(TOMBSTONE_KEY)).toBe(""));
    expect(stored.has(key)).toBe(false);
    expect(stored.has(otherKey)).toBe(false);
    expect(coldClient.getQueryData(QUERY_KEY)).toBeUndefined();
    stop();
  });

  it("marker-write falho deixa ausência fail-closed e o cold start expurga o resíduo", async () => {
    const stored = new Map<string, string>();
    let failMarkerWrite = true;
    const storage = {
      getItem: vi.fn(async (key: string) => stored.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        if (key === TOMBSTONE_KEY && failMarkerWrite) {
          throw new Error("marker indisponível");
        }
        stored.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        stored.delete(key);
      }),
      getAllKeys: vi.fn(async () => [...stored.keys()]),
      multiRemove: vi.fn(async (keys: string[]) => {
        keys.forEach((key) => stored.delete(key));
      }),
    };
    let persistence = await loadPersistence(storage);
    const key = persistence.persistedCacheKey(24, 404);
    stored.set(key, persistedPayload("resíduo sem marker"));

    await expect(persistence.clearPersistedQueryCache()).rejects.toThrow(
      "marker indisponível",
    );
    expect(stored.has(TOMBSTONE_KEY)).toBe(false);
    expect(stored.has(key)).toBe(true);

    failMarkerWrite = false;
    vi.resetModules();
    persistence = await loadPersistence(storage);
    const coldClient = new QueryClient();
    const stop = persistence.startQueryCachePersistence({
      queryClient: coldClient,
      userId: 24,
      institutionId: 404,
      buster: "test",
      isAuthorizationCurrent: AUTHORIZATION_CURRENT,
    });
    await vi.waitFor(() => expect(stored.get(TOMBSTONE_KEY)).toBe(""));

    expect(stored.has(key)).toBe(false);
    expect(coldClient.getQueryData(QUERY_KEY)).toBeUndefined();
    stop();
  });

  it("falha de leitura do tombstone bloqueia restore e qualquer write", async () => {
    const storage = createStorage(async (key) => {
      if (key === TOMBSTONE_KEY) throw new Error("storage indisponível");
      return persistedPayload("não pode abrir");
    });
    // createStorage trata o marker como null; este teste precisa sabotar a
    // leitura física da barreira diretamente.
    storage.getItem.mockImplementation(async (key: string) => {
      if (key === TOMBSTONE_KEY) throw new Error("storage indisponível");
      return persistedPayload("não pode abrir");
    });
    const persistence = await loadPersistence(storage);
    const client = new QueryClient();
    const key = persistence.persistedCacheKey(23, 303);
    const stop = persistence.startQueryCachePersistence({
      queryClient: client,
      userId: 23,
      institutionId: 303,
      buster: "test",
      isAuthorizationCurrent: AUTHORIZATION_CURRENT,
    });
    await flushPromises();
    expect(client.getQueryData(QUERY_KEY)).toBeUndefined();
    client.setQueryData(QUERY_KEY, "write bloqueado");
    await flushPromises();
    expect(storage.getItem).not.toHaveBeenCalledWith(key);
    expect(storage.setItem).not.toHaveBeenCalled();
    stop();
  });
});
