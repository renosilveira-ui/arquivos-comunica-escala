// lib/push-token.ts — token de push do aparelho na sessão atual.
//
// O predecessor confirmado pelo servidor precisa sobreviver a cold starts para
// um rollover conseguir removê-lo atomicamente. O valor bruto é uma credencial:
// fica exclusivamente no SecureStore e nunca no AsyncStorage ou em logs.
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

export type PushTokenPlatform = "ios" | "android" | "web";

export type ServerRegisteredPushToken = Readonly<{
  userId: number;
  platform: PushTokenPlatform;
  token: string;
}>;

type PushTokenEnvelope = Readonly<{
  version: 1;
  userId: number;
  platform: PushTokenPlatform;
  token: string;
  fingerprint: string;
}>;

const PUSH_TOKEN_VAULT_KEY = "push_server_predecessor_v1";
const PUSH_TOKEN_VAULT_QUARANTINE_KEY = "push_server_predecessor_quarantine_v1";
const PUSH_TOKEN_VAULT_QUARANTINE_VALUE = "quarantined:v1";
const FNV_MASK_64 = (1n << 64n) - 1n;
const FNV_PRIME_64 = 0x100000001b3n;

let lastPushToken: string | null = null;
let serverRegisteredPushToken: { userId: number; token: string } | null = null;
let vaultGeneration = 0;
let vaultMutationTail: Promise<void> = Promise.resolve();

export class PushTokenVaultError extends Error {
  readonly code:
    | "PUSH_TOKEN_VAULT_INVALID"
    | "PUSH_TOKEN_VAULT_QUARANTINED"
    | "PUSH_TOKEN_VAULT_SUPERSEDED"
    | "PUSH_TOKEN_VAULT_UNAVAILABLE";

  constructor(code: PushTokenVaultError["code"], message: string) {
    super(message);
    this.name = "PushTokenVaultError";
    this.code = code;
  }
}

function invalidVaultError(): PushTokenVaultError {
  return new PushTokenVaultError(
    "PUSH_TOKEN_VAULT_INVALID",
    "O predecessor push persistido é inválido",
  );
}

function unavailableVaultError(): PushTokenVaultError {
  return new PushTokenVaultError(
    "PUSH_TOKEN_VAULT_UNAVAILABLE",
    "Não foi possível confirmar o cofre do predecessor push",
  );
}

function supersededVaultError(): PushTokenVaultError {
  return new PushTokenVaultError(
    "PUSH_TOKEN_VAULT_SUPERSEDED",
    "A operação do cofre push foi substituída",
  );
}

function quarantineVaultError(): PushTokenVaultError {
  return new PushTokenVaultError(
    "PUSH_TOKEN_VAULT_QUARANTINED",
    "O cofre do predecessor push exige limpeza confirmada",
  );
}

function fnv1a64(value: string, seed: bigint): string {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * FNV_PRIME_64) & FNV_MASK_64;
  }
  return hash.toString(16).padStart(16, "0");
}

function envelopeFingerprint(
  userId: number,
  platform: PushTokenPlatform,
  token: string,
): string {
  const boundValue = JSON.stringify([1, userId, platform, token]);
  return [
    fnv1a64(boundValue, 0xcbf29ce484222325n),
    fnv1a64(`push-predecessor\0${boundValue}`, 0x84222325cbf29ce4n),
  ].join("");
}

function isPushTokenPlatform(value: unknown): value is PushTokenPlatform {
  return value === "ios" || value === "android" || value === "web";
}

function assertValidContext(context: ServerRegisteredPushToken): void {
  if (
    !Number.isSafeInteger(context.userId) ||
    context.userId <= 0 ||
    !isPushTokenPlatform(context.platform) ||
    typeof context.token !== "string" ||
    context.token.trim().length === 0
  ) {
    throw invalidVaultError();
  }
}

function parseEnvelope(raw: string): PushTokenEnvelope | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const exactKeys = ["fingerprint", "platform", "token", "userId", "version"];
    if (
      parsed === null ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join("\0") !== exactKeys.join("\0") ||
      parsed.version !== 1 ||
      !Number.isSafeInteger(parsed.userId) ||
      (parsed.userId as number) <= 0 ||
      !isPushTokenPlatform(parsed.platform) ||
      typeof parsed.token !== "string" ||
      parsed.token.trim().length === 0 ||
      typeof parsed.fingerprint !== "string"
    ) {
      return null;
    }

    const envelope = parsed as PushTokenEnvelope;
    return envelope.fingerprint === envelopeFingerprint(
      envelope.userId,
      envelope.platform,
      envelope.token,
    )
      ? envelope
      : null;
  } catch {
    return null;
  }
}

