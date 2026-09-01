import { shouldInvalidateSwapQueriesOnNotification } from "./swap-offer-badge-refresh";
import { shouldInvalidateVacancyQueriesOnNotification } from "./vacancy-broadcast";

export type NotificationQueryRefreshTarget =
  | "SWAPS"
  | "VACANCIES"
  | "SCHEDULES"
  | "PENDING_ASSIGNMENTS"
  | "SCHEDULE_INVITES"
  | "SUMMARY_COUNTS";

const NONE: readonly NotificationQueryRefreshTarget[] = Object.freeze([]);
const SWAPS = Object.freeze(["SWAPS"] as const);
const VACANCIES = Object.freeze(["VACANCIES", "SUMMARY_COUNTS"] as const);
const SWAPS_AND_SCHEDULES = Object.freeze(["SWAPS", "SCHEDULES"] as const);
const SCHEDULES = Object.freeze(["SCHEDULES"] as const);
const REPLACEMENT_ACCEPTED = Object.freeze(["SCHEDULES", "SWAPS"] as const);
const ASSIGNMENT_CHANGE = Object.freeze([
  "SCHEDULES",
  "VACANCIES",
  "PENDING_ASSIGNMENTS",
  "SUMMARY_COUNTS",
  "SWAPS",
] as const);
const SCHEDULE_INVITES = Object.freeze(["SCHEDULE_INVITES"] as const);

/**
 * Matriz fechada de caches que um push em primeiro plano torna potencialmente
 * obsoletos. Tipos desconhecidos falham fechados e não provocam refetch amplo.
 */
export function notificationQueryRefreshTargets(
  type: unknown,
): readonly NotificationQueryRefreshTarget[] {
  if (shouldInvalidateSwapQueriesOnNotification(type)) {
    return type === "swap_taken" ? SWAPS_AND_SCHEDULES : SWAPS;
  }
  if (shouldInvalidateVacancyQueriesOnNotification(type)) return VACANCIES;

  switch (type) {
    case "shift_assigned":
    case "shift_unassigned":
      return ASSIGNMENT_CHANGE;
    case "replacement_accepted":
      return REPLACEMENT_ACCEPTED;
    case "replacement_declined":
      return SCHEDULES;
    case "duty_confirmation":
    case "duty_nomination":
    case "duty_auto_confirmed":
    case "manager_confirmation_escalation":
    case "shift_reminder":
      return SCHEDULES;
    case "invite_accepted":
    case "invite_declined":
      return SCHEDULE_INVITES;
    default:
      return NONE;
  }
}
