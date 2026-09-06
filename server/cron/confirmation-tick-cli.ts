// server/cron/confirmation-tick-cli.ts
//
// Entrada one-shot do dispatcher de confirmação. Não sobe HTTP e não
// inicia o loop in-process: um tick e o processo pode sair.
//
// Isto NÃO fecha o gap 24/7 no plano Render free. O intervalo in-process
// some quando a instância dorme. Fechar o finding é
// EXTERNAL_INFRA_ACTION_REQUIRED — ver docs/operations/confirmation-coverage.md.

import { closeDb, getDb } from "../db";
import { tick } from "./shift-confirmation-dispatcher";

export function isConfirmationTickCliPath(argv1: string | undefined): boolean {
  if (!argv1) return false;
  return /(?:^|\/)run-confirmation-tick(?:\.[cm]?js|\.ts)?$/.test(
    argv1.replaceAll("\\", "/"),
  );
}

export function requireConfirmationTickDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const url = env.DATABASE_URL?.trim() ?? "";
  if (!url) {
    throw new Error(
      "DATABASE_URL é obrigatória para o tick one-shot de confirmação.",
    );
  }
  return url;
}

export async function runConfirmationTickOnce(
  now: Date = new Date(),
): Promise<void> {
  requireConfirmationTickDatabaseUrl();
  const db = await getDb();
  if (!db) {
    throw new Error("Tick de confirmação abortado: banco indisponível.");
  }
  await tick(now);
}

export async function runConfirmationTickCli(): Promise<void> {
  const started = Date.now();
  console.log(
    JSON.stringify({
      msg: "confirmation tick start",
      at: new Date().toISOString(),
    }),
  );
  try {
    await runConfirmationTickOnce();
    console.log(
      JSON.stringify({
        msg: "confirmation tick ok",
        durationMs: Date.now() - started,
      }),
    );
  } finally {
    // closeDb após tick ok é teardown do processo one-shot. O trabalho já
    // está commitado e o próximo Cron abre pool novo. Falha aqui é
    // harmless teardown: loga e o CLI permanece exit 0 (retry do tick
    // seria ruído idempotente, não recuperação). Falha do tick() sobe.
    try {
      await closeDb();
    } catch (err) {
      console.error(
        JSON.stringify({
          msg: "confirmation tick closeDb failed",
          err: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
}
