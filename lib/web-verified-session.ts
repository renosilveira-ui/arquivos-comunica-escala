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
