import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import {
  parseStoredScheduleContextId,
  resolveScheduleContextId,
  scheduleContextStorageKey,
  type ScheduleContextOption,
  type ScheduleContextVisibility,
} from "@/lib/schedule-context-selection";

type UseScheduleContextOptions = Readonly<{
  userId: number | null | undefined;
  institutionId: number | null | undefined;
  visibility?: ScheduleContextVisibility;
}>;

/**
 * Contexto operacional da escala. A chave é account + tenant scoped para um
 * médico não herdar a última escala de outra conta ou instituição no aparelho.
 *
 * visibility "roster" alimenta o panorama Geral com todas as escalas
 * ativas do tenant (só leitura). "authorized" permanece para criar/gerir.
 */
export function useScheduleContext({
  userId,
  institutionId,
  visibility = "authorized",
}: UseScheduleContextOptions) {
  const enabled = !!userId && !!institutionId;
  const authorizedQuery = trpc.scheduleContexts.listMine.useQuery(undefined, {
    enabled: enabled && visibility === "authorized",
    staleTime: 60_000,
  });
  const rosterQuery = trpc.scheduleContexts.listReadable.useQuery(undefined, {
    enabled: enabled && visibility === "roster",
    staleTime: 60_000,
  });
  const query = visibility === "roster" ? rosterQuery : authorizedQuery;
  const contexts = useMemo<readonly ScheduleContextOption[]>(
    () => query.data ?? [],
    [query.data],
  );
  const contextSignature = query.data
    ? contexts.map((context) => context.id).join(",")
    : null;
  const storageKey =
    userId && institutionId
      ? scheduleContextStorageKey(userId, institutionId, visibility)
      : null;
  const [selectedContextId, setSelectedContextId] = useState<number | null>(
    null,
  );
  const [hydratedStorageKey, setHydratedStorageKey] = useState<string | null>(
    null,
  );

  useEffect(() => {
    let current = true;

    if (!storageKey || contextSignature === null) {
      setSelectedContextId(null);
      setHydratedStorageKey(null);
      return () => {
        current = false;
      };
    }

    setHydratedStorageKey(null);
    void AsyncStorage.getItem(storageKey)
      .then((raw) => {
        if (!current) return;
        const resolved = resolveScheduleContextId(
          contexts,
          parseStoredScheduleContextId(raw),
        );
        setSelectedContextId(resolved);
        setHydratedStorageKey(storageKey);

        if (contexts.length === 0) {
          void AsyncStorage.removeItem(storageKey).catch(() => undefined);
        } else if (contexts.length === 1) {
          void AsyncStorage.setItem(storageKey, String(contexts[0].id)).catch(
            () => undefined,
          );
        }
      })
      .catch(() => {
        if (!current) return;
        setSelectedContextId(resolveScheduleContextId(contexts, null));
        setHydratedStorageKey(storageKey);
      });

    return () => {
      current = false;
    };
    // contextSignature é intencional: nomes podem mudar sem invalidar uma
    // escolha; inclusão/remoção de ids exige nova revalidação.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextSignature, storageKey]);

  const selectContext = useCallback(
    (contextId: number | null) => {
      if (!storageKey) return;
      const next =
        contextId !== null &&
        contexts.some((context) => context.id === contextId)
          ? contextId
          : null;
      setSelectedContextId(next);
      if (next === null) {
        void AsyncStorage.removeItem(storageKey).catch(() => undefined);
      } else {
        void AsyncStorage.setItem(storageKey, String(next)).catch(
          () => undefined,
        );
      }
    },
    [contexts, storageKey],
  );

  // Limpeza apenas visual durante o fluxo Hospital > Setor > Qualificação.
  // Não apaga a preferência anterior até uma nova qualificação ser confirmada.
  const clearCurrentSelection = useCallback(() => {
    setSelectedContextId(null);
  }, []);

  const selectedContext = useMemo(
    () => contexts.find((context) => context.id === selectedContextId) ?? null,
    [contexts, selectedContextId],
  );

  return {
    ...query,
    contexts,
    selectedContext,
    selectedContextId,
    selectContext,
    clearCurrentSelection,
    isSelectionHydrating:
      query.isLoading ||
      (!query.isError && !!storageKey && hydratedStorageKey !== storageKey),
  };
}
