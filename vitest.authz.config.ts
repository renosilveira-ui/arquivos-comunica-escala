/**
 * vitest.authz.config.ts
 *
 * Separate vitest config for AuthZ v1 enforcement tests.
 * These tests are pure logic — no database required.
 */
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    fileParallelism: false,
    include: ["tests/authz-enforce.test.ts"],
    env: {
      NODE_ENV: "test",
      AUTHZ_V1_ENFORCE: "1",
    },
  },
  define: {
    __DEV__: true,
  },
});
