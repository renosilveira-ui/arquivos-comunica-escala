import {
  getActiveWebSessionWorkflowSignal,
  waitForActiveWebSessionWorkflow,
} from "./_core/web-session-workflow";
import { enqueueNativeBadgeWrite } from "./native-badge-write-queue";

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

export class SessionTerminationLocalCleanupError extends Error {
  readonly reason: unknown;

  constructor(reason: unknown) {
    super("A sessão foi revogada, mas a limpeza local ficou incompleta");
    this.name = "SessionTerminationLocalCleanupError";
    this.reason = reason;
  }
}

export function isSessionTerminationLocalCleanupError(
  error: unknown,
): error is SessionTerminationLocalCleanupError {
  return error instanceof SessionTerminationLocalCleanupError;
}

export class AccountDeletionLocalCleanupError extends Error {
  readonly reason: unknown;

  constructor(reason: unknown) {
    super("A conta foi excluída, mas a limpeza local ficou incompleta");
    this.name = "AccountDeletionLocalCleanupError";
    this.reason = reason;
  }
}

export function isAccountDeletionLocalCleanupError(
  error: unknown,
): error is AccountDeletionLocalCleanupError {
  return error instanceof AccountDeletionLocalCleanupError;
}

export type NativeNotificationCleanupApi = Readonly<{
  setBadgeCountAsync: (count: number) => Promise<boolean>;
  dismissAllNotificationsAsync: () => Promise<void>;
  cancelAllScheduledNotificationsAsync: () => Promise<void>;
  clearLastNotificationResponse: () => void;
}>;

type NativeNotificationCleanupLoader =
  () => Promise<NativeNotificationCleanupApi>;

async function loadNativeNotificationCleanupApi(): Promise<NativeNotificationCleanupApi> {
  return import("expo-notifications");
}

/**
 * Limpa artefatos visíveis da conta que acabou de ser revogada. As APIs do
 * sistema operacional são app-scoped; o isolamento por conta vem do caller,
 * que só executa estas etapas para a lease ainda atual e depois do ACK remoto.
 */
export function createAccountScopedNotificationCleanupSteps(
  platform: string,
  loadApi: NativeNotificationCleanupLoader = loadNativeNotificationCleanupApi,
  isCurrent: () => boolean = () => true,
): readonly SessionCleanupStep[] {
  if (platform === "web") return [];

  let apiPromise: Promise<NativeNotificationCleanupApi> | null = null;
  const getApi = () => {
    apiPromise ??= loadApi();
    return apiPromise;
  };

  return [
    {
      name: "badge de notificações do aparelho",
      run: async () => {
        // `false` significa que a plataforma não oferece suporte a badge, não
        // que a limpeza falhou. Rejeições da Promise continuam sendo agregadas.
        await enqueueNativeBadgeWrite({
          isCurrent,
          write: async () => (await getApi()).setBadgeCountAsync(0),
        });
      },
    },
    {
      name: "notificações entregues no aparelho",
      run: async () => {
        await (await getApi()).dismissAllNotificationsAsync();
      },
    },
    {
      name: "notificações agendadas no aparelho",
      run: async () => {
        await (await getApi()).cancelAllScheduledNotificationsAsync();
      },
    },
    {
      name: "última resposta de notificação",
      run: async () => {
        (await getApi()).clearLastNotificationResponse();
      },
    },
  ];
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
