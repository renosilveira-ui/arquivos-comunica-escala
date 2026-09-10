export const FORGOT_PASSWORD_RATE_LIMIT_CAPACITY = 5_000;

type AttemptEntry = {
  attempts: number[];
};

/**
 * Janela deslizante por chave com TTL e descarte LRU estritamente limitado.
 *
 * Cada entrada guarda no máximo `maxAttempts` timestamps. `Map` fornece a
 * ordem LRU: uma leitura válida move a chave para o fim, e uma chave nova
 * remove a menos recente antes da inserção. A expiração é avaliada somente
 * para a chave acessada, sem varrer o cache inteiro.
 */
export class ForgotPasswordRateLimitCache {
  private readonly entries = new Map<string, AttemptEntry>();

  constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number,
    private readonly capacity: number = FORGOT_PASSWORD_RATE_LIMIT_CAPACITY,
  ) {
    if (
      !Number.isInteger(maxAttempts) ||
      maxAttempts < 1 ||
      !Number.isFinite(windowMs) ||
      windowMs <= 0 ||
      !Number.isInteger(capacity) ||
      capacity < 1
    ) {
      throw new Error("FORGOT_PASSWORD_RATE_LIMIT_CONFIG_INVALID");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  checkAndRecord(key: string, now = Date.now()): boolean {
    if (!Number.isFinite(now)) {
      throw new Error("FORGOT_PASSWORD_RATE_LIMIT_TIME_INVALID");
    }

    const current = this.entries.get(key);
    if (current) {
      const cutoff = now - this.windowMs;
      let firstRecent = 0;
      while (
        firstRecent < current.attempts.length &&
        current.attempts[firstRecent]! <= cutoff
      ) {
        firstRecent += 1;
      }
      const recent =
        firstRecent === 0
          ? current.attempts
          : current.attempts.slice(firstRecent);

      if (recent.length > 0) {
        const limited = recent.length >= this.maxAttempts;
        if (!limited) recent.push(now);
        this.touch(key, { attempts: recent });
        return limited;
      }

      this.entries.delete(key);
    }

    // Remove antes de inserir: nem transitoriamente o cache excede o teto.
    if (this.entries.size === this.capacity) {
      const leastRecentlyUsed = this.entries.keys().next().value;
      if (leastRecentlyUsed !== undefined) {
        this.entries.delete(leastRecentlyUsed);
      }
    }
    this.entries.set(key, { attempts: [now] });
    return false;
  }

  private touch(key: string, entry: AttemptEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }
}
