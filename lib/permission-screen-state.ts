export type PendingContentState = "LOADING" | "MISSING_PROFESSIONAL" | "READY";

export function resolvePendingContentState(input: {
  pendingLoading: boolean;
  permissionsLoading: boolean;
  professionalLoading: boolean;
  myShiftsLoading: boolean;
  hasProfessional: boolean;
  canApproveAssignments: boolean;
}): PendingContentState {
  if (
    input.pendingLoading ||
    input.permissionsLoading ||
    input.professionalLoading ||
    input.myShiftsLoading
  ) {
    return "LOADING";
  }
  return !input.hasProfessional && !input.canApproveAssignments
    ? "MISSING_PROFESSIONAL"
    : "READY";
}

export type EditShiftPermissionState =
  | "LOADING"
  | "UNAUTHENTICATED"
  | "ALLOWED"
  | "DENIED";

export function resolveEditShiftPermissionState(input: {
  authLoading: boolean;
  hasUser: boolean;
  permissionsLoading: boolean;
  canEditShift: boolean;
}): EditShiftPermissionState {
  if (input.authLoading || input.permissionsLoading) return "LOADING";
  if (!input.hasUser) return "UNAUTHENTICATED";
  return input.canEditShift ? "ALLOWED" : "DENIED";
}

export function canLoadEditShift(
  state: EditShiftPermissionState,
  hasShiftId: boolean,
): boolean {
  return state === "ALLOWED" && hasShiftId;
}
