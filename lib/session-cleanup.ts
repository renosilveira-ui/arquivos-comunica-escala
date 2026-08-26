import {
  getActiveWebSessionWorkflowSignal,
  waitForActiveWebSessionWorkflow,
} from "./_core/web-session-workflow";

export type SessionCleanupStep = {
  name: string;
  run: () => void | Promise<void>;
};

type CleanupFailure = {
  name: string;
  error: unknown;
};

export class SessionTerminationNotDurableError extends Error {
  readonly reason: unknown;

  constructor(reason: unknown) {
    super("Não foi possível encerrar a sessão com segurança neste aparelho");
    this.name = "SessionTerminationNotDurableError";
    this.reason = reason;
  }
}

export function isSessionTerminationNotDurableError(
  error: unknown,
): error is SessionTerminationNotDurableError {
  return error instanceof SessionTerminationNotDurableError;
}

export async function runSessionCleanup(
  steps: readonly SessionCleanupStep[],
  finalizeInMemoryState: () => void | Promise<void>,
  reportFailure: (name: string, error: unknown) => void = (name, error) => {
    console.error(`[Auth] Falha ao limpar ${name}`, error);
  },
): Promise<void> {
  const failures: CleanupFailure[] = [];
  const report = (name: string, error: unknown) => {
    try {
      reportFailure(name, error);
    } catch {
      // Observabilidade não pode interromper as demais etapas de limpeza.
    }
  };

  try {
    for (const step of steps) {
      try {
        const workflowSignal = getActiveWebSessionWorkflowSignal();
        if (workflowSignal?.aborted) {
          throw (
            workflowSignal.reason ??
            new Error("Workflow de sessão web cancelado")
          );
        }
        await waitForActiveWebSessionWorkflow(
          Promise.resolve(step.run()),
          workflowSignal,
        );
      } catch (error) {
        failures.push({ name: step.name, error });
        report(step.name, error);
      }
    }
  } finally {
    try {
      await finalizeInMemoryState();
    } catch (error) {
      failures.push({ name: "estado de autenticação em memória", error });
      report("estado de autenticação em memória", error);
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map(({ error }) => error),
      `Limpeza local da sessão incompleta: ${failures.map(({ name }) => name).join(", ")}`,
    );
  }
}
