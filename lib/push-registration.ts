import AsyncStorage from "@react-native-async-storage/async-storage";
import { clearServerRegisteredPushTokenVault } from "@/lib/push-token";
import {
  getActiveWebSessionWorkflowSignal,
  waitForActiveWebSessionWorkflow,
} from "@/lib/_core/web-session-workflow";

export type PushRegistrationContext = Readonly<{
  userId: number;
  token: string;
  platform: "ios" | "android" | "web";
}>;

type RegisterPushContext = (
  context: PushRegistrationContext,
) => Promise<{ success: boolean; message?: string }>;

type WaitBeforeRetry = (delayMs: number) => Promise<void>;

const PUSH_REGISTRATION_STORAGE_KEY = "push_registration_fingerprint_v1";
export const PUSH_REGISTRATION_TTL_MS = 24 * 60 * 60 * 1000;
export const PUSH_REGISTRATION_RETRY_DELAYS_MS = [500, 2_000] as const;
const FNV_MASK_64 = (1n << 64n) - 1n;
const FNV_PRIME_64 = 0x100000001b3n;

let registeredContextKey: string | null = null;
let registeredAt: number | null = null;
let proofGeneration = 0;
let hydrationAttempt: Readonly<{
  generation: number;
  promise: Promise<void>;
}> | null = null;
let proofStorageTail: Promise<void> = Promise.resolve();
let registrationGeneration = 0;
let registrationTail: Promise<void> = Promise.resolve();
let registrationAdmissionOpen = true;

function fnv1a64(value: string, seed: bigint): string {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * FNV_PRIME_64) & FNV_MASK_64;
  }
  return hash.toString(16).padStart(16, "0");
}

function tokenFingerprint(token: string): string {
  // O Expo token não é persistido em claro no AsyncStorage. Dois hashes
  // independentes dão uma chave estável de 128 bits para dedupe; não são
  // usados como credencial nem enviados ao servidor.
  return [
    fnv1a64(token, 0xcbf29ce484222325n),
    fnv1a64(`push-registration\0${token}`, 0x84222325cbf29ce4n),
  ].join("");
}

function contextKey(context: PushRegistrationContext): string {
  return JSON.stringify([
    context.userId,
    tokenFingerprint(context.token),
    context.platform,
  ]);
}

