/**
 * Destructive E2E workflow runner.
 *
 * Safe to import from tests: environment validation happens before database
 * modules are loaded and main runs only when this is the process entry point.
 *
 * Explicit usage:
 *   NODE_ENV=test E2E_WORKFLOW_ALLOW_DESTRUCTIVE=1 \
 *   E2E_DATABASE_URL=mysql://...@127.0.0.1/escalas_test \
 *   pnpm e2e:workflow:destructive
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const ALLOWED_TEST_DATABASES = new Set(["escalas_test"]);
const ALLOWED_LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const WORKFLOW_LOCK_NAME = "escalas-e2e-workflow-v2";
const WORKFLOW_LOCK_TIMEOUT_SECONDS = 30;
const AUDIT_QUIESCENCE_PASSES = 2;
const AUDIT_QUIESCENCE_MAX_PASSES = 8;
const AUDIT_QUIESCENCE_DELAY_MS = 20;

type Environment = Record<string, string | undefined>;

export type ValidatedE2EEnvironment = {
  databaseUrl: string;
  databaseName: string;
  host: string;
  port: string;
  username: string;
  password: string;
  userId: number | null;
  gestorId: number | null;
};

export type DatabaseFingerprint = {
  serverHost: string;
  serverPort: number;
  databaseName: string;
};

export type CanonicalScenario = {
  institutionId: number;
  institutionActive: boolean;
  hospitalId: number;
  hospitalInstitutionId: number;
  sectorId: number;
  sectorInstitutionId: number;
  sectorHospitalId: number;
};

export type WorkflowRunPlan = {
  runId: string;
  labelPrefix: string;
  searchOffsetDays: number;
};

export type WorkflowFixtureScope = {
  runId: string;
  institutionId: number;
  shiftIds: number[];
  managerScopeIds: number[];
};

export type WorkflowCleanupOperations = {
  deleteAuditTrailRows(
    institutionId: number,
    shiftIds: readonly number[],
  ): Promise<void>;
  findAuditTrailIds(
    institutionId: number,
    shiftIds: readonly number[],
  ): Promise<readonly number[]>;
  deleteShiftAuditRows(
    institutionId: number,
    shiftIds: readonly number[],
  ): Promise<void>;
  deleteAssignmentRows(
    institutionId: number,
    shiftIds: readonly number[],
  ): Promise<void>;
  deleteShiftRows(
    institutionId: number,
    shiftIds: readonly number[],
  ): Promise<void>;
  deleteManagerScopeRows(
    institutionId: number,
    managerScopeIds: readonly number[],
  ): Promise<void>;
};

export type WorkflowCleanupOptions = {
  quiescenceDelayMs?: number;
  wait?: (delayMs: number) => Promise<void>;
};

export type DedicatedWorkflowLockConnection = {
  query(statement: string, values?: readonly unknown[]): Promise<unknown>;
  end(): Promise<void>;
};

export type DedicatedWorkflowLockOptions<T> = {
  expectedDatabase: string;
  openConnection: () => Promise<DedicatedWorkflowLockConnection>;
  readWorkflowFingerprint: () => Promise<DatabaseFingerprint>;
  closeWorkflowResources: () => Promise<void>;
  run: () => Promise<T>;
  timeoutSeconds?: number;
};

export type WorkflowRuntime = {
  closeDb(): Promise<void>;
  getDb(): Promise<any>;
  openWorkflowLockConnection(
    databaseUrl: string,
  ): Promise<DedicatedWorkflowLockConnection>;
  readPoolFingerprint(db: any): Promise<DatabaseFingerprint>;
  appRouter: any;
  schema: any;
  orm: any;
};

export type E2EChildProcessRequest = {
  command: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
};

export type E2EChildProcessRunner = (
  request: E2EChildProcessRequest,
) => Promise<void>;

type CanonicalE2EActor = {
  id: number;
  userId: number;
  sessionVersion: number;
  globalRole: string;
};

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

function log(message: string, color: keyof typeof colors = "reset"): void {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  log(`✅ PASS: ${message}`, "green");
}

function parseOptionalPositiveId(
  value: string | undefined,
  name: string,
): number | null {
  if (value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer when provided.`);
  }
  return parsed;
}

function decodeUrlComponent(value: string, field: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(
      `E2E_DATABASE_URL ${field} must use valid percent encoding.`,
    );
  }
}

function canonicalDatabaseUrl(parts: {
  host: string;
  port: string;
  username: string;
  password: string;
  databaseName: string;
}): string {
  const hasCredentials = parts.username !== "" || parts.password !== "";
  const credentials = hasCredentials
    ? `${encodeURIComponent(parts.username)}:${encodeURIComponent(parts.password)}@`
    : "";
  return `mysql://${credentials}${parts.host}:${parts.port}/${encodeURIComponent(parts.databaseName)}`;
}

/**
 * Fail-closed destructive-target validation. This deliberately never reads
 * DATABASE_URL, so ambient application credentials cannot authorize E2E.
 */
