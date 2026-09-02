import { parseAccountWideBadgeCount } from "./account-wide-native-badge";
import { enqueueNativeBadgeWrite } from "./native-badge-write-queue";

type AccountWideBadgeCountResponse = Readonly<{ count: unknown }>;

export type AccountWideNativeBadgeReconcileDependencies = Readonly<{
  /** Server-side mutation; no device payload is accepted as authority. */
  acknowledge: () => Promise<AccountWideBadgeCountResponse>;
  /** Fallback only: preserve the canonical count when acknowledgement fails. */
  getUnreadCount: () => Promise<AccountWideBadgeCountResponse>;
  /** Local OS API. It never calls Expo/APNs/FCM. */
  setLocalBadgeCount: (count: number) => Promise<boolean>;
  /** Session + component-generation fence, checked after every await. */
  isCurrent: () => boolean;
}>;

export type AccountWideNativeBadgeReconcileResult =
  | Readonly<{
      state: "APPLIED";
      source: "ACKNOWLEDGEMENT" | "COUNT";
      count: number;
    }>
  | Readonly<{ state: "STALE" }>
  | Readonly<{ state: "PRESERVED" }>
  | Readonly<{ state: "UNAVAILABLE" }>;

export type AccountWideNativeBadgeReconcileFence = Readonly<{
  /** Starts a newer run and returns the capability held only by that run. */
  begin: () => () => boolean;
  /** Invalidates every outstanding run during unmount/logout. */
  invalidate: () => void;
}>;

/**
 * Foreground receive + resume can schedule reconciliations concurrently. A
 * newer result is authoritative for the local icon; an older network response
 * must never overwrite it while the same account/session remains active.
 */
export function createAccountWideNativeBadgeReconcileFence(): AccountWideNativeBadgeReconcileFence {
  let generation = 0;
  let active = true;

  return {
    begin() {
      const runGeneration = ++generation;
      return () => active && generation === runGeneration;
    },
    invalidate() {
      active = false;
      generation += 1;
    },
  };
}

async function applyCanonicalCount(
  response: AccountWideBadgeCountResponse,
  source: "ACKNOWLEDGEMENT" | "COUNT",
  allowZero: boolean,
  dependencies: AccountWideNativeBadgeReconcileDependencies,
): Promise<AccountWideNativeBadgeReconcileResult> {
  const count = parseAccountWideBadgeCount(response.count);
  if (count === null) return { state: "UNAVAILABLE" };
  // Falha da mutation significa que o servidor não confirmou a transição de
  // leitura. O fallback pode corrigir para uma contagem positiva, mas nunca
  // limpa o ícone com zero por inferência após essa falha.
  if (count === 0 && !allowZero) return { state: "PRESERVED" };
  if (!dependencies.isCurrent()) return { state: "STALE" };
  try {
    const write = await enqueueNativeBadgeWrite({
      isCurrent: dependencies.isCurrent,
      // `false` informa que a plataforma não oferece badge. A resposta
      // canônica ainda foi reconciliada e não deve virar uma falha.
      write: () => dependencies.setLocalBadgeCount(count),
    });
    if (write.state === "STALE") return { state: "STALE" };
  } catch {
    return dependencies.isCurrent()
      ? { state: "UNAVAILABLE" }
      : { state: "STALE" };
  }
  return { state: "APPLIED", source, count };
}

/**
 * Reconcilia apenas no dispositivo já aberto/retomado. Sem inbox por ID, a
 * semântica é acknowledgement account-wide de alertas visíveis à sessão
 * VERIFIED; uma falha não zera o ícone por inferência local.
 */
export async function reconcileAccountWideNativeBadge(
  dependencies: AccountWideNativeBadgeReconcileDependencies,
): Promise<AccountWideNativeBadgeReconcileResult> {
  if (!dependencies.isCurrent()) return { state: "STALE" };

  try {
    return await applyCanonicalCount(
      await dependencies.acknowledge(),
      "ACKNOWLEDGEMENT",
      true,
      dependencies,
    );
  } catch {
    if (!dependencies.isCurrent()) return { state: "STALE" };
    try {
      return await applyCanonicalCount(
        await dependencies.getUnreadCount(),
        "COUNT",
        false,
        dependencies,
      );
    } catch {
      return dependencies.isCurrent()
        ? { state: "UNAVAILABLE" }
        : { state: "STALE" };
    }
  }
}
