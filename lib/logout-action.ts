import {
  isSessionTerminationLocalCleanupError,
  isSessionTerminationNotDurableError,
} from "./session-cleanup";

export type LogoutFailureFeedback = Readonly<{
  title: string;
  message: string;
}>;

export function logoutFailureFeedback(error: unknown): LogoutFailureFeedback {
  if (isSessionTerminationNotDurableError(error)) {
    return {
      title: "Saída não confirmada",
      message:
        "O servidor não confirmou o encerramento e o app não tratou a saída como concluída. Tente novamente em instantes.",
    };
  }
  if (isSessionTerminationLocalCleanupError(error)) {
    return {
      title: "Sessão encerrada; limpeza incompleta",
      message:
        "O servidor confirmou a saída, mas este aparelho não concluiu toda a limpeza local. Feche e reabra o app antes de entregá-lo a outra pessoa.",
    };
  }
  return {
    title: "Não foi possível concluir a saída",
    message:
      "Não foi possível confirmar o resultado completo da saída. Tente novamente e, se o aviso persistir, feche o app e procure o suporte.",
  };
}

export type LogoutActionLock = { current: boolean };
export type LogoutActionOutcome = "SUCCESS" | "FAILED" | "CANCELLED" | "IGNORED";

export async function runGuardedLogoutAction(options: {
  lock: LogoutActionLock;
  logout: () => Promise<void>;
  confirm?: () => boolean | Promise<boolean>;
  onBusyChange: (busy: boolean) => void;
  onSuccess?: () => void | Promise<void>;
  onSuccessEffectError?: (error: unknown) => void;
  onFailure: (error: unknown) => void | Promise<void>;
}): Promise<LogoutActionOutcome> {
  if (options.lock.current) return "IGNORED";

  options.lock.current = true;
  options.onBusyChange(true);
  try {
    if (options.confirm && !(await options.confirm())) return "CANCELLED";
    try {
      await options.logout();
    } catch (error) {
      await options.onFailure(error);
      return "FAILED";
    }

    try {
      await options.onSuccess?.();
    } catch (error) {
      options.onSuccessEffectError?.(error);
    }
    return "SUCCESS";
  } finally {
    options.lock.current = false;
    options.onBusyChange(false);
  }
}
