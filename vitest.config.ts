import { defineConfig } from "vitest/config";
import path from "path";
import { validateStandardTestDestructiveTarget } from "./scripts/destructive-target-fence";

const validatedTestTarget =
  validateStandardTestDestructiveTarget(process.env);
const testDbUrl = validatedTestTarget.databaseUrl;

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
      // lib/theme.ts usa Platform.select (fonte mono por plataforma); em
      // Node não há react-native — um stub com só o que a lib toca.
      "react-native": path.resolve(__dirname, "./tests/stubs/react-native.ts"),
      "lucide-react-native": path.resolve(
        __dirname,
        "./tests/stubs/lucide-react-native.ts",
      ),
    },
  },
  test: {
    globals: true,
    environment: "node",
    fileParallelism: false,
    setupFiles: ["./tests/setup.ts"],
    env: {
      // A configuração falha antes de carregar a suíte se o alvo não for o
      // MySQL local descartável e explicitamente autorizado.
      DATABASE_URL: testDbUrl,
      TEST_DATABASE_URL: testDbUrl,
      TEST_DATABASE_ALLOW_DESTRUCTIVE: "1",
      TEST_DATABASE_EXPECTED_NAME: validatedTestTarget.databaseName,
      TEST_DATABASE_DISPOSABLE_MARKER:
        process.env.TEST_DATABASE_DISPOSABLE_MARKER!,
      SCHEDULE_INVITE_CODE_PEPPER:
        "test-only-schedule-invite-code-pepper-v2-2026",
      NODE_ENV: "test",
    },
    exclude: [
      "tests/schedule-shift-capacity-migration.test.ts",
      "**/node_modules/**",
      "**/dist/**",
      "**/app/**",
      "**/components/**",
      "**/hooks/**",
      "**/lib/**",
      "**/.expo/**",
      "tests/sector-service-specialties-migration-mysql.test.ts",
      "tests/readiness-fence-v1-mysql.test.ts",
      "tests/vacancy-query-indexes-migration-mysql.test.ts",
      "tests/whatsapp-inbound-nl-poll-index-mysql.test.ts",
      "tests/professional-identity-migration-mysql.test.ts",
      "tests/institution-feature-entitlements-migration-mysql.test.ts",
      "tests/schedule-invite-issuance-fence-migration-mysql.test.ts",
      "tests/schedule-invite-code-hash-v2-migration-mysql.test.ts",
      "tests/whatsapp-continuation-migration-mysql.test.ts",
      "tests/whatsapp-account-ownership-mysql.test.ts",
    ],
  },
  define: {
    __DEV__: true,
  },
});
