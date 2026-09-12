import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-12-audit-trail-action-enum.sql",
    import.meta.url,
  ),
  "utf8",
);

const schema = readFileSync(
  new URL("../drizzle/schema.ts", import.meta.url),
  "utf8",
);

const REQUIRED = [
  "CESSAO_OFFERED",
  "CESSAO_ACCEPTED",
  "CESSAO_REJECTED",
  "CESSAO_APPROVED_BY_OWNER",
  "CESSAO_CANCELLED",
  "SWAP_APPROVED_BY_OWNER",
  "TRANSFER_APPROVED_BY_OWNER",
] as const;

function schemaActionValues(): string[] {
  const blocks = [
    ...schema.matchAll(
      /action: mysqlEnum\("action", \[(.*?)\]\)\.notNull\(\)/gs,
    ),
  ].map((m) => m[1]);
  const block = blocks.find((b) => b.includes("SHIFT_CREATED"));
  if (!block) throw new Error("bloco do enum de audit_trail não encontrado");
  return [...block.matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
}

function migrationEnumValues(): string[] {
  const m = migration.match(/MODIFY COLUMN action ENUM\((.*?)\) NOT NULL;/s);
  if (!m) throw new Error("MODIFY COLUMN não encontrado");
  return [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
}

/**
 * O banco real ficou meses sem sete ações que o código grava. A lista da
 * migração é a do schema, na ordem do schema — qualquer divergência entre
 * os dois é exatamente o tipo de drift que este arquivo existe para fechar.
 */
describe("migration manual — enum de ações da auditoria", () => {
  it("a lista é a do schema Drizzle, na mesma ordem", () => {
    expect(migrationEnumValues()).toEqual(schemaActionValues());
  });

  it("traz os sete valores que faltavam no banco real", () => {
    const values = migrationEnumValues();
    for (const value of REQUIRED) expect(values).toContain(value);
  });

  it("só aspas simples: o banco real roda com ANSI_QUOTES", () => {
    const statements = migration
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(statements).not.toContain('"');
  });

  it("não apaga nada e falha fechado em três guardas", () => {
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN|DATABASE)\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
    const statements = migration
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(statements.match(/SELECT 1 FROM `__[a-z0-9_]+__`/g)).toHaveLength(
      3,
    );
    expect(migration).toContain("__audit_trail_action_enum_missing__");
    expect(migration).toContain("__audit_trail_action_enum_unknown_value__");
    expect(migration).toContain(
      "__audit_trail_action_enum_contract_mismatch__",
    );
  });

  it("o manifesto lido do catálogo cobre todos os valores do schema", () => {
    for (const value of schemaActionValues()) {
      expect(migration).toContain(`REPLACE(@ate_rest, '''${value}''', '')`);
    }
  });
});
