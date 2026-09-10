import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const packageJson = readFileSync("package.json", "utf8");
const fenceProof = readFileSync(
  "tests/schedule-invite-issuance-fence-migration-mysql.test.ts",
  "utf8",
);
const fenceMigration = readFileSync(
  "drizzle/migrations/manual/2026-09-10-schedule-invite-issuance-fences.sql",
  "utf8",
);
const hashProof = readFileSync(
  "tests/schedule-invite-code-hash-v2-migration-mysql.test.ts",
  "utf8",
);
const runbook = readFileSync(
  "docs/operations/schedule-invite-code-hash-v2.md",
  "utf8",
);

describe("wiring CI das migrations de convite", () => {
  it("declara URLs loopback, marker e comando explícito", () => {
    expect(ci).toContain(
      "SCHEDULE_INVITE_FENCE_MIGRATION_TEST_SERVER_URL: mysql://root:root@127.0.0.1:3306/mysql",
    );
    expect(ci).toContain(
      "SCHEDULE_INVITE_HASH_V2_MIGRATION_TEST_SERVER_URL: mysql://root:root@127.0.0.1:3306/mysql",
    );
    expect(ci).toContain("SCHEDULE_INVITE_MIGRATION_TEST_MARKER:");
    expect(ci).toContain("run: pnpm test:schedule-invite-migrations");
    expect(packageJson).toContain('"test:schedule-invite-migrations"');
  });

  it("falha sem env/marker e não contém skip nem DROP DATABASE", () => {
    for (const source of [fenceProof, hashProof]) {
      expect(source).toContain("throw new Error(");
      expect(source).toContain("SCHEDULE_INVITE_MIGRATION_TEST_MARKER");
      expect(source).toContain('url.pathname !== "/mysql"');
      expect(source).toContain("__escalas_disposable_test_target_v1");
      expect(source).toContain("escalas-disposable-test-target-v1");
      expect(source).toContain("marker_hash CHAR(64)");
      expect(source).toContain('DATABASE_PREFIX = "escalas_test_');
      expect(source).not.toContain("describe.skip");
      expect(source).not.toMatch(/\bDROP\s+DATABASE\b/i);
      expect(source).not.toContain("process.env.DATABASE_URL");
    }
  });

  it("fixa fence → hash V2 → reruns/manifests → env → runtime", () => {
    const gates = [
      "1. **Fence/outbox/journal:**",
      "2. **Hash V2:**",
      "3. **Reruns/manifests:**",
      "4. **Env:**",
      "5. **Runtime:**",
    ].map((gate) => runbook.indexOf(gate));
    expect(gates.every((index) => index >= 0)).toBe(true);
    expect(gates).toEqual([...gates].sort((left, right) => left - right));
    expect(runbook).toContain("Não operar writer antigo e novo");
  });

  it("mantém provas adversariais do manifesto e do journal append-only", () => {
    expect(fenceProof).toContain(
      "DROP CHECK chk_schedule_invite_issuance_generation",
    );
    expect(fenceProof).toContain("generation >= 0");
    expect(fenceProof).toContain("ON UPDATE CASCADE ON DELETE CASCADE");
    expect(fenceProof).toContain(
      "trg_schedule_invite_issuance_journal_no_update",
    );
    expect(fenceMigration).toContain(
      "trg_schedule_invite_issuance_journal_no_delete",
    );
    expect(fenceMigration).toContain(
      "DROP TRIGGER IF EXISTS trg_schedule_invite_issuance_journal_no_update",
    );
    expect(fenceMigration).toContain("SIGNAL SQLSTATE '45000'");
    expect(fenceMigration).toContain("@siij_trigger_subset_ok");
    expect(fenceMigration).toContain(
      "@siij_reserved_trigger_count BETWEEN 0 AND 2",
    );
    expect(fenceMigration).toContain(
      "trg_users_schedule_invite_email_egress_guard",
    );
    expect(fenceMigration).toContain("NOT (OLD.email <=> NEW.email)");
    expect(fenceMigration).toContain(
      "idx_schedule_invite_issuance_email_egress",
    );
    expect(fenceMigration).toContain(
      "fk_schedule_invite_issuance_active_invite",
    );
    expect(fenceProof).toContain(
      'it("repara somente o subconjunto exato de triggers perdido por crash"',
    );
    expect(fenceProof).toContain(
      'it("retoma o estado próprio após criar a fence e antes de criar o journal"',
    );
    expect(fenceProof).toContain(
      'it("postflight do primeiro run recusa tipo criado fora do manifesto"',
    );
    expect(fenceProof).toContain(
      'it("postflight do primeiro run recusa default criado fora do manifesto"',
    );
    expect(fenceProof).toContain(
      "SCHEDULE_INVITE_EMAIL_CHANGE_BLOCKED_DURING_EGRESS",
    );
    expect(fenceProof).toContain("ER_NO_REFERENCED_ROW_2");
    expect(fenceProof).toContain("SET reason_code = 'TAMPERED'");
    expect(fenceProof).toContain(
      "DELETE FROM schedule_invite_issuance_journal",
    );
    expect(hashProof).toContain('code_hash_version: "HMAC_SHA256_V2"');
    expect(runbook).toContain("default final da");
  });
});
