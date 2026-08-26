/**
 * Isolated destructive E2E worker.
 *
 * This file is intentionally separate from the public runner. Database code is
 * imported only here, after the child has revalidated and sanitized its target.
 */

import { pathToFileURL } from "node:url";

import {
  buildSanitizedE2EChildEnvironment,
  buildWorkflowRunPlan,
  databaseFingerprintFromQueryResult,
  runE2EWorkflowChildCore,
  validateE2EWorkflowEnvironment,
  type DedicatedWorkflowLockConnection,
  type WorkflowRuntime,
} from "./run-e2e-workflow.js";

type Environment = Record<string, string | undefined>;
type WorkflowRuntimeLoader = () => Promise<WorkflowRuntime>;

function installSanitizedEnvironment(
  env: Readonly<Record<string, string>>,
): void {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, env);
}

async function loadProductionWorkflowRuntime(): Promise<WorkflowRuntime> {
  const [database, routers, schema, orm, mysql] = await Promise.all([
    import("../server/db.js"),
    import("../server/routers.js"),
    import("../drizzle/schema.js"),
    import("drizzle-orm"),
    import("mysql2/promise"),
  ]);
  return {
    closeDb: database.closeDb,
    getDb: database.getDb,
    async openWorkflowLockConnection(databaseUrl: string) {
      const dedicated = await mysql.createConnection(databaseUrl);
      return {
        query(statement: string, values: readonly unknown[] = []) {
          return dedicated.query(statement, [...values]);
        },
        end() {
          return dedicated.end();
        },
      } satisfies DedicatedWorkflowLockConnection;
    },
    async readPoolFingerprint(db: any) {
      const result = await db.execute(
        orm.sql`SELECT @@hostname AS server_host, @@port AS server_port, DATABASE() AS database_name`,
      );
      return databaseFingerprintFromQueryResult(result);
    },
    appRouter: routers.appRouter,
    schema,
    orm,
  };
}

export async function runE2EWorkflowChild(
  env: Environment = process.env,
  loadRuntime: WorkflowRuntimeLoader = loadProductionWorkflowRuntime,
): Promise<void> {
  if (env.E2E_WORKFLOW_CHILD !== "1") {
    throw new Error("E2E child requires the isolated parent-process marker.");
  }
  const config = validateE2EWorkflowEnvironment(env);
  if (env.DATABASE_URL !== config.databaseUrl) {
    throw new Error(
      "E2E child DATABASE_URL must equal the canonical validated target.",
    );
  }
  if (env.DATABASE_SSL !== "false") {
    throw new Error(
      "E2E child requires DATABASE_SSL=false for its local target.",
    );
  }
  const plan = buildWorkflowRunPlan(env.E2E_WORKFLOW_RUN_ID);

  // The production runtime reads process.env while its modules are imported.
  // Replace inherited state before that boundary so external credentials,
  // NODE_OPTIONS and outbound integration flags cannot reach the worker.
  installSanitizedEnvironment(
    buildSanitizedE2EChildEnvironment(config, plan, env),
  );
  const runtime = await loadRuntime();
  await runE2EWorkflowChildCore(runtime, config, plan);
}

async function main(): Promise<void> {
  try {
    await runE2EWorkflowChild();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Isolated destructive E2E child failed: ${message}`);
    process.exitCode = 1;
  }
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) void main();
