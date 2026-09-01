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
    expect(schemaStep).toBeGreaterThanOrEqual(0);
    expect(proofStep).toBeGreaterThan(schemaStep);
    const proofBlock = CI_WORKFLOW.slice(proofStep);
    expect(proofBlock).toContain(
      "run: pnpm exec tsx scripts/prove-readiness-fence-v1-migration.ts",
    );
    expect(proofBlock).toContain("env:");
  });
});
