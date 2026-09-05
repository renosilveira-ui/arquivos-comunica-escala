/**
 * CLI one-shot do dispatcher de confirmação de plantão.
 *
 * Não importa o servidor HTTP. Não inicia o loop in-process do dispatcher.
 *
 * Uso local:
 *   pnpm confirmation:tick
 *
 * Artefato de produção (Render Cron — EXTERNAL_INFRA_ACTION_REQUIRED):
 *   node dist/run-confirmation-tick.mjs
 *
 * Ver docs/operations/confirmation-coverage.md.
 */
import "dotenv/config";
import {
  isConfirmationTickCliPath,
  runConfirmationTickCli,
} from "../server/cron/confirmation-tick-cli";

if (isConfirmationTickCliPath(process.argv[1])) {
  runConfirmationTickCli().then(
    () => process.exit(0),
    (err: unknown) => {
      console.error(
        JSON.stringify({
          msg: "confirmation tick failed",
          err: err instanceof Error ? err.message : String(err),
        }),
      );
      process.exit(1);
    },
  );
}
