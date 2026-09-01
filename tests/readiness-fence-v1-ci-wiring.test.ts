import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CI_WORKFLOW = readFileSync(
  fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url)),
  "utf8",
);

describe("wiring da prova MySQL da readiness fence V1 na CI", () => {
  it("executa a prova isolada com o service MySQL local, nunca DATABASE_URL", () => {
    expect(CI_WORKFLOW).toContain(
      'READINESS_FENCE_V1_PROOF_ALLOW_DESTRUCTIVE: "1"',
    );
    expect(CI_WORKFLOW).toContain(
      "READINESS_FENCE_V1_PROOF_SERVER_URL: mysql://root:root@127.0.0.1:3306/",
    );

    const schemaStep = CI_WORKFLOW.indexOf("- name: Apply database schema");
    const proofStep = CI_WORKFLOW.indexOf(
      "- name: Prove readiness fence V1 manual migration",
    );
    const concurrencyStep = CI_WORKFLOW.indexOf(
      "- name: Validate readiness fence V1 event journal concurrency",
    );
    const preparedStep = CI_WORKFLOW.indexOf(
      "- name: Validate readiness fence V1 over Drizzle PREPARED schema",
    );
    expect(schemaStep).toBeGreaterThanOrEqual(0);
    expect(preparedStep).toBeGreaterThan(schemaStep);
    expect(proofStep).toBeGreaterThan(schemaStep);
    expect(proofStep).toBeGreaterThan(preparedStep);
    expect(concurrencyStep).toBeGreaterThan(proofStep);
    const preparedBlock = CI_WORKFLOW.slice(preparedStep, proofStep);
    expect(preparedBlock).toContain('READINESS_FENCE_V1_APPLY: "1"');
    expect(preparedBlock).toContain(
      "READINESS_FENCE_V1_DATABASE_URL: mysql://root:root@127.0.0.1:3306/escalas_test",
    );
    expect(preparedBlock).toContain("pnpm apply:readiness-fence-v1");
    const proofBlock = CI_WORKFLOW.slice(proofStep);
    expect(proofBlock).toContain(
      "run: pnpm exec tsx scripts/prove-readiness-fence-v1-migration.ts",
    );
    expect(proofBlock).toContain("env:");
    const concurrencyBlock = CI_WORKFLOW.slice(concurrencyStep);
    expect(concurrencyBlock).toContain(
      "READINESS_FENCE_V1_MYSQL_TEST_SERVER_URL: ${{ env.READINESS_FENCE_V1_PROOF_SERVER_URL }}",
    );
    expect(concurrencyBlock).toContain(
      "run: pnpm test:readiness-fence-v1-mysql",
    );
  });
});
