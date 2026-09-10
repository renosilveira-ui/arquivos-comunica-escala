const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isConfirmationRouteToken(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function parseConfirmationRouteToken(value: unknown): string | null {
  return isConfirmationRouteToken(value) ? value : null;
}

export function parseConfirmationRouteEpoch(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) &&
    parsed.getUTCMilliseconds() === 0 &&
    parsed.toISOString() === value
    ? value
    : null;
}
