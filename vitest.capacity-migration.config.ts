import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: [],
    include: ["tests/schedule-shift-capacity-migration.test.ts"],
  },
});
