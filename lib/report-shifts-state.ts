import {
  canDisplayOperationalListCount,
  resolveOperationalListState,
  type OperationalListState,
} from "./operational-screen-state";

/**
 * Estado do Relatório de Escalas.
 *
 * Estatísticas (total, horas, confirmadas, vazias) são afirmações sobre o
 * mês inteiro. `data === undefined` não é “nenhuma escala”: em React Query
 * isso também é erro, loading e query desabilitada. Colapsar com
 * `apiShifts || []` transforma falha em zero — o usuário confia no resumo.
 */
export type ReportShiftsQueryState = OperationalListState;
export type ReportShiftsSurfaceKind = "LOADING" | "ERROR" | "EMPTY" | "READY";

export const REPORT_SHIFTS_ERROR_TITLE =
  "Não foi possível carregar o relatório de escalas.";
export const REPORT_SHIFTS_EMPTY_TITLE = "Nenhuma escala neste mês";
export const REPORT_SHIFTS_RETRY_LABEL = "Tentar novamente";
export const REPORT_SHIFTS_LOADING_LABEL = "Carregando dados...";

export function resolveReportShiftsState(input: {
  isDemo: boolean;
  demoCount: number;
  isLoading: boolean;
  isPending: boolean;
  isError: boolean;
  data: readonly unknown[] | undefined;
  error?: unknown;
}): ReportShiftsQueryState {
  if (input.isDemo) {
    return input.demoCount > 0 ? "READY" : "EMPTY";
  }
  return resolveOperationalListState({
    isLoading: input.isLoading,
    isPending: input.isPending,
    isError: input.isError,
    hasResolvedData: input.data !== undefined,
    itemCount: Array.isArray(input.data) ? input.data.length : 0,
    error: input.error,
  });
}

export function canDisplayReportStatistics(
  state: ReportShiftsQueryState,
): boolean {
  return canDisplayOperationalListCount(state);
}

export function reportShiftsSurface(state: ReportShiftsQueryState): {
  kind: ReportShiftsSurfaceKind;
  title: string | null;
  showRetry: boolean;
  retryLabel: string | null;
  showStatistics: boolean;
} {
  switch (state) {
    case "LOADING":
    case "UNRESOLVED":
      return {
        kind: "LOADING",
        title: null,
        showRetry: false,
        retryLabel: null,
        showStatistics: false,
      };
    case "ERROR":
      return {
        kind: "ERROR",
        title: REPORT_SHIFTS_ERROR_TITLE,
        showRetry: true,
        retryLabel: REPORT_SHIFTS_RETRY_LABEL,
        showStatistics: false,
      };
    case "EMPTY":
      return {
        kind: "EMPTY",
        title: REPORT_SHIFTS_EMPTY_TITLE,
        showRetry: false,
        retryLabel: null,
        showStatistics: true,
      };
    case "READY":
      return {
        kind: "READY",
        title: null,
        showRetry: false,
        retryLabel: null,
        showStatistics: true,
      };
  }
}
