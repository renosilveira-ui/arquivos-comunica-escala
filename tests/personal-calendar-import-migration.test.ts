import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-12-personal-calendar-google-import.sql",
    import.meta.url,
  ),
  "utf8",
);

const schema = readFileSync(
  new URL("../drizzle/schema.ts", import.meta.url),
  "utf8",
);

describe("migration manual — importação do Google para a agenda", () => {
  it("é aditiva e não apaga nada", () => {
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN|DATABASE)\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
    const updates =
      migration.match(/\bUPDATE\s+(?!CURRENT_TIMESTAMP\b)\w+/gi) ?? [];
    expect(updates).toEqual([]);
  });

  /**
   * A fundação da agenda confere um hash estrutural das suas cinco tabelas
   * toda vez que roda. Alterar `personal_calendar_items` aqui faria aquela
   * migração passar a recusar — por isso esta só CRIA tabelas ao lado.
   */
  it("não altera as tabelas da fundação da agenda", () => {
    expect(migration).not.toMatch(/ALTER\s+TABLE\s+personal_calendar_items\b/i);
    expect(migration).not.toMatch(
      /ALTER\s+TABLE\s+personal_calendar_(alert_rules|recurrences|occurrences|occurrence_exceptions)\b/i,
    );
  });

  it("é rerodável e falha fechado em estado parcial", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS");
    expect(migration).toContain("__personal_calendar_import_partial_schema__");
    expect(migration).toContain(
      "__personal_calendar_import_foundation_missing__",
    );
    expect(migration).toContain(
      "__personal_calendar_import_column_contract_mismatch__",
    );
    expect(migration).toContain(
      "__personal_calendar_import_key_contract_mismatch__",
    );
  });

  it("o aborto identifica a guarda, em vez de dizer só que falhou", () => {
    const statements = migration
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(statements).not.toContain("JSON_EXTRACT");
    expect(statements.match(/SELECT 1 FROM `__[a-z0-9_]+__`/g)).toHaveLength(4);
  });

  /**
   * Um evento do Google origina no máximo um compromisso por conta, e um
   * compromisso tem no máximo uma origem. Sem as duas chaves, um cursor
   * expirado (leitura completa) duplicaria a agenda inteira.
   */
  it("a identidade do evento e a do item são do banco", () => {
    expect(migration).toContain(
      "UNIQUE KEY uniq_pc_external_link_event (owner_user_id, provider, external_calendar_id, external_event_id)",
    );
    expect(migration).toContain(
      "UNIQUE KEY uniq_pc_external_link_item (item_id)",
    );
    expect(migration).toContain(
      "UNIQUE KEY uniq_pc_import_cursor (owner_user_id, provider, external_calendar_id)",
    );
  });

  it("apagar o compromisso ou a conta leva o vínculo junto", () => {
    expect(migration).toContain(
      "FOREIGN KEY (item_id) REFERENCES personal_calendar_items(id) ON DELETE CASCADE",
    );
    const cascades = migration.match(/ON DELETE CASCADE/g) ?? [];
    expect(cascades.length).toBeGreaterThanOrEqual(3);
  });

  it("só InnoDB", () => {
    for (const match of migration.matchAll(/(?<![\w@])ENGINE\s*=\s*(\w+)/gi)) {
      expect(match[1].toUpperCase()).toBe("INNODB");
    }
  });
});

describe("schema Drizzle e migration convergem", () => {
  it("toda constraint da migration está declarada no schema", () => {
    const declared = [
      ...migration.matchAll(/CONSTRAINT\s+(chk_[a-z0-9_]+|fk_[a-z0-9_]+)/gi),
      ...migration.matchAll(/UNIQUE KEY\s+(uniq_[a-z0-9_]+)/gi),
    ].map((match) => match[1]);
    const scoped = declared.filter((name) =>
      /pc_(external_link|import_cursor)/.test(name),
    );
    expect(scoped.length).toBeGreaterThanOrEqual(7);
    for (const name of scoped) {
      expect(schema, `schema declara ${name}`).toContain(`"${name}"`);
    }
  });

  it("as colunas existem nos dois lados", () => {
    for (const column of [
      "external_calendar_id",
      "external_event_id",
      "external_etag",
      "imported_at",
      "sync_cursor",
      "last_imported_at",
    ]) {
      expect(schema, `schema declara ${column}`).toContain(`"${column}"`);
      expect(migration, `migration cria ${column}`).toContain(column);
    }
  });

  it("o schema aponta qual migration cria estas tabelas", () => {
    expect(schema).toContain("2026-09-12-personal-calendar-google-import.sql");
  });
});
