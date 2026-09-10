import { defineConfig } from "vitest/config";
import { validateStandardTestDestructiveTarget } from "./scripts/destructive-target-fence";

const validatedParentTarget = validateStandardTestDestructiveTarget(
  process.env,
);
const parentDbUrl = validatedParentTarget.databaseUrl;

/** Banco-filho exclusivo; bloqueia DATABASE_URL ambiente e exige o pai marcado. */
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: [],
    fileParallelism: false,
    include: [
      "tests/disposable-mysql-child-runner.test.ts",
      "tests/whatsapp-account-ownership-mysql.test.ts",
    ],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "",
      TEST_DATABASE_URL: parentDbUrl,
      TEST_DATABASE_ALLOW_DESTRUCTIVE: "1",
      TEST_DATABASE_EXPECTED_NAME: validatedParentTarget.databaseName,
      TEST_DATABASE_DISPOSABLE_MARKER:
        process.env.TEST_DATABASE_DISPOSABLE_MARKER!,
    },
  },
});
