let activeWorkflowSignal: AbortSignal | null = null;

export function getActiveWebSessionWorkflowSignal(): AbortSignal | null {
  return activeWorkflowSignal;
}

/**
 * Cerca awaits locais que não aceitam AbortSignal (AsyncStorage/SecureStore).
 * A operação física pode terminar depois, mas suas tails/generations continuam
 * serializadas; o caller deixa de reter o Web Lock assim que o workflow expira.
 */
export function waitForActiveWebSessionWorkflow<T>(
  operation: Promise<T>,
  signal = activeWorkflowSignal,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ?? new Error("Workflow de sessão web cancelado"),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new Error("Workflow de sessão web cancelado"));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function enterWebSessionWorkflow(
  signal: AbortSignal,
): () => void {
  const previousSignal = activeWorkflowSignal;
  activeWorkflowSignal = signal;
  return () => {
    if (activeWorkflowSignal === signal) {
      activeWorkflowSignal = previousSignal;
    }
  };
}
