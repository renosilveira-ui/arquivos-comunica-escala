export type ManagementDirection =
  "LOADING" | "UNAVAILABLE" | "ADMIN_REQUIRED" | "CREATE";

/** Navigation projection only; the write still authorizes actor + scope on server. */
export function managementDirection(input: {
  institutionId: number | null;
  fetching: boolean;
  error: boolean;
  capabilities?: { institutionId: number; canCreateShift: boolean };
}): ManagementDirection {
  if (input.institutionId === null) return "ADMIN_REQUIRED";
  if (input.fetching) return "LOADING";
  if (
    input.error ||
    !input.capabilities ||
    input.capabilities.institutionId !== input.institutionId
  )
    return "UNAVAILABLE";
  return input.capabilities.canCreateShift === true
    ? "CREATE"
    : "ADMIN_REQUIRED";
}

export function operationalEntryDirection(input: {
  fetching: boolean;
  error: boolean;
  contextCount?: number;
}): "LOADING" | "UNAVAILABLE" | "ONBOARDING" | "AGENDA" {
  if (input.fetching) return "LOADING";
  if (input.error || input.contextCount === undefined) return "UNAVAILABLE";
  return input.contextCount === 0 ? "ONBOARDING" : "AGENDA";
}

/** Evaluated only AFTER the current session/membership attestation. */
export function isUnlinkedAccountRoute(pathname: string): boolean {
  return [
    "/onboarding",
    "/account-profile",
    "/join-schedule",
    "/change-password",
  ].includes(pathname);
}
