export type SessionEpochTicket = Readonly<{ generation: number }>;

/**
 * CAS temporal da sessão do app. Toda operação assíncrona captura um ticket;
 * login, logout e encerramento avançam a geração antes do primeiro await.
 * Respostas de uma identidade anterior deixam de ter autoridade para gravar.
 */
export class SessionEpoch {
  private generation = 0;

  capture(): SessionEpochTicket {
    return { generation: this.generation };
  }

  beginTransition(): SessionEpochTicket {
    this.generation += 1;
    return this.capture();
  }

  beginTransitionIfCurrent(
    expected: SessionEpochTicket,
  ): SessionEpochTicket | null {
    if (!this.isCurrent(expected)) return null;
    return this.beginTransition();
  }

  isCurrent(ticket: SessionEpochTicket): boolean {
    return ticket.generation === this.generation;
  }

  async runIfCurrent(
    ticket: SessionEpochTicket,
    operation: () => void | Promise<void>,
  ): Promise<boolean> {
    if (!this.isCurrent(ticket)) return false;
    await operation();
    return this.isCurrent(ticket);
  }
}

export const appSessionEpoch = new SessionEpoch();
