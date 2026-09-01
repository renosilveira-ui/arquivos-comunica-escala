import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-08-31-sector-service-specialties.sql",
    import.meta.url,
  ),
  "utf8",
);
const ciWorkflow = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);

describe("migration de especialidades assistenciais por setor", () => {
  it("é aditiva, rerodável e protege a topologia completa", () => {
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS sector_service_specialties",
    );
    expect(migration).toContain("uniq_sector_service_specialty");
    expect(migration).toContain("idx_sector_service_specialty_specialty");
    expect(migration).toContain("fk_sector_service_specialty_topology");
    expect(migration).toContain(
      "FOREIGN KEY (institution_id, hospital_id, sector_id)",
    );
    expect(migration).toContain("INFORMATION_SCHEMA.STATISTICS");
    expect(migration).toContain("INFORMATION_SCHEMA.TABLE_CONSTRAINTS");
    expect(migration).toContain("INFORMATION_SCHEMA.COLUMNS");
    expect(migration).toContain(
      "sector_service_specialties_existing_table_contract_mismatch",
    );
    expect(migration).toContain(
      "sector_service_specialties_table_contract_mismatch",
    );
    expect(migration).toContain(
      "@sector_service_specialties_foreign_key_count",
    );
    expect(migration).toContain(
      "sector_service_specialties_sectors_index_contract_mismatch",
    );
    expect(migration).toContain("ENGINE=InnoDB");
    const parentIndex = migration.indexOf(
      "ALTER TABLE sectors ADD UNIQUE KEY uniq_sectors_topology_id",
    );
    const topologyForeignKey = migration.indexOf(
      "FOREIGN KEY (institution_id, hospital_id, sector_id)",
    );
    expect(parentIndex).toBeGreaterThanOrEqual(0);
    expect(topologyForeignKey).toBeGreaterThan(parentIndex);
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
  });

  it("não semeia nem altera dados operacionais", () => {
    expect(migration).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(migration).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migration).not.toMatch(/Hospital São Carlos|Hospital das Clínicas/i);
    expect(migration).not.toMatch(
      /Hospital Unimed Sul|Hospital Regional Unimed/i,
    );
  });

  it("adiciona a auditoria de setor sem retirar valores históricos", () => {
    expect(migration).toContain("SECTOR_SERVICE_SPECIALTIES_UPDATED");
    expect(migration).toContain("''SECTOR''");
    expect(migration).toContain("LEFT(@action_column_type");
    expect(migration).toContain("LEFT(@entity_column_type");
    expect(migration).toContain("@audit_action_contract_matches");
    expect(migration).toContain("@audit_entity_contract_matches");
    expect(migration).toContain(
      "sector_service_specialties_audit_action_contract_mismatch",
    );
    expect(migration).toContain(
      "sector_service_specialties_audit_entity_contract_mismatch",
    );
    expect(migration).toContain("LOWER(COLUMN_TYPE) LIKE 'enum(%'");
    expect(migration).toContain("CHARACTER SET ',");
    expect(migration).toContain("COLLATE ',");
    expect(migration).toContain("COLUMN_COMMENT = ''");
    expect(migration).not.toContain("MODIFY COLUMN action ENUM(");
    expect(migration).not.toContain("MODIFY COLUMN entity_type ENUM(");
  });

  it("executa a prova MySQL somente contra um servidor local isolado na CI", () => {
    expect(ciWorkflow).toContain(
      "SECTOR_SERVICE_SPECIALTIES_MIGRATION_TEST_SERVER_URL: mysql://root:root@127.0.0.1:3306/mysql",
    );
    expect(ciWorkflow).toContain(
      "run: pnpm test:sector-service-specialties-migration",
    );
  });
});
