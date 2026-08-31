export type ActionableBadgeState =
  | Readonly<{ status: "LOADING"; count: null }>
  | Readonly<{ status: "READY"; count: number }>
  | Readonly<{ status: "STALE"; count: number }>
  | Readonly<{ status: "UNAVAILABLE"; count: null }>;

function isValidCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * Converte o resultado de uma query de atenção em estado explícito.
 * Uma falha nunca equivale a zero: se houver dado anterior ele é preservado
 * como STALE; sem dado confirmado, a contagem fica UNAVAILABLE.
 */
export function deriveActionableBadgeState(input: {
  count: unknown;
  hasError: boolean;
}): ActionableBadgeState {
  if (input.hasError) {
    return isValidCount(input.count)
      ? { status: "STALE", count: input.count }
      : { status: "UNAVAILABLE", count: null };
  }
  if (input.count === undefined) return { status: "LOADING", count: null };
  return isValidCount(input.count)
    ? { status: "READY", count: input.count }
    : { status: "UNAVAILABLE", count: null };
}

/**
 * Agrega filas disjuntas sem publicar total parcial como se fosse exato.
 * Uma fonte sem dado confirmado torna o conjunto indisponível; dado anterior
 * de todas as fontes pode ser somado, mas permanece marcado como STALE.
 */
export function combineActionableBadgeStates(
  states: readonly ActionableBadgeState[],
): ActionableBadgeState {
  if (states.length === 0) {
    return { status: "LOADING", count: null };
  }
  if (states.some((state) => state.status === "UNAVAILABLE")) {
    return { status: "UNAVAILABLE", count: null };
  }
  if (states.some((state) => state.status === "LOADING")) {
    return { status: "LOADING", count: null };
  }

  const count = states.reduce((total, state) => total + (state.count ?? 0), 0);
  if (!Number.isSafeInteger(count)) {
    return { status: "UNAVAILABLE", count: null };
  }
  return states.some((state) => state.status === "STALE")
    ? { status: "STALE", count }
    : { status: "READY", count };
}

export function actionableBadgeValue(
  state: ActionableBadgeState,
  maxVisibleCount = 9,
): string | number | undefined {
  const cap =
    Number.isSafeInteger(maxVisibleCount) && maxVisibleCount > 0
      ? maxVisibleCount
      : 9;

  if (state.status === "LOADING") return undefined;
  if (state.status === "UNAVAILABLE") return "!";
  if (state.status === "STALE" && state.count === 0) return "!";
  if (state.count === 0) return undefined;
  return state.count > cap ? `${cap}+` : state.count;
}

export function actionableBadgeUsesWarningTone(
  state: ActionableBadgeState,
): boolean {
  return state.status === "STALE" || state.status === "UNAVAILABLE";
}

export function actionableBadgeAccessibilityLabel(
  label: string,
  state: ActionableBadgeState,
): string {
  if (state.status === "LOADING") return label;
  if (state.status === "UNAVAILABLE") {
    return `${label}, contagem de pendências indisponível`;
  }
  if (state.status === "STALE" && state.count === 0) {
    return `${label}, contagem de pendências indisponível`;
  }
  if (state.count === 0) return label;

  const countLabel = `${state.count} pendência${state.count === 1 ? "" : "s"}`;
  return state.status === "STALE"
    ? `${label}, ${countLabel}, contagem desatualizada`
    : `${label}, ${countLabel}`;
}