export function validateE2EWorkflowEnvironment(
  env: Environment = process.env,
): ValidatedE2EEnvironment {
  if (env.NODE_ENV !== "test") {
    throw new Error("E2E workflow requires NODE_ENV=test.");
  }
  if (env.E2E_WORKFLOW_ALLOW_DESTRUCTIVE !== "1") {
    throw new Error("E2E workflow requires E2E_WORKFLOW_ALLOW_DESTRUCTIVE=1.");
  }
  const rawDatabaseUrl = env.E2E_DATABASE_URL;
  if (!rawDatabaseUrl) {
    throw new Error("E2E workflow requires explicit E2E_DATABASE_URL.");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawDatabaseUrl);
  } catch {
    throw new Error("E2E_DATABASE_URL must be a valid URL.");
  }
  if (parsed.protocol !== "mysql:") {
    throw new Error("E2E_DATABASE_URL must use the mysql protocol.");
  }
  if (
    rawDatabaseUrl.includes("?") ||
    rawDatabaseUrl.includes("#") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      "E2E_DATABASE_URL must not contain query parameters, driver options, or a fragment.",
    );
  }
  const parsedHost = parsed.hostname.toLowerCase();
  if (!ALLOWED_LOCAL_HOSTS.has(parsedHost)) {
    throw new Error("E2E_DATABASE_URL host must be localhost or 127.0.0.1.");
  }
  const host = parsedHost === "localhost" ? "127.0.0.1" : parsedHost;
  const databaseName = decodeUrlComponent(
    parsed.pathname.replace(/^\/+/, ""),
    "database name",
  );
  if (!ALLOWED_TEST_DATABASES.has(databaseName)) {
    throw new Error(
      `E2E_DATABASE_URL database must be one of: ${[...ALLOWED_TEST_DATABASES].join(", ")}.`,
    );
  }
  const portNumber = Number(parsed.port || "3306");
  if (
    !Number.isSafeInteger(portNumber) ||
    portNumber <= 0 ||
    portNumber > 65_535
  ) {
    throw new Error("E2E_DATABASE_URL port must be between 1 and 65535.");
  }
  const port = String(portNumber);
  const username = decodeUrlComponent(parsed.username, "username");
  const password = decodeUrlComponent(parsed.password, "password");
  const databaseUrl = canonicalDatabaseUrl({
    host,
    port,
    username,
    password,
    databaseName,
  });
  return {
    databaseUrl,
    databaseName,
    host,
    port,
    username,
    password,
    userId: parseOptionalPositiveId(env.E2E_USER_ID, "E2E_USER_ID"),
    gestorId: parseOptionalPositiveId(env.E2E_GESTOR_ID, "E2E_GESTOR_ID"),
  };
}

export function buildWorkflowRunPlan(
  runId: string = randomUUID(),
): WorkflowRunPlan {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      runId,
    )
  ) {
    throw new Error("E2E runId must be a canonical UUID.");
  }
  const seed = Number.parseInt(
    createHash("sha256").update(runId).digest("hex").slice(0, 8),
    16,
  );
  return {
    runId,
    labelPrefix: `E2E Test ${runId}`,
    searchOffsetDays: 30 + (seed % 3_000),
  };
}

export function assertCanonicalScenario(scenario: CanonicalScenario): void {
  assert(scenario.institutionActive, "Institution is active");
  assert(
    scenario.hospitalInstitutionId === scenario.institutionId,
    "Hospital belongs to selected institution",
  );
  assert(
    scenario.sectorInstitutionId === scenario.institutionId,
    "Sector belongs to selected institution",
  );
  assert(
    scenario.sectorHospitalId === scenario.hospitalId,
    "Sector belongs to selected hospital",
  );
}

export function assertConnectedDatabaseName(
  actualDatabase: string,
  expectedDatabase: string,
): void {
  if (actualDatabase !== expectedDatabase) {
    throw new Error(
      `Connected database mismatch: expected ${expectedDatabase}, received ${actualDatabase || "<none>"}.`,
    );
  }
}

function uniquePositiveIds(ids: readonly number[], field: string): number[] {
  const unique = [...new Set(ids)];
  if (unique.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error(`${field} must contain only positive safe integers.`);
  }
  return unique;
}

function defaultQuiescenceWait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * Deletes only fixtures owned by this run and tenant. `audit_trail` has no FK
 * to `shift_instances`, so a snapshot of audit primary keys is not ownership
 * evidence: a late audit for the same run-owned shift must also be removed.
 * Two consecutive empty observations provide bounded, test-only quiescence.
 */
