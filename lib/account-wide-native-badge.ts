/**
 * Contrato compartilhado do badge nativo da conta.
 *
 * O número nunca é derivado do payload recebido no aparelho. O servidor usa
 * estes tipos apenas para selecionar as intenções push rastreadas que podem
 * participar da contagem canônica da conta autenticada.
 */
export const ACCOUNT_WIDE_BADGE_VERSION = 1 as const;

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

/** A foreground payload is only a trigger for its verified recipient. */
export function shouldReconcileAccountWideBadgeForReceivedNotification(input: {
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
