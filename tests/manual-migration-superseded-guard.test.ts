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

/**
 * O que o operador lê quando uma migração morre no meio.
 *
 * O ledger continua registrando só sucesso — um ledger que registra
 * tentativa é um ledger que mente. Mas DDL no MySQL faz commit implícito:
 * um arquivo com vários passos que falha no meio deixa os anteriores
 * aplicados e nada no ledger. Antes, quem rodava via só um stack trace e
 * não tinha como saber que o banco podia estar a meio caminho.
 *
 * Achado do segundo parecer de bancos (M5), reparado sem mexer na semântica
 * do ledger.
 */
describe("falha de migração avisa o que ficou para trás", () => {
  const fonte = readFileSync(
    new URL("../scripts/apply-manual-migration.ts", import.meta.url),
    "utf8",
  );

  it("o ledger continua gravando só depois do sucesso", () => {
    const corpo = fonte.slice(fonte.indexOf("export async function applyManualMigration"));
    const posQuery = corpo.indexOf("await connection.query(sql)");
    const posLedger = corpo.indexOf("recordManualMigration(connection");
    expect(posQuery).toBeGreaterThan(-1);
    expect(posLedger).toBeGreaterThan(posQuery);
  });

  it("a falha explica o estado do banco e o caminho de saída", () => {
    expect(fonte).toContain("MIGRAÇÃO FALHOU NO MEIO DO CAMINHO");
    // Precisa dizer que o banco pode estar parcialmente alterado.
    expect(fonte).toMatch(/parcialmente alterado/);
    // E que o ledger não registrou nada, para ninguém procurar lá.
    expect(fonte).toMatch(/NADA foi gravado no ledger/);
    // E o que fazer: rodar de novo é seguro, porque são rerodáveis.
    expect(fonte).toMatch(/rerod[aá]ve/i);
    expect(fonte).toMatch(/schema:drift/);
  });

  it("o erro original continua subindo, não é engolido", () => {
    const trecho = fonte.slice(
      fonte.indexOf("MIGRAÇÃO FALHOU NO MEIO DO CAMINHO"),
    );
    expect(trecho).toMatch(/throw error;/);
  });
});