export async function cleanupTrackedFixtures(
  scope: WorkflowFixtureScope,
  operations: WorkflowCleanupOperations,
  options: WorkflowCleanupOptions = {},
): Promise<void> {
  if (!Number.isSafeInteger(scope.institutionId) || scope.institutionId <= 0) {
    throw new Error("Cleanup requires a canonical positive institutionId.");
  }
  const shiftIds = uniquePositiveIds(scope.shiftIds, "shiftIds");
  const managerScopeIds = uniquePositiveIds(
    scope.managerScopeIds,
    "managerScopeIds",
  );
  let fixtureCleanupFailed = false;
  let fixtureCleanupError: unknown;
  try {
    if (shiftIds.length > 0) {
      await operations.deleteShiftAuditRows(scope.institutionId, shiftIds);
      await operations.deleteAssignmentRows(scope.institutionId, shiftIds);
      await operations.deleteShiftRows(scope.institutionId, shiftIds);

      const wait = options.wait ?? defaultQuiescenceWait;
      const delayMs = options.quiescenceDelayMs ?? AUDIT_QUIESCENCE_DELAY_MS;
      if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
        throw new Error(
          "Audit quiescence delay must be a non-negative integer.",
        );
      }
      let consecutiveEmptyPasses = 0;
      for (let pass = 0; pass < AUDIT_QUIESCENCE_MAX_PASSES; pass += 1) {
        await operations.deleteAuditTrailRows(scope.institutionId, shiftIds);
        const remainingIds = uniquePositiveIds(
          await operations.findAuditTrailIds(scope.institutionId, shiftIds),
          "remaining auditTrailIds",
        );
        if (remainingIds.length === 0) consecutiveEmptyPasses += 1;
        else consecutiveEmptyPasses = 0;
        if (consecutiveEmptyPasses >= AUDIT_QUIESCENCE_PASSES) break;
        await wait(delayMs);
      }
      if (consecutiveEmptyPasses < AUDIT_QUIESCENCE_PASSES) {
        throw new Error(
          "Run-owned auditTrail rows did not reach bounded quiescence.",
        );
      }
    }
  } catch (error) {
    fixtureCleanupFailed = true;
    fixtureCleanupError = error;
  }

  let managerCleanupFailed = false;
  let managerCleanupError: unknown;
  try {
    if (managerScopeIds.length > 0) {
      await operations.deleteManagerScopeRows(
        scope.institutionId,
        managerScopeIds,
      );
    }
  } catch (error) {
    managerCleanupFailed = true;
    managerCleanupError = error;
  }

  if (fixtureCleanupFailed && managerCleanupFailed) {
    throw new AggregateError(
      [fixtureCleanupError, managerCleanupError],
      "Run-owned fixture cleanup failed in multiple exact scopes.",
    );
  }
  if (fixtureCleanupFailed) throw fixtureCleanupError;
  if (managerCleanupFailed) throw managerCleanupError;
}

function rowsFromExecute(result: unknown): Record<string, unknown>[] {
  if (!Array.isArray(result)) return [];
  if (Array.isArray(result[0])) return result[0] as Record<string, unknown>[];
  return result as Record<string, unknown>[];
}

export function databaseFingerprintFromQueryResult(
  result: unknown,
): DatabaseFingerprint {
  const row = rowsFromExecute(result)[0];
  const serverHost = String(row?.server_host ?? "")
    .trim()
    .toLowerCase();
  const serverPort = Number(row?.server_port ?? Number.NaN);
  const databaseName = String(row?.database_name ?? "");
  if (
    serverHost === "" ||
    !Number.isSafeInteger(serverPort) ||
    serverPort <= 0 ||
    serverPort > 65_535 ||
    databaseName === ""
  ) {
    throw new Error("Database connection returned an invalid fingerprint.");
  }
  return { serverHost, serverPort, databaseName };
}

export function assertMatchingDatabaseFingerprint(
  lockFingerprint: DatabaseFingerprint,
  workflowFingerprint: DatabaseFingerprint,
): void {
  if (
    lockFingerprint.serverHost !== workflowFingerprint.serverHost ||
    lockFingerprint.serverPort !== workflowFingerprint.serverPort ||
    lockFingerprint.databaseName !== workflowFingerprint.databaseName
  ) {
    throw new Error(
      "Workflow pool fingerprint does not match the dedicated lock owner.",
    );
  }
}

function readLockResult(
  result: unknown,
  field: "acquired" | "released",
): number {
  return Number(rowsFromExecute(result)[0]?.[field] ?? Number.NaN);
}

/**
 * Holds the MySQL advisory lock on one dedicated physical connection for the
 * complete workflow, cleanup and residue assertion. Pool-level `execute()` is
 * intentionally insufficient because GET_LOCK/RELEASE_LOCK are connection
 * scoped in MySQL.
 */
