import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-02-operational-delivery-requeue-audit.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration de auditoria de requeue operacional", () => {
  it("é aditiva, rerodável e não persiste alvo ou conteúdo", () => {
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS operational_delivery_requeue_audits",
    );
    expect(migration).toContain("foundation_precondition_stmt");
    expect(migration).toContain("notification_delivery_id");
    expect(migration).toContain("operational_event_id");
    expect(migration).toContain("actor_user_id");
    expect(migration).toContain("previous_attempt_count");
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migration).not.toMatch(/\bUPDATE\s+/i);
    const tableDefinition = migration.match(
      /CREATE TABLE IF NOT EXISTS operational_delivery_requeue_audits[\s\S]*?ENGINE=InnoDB;/,
    )?.[0];
    expect(tableDefinition).toBeDefined();
    expect(tableDefinition).not.toMatch(/email|token|body|phi/i);
  });

  it("falha fechado para tabela homônima com contrato divergente", () => {
    expect(migration).toContain("INFORMATION_SCHEMA.COLUMNS");
    expect(migration).toContain("INFORMATION_SCHEMA.STATISTICS");
    expect(migration).toContain("INFORMATION_SCHEMA.KEY_COLUMN_USAGE");
    expect(migration).toContain("requeue_audit_total_index_count");
    expect(migration).toContain("requeue_audit_total_foreign_key_count");
    expect(migration).toContain("requeue_audit_contract_precondition");
    expect(migration).toContain("requeue_audit_contract_stmt");
    expect(migration).toContain(
      "operational_delivery_requeue_audit_contract_mismatch",
    );
    expect(migration).toContain(
      "fk_operational_delivery_requeue_audit_institution",
    );
    expect(migration.indexOf("requeue_audit_contract_stmt")).toBeLessThan(
      migration.indexOf(
        "CREATE TABLE IF NOT EXISTS operational_delivery_requeue_audits",
      ),
    );
  });
});
