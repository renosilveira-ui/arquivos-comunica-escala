/**
 * The notification payload only names a possible vacancy. It never grants
 * access or carries the hospital/date used by the screen. Those fields come
 * exclusively from the tenant-scoped server resolution.
 */
export const VACANCY_PUSH_ROUTE_PARAM = "vacancyIntentId" as const;

export type VacancyPushIntentResolution =
  | Readonly<{
      available: true;
      shiftInstanceId: number;
      hospitalId: number;
      sectorId: number;
      date: string;
    }>
  | Readonly<{ available: false }>;

export type VacancyPushIntentTenantSnapshot = Readonly<{
  institutionId: number | null;
  revision: number;
}>;

export type VacancyPushIntentConsumptionFence = Readonly<{
  userId: number | null;
  sessionGeneration: number | null;
  tenantId: number | null;
  tenantRevision: number;
  intentShiftInstanceId: number | null;
  intentGeneration: number | null;
}>;

/** A synchronous publication made before the router schedules its rerender. */
export type VacancyPushIntentPublication = Readonly<{
  userId: number;
  sessionGeneration: number;
  shiftInstanceId: number;
  generation: number;
}>;

export type VacancyPushIntentNotificationFence = Readonly<{
  publish: (
    userId: number,
    sessionGeneration: number,
    shiftInstanceId: number,
  ) => VacancyPushIntentPublication | null;
  current: () => VacancyPushIntentPublication | null;
  clearIfCurrent: (expected: VacancyPushIntentPublication) => boolean;
  clearIfSessionCurrent: (userId: number, sessionGeneration: number) => boolean;
}>;

/**
 * Router params update on React's schedule. This tiny in-memory fence is
 * published synchronously by the notification listener first, so a passive
 * effect for an older intent cannot clear a newer one before that rerender.
 */
export function createVacancyPushIntentNotificationFence(): VacancyPushIntentNotificationFence {
  let generation = 0;
  let current: VacancyPushIntentPublication | null = null;

  return {
    publish(userId, sessionGeneration, shiftInstanceId) {
      if (
        !isPositiveSafeInteger(userId) ||
        !isNonNegativeSafeInteger(sessionGeneration) ||
        !isPositiveSafeInteger(shiftInstanceId)
      ) {
        return null;
      }
      generation += 1;
      current = { userId, sessionGeneration, shiftInstanceId, generation };
      return { ...current };
    },
    current() {
      return current === null ? null : { ...current };
    },
    clearIfCurrent(expected) {
      if (
        current === null ||
        current.userId !== expected.userId ||
        current.sessionGeneration !== expected.sessionGeneration ||
        current.shiftInstanceId !== expected.shiftInstanceId ||
        current.generation !== expected.generation
      ) {
        return false;
      }
      current = null;
      return true;
    },
    clearIfSessionCurrent(userId, sessionGeneration) {
      if (
        !isPositiveSafeInteger(userId) ||
        !isNonNegativeSafeInteger(sessionGeneration) ||
        current === null ||
        current.userId !== userId ||
        current.sessionGeneration !== sessionGeneration
      ) {
        return false;
      }
      current = null;
      return true;
    },
  };
}

export const vacancyPushIntentNotificationFence =
  createVacancyPushIntentNotificationFence();

export type VacancyPushIntentRouteState =
  | Readonly<{ kind: "IDLE" }>
  | Readonly<{ kind: "LOADING" }>
  | Readonly<{ kind: "ERROR" }>
  | Readonly<{ kind: "UNAVAILABLE" }>
  | Readonly<{
      kind: "READY";
      selection: Readonly<{
        hospitalId: number;
        sectorId: number;
        date: string;
      }>;
    }>;

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isHospitalDayKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isSameTenantSnapshot(
  left: VacancyPushIntentTenantSnapshot,
  right: VacancyPushIntentTenantSnapshot,
): boolean {
  return (
    left.institutionId === right.institutionId &&
    left.revision === right.revision
  );
}

