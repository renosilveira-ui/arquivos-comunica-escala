// lib/query-persist.ts — persistência do cache do react-query no aparelho.
//
// Por usuário E por instituição: a chave no AsyncStorage leva os dois ids,
// então trocar de conta ou de instituição nunca restaura dados do outro
// contexto. No logout, tudo o que foi persistido é apagado
// (clearPersistedQueryCache, chamado por hooks/use-auth.ts).
//
// A política (quais procedures, idade máxima) vive em
// lib/query-persist-policy.ts, sem dependência de React Native.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { dehydrate, hashKey, hydrate, QueryClient } from "@tanstack/react-query";
import {
  persistQueryClientRestore,
  persistQueryClientSave,
  persistQueryClientSubscribe,
  type PersistedClient,
  type PersistQueryClientOptions,
} from "@tanstack/react-query-persist-client";
import {
  isPersistedQueryKey,
  PERSISTED_QUERY_MAX_AGE_MS,
  shouldPersistQuery,
} from "./query-persist-policy";

const KEY_PREFIX = "escala.query-cache.v1";
const QUERY_CACHE_TOMBSTONE_KEY = `${KEY_PREFIX}.revoked`;
const QUERY_CACHE_TOMBSTONE = "revoked";
const QUERY_CACHE_DEHYDRATE_OPTIONS = {
  shouldDehydrateQuery: shouldPersistQuery,
  // O default da TanStack inclui mutações pausadas, com variables/context.
  // Esse cache é exclusivamente de consultas e nunca pode virar uma fila de
  // comandos offline nem persistir tokens/inputs de mutações.
  shouldDehydrateMutation: () => false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withoutPersistedMutations(value: unknown): PersistedClient {
  if (
    !isRecord(value) ||
    typeof value.timestamp !== "number" ||
    !Number.isFinite(value.timestamp) ||
    typeof value.buster !== "string" ||
    !isRecord(value.clientState) ||
    !Array.isArray(value.clientState.queries)
  ) {
    throw new TypeError("Cache persistido em formato inválido.");
  }

  return {
    ...value,
    clientState: {
      ...value.clientState,
      mutations: [],
      // Payloads legados continham a própria autoridade institucional.
      // Refiltrar aqui impede allowlist/capabilities/managerScope antigos de
      // chegarem ao staging ou à promoção.
      queries: value.clientState.queries.filter((query) => {
        if (
          !isRecord(query) ||
          !Array.isArray(query.queryKey) ||
          typeof query.queryHash !== "string" ||
          !isRecord(query.state) ||
          query.state.status !== "success" ||
          !isPersistedQueryKey(query.queryKey)
        ) {
          return false;
        }
        try {
          // hydrate indexa pelo queryHash fornecido. Sem este binding, uma
          // key permitida poderia carregar o hash de capabilities e injetar
          // autoridade no slot já semeado pelo handshake fresco.
          return query.queryHash === hashKey(query.queryKey);
        } catch {
          return false;
        }
      }),
    },
  } as unknown as PersistedClient;
}

function serializePersistedClient(value: unknown): string {
  return JSON.stringify(withoutPersistedMutations(value));
}

function deserializePersistedClient(value: string): PersistedClient {
  return withoutPersistedMutations(JSON.parse(value) as unknown);
}

type PersistenceLease = {
  generation: number;
  restoreSettled: boolean;
  storageAdmitted: boolean;
  isAuthorizationCurrent: () => boolean;
  unsubscribe?: () => void;
  subscribe?: () => () => void;
  saveCurrent?: () => Promise<void>;
};

let persistenceGeneration = 0;
let activeLease: PersistenceLease | null = null;
let storageMutationTail: Promise<void> = Promise.resolve();

function isLeaseCurrent(lease: PersistenceLease): boolean {
  if (
    activeLease !== lease ||
    persistenceGeneration !== lease.generation ||
    !lease.storageAdmitted
  ) {
    return false;
  }

  try {
    return lease.isAuthorizationCurrent();
  } catch {
    return false;
  }
}

async function readQueryCacheTombstone(): Promise<string | null> {
  return AsyncStorage.getItem(QUERY_CACHE_TOMBSTONE_KEY);
}

async function persistQueryCacheTombstone(): Promise<void> {
  await AsyncStorage.setItem(QUERY_CACHE_TOMBSTONE_KEY, QUERY_CACHE_TOMBSTONE);
  const persisted = await readQueryCacheTombstone();
  if (persisted !== QUERY_CACHE_TOMBSTONE) {
    throw new Error("Não foi possível confirmar a barreira durável do cache.");
  }
}

async function removePersistedQueryEntriesAndReleaseTombstone(): Promise<void> {
  const keys = await AsyncStorage.getAllKeys();
  const mine = keys.filter(
    (key) => key.startsWith(KEY_PREFIX) && key !== QUERY_CACHE_TOMBSTONE_KEY,
  );
  if (mine.length > 0) await AsyncStorage.multiRemove(mine);
  const remaining = (await AsyncStorage.getAllKeys()).filter(
    (key) => key.startsWith(KEY_PREFIX) && key !== QUERY_CACHE_TOMBSTONE_KEY,
  );
  if (remaining.length > 0) {
    throw new Error("A limpeza do cache local deixou dados residuais.");
  }

  // Commit explícito. Não removemos a chave: um remove ambíguo não permite
  // distinguir "limpeza concluída" de "barreira perdida" após um crash.
  await AsyncStorage.setItem(QUERY_CACHE_TOMBSTONE_KEY, "");
  const released = await readQueryCacheTombstone();
  if (released !== "") {
    throw new Error("Não foi possível confirmar a liberação do cache local.");
  }
}

async function releasePendingQueryCacheTombstone(): Promise<boolean> {
  let tombstone: string | null;
  try {
    tombstone = await readQueryCacheTombstone();
  } catch {
    return false;
  }
  // Ausência também é estado não provado: pode ser primeira abertura após a
  // migração ou uma tentativa anterior cujo marker-write falhou. Em ambos os
  // casos limpamos todas as entradas antes de gravar o release confirmado.
  if (tombstone === "") return true;

  try {
    await removePersistedQueryEntriesAndReleaseTombstone();
    return true;
  } catch {
    return false;
  }
}

/**
 * Serializa writes/removes físicos do cache. O fence fecha novos writes da
 * lease antiga; a fila garante que a limpeza rode depois de qualquer write
 * que já tenha atravessado a barreira e antes dos writes de uma lease nova.
 */
function enqueueStorageMutation(operation: () => Promise<void>): Promise<void> {
  const scheduled = storageMutationTail.then(operation, operation);
  storageMutationTail = scheduled.catch(() => undefined);
  return scheduled;
}

async function waitForStorageMutationIdle(): Promise<void> {
  for (;;) {
    const observedTail = storageMutationTail;
    await observedTail;
    if (observedTail === storageMutationTail) return;
  }
}

function leaseBoundStorage(lease: PersistenceLease) {
  return {
    async getItem(key: string): Promise<string | null> {
      await waitForStorageMutationIdle();
      if (!isLeaseCurrent(lease)) return null;
      if (!(await releasePendingQueryCacheTombstone())) {
        lease.storageAdmitted = false;
        return null;
      }
      if (!isLeaseCurrent(lease)) return null;
      const value = await AsyncStorage.getItem(key);
      if (!isLeaseCurrent(lease) || value === null) return null;

      const sanitizedValue = serializePersistedClient(
        deserializePersistedClient(value),
      );
      if (sanitizedValue !== value) {
        await enqueueStorageMutation(async () => {
          if (!isLeaseCurrent(lease)) return;
          await AsyncStorage.setItem(key, sanitizedValue);
        });
      }

      return isLeaseCurrent(lease) ? sanitizedValue : null;
    },
    setItem(key: string, value: string): Promise<void> {
      if (!isLeaseCurrent(lease)) return Promise.resolve();
      return enqueueStorageMutation(async () => {
        if (!isLeaseCurrent(lease)) return;
        if (!(await releasePendingQueryCacheTombstone())) {
          lease.storageAdmitted = false;
          return;
        }
        if (!isLeaseCurrent(lease)) return;
        const sanitizedValue = serializePersistedClient(
          deserializePersistedClient(value),
        );
        await AsyncStorage.setItem(key, sanitizedValue);
      });
    },
    removeItem(key: string): Promise<void> {
      if (!isLeaseCurrent(lease)) return Promise.resolve();
      return enqueueStorageMutation(async () => {
        if (!isLeaseCurrent(lease)) return;
        if (!(await releasePendingQueryCacheTombstone())) {
          lease.storageAdmitted = false;
          return;
        }
        if (!isLeaseCurrent(lease)) return;
        await AsyncStorage.removeItem(key);
      });
    },
  };
}

/**
 * Fecha imediatamente a autoridade do restore/subscribe atual.
 *
 * O restore roda primeiro em um QueryClient isolado (staging), mas a lease
 * continua necessária para impedir que uma resolução antiga seja promovida
 * depois de logout ou troca de tenant. O unsubscribe também acontece aqui,
 * de forma síncrona, sem esperar o próximo render do React.
 */
export function fenceQueryCachePersistence(): void {
  persistenceGeneration += 1;
  const lease = activeLease;
  activeLease = null;
  lease?.unsubscribe?.();
  if (lease) lease.unsubscribe = undefined;
}

/**
 * Pausa a persistência para uma tentativa de logout reversível.
 *
 * O callback só reabre a MESMA lease se nenhuma troca de sessão/tenant tiver
 * ocorrido no intervalo. Assim, uma falha HTTP de logout volta a persistir o
 * usuário ainda autenticado sem permitir que um rollback antigo substitua um
 * contexto mais novo.
 */
export function suspendQueryCachePersistence(): () => boolean {
  const lease = activeLease;
  persistenceGeneration += 1;
  const suspensionGeneration = persistenceGeneration;
  activeLease = null;
  lease?.unsubscribe?.();
  if (lease) lease.unsubscribe = undefined;

  let consumed = false;
  return () => {
    if (consumed) return false;
    consumed = true;
    if (
      !lease ||
      !lease.storageAdmitted ||
      activeLease !== null ||
      persistenceGeneration !== suspensionGeneration
    ) {
      return false;
    }

    lease.generation = suspensionGeneration;
    activeLease = lease;
    if (lease.restoreSettled) {
      lease.unsubscribe = lease.subscribe?.();
      void lease.saveCurrent?.().catch(() => {
        // Persistência local é best-effort; a lease segue aberta para a
        // próxima atualização do cache.
      });
    }
    return true;
  };
}

export function persistedCacheKey(userId: number, institutionId: number): string {
  return `${KEY_PREFIX}.u${userId}.i${institutionId}`;
}

export function persistedCacheTombstoneKey(): string {
  return QUERY_CACHE_TOMBSTONE_KEY;
}

/**
 * Restaura o cache persistido deste usuário/instituição e passa a gravar
 * as consultas permitidas a cada mudança. Devolve a função que encerra a
 * gravação (chamar no unmount / troca de contexto).
 */
export function startQueryCachePersistence(params: {
  queryClient: QueryClient;
  userId: number;
  institutionId: number;
  /** Versão do app: cache de outra versão é descartado (formato pode mudar). */
  buster: string;
  /** Prova fresca de autorização que deve continuar válida até a promoção. */
  isAuthorizationCurrent: () => boolean;
}): () => void {
  fenceQueryCachePersistence();
  const lease: PersistenceLease = {
    generation: persistenceGeneration,
    restoreSettled: false,
    storageAdmitted: true,
    isAuthorizationCurrent: params.isAuthorizationCurrent,
  };
  activeLease = lease;

  const persister = createAsyncStoragePersister({
    storage: leaseBoundStorage(lease),
    key: persistedCacheKey(params.userId, params.institutionId),
    throttleTime: 1000,
    serialize: serializePersistedClient,
    deserialize: deserializePersistedClient,
  });
  const options: PersistQueryClientOptions = {
    queryClient: params.queryClient,
    persister,
    maxAge: PERSISTED_QUERY_MAX_AGE_MS,
    buster: params.buster,
    dehydrateOptions: QUERY_CACHE_DEHYDRATE_OPTIONS,
  };
  lease.subscribe = () => persistQueryClientSubscribe(options);
  lease.saveCurrent = () => persistQueryClientSave(options);

  // Nunca hidrate diretamente o client compartilhado: persistQueryClientRestore
  // faz o write dentro da Promise, antes que o caller possa conferir se a
  // sessão ainda é a mesma. O staging torna a promoção um CAS explícito.
  const stagingClient = new QueryClient({
    defaultOptions: params.queryClient.getDefaultOptions(),
  });
  const restoreOptions: PersistQueryClientOptions = {
    ...options,
    queryClient: stagingClient,
  };

  persistQueryClientRestore(restoreOptions)
    .catch(() => {
      // Cache corrompido/ilegível: o app segue sem ele (fetch normal).
    })
    .then(() => {
      lease.restoreSettled = true;
      if (!isLeaseCurrent(lease)) return;

      hydrate(
        params.queryClient,
        dehydrate(stagingClient, QUERY_CACHE_DEHYDRATE_OPTIONS),
      );
      if (!isLeaseCurrent(lease)) return;
      lease.unsubscribe = lease.subscribe?.();
    })
    .finally(() => {
      stagingClient.clear();
    });

  return () => {
    if (activeLease === lease) {
      fenceQueryCachePersistence();
      return;
    }
    lease.unsubscribe?.();
  };
}

/** Apaga todo cache persistido (logout, exclusão de conta). */
export async function clearPersistedQueryCache(): Promise<void> {
  fenceQueryCachePersistence();
  await enqueueStorageMutation(async () => {
    await persistQueryCacheTombstone();
    await removePersistedQueryEntriesAndReleaseTombstone();
  });
}
