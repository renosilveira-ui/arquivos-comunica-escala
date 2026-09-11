import { defineConfig } from "vitest/config";

/**
 * A migration manual é executada só contra um schema MySQL efêmero e
 * allowlisted. Não carrega o setup global, que semeia o banco de integração.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/sector-service-specialties-migration-mysql.test.ts",
      "tests/vacancy-query-indexes-migration.test.ts",
      "tests/vacancy-query-indexes-migration-mysql.test.ts",
      "tests/whatsapp-inbound-nl-poll-index-mysql.test.ts",
      "tests/professional-identity-migration-mysql.test.ts",
      "tests/institution-feature-entitlements-migration-mysql.test.ts",
      "tests/whatsapp-continuation-migration-mysql.test.ts",
      "tests/personal-calendar-foundation-migration-mysql.test.ts",
      "tests/schedule-invite-issuance-fence-migration-mysql.test.ts",
      "tests/schedule-invite-code-hash-v2-migration-mysql.test.ts",
      "tests/auth-recovery-migration-mysql.test.ts",
      "tests/core-schema-reproducibility-migration-mysql.test.ts",
      "tests/manual-migration-ledger-mysql.test.ts",
    ],
    setupFiles: [],
    fileParallelism: false,
    env: { NODE_ENV: "test" },
  },
});
