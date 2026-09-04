import { presentQueryError } from "./query-error-presentation";

/**
 * Estado da superfície "Próximo plantão".
 *
 * Erro, loading, ausência real e sucesso não se colapsam por truthiness:
 * `data === undefined` não é ausência; `data === null` só é EMPTY depois
 * de um resultado canônico (ou cache de ausência já confirmada).
 */
export type NextShiftQueryState = "LOADING" | "ERROR" | "EMPTY" | "SUCCESS";

export const NEXT_SHIFT_ERROR_TITLE =
  "Não foi possível carregar seu próximo plantão.";
export const NEXT_SHIFT_EMPTY_TITLE = "Nenhum plantão agendado";
export const NEXT_SHIFT_EMPTY_SUBTITLE =
  "Quando você for alocado, ele aparece aqui.";
export const NEXT_SHIFT_RETRY_LABEL = "Tentar novamente";
export const NEXT_SHIFT_LOADING_A11Y = "Carregando próximo plantão";

function isNextShiftPayload(data: unknown): data is object {
  return data !== null && data !== undefined && typeof data === "object";
}

/**
 * Decide o estado sem `data ? … : empty`.
 *
 * - Plantão em cache (inclusive após refetch falho não-ACCESS) → SUCCESS.
 * - `null` canônico (inclusive refetch falho não-ACCESS) → EMPTY.
 * - ACCESS (401/403) sempre ERROR: sessão/revogação não é "sem plantão".
 * - Erro sem resultado anterior → ERROR.
 * - Demais (pending, disabled, primeiro fetch) → LOADING, nunca EMPTY.
 */
export function resolveNextShiftState(input: {
  isLoading: boolean;
  isError: boolean;
  data: unknown;
  error?: unknown;
}): NextShiftQueryState {
  if (input.isError && presentQueryError(input.error).kind === "ACCESS") {
    return "ERROR";
  }
  if (isNextShiftPayload(input.data)) return "SUCCESS";
  if (input.data === null) return "EMPTY";
  if (input.isError) return "ERROR";
  if (input.isLoading) return "LOADING";
  return "LOADING";
}

export function nextShiftSurface(state: NextShiftQueryState): {
  kind: NextShiftQueryState;
  title: string | null;
  showRetry: boolean;
  retryLabel: string | null;
} {
  switch (state) {
    case "LOADING":
      return { kind: "LOADING", title: null, showRetry: false, retryLabel: null };
    case "ERROR":
      return {
        kind: "ERROR",
        title: NEXT_SHIFT_ERROR_TITLE,
        showRetry: true,
        retryLabel: NEXT_SHIFT_RETRY_LABEL,
      };
    case "EMPTY":
      return {
        kind: "EMPTY",
        title: NEXT_SHIFT_EMPTY_TITLE,
        showRetry: false,
        retryLabel: null,
      };
    case "SUCCESS":
      return { kind: "SUCCESS", title: null, showRetry: false, retryLabel: null };
  }
}
