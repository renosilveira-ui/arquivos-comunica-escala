import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { assertNotSuperseded } from "../scripts/apply-manual-migration";

const v1 = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-08-24-push-token-provenance.sql",
    import.meta.url,
  ),
  "utf8",
);
const v2 = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-12-push-token-provenance-v2.sql",
    import.meta.url,
  ),
  "utf8",
);

/**
 * Uma migração substituída fica no repositório como histórico, mas não pode
 * ser aplicada por engano. A diretiva `-- @superseded <arquivo>` no topo é o
 * que o executor lê; este teste prende o contrato nos dois lados.
 */
describe("executor genérico — migração substituída", () => {
  it("a v1 de push_tokens declara a substituta e é recusada", () => {
    expect(() => assertNotSuperseded(v1)).toThrow(
      "MANUAL_MIGRATION_SUPERSEDED_BY:2026-09-12-push-token-provenance-v2.sql",
    );
  });

  it("a v2 não é substituída e passa", () => {
    expect(() => assertNotSuperseded(v2)).not.toThrow();
  });

  it("a diretiva só vale como comentário de linha no topo, não em prosa", () => {
    expect(() =>
      assertNotSuperseded("-- fala de @superseded sem ser diretiva\nSELECT 1;"),
    ).not.toThrow();
    expect(() => assertNotSuperseded("--@superseded outro.sql\nSELECT 1;")).toThrow(
      /SUPERSEDED_BY:outro\.sql/,
    );
  });

  it("a v2 só usa aspas simples e é guardada em cada passo", () => {
    const statements = v2
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(statements).not.toContain('"');
    expect((statements.match(/PREPARE stmt FROM @ddl;/g) ?? []).length).toBe(6);
    expect(v2).toContain("__push_tokens_shape_unexpected__");
    expect(v2).toContain("__push_tokens_contract_mismatch__");
  });
});
