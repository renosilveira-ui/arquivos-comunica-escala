import { defineConfig } from "vitest/config";

/** Testes puros do motor; não inicializam MySQL nem seeds compartilhados. */
export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: [
      "tests/operational-delivery-worker.test.ts",
      "tests/operational-delivery-requeue-audit-migration.test.ts",
    ],
  },
});
