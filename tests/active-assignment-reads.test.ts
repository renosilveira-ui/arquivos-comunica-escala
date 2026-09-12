import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Troca e remoção não apagam a alocação: marcam `is_active = 0`. Toda leitura
 * que responde "quais são os plantões desta pessoa" precisa filtrar por isso,
 * senão o médico recebe aviso, previsão ou evento de um plantão que já não é
 * dele. Esta suíte trava as leituras account-wide que já foram corrigidas
 * por esse motivo; uma regressão reprova aqui antes de chegar ao staging.
 */
const READS: { file: string; anchor: string }[] = [
  {
    file: "../server/departure-engine.ts",
    anchor: "export async function listUpcomingAssignments",
  },
  {
    file: "../server/weather-router.ts",
    anchor: "async function resolveUserLocation",
  },
];

function functionBody(source: string, anchor: string): string {
  const start = source.indexOf(anchor);
  expect(start, anchor).toBeGreaterThan(-1);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end);
}

describe("leituras account-wide de alocação filtram is_active", () => {
  for (const read of READS) {
    it(`${read.file} · ${read.anchor}`, () => {
      const source = readFileSync(new URL(read.file, import.meta.url), "utf8");
      const body = functionBody(source, read.anchor);
      expect(body).toContain(".from(shiftAssignmentsV2)");
      expect(body).toContain("eq(shiftAssignmentsV2.isActive, true)");
    });
  }
});
