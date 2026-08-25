import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDirectory = fileURLToPath(new URL(".", import.meta.url));
const forbiddenDatabaseModules = new Set(
  ["server/db.ts", "server/db.js"].map((relativePath) =>
    path.normalize(path.resolve(rootDirectory, relativePath)),
  ),
);
const forbiddenModuleId = "\0e2e-default-gate-db-import-forbidden";

/**
 * No setup file and no database environment: the default E2E gate verifies
 * only the fail-closed guard. The destructive workflow has a separate,
 * explicitly authorized command.
 */
export default defineConfig({
  plugins: [
    {
      name: "forbid-database-import-in-default-e2e-gate",
      enforce: "pre",
      async resolveId(source, importer) {
        if (source === forbiddenModuleId) return forbiddenModuleId;
        const resolved = await this.resolve(source, importer, {
          skipSelf: true,
        });
        if (!resolved) return null;
        const canonicalPath = path.normalize(resolved.id.split("?", 1)[0]);
        return forbiddenDatabaseModules.has(canonicalPath)
          ? forbiddenModuleId
          : null;
      },
      load(id) {
        return id === forbiddenModuleId
          ? 'throw new Error("Default E2E gate must not import server/db");'
          : null;
      },
    },
  ],
  test: {
    environment: "node",
    include: [
      "tests/e2e-workflow-guard.test.ts",
      "tests/e2e-default-gate-tripwire.guard.ts",
    ],
    setupFiles: [],
  },
});
