/**
 * Pausa de um worker quando as tabelas dele ainda não existem.
 *
 * A migração manual é aplicada FORA do deploy. Entre o merge e a aplicação,
 * um worker consultaria tabelas ausentes a cada tick, enchendo o log de ruído
 * que esconde erro de verdade. A versão anterior dormia até o próximo boot —
 * e a migração aplicada depois do deploy deixava o worker parado sem que
 * ninguém percebesse. Agora ele pausa por um intervalo e tenta de novo.
 *
 * Um objeto por worker: cada um tem o seu schema e a sua pausa.
 */
export const SCHEMA_REPROBE_INTERVAL_MS = 10 * 60_000;

export function isMissingSchema(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { code?: unknown }).code === "ER_NO_SUCH_TABLE";
}

export class SchemaDormancy {
  private untilMs = 0;

  isDormant(now: Date): boolean {
    return now.getTime() < this.untilMs;
  }

  /** Registra a pausa e devolve os segundos até a próxima tentativa, para o log. */
  markMissing(now: Date): number {
    this.untilMs = now.getTime() + SCHEMA_REPROBE_INTERVAL_MS;
    return SCHEMA_REPROBE_INTERVAL_MS / 1000;
  }

  /** Somente para teste. */
  reset(): void {
    this.untilMs = 0;
  }
}