export async function withDedicatedWorkflowLock<T>(
  options: DedicatedWorkflowLockOptions<T>,
): Promise<T> {
  const timeoutSeconds =
    options.timeoutSeconds ?? WORKFLOW_LOCK_TIMEOUT_SECONDS;
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 0) {
    throw new Error(
      "E2E workflow lock timeout must be a non-negative integer.",
    );
  }

  let connection: DedicatedWorkflowLockConnection | null = null;
  let lockAcquired = false;
  let result: T | undefined;
  let workflowFailed = false;
  let workflowError: unknown;
  const finalizationErrors: unknown[] = [];

  try {
    connection = await options.openConnection();
    const lockFingerprint = databaseFingerprintFromQueryResult(
      await connection.query(
        "SELECT @@hostname AS server_host, @@port AS server_port, DATABASE() AS database_name",
      ),
    );
    assertConnectedDatabaseName(
      lockFingerprint.databaseName,
      options.expectedDatabase,
    );

    const lockResult = await connection.query(
      "SELECT GET_LOCK(?, ?) AS acquired",
      [WORKFLOW_LOCK_NAME, timeoutSeconds],
    );
    lockAcquired = readLockResult(lockResult, "acquired") === 1;
    if (!lockAcquired) {
      throw new Error("Could not acquire the isolated E2E workflow lock.");
    }

    const workflowFingerprint = await options.readWorkflowFingerprint();
    assertConnectedDatabaseName(
      workflowFingerprint.databaseName,
      options.expectedDatabase,
    );
    assertMatchingDatabaseFingerprint(lockFingerprint, workflowFingerprint);
    result = await options.run();
  } catch (error) {
    workflowFailed = true;
    workflowError = error;
  } finally {
    if (connection && lockAcquired) {
      try {
        await options.closeWorkflowResources();
      } catch (error) {
        finalizationErrors.push(error);
      }
      try {
        const releaseResult = await connection.query(
          "SELECT RELEASE_LOCK(?) AS released",
          [WORKFLOW_LOCK_NAME],
        );
        if (readLockResult(releaseResult, "released") !== 1) {
          throw new Error(
            "Dedicated E2E connection did not release its workflow lock.",
          );
        }
      } catch (error) {
        finalizationErrors.push(error);
      }
    }
    if (connection) {
      try {
        await connection.end();
      } catch (error) {
        finalizationErrors.push(error);
      }
    }
  }

  if (workflowFailed) {
    if (finalizationErrors.length > 0) {
      throw new AggregateError(
        [workflowError, ...finalizationErrors],
        "E2E workflow failed and its dedicated lock could not be finalized cleanly.",
      );
    }
    throw workflowError;
  }
  if (finalizationErrors.length > 0) {
    throw new AggregateError(
      finalizationErrors,
      "Dedicated E2E lock finalization failed.",
    );
  }
  return result as T;
}

function insertIdFromResult(result: unknown, description: string): number {
  if (!Array.isArray(result)) {
    throw new Error(`${description} did not return a driver result.`);
  }
  const header = result[0] as { insertId?: unknown } | undefined;
  const insertId = Number(header?.insertId);
  if (!Number.isSafeInteger(insertId) || insertId <= 0) {
    throw new Error(`${description} did not return a positive insert id.`);
  }
  return insertId;
}

function isConflictError(error: unknown): boolean {
  const candidate = error as {
    message?: unknown;
    data?: { code?: unknown };
    shape?: { data?: { code?: unknown } };
  };
  const message = String(candidate?.message ?? "").toLowerCase();
  const code = candidate?.data?.code ?? candidate?.shape?.data?.code;
  return (
    code === "CONFLICT" ||
    message.includes("conflito") ||
    message.includes("overlap") ||
    message.includes("já está alocado") ||
    message.includes("already allocated")
  );
}

async function hasUserTimeConflict(
  db: any,
  sql: WorkflowRuntime["orm"]["sql"],
  userId: number,
  startAt: Date,
  endAt: Date,
): Promise<boolean> {
  const result = await db.execute(
    sql`SELECT COUNT(*) AS count
        FROM shift_assignments_v2 sa
        INNER JOIN shift_instances si ON si.id = sa.shift_instance_id
        INNER JOIN professionals p ON p.id = sa.professional_id
        WHERE sa.is_active = true
          AND p.user_id = ${userId}
          AND si.start_at < ${endAt}
          AND si.end_at > ${startAt}`,
  );
  return Number(rowsFromExecute(result)[0]?.count ?? 0) > 0;
}

async function findAvailableBaseDate(
  db: any,
  sql: WorkflowRuntime["orm"]["sql"],
  userId: number,
  windows: readonly { startHour: number; endHour: number }[],
  startOffsetDays: number,
  searchDays = 180,
): Promise<Date> {
  for (
    let offset = startOffsetDays;
    offset < startOffsetDays + searchDays;
    offset += 1
  ) {
    const day = new Date();
    day.setUTCDate(day.getUTCDate() + offset);
    day.setUTCHours(0, 0, 0, 0);
    let conflict = false;
    for (const window of windows) {
      const startAt = new Date(day);
      startAt.setUTCHours(window.startHour, 0, 0, 0);
      const endAt = new Date(day);
      endAt.setUTCHours(window.endHour, 0, 0, 0);
      if (await hasUserTimeConflict(db, sql, userId, startAt, endAt)) {
        conflict = true;
        break;
      }
    }
    if (!conflict) return day;
  }
  throw new Error(
    "No conflict-free E2E window was found for the selected user.",
  );
}

function createCaller(
  appRouter: WorkflowRuntime["appRouter"],
  actor: CanonicalE2EActor,
  institutionId: number,
) {
  return appRouter.createCaller({
    user: {
      id: actor.userId,
      role: actor.globalRole,
      sessionVersion: actor.sessionVersion,
    } as any,
    req: { headers: {}, ip: "127.0.0.1" } as any,
    res: {} as any,
    institutionId,
    allowedInstitutionIds: [institutionId],
  });
}