function enqueueProofStorage<T>(operation: () => Promise<T>): Promise<T> {
  const result = proofStorageTail.then(operation, operation);
  proofStorageTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function hydratePersistedRegistration(): Promise<void> {
  const generation = proofGeneration;
  if (hydrationAttempt?.generation === generation) {
    await hydrationAttempt.promise;
    return;
  }

  const operation = enqueueProofStorage(async () => {
    try {
      const raw = await AsyncStorage.getItem(PUSH_REGISTRATION_STORAGE_KEY);
      if (generation !== proofGeneration || !raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (
        parsed.version !== 1 ||
        typeof parsed.contextKey !== "string" ||
        typeof parsed.registeredAt !== "number" ||
        !Number.isFinite(parsed.registeredAt)
      ) {
        return;
      }
      registeredContextKey = parsed.contextKey;
      registeredAt = parsed.registeredAt;
    } catch {
      // Storage indisponível/corrompido nunca autoriza pular o registro.
      if (generation === proofGeneration) {
        registeredContextKey = null;
        registeredAt = null;
      }
    }
  });
  hydrationAttempt = { generation, promise: operation };
  await waitForActiveWebSessionWorkflow(operation);
}

function isFreshRegistration(key: string, now: number): boolean {
  return (
    registeredContextKey === key &&
    registeredAt !== null &&
    registeredAt <= now &&
    now - registeredAt < PUSH_REGISTRATION_TTL_MS
  );
}

/** Prova local recente de um registro servidor para este user+device. */
export function hasFreshPushRegistrationProof(
  context: PushRegistrationContext,
  now = Date.now(),
): boolean {
  return registrationAdmissionOpen && isFreshRegistration(contextKey(context), now);
}

/** Hidrata somente a prova local; nunca registra nem promove um token. */
export async function hydrateFreshPushRegistrationProof(
  context: PushRegistrationContext,
  now = Date.now(),
): Promise<boolean> {
  await hydratePersistedRegistration();
  return hasFreshPushRegistrationProof(context, now);
}

async function persistRegistration(key: string, timestamp: number): Promise<void> {
  const generation = ++proofGeneration;
  const operation = enqueueProofStorage(async () => {
    if (generation !== proofGeneration) return;
    try {
      await AsyncStorage.setItem(
        PUSH_REGISTRATION_STORAGE_KEY,
        JSON.stringify({ version: 1, contextKey: key, registeredAt: timestamp }),
      );
    } catch {
      // O registro servidor já ocorreu; sem prova persistida, o próximo cold
      // start registra novamente em vez de assumir um estado não comprovado.
    }
  });
  hydrationAttempt = { generation, promise: operation };
  await operation;
}

function persistedContextKey(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed.version === 1 && typeof parsed.contextKey === "string"
      ? parsed.contextKey
      : null;
  } catch {
    return null;
  }
}

async function invalidatePersistedRegistration(expectedKey?: string): Promise<void> {
  if (expectedKey !== undefined) {
    try {
      const raw = await AsyncStorage.getItem(PUSH_REGISTRATION_STORAGE_KEY);
      if (!raw) return;
      const storedKey = persistedContextKey(raw);
      // Payload corrompido/futuro já é não autorizante. Uma prova diferente
      // pertence a outro token/usuário e não deve ser apagada por este rollover.
      if (storedKey === null || storedKey !== expectedKey) return;
    } catch {
      // Sem conseguir identificar a prova, invalida tudo abaixo: preservar um
      // fingerprint possivelmente removido no servidor seria fail-open.
    }
  }

  try {
    await AsyncStorage.removeItem(PUSH_REGISTRATION_STORAGE_KEY);
    const remaining = await AsyncStorage.getItem(PUSH_REGISTRATION_STORAGE_KEY);
    if (remaining === null) return;
    if (
      expectedKey !== undefined &&
      persistedContextKey(remaining) !== expectedKey
    ) {
      return;
    }
  } catch {
    // Tenta um tombstone expirado abaixo.
  }

  const tombstone = JSON.stringify({
    version: 1,
    contextKey: "INVALIDATED",
    registeredAt: 0,
  });
  try {
    await AsyncStorage.setItem(PUSH_REGISTRATION_STORAGE_KEY, tombstone);
    if ((await AsyncStorage.getItem(PUSH_REGISTRATION_STORAGE_KEY)) === tombstone) {
      return;
    }
  } catch {
    // Erro explícito abaixo: não afirmar que a prova removida foi invalidada.
  }

  throw new Error("Não foi possível invalidar o registro push persistido");
}

/**
 * Um replacement servidor bem-sucedido remove o predecessor fisicamente.
 * Invalida a prova correspondente mesmo quando o POST já perdeu o ticket UI;
 * caso contrário um rollover posterior de volta ao token antigo pularia o POST.
 */
export async function invalidatePushRegistrationProof(
  context: PushRegistrationContext,
): Promise<void> {
  const key = contextKey(context);
  const generation = ++proofGeneration;
  if (registeredContextKey === key) {
    registeredContextKey = null;
    registeredAt = null;
  }
  const operation = enqueueProofStorage(() => invalidatePersistedRegistration(key));
  hydrationAttempt = {
    generation,
    promise: operation.then(
      () => undefined,
      () => undefined,
    ),
  };
  await waitForActiveWebSessionWorkflow(operation);
}

function waitBeforeRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function registerWithRetry(
  context: PushRegistrationContext,
  register: RegisterPushContext,
  wait: WaitBeforeRetry,
  isAdmitted: () => boolean,
): Promise<boolean> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= PUSH_REGISTRATION_RETRY_DELAYS_MS.length; attempt += 1) {
    if (!isAdmitted()) return false;
    try {
      const result = await register(context);
      if (result.success) return true;
      lastError = new Error(result.message?.trim() || "Servidor recusou o registro push");
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    const retryDelay = PUSH_REGISTRATION_RETRY_DELAYS_MS[attempt];
    if (retryDelay !== undefined) await wait(retryDelay);
  }

  throw lastError ?? new Error("Falha desconhecida ao registrar push");
}

