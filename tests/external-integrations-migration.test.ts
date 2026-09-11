import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-10-external-integrations-foundation.sql",
    import.meta.url,
  ),
  "utf8",
);

const schema = readFileSync(
  new URL("../drizzle/schema.ts", import.meta.url),
  "utf8",
);

describe("migration manual — fundação das integrações externas", () => {
  it("é aditiva: não apaga tabela, coluna nem histórico", () => {
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN|DATABASE)\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it("o único UPDATE é o backfill idempotente do fuso", () => {
    // `ON UPDATE CURRENT_TIMESTAMP` é definição de coluna, não escrita.
    const updates =
      migration.match(/\bUPDATE\s+(?!CURRENT_TIMESTAMP\b)\w+/gi) ?? [];
    expect(updates).toEqual(["UPDATE institutions"]);
    expect(migration).toContain(
      "WHERE time_zone IS NULL OR TRIM(time_zone) = ''",
    );
  });

  it("é rerodável: toda DDL confere o catálogo antes de agir", () => {
    expect(migration).toContain("INFORMATION_SCHEMA.COLUMNS");
    expect(migration).toContain("INFORMATION_SCHEMA.TABLE_CONSTRAINTS");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS");
  });

  it("falha fechado em estado parcial e em base ausente", () => {
    for (const marker of [
      "__external_integrations_partial_schema__",
      "__external_integrations_base_schema_missing__",
      "__external_integrations_column_contract_mismatch__",
      "__external_integrations_key_contract_mismatch__",
      "__external_integrations_timezone_backfill_incomplete__",
    ]) {
      expect(migration).toContain(marker);
    }
  });

  /**
   * O aborto precisa DIZER qual guarda disparou.
   *
   * `SELECT JSON_EXTRACT('MARCADOR','$')` aborta, mas o MySQL responde só
   * "Invalid JSON text" e engole o marcador: quem aplica a migration às 2h
   * da manhã descobre que falhou, não por quê. Referenciar uma tabela
   * inexistente cujo NOME é o marcador aborta igual e o catálogo ecoa o
   * nome na mensagem.
   */
  it("o aborto identifica a guarda que disparou", () => {
    // Só o idioma executável importa; o cabeçalho cita o descartado ao
    // explicar por que foi descartado.
    const statements = migration
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(statements).not.toContain("JSON_EXTRACT");
    const aborts = statements.match(/SELECT 1 FROM `__[a-z0-9_]+__`/g) ?? [];
    expect(aborts).toHaveLength(5);
  });

  it("nasce compatível com o domínio temporal legado", () => {
    expect(migration).toContain(
      "time_zone VARCHAR(64) NOT NULL DEFAULT ''America/Sao_Paulo''",
    );
  });

  it("a exclusão da conta leva credencial e origem junto", () => {
    expect(migration).toContain(
      "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
    );
    const cascades = migration.match(/ON DELETE CASCADE/g) ?? [];
    expect(cascades.length).toBeGreaterThanOrEqual(2);
  });

  it("a saída de um gestor não apaga a localização do hospital", () => {
    expect(migration).toContain(
      "fk_hospitals_location_updated_by FOREIGN KEY (location_updated_by_user_id) REFERENCES users(id) ON DELETE SET NULL",
    );
  });

  it("o banco garante as invariantes de segurança, não só o writer", () => {
    expect(migration).toContain("chk_user_external_credential_kid");
    expect(migration).toContain("chk_user_external_credential_state");
    expect(migration).toContain(
      "UNIQUE KEY uniq_user_external_credential_provider (user_id, provider)",
    );
    expect(migration).toContain(
      "default_slot TINYINT GENERATED ALWAYS AS (IF(is_default = 1, 1, NULL)) STORED",
    );
    expect(migration).toContain(
      "UNIQUE KEY uniq_user_travel_origin_default (user_id, default_slot)",
    );
  });

  it("não existe coluna em claro para segredo ou coordenada do usuário", () => {
    const travelOrigin = migration.slice(
      migration.indexOf("CREATE TABLE IF NOT EXISTS user_travel_origins"),
    );
    const definition = travelOrigin.slice(0, travelOrigin.indexOf("ENGINE="));
    expect(definition).toContain("sealed_location TEXT NOT NULL");
    expect(definition).not.toMatch(/\blatitude\b/);
    expect(definition).not.toMatch(/\blongitude\b/);
    expect(definition).not.toMatch(/\baddress\b/);
    expect(definition).not.toMatch(/\bplace_id\b/);
  });

  it("o domínio pessoal não ganhou tenant: nada de institution_id", () => {
    for (const table of ["user_external_credentials", "user_travel_origins"]) {
      const start = migration.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`);
      const definition = migration.slice(
        start,
        migration.indexOf("ENGINE=", start),
      );
      expect(definition).not.toContain("institution_id");
      expect(definition).not.toContain("hospital_id");
      expect(definition).not.toContain("professional_id");
    }
  });
});

describe("schema Drizzle e migration descrevem a mesma estrutura", () => {
  it("as duas tabelas novas existem no schema", () => {
    expect(schema).toContain('mysqlTable(\n  "user_external_credentials"');
    expect(schema).toContain('mysqlTable(\n  "user_travel_origins"');
  });

  it("as colunas declaradas no schema estão na migration", () => {
    for (const column of [
      "sealed_refresh_token",
      "sealed_account_label",
      "encryption_kid",
      "external_calendar_id",
      "sync_cursor",
      "last_failure_reason",
      "consecutive_failure_count",
      "consent_granted_at",
      "consent_version",
      "google_place_id",
      "location_updated_by_user_id",
    ]) {
      expect(schema, `schema declara ${column}`).toContain(`"${column}"`);
      expect(migration, `migration cria ${column}`).toContain(column);
    }
  });

  /**
   * A CI monta o banco com `drizzle-kit push` a partir do schema; o staging
   * recebe a migration. Uma constraint declarada em só um dos dois faz os
   * dois ambientes divergirem exatamente nas invariantes de segurança — e o
   * teste que passa na CI deixa de provar o que roda em produção.
   */
  it("toda constraint da migration também é declarada no schema", () => {
    const declared = [
      ...migration.matchAll(/CONSTRAINT\s+(chk_[a-z0-9_]+|fk_[a-z0-9_]+)/gi),
      ...migration.matchAll(/UNIQUE KEY\s+(uniq_[a-z0-9_]+)/gi),
    ].map((match) => match[1]);

    const scoped = declared.filter((name) =>
      /user_external_credential|user_travel_origin|hospitals_location/.test(
        name,
      ),
    );
    expect(scoped.length).toBeGreaterThanOrEqual(8);
    for (const name of scoped) {
      expect(schema, `schema declara ${name}`).toContain(`"${name}"`);
    }
  });

  it("o schema documenta qual migration cria estas tabelas", () => {
    const references =
      schema.match(/2026-09-10-external-integrations-foundation\.sql/g) ?? [];
    expect(references.length).toBeGreaterThanOrEqual(2);
  });
});
