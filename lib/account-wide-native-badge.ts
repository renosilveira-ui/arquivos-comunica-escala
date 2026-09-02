/**
 * Contrato compartilhado do badge nativo da conta.
 *
 * O número nunca é derivado do payload recebido no aparelho. O servidor usa
 * estes tipos apenas para selecionar as intenções push rastreadas que podem
 * participar da contagem canônica da conta autenticada.
 */
export const ACCOUNT_WIDE_BADGE_VERSION = 1 as const;

/**
 * O snapshot remoto não carrega identidade, tenant ou conteúdo. Um collapse
 * id fixo só coalesce snapshots de badge no mesmo aparelho, sem misturar as
 * notificações visíveis entre si.
 */
export const ACCOUNT_WIDE_BADGE_SNAPSHOT_COLLAPSE_ID =
  "escalas-account-badge-snapshot-v1" as const;

/**
 * Único marcador permitido no snapshot remoto. Ele não identifica conta,
 * instituição, turno ou pessoa: no app aberto serve somente para disparar a
 * leitura canônica no servidor, nunca para confiar no número recebido.
 */
export const ACCOUNT_WIDE_BADGE_SNAPSHOT_DATA = Object.freeze({
  accountWideBadgeSnapshotVersion: ACCOUNT_WIDE_BADGE_VERSION,
});

// O snapshot é uma fotografia eventual, não uma notificação operacional.
// Cinco minutos limita a possibilidade de o provedor entregar um número já
// superado; a abertura/retomada ainda reconcilia a fonte canônica.
export const ACCOUNT_WIDE_BADGE_SNAPSHOT_TTL_SECONDS = 5 * 60;

export const ACCOUNT_WIDE_BADGE_NOTIFICATION_TYPES = [
  "duty_confirmation",
  "duty_nomination",
  "duty_auto_confirmed",
  "manager_confirmation_escalation",
  "replacement_accepted",
  "replacement_declined",
  "sso_ready",
  "shift_assigned",
  "shift_unassigned",
  "shift_reminder",
  "swap_offer",
  "swap_taken",
  "vacancy_available",
  "vacancy_request_created",
  "vacancy_request_approved",
  "vacancy_request_rejected",
  "invite_accepted",
  "invite_declined",
] as const;

export type AccountWideBadgeNotificationType =
  (typeof ACCOUNT_WIDE_BADGE_NOTIFICATION_TYPES)[number];

export function isAccountWideBadgeNotificationType(
  value: unknown,
): value is AccountWideBadgeNotificationType {
  return (
    typeof value === "string" &&
    (ACCOUNT_WIDE_BADGE_NOTIFICATION_TYPES as readonly string[]).includes(value)
  );
}

export function parseAccountWideBadgeCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

export function isAccountWideBadgeSnapshotNotificationData(
  value: unknown,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Readonly<Record<string, unknown>>;
  return (
    data.accountWideBadgeSnapshotVersion === ACCOUNT_WIDE_BADGE_VERSION &&
    // O marker é um contrato fechado: nada além da versão pode fazer um
    // payload recebido disparar até mesmo uma consulta autenticada.
    Object.keys(data).length === 1
  );
}

export function shouldRefreshAccountWideBadgeForReceivedSnapshot(input: {
  data: unknown;
  isSessionAuthorizationCurrent: boolean;
}): boolean {
  return (
    input.isSessionAuthorizationCurrent &&
    isAccountWideBadgeSnapshotNotificationData(input.data)
  );
}

/**
 * Web não tem badge de ícone controlado pelo Expo. No nativo, a retomada é a
 * fronteira de reconciliação para push recebido enquanto o processo estava
 * suspenso; troca de instituição não participa desta decisão account-scoped.
 */
export function shouldRefreshAccountWideBadgeOnAppStateChange(input: {
  platform: string;
  previousState: string;
  nextState: string;
}): boolean {
  return (
    input.platform !== "web" &&
    input.previousState !== "active" &&
    input.nextState === "active"
  );
}

/** A foreground payload is only a trigger for a count-only refresh. */
export function shouldRefreshAccountWideBadgeForReceivedNotification(input: {
  recipientUserId: number | null;
  currentUserId: number | null;
  isSessionAuthorizationCurrent: boolean;
}): boolean {
  return (
    input.isSessionAuthorizationCurrent &&
    input.currentUserId !== null &&
    input.recipientUserId === input.currentUserId
  );
}
