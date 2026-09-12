import { and, isNotNull, lt, or } from "drizzle-orm";

import {
  googleOauthStates,
  passwordResets,
  ssoLaunchCodes,
  ssoUsedTokens,
} from "../../drizzle/schema";
import { logger } from "../_core/logger";
import { getDb } from "../db";

/**
 * Varredura de registros efêmeros vencidos.
 *
 * Parecer de bancos (12/09/2026): `password_resets`, `sso_used_tokens`,
 * `sso_launch_codes` e `google_oauth_states` só cresciam — todos os
 * registros vencidos, nenhum varrido. Volumes pequenos hoje, crescimento
 * sem teto. Cada fluxo apaga o SEU registro quando o consome; o que ninguém
 * apagava era o que venceu sem ser consumido.
 *
 * ## O que sai, e quando
 *
 * Só o que já venceu há mais de `GRACE_MS` (24 h). A carência importa por
 * dois motivos: um token usado no limite ainda pode estar numa investigação
 * de suporte ("recebi o e-mail e não funcionou"), e `sso_used_tokens` é a
 * proteção contra replay — um JWT vencido é rejeitado pelo `exp` de qualquer
 * jeito, mas ninguém precisa apagar o registro no minuto em que vence.
 *
 * ## O que NÃO sai
 *
 * Nada com validade futura. Nada consumido recentemente (um `used_at` de
 * hoje ainda serve para auditoria). Nada de outra tabela: esta varredura
 * conhece só estas quatro, e cada uma tem o próprio índice em `expires_at`
 * (ou o índice de varredura da tabela).
 *
 * Lotes de 500 e no máximo 4 lotes por tabela por tick: um banco com anos de
 * acúmulo é limpo em várias horas, sem uma transação longa.
 */

export const EPHEMERAL_RETENTION_INTERVAL_MS = 60 * 60_000;
export const EPHEMERAL_RETENTION_GRACE_MS = 24 * 60 * 60_000;
export const EPHEMERAL_RETENTION_BATCH_SIZE = 500;
export const EPHEMERAL_RETENTION_MAX_BATCHES = 4;

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export type EphemeralSweepSummary = {
  passwordResets: number;
  ssoUsedTokens: number;
  ssoLaunchCodes: number;
  googleOauthStates: number;
  capped: boolean;
};

let intervalId: ReturnType<typeof setInterval> | null = null;
let activeTick: Promise<void> | null = null;
let acceptingTicks = false;

async function deleteInBatches(
  run: (limit: number) => Promise<number>,
): Promise<{ deleted: number; capped: boolean }> {
  let deleted = 0;
  for (let batch = 0; batch < EPHEMERAL_RETENTION_MAX_BATCHES; batch += 1) {
    const affected = await run(EPHEMERAL_RETENTION_BATCH_SIZE);
    deleted += affected;
    if (affected < EPHEMERAL_RETENTION_BATCH_SIZE) {
      return { deleted, capped: false };
    }
  }
  return { deleted, capped: true };
}

function affectedRows(result: unknown): number {
  const head = Array.isArray(result) ? result[0] : result;
  const rows = (head as { affectedRows?: unknown } | undefined)?.affectedRows;
  return typeof rows === "number" ? rows : 0;
}

export async function sweepEphemeralRecords(input: {
  db: Db;
  now?: Date;
}): Promise<EphemeralSweepSummary> {
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - EPHEMERAL_RETENTION_GRACE_MS);
  const summary: EphemeralSweepSummary = {
    passwordResets: 0,
    ssoUsedTokens: 0,
    ssoLaunchCodes: 0,
    googleOauthStates: 0,
    capped: false,
  };

  // Cada tabela no seu próprio try: uma falha (tabela ausente numa instalação
  // antiga, lock) não impede as outras.
  const steps: {
    key: keyof Omit<EphemeralSweepSummary, "capped">;
    run: (limit: number) => Promise<number>;
  }[] = [
    {
      key: "passwordResets",
      run: async (limit) =>
        affectedRows(
          await input.db
            .delete(passwordResets)
            .where(
              or(
                lt(passwordResets.expiresAt, cutoff),
                and(
                  isNotNull(passwordResets.usedAt),
                  lt(passwordResets.usedAt, cutoff),
                ),
              ),
            )
            .limit(limit),
        ),
    },
    {
      key: "ssoUsedTokens",
      run: async (limit) =>
        affectedRows(
          await input.db
            .delete(ssoUsedTokens)
            .where(lt(ssoUsedTokens.expiresAt, cutoff))
            .limit(limit),
        ),
    },
    {
      key: "ssoLaunchCodes",
      run: async (limit) =>
        affectedRows(
          await input.db
            .delete(ssoLaunchCodes)
            .where(lt(ssoLaunchCodes.expiresAt, cutoff))
            .limit(limit),
        ),
    },
    {
      key: "googleOauthStates",
      run: async (limit) =>
        affectedRows(
          await input.db
            .delete(googleOauthStates)
            .where(lt(googleOauthStates.expiresAt, cutoff))
            .limit(limit),
        ),
    },
  ];

  for (const step of steps) {
    try {
      const result = await deleteInBatches(step.run);
      summary[step.key] = result.deleted;
      summary.capped = summary.capped || result.capped;
    } catch (error) {
      logger.warn(
        {
          event: "ephemeral_retention_step_failed",
          step: step.key,
          errorName: error instanceof Error ? error.name : "unknown",
        },
        "ephemeral retention step failed",
      );
    }
  }
  return summary;
}

export async function tickEphemeralRetention(now = new Date()): Promise<void> {
  if (activeTick) return activeTick;
  let tick!: Promise<void>;
  tick = (async () => {
    try {
      const db = await getDb();
      if (!db) return;
      const summary = await sweepEphemeralRecords({ db, now });
      const total =
        summary.passwordResets +
        summary.ssoUsedTokens +
        summary.ssoLaunchCodes +
        summary.googleOauthStates;
      if (total > 0 || summary.capped) {
        logger.info(
          { event: "ephemeral_retention_tick", ...summary },
          "ephemeral retention tick",
        );
      }
    } catch (error) {
      logger.warn(
        {
          event: "ephemeral_retention_tick_failed",
          errorName: error instanceof Error ? error.name : "unknown",
        },
        "ephemeral retention tick failed",
      );
    } finally {
      if (activeTick === tick) activeTick = null;
    }
  })();
  activeTick = tick;
  await tick;
}

export function startEphemeralRetentionCron(): void {
  if (intervalId) return;
  acceptingTicks = true;
  void tickEphemeralRetention();
  intervalId = setInterval(() => {
    if (acceptingTicks) void tickEphemeralRetention();
  }, EPHEMERAL_RETENTION_INTERVAL_MS);
}

export function stopEphemeralRetentionCron(): Promise<void> {
  acceptingTicks = false;
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  return activeTick ?? Promise.resolve();
}

