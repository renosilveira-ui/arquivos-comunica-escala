import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  assertCanonicalScenario,
  assertConnectedDatabaseName,
  assertMatchingDatabaseFingerprint,
  assertProductionCleanupComplete,
  buildE2EChildProcessRequest,
  buildWorkflowRunPlan,
  cleanupTrackedFixtures,
  databaseFingerprintFromQueryResult,
  productionCleanupOperations,
  runE2EWorkflow,
  runE2EWorkflowChildCore,
  validateE2EWorkflowEnvironment,
  withDedicatedWorkflowLock,
  type DatabaseFingerprint,
  type DedicatedWorkflowLockConnection,
  type E2EChildProcessRequest,
  type WorkflowCleanupOperations,
  type WorkflowFixtureScope,
  type WorkflowRuntime,
} from "../scripts/run-e2e-workflow";
import { runE2EWorkflowChild } from "../scripts/run-e2e-workflow-child";

const SAFE_URL = "mysql://127.0.0.1:3306/escalas_test";
const SAFE_ENV = {
  NODE_ENV: "test",
  E2E_WORKFLOW_ALLOW_DESTRUCTIVE: "1",
  E2E_DATABASE_URL: SAFE_URL,
};
const EXTERNAL_AMBIENT_DATABASE_URL = "mysql://db.render.example/production";
const LOCAL_FINGERPRINT = {
  serverHost: "local-mysql",
  serverPort: 3306,
  databaseName: "escalas_test",
} satisfies DatabaseFingerprint;

function fingerprintRows(
  fingerprint: DatabaseFingerprint = LOCAL_FINGERPRINT,
): unknown {
  return [
    [
      {
        server_host: fingerprint.serverHost,
        server_port: fingerprint.serverPort,
        database_name: fingerprint.databaseName,
      },
    ],
    [],
  ];
}

const readLocalFingerprint = async (): Promise<DatabaseFingerprint> =>
  LOCAL_FINGERPRINT;
const closeNoopWorkflowResources = async (): Promise<void> => undefined;

