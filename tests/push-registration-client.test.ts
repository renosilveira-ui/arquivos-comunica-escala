import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PushRegistrationContext } from "../lib/push-registration";

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

let clearPushTokenVault: ReturnType<typeof vi.fn>;

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

async function loadRegistration(storage: StorageMock) {
  vi.doMock("@react-native-async-storage/async-storage", () => ({ default: storage }));
  vi.doMock("@/lib/push-token", () => ({
    clearServerRegisteredPushTokenVault: clearPushTokenVault,
  }));
  return import("../lib/push-registration");
}

const baseContext: PushRegistrationContext = {
  userId: 41,
  token: "ExponentPushToken[client-race]",
  platform: "ios",
};

describe("coordenação do registro push no cliente", () => {
  let storage: StorageMock;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    storage = createStorage();
    clearPushTokenVault = vi.fn(async () => undefined);
  });

  it("deduplica remount e cold start no mesmo user+device+token", async () => {
    let registration = await loadRegistration(storage);
    const register = vi.fn(async () => ({ success: true }));

    await expect(registration.ensurePushRegistration(baseContext, register)).resolves.toBe(true);
    expect(registration.hasFreshPushRegistrationProof(baseContext)).toBe(true);
    await expect(registration.ensurePushRegistration(baseContext, register)).resolves.toBe(false);
    expect(register).toHaveBeenCalledTimes(1);
    expect(storage.values.size).toBe(1);
    expect([...storage.values.values()][0]).not.toContain(baseContext.token);

    vi.resetModules();
    registration = await loadRegistration(storage);
    await expect(registration.ensurePushRegistration(baseContext, register)).resolves.toBe(false);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("troca de tenant não cria novo ownership para o mesmo user+device", async () => {
    const registration = await loadRegistration(storage);
    const register = vi.fn(async () => ({ success: true }));

    await expect(registration.ensurePushRegistration(baseContext, register)).resolves.toBe(true);
    // Tenant não pertence ao contexto físico e, portanto, não altera a chave.
    await expect(
      registration.ensurePushRegistration({ ...baseContext }, register),
    ).resolves.toBe(false);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("rollover do token registra novamente para o mesmo usuário", async () => {
    const registration = await loadRegistration(storage);
    const register = vi.fn(async () => ({ success: true }));

    await registration.ensurePushRegistration(baseContext, register);
    await expect(registration.ensurePushRegistration({
      ...baseContext,
      token: "ExponentPushToken[client-rollover]",
    }, register)).resolves.toBe(true);
    expect(register).toHaveBeenCalledTimes(2);
  });

  it("expira a prova persistida após 24 horas e recupera uma row perdida", async () => {
    const registration = await loadRegistration(storage);
    const register = vi.fn(async () => ({ success: true }));
    const now = 1_800_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);

    await registration.ensurePushRegistration(baseContext, register);
    clock.mockReturnValue(now + registration.PUSH_REGISTRATION_TTL_MS - 1);
    await expect(registration.ensurePushRegistration(baseContext, register)).resolves.toBe(false);
    expect(registration.hasFreshPushRegistrationProof(baseContext)).toBe(true);
    clock.mockReturnValue(now + registration.PUSH_REGISTRATION_TTL_MS);
    expect(registration.hasFreshPushRegistrationProof(baseContext)).toBe(false);
    await expect(registration.ensurePushRegistration(baseContext, register)).resolves.toBe(true);

    expect(register).toHaveBeenCalledTimes(2);
  });

  it("repete falha transitória com backoff e não faz POST extra após a prova", async () => {
    const registration = await loadRegistration(storage);
    const register = vi
      .fn()
      .mockResolvedValueOnce({ success: false, message: "banco temporariamente indisponível" })
      .mockResolvedValueOnce({ success: true });
    const delays: number[] = [];

    await expect(
      registration.ensurePushRegistration(baseContext, register, async (delayMs) => {
        delays.push(delayMs);
      }),
    ).resolves.toBe(true);
    expect(register).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([registration.PUSH_REGISTRATION_RETRY_DELAYS_MS[0]]);
    expect(storage.setItem).toHaveBeenCalledTimes(1);

    await expect(registration.ensurePushRegistration(baseContext, register)).resolves.toBe(false);
    expect(register).toHaveBeenCalledTimes(2);
  });

  it("limita tentativas e nunca persiste fingerprint quando todas falham", async () => {
    const registration = await loadRegistration(storage);
    const register = vi.fn(async () => ({ success: false, message: "indisponível" }));
    const delays: number[] = [];

    await expect(
      registration.ensurePushRegistration(baseContext, register, async (delayMs) => {
        delays.push(delayMs);
      }),
    ).rejects.toThrow("indisponível");
    expect(register).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([...registration.PUSH_REGISTRATION_RETRY_DELAYS_MS]);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("storage corrompido ou indisponível registra de forma fail-safe", async () => {
    storage.values.set("push_registration_fingerprint_v1", "{corrompido");
    let registration = await loadRegistration(storage);
    const registerCorrupt = vi.fn(async () => ({ success: true }));
    await expect(
      registration.ensurePushRegistration(baseContext, registerCorrupt),
    ).resolves.toBe(true);
    expect(registerCorrupt).toHaveBeenCalledTimes(1);

    vi.resetModules();
    storage = createStorage();
    storage.getItem.mockRejectedValueOnce(new Error("storage indisponível"));
    storage.setItem.mockRejectedValueOnce(new Error("storage indisponível"));
    registration = await loadRegistration(storage);
    const registerUnavailable = vi.fn(async () => ({ success: true }));
    await expect(
      registration.ensurePushRegistration(baseContext, registerUnavailable),
    ).resolves.toBe(true);
    expect(registerUnavailable).toHaveBeenCalledTimes(1);
  });

  it("serializa troca rápida de conta A para B e deixa B como registro final", async () => {
    const { ensurePushRegistration } = await loadRegistration(storage);
    const firstRegistration = deferred<{ success: boolean }>();
    const calls: number[] = [];
    const register = vi.fn(async (context: PushRegistrationContext) => {
      calls.push(context.userId);
      if (context.userId === baseContext.userId) return firstRegistration.promise;
      return { success: true };
    });

    const accountA = ensurePushRegistration(baseContext, register);
    const accountBContext = { ...baseContext, userId: 42 };
    const accountB = ensurePushRegistration(accountBContext, register);
    await vi.waitFor(() => expect(calls).toEqual([41]));

    firstRegistration.resolve({ success: true });
    await expect(Promise.all([accountA, accountB])).resolves.toEqual([true, true]);
    expect(calls).toEqual([41, 42]);

    await expect(ensurePushRegistration(accountBContext, register)).resolves.toBe(false);
    expect(register).toHaveBeenCalledTimes(2);
  });

  it("logout aguarda o registro em trânsito e apaga a prova persistida", async () => {
    const registrationModule = await loadRegistration(storage);
    const pendingRegistration = deferred<{ success: boolean }>();
    const register = vi.fn(() => pendingRegistration.promise);
    const registration = registrationModule.ensurePushRegistration(baseContext, register);
    const unregister = vi.fn();

    registrationModule.closePushRegistrationAdmission();
    const logoutBarrier = registrationModule.waitForPushRegistrationIdle().then(async () => {
      unregister();
      await registrationModule.clearPushRegistrationState();
    });
    await Promise.resolve();
    expect(unregister).not.toHaveBeenCalled();

    pendingRegistration.resolve({ success: true });
    await Promise.all([registration, logoutBarrier]);
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(clearPushTokenVault).toHaveBeenCalledTimes(1);
    expect(storage.values.size).toBe(0);
  });

  it("deadline libera a espera e resposta tardia não publica prova da geração fechada", async () => {
    const registration = await loadRegistration(storage);
    const pendingRegistration = deferred<{ success: boolean }>();
    const register = vi.fn(() => pendingRegistration.promise);
    const inFlight = registration.ensurePushRegistration(baseContext, register);
    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));

    registration.closePushRegistrationAdmission();
    const controller = new AbortController();
    const idle = registration.waitForPushRegistrationIdle(controller.signal);
    controller.abort(new Error("workflow expirado"));

    await expect(idle).rejects.toThrow("workflow expirado");
    expect(registration.hasFreshPushRegistrationProof(baseContext)).toBe(false);
    expect(storage.values.size).toBe(0);

    pendingRegistration.resolve({ success: true });
    // O POST remoto pode ter sido confirmado; o retorno preserva esse fato,
    // mas a geração fechada jamais ganha proof/publicação local.
    await expect(inFlight).resolves.toBe(true);
    expect(registration.hasFreshPushRegistrationProof(baseContext)).toBe(false);
    expect(storage.values.size).toBe(0);
  });

  it("clear cerca hydrate pendente, idle o aguarda e a prova antiga não ressuscita", async () => {
    let registration = await loadRegistration(storage);
    const register = vi.fn(async () => ({ success: true }));
    await registration.ensurePushRegistration(baseContext, register);
    const persistedProof = storage.values.get("push_registration_fingerprint_v1");
    expect(persistedProof).toBeTruthy();

    vi.resetModules();
    const pendingRead = deferred<string | null>();
    storage.getItem.mockImplementationOnce(() => pendingRead.promise);
    registration = await loadRegistration(storage);

    const hydrate = registration.hydrateFreshPushRegistrationProof(baseContext);
    await vi.waitFor(() => expect(storage.getItem).toHaveBeenCalledTimes(1));
    registration.closePushRegistrationAdmission();
    const clear = registration.clearPushRegistrationState();
    const idle = registration.waitForPushRegistrationIdle();
    let idleSettled = false;
    void idle.then(() => {
      idleSettled = true;
    });
    await Promise.resolve();
    expect(idleSettled).toBe(false);
    expect(clearPushTokenVault).not.toHaveBeenCalled();

    pendingRead.resolve(persistedProof ?? null);
    await expect(Promise.all([hydrate, clear, idle])).resolves.toEqual([
      false,
      undefined,
      undefined,
    ]);
    expect(registration.hasFreshPushRegistrationProof(baseContext)).toBe(false);
    expect(clearPushTokenVault).toHaveBeenCalledTimes(1);
    expect(storage.values.size).toBe(0);

    registration.openPushRegistrationAdmission();
    await expect(registration.ensurePushRegistration(baseContext, register)).resolves.toBe(true);
    expect(register).toHaveBeenCalledTimes(2);
  });

  it("cold start após revogação remota registra de novo sem depender de clear posterior", async () => {
    let registration = await loadRegistration(storage);
    const serverRows = new Set<string>();
    const register = vi.fn(async (context: PushRegistrationContext) => {
      serverRows.add(context.token);
      return { success: true };
    });

    await expect(registration.ensurePushRegistration(baseContext, register)).resolves.toBe(true);
    expect(serverRows.has(baseContext.token)).toBe(true);

    // Ordem mutation-sensitive do logout/rotate: a prova sai do disco ANTES
    // da operação remota que revoga a row.
    registration.closePushRegistrationAdmission();
    await registration.waitForPushRegistrationIdle();
    await registration.clearPushRegistrationState();
    serverRows.delete(baseContext.token);

    // Simula morte do processo logo após a resposta HTTP: não existe um clear
    // posterior. O módulo novo deve fazer POST no primeiro mount.
    vi.resetModules();
    registration = await loadRegistration(storage);
    await expect(registration.ensurePushRegistration(baseContext, register)).resolves.toBe(true);

    expect(register).toHaveBeenCalledTimes(2);
    expect(serverRows.has(baseContext.token)).toBe(true);
  });

  it("logout HTTP falho reabre geração nova e re-registra o mesmo aparelho", async () => {
    const registration = await loadRegistration(storage);
    const register = vi.fn(async () => ({ success: true }));

    await registration.ensurePushRegistration(baseContext, register);
    const staleTicket = registration.capturePushRegistrationAdmission();
    registration.closePushRegistrationAdmission();
    await registration.waitForPushRegistrationIdle();
    await registration.clearPushRegistrationState();

    // O servidor não confirmou a revogação: o AuthProvider reabre e remonta.
    registration.openPushRegistrationAdmission();
    const retryTicket = registration.capturePushRegistrationAdmission();
    expect(registration.isPushRegistrationAdmissionCurrent(staleTicket)).toBe(false);
    expect(registration.isPushRegistrationAdmissionCurrent(retryTicket)).toBe(true);
    await expect(registration.ensurePushRegistration(baseContext, register)).resolves.toBe(true);

    expect(register).toHaveBeenCalledTimes(2);
    expect(registration.hasFreshPushRegistrationProof(baseContext)).toBe(true);
  });

  it("fecha admissão antes do await, descarta token tardio e reabre só no próximo login", async () => {
    const registration = await loadRegistration(storage);
    const acquisitionTicket = registration.capturePushRegistrationAdmission();
    const register = vi.fn(async () => ({ success: true }));

    registration.closePushRegistrationAdmission();
    expect(registration.isPushRegistrationAdmissionCurrent(acquisitionTicket)).toBe(false);
    await expect(
      registration.ensurePushRegistration(baseContext, register),
    ).resolves.toBe(false);
    expect(register).not.toHaveBeenCalled();

    // Abrir uma geração nova não torna válido o token adquirido na antiga.
    registration.openPushRegistrationAdmission();
    expect(registration.isPushRegistrationAdmissionCurrent(acquisitionTicket)).toBe(false);
    await expect(
      registration.ensurePushRegistration(baseContext, register),
    ).resolves.toBe(true);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("estabiliza a tail fechada e remove registro concluído durante o logout", async () => {
    const registration = await loadRegistration(storage);
    const serverRows = new Set<string>();
    const pendingPost = deferred<{ success: boolean }>();
    const register = vi.fn(async (context: PushRegistrationContext) => {
      const result = await pendingPost.promise;
      if (result.success) serverRows.add(context.token);
      return result;
    });

    const inFlight = registration.ensurePushRegistration(baseContext, register);
    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));

    // Barreira real: nenhuma operação nova entra depois deste ponto.
    registration.closePushRegistrationAdmission();
    const idle = registration.waitForPushRegistrationIdle();
    await expect(
      registration.ensurePushRegistration(baseContext, register),
    ).resolves.toBe(false);

    pendingPost.resolve({ success: true });
    await Promise.all([inFlight, idle]);
    serverRows.delete(baseContext.token); // unregister capturado após a tail
    await registration.clearPushRegistrationState();

    expect(serverRows.size).toBe(0);
    expect(register).toHaveBeenCalledTimes(1);
    expect(storage.values.size).toBe(0);
  });

  it("cancela retries ainda não admitidos quando o logout fecha a geração", async () => {
    const registration = await loadRegistration(storage);
    const retryWait = deferred<void>();
    const register = vi.fn(async () => ({ success: false, message: "transitório" }));
    const operation = registration.ensurePushRegistration(
      baseContext,
      register,
      () => retryWait.promise,
    );
    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1));

    registration.closePushRegistrationAdmission();
    retryWait.resolve();

    await expect(operation).resolves.toBe(false);
    expect(register).toHaveBeenCalledTimes(1);
    expect(storage.values.size).toBe(0);
  });

  it("usa tombstone expirado se remove falhar e cold start registra novamente", async () => {
    let registration = await loadRegistration(storage);
    const register = vi.fn(async () => ({ success: true }));
    await registration.ensurePushRegistration(baseContext, register);
    storage.removeItem.mockRejectedValueOnce(new Error("remove indisponível"));

    await expect(registration.clearPushRegistrationState()).resolves.toBeUndefined();
    expect([...storage.values.values()][0]).toContain('"registeredAt":0');

    vi.resetModules();
    registration = await loadRegistration(storage);
    await expect(registration.ensurePushRegistration(baseContext, register)).resolves.toBe(true);
    expect(register).toHaveBeenCalledTimes(2);
  });

  it("não silencia quando remove e tombstone falham", async () => {
    const registration = await loadRegistration(storage);
    const register = vi.fn(async () => ({ success: true }));
    await registration.ensurePushRegistration(baseContext, register);
    storage.removeItem.mockRejectedValueOnce(new Error("remove indisponível"));
    storage.setItem.mockRejectedValueOnce(new Error("tombstone indisponível"));

    await expect(registration.clearPushRegistrationState()).rejects.toThrow(
      "Não foi possível invalidar o registro push persistido",
    );
    await expect(registration.ensurePushRegistration(baseContext, register)).resolves.toBe(true);
    expect(register).toHaveBeenCalledTimes(2);
  });

  it("falha do cofre propaga e preserva a proof antes de qualquer efeito remoto", async () => {
    const registration = await loadRegistration(storage);
    const register = vi.fn(async () => ({ success: true }));
    await registration.ensurePushRegistration(baseContext, register);
    const persistedProof = storage.values.get("push_registration_fingerprint_v1");
    expect(persistedProof).toBeTruthy();
    clearPushTokenVault.mockRejectedValueOnce(new Error("SecureStore indisponível"));

    registration.closePushRegistrationAdmission();
    await expect(registration.clearPushRegistrationState()).rejects.toThrow(
      "SecureStore indisponível",
    );

    expect(storage.values.get("push_registration_fingerprint_v1")).toBe(persistedProof);
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("remount após unregister registra novamente o mesmo contexto", async () => {
    let registration = await loadRegistration(storage);
    const register = vi.fn(async () => ({ success: true }));

    await registration.ensurePushRegistration(baseContext, register);
    await registration.clearPushRegistrationState();
    vi.resetModules();
    registration = await loadRegistration(storage);
    await registration.ensurePushRegistration(baseContext, register);

    expect(register).toHaveBeenCalledTimes(2);
  });
});
