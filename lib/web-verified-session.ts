import { Platform } from "react-native";
import type { SessionEpochTicket } from "./session-epoch";

export type PreservedWebVerifiedSession<T extends { id: number }> = Readonly<{
  user: T;
  ticket: SessionEpochTicket;
  sequence: number;
}>;

let preservedWebVerifiedSession: PreservedWebVerifiedSession<{
  id: number;
}> | null = null;

export function rememberPreservedWebVerifiedSession<T extends { id: number }>(
  snapshot: PreservedWebVerifiedSession<T>,
): void {
  if (Platform.OS !== "web") return;
  if (!Number.isSafeInteger(snapshot.user.id) || snapshot.user.id <= 0) return;
  preservedWebVerifiedSession = snapshot;
}

export function clearPreservedWebVerifiedSession(): void {
  preservedWebVerifiedSession = null;
}

export function readPreservedWebVerifiedSession<T extends { id: number }>(input: {
  isTransportCurrent: (userId: number) => boolean;
  isEpochCurrent: (ticket: SessionEpochTicket) => boolean;
}): PreservedWebVerifiedSession<T> | null {
  if (Platform.OS !== "web") return null;
  const snapshot = preservedWebVerifiedSession as PreservedWebVerifiedSession<T> | null;
  if (!snapshot) return null;
  if (!input.isTransportCurrent(snapshot.user.id)) return null;
  if (!input.isEpochCurrent(snapshot.ticket)) return null;
  return snapshot;
}

/**
 * Remount do AuthProvider (Fast Refresh / layout) pode encontrar a snapshot
 * VERIFIED com sequence atrás de `latestAuthRefetchSequence` — um refetch
 * soft incrementa o módulo sem republicar o receipt — ou à frente, se o
 * módulo do hook recarregou e zerou o contador. Sem alinhar, `isCurrent()`
 * fica falso, o gate institucional nunca abre e toques de push são
 * descartados.
 */
export function alignPreservedWebVerifiedSessionSequence(
  latestSequence: number,
): number {
  if (Platform.OS !== "web") return latestSequence;
  const snapshot = preservedWebVerifiedSession;
  if (!snapshot) return latestSequence;
  const safeLatest =
    Number.isSafeInteger(latestSequence) && latestSequence >= 0
      ? latestSequence
      : 0;
  const aligned = Math.max(safeLatest, snapshot.sequence);
  if (aligned !== snapshot.sequence) {
    preservedWebVerifiedSession = { ...snapshot, sequence: aligned };
  }
  return aligned;
}
