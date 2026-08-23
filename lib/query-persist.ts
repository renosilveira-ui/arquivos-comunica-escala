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
import type { QueryClient } from "@tanstack/react-query";
import {
  persistQueryClientRestore,
  persistQueryClientSubscribe,
  type PersistQueryClientOptions,
} from "@tanstack/react-query-persist-client";
import { PERSISTED_QUERY_MAX_AGE_MS, shouldPersistQuery } from "./query-persist-policy";

const KEY_PREFIX = "escala.query-cache.v1";

export function persistedCacheKey(userId: number, institutionId: number): string {
  return `${KEY_PREFIX}.u${userId}.i${institutionId}`;
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
}): () => void {
  const persister = createAsyncStoragePersister({
    storage: AsyncStorage,
    key: persistedCacheKey(params.userId, params.institutionId),
    throttleTime: 1000,
  });
  const options: PersistQueryClientOptions = {
    queryClient: params.queryClient,
    persister,
    maxAge: PERSISTED_QUERY_MAX_AGE_MS,
    buster: params.buster,
    dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
  };

  let stopped = false;
  let unsubscribe: (() => void) | undefined;

  persistQueryClientRestore(options)
    .catch(() => {
      // Cache corrompido/ilegível: o app segue sem ele (fetch normal).
    })
    .then(() => {
      if (!stopped) unsubscribe = persistQueryClientSubscribe(options);
    });

  return () => {
    stopped = true;
    unsubscribe?.();
  };
}

/** Apaga todo cache persistido (logout, exclusão de conta). */
export async function clearPersistedQueryCache(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const mine = keys.filter((key) => key.startsWith(KEY_PREFIX));
    if (mine.length > 0) await AsyncStorage.multiRemove(mine);
  } catch {
    // Persistência é best-effort; a sessão em memória já foi limpa.
  }
}