describe("destructive E2E workflow guard", () => {
  it("requires every explicit opt-in and ignores ambient DATABASE_URL", async () => {
    const childProcessRunner = vi.fn();

    await expect(
      runE2EWorkflow({
        env: {
          NODE_ENV: "test",
          E2E_WORKFLOW_ALLOW_DESTRUCTIVE: "1",
          DATABASE_URL: EXTERNAL_AMBIENT_DATABASE_URL,
        },
        childProcessRunner,
      }),
    ).rejects.toThrow("explicit E2E_DATABASE_URL");
    expect(childProcessRunner).not.toHaveBeenCalled();

    expect(() =>
      validateE2EWorkflowEnvironment({
        E2E_WORKFLOW_ALLOW_DESTRUCTIVE: "1",
        E2E_DATABASE_URL: SAFE_URL,
      }),
    ).toThrow("NODE_ENV=test");
    expect(() =>
      validateE2EWorkflowEnvironment({
        NODE_ENV: "test",
        E2E_DATABASE_URL: SAFE_URL,
      }),
    ).toThrow("E2E_WORKFLOW_ALLOW_DESTRUCTIVE=1");
  });

  it("keeps a prewarmed external caller pool isolated and sends only canonical child state", async () => {
    const parentPool = {
      databaseUrl: "mysql://external.example:3306/escalas_test",
      writes: 0,
    };
    const deprecatedCallerRuntimeLoader = vi.fn(async () => {
      parentPool.writes += 1;
      throw new Error("caller runtime must never load");
    });
    const childWrites: string[] = [];
    const childProcessRunner = vi.fn(
      async (request: E2EChildProcessRequest) => {
        expect(request.command).toBe(process.execPath);
        expect(request.args.slice(0, 2)).toEqual(["--import", "tsx"]);
        expect(request.args.at(-1)).toMatch(
          /scripts\/run-e2e-workflow-child\.ts$/,
        );
        expect(request.env.DATABASE_URL).toBe(SAFE_URL);
        expect(request.env.E2E_DATABASE_URL).toBe(SAFE_URL);
        expect(request.env.E2E_WORKFLOW_CHILD).toBe("1");
        expect(request.env.NODE_OPTIONS).toBeUndefined();
        expect(request.env.COMUNICA_PLUS_OUTBOUND_ENABLED).toBeUndefined();
        childWrites.push(request.env.DATABASE_URL);
      },
    );

    const options = {
      env: {
        ...SAFE_ENV,
        DATABASE_URL: parentPool.databaseUrl,
        NODE_OPTIONS: "--require=/tmp/ambient-hook.cjs",
        COMUNICA_PLUS_OUTBOUND_ENABLED: "1",
      },
      runId: "10000000-0000-4000-8000-000000000001",
      childProcessRunner,
      // Mutation sentinel for the exact stopped implementation: an unknown
      // legacy `loadRuntime` field must remain unreachable from this facade.
      loadRuntime: deprecatedCallerRuntimeLoader,
    } as Parameters<typeof runE2EWorkflow>[0] & {
      loadRuntime: typeof deprecatedCallerRuntimeLoader;
    };
    await runE2EWorkflow(options);

    expect(parentPool.writes).toBe(0);
    expect(deprecatedCallerRuntimeLoader).not.toHaveBeenCalled();
    expect(childWrites).toEqual([SAFE_URL]);
    expect(childProcessRunner).toHaveBeenCalledTimes(1);
  });

  it.each([
    "mysql://db.render.com/escalas_test",
    "mysql://db.supabase.co/escalas_test",
    "mysql://10.0.0.8/escalas_test",
    "mysql://[::1]/escalas_test",
    "mysql://127.0.0.1/production",
    "postgresql://127.0.0.1/escalas_test",
    "mysql://127.0.0.1/escalas_test?socketPath=%2Ftmp%2Fmysql.sock",
    "mysql://127.0.0.1/escalas_test?ssl=true",
    "mysql://127.0.0.1/escalas_test?connectTimeout=1",
    "mysql://127.0.0.1/escalas_test?",
    "mysql://127.0.0.1/escalas_test#alternate-target",
    "mysql://127.0.0.1/escalas_test#",
  ])(
    "rejects unsafe target %s before spawning or loading database code",
    async (databaseUrl) => {
      const childProcessRunner = vi.fn();
      await expect(
        runE2EWorkflow({
          env: { ...SAFE_ENV, E2E_DATABASE_URL: databaseUrl },
          childProcessRunner,
        }),
      ).rejects.toThrow();
      expect(childProcessRunner).not.toHaveBeenCalled();
    },
  );

  it("accepts only an explicit local allowlisted test target", () => {
    const validated = validateE2EWorkflowEnvironment(SAFE_ENV);
    expect(validated).toMatchObject({
      databaseUrl: SAFE_URL,
      databaseName: "escalas_test",
      host: "127.0.0.1",
      port: "3306",
      username: "",
      password: "",
    });
    const credentialed = validateE2EWorkflowEnvironment({
      ...SAFE_ENV,
      E2E_DATABASE_URL: "mysql://runner%40local:p%3Ass@LOCALHOST/escalas_test",
    });
    expect(credentialed).toMatchObject({
      databaseUrl: "mysql://runner%40local:p%3Ass@127.0.0.1:3306/escalas_test",
      host: "127.0.0.1",
      username: "runner@local",
      password: "p:ss",
    });
    expect(
      buildE2EChildProcessRequest(
        credentialed,
        buildWorkflowRunPlan("10000000-0000-4000-8000-000000000001"),
        { NODE_OPTIONS: "--inspect", PATH: "/safe/bin" },
      ).env,
    ).toMatchObject({
      PATH: "/safe/bin",
      DATABASE_URL: "mysql://runner%40local:p%3Ass@127.0.0.1:3306/escalas_test",
      DATABASE_SSL: "false",
    });
  });

  it("revalidates child identity and canonical target before invoking its DB loader", async () => {
    const loadRuntime = vi.fn();
    const childEnv = {
      ...SAFE_ENV,
      DATABASE_SSL: "false",
      DATABASE_URL: "mysql://external.example:3306/escalas_test",
      E2E_WORKFLOW_CHILD: "1",
      E2E_WORKFLOW_RUN_ID: "10000000-0000-4000-8000-000000000001",
    };

    await expect(
      runE2EWorkflowChild(childEnv, loadRuntime as never),
    ).rejects.toThrow("DATABASE_URL must equal");
    expect(loadRuntime).not.toHaveBeenCalled();

    await expect(
      runE2EWorkflowChild(
        { ...childEnv, DATABASE_URL: SAFE_URL, E2E_WORKFLOW_CHILD: "0" },
        loadRuntime as never,
      ),
    ).rejects.toThrow("parent-process marker");
    expect(loadRuntime).not.toHaveBeenCalled();
  });

  it("sanitizes the child environment before the production runtime loader boundary", async () => {
    const originalEnvironment = { ...process.env };
    const loaderError = new Error("stop after sanitized loader observation");
    const loadRuntime = vi.fn(async () => {
      expect(process.env.DATABASE_URL).toBe(SAFE_URL);
      expect(process.env.DATABASE_SSL).toBe("false");
      expect(process.env.NODE_OPTIONS).toBeUndefined();
      expect(process.env.COMUNICA_PLUS_OUTBOUND_ENABLED).toBeUndefined();
      throw loaderError;
    });
    try {
      await expect(
        runE2EWorkflowChild(
          {
            ...SAFE_ENV,
            DATABASE_SSL: "false",
            DATABASE_URL: SAFE_URL,
            E2E_WORKFLOW_CHILD: "1",
            E2E_WORKFLOW_RUN_ID: "10000000-0000-4000-8000-000000000001",
            NODE_OPTIONS: "--require=/tmp/ambient-hook.cjs",
            COMUNICA_PLUS_OUTBOUND_ENABLED: "1",
          },
          loadRuntime as never,
        ),
      ).rejects.toBe(loaderError);
      expect(loadRuntime).toHaveBeenCalledTimes(1);
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, originalEnvironment);
    }
  });

  it("requires SELECT DATABASE() to match the validated allowlisted name exactly", () => {
    expect(() =>
      assertConnectedDatabaseName("escalas_test", "escalas_test"),
    ).not.toThrow();
    expect(() =>
      assertConnectedDatabaseName("escalas", "escalas_test"),
    ).toThrow("Connected database mismatch");
  });

  it("requires lock and workflow pools to prove the same host, port, and database", () => {
    expect(databaseFingerprintFromQueryResult(fingerprintRows())).toEqual(
      LOCAL_FINGERPRINT,
    );
    expect(() =>
      assertMatchingDatabaseFingerprint(LOCAL_FINGERPRINT, LOCAL_FINGERPRINT),
    ).not.toThrow();
    for (const mutation of [
      { ...LOCAL_FINGERPRINT, serverHost: "external-mysql" },
      { ...LOCAL_FINGERPRINT, serverPort: 3307 },
      { ...LOCAL_FINGERPRINT, databaseName: "other_test" },
    ]) {
      expect(() =>
        assertMatchingDatabaseFingerprint(LOCAL_FINGERPRINT, mutation),
      ).toThrow("fingerprint does not match");
    }
  });

  it("accepts only a fully linked active institution-hospital-sector hierarchy", () => {
    const canonical = {
      institutionId: 11,
      institutionActive: true,
      hospitalId: 22,
      hospitalInstitutionId: 11,
      sectorId: 33,
      sectorInstitutionId: 11,
      sectorHospitalId: 22,
    };
    expect(() => assertCanonicalScenario(canonical)).not.toThrow();
    expect(() =>
      assertCanonicalScenario({ ...canonical, hospitalInstitutionId: 99 }),
    ).toThrow("Hospital belongs");
    expect(() =>
      assertCanonicalScenario({ ...canonical, sectorInstitutionId: 99 }),
    ).toThrow("Sector belongs to selected institution");
    expect(() =>
      assertCanonicalScenario({ ...canonical, sectorHospitalId: 99 }),
    ).toThrow("Sector belongs to selected hospital");
    expect(() =>
      assertCanonicalScenario({ ...canonical, institutionActive: false }),
    ).toThrow("Institution is active");
  });

  it("derives unique run labels and deterministic scheduling buckets", () => {
    const first = buildWorkflowRunPlan("10000000-0000-4000-8000-000000000001");
    const second = buildWorkflowRunPlan("20000000-0000-4000-8000-000000000002");
    expect(first.runId).not.toBe(second.runId);
    expect(first.labelPrefix).not.toBe(second.labelPrefix);
    expect(first.searchOffsetDays).not.toBe(second.searchOffsetDays);
  });

  it("removes late audit rows owned by exact shifts and preserves sibling runs and tenants", async () => {
    type Row = {
      institutionId: number;
      id: number;
      shiftId?: number;
      entityId?: number;
      entityType?: string;
    };
    const auditTrail: Row[] = [
      {
        institutionId: 11,
        id: 1,
        shiftId: 101,
        entityType: "SHIFT_ASSIGNMENT",
      },
      { institutionId: 11, id: 2, shiftId: 202 },
      { institutionId: 12, id: 3, shiftId: 101 },
      {
        institutionId: 11,
        id: 4,
        entityId: 101,
        entityType: "SHIFT_INSTANCE",
      },
      {
        institutionId: 11,
        id: 5,
        shiftId: 303,
        entityId: 101,
        entityType: "SHIFT_ASSIGNMENT",
      },
    ];
    const shiftAudit: Row[] = [
      { institutionId: 11, id: 10, shiftId: 101 },
      { institutionId: 11, id: 20, shiftId: 202 },
    ];
    const assignments: Row[] = [
      { institutionId: 11, id: 4, shiftId: 101 },
      { institutionId: 11, id: 5, shiftId: 202 },
    ];
    const shifts: Row[] = [
      { institutionId: 11, id: 101 },
      { institutionId: 11, id: 202 },
      { institutionId: 12, id: 101 },
    ];
    const scopes: Row[] = [
      { institutionId: 11, id: 301 },
      { institutionId: 11, id: 302 },
      // Impossible under the real global PK, but intentionally adversarial:
      // it makes the institution predicate load-bearing in this query model.
      { institutionId: 12, id: 301 },
    ];
    type TableName =
      | "auditTrail"
      | "managerScope"
      | "shiftAssignmentsV2"
      | "shiftAuditLog"
      | "shiftInstances";
    type Column = {
      key: "id" | "institutionId" | "shiftId" | "entityId" | "entityType";
      table: TableName;
    };
    type Predicate =
      | { column: Column; kind: "eq"; value: number | string }
      | {
          column: Column;
          kind: "in";
          values: readonly (number | string)[];
        }
      | { clauses: readonly Predicate[]; kind: "and" | "or" };
    type Table = {
      id: Column;
      institutionId: Column;
      name: TableName;
      shiftInstanceId?: Column;
      entityId?: Column;
      entityType?: Column;
    };
    const table = (name: TableName, withShiftId: boolean): Table => ({
      id: { key: "id", table: name },
      institutionId: { key: "institutionId", table: name },
      name,
      ...(withShiftId
        ? { shiftInstanceId: { key: "shiftId", table: name } as Column }
        : {}),
      ...(name === "auditTrail"
        ? {
            entityId: { key: "entityId", table: name } as Column,
            entityType: { key: "entityType", table: name } as Column,
          }
        : {}),
    });
    const schema = {
      auditTrail: table("auditTrail", true),
      managerScope: table("managerScope", false),
      shiftAssignmentsV2: table("shiftAssignmentsV2", true),
      shiftAuditLog: table("shiftAuditLog", true),
      shiftInstances: table("shiftInstances", false),
    };
    const rowsByTable: Record<TableName, Row[]> = {
      auditTrail,
      managerScope: scopes,
      shiftAssignmentsV2: assignments,
      shiftAuditLog: shiftAudit,
      shiftInstances: shifts,
    };
    const matches = (predicate: Predicate, row: Row): boolean => {
      if (predicate.kind === "and") {
        return predicate.clauses.every((clause) => matches(clause, row));
      }
      if (predicate.kind === "or") {
        return predicate.clauses.some((clause) => matches(clause, row));
      }
      const rowValue = row[predicate.column.key];
      return predicate.kind === "eq"
        ? rowValue === predicate.value
        : predicate.values.includes(rowValue);
    };
    let auditDeletePasses = 0;
    const db = {
      delete: (selectedTable: Table) => ({
        where: async (predicate: Predicate) => {
          const rows = rowsByTable[selectedTable.name];
          for (let index = rows.length - 1; index >= 0; index -= 1) {
            if (matches(predicate, rows[index])) rows.splice(index, 1);
          }
          if (
            selectedTable.name === "auditTrail" &&
            auditDeletePasses++ === 0
          ) {
            // A row committed after the first delete must be caught by the
            // bounded fixed-point pass, because shift 101 belongs to run one.
            auditTrail.push({ institutionId: 11, id: 99, shiftId: 101 });
          }
        },
      }),
      select: () => ({
        from: (selectedTable: Table) => ({
          where: async (predicate: Predicate) =>
            rowsByTable[selectedTable.name]
              .filter((row) => matches(predicate, row))
              .map((row) => ({ id: row.id })),
        }),
      }),
    };
    const runtime = {
      orm: {
        and: (...clauses: Predicate[]) =>
          ({ clauses, kind: "and" }) as Predicate,
        or: (...clauses: Predicate[]) => ({ clauses, kind: "or" }) as Predicate,
        eq: (column: Column, value: number | string) =>
          ({ column, kind: "eq", value }) as Predicate,
        inArray: (column: Column, values: readonly (number | string)[]) =>
          ({ column, kind: "in", values }) as Predicate,
      },
      schema,
    } as never;
    const operations = productionCleanupOperations(db, runtime);
    const first: WorkflowFixtureScope = {
      runId: "10000000-0000-4000-8000-000000000001",
      institutionId: 11,
      shiftIds: [101],
      managerScopeIds: [301],
    };
    const second: WorkflowFixtureScope = {
      runId: "20000000-0000-4000-8000-000000000002",
      institutionId: 11,
      shiftIds: [202],
      managerScopeIds: [302],
    };

    const wait = vi.fn(async () => undefined);
    await expect(
      assertProductionCleanupComplete(db, runtime, first),
    ).rejects.toThrow("Run-owned auditTrail rows");
    await cleanupTrackedFixtures(first, operations, {
      quiescenceDelayMs: 0,
      wait,
    });
    await assertProductionCleanupComplete(db, runtime, first);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(auditTrail).toEqual([
      { institutionId: 11, id: 2, shiftId: 202 },
      { institutionId: 12, id: 3, shiftId: 101 },
      {
        institutionId: 11,
        id: 5,
        shiftId: 303,
        entityId: 101,
        entityType: "SHIFT_ASSIGNMENT",
      },
    ]);
    expect(shiftAudit).toEqual([{ institutionId: 11, id: 20, shiftId: 202 }]);
    expect(assignments).toEqual([{ institutionId: 11, id: 5, shiftId: 202 }]);
    expect(shifts).toEqual([
      { institutionId: 11, id: 202 },
      { institutionId: 12, id: 101 },
    ]);
    expect(scopes).toEqual([
      { institutionId: 11, id: 302 },
      { institutionId: 12, id: 301 },
    ]);

    await cleanupTrackedFixtures(second, operations, {
      quiescenceDelayMs: 0,
      wait,
    });
    await assertProductionCleanupComplete(db, runtime, second);
    expect(wait).toHaveBeenCalledTimes(3);
    expect(auditTrail).toEqual([
      { institutionId: 12, id: 3, shiftId: 101 },
      {
        institutionId: 11,
        id: 5,
        shiftId: 303,
        entityId: 101,
        entityType: "SHIFT_ASSIGNMENT",
      },
    ]);
    expect(shiftAudit).toEqual([]);
    expect(assignments).toEqual([]);
    expect(shifts).toEqual([{ institutionId: 12, id: 101 }]);
    expect(scopes).toEqual([{ institutionId: 12, id: 301 }]);
  });

  it("fails closed when run-owned audit rows never reach bounded quiescence", async () => {
    const deleteManagerScopeRows = vi.fn(async () => undefined);
    const operations: WorkflowCleanupOperations = {
      deleteAssignmentRows: vi.fn(async () => undefined),
      deleteAuditTrailRows: vi.fn(async () => undefined),
      deleteManagerScopeRows,
      deleteShiftAuditRows: vi.fn(async () => undefined),
      deleteShiftRows: vi.fn(async () => undefined),
      findAuditTrailIds: vi.fn(async () => [901]),
    };
    const scope: WorkflowFixtureScope = {
      institutionId: 11,
      managerScopeIds: [301],
      runId: "10000000-0000-4000-8000-000000000001",
      shiftIds: [101],
    };

    await expect(
      cleanupTrackedFixtures(scope, operations, {
        quiescenceDelayMs: 0,
        wait: async () => undefined,
      }),
    ).rejects.toThrow("did not reach bounded quiescence");
    expect(operations.findAuditTrailIds).toHaveBeenCalledTimes(8);
    expect(deleteManagerScopeRows).toHaveBeenCalledWith(11, [301]);
  });

  it("preserves the exact primary fixture error after exact manager cleanup succeeds", async () => {
    const primaryError = new Error("synthetic primary fixture cleanup failure");
    const deleteManagerScopeRows = vi.fn(async () => undefined);
    const operations: WorkflowCleanupOperations = {
      deleteAssignmentRows: vi.fn(async () => undefined),
      deleteAuditTrailRows: vi.fn(async () => undefined),
      deleteManagerScopeRows,
      deleteShiftAuditRows: vi.fn(async () => {
        throw primaryError;
      }),
      deleteShiftRows: vi.fn(async () => undefined),
      findAuditTrailIds: vi.fn(async () => []),
    };
    const scope: WorkflowFixtureScope = {
      institutionId: 11,
      managerScopeIds: [301],
      runId: "10000000-0000-4000-8000-000000000001",
      shiftIds: [101],
    };

    let received: unknown;
    try {
      await cleanupTrackedFixtures(scope, operations, {
        quiescenceDelayMs: 0,
        wait: async () => undefined,
      });
    } catch (error) {
      received = error;
    }

    expect(received).toBe(primaryError);
    expect(deleteManagerScopeRows).toHaveBeenCalledWith(11, [301]);
  });

  it("aggregates quiescence and exact manager-scope cleanup failures in order", async () => {
    const managerCleanupError = new Error("synthetic manager cleanup failure");
    const deleteManagerScopeRows = vi.fn(async () => {
      throw managerCleanupError;
    });
    const operations: WorkflowCleanupOperations = {
      deleteAssignmentRows: vi.fn(async () => undefined),
      deleteAuditTrailRows: vi.fn(async () => undefined),
      deleteManagerScopeRows,
      deleteShiftAuditRows: vi.fn(async () => undefined),
      deleteShiftRows: vi.fn(async () => undefined),
      findAuditTrailIds: vi.fn(async () => [901]),
    };
    const scope: WorkflowFixtureScope = {
      institutionId: 11,
      managerScopeIds: [301],
      runId: "10000000-0000-4000-8000-000000000001",
      shiftIds: [101],
    };

    let received: unknown;
    try {
      await cleanupTrackedFixtures(scope, operations, {
        quiescenceDelayMs: 0,
        wait: async () => undefined,
      });
    } catch (error) {
      received = error;
    }

    expect(received).toBeInstanceOf(AggregateError);
    const aggregate = received as AggregateError;
    expect(aggregate.message).toBe(
      "Run-owned fixture cleanup failed in multiple exact scopes.",
    );
    expect(aggregate.errors[0]).toMatchObject({
      message: "Run-owned auditTrail rows did not reach bounded quiescence.",
    });
    expect(aggregate.errors[1]).toBe(managerCleanupError);
    expect(deleteManagerScopeRows).toHaveBeenCalledWith(11, [301]);
  });

  it("acquires and releases the advisory lock on the same dedicated connection", async () => {
    const statements: string[] = [];
    let ended = false;
    const connection: DedicatedWorkflowLockConnection = {
      async query(statement) {
        statements.push(statement);
        if (statement.includes("DATABASE()")) {
          return fingerprintRows();
        }
        if (statement.includes("GET_LOCK")) {
          return [[{ acquired: 1 }], []];
        }
        if (statement.includes("RELEASE_LOCK")) {
          return [[{ released: 1 }], []];
        }
        throw new Error(`Unexpected statement: ${statement}`);
      },
      async end() {
        ended = true;
      },
    };
    const openConnection = vi.fn(async () => connection);
    const writes = vi.fn(async () => {
      statements.push("WORKFLOW_WITH_CLEANUP_AND_ASSERT");
      return "completed";
    });

    await expect(
      withDedicatedWorkflowLock({
        expectedDatabase: "escalas_test",
        openConnection,
        readWorkflowFingerprint: async () => {
          statements.push("POOL_FINGERPRINT");
          return LOCAL_FINGERPRINT;
        },
        closeWorkflowResources: async () => {
          statements.push("CLOSE_WORKFLOW_POOL");
        },
        run: writes,
      }),
    ).resolves.toBe("completed");

    expect(openConnection).toHaveBeenCalledTimes(1);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(
      statements.filter((entry) => entry.includes("GET_LOCK")),
    ).toHaveLength(1);
    expect(
      statements.filter((entry) => entry.includes("RELEASE_LOCK")),
    ).toHaveLength(1);
    expect(statements).toEqual([
      "SELECT @@hostname AS server_host, @@port AS server_port, DATABASE() AS database_name",
      "SELECT GET_LOCK(?, ?) AS acquired",
      "POOL_FINGERPRINT",
      "WORKFLOW_WITH_CLEANUP_AND_ASSERT",
      "CLOSE_WORKFLOW_POOL",
      "SELECT RELEASE_LOCK(?) AS released",
    ]);
    expect(ended).toBe(true);
  });

  it.each([0, null])(
    "does not start workflow writes when lock acquisition returns %s",
    async (acquired) => {
      const statements: string[] = [];
      let ended = false;
      const connection: DedicatedWorkflowLockConnection = {
        async query(statement) {
          statements.push(statement);
          if (statement.includes("DATABASE()")) {
            return fingerprintRows();
          }
          if (statement.includes("GET_LOCK")) {
            return [[{ acquired }], []];
          }
          throw new Error(`Unexpected statement: ${statement}`);
        },
        async end() {
          ended = true;
        },
      };
      const writes = vi.fn(async () => undefined);
      const readWorkflowFingerprint = vi.fn(readLocalFingerprint);
      const closeWorkflowResources = vi.fn(closeNoopWorkflowResources);

      await expect(
        withDedicatedWorkflowLock({
          expectedDatabase: "escalas_test",
          openConnection: async () => connection,
          readWorkflowFingerprint,
          closeWorkflowResources,
          run: writes,
          timeoutSeconds: 0,
        }),
      ).rejects.toThrow("Could not acquire");

      expect(writes).not.toHaveBeenCalled();
      expect(readWorkflowFingerprint).not.toHaveBeenCalled();
      expect(closeWorkflowResources).not.toHaveBeenCalled();
      expect(statements.some((entry) => entry.includes("RELEASE_LOCK"))).toBe(
        false,
      );
      expect(ended).toBe(true);
    },
  );

  it("rejects a dedicated connection target mismatch before workflow writes", async () => {
    const statements: string[] = [];
    let ended = false;
    const writes = vi.fn(async () => undefined);
    const readWorkflowFingerprint = vi.fn(readLocalFingerprint);
    const closeWorkflowResources = vi.fn(closeNoopWorkflowResources);
    const connection: DedicatedWorkflowLockConnection = {
      async query(statement) {
        statements.push(statement);
        return fingerprintRows({
          ...LOCAL_FINGERPRINT,
          databaseName: "not_escalas_test",
        });
      },
      async end() {
        ended = true;
      },
    };

    await expect(
      withDedicatedWorkflowLock({
        expectedDatabase: "escalas_test",
        openConnection: async () => connection,
        readWorkflowFingerprint,
        closeWorkflowResources,
        run: writes,
      }),
    ).rejects.toThrow("Connected database mismatch");

    expect(writes).not.toHaveBeenCalled();
    expect(readWorkflowFingerprint).not.toHaveBeenCalled();
    expect(closeWorkflowResources).not.toHaveBeenCalled();
    expect(statements).toEqual([
      "SELECT @@hostname AS server_host, @@port AS server_port, DATABASE() AS database_name",
    ]);
    expect(ended).toBe(true);
  });

  it("aborts before workflow writes when the pool fingerprint differs from the lock owner", async () => {
    const events: string[] = [];
    const writes = vi.fn(async () => undefined);
    const connection: DedicatedWorkflowLockConnection = {
      async query(statement) {
        events.push(statement);
        if (statement.includes("DATABASE()")) return fingerprintRows();
        if (statement.includes("GET_LOCK")) return [[{ acquired: 1 }], []];
        if (statement.includes("RELEASE_LOCK")) {
          return [[{ released: 1 }], []];
        }
        throw new Error(`Unexpected statement: ${statement}`);
      },
      async end() {
        events.push("END_LOCK_CONNECTION");
      },
    };

    await expect(
      withDedicatedWorkflowLock({
        expectedDatabase: "escalas_test",
        openConnection: async () => connection,
        readWorkflowFingerprint: async () => ({
          ...LOCAL_FINGERPRINT,
          serverHost: "external-mysql",
        }),
        closeWorkflowResources: async () => {
          events.push("CLOSE_WORKFLOW_POOL");
        },
        run: writes,
      }),
    ).rejects.toThrow("fingerprint does not match");

    expect(writes).not.toHaveBeenCalled();
    expect(events.indexOf("CLOSE_WORKFLOW_POOL")).toBeLessThan(
      events.indexOf("SELECT RELEASE_LOCK(?) AS released"),
    );
    expect(events.at(-1)).toBe("END_LOCK_CONNECTION");
  });

  it("closes the child pool before releasing the same dedicated owner when workflow throws", async () => {
    const statements: string[] = [];
    let ended = false;
    const connection: DedicatedWorkflowLockConnection = {
      async query(statement) {
        statements.push(statement);
        if (statement.includes("DATABASE()")) {
          return fingerprintRows();
        }
        if (statement.includes("GET_LOCK")) {
          return [[{ acquired: 1 }], []];
        }
        if (statement.includes("RELEASE_LOCK")) {
          return [[{ released: 1 }], []];
        }
        throw new Error(`Unexpected statement: ${statement}`);
      },
      async end() {
        ended = true;
      },
    };

    const runtime = {
      async closeDb() {
        statements.push("CLOSE_WORKFLOW_POOL");
      },
      async getDb() {
        statements.push("CREATE_WORKFLOW_POOL");
        return {};
      },
      async openWorkflowLockConnection() {
        return connection;
      },
      async readPoolFingerprint() {
        return LOCAL_FINGERPRINT;
      },
      appRouter: {},
      schema: {},
      orm: {},
    } satisfies WorkflowRuntime;

    await expect(
      runE2EWorkflowChildCore(
        runtime,
        validateE2EWorkflowEnvironment(SAFE_ENV),
        buildWorkflowRunPlan("10000000-0000-4000-8000-000000000001"),
        async () => {
          statements.push("WORKFLOW_THROW");
          throw new Error("synthetic workflow failure");
        },
      ),
    ).rejects.toThrow("synthetic workflow failure");

    expect(
      statements.filter((entry) => entry.includes("RELEASE_LOCK")),
    ).toHaveLength(1);
    expect(statements.indexOf("CLOSE_WORKFLOW_POOL")).toBeLessThan(
      statements.indexOf("SELECT RELEASE_LOCK(?) AS released"),
    );
    expect(ended).toBe(true);
  });

  it("still releases and ends the dedicated owner when child pool close fails", async () => {
    const events: string[] = [];
    const closeError = new Error("synthetic workflow pool close failure");
    const connection: DedicatedWorkflowLockConnection = {
      async query(statement) {
        events.push(statement);
        if (statement.includes("DATABASE()")) return fingerprintRows();
        if (statement.includes("GET_LOCK")) return [[{ acquired: 1 }], []];
        if (statement.includes("RELEASE_LOCK")) {
          return [[{ released: 1 }], []];
        }
        throw new Error(`Unexpected statement: ${statement}`);
      },
      async end() {
        events.push("END_LOCK_CONNECTION");
      },
    };

    let received: unknown;
    try {
      await withDedicatedWorkflowLock({
        expectedDatabase: "escalas_test",
        openConnection: async () => connection,
        readWorkflowFingerprint: readLocalFingerprint,
        closeWorkflowResources: async () => {
          events.push("CLOSE_WORKFLOW_POOL");
          throw closeError;
        },
        run: async () => undefined,
      });
    } catch (error) {
      received = error;
    }

    expect(received).toBeInstanceOf(AggregateError);
    expect((received as AggregateError).errors).toEqual([closeError]);
    expect(events.indexOf("CLOSE_WORKFLOW_POOL")).toBeLessThan(
      events.indexOf("SELECT RELEASE_LOCK(?) AS released"),
    );
    expect(events.at(-1)).toBe("END_LOCK_CONNECTION");
  });

  it("fails closed and still closes when the dedicated owner cannot prove release", async () => {
    let ended = false;
    const connection: DedicatedWorkflowLockConnection = {
      async query(statement) {
        if (statement.includes("DATABASE()")) {
          return fingerprintRows();
        }
        if (statement.includes("GET_LOCK")) {
          return [[{ acquired: 1 }], []];
        }
        if (statement.includes("RELEASE_LOCK")) {
          return [[{ released: 0 }], []];
        }
        throw new Error(`Unexpected statement: ${statement}`);
      },
      async end() {
        ended = true;
      },
    };

    await expect(
      withDedicatedWorkflowLock({
        expectedDatabase: "escalas_test",
        openConnection: async () => connection,
        readWorkflowFingerprint: readLocalFingerprint,
        closeWorkflowResources: closeNoopWorkflowResources,
        run: async () => undefined,
      }),
    ).rejects.toThrow("Dedicated E2E lock finalization failed");
    expect(ended).toBe(true);
  });

  it("serializes two concurrent full public calls until the first child closes its pool and releases", async () => {
    type Waiter = {
      connectionId: string;
      resolve: (value: unknown) => void;
    };
    type LockState = {
      owner: string | null;
      waiters: Waiter[];
    };
    const expectedWorkflowLockName = "escalas-e2e-workflow-v2";
    const events: string[] = [];
    const locks = new Map<string, LockState>();
    const lockState = (lockName: string): LockState => {
      const existing = locks.get(lockName);
      if (existing) return existing;
      const created = { owner: null, waiters: [] } satisfies LockState;
      locks.set(lockName, created);
      return created;
    };
    let signalWaiterQueued: (() => void) | null = null;
    const waiterQueued = new Promise<void>((resolve) => {
      signalWaiterQueued = resolve;
    });
    const connection = (
      connectionId: string,
    ): DedicatedWorkflowLockConnection => ({
      async query(statement, values = []) {
        if (statement.includes("DATABASE()")) {
          events.push(`${connectionId}:database`);
          return fingerprintRows();
        }
        const lockName = values[0];
        if (typeof lockName !== "string" || lockName.length === 0) {
          throw new Error("Advisory lock query requires an exact lock name.");
        }
        const state = lockState(lockName);
        if (statement.includes("GET_LOCK")) {
          events.push(`${connectionId}:get-lock:${lockName}`);
          if (state.owner === null) {
            state.owner = connectionId;
            return [[{ acquired: 1 }], []];
          }
          return new Promise((resolve) => {
            state.waiters.push({ connectionId, resolve });
            signalWaiterQueued?.();
          });
        }
        if (statement.includes("RELEASE_LOCK")) {
          events.push(`${connectionId}:release-lock:${lockName}`);
          if (state.owner !== connectionId) return [[{ released: 0 }], []];
          state.owner = null;
          const next = state.waiters.shift();
          if (next) {
            state.owner = next.connectionId;
            next.resolve([[{ acquired: 1 }], []]);
          }
          return [[{ released: 1 }], []];
        }
        throw new Error(`Unexpected statement: ${statement}`);
      },
      async end() {
        events.push(`${connectionId}:end`);
      },
    });
    let allowFirstToFinish: (() => void) | null = null;
    const firstMayFinish = new Promise<void>((resolve) => {
      allowFirstToFinish = resolve;
    });
    let signalFirstStarted: (() => void) | null = null;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    const runOrder: string[] = [];

    const firstRunId = "10000000-0000-4000-8000-000000000001";
    const secondRunId = "20000000-0000-4000-8000-000000000002";
    const childProcessRunner = async (
      request: E2EChildProcessRequest,
    ): Promise<void> => {
      const config = validateE2EWorkflowEnvironment(request.env);
      const plan = buildWorkflowRunPlan(request.env.E2E_WORKFLOW_RUN_ID);
      const connectionId = plan.runId === firstRunId ? "first" : "second";
      const runtime = {
        async closeDb() {
          events.push(`${connectionId}:close-pool`);
        },
        async getDb() {
          return {};
        },
        async openWorkflowLockConnection() {
          return connection(connectionId);
        },
        async readPoolFingerprint() {
          return LOCAL_FINGERPRINT;
        },
        appRouter: {},
        schema: {},
        orm: {},
      } satisfies WorkflowRuntime;
      await runE2EWorkflowChildCore(runtime, config, plan, async () => {
        runOrder.push(`${connectionId}:start`);
        if (connectionId === "first") {
          signalFirstStarted?.();
          await firstMayFinish;
        }
        runOrder.push(`${connectionId}:end`);
      });
    };

    const first = runE2EWorkflow({
      env: SAFE_ENV,
      runId: firstRunId,
      childProcessRunner,
    });
    await firstStarted;
    const second = runE2EWorkflow({
      env: SAFE_ENV,
      runId: secondRunId,
      childProcessRunner,
    });
    await waiterQueued;

    expect(runOrder).toEqual(["first:start"]);
    allowFirstToFinish?.();
    await Promise.all([first, second]);

    expect(runOrder).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
    expect(events.filter((event) => event.includes(":get-lock:"))).toEqual([
      `first:get-lock:${expectedWorkflowLockName}`,
      `second:get-lock:${expectedWorkflowLockName}`,
    ]);
    expect(events.filter((event) => event.includes(":release-lock:"))).toEqual([
      `first:release-lock:${expectedWorkflowLockName}`,
      `second:release-lock:${expectedWorkflowLockName}`,
    ]);
    expect(events.indexOf("first:close-pool")).toBeLessThan(
      events.indexOf(`first:release-lock:${expectedWorkflowLockName}`),
    );
    expect(events.indexOf("second:close-pool")).toBeLessThan(
      events.indexOf(`second:release-lock:${expectedWorkflowLockName}`),
    );
    expect(events).toContain("first:end");
    expect(events).toContain("second:end");

    // Negative control: unlike two workflow runs, distinct lock names are
    // independent in MySQL and therefore must both acquire without waiting.
    const distinctA = connection("distinct-a");
    const distinctB = connection("distinct-b");
    await expect(
      Promise.all([
        distinctA.query("SELECT GET_LOCK(?, ?) AS acquired", [
          "control-lock-a",
          0,
        ]),
        distinctB.query("SELECT GET_LOCK(?, ?) AS acquired", [
          "control-lock-b",
          0,
        ]),
      ]),
    ).resolves.toEqual([
      [[{ acquired: 1 }], []],
      [[{ acquired: 1 }], []],
    ]);
    await distinctA.query("SELECT RELEASE_LOCK(?) AS released", [
      "control-lock-a",
    ]);
    await distinctB.query("SELECT RELEASE_LOCK(?) AS released", [
      "control-lock-b",
    ]);
  });

  it("executes the actual default gate with an ambient external DATABASE_URL and no destructive opt-in", async () => {
    if (process.env.E2E_DEFAULT_GATE_CHILD === "1") return;

    const childEnvironment = {
      ...process.env,
      DATABASE_URL: EXTERNAL_AMBIENT_DATABASE_URL,
      E2E_DEFAULT_GATE_CHILD: "1",
    };
    delete childEnvironment.E2E_DATABASE_URL;
    delete childEnvironment.E2E_WORKFLOW_ALLOW_DESTRUCTIVE;
    const result = spawnSync("pnpm", ["gate"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: childEnvironment,
      encoding: "utf8",
      timeout: 60_000,
    });

    expect({
      error: result.error?.message,
      signal: result.signal,
      stderr: result.stderr,
      stdout: result.stdout,
      status: result.status,
    }).toMatchObject({
      error: undefined,
      signal: null,
      status: 0,
    });
  });

  it("wires only the isolated guard into the default gate and keeps destruction explicit", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts["test:e2e"]).toBe(
      "cross-env NODE_ENV=test vitest run --config vitest.e2e-guard.config.ts",
    );
    expect(packageJson.scripts.gate).toBe("pnpm test:e2e");
    expect(packageJson.scripts["e2e:workflow:destructive"]).toBe(
      "tsx scripts/run-e2e-workflow.ts",
    );
    expect(packageJson.scripts["gate:destructive"]).toBe(
      "pnpm test:e2e && pnpm e2e:workflow:destructive",
    );
    expect(packageJson.scripts["e2e:workflow"]).toBeUndefined();
  });
});
