import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-11-departure-alerts.sql",
    import.meta.url,
  ),
  "utf8",
);

const schema = readFileSync(
  new URL("../drizzle/schema.ts", import.meta.url),
  "utf8",
);

describe("migration manual — aviso de hora de sair", () => {
  it("é aditiva e não apaga nada", () => {
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN|DATABASE)\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
    const updates =
      migration.match(/\bUPDATE\s+(?!CURRENT_TIMESTAMP\b)\w+/gi) ?? [];
    expect(updates).toEqual([]);
  });

  it("é rerodável e falha fechado em estado parcial", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS");
    expect(migration).toContain("__departure_partial_schema__");
    expect(migration).toContain("__departure_foundation_missing__");
    expect(migration).toContain("__departure_column_contract_mismatch__");
    expect(migration).toContain("__departure_key_contract_mismatch__");
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
   * Opt-in explícito. Conveniência que ninguém pediu vira ruído, e ruído em
   * app de plantão treina o médico a ignorar notificação.
   */
  it("o aviso nasce desligado", () => {
    expect(migration).toContain("enabled TINYINT(1) NOT NULL DEFAULT 0");
  });

  /**
   * O sistema não pergunta nada ao médico: nem folga de chegada, nem tempo de
   * trajeto assumido. Se essas colunas voltarem, voltou a pergunta.
   */
  it("não existe coluna de folga nem de tempo chutado", () => {
    expect(migration).not.toContain("arrival_margin_minutes");
    expect(migration).not.toContain("fallback_travel_minutes");
    expect(migration).not.toContain("desired_arrival_at");
    expect(migration).not.toContain("'FALLBACK'");
  });

  /**
   * O horário do aviso é fixo e não depende de cálculo nenhum — por isso a
   * coluna é NOT NULL enquanto todas as de estimativa são opcionais.
   */
  it("o horário do aviso é obrigatório; a estimativa, não", () => {
    expect(migration).toContain("notice_at TIMESTAMP NOT NULL");
    expect(migration).toContain("estimated_duration_seconds INT NULL");
    expect(migration).toContain("depart_at TIMESTAMP NULL");
  });

  it("o banco recusa plano ENVIADO sem carimbo de envio", () => {
    expect(migration).toContain("chk_departure_plan_sent");
    expect(migration).toContain("(status <> 'SENT') OR (sent_at IS NOT NULL)");
  });

  /**
   * Horário de saída e duração andam juntos. Sem esta trava, um plano com
   * `depart_at` e duração nula renderizaria "saia até" num aviso que existe
   * justamente por não saber o trajeto.
   */
  it("o banco recusa estimativa pela metade", () => {
    expect(migration).toContain("chk_departure_plan_estimate");
    expect(migration).toContain(
      "(depart_at IS NULL AND estimated_duration_seconds IS NULL)",
    );
  });

  it("a identidade do aviso e a unicidade por alocação são do banco", () => {
    expect(migration).toContain("UNIQUE KEY uniq_departure_plan_dedup");
    expect(migration).toContain(
      "UNIQUE KEY uniq_departure_plan_assignment (user_id, assignment_id)",
    );
  });

  it("apagar a origem não apaga o plano, só desfaz o vínculo", () => {
    expect(migration).toContain(
      "FOREIGN KEY (travel_origin_id) REFERENCES user_travel_origins(id)\n    ON DELETE SET NULL",
    );
  });

  it("excluir a conta leva preferências e planos junto", () => {
    const cascades = migration.match(/ON DELETE CASCADE/g) ?? [];
    expect(cascades.length).toBeGreaterThanOrEqual(2);
  });

  /**
   * A origem residencial não pode ter cópia em claro em lugar nenhum — nem
   * desnormalizada dentro do plano, "para facilitar o cálculo".
   */
  it("o plano não guarda coordenada nem endereço", () => {
    const start = migration.indexOf(
      "CREATE TABLE IF NOT EXISTS departure_plans",
    );
    const definition = migration.slice(
      start,
      migration.indexOf("ENGINE=", start),
    );
    expect(definition).not.toMatch(/\blatitude\b/);
    expect(definition).not.toMatch(/\blongitude\b/);
    expect(definition).not.toMatch(/\baddress\b/);
    expect(definition).not.toMatch(/\bplace_id\b/);
  });
});

describe("schema Drizzle e migration convergem", () => {
  it("toda constraint da migration está declarada no schema", () => {
    const declared = [
      ...migration.matchAll(/CONSTRAINT\s+(chk_[a-z0-9_]+|fk_[a-z0-9_]+)/gi),
      ...migration.matchAll(/UNIQUE KEY\s+(uniq_[a-z0-9_]+)/gi),
    ].map((match) => match[1]);
    const scoped = declared.filter((name) => /departure/.test(name));
    expect(scoped.length).toBeGreaterThanOrEqual(9);
    for (const name of scoped) {
      expect(schema, `schema declara ${name}`).toContain(`"${name}"`);
    }
  });

  it("as colunas do plano existem nos dois lados", () => {
    for (const column of [
      "notice_at",
      "estimated_duration_seconds",
      "estimate_quality",
      "depart_at",
      "next_recompute_at",
      "shift_signature",
      "origin_signature",
      "weather_summary",
      "dedup_key",
    ]) {
      expect(schema, `schema declara ${column}`).toContain(`"${column}"`);
      expect(migration, `migration cria ${column}`).toContain(column);
    }
  });

  it("o schema aponta qual migration cria estas tabelas", () => {
    const references = schema.match(/2026-09-11-departure-alerts\.sql/g) ?? [];
    expect(references.length).toBeGreaterThanOrEqual(2);
  });
});
