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
    setupFiles: ["./tests/setup.ts"],
    env: {
      DATABASE_URL: "mysql://root:root@127.0.0.1:3306/escalas_test",
      NODE_ENV: "test",
    },
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/app/**",
      "**/components/**",
      "**/hooks/**",
      "**/lib/**",
      "**/.expo/**",
    ],
  },
  define: {
    __DEV__: true,
  },
});