function buildRunOwnedAuditTrailPredicate(
  runtime: WorkflowRuntime,
  institutionId: number,
  shiftIds: readonly number[],
) {
  const { and, eq, inArray, or } = runtime.orm;
  const { auditTrail } = runtime.schema;
  return and(
    eq(auditTrail.institutionId, institutionId),
    or(
      inArray(auditTrail.shiftInstanceId, [...shiftIds]),
      and(
        eq(auditTrail.entityType, "SHIFT_INSTANCE"),
        inArray(auditTrail.entityId, [...shiftIds]),
      ),
    ),
  );
}

export function productionCleanupOperations(
  db: any,
  runtime: WorkflowRuntime,
): WorkflowCleanupOperations {
  const { and, eq, inArray } = runtime.orm;
  const {
    auditTrail,
    managerScope,
    shiftAssignmentsV2,
    shiftAuditLog,
    shiftInstances,
  } = runtime.schema;
  return {
    async deleteAuditTrailRows(institutionId, shiftIds) {
      await db
        .delete(auditTrail)
        .where(
          buildRunOwnedAuditTrailPredicate(runtime, institutionId, shiftIds),
        );
    },
    async findAuditTrailIds(institutionId, shiftIds) {
      const rows = await db
        .select({ id: auditTrail.id })
        .from(auditTrail)
        .where(
          buildRunOwnedAuditTrailPredicate(runtime, institutionId, shiftIds),
        );
      return rows.map((row: { id: number }) => row.id);
    },
    async deleteShiftAuditRows(institutionId, shiftIds) {
      await db
        .delete(shiftAuditLog)
        .where(
          and(
            eq(shiftAuditLog.institutionId, institutionId),
            inArray(shiftAuditLog.shiftInstanceId, [...shiftIds]),
          ),
        );
    },
    async deleteAssignmentRows(institutionId, shiftIds) {
      await db
        .delete(shiftAssignmentsV2)
        .where(
          and(
            eq(shiftAssignmentsV2.institutionId, institutionId),
            inArray(shiftAssignmentsV2.shiftInstanceId, [...shiftIds]),
          ),
        );
    },
    async deleteShiftRows(institutionId, shiftIds) {
      await db
        .delete(shiftInstances)
        .where(
          and(
            eq(shiftInstances.institutionId, institutionId),
            inArray(shiftInstances.id, [...shiftIds]),
          ),
        );
    },
    async deleteManagerScopeRows(institutionId, managerScopeIds) {
      await db
        .delete(managerScope)
        .where(
          and(
            eq(managerScope.institutionId, institutionId),
            inArray(managerScope.id, [...managerScopeIds]),
          ),
        );
    },
  };
}

export async function assertProductionCleanupComplete(
  db: any,
  runtime: WorkflowRuntime,
  scope: WorkflowFixtureScope,
): Promise<void> {
  const { and, eq, inArray } = runtime.orm;
  const {
    auditTrail,
    managerScope,
    shiftAssignmentsV2,
    shiftAuditLog,
    shiftInstances,
  } = runtime.schema;
  const remainingAuditTrail =
    scope.shiftIds.length === 0
      ? []
      : await db
          .select({ id: auditTrail.id })
          .from(auditTrail)
          .where(
            buildRunOwnedAuditTrailPredicate(
              runtime,
              scope.institutionId,
              scope.shiftIds,
            ),
          );
  const remainingShiftAudit =
    scope.shiftIds.length === 0
      ? []
      : await db
          .select({ id: shiftAuditLog.id })
          .from(shiftAuditLog)
          .where(
            and(
              eq(shiftAuditLog.institutionId, scope.institutionId),
              inArray(shiftAuditLog.shiftInstanceId, [...scope.shiftIds]),
            ),
          );
  const remainingAssignments =
    scope.shiftIds.length === 0
      ? []
      : await db
          .select({ id: shiftAssignmentsV2.id })
          .from(shiftAssignmentsV2)
          .where(
            and(
              eq(shiftAssignmentsV2.institutionId, scope.institutionId),
              inArray(shiftAssignmentsV2.shiftInstanceId, [...scope.shiftIds]),
            ),
          );
  const remainingShifts =
    scope.shiftIds.length === 0
      ? []
      : await db
          .select({ id: shiftInstances.id })
          .from(shiftInstances)
          .where(
            and(
              eq(shiftInstances.institutionId, scope.institutionId),
              inArray(shiftInstances.id, [...scope.shiftIds]),
            ),
          );
  const remainingManagerScopes =
    scope.managerScopeIds.length === 0
      ? []
      : await db
          .select({ id: managerScope.id })
          .from(managerScope)
          .where(
            and(
              eq(managerScope.institutionId, scope.institutionId),
              inArray(managerScope.id, [...scope.managerScopeIds]),
            ),
          );

  assert(
    remainingAuditTrail.length === 0,
    "Run-owned auditTrail rows were removed by exact shift ownership",
  );
  assert(
    remainingShiftAudit.length === 0,
    "Run-scoped shift audit rows were removed",
  );
  assert(
    remainingAssignments.length === 0,
    "Run-scoped assignments were removed",
  );
  assert(remainingShifts.length === 0, "Run-scoped shifts were removed");
  assert(
    remainingManagerScopes.length === 0,
    "Run-created manager scopes were removed",
  );
}

