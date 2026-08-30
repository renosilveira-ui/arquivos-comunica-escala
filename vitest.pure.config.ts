import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Suítes estruturais sem banco. O vitest.config.ts principal prepara e semeia
 * MySQL para testes de integração; estes contratos devem rodar também antes de
 * qualquer migration ser aplicada.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
    },
  },
  test: {
    environment: "node",
    setupFiles: [],
    include: [
      "tests/medical-specialties-catalog.test.ts",
      "tests/schedule-contexts-schema.test.ts",
      "tests/schedule-contexts-migration.test.ts",
      "tests/schedule-context-policy.test.ts",
      "tests/medical-qualification.test.ts",
      "tests/sao-carlos-context-blueprint.test.ts",
      "tests/schedule-context-router.test.ts",
      "tests/schedule-context-selection.test.ts",
      "tests/agenda-month-navigation.test.ts",
      "tests/shift-template-options.test.ts",
      "tests/assignment-schedule-context-guards.test.ts",
      "tests/schedule-context-readiness.test.ts",
      "tests/admin-schedule-context-selection.test.ts",
      "tests/schedule-context-readers-source.test.ts",
      "tests/notification-shift-routing.test.ts",
      "tests/assignment-push-signal.test.ts",
      "tests/bulk-import-structured-guard.test.ts",
      "tests/replacement-candidates-schedule-context.test.ts",
      "tests/edit-shift-context-immutable.test.ts",
      "tests/schedule-invite-code.test.ts",
      "tests/schedule-invites-schema.test.ts",
      "tests/schedule-invites-migration.test.ts",
      "tests/schedule-invites-router.test.ts",
      "tests/schedule-invites-source.test.ts",
      "tests/schedule-invites-named-migration.test.ts",
      "tests/professional-institutions-role-migration.test.ts",
      "tests/schedule-context-allowlist-migration.test.ts",
      "tests/consolidate-unified-sector-contexts-migration.test.ts",
      "tests/provision-sala-recuperacao-source.test.ts",
      "tests/hospital-time.test.ts",
      "tests/sala-recuperacao-shift-blueprint.test.ts",
      "tests/open-month-shifts.test.ts",
      "tests/schedule-invite-mail.test.ts",
      "tests/mailer.test.ts",
      "tests/request-deadline.test.ts",
      "tests/login-admission-bounce.test.ts",
      "tests/android-login-boot-hang.test.ts",
      "tests/canonical-session-request-deadline.test.ts",
      "tests/auth-provider-races.test.ts",
      "tests/auth-logout-persistence.test.ts",
      "tests/web-session-visibility.test.ts",
      "tests/web-session-lifecycle.test.ts",
      "tests/web-verified-session.test.ts",
      "tests/institution-roles.test.ts",
    ],
  },
});
