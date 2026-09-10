import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { Platform } from "react-native";
import {
  isScreenActionLeaseCurrent,
  type ScreenActionLease,
} from "@/lib/screen-action-lease";
import { appSessionEpoch } from "@/lib/session-epoch";

const useCommittedLayoutEffect =
  Platform.OS === "web" && typeof window === "undefined"
    ? useEffect
    : useLayoutEffect;

/**
 * Cerca efeitos locais posteriores a uma mutation (feedback, cache e rota).
 * A escrita continua sendo autorizada e revalidada pelo servidor; esta lease
 * impede somente que uma resposta antiga atue sobre outra conta ou tela.
 */
export function useScreenActionLease(input: {
  userId: number | undefined;
  contextKey?: string | null;
}) {
  const mountedRef = useRef(false);
  const sequenceRef = useRef(0);
  const currentRef = useRef({
    userId: input.userId,
    contextKey: input.contextKey ?? null,
  });

  // Atualiza a identidade somente após o commit. Escrever refs durante render
  // contaminaria a tela ainda vigente se o React abandonasse aquele render.
  useCommittedLayoutEffect(() => {
    const nextContext = {
      userId: input.userId,
      contextKey: input.contextKey ?? null,
    };
    if (
      currentRef.current.userId !== nextContext.userId ||
      currentRef.current.contextKey !== nextContext.contextKey
    ) {
      currentRef.current = nextContext;
      sequenceRef.current += 1;
    }
    mountedRef.current = true;
  }, [input.contextKey, input.userId]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      sequenceRef.current += 1;
    };
  }, []);

  const capture = useCallback((): ScreenActionLease | null => {
    const userId = currentRef.current.userId;
    if (
      !mountedRef.current ||
      !Number.isSafeInteger(userId) ||
      (userId ?? 0) <= 0 ||
      currentRef.current.contextKey == null
    ) {
      return null;
    }
    const sequence = ++sequenceRef.current;
    return {
      userId: userId!,
      contextKey: currentRef.current.contextKey,
      sequence,
      sessionEpoch: appSessionEpoch.capture(),
    };
  }, []);

  const isCurrent = useCallback((lease: ScreenActionLease | null): boolean => {
    if (!lease) return false;
    return isScreenActionLeaseCurrent(lease, {
      mounted: mountedRef.current,
      userId: currentRef.current.userId,
      contextKey: currentRef.current.contextKey,
      sequence: sequenceRef.current,
      sessionEpochCurrent: appSessionEpoch.isCurrent(lease.sessionEpoch),
    });
  }, []);

  return { capture, isCurrent };
}