export async function executeWorkflow(
  runtime: WorkflowRuntime,
  config: ValidatedE2EEnvironment,
  plan: WorkflowRunPlan,
): Promise<void> {
  const db = await runtime.getDb();
  if (!db) throw new Error("Database connection failed.");

  const { and, eq, inArray, isNull, sql } = runtime.orm;
  const {
    hospitals,
    institutions,
    managerScope,
    professionalInstitutions,
    professionals,
    sectors,
    shiftAuditLog,
    shiftInstances,
    users,
  } = runtime.schema;

  let scope: WorkflowFixtureScope | null = null;

  try {
    const databaseResult = await db.execute(
      sql`SELECT DATABASE() AS database_name`,
    );
    const actualDatabase = String(
      rowsFromExecute(databaseResult)[0]?.database_name ?? "",
    );
    assertConnectedDatabaseName(actualDatabase, config.databaseName);
    assert(
      actualDatabase === config.databaseName,
      "Connected database is the approved test database",
    );

    log("\n📋 PASSO A: Preparar cenário canônico", "blue");
    const [scenario] = await db
      .select({
        institutionId: institutions.id,
        institutionActive: institutions.isActive,
        hospitalId: hospitals.id,
        hospitalInstitutionId: hospitals.institutionId,
        sectorId: sectors.id,
        sectorInstitutionId: sectors.institutionId,
        sectorHospitalId: sectors.hospitalId,
      })
      .from(institutions)
      .innerJoin(hospitals, eq(hospitals.institutionId, institutions.id))
      .innerJoin(
        sectors,
        and(
          eq(sectors.institutionId, institutions.id),
          eq(sectors.hospitalId, hospitals.id),
        ),
      )
      .where(eq(institutions.isActive, true))
      .limit(1);
    if (!scenario) {
      throw new Error(
        "No active canonical institution/hospital/sector hierarchy found.",
      );
    }
    assertCanonicalScenario(scenario);

    scope = {
      runId: plan.runId,
      institutionId: scenario.institutionId,
      shiftIds: [],
      managerScopeIds: [],
    };

    const actorSelection = {
      id: professionals.id,
      userId: users.id,
      sessionVersion: users.sessionVersion,
      globalRole: users.role,
    };
    const selectActor = async (
      roles: readonly ("USER" | "GESTOR_MEDICO" | "GESTOR_PLUS")[],
      requestedUserId: number | null,
    ): Promise<CanonicalE2EActor | undefined> => {
      const rows = await db
        .select(actorSelection)
        .from(professionalInstitutions)
        .innerJoin(
          professionals,
          and(
            eq(professionals.id, professionalInstitutions.professionalId),
            eq(professionals.userId, professionalInstitutions.userId),
          ),
        )
        .innerJoin(
          users,
          and(
            eq(users.id, professionalInstitutions.userId),
            eq(users.approvalStatus, "APPROVED"),
            isNull(users.deletedAt),
          ),
        )
        .innerJoin(
          institutions,
          and(
            eq(institutions.id, professionalInstitutions.institutionId),
            eq(institutions.isActive, true),
          ),
        )
        .where(
          and(
            eq(professionalInstitutions.institutionId, scenario.institutionId),
            eq(professionalInstitutions.active, true),
            inArray(professionalInstitutions.roleInInstitution, [...roles]),
            requestedUserId
              ? eq(professionalInstitutions.userId, requestedUserId)
              : undefined,
          ),
        )
        .limit(1);
      return rows[0];
    };

    const userProfessional = await selectActor(["USER"], config.userId);
    const gestorProfessional = await selectActor(
      ["GESTOR_MEDICO", "GESTOR_PLUS"],
      config.gestorId,
    );
    assert(
      userProfessional,
      "Approved USER has an active canonical PI in the selected institution",
    );
    assert(
      gestorProfessional,
      "Approved GESTOR has an active canonical PI in the selected institution",
    );

    const [existingScope] = await db
      .select({ id: managerScope.id })
      .from(managerScope)
      .where(
        and(
          eq(managerScope.institutionId, scenario.institutionId),
          eq(managerScope.managerProfessionalId, gestorProfessional.id),
          eq(managerScope.hospitalId, scenario.hospitalId),
          eq(managerScope.sectorId, scenario.sectorId),
          eq(managerScope.active, true),
        ),
      )
      .limit(1);
    if (!existingScope) {
      const insertResult = await db.insert(managerScope).values({
        institutionId: scenario.institutionId,
        managerProfessionalId: gestorProfessional.id,
        hospitalId: scenario.hospitalId,
        sectorId: scenario.sectorId,
        active: true,
        createdAt: new Date(),
      });
      scope.managerScopeIds.push(
        insertIdFromResult(insertResult, "manager_scope insert"),
      );
    }

    const firstDay = await findAvailableBaseDate(
      db,
      sql,
      userProfessional.userId,
      [{ startHour: 7, endHour: 13 }],
      plan.searchOffsetDays,
    );
    const secondDay = await findAvailableBaseDate(
      db,
      sql,
      userProfessional.userId,
      [{ startHour: 13, endHour: 19 }],
      plan.searchOffsetDays + 1,
    );
    const conflictDay = await findAvailableBaseDate(
      db,
      sql,
      userProfessional.userId,
      [{ startHour: 14, endHour: 18 }],
      plan.searchOffsetDays + 2,
    );

    const insertShift = async (
      suffix: string,
      baseDay: Date,
      startHour: number,
      endHour: number,
    ): Promise<number> => {
      const startAt = new Date(baseDay);
      startAt.setUTCHours(startHour, 0, 0, 0);
      const endAt = new Date(baseDay);
      endAt.setUTCHours(endHour, 0, 0, 0);
      const insertResult = await db.insert(shiftInstances).values({
        institutionId: scenario.institutionId,
        hospitalId: scenario.hospitalId,
        sectorId: scenario.sectorId,
        startAt,
        endAt,
        label: `${plan.labelPrefix} - ${suffix}`,
        createdBy: gestorProfessional.userId,
      });
      const shiftId = insertIdFromResult(insertResult, `shift ${suffix}`);
      scope!.shiftIds.push(shiftId);
      return shiftId;
    };

    const morningShiftId = await insertShift("Manhã", firstDay, 7, 13);
    const afternoonShiftId = await insertShift("Tarde", secondDay, 13, 19);
    const conflictShiftAId = await insertShift(
      "Conflito A",
      conflictDay,
      14,
      18,
    );
    const conflictShiftBId = await insertShift(
      "Conflito B",
      conflictDay,
      14,
      18,
    );
    assert(
      scope.shiftIds.length === 4,
      "Four run-scoped shifts were created and tracked by exact id",
    );

    const userCaller = createCaller(
      runtime.appRouter,
      userProfessional,
      scenario.institutionId,
    );
    const gestorCaller = createCaller(
      runtime.appRouter,
      gestorProfessional,
      scenario.institutionId,
    );

    log("\n📋 PASSO B: USER assume vaga", "blue");
    const assumed = await userCaller.shiftAssignments.assumeVacancy({
      shiftInstanceId: morningShiftId,
    });
    assert(assumed, "assumeVacancy returned a result");
    const [pendingShift] = await db
      .select()
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.institutionId, scenario.institutionId),
          eq(shiftInstances.id, morningShiftId),
        ),
      )
      .limit(1);
    assert(pendingShift?.status === "PENDENTE", "Shift became PENDENTE");

    const pendingList = await gestorCaller.shiftAssignments.listPending();
    const pendingAssignment = pendingList.find(
      (entry: { shiftInstanceId: number }) =>
        entry.shiftInstanceId === morningShiftId,
    );
    assert(pendingAssignment, "GESTOR sees this run's pending assignment");
    await gestorCaller.shiftInstances.approveAssignment({
      assignmentId: pendingAssignment.assignmentId,
    });
    const [approvedShift] = await db
      .select()
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.institutionId, scenario.institutionId),
          eq(shiftInstances.id, morningShiftId),
        ),
      )
      .limit(1);
    assert(
      approvedShift?.status === "OCUPADO",
      "Approved shift became OCUPADO",
    );

    log("\n📋 PASSO C: rejeição", "blue");
    const rejectedCandidate = await userCaller.shiftAssignments.assumeVacancy({
      shiftInstanceId: afternoonShiftId,
    });
    await gestorCaller.shiftInstances.rejectAssignment({
      assignmentId: rejectedCandidate.assignmentId,
      reason: `E2E rejection ${plan.runId}`,
    });
    const [rejectedShift] = await db
      .select()
      .from(shiftInstances)
      .where(
        and(
          eq(shiftInstances.institutionId, scenario.institutionId),
          eq(shiftInstances.id, afternoonShiftId),
        ),
      )
      .limit(1);
    assert(rejectedShift?.status === "VAGO", "Rejected shift returned to VAGO");

    log("\n📋 PASSO D: conflito global", "blue");
    const conflictA = await userCaller.shiftAssignments.assumeVacancy({
      shiftInstanceId: conflictShiftAId,
    });
    await gestorCaller.shiftInstances.approveAssignment({
      assignmentId: conflictA.assignmentId,
    });

    let conflictBlocked = false;
    let conflictBAssignment: { assignmentId: number } | null = null;
    try {
      conflictBAssignment = await userCaller.shiftAssignments.assumeVacancy({
        shiftInstanceId: conflictShiftBId,
      });
    } catch (error) {
      if (!isConflictError(error)) throw error;
      conflictBlocked = true;
    }
    if (!conflictBlocked && conflictBAssignment) {
      try {
        await gestorCaller.shiftInstances.approveAssignment({
          assignmentId: conflictBAssignment.assignmentId,
        });
      } catch (error) {
        if (!isConflictError(error)) throw error;
        conflictBlocked = true;
      }
    }
    assert(conflictBlocked, "Global time conflict was rejected");

    const requiredAuditEvents = await db
      .select({ event: shiftAuditLog.event })
      .from(shiftAuditLog)
      .where(
        and(
          eq(shiftAuditLog.institutionId, scenario.institutionId),
          inArray(shiftAuditLog.shiftInstanceId, scope.shiftIds),
        ),
      );
    const events = new Set(
      requiredAuditEvents.map((entry: { event: string }) => entry.event),
    );
    assert(
      events.has("VACANCY_REQUESTED"),
      "Run-scoped audit contains VACANCY_REQUESTED",
    );
    assert(
      events.has("ASSIGNMENT_APPROVED"),
      "Run-scoped audit contains ASSIGNMENT_APPROVED",
    );
    assert(
      events.has("ASSIGNMENT_REJECTED"),
      "Run-scoped audit contains ASSIGNMENT_REJECTED",
    );
  } finally {
    if (scope) {
      const cleanupOperations = productionCleanupOperations(db, runtime);
      await cleanupTrackedFixtures(scope, cleanupOperations);
      await assertProductionCleanupComplete(db, runtime, scope);
      log(`🧽 Cleaned only fixtures tracked for run ${scope.runId}`, "cyan");
    }
  }
}

