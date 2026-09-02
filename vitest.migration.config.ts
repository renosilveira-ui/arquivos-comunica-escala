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
    ],
    setupFiles: [],
    fileParallelism: false,
    env: { NODE_ENV: "test" },
  },
});
