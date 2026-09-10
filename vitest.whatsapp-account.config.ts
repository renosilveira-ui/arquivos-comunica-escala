import { defineConfig } from "vitest/config";

/** Banco descartável exclusivo; não carrega tests/setup.ts nem DATABASE_URL externa. */
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: [],
    fileParallelism: false,
    include: ["tests/whatsapp-account-ownership-mysql.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
