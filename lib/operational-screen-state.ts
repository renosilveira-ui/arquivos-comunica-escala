import { presentQueryError } from "./query-error-presentation";

export type OperationalListState =
  | "LOADING"
  | "UNRESOLVED"
  | "ERROR"
  | "EMPTY"
  | "READY";

/**
 * Um contador é uma afirmação sobre o conjunto inteiro. Só o expomos após
 * resposta confirmada; loading, erro e estado pausado usam texto neutro.
 */
export function canDisplayOperationalListCount(
  state: OperationalListState,
): boolean {
  return state === "READY" || state === "EMPTY";
}

/**
 * Dados já confirmados podem permanecer visíveis após um refresh falhar,
 * mas uma coleção vazia jamais é tratada como fato quando a query falhou.
 */
export function resolveOperationalListState(input: {
  isLoading: boolean;
  isPending: boolean;
  isError: boolean;
  hasResolvedData: boolean;
  itemCount: number;
  error?: unknown;
}): OperationalListState {
  if (input.isLoading) return "LOADING";
  if (
    input.isError &&
    (input.itemCount === 0 || presentQueryError(input.error).kind === "ACCESS")
  ) {
    return "ERROR";
  }
  // Uma query desabilitada, pausada ou ainda sem resposta não autoriza a UI a
  // afirmar que a lista está vazia.
  if (input.isPending || !input.hasResolvedData) return "UNRESOLVED";
  return input.itemCount > 0 ? "READY" : "EMPTY";
}

export type VacanciesGateState =
  | "LOADING"
  | "AUTH_REQUIRED"
  | "PROFESSIONAL_UNAVAILABLE"
  | "MISSING_PROFESSIONAL"
  | "FILTERS_UNAVAILABLE"
  | "READY";

export function resolveVacanciesGateState(input: {
  authLoading: boolean;
  permissionsLoading: boolean;
  professionalLoading: boolean;
  filtersLoading: boolean;
  hasUser: boolean;
  hasProfessional: boolean;
  professionalUnavailable: boolean;
  filtersUnavailable: boolean;
}): VacanciesGateState {
  if (
    input.authLoading ||
    input.permissionsLoading ||
    input.professionalLoading ||
    input.filtersLoading
  ) {
    return "LOADING";
  }
  if (!input.hasUser) return "AUTH_REQUIRED";
  if (input.professionalUnavailable) return "PROFESSIONAL_UNAVAILABLE";
  if (!input.hasProfessional) return "MISSING_PROFESSIONAL";
  if (input.filtersUnavailable) return "FILTERS_UNAVAILABLE";
  return "READY";
}

export function resolveMyApplicationsContentState(input: {
  isLoading: boolean;
  isPending: boolean;
  hasError: boolean;
  hasResolvedApplications: boolean;
  hasResolvedVacancyRequests: boolean;
  applicationCount: number;
  vacancyRequestCount: number;
}): OperationalListState {
  if (input.isLoading) return "LOADING";
  // Candidaturas são um histórico operacional: se uma das duas fontes falha,
  // um cache parcial não pode ser apresentado como lista completa.
  if (input.hasError) return "ERROR";
  if (
    input.isPending ||
    !input.hasResolvedApplications ||
    !input.hasResolvedVacancyRequests
  ) {
    return "UNRESOLVED";
  }
  return input.applicationCount + input.vacancyRequestCount > 0
    ? "READY"
    : "EMPTY";
}
