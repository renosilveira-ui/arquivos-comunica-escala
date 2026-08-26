// Prazo único para fetch de abertura/login. Sem isso o BootScreen espera
// para sempre quando o Render está acordando ou o TCP fica preso.
// 60 s cobre o cold start documentado (47–64 s) e ainda libera a tela.

export const REQUEST_DEADLINE_MS = 70_000;
export const AUTHORIZATION_GATE_STALL_MS = 80_000;

export function isNetInfoOnline(state: {
  isConnected: boolean | null;
}): boolean {
  // isInternetReachable=false no iOS no primeiro segundo não é "sem rede".
  // Só a ausência explícita de conexão segura o guard no BootScreen.
  return state.isConnected !== false;
}

export function withRequestDeadline(
  existing?: AbortSignal | null,
  ms: number = REQUEST_DEADLINE_MS,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new Error("Tempo esgotado ao conectar ao servidor"));
    }
  }, ms);

  const abortFromExisting = () => {
    if (!controller.signal.aborted) {
      controller.abort(existing?.reason);
    }
  };
  if (existing) {
    if (existing.aborted) abortFromExisting();
    else existing.addEventListener("abort", abortFromExisting, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      existing?.removeEventListener("abort", abortFromExisting);
    },
  };
}
