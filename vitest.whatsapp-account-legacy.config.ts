import { defineConfig } from "vitest/config";

/** Regressões legadas sem seed global ou DATABASE_URL externa. */
export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    setupFiles: ["./tests/helpers/whatsapp-account-legacy-mysql-setup.ts"],
    include: [
      "tests/user-contact-channels.test.ts",
      "tests/whatsapp-verification.test.ts",
      "tests/whatsapp-inbound-idempotency.test.ts",
      "tests/whatsapp-inbound-identity.test.ts",
      "tests/whatsapp-inbound-payload-retry.test.ts",
      "tests/whatsapp-inbound-privacy.test.ts",
      "tests/whatsapp-inbound-webhook-accept.test.ts",
    ],
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
