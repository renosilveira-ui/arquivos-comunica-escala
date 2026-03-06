// lib/_core/manus-runtime.ts — Stub para compatibilidade com template Manus
// Fora do Manus, essas funções são no-ops seguros.
import type { Metrics } from "react-native-safe-area-context";

/**
 * No template Manus original, isso injeta cookies de sessão do container pai.
 * Fora do Manus, é um no-op.
 */
export function initManusRuntime(): void {
  // no-op — app roda standalone
}

/**
 * No Manus, recebe atualizações de safe area do container.
 * Fora do Manus, retorna um unsubscribe vazio.
 */
export function subscribeSafeAreaInsets(
  _callback: (metrics: Metrics) => void,
): () => void {
  return () => {};
}
