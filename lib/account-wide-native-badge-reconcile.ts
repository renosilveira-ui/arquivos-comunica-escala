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

export type AccountWideNativeBadgeReconciliationQueue = Readonly<{
  /**
   * Serializes server acknowledgement and count refreshes for one mounted
   * session. A refresh that begins while an acknowledgement is in flight must
   * observe the acknowledgement's committed state instead of restoring a
   * pre-acknowledgement count on the icon.
   */
  enqueue: <T>(operation: () => Promise<T>) => Promise<T>;
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

/**
 * This queue is intentionally per mounted session. The process-wide write
 * queue still protects the operating-system icon across logout/new login;
 * this queue protects causal ordering of server operations within one session.
 */
export function createAccountWideNativeBadgeReconciliationQueue(): AccountWideNativeBadgeReconciliationQueue {
  let tail: Promise<void> = Promise.resolve();

  return {
    enqueue<T>(operation: () => Promise<T>): Promise<T> {
      const scheduled = tail.then(operation, operation);
      tail = scheduled.then(
        () => undefined,
        () => undefined,
      );
      return scheduled;
    },
  };
}

async function applyCanonicalCount(
  response: AccountWideBadgeCountResponse,
  source: "ACKNOWLEDGEMENT" | "COUNT",
  allowZero: boolean,
  dependencies: Pick<
    AccountWideNativeBadgeReconcileDependencies,
    "setLocalBadgeCount" | "isCurrent"
  >,
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

/**
 * Um snapshot remoto recebido com o app aberto não tem autoridade para
 * escrever seu próprio número. Ele apenas dispara esta leitura autenticada,
 * sem acknowledgement: assim um payload forjado ou atrasado nunca marca
 * alertas como lidos.
 */
export async function refreshAccountWideNativeBadge(
  dependencies: Pick<
    AccountWideNativeBadgeReconcileDependencies,
    "getUnreadCount" | "setLocalBadgeCount" | "isCurrent"
  >,
): Promise<AccountWideNativeBadgeReconcileResult> {
  if (!dependencies.isCurrent()) return { state: "STALE" };
  try {
    return await applyCanonicalCount(
      await dependencies.getUnreadCount(),
      "COUNT",
      true,
      dependencies,
    );
  } catch {
    return dependencies.isCurrent()
      ? { state: "UNAVAILABLE" }
      : { state: "STALE" };
  }
}
