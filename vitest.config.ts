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
    setupFiles: ["./tests/setup.ts"],
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
