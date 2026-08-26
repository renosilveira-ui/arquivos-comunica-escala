import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MEDICAL_SPECIALTIES } from "../lib/medical-specialties";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-08-25-schedule-contexts-medical-specialties.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration manual de contextos e especialidades", () => {
  it("semeia exatamente o mesmo catálogo CFM publicado em TypeScript", () => {
    const seedRows = Array.from(
      migration.matchAll(
        /^\s*\('([A-Z0-9_]+)', '([^']+)', 'CFM_2380_2024', TRUE, (\d+)\)[,;]?$/gm,
      ),
      ([, code, name, sortOrder]) => ({
        code,
        name,
        sourceVersion: "CFM_2380_2024",
        active: true,
        sortOrder: Number(sortOrder),
      }),
    );

    expect(seedRows).toEqual(
      MEDICAL_SPECIALTIES.map(
        ({ code, name, sourceVersion, active, sortOrder }) => ({
          code,
          name,
          sourceVersion,
          active,
          sortOrder,
        }),
      ),
    );
  });

  it("é aditiva, rerodável e guarda alterações em tabelas existentes", () => {
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS medical_specialties",
    );
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS schedule_contexts");
    expect(migration).toContain("ON DUPLICATE KEY UPDATE");
    expect(migration).toContain("INFORMATION_SCHEMA.COLUMNS");
    expect(migration).toContain("INFORMATION_SCHEMA.STATISTICS");
    expect(migration).toContain("INFORMATION_SCHEMA.TABLE_CONSTRAINTS");
    expect(migration).toContain("COLUMN_NAME = 'medical_specialty_id'");
    expect(migration).toContain("COLUMN_NAME = 'operational_profile_code'");
    expect(migration).toContain("COLUMN_NAME = 'schedule_context_id'");
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it("impõe política de admissão e unicidade lógica por setor", () => {
    expect(migration).toContain("uniq_schedule_context_specialty");
    expect(migration).toContain("uniq_schedule_context_operational_profile");
    expect(migration).toContain("admission_policy");
    expect(migration).toContain("ALL_CFM_SPECIALTIES");
    expect(migration).toContain("RESIDENTE_ANESTESIOLOGIA");
    expect(migration).toContain(
      "(medical_specialty_id IS NOT NULL AND operational_profile_code IS NULL)",
    );
    expect(migration).toContain(
      "(medical_specialty_id IS NULL AND operational_profile_code IS NOT NULL)",
    );
    expect(migration).toContain(
      "chk_professionals_at_most_one_medical_qualification",
    );
    expect(migration).toContain(
      "CHECK (medical_specialty_id IS NULL OR operational_profile_code IS NULL)",
    );
  });

  it("amarra instituição, hospital, setor, contexto e turno por FKs compostas", () => {
    expect(migration).toContain("uniq_hospitals_topology_id");
    expect(migration).toContain("uniq_sectors_topology_id");
    expect(migration).toContain("uniq_schedule_context_topology_id");
    expect(migration).toContain("fk_sectors_hospital_topology");
    expect(migration).toContain("fk_schedule_context_hospital_topology");
    expect(migration).toContain("fk_schedule_context_sector_topology");
    expect(migration).toContain("fk_shift_instance_schedule_context_topology");
    expect(migration).toContain(
      "FOREIGN KEY (institution_id, hospital_id, sector_id, schedule_context_id)",
    );
  });

  it("faz somente os três backfills inequívocos e promove clínico geral a Clínica médica", () => {
    const equalityMatches = Array.from(
      migration.matchAll(
        /LOWER\(TRIM\((?:professional|shift_instance)\.specialty\)\) = '([^']+)'/g,
      ),
      ([, value]) => value,
    );
    expect(new Set(equalityMatches)).toEqual(
      new Set(["anestesiologia", "ortopedia"]),
    );
    expect(migration).toContain("specialty.code = 'ORTOPEDIA_E_TRAUMATOLOGIA'");
    expect(migration).toContain("specialty.code = 'CLINICA_MEDICA'");
    expect(migration).toContain("'clínica geral', 'clínico geral'");
    expect(migration).not.toMatch(
      /operational_profile_code = 'MEDICO_GENERALISTA'/,
    );
    expect(migration).not.toMatch(
      /LOWER\(TRIM\([^)]*\.specialty\)\) = 'clínica médica'/i,
    );
  });

  it("não mistura a carga específica do Hospital São Carlos na migration genérica", () => {
    expect(migration).not.toMatch(/Sala de Recuperação|\bTRR\b|\bUTI\b/i);
    expect(migration).not.toMatch(
      /INSERT\s+INTO\s+(institutions|hospitals|sectors)/i,
    );
  });
});