function serializeEnvelope(context: ServerRegisteredPushToken): string {
  const envelope: PushTokenEnvelope = {
    version: 1,
    userId: context.userId,
    platform: context.platform,
    token: context.token,
    fingerprint: envelopeFingerprint(context.userId, context.platform, context.token),
  };
  return JSON.stringify(envelope);
}

function enqueueVaultMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = vaultMutationTail.then(operation, operation);
  vaultMutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function forgetServerRegisteredPushToken(): void {
  serverRegisteredPushToken = null;
}

async function isSecurePushVaultAvailable(): Promise<boolean> {
  // O método existe no runtime Expo. O fallback mantém doubles antigos de
  // teste compatíveis; produção web retorna false de forma explícita.
  if (typeof SecureStore.isAvailableAsync !== "function") return true;
  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    // Indisponibilidade confirmada (false) é diferente de uma leitura
    // ambígua. Erro em plataforma nativa nunca autoriza pular o delete.
    throw unavailableVaultError();
  }
}

async function assertVaultIsNotQuarantined(): Promise<void> {
  let marker: string | null;
  try {
    marker = await AsyncStorage.getItem(PUSH_TOKEN_VAULT_QUARANTINE_KEY);
  } catch {
    throw unavailableVaultError();
  }
  // Qualquer presença, inclusive marker futuro/corrompido, bloqueia. Apenas
  // ausência confirmada abre a leitura/gravação do segredo.
  if (marker !== null) throw quarantineVaultError();
}

/**
 * Instala um bloqueio sem segredo e tenta remover o valor bruto. O marker é
 * deliberadamente preservado: somente clearServerRegisteredPushTokenVault,
 * com delete + readback nulo, pode declarar o cofre limpo novamente.
 */
async function quarantineAndScrubVault(): Promise<void> {
  forgetServerRegisteredPushToken();
  let markerConfirmed = false;
  try {
    await AsyncStorage.setItem(
      PUSH_TOKEN_VAULT_QUARANTINE_KEY,
      PUSH_TOKEN_VAULT_QUARANTINE_VALUE,
    );
    markerConfirmed =
      (await AsyncStorage.getItem(PUSH_TOKEN_VAULT_QUARANTINE_KEY)) ===
      PUSH_TOKEN_VAULT_QUARANTINE_VALUE;
  } catch {
    markerConfirmed = false;
  }

  // Sem marker positivo, o próprio raw permanece como quarentena durável. Isso
  // evita transformar falha/no-op do AsyncStorage em ausência saudável após
  // restart. Com marker confirmado, o segredo pode ser apagado com segurança.
  if (!markerConfirmed) return;
  try {
    await SecureStore.deleteItemAsync(PUSH_TOKEN_VAULT_KEY);
    await SecureStore.getItemAsync(PUSH_TOKEN_VAULT_KEY);
  } catch {
    // O chamador sempre falha; nunca promovemos ausência não confirmada.
  }
}

export function setLastPushToken(token: string | null): void {
  lastPushToken = token;
  if (token === null) serverRegisteredPushToken = null;
}

export function getLastPushToken(): string | null {
  return lastPushToken;
}

/**
 * Predecessor confirmado pelo servidor, separado do token publicado para UI/
 * logout. Pode avançar após um POST cujo hook já desmontou, permitindo que o
 * próximo mount faça replacement sem republicar estado stale.
 *
 * Esta API síncrona continua sendo somente memória. Use
 * persistServerRegisteredPushToken para estabelecer prova durável.
 */
export function recordServerRegisteredPushToken(userId: number, token: string): void {
  serverRegisteredPushToken = { userId, token };
}

export function getServerRegisteredPushToken(userId: number): string | null {
  return serverRegisteredPushToken?.userId === userId
    ? serverRegisteredPushToken.token
    : null;
}

/**
 * Hidrata apenas um predecessor integralmente válido e vinculado ao usuário e
 * à plataforma atuais. Corrupção ou troca de conta entra em quarentena e lança
 * erro; null significa exclusivamente ausência saudável confirmada.
 */
