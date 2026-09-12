import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  stopConfirmationCron,
  tick,
} from "../server/cron/shift-confirmation-dispatcher";

const dispatcherSource = readFileSync(
  new URL("../server/cron/shift-confirmation-dispatcher.ts", import.meta.url),
  "utf8",
);
const bootSource = readFileSync(
  new URL("../server/_core/index.ts", import.meta.url),
  "utf8",
);

/**
 * O SIGTERM do deploy chega a qualquer instante. O tick de confirmação
 * escala pendências em várias etapas (CAS do recheck, outbox gerencial);
 * cortá-lo no meio deixava uma confirmação sem timer e sem aviso. O shutdown
 * precisa esperar o tick terminar, como já espera os outros workers.
 */
describe("shutdown drena o tick de confirmação", () => {
  it("stopConfirmationCron devolve o tick em andamento", async () => {
    // Um tick de verdade contra o banco de testes (vazio): rápido, mas não
    // instantâneo — o suficiente para provar a ordem.
    const inflight = tick(new Date());
    let finished = false;
    void inflight.then(() => {
      finished = true;
    });

    const drain = stopConfirmationCron();
    // A mesma promise, não um wrapper: quem espera o drain espera o tick.
    expect(drain).toBe(inflight);
    await drain;
    expect(finished).toBe(true);
  });

  it("tick concorrente recebe o tick em andamento, sem processar de novo", async () => {
    const first = tick(new Date());
    const second = tick(new Date());
    expect(second).toBe(first);
    await first;
  });

  it("sem tick em andamento, o drain resolve na hora", async () => {
    await expect(stopConfirmationCron()).resolves.toBeUndefined();
  });

  it("o boot aguarda o drain como faz com os demais workers", () => {
    const stopIndex = bootSource.indexOf("confirmationDrain = stopConfirmationCron()");
    const awaitIndex = bootSource.indexOf("await confirmationDrain");
    expect(stopIndex).toBeGreaterThan(0);
    expect(awaitIndex).toBeGreaterThan(stopIndex);
  });

  it("escalação sem gestor elegível vira evento estruturado, não texto solto", () => {
    expect(dispatcherSource).toContain('event: "confirmation_escalation_no_manager"');
    expect(dispatcherSource).not.toContain("mantém recheck:");
  });

  /**
   * A raiz da regressão da #492: `managerCount === 0` era um sinal
   * sobrecarregado. Quatro situações devolviam zero — política desligada,
   * confirmação já respondida, ausência de gestor e banco fora —, duas delas
   * normais e duas alarme. Estes testes travam a separação: cada saída tem
   * nome, e só as duas que merecem alarme estão na tabela.
   */
  it("cada desfecho da escalação tem nome próprio", () => {
    for (const outcome of [
      "NOTIFIED",
      "SUPPRESSED_BY_POLICY",
      "NO_LONGER_OPEN",
      "NO_MANAGER",
      "DB_UNAVAILABLE",
    ]) {
      expect(dispatcherSource).toContain(`"${outcome}"`);
    }
    // Nenhum caminho devolve o resultado sem dizer qual é o desfecho.
    const returns =
      dispatcherSource.match(/return \{[^}]*managerCount:[^}]*\}/g) ?? [];
    expect(returns.length).toBeGreaterThan(0);
    for (const statement of returns) {
      expect(statement).toContain("outcome:");
    }
  });

  it("só ausência de gestor e banco fora viram alarme", () => {
    const table = dispatcherSource.slice(
      dispatcherSource.indexOf("const ESCALATION_ALARMS"),
      dispatcherSource.indexOf("export async function notifyManagers"),
    );
    expect(table).toContain("NO_MANAGER");
    expect(table).toContain("DB_UNAVAILABLE");
    // Política desligada e confirmação já respondida são estado normal: se
    // entrarem na tabela, o alarme volta a tocar para quem não tem problema.
    expect(table).not.toContain("SUPPRESSED_BY_POLICY");
    expect(table).not.toContain("NO_LONGER_OPEN");
  });
});