export function ensurePushRegistration(
  context: PushRegistrationContext,
  register: RegisterPushContext,
  wait: WaitBeforeRetry = waitBeforeRetry,
): Promise<boolean> {
  if (!registrationAdmissionOpen) return Promise.resolve(false);
  const key = contextKey(context);
  const generation = registrationGeneration;
  const operation = registrationTail.then(async () => {
    await hydratePersistedRegistration();
    if (
      !registrationAdmissionOpen ||
      generation !== registrationGeneration ||
      isFreshRegistration(key, Date.now())
    ) {
      return false;
    }
    const registered = await registerWithRetry(
      context,
      register,
      wait,
      () => (
        registrationAdmissionOpen &&
        generation === registrationGeneration
      ),
    );
    if (!registered) return false;
    if (
      registrationAdmissionOpen &&
      generation === registrationGeneration
    ) {
      const timestamp = Date.now();
      registeredContextKey = key;
      registeredAt = timestamp;
      await persistRegistration(key, timestamp);
    }
    return true;
  });
  registrationTail = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

/** Fecha a admissão antes do primeiro await do logout/transição de conta. */
export function closePushRegistrationAdmission(): void {
  registrationAdmissionOpen = false;
  registrationGeneration += 1;
}

/** Reabre apenas quando um novo login foi publicado com sucesso. */
export function openPushRegistrationAdmission(): void {
  registrationGeneration += 1;
  registrationAdmissionOpen = true;
}

export function isPushRegistrationAdmissionOpen(): boolean {
  return registrationAdmissionOpen;
}

export function capturePushRegistrationAdmission(): number | null {
  return registrationAdmissionOpen ? registrationGeneration : null;
}

export function isPushRegistrationAdmissionCurrent(ticket: number | null): boolean {
  return (
    ticket !== null &&
    registrationAdmissionOpen &&
    ticket === registrationGeneration
  );
}

function waitForRegistrationTail(
  tail: Promise<unknown>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) return tail.then(() => undefined);
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ?? new Error("Espera do registro push cancelada"),
    );
  }
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new Error("Espera do registro push cancelada"));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    tail.then(
      () => {
        cleanup();
        resolve();
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export async function waitForPushRegistrationIdle(
  signal = getActiveWebSessionWorkflowSignal() ?? undefined,
): Promise<void> {
  for (;;) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("Espera do registro push cancelada");
    }
    const observedRegistrationTail = registrationTail;
    const observedStorageTail = proofStorageTail;
    await waitForRegistrationTail(
      Promise.all([observedRegistrationTail, observedStorageTail]),
      signal,
    );
    if (
      observedRegistrationTail === registrationTail &&
      observedStorageTail === proofStorageTail
    ) {
      return;
    }
  }
}

export async function clearPushRegistrationState(): Promise<void> {
  registrationGeneration += 1;
  const generation = ++proofGeneration;
  registeredContextKey = null;
  registeredAt = null;
  const operation = enqueueProofStorage(async () => {
    // O cofre entra na mesma tail/generation da proof. A função só retorna — e
    // portanto só libera logout/rotate remoto — após ambos os deletes terem
    // readback confirmado. Falha do cofre propaga e mantém o efeito remoto
    // bloqueado.
    await clearServerRegisteredPushTokenVault();
    await invalidatePersistedRegistration();
  });
  hydrationAttempt = {
    generation,
    promise: operation.then(
      () => undefined,
      () => undefined,
    ),
  };
  await waitForActiveWebSessionWorkflow(operation);
}
