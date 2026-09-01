import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-01-institution-readiness-fence-v2-sector-service-specialties.sql",
    import.meta.url,
  ),
  "utf8",
);

function triggerBlock(name: string): string {
  const start = migration.indexOf(`CREATE TRIGGER ${name}`);
  const next = migration.indexOf("CREATE TRIGGER ", start + 1);
  return migration.slice(start, next === -1 ? undefined : next);
}

describe("migration V2 da fence para especialidades assistenciais", () => {
  it("é aditiva e preserva o singleton V1", () => {
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS institution_readiness_fence_extension_installations",
    );
    expect(migration).toContain(
      "base_installation_id TINYINT UNSIGNED NOT NULL",
    );
    expect(migration).toContain("base_coverage_version VARCHAR(64) NOT NULL");
    expect(migration).toContain("base_coverage_hash CHAR(64) NOT NULL");
    expect(migration).toContain(
      "fk_readiness_fence_extension_base_installation",
    );
    expect(migration).not.toMatch(
      /(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+institution_readiness_fence_installations\b/i,
    );
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|TRIGGER)\b/i);
    expect(migration).not.toMatch(/CREATE\s+OR\s+REPLACE\s+(?:TABLE|TRIGGER)/i);
  });

  it("instala exatamente os três observadores V2 da relação N:N", () => {
    const expected = [
      ["trg_readiness_fence_sector_service_specialties_ai", "INSERT"],
      ["trg_readiness_fence_sector_service_specialties_au", "UPDATE"],
      ["trg_readiness_fence_sector_service_specialties_ad", "DELETE"],
    ] as const;
    expect(migration.match(/-- @idempotent-trigger/g) ?? []).toHaveLength(3);

    for (const [name, event] of expected) {
      const block = triggerBlock(name);
      expect(block).toContain(`AFTER ${event} ON sector_service_specialties`);
      expect(block).toContain("ON DUPLICATE KEY UPDATE");
      expect(block).toContain("revision = revision + 1");
      expect(block).not.toMatch(/\bBEGIN\b|\bEND\b/i);
    }
  });

  it("invalida o tenant declarado e as rotas canônicas para resistir a dados corrompidos", () => {
    const insertBlock = triggerBlock(
      "trg_readiness_fence_sector_service_specialties_ai",
    );
    const updateBlock = triggerBlock(
      "trg_readiness_fence_sector_service_specialties_au",
    );
    const deleteBlock = triggerBlock(
      "trg_readiness_fence_sector_service_specialties_ad",
    );

    for (const block of [insertBlock, deleteBlock]) {
      expect(block).toContain("FROM hospitals AS hospital");
      expect(block).toContain("FROM sectors AS sector");
      expect(block).toContain("UNION");
    }
    expect(insertBlock).toContain("NEW.institution_id");
    expect(deleteBlock).toContain("OLD.institution_id");
    for (const field of [
      "institution_id",
      "hospital_id",
      "sector_id",
      "medical_specialty_id",
    ]) {
      expect(updateBlock).toContain(`OLD.${field}`);
      expect(updateBlock).toContain(`NEW.${field}`);
    }
    expect(updateBlock).toContain("old_hospital.institution_id");
    expect(updateBlock).toContain("new_hospital.institution_id");
    expect(updateBlock).toContain("old_sector.institution_id");
    expect(updateBlock).toContain("new_sector.institution_id");
  });

  it("trata a relação como metadado presente sem usar atividade do catálogo", () => {
    const updateBlock = triggerBlock(
      "trg_readiness_fence_sector_service_specialties_au",
    );
    expect(updateBlock).not.toContain("created_at");
    expect(migration).not.toMatch(
      /CREATE\s+TRIGGER[\s\S]*?ON\s+medical_specialties\b/i,
    );
    expect(migration).not.toMatch(/medical_specialties\.(?:active|is_active)/i);
    expect(migration).not.toMatch(/NEW\.(?:active|is_active)/i);
    expect(migration).not.toMatch(/OLD\.(?:active|is_active)/i);
  });
});