export function isVacancyPushIntentConsumptionFenceCurrent(
  captured: VacancyPushIntentConsumptionFence,
  current: VacancyPushIntentConsumptionFence,
): boolean {
  return (
    captured.userId === current.userId &&
    captured.sessionGeneration === current.sessionGeneration &&
    captured.tenantId === current.tenantId &&
    captured.tenantRevision === current.tenantRevision &&
    captured.intentShiftInstanceId === current.intentShiftInstanceId &&
    captured.intentGeneration === current.intentGeneration
  );
}

/**
 * A publication is usable only by the exact session and route that produced
 * it. In particular, an old ticket for the same account must not shadow an
 * external deep link after that account rotates its session.
 */
export function matchVacancyPushIntentPublicationForRoute(
  publication: VacancyPushIntentPublication | null,
  currentUserId: number | null,
  currentSessionGeneration: number | null,
  shiftInstanceId: number | null,
): VacancyPushIntentPublication | null {
  return publication?.userId === currentUserId &&
    publication.sessionGeneration === currentSessionGeneration &&
    publication.shiftInstanceId === shiftInstanceId
    ? publication
    : null;
}

export function isVacancyPushIntentPublicationCurrent(
  expected: VacancyPushIntentPublication | null,
  current: VacancyPushIntentPublication | null,
  currentUserId: number | null,
  currentSessionGeneration: number | null,
): boolean {
  if (
    !isPositiveSafeInteger(currentUserId) ||
    !isNonNegativeSafeInteger(currentSessionGeneration)
  ) {
    return false;
  }
  const currentForSession =
    current?.userId === currentUserId &&
    current.sessionGeneration === currentSessionGeneration
      ? current
      : null;
  if (expected === null) return currentForSession === null;
  return (
    expected.userId === currentUserId &&
    expected.sessionGeneration === currentSessionGeneration &&
    currentForSession !== null &&
    expected.shiftInstanceId === currentForSession.shiftInstanceId &&
    expected.generation === currentForSession.generation
  );
}

/** Route params may be duplicated by an external deep link; reject ambiguity. */
export function parseVacancyPushIntentId(value: unknown): number | null {
  if (Array.isArray(value)) return null;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[1-9]\d*$/.test(value)
        ? Number(value)
        : Number.NaN;
  return isPositiveSafeInteger(parsed) ? parsed : null;
}

export function vacancyPushRouteParams(shiftInstanceId: number): {
  vacancyIntentId: string;
} {
  return { vacancyIntentId: String(shiftInstanceId) };
}

export function clearVacancyPushRouteParams(): {
  vacancyIntentId: undefined;
} {
  return { vacancyIntentId: undefined };
}

/**
 * Converts query state into a fail-closed view state. In particular, a cached
 * answer for a previous route parameter cannot select filters for a new one
 * or leave the user in an indefinite loading state.
 */
export function resolveVacancyPushIntentRouteState(input: {
  intentShiftInstanceId: number | null;
  resolutionTenant: VacancyPushIntentTenantSnapshot;
  currentTenant: VacancyPushIntentTenantSnapshot;
  isFetching: boolean;
  isError: boolean;
  data: VacancyPushIntentResolution | undefined;
}): VacancyPushIntentRouteState {
  if (input.intentShiftInstanceId === null) return { kind: "IDLE" };
  if (!isSameTenantSnapshot(input.resolutionTenant, input.currentTenant)) {
    return { kind: "ERROR" };
  }
  if (input.isError) return { kind: "ERROR" };
  if (input.isFetching || input.data === undefined) return { kind: "LOADING" };
  if (!input.data.available) return { kind: "UNAVAILABLE" };

  if (
    input.data.shiftInstanceId !== input.intentShiftInstanceId ||
    !isPositiveSafeInteger(input.data.hospitalId) ||
    !isPositiveSafeInteger(input.data.sectorId) ||
    !isHospitalDayKey(input.data.date)
  ) {
    return { kind: "ERROR" };
  }

  return {
    kind: "READY",
    selection: {
      hospitalId: input.data.hospitalId,
      sectorId: input.data.sectorId,
      date: input.data.date,
    },
  };
}