export async function runE2EWorkflowChildCore(
  runtime: WorkflowRuntime,
  config: ValidatedE2EEnvironment,
  plan: WorkflowRunPlan,
  execute: (
    runtime: WorkflowRuntime,
    config: ValidatedE2EEnvironment,
    plan: WorkflowRunPlan,
  ) => Promise<void> = executeWorkflow,
): Promise<void> {
  await withDedicatedWorkflowLock({
    expectedDatabase: config.databaseName,
    openConnection: () =>
      runtime.openWorkflowLockConnection(config.databaseUrl),
    readWorkflowFingerprint: async () => {
      const db = await runtime.getDb();
      if (!db) {
        throw new Error("Isolated E2E workflow pool could not be created.");
      }
      return runtime.readPoolFingerprint(db);
    },
    closeWorkflowResources: () => runtime.closeDb(),
    run: () => execute(runtime, config, plan),
  });
}

const INHERITED_CHILD_ENV_KEYS = [
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
] as const;

export function buildSanitizedE2EChildEnvironment(
  config: ValidatedE2EEnvironment,
  plan: WorkflowRunPlan,
  parentEnv: Environment = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of INHERITED_CHILD_ENV_KEYS) {
    const value = parentEnv[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    NODE_ENV: "test",
    TZ: "UTC",
    DATABASE_SSL: "false",
    DATABASE_URL: config.databaseUrl,
    E2E_DATABASE_URL: config.databaseUrl,
    E2E_WORKFLOW_ALLOW_DESTRUCTIVE: "1",
    E2E_WORKFLOW_CHILD: "1",
    E2E_WORKFLOW_RUN_ID: plan.runId,
  });
  if (config.userId !== null) env.E2E_USER_ID = String(config.userId);
  if (config.gestorId !== null) env.E2E_GESTOR_ID = String(config.gestorId);
  return env;
}

