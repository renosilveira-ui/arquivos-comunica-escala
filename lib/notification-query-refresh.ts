import { shouldInvalidateSwapQueriesOnNotification } from "./swap-offer-badge-refresh";
import { shouldInvalidateVacancyQueriesOnNotification } from "./vacancy-broadcast";

export type NotificationQueryRefreshTarget =
  | "SWAPS"
  | "VACANCIES"
  | "SCHEDULES"
  | "PENDING_ASSIGNMENTS"
  | "MY_VACANCY_REQUESTS"
  | "SCHEDULE_INVITES"
  | "SUMMARY_COUNTS"
  | "ACTIONABLE_VACANCY_COUNTS";

const NONE: readonly NotificationQueryRefreshTarget[] = Object.freeze([]);
const SWAPS = Object.freeze(["SWAPS"] as const);
const VACANCIES = Object.freeze([
  "VACANCIES",
  "SUMMARY_COUNTS",
  "ACTIONABLE_VACANCY_COUNTS",
] as const);
const SWAPS_AND_SCHEDULES = Object.freeze(["SWAPS", "SCHEDULES"] as const);
const SCHEDULES = Object.freeze(["SCHEDULES"] as const);
const REPLACEMENT_ACCEPTED = Object.freeze(["SCHEDULES", "SWAPS"] as const);
const ASSIGNMENT_CHANGE = Object.freeze([
  "SCHEDULES",
  "VACANCIES",
  "PENDING_ASSIGNMENTS",
  "SUMMARY_COUNTS",
  "ACTIONABLE_VACANCY_COUNTS",
  "SWAPS",
] as const);
const VACANCY_REQUEST_CREATED = Object.freeze([
  "PENDING_ASSIGNMENTS",
  "SUMMARY_COUNTS",
] as const);
const VACANCY_REQUEST_DECIDED = Object.freeze([
  ...ASSIGNMENT_CHANGE,
  "MY_VACANCY_REQUESTS",
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
    case "vacancy_request_created":
      return VACANCY_REQUEST_CREATED;
    case "vacancy_request_approved":
    case "vacancy_request_rejected":
      return VACANCY_REQUEST_DECIDED;
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
