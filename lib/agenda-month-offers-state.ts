import {
  canDisplayOperationalListCount,
  resolveOperationalListState,
  type OperationalListState,
} from "./operational-screen-state";

/**
 * Ofertas sobrepostas na grade mensal da Agenda.
 *
 * `data === undefined` em `swaps.listAvailable` não é “não há ofertas”:
 * em React Query isso também é erro, loading e query desabilitada.
 * Colapsar com `availableSwaps ?? []` apaga os ticks azuis e as faixas
 * do dia como se o mês estivesse limpo.
 */
export type AgendaMonthOffersQueryState = OperationalListState;
export type AgendaMonthOffersSurfaceKind = "LOADING" | "ERROR" | "EMPTY" | "READY";

export const AGENDA_MONTH_OFFERS_ERROR_TITLE =
  "Não foi possível carregar as ofertas da agenda.";
export const AGENDA_MONTH_OFFERS_RETRY_LABEL = "Tentar novamente";

export function resolveAgendaMonthOffersState(input: {
  isLoading: boolean;
  isPending: boolean;
  isError: boolean;
  data: readonly unknown[] | undefined;
  error?: unknown;
}): AgendaMonthOffersQueryState {
  return resolveOperationalListState({
    isLoading: input.isLoading,
    isPending: input.isPending,
    isError: input.isError,
    hasResolvedData: input.data !== undefined,
    itemCount: Array.isArray(input.data) ? input.data.length : 0,
    error: input.error,
  });
}

export function canDisplayAgendaMonthOffers(
  state: AgendaMonthOffersQueryState,
): boolean {
  return canDisplayOperationalListCount(state);
}

export function agendaMonthOffersSurface(state: AgendaMonthOffersQueryState): {
  kind: AgendaMonthOffersSurfaceKind;
  title: string | null;
  showRetry: boolean;
  retryLabel: string | null;
  paintOfferTicks: boolean;
} {
  switch (state) {
    case "LOADING":
    case "UNRESOLVED":
      return {
        kind: "LOADING",
        title: null,
        showRetry: false,
        retryLabel: null,
        paintOfferTicks: false,
      };
    case "ERROR":
      return {
        kind: "ERROR",
        title: AGENDA_MONTH_OFFERS_ERROR_TITLE,
        showRetry: true,
        retryLabel: AGENDA_MONTH_OFFERS_RETRY_LABEL,
        paintOfferTicks: false,
      };
    case "EMPTY":
      return {
        kind: "EMPTY",
        title: null,
        showRetry: false,
        retryLabel: null,
        paintOfferTicks: true,
      };
    case "READY":
      return {
        kind: "READY",
        title: null,
        showRetry: false,
        retryLabel: null,
        paintOfferTicks: true,
      };
  }
}
