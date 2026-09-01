import { defineConfig } from "vitest/config";

/**
 * Exercita locks reais do journal somente em schema MySQL efêmero e local.
 * Não carrega o setup global nem reutiliza o banco de integração da aplicação.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/readiness-fence-v1-mysql.test.ts"],
    setupFiles: [],
    fileParallelism: false,
    env: { NODE_ENV: "test" },
  },
});
