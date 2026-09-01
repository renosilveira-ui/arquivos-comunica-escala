import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Integração opt-in: o teste cria e remove um banco MySQL efêmero apenas
 * quando OPERATIONAL_DELIVERY_DB_TEST_URL aponta explicitamente para localhost.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
  test: {
    environment: "node",
    setupFiles: [],
    fileParallelism: false,
    include: ["tests/operational-delivery-worker.db-integration.ts"],
    env: {
      NODE_ENV: "test",
    },
  },
});