export function buildE2EChildProcessRequest(
  config: ValidatedE2EEnvironment,
  plan: WorkflowRunPlan,
  parentEnv: Environment = process.env,
): E2EChildProcessRequest {
  return {
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      fileURLToPath(new URL("./run-e2e-workflow-child.ts", import.meta.url)),
    ],
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: buildSanitizedE2EChildEnvironment(config, plan, parentEnv),
  };
}

async function runProductionChildProcess(
  request: E2EChildProcessRequest,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: { ...request.env },
      shell: false,
      stdio: "inherit",
    });
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0 && signal === null) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Isolated E2E child failed (${signal ? `signal ${signal}` : `exit ${String(code)}`}).`,
        ),
      );
    });
  });
}

/**
 * Public destructive entry point. It validates in the caller and then always
 * delegates mutations to a fresh Node/tsx child; no application DB singleton
 * from the caller can cross this process boundary.
 */
export async function runE2EWorkflow(
  options: {
    env?: Environment;
    runId?: string;
    childProcessRunner?: E2EChildProcessRunner;
  } = {},
): Promise<void> {
  const sourceEnv = options.env ?? process.env;
  const config = validateE2EWorkflowEnvironment(sourceEnv);
  const plan = buildWorkflowRunPlan(options.runId);
  log(
    `Validated destructive E2E target host=${config.host} port=${config.port} database=${config.databaseName}`,
    "cyan",
  );
  const request = buildE2EChildProcessRequest(config, plan, sourceEnv);
  await (options.childProcessRunner ?? runProductionChildProcess)(request);
}

async function main(): Promise<void> {
  log("\n🧪 Starting isolated destructive E2E workflow", "cyan");
  try {
    await runE2EWorkflow();
    log("🎉 E2E WORKFLOW PASSED", "green");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`❌ E2E WORKFLOW FAILED: ${message}`, "red");
    process.exitCode = 1;
  }
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) void main();
