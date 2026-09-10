import type { SessionEpochTicket } from "./session-epoch";

export type ScreenActionLease = Readonly<{
  userId: number;
  contextKey: string | null;
  sequence: number;
  sessionEpoch: SessionEpochTicket;
}>;

/**
 * Uma conclusão assíncrona só pode alterar a tela que iniciou a ação.
 * Identidade, contexto, sessão, sequência e montagem precisam continuar
 * iguais; qualquer transição invalida o callback antigo de forma fail-closed.
 */
export function isScreenActionLeaseCurrent(
  lease: ScreenActionLease,
  current: Readonly<{
    mounted: boolean;
    userId: number | undefined;
    contextKey: string | null;
    sequence: number;
    sessionEpochCurrent: boolean;
  }>,
): boolean {
  return (
    current.mounted &&
    current.sessionEpochCurrent &&
    current.userId === lease.userId &&
    current.contextKey === lease.contextKey &&
    current.sequence === lease.sequence
  );
}
