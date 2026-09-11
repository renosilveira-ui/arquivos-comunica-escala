import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../server/cron/shift-confirmation-dispatcher.ts", import.meta.url),
  "utf8",
);

/**
 * Em 11/09/2026 o cron de confirmação falhava a cada 60 segundos no staging,
 * havia tempo indeterminado. O log dizia só "TICK_FAILED", e as quatro etapas
 * do tick estavam encadeadas com `await`: a primeira a estourar matava as
 * três seguintes — rechecagem de 30 min, retentativa de push, fila do
 * Comunica+ e aviso de início de plantão, todos parados por causa de uma.
 *
 * E, como o tick repetia a cada minuto sem recuar, a etapa quebrada seguia
 * tomando lock: um gestor tentando se alocar num plantão recebeu
 * `ER_LOCK_DEADLOCK`.
 *
 * Estes testes leem o fonte porque o alvo é estrutural — a forma como as
 * etapas são compostas, não o resultado de uma delas.
 */
describe("o tick não deixa uma etapa derrubar as outras", () => {
  const STEPS = [
    "dispatchConfirmations",
    "processRechecks",
    "processPendingPushDeliveries",
    "processPendingDutySyncs",
    "processPendingComunicaPlusOutbox",
    "processShiftStartPushes",
  ];

  it("toda etapa passa pelo isolamento", () => {
    for (const step of STEPS) {
      expect(source, `${step} precisa rodar dentro de runStep`).toContain(
        `runStep("${step}"`,
      );
    }
  });

  /**
   * A regressão exata: `await dispatchConfirmations(now);` solto no corpo do
   * tick. Se alguém reintroduzir a chamada direta, a primeira falha volta a
   * matar o resto.
   */
  it("nenhuma etapa é chamada direto no corpo do tick", () => {
    for (const step of STEPS) {
      expect(source, `${step} não pode ser chamada direto`).not.toMatch(
        new RegExp(`await ${step}\\(now\\)`),
      );
    }
  });

  it("a falha de uma etapa é capturada com o nome dela", () => {
    expect(source).toContain("confirmation_step_failed");
    expect(source).toContain("step: name");
    expect(source).toContain("safeErrorDiagnostic(error)");
  });

  /**
   * Sem espera crescente, uma etapa permanentemente quebrada volta a bater no
   * banco a cada 60 s. Foi assim que o deadlock chegou ao usuário.
   */
  it("existe espera crescente, com teto", () => {
    expect(source).toContain("MAX_BACKOFF_MS");
    expect(source).toMatch(/skipUntilMs/);
    expect(source).toMatch(/2 \*\* \(failures - 1\)/);
  });

  it("a recuperação também aparece no log", () => {
    expect(source).toContain("confirmation_step_recovered");
  });

  /**
   * O diagnóstico não pode vazar mensagem crua do driver: o mesmo cron toca
   * escala, alocação e identidade de profissional.
   */
  it("nenhum log do cron interpola mensagem de erro", () => {
    expect(source).not.toMatch(/error\.message/);
    expect(source).not.toMatch(/String\(error\)/);
    expect(source).not.toMatch(/\$\{error\}/);
  });
});
