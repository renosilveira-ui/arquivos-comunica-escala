// lib/session-events.ts — sinal "o servidor não reconhece mais esta sessão".
//
// O cache de consultas agora sobrevive a falhas de rede (telas mantêm os
// dados quando o refetch falha). Sem este sinal, um 401 real (senha
// trocada, sessão revogada, conta excluída) ficaria mascarado pelos dados
// em cache até o app ser reiniciado. O QueryClient (app/_layout.tsx) emite
// aqui em todo erro UNAUTHORIZED do tRPC; o AuthProvider (hooks/use-auth.ts)
// revalida a sessão em /api/auth/me — que distingue "sessão inválida"
// (desloga) de "servidor fora do ar" (mantém o cache). FORBIDDEN não conta:
// é falta de permissão para UMA procedure, não sessão morta.

type Listener = () => void;

const listeners = new Set<Listener>();

/** Chamado pelo QueryClient quando uma consulta/mutação volta UNAUTHORIZED. */
export function emitSessionUnauthorized(): void {
  for (const listener of listeners) listener();
}

export function onSessionUnauthorized(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Erro do tRPC (TRPCClientError) com code UNAUTHORIZED? */
export function isUnauthorizedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const data = (error as { data?: { code?: unknown } }).data;
  return data?.code === "UNAUTHORIZED";
}