export async function hydrateServerRegisteredPushToken(
  userId: number,
  platform: PushTokenPlatform,
): Promise<string | null> {
  // A chamada declara qual é o contexto atual. A memória anterior deixa de
  // ser observável antes de qualquer I/O, inclusive se marker/storage falhar.
  forgetServerRegisteredPushToken();
  if (!Number.isSafeInteger(userId) || userId <= 0 || !isPushTokenPlatform(platform)) {
    throw invalidVaultError();
  }

  const generation = ++vaultGeneration;
  return enqueueVaultMutation(async () => {
    await assertVaultIsNotQuarantined();
    if (!(await isSecurePushVaultAvailable())) throw unavailableVaultError();

    let raw: string | null;
    try {
      raw = await SecureStore.getItemAsync(PUSH_TOKEN_VAULT_KEY);
    } catch {
      await quarantineAndScrubVault();
      throw unavailableVaultError();
    }

    if (generation !== vaultGeneration) throw supersededVaultError();
    if (raw === null) {
      forgetServerRegisteredPushToken();
      return null;
    }

    const envelope = parseEnvelope(raw);
    if (
      envelope === null ||
      envelope.userId !== userId ||
      envelope.platform !== platform
    ) {
      await quarantineAndScrubVault();
      throw invalidVaultError();
    }

    if (generation !== vaultGeneration) throw supersededVaultError();
    serverRegisteredPushToken = { userId: envelope.userId, token: envelope.token };
    return envelope.token;
  });
}

/** Persiste o predecessor com write + readback byte a byte antes de publicá-lo. */
export async function persistServerRegisteredPushToken(
  context: ServerRegisteredPushToken,
): Promise<void> {
  assertValidContext(context);
  // O servidor já confirmou este contexto antes da persistência. Não mantém
  // um predecessor antigo observável durante uma transição ainda não provada.
  forgetServerRegisteredPushToken();
  const generation = ++vaultGeneration;
  const serialized = serializeEnvelope(context);

  return enqueueVaultMutation(async () => {
    await assertVaultIsNotQuarantined();
    if (!(await isSecurePushVaultAvailable())) throw unavailableVaultError();
    if (generation !== vaultGeneration) throw supersededVaultError();

    try {
      await SecureStore.setItemAsync(PUSH_TOKEN_VAULT_KEY, serialized);
      const readback = await SecureStore.getItemAsync(PUSH_TOKEN_VAULT_KEY);
      if (readback !== serialized) {
        await quarantineAndScrubVault();
        throw unavailableVaultError();
      }
    } catch (error) {
      if (error instanceof PushTokenVaultError) throw error;
      await quarantineAndScrubVault();
      throw unavailableVaultError();
    }

    if (generation !== vaultGeneration) throw supersededVaultError();
    serverRegisteredPushToken = { userId: context.userId, token: context.token };
  });
}

/**
 * Fecha o cofre de imediato e só resolve depois de confirmar SecureStore nulo
 * e marker nulo. Falha/no-op/ACK perdido preserva a quarentena e rejeita.
 */
export async function clearServerRegisteredPushTokenVault(): Promise<void> {
  ++vaultGeneration;
  forgetServerRegisteredPushToken();

  return enqueueVaultMutation(async () => {
    let secureStoreCleared = false;

    try {
      await AsyncStorage.setItem(
        PUSH_TOKEN_VAULT_QUARANTINE_KEY,
        PUSH_TOKEN_VAULT_QUARANTINE_VALUE,
      );
      // O readback do marker é uma barreira; mesmo se falhar, ainda tentamos o
      // delete do segredo e decidimos pelo estado final confirmado abaixo.
      await AsyncStorage.getItem(PUSH_TOKEN_VAULT_QUARANTINE_KEY);
    } catch {
      // Estado final é verificado abaixo.
    }

    if (!(await isSecurePushVaultAvailable())) {
      // Web sem SecureStore nunca conseguiu admitir um envelope por estas APIs.
      // A limpeza vazia não deve bloquear logout/rotate globais. Se um token
      // push for de fato obtido ali, hydrate/persist acima falham antes do POST.
      secureStoreCleared = true;
    } else {
      try {
        await SecureStore.deleteItemAsync(PUSH_TOKEN_VAULT_KEY);
        secureStoreCleared = (await SecureStore.getItemAsync(PUSH_TOKEN_VAULT_KEY)) === null;
      } catch {
        secureStoreCleared = false;
      }
    }

    if (!secureStoreCleared) throw unavailableVaultError();

    try {
      await AsyncStorage.removeItem(PUSH_TOKEN_VAULT_QUARANTINE_KEY);
      if ((await AsyncStorage.getItem(PUSH_TOKEN_VAULT_QUARANTINE_KEY)) !== null) {
        throw unavailableVaultError();
      }
    } catch {
      throw unavailableVaultError();
    }
  });
}
