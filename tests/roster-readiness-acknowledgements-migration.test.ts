import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-08-31-roster-readiness-acknowledgements.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration manual de ciência de prontidão", () => {
  it("é aditiva, repetível e não altera escala ou vínculos existentes", () => {
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS roster_readiness_acknowledgements",
    );
    expect(migration).toContain(
      "UNIQUE KEY uniq_roster_readiness_acknowledgement",
    );
    expect(migration).toContain("INFORMATION_SCHEMA.STATISTICS");
    expect(migration).toContain("uniq_hospitals_topology_id");
    expect(migration).toContain("uniq_monthly_rosters_topology_id");
    expect(migration).toContain("actor_membership_unique_exists");
    expect(migration).toContain(
      "uniq_professional_institutions_user_institution",
    );
    expect(migration).not.toMatch(/^\s*(DROP|DELETE|UPDATE|INSERT)\b/im);
  });

  it("amarra ciência a roster, ator e topologia institucional canônica", () => {
    expect(migration.indexOf("uniq_hospitals_topology_id")).toBeLessThan(
      migration.indexOf("fk_roster_readiness_ack_hospital_topology"),
    );
    expect(migration).toContain("FOREIGN KEY (institution_id, hospital_id)");
    expect(migration).toContain("REFERENCES hospitals(institution_id, id)");
    expect(migration).toContain(
      "FOREIGN KEY (monthly_roster_id) REFERENCES monthly_rosters(id)",
    );
    expect(migration).not.toMatch(
      /fk_roster_readiness_ack_roster[\s\S]*?ON DELETE CASCADE/i,
    );
    expect(migration).toContain(
      "FOREIGN KEY (institution_id, hospital_id, year_month, monthly_roster_id)",
    );
    expect(migration).toContain(
      "REFERENCES monthly_rosters(institution_id, hospital_id, year_month, id)",
    );
    expect(migration).toContain(
      "FOREIGN KEY (actor_user_id) REFERENCES users(id)",
    );
    expect(migration).toContain(
      "FOREIGN KEY (actor_user_id, institution_id)",
    );
    expect(migration).toContain(
      "REFERENCES professional_institutions(user_id, institution_id)",
    );
    expect(migration).toContain(
      "fk_roster_readiness_ack_actor_institution",
    );
    expect(migration).toContain("snapshot_hash VARCHAR(64) NOT NULL");
    expect(migration).toContain(
      "readiness_fence_revision BIGINT UNSIGNED NOT NULL",
    );
    expect(migration).toContain(
      "readiness_fence_coverage_version VARCHAR(64) NOT NULL",
    );
    expect(migration).toContain(
      "readiness_fence_coverage_hash VARCHAR(64) NOT NULL",
    );
    expect(migration).toContain("issue_codes JSON NOT NULL");
    expect(migration).toContain("issue_snapshot JSON NOT NULL");
  });
});
