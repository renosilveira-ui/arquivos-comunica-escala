import { beforeEach, describe, expect, it, vi } from "vitest";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

type StorageMock = {
  values: Map<string, string>;
  getItem: ReturnType<typeof vi.fn>;
  setItem: ReturnType<typeof vi.fn>;
  removeItem: ReturnType<typeof vi.fn>;
};

type SecureStoreMock = {
  values: Map<string, string>;
  isAvailableAsync: ReturnType<typeof vi.fn>;
  getItemAsync: ReturnType<typeof vi.fn>;
  setItemAsync: ReturnType<typeof vi.fn>;
  deleteItemAsync: ReturnType<typeof vi.fn>;
};

function createStorage(): StorageMock {
  const values = new Map<string, string>();
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

function createSecureStore(): SecureStoreMock {
  const values = new Map<string, string>();
  return {
    values,
    isAvailableAsync: vi.fn(async () => true),
    getItemAsync: vi.fn(async (key: string) => values.get(key) ?? null),
    setItemAsync: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    deleteItemAsync: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
}

async function loadVault(storage: StorageMock, secureStore: SecureStoreMock) {
  vi.doMock("@react-native-async-storage/async-storage", () => ({ default: storage }));
  vi.doMock("expo-secure-store", () => secureStore);
  return import("../lib/push-token");
}

const tokenA = "ExponentPushToken[secure-predecessor-A]";
const tokenB = "ExponentPushToken[secure-predecessor-B]";

describe("cofre seguro do predecessor push", () => {
  let storage: StorageMock;
  let secureStore: SecureStoreMock;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    storage = createStorage();
    secureStore = createSecureStore();
  });

  it("persiste envelope exato só no SecureStore e hidrata após restart do módulo", async () => {
    let vault = await loadVault(storage, secureStore);

    await vault.persistServerRegisteredPushToken({
      userId: 41,
      platform: "ios",
      token: tokenA,
    });

    expect(vault.getServerRegisteredPushToken(41)).toBe(tokenA);
    expect(secureStore.values.size).toBe(1);
    const raw = [...secureStore.values.values()][0];
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(envelope)).toEqual([
      "version",
      "userId",
      "platform",
      "token",
      "fingerprint",
    ]);
    expect(envelope).toMatchObject({
      version: 1,
      userId: 41,
      platform: "ios",
      token: tokenA,
    });
    expect(envelope.fingerprint).toMatch(/^[a-f0-9]{32}$/);
    expect(JSON.stringify([...storage.values])).not.toContain(tokenA);

    vi.resetModules();
    vault = await loadVault(storage, secureStore);
    expect(vault.getServerRegisteredPushToken(41)).toBeNull();
    await expect(vault.hydrateServerRegisteredPushToken(41, "ios")).resolves.toBe(tokenA);
    expect(vault.getServerRegisteredPushToken(41)).toBe(tokenA);
  });

  it("detecta set no-op, apaga qualquer raw ambíguo e mantém quarentena", async () => {
    secureStore.setItemAsync.mockResolvedValueOnce(undefined);
    const vault = await loadVault(storage, secureStore);

    await expect(vault.persistServerRegisteredPushToken({
      userId: 41,
      platform: "ios",
      token: tokenA,
    })).rejects.toMatchObject({ code: "PUSH_TOKEN_VAULT_UNAVAILABLE" });

    expect(vault.getServerRegisteredPushToken(41)).toBeNull();
    expect(secureStore.values.size).toBe(0);
    expect(storage.values.size).toBe(1);
    await expect(vault.hydrateServerRegisteredPushToken(41, "ios"))
      .rejects.toMatchObject({ code: "PUSH_TOKEN_VAULT_QUARANTINED" });
  });

  it("trata write aplicado com ACK perdido como ambíguo e nunca publica o token", async () => {
    secureStore.setItemAsync.mockImplementationOnce(async (key: string, value: string) => {
      secureStore.values.set(key, value);
      throw new Error("ACK perdido");
    });
    const vault = await loadVault(storage, secureStore);

    await expect(vault.persistServerRegisteredPushToken({
      userId: 41,
      platform: "ios",
      token: tokenA,
    })).rejects.toMatchObject({ code: "PUSH_TOKEN_VAULT_UNAVAILABLE" });

    expect(vault.getServerRegisteredPushToken(41)).toBeNull();
    expect(secureStore.values.size).toBe(0);
    expect(JSON.stringify([...storage.values])).not.toContain(tokenA);
  });

  it("conteúdo corrompido é apagado e fica bloqueado até clear confirmado", async () => {
    secureStore.values.set("push_server_predecessor_v1", JSON.stringify({
      version: 1,
      userId: 41,
      platform: "ios",
      token: tokenA,
      fingerprint: "adulterado",
      extra: true,
    }));
    let vault = await loadVault(storage, secureStore);

    await expect(vault.hydrateServerRegisteredPushToken(41, "ios"))
      .rejects.toMatchObject({ code: "PUSH_TOKEN_VAULT_INVALID" });
    expect(secureStore.values.size).toBe(0);
    expect(storage.values.size).toBe(1);

    vi.resetModules();
    vault = await loadVault(storage, secureStore);
    await expect(vault.hydrateServerRegisteredPushToken(41, "ios"))
      .rejects.toMatchObject({ code: "PUSH_TOKEN_VAULT_QUARANTINED" });
    await expect(vault.clearServerRegisteredPushTokenVault()).resolves.toBeUndefined();
    await expect(vault.hydrateServerRegisteredPushToken(41, "ios")).resolves.toBeNull();
  });

  it("set no-op da quarentena preserva o raw inválido como bloqueio durável", async () => {
    const corruptRaw = JSON.stringify({
      version: 1,
      userId: 41,
      platform: "ios",
      token: tokenA,
      fingerprint: "inválido",
    });
    secureStore.values.set("push_server_predecessor_v1", corruptRaw);
    storage.setItem.mockResolvedValueOnce(undefined);
    let vault = await loadVault(storage, secureStore);

    await expect(vault.hydrateServerRegisteredPushToken(41, "ios"))
      .rejects.toMatchObject({ code: "PUSH_TOKEN_VAULT_INVALID" });
    expect([...secureStore.values.values()]).toEqual([corruptRaw]);
    expect(storage.values.size).toBe(0);

    vi.resetModules();
    vault = await loadVault(storage, secureStore);
    await expect(vault.hydrateServerRegisteredPushToken(41, "ios"))
      .rejects.toMatchObject({ code: "PUSH_TOKEN_VAULT_INVALID" });
  });

  it("falha de leitura do marker nunca consulta nem publica o segredo", async () => {
    let vault = await loadVault(storage, secureStore);
    await vault.persistServerRegisteredPushToken({
      userId: 41,
      platform: "ios",
      token: tokenA,
    });

    vi.resetModules();
    storage.getItem.mockRejectedValueOnce(new Error("AsyncStorage indisponível"));
    const secureReadsBefore = secureStore.getItemAsync.mock.calls.length;
    vault = await loadVault(storage, secureStore);
    await expect(vault.hydrateServerRegisteredPushToken(41, "ios"))
      .rejects.toMatchObject({ code: "PUSH_TOKEN_VAULT_UNAVAILABLE" });
    expect(secureStore.getItemAsync).toHaveBeenCalledTimes(secureReadsBefore);
    expect(vault.getServerRegisteredPushToken(41)).toBeNull();
  });

  it("troca de usuário ou plataforma nunca reutiliza o predecessor anterior", async () => {
    let vault = await loadVault(storage, secureStore);
    await vault.persistServerRegisteredPushToken({
      userId: 41,
      platform: "ios",
      token: tokenA,
    });

    vi.resetModules();
    vault = await loadVault(storage, secureStore);
    await expect(vault.hydrateServerRegisteredPushToken(42, "ios"))
      .rejects.toMatchObject({ code: "PUSH_TOKEN_VAULT_INVALID" });
    expect(vault.getServerRegisteredPushToken(41)).toBeNull();
    expect(vault.getServerRegisteredPushToken(42)).toBeNull();
    expect(secureStore.values.size).toBe(0);

    await vault.clearServerRegisteredPushTokenVault();
    await vault.persistServerRegisteredPushToken({
      userId: 42,
      platform: "android",
      token: tokenB,
    });
    vi.resetModules();
    vault = await loadVault(storage, secureStore);
    await expect(vault.hydrateServerRegisteredPushToken(42, "ios"))
      .rejects.toMatchObject({ code: "PUSH_TOKEN_VAULT_INVALID" });
  });

  it("delete no-op não declara clear e o bloqueio sobrevive ao restart", async () => {
    let vault = await loadVault(storage, secureStore);
    await vault.persistServerRegisteredPushToken({
      userId: 41,
      platform: "ios",
      token: tokenA,
    });
    secureStore.deleteItemAsync.mockResolvedValueOnce(undefined);

    const clear = vault.clearServerRegisteredPushTokenVault();
    expect(vault.getServerRegisteredPushToken(41)).toBeNull();
    await expect(clear).rejects.toMatchObject({ code: "PUSH_TOKEN_VAULT_UNAVAILABLE" });
    expect(secureStore.values.size).toBe(1);
    expect(storage.values.size).toBe(1);

    vi.resetModules();
    vault = await loadVault(storage, secureStore);
    await expect(vault.hydrateServerRegisteredPushToken(41, "ios"))
      .rejects.toMatchObject({ code: "PUSH_TOKEN_VAULT_QUARANTINED" });
  });

  it("remove do marker no-op rejeita mesmo depois de apagar o segredo", async () => {
    const vault = await loadVault(storage, secureStore);
    await vault.persistServerRegisteredPushToken({
      userId: 41,
      platform: "ios",
      token: tokenA,
    });
    storage.removeItem.mockResolvedValueOnce(undefined);

    await expect(vault.clearServerRegisteredPushTokenVault())
      .rejects.toMatchObject({ code: "PUSH_TOKEN_VAULT_UNAVAILABLE" });
    expect(secureStore.values.size).toBe(0);
    expect(storage.values.size).toBe(1);
  });

  it("clear cerca hydrate pendente e impede ressurreição em memória", async () => {
    let vault = await loadVault(storage, secureStore);
    await vault.persistServerRegisteredPushToken({
      userId: 41,
      platform: "ios",
      token: tokenA,
    });
    const raw = [...secureStore.values.values()][0];

    vi.resetModules();
    const pendingRead = deferred<string | null>();
    secureStore.getItemAsync.mockImplementationOnce(() => pendingRead.promise);
    vault = await loadVault(storage, secureStore);

    const hydrate = vault.hydrateServerRegisteredPushToken(41, "ios");
    await vi.waitFor(() => expect(secureStore.getItemAsync).toHaveBeenCalledTimes(2));
    const clear = vault.clearServerRegisteredPushTokenVault();
    pendingRead.resolve(raw);

    await expect(hydrate).rejects.toMatchObject({ code: "PUSH_TOKEN_VAULT_SUPERSEDED" });
    await expect(clear).resolves.toBeUndefined();
    expect(vault.getServerRegisteredPushToken(41)).toBeNull();
    expect(secureStore.values.size).toBe(0);
  });

  it("não envia o token ao AsyncStorage nem a logs, inclusive em falhas", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    secureStore.setItemAsync.mockImplementationOnce(async () => {
      throw new Error(`falha contendo segredo de provedor: ${tokenA}`);
    });
    const vault = await loadVault(storage, secureStore);

    const failure = await vault.persistServerRegisteredPushToken({
      userId: 41,
      platform: "ios",
      token: tokenA,
    }).catch((caught: unknown) => caught);

    expect(failure).toMatchObject({ code: "PUSH_TOKEN_VAULT_UNAVAILABLE" });
    expect(String(failure)).not.toContain(tokenA);
    expect(JSON.stringify([...storage.values])).not.toContain(tokenA);
    expect(JSON.stringify([
      ...warn.mock.calls,
      ...error.mock.calls,
      ...log.mock.calls,
    ])).not.toContain(tokenA);
  });

  it("sem SecureStore bloqueia token obtido, mas permite clear vazio do logout web", async () => {
    secureStore.isAvailableAsync.mockResolvedValue(false);
    const vault = await loadVault(storage, secureStore);

    await expect(vault.hydrateServerRegisteredPushToken(41, "web"))
      .rejects.toMatchObject({ code: "PUSH_TOKEN_VAULT_UNAVAILABLE" });
    await expect(vault.persistServerRegisteredPushToken({
      userId: 41,
      platform: "web",
      token: tokenA,
    })).rejects.toMatchObject({ code: "PUSH_TOKEN_VAULT_UNAVAILABLE" });
    expect(secureStore.getItemAsync).not.toHaveBeenCalled();
    expect(secureStore.setItemAsync).not.toHaveBeenCalled();

    await expect(vault.clearServerRegisteredPushTokenVault()).resolves.toBeUndefined();
    expect(storage.values.size).toBe(0);
  });

  it("erro ao consultar disponibilidade nativa bloqueia clear e preserva quarentena", async () => {
    const vault = await loadVault(storage, secureStore);
    await vault.persistServerRegisteredPushToken({
      userId: 41,
      platform: "ios",
      token: tokenA,
    });
    secureStore.isAvailableAsync.mockRejectedValueOnce(new Error("bridge indisponível"));

    await expect(vault.clearServerRegisteredPushTokenVault())
      .rejects.toMatchObject({ code: "PUSH_TOKEN_VAULT_UNAVAILABLE" });
    expect(secureStore.values.size).toBe(1);
    expect(storage.values.size).toBe(1);
  });

  it("erro transitório antes da escrita permite retry posterior com readback exato", async () => {
    secureStore.isAvailableAsync.mockRejectedValueOnce(new Error("bridge transitório"));
    const vault = await loadVault(storage, secureStore);
    const context = { userId: 41, platform: "ios", token: tokenA } as const;

    await expect(vault.persistServerRegisteredPushToken(context))
      .rejects.toMatchObject({ code: "PUSH_TOKEN_VAULT_UNAVAILABLE" });
    expect(storage.values.size).toBe(0);
    expect(secureStore.values.size).toBe(0);

    await expect(vault.persistServerRegisteredPushToken(context)).resolves.toBeUndefined();
    await expect(vault.hydrateServerRegisteredPushToken(41, "ios")).resolves.toBe(tokenA);
  });
});
