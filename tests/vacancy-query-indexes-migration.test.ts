import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";
import {
  managerScope,
  professionalAccess,
  shiftAssignmentsV2,
  shiftInstances,
} from "../drizzle/schema";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-02-vacancy-query-indexes.sql",
    import.meta.url,
  ),
  "utf8",
);

function indexColumns(table: Parameters<typeof getTableConfig>[0]) {
  return Object.fromEntries(
    getTableConfig(table).indexes.map((index) => [
      index.config.name,
      index.config.columns.map((column) =>
        "name" in column ? column.name : null,
      ),
    ]),
  );
}

function migrationIndexColumns(indexName: string): string[] | undefined {
  const match = migration.match(
    new RegExp(`ADD INDEX ${indexName} \\(([^)]+)\\)`),
  );
  return match?.[1]?.split(",").map((column) => column.trim());
}

describe("índices da consulta acionável de Vagas", () => {
  it("mantém schema e migration no mesmo contrato", () => {
    const expectedIndexes = {
      idx_prof_access_actor_active: [
        "institution_id",
        "professional_id",
        "can_access",
        "hospital_id",
        "sector_id",
      ],
      idx_manager_scope_actor_active: [
        "institution_id",
        "manager_professional_id",
        "active",
        "hospital_id",
        "sector_id",
      ],
      idx_shift_instances_vacancy_lookup: [
        "institution_id",
        "status",
        "schedule_context_id",
        "start_at",
      ],
      idx_shift_assignments_shift_active: ["shift_instance_id", "is_active"],
      idx_shift_assignments_prof_active: [
        "professional_id",
        "is_active",
        "shift_instance_id",
      ],
    };

    expect(indexColumns(professionalAccess)).toMatchObject({
      idx_prof_access_actor_active:
        expectedIndexes.idx_prof_access_actor_active,
    });
    expect(indexColumns(managerScope)).toMatchObject({
      idx_manager_scope_actor_active:
        expectedIndexes.idx_manager_scope_actor_active,
    });
    expect(indexColumns(shiftInstances)).toMatchObject({
      idx_shift_instances_vacancy_lookup:
        expectedIndexes.idx_shift_instances_vacancy_lookup,
    });
    expect(indexColumns(shiftAssignmentsV2)).toMatchObject({
      idx_shift_assignments_shift_active:
        expectedIndexes.idx_shift_assignments_shift_active,
      idx_shift_assignments_prof_active:
        expectedIndexes.idx_shift_assignments_prof_active,
    });

    expect(
      Object.fromEntries(
        Object.keys(expectedIndexes).map((indexName) => [
          indexName,
          migrationIndexColumns(indexName),
        ]),
      ),
    ).toEqual(expectedIndexes);
  });

  it("é aditiva, rerodável e recusa índice homônimo incompatível", () => {
    expect(migration).toContain("INFORMATION_SCHEMA.STATISTICS");
    expect(migration).toContain("@vacancy_indexes_preflight");
    expect(migration).toContain("@vacancy_index_count = 5");
    expect(migration).toContain("VACANCY_INDEX_CONTRACT_MISMATCH");
    expect(migration).toContain("VACANCY_INDEX_POSTFLIGHT_MISMATCH");
    expect(migration).not.toContain("vacancy_query_indexes_contract_mismatch");
    expect(migration).not.toContain(
      "vacancy_query_indexes_postflight_mismatch",
    );
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX)\b/i);
    expect(migration).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
  });
});
