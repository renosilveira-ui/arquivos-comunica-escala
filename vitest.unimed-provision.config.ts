import { defineConfig } from "vitest/config";

/**
 * A prova da provisão Unimed usa apenas um schema MySQL efêmero, criado a
 * partir de um servidor local explicitamente allowlisted. Não reutiliza o
 * banco da aplicação nem o setup global de integração.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/unimed-hospital-provision-mysql.test.ts"],
    setupFiles: [],
    fileParallelism: false,
    env: { NODE_ENV: "test" },
  },
});
