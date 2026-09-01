import { defineConfig } from "vitest/config";

/**
 * Prova manual opt-in contra um MySQL local descartável. Não carrega o setup
 * global porque ele prepara escalas_test; este teste cria um banco próprio.
 */
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: [],
    include: ["tests/operational-events-foundation.mysql.test.ts"],
  },
});
