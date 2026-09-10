import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import {
  assertConnectedDatabaseName,
  deriveDisposableChildTestTarget,
  destructiveTargetFingerprint,
  DISPOSABLE_TEST_TARGET_MARKER_SELECT,
  DISPOSABLE_TEST_TARGET_MARKER_TABLE,
  DISPOSABLE_TEST_TARGET_REQUIRED_TABLES,
  DISPOSABLE_TEST_TARGET_SCHEMA_SELECT,
  validateSeedAdminDestructiveTarget,
  validateSeedStagingDestructiveTarget,
  validateStandardTestDestructiveTarget,
} from "../scripts/destructive-target-fence";
import { prepareStandardTestDatabase } from "../scripts/prepare-standard-test-database";
import { seedTestData } from "../scripts/seed-test-data";

const SAFE_TEST_URL = "mysql://root:root@127.0.0.1:3306/escalas_test";
const SAFE_TEST_MARKER = "destructive-fence-unit-test-marker-v1";
const SAFE_TEST_ENV = {
  NODE_ENV: "test",
  TEST_DATABASE_ALLOW_DESTRUCTIVE: "1",
  TEST_DATABASE_EXPECTED_NAME: "escalas_test",
  TEST_DATABASE_DISPOSABLE_MARKER: SAFE_TEST_MARKER,
  TEST_DATABASE_URL: SAFE_TEST_URL,
};

describe("standard test destructive target fence", () => {
  it("accepts only the explicit local disposable database", () => {
    expect(validateStandardTestDestructiveTarget(SAFE_TEST_ENV)).toMatchObject({
      databaseUrl: SAFE_TEST_URL,
      databaseName: "escalas_test",
      host: "127.0.0.1",
      port: "3306",
    });
  });

  it("canonicalizes localhost and accepts explicit IPv6 loopback", () => {
    expect(
      validateStandardTestDestructiveTarget({
        ...SAFE_TEST_ENV,
        TEST_DATABASE_URL: "mysql://root:root@localhost/escalas_test",
      }),
    ).toMatchObject({ host: "127.0.0.1", port: "3306" });
    expect(
      validateStandardTestDestructiveTarget({
        ...SAFE_TEST_ENV,
        TEST_DATABASE_URL: "mysql://root:root@[::1]/escalas_test",
      }),
    ).toMatchObject({ host: "[::1]", port: "3306" });
  });

  it("binds the disposable marker to host, port and database", () => {
    const defaultPort = validateStandardTestDestructiveTarget(SAFE_TEST_ENV);
    const alternatePort = validateStandardTestDestructiveTarget({
      ...SAFE_TEST_ENV,
      TEST_DATABASE_URL: "mysql://root:root@127.0.0.1:3307/escalas_test",
    });
    expect(alternatePort.markerHash).not.toBe(defaultPort.markerHash);
  });

  it("derives a distinct marked child without changing server authority", () => {
    const parent = validateStandardTestDestructiveTarget(SAFE_TEST_ENV);
    const child = deriveDisposableChildTestTarget(
      parent,
      "escalas_test_wa_account_123_abcdef123456",
      "whatsapp-account-ownership-v1",
    );

    expect(child).toMatchObject({
      databaseName: "escalas_test_wa_account_123_abcdef123456",
      host: parent.host,
      port: parent.port,
    });
    expect(child.databaseUrl).toBe(
      "mysql://root:root@127.0.0.1:3306/escalas_test_wa_account_123_abcdef123456",
    );
    expect(child.fingerprint).not.toBe(parent.fingerprint);
    expect(child.markerHash).not.toBe(parent.markerHash);
  });

  it("refuses an unsafe, identical or unnamespaced child", () => {
    const parent = validateStandardTestDestructiveTarget(SAFE_TEST_ENV);
    expect(() =>
      deriveDisposableChildTestTarget(
        parent,
        parent.databaseName,
        "whatsapp-account-ownership-v1",
      ),
    ).toThrow("distinct explicit test database name");
    expect(() =>
      deriveDisposableChildTestTarget(
        parent,
        "production",
        "whatsapp-account-ownership-v1",
      ),
    ).toThrow("distinct explicit test database name");
    expect(() =>
      deriveDisposableChildTestTarget(
        parent,
        "escalas_test_wa_account_123_abcdef123456",
        "short",
      ),
    ).toThrow("8-64 character identifier");
  });

  it("allows an isolated local database only when its exact name is declared", () => {
    expect(
      validateStandardTestDestructiveTarget({
        NODE_ENV: "test",
        TEST_DATABASE_ALLOW_DESTRUCTIVE: "1",
        TEST_DATABASE_EXPECTED_NAME: "escalas_test_worker_2",
        TEST_DATABASE_DISPOSABLE_MARKER: SAFE_TEST_MARKER,
        TEST_DATABASE_URL:
          "mysql://root:root@127.0.0.1:3306/escalas_test_worker_2",
      }),
    ).toMatchObject({ databaseName: "escalas_test_worker_2" });
  });

  it("cannot relabel a local staging or production database as disposable", () => {
    for (const databaseName of ["escalas_staging", "escalas_production"]) {
      expect(() =>
        validateStandardTestDestructiveTarget({
          NODE_ENV: "test",
          TEST_DATABASE_ALLOW_DESTRUCTIVE: "1",
          TEST_DATABASE_EXPECTED_NAME: databaseName,
          TEST_DATABASE_DISPOSABLE_MARKER: SAFE_TEST_MARKER,
          TEST_DATABASE_URL: `mysql://root:root@127.0.0.1:3306/${databaseName}`,
        }),
      ).toThrow("disposable test database name");
    }
  });

  it("fails closed when NODE_ENV or the destructive opt-in diverges", () => {
    expect(() =>
      validateStandardTestDestructiveTarget({
        ...SAFE_TEST_ENV,
        NODE_ENV: "development",
      }),
    ).toThrow("NODE_ENV=test");
    expect(() =>
      validateStandardTestDestructiveTarget({
        ...SAFE_TEST_ENV,
        TEST_DATABASE_ALLOW_DESTRUCTIVE: undefined,
      }),
    ).toThrow("TEST_DATABASE_ALLOW_DESTRUCTIVE=1");
    expect(() =>
      validateStandardTestDestructiveTarget({
        ...SAFE_TEST_ENV,
        TEST_DATABASE_ALLOW_DESTRUCTIVE: "true",
      }),
    ).toThrow("TEST_DATABASE_ALLOW_DESTRUCTIVE=1");
  });

  it("never falls back to ambient DATABASE_URL", () => {
    expect(() =>
      validateStandardTestDestructiveTarget({
        NODE_ENV: "test",
        TEST_DATABASE_ALLOW_DESTRUCTIVE: "1",
        TEST_DATABASE_EXPECTED_NAME: "escalas_test",
        TEST_DATABASE_DISPOSABLE_MARKER: SAFE_TEST_MARKER,
        DATABASE_URL: "mysql://app:secret@db.example/prod",
      }),
    ).toThrow("TEST_DATABASE_URL");
  });

  it("requires URL, exact name and disposable marker explicitly", () => {
    for (const missing of [
      "TEST_DATABASE_URL",
      "TEST_DATABASE_EXPECTED_NAME",
      "TEST_DATABASE_DISPOSABLE_MARKER",
    ] as const) {
      expect(() =>
        validateStandardTestDestructiveTarget({
          ...SAFE_TEST_ENV,
          [missing]: undefined,
        }),
      ).toThrow(missing);
    }
  });

  it.each([
    [
      "remote host",
      "mysql://root:root@db.example.test:3306/escalas_test",
      "host must be an explicit loopback",
    ],
    [
      "unexpected database",
      "mysql://root:root@127.0.0.1:3306/escalas_staging",
      "database does not match",
    ],
    ["malformed URL", "not a url", "explicit valid URL"],
    [
      "query parameters",
      `${SAFE_TEST_URL}?ssl-mode=REQUIRED`,
      "must not contain query parameters",
    ],
    [
      "fragment",
      `${SAFE_TEST_URL}#staging`,
      "must not contain query parameters",
    ],
  ])("rejects %s", (_caseName, databaseUrl, expectedMessage) => {
    expect(() =>
      validateStandardTestDestructiveTarget({
        ...SAFE_TEST_ENV,
        TEST_DATABASE_URL: databaseUrl,
      }),
    ).toThrow(expectedMessage);
  });

  it("does not open the database when validation fails", async () => {
    const openDatabase = vi.fn();

    await expect(
      seedTestData({
        env: {
          ...SAFE_TEST_ENV,
          TEST_DATABASE_URL:
            "mysql://root:root@db.example.test:3306/escalas_test",
        },
        openDatabase,
      }),
    ).rejects.toThrow("host must be an explicit loopback");

    expect(openDatabase).not.toHaveBeenCalled();
  });

  it("checks SELECT DATABASE() before any DELETE", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([[{ database_name: "production" }], []]);
    const openDatabase = vi.fn(async () => ({ execute }) as never);

    await expect(
      seedTestData({ env: SAFE_TEST_ENV, openDatabase }),
    ).rejects.toThrow("Connected test database does not match");

    expect(openDatabase).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toBe(
      "SELECT DATABASE() AS database_name",
    );
  });

  it("checks the prepared marker before any DELETE", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([[{ database_name: "escalas_test" }], []])
      .mockResolvedValueOnce([
        [{ database_name: "escalas_test", marker_hash: "wrong" }],
        [],
      ]);
    const openDatabase = vi.fn(async () => ({ execute }) as never);

    await expect(
      seedTestData({ env: SAFE_TEST_ENV, openDatabase }),
    ).rejects.toThrow("not the explicitly prepared disposable target");

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1]?.[0]).toBe(
      DISPOSABLE_TEST_TARGET_MARKER_SELECT,
    );
    expect(execute.mock.calls.flat().join(" ")).not.toContain("DELETE");
  });

  it("checks the required schema before any DELETE", async () => {
    const target = validateStandardTestDestructiveTarget(SAFE_TEST_ENV);
    const execute = vi
      .fn()
      .mockResolvedValueOnce([[{ database_name: "escalas_test" }], []])
      .mockResolvedValueOnce([
        [
          {
            database_name: "escalas_test",
            marker_hash: target.markerHash,
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([[{ table_name: "users" }], []]);
    const openDatabase = vi.fn(async () => ({ execute }) as never);

    await expect(
      seedTestData({ env: SAFE_TEST_ENV, openDatabase }),
    ).rejects.toThrow("missing required pre-seed tables");

    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[2]?.[0]).toBe(
      DISPOSABLE_TEST_TARGET_SCHEMA_SELECT,
    );
    expect(execute.mock.calls.flat().join(" ")).not.toContain("DELETE");
  });

  it("refuses to create the marker when a pre-existing table has data", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([[{ database_name: "escalas_test" }], []])
      .mockResolvedValueOnce([
        DISPOSABLE_TEST_TARGET_REQUIRED_TABLES.map((table_name) => ({
          table_name,
        })),
        [],
      ])
      .mockResolvedValueOnce([[{ has_rows: 1 }], []]);
    const end = vi.fn();

    await expect(
      prepareStandardTestDatabase({
        env: SAFE_TEST_ENV,
        openConnection: vi.fn(async () => ({ query, end }) as never),
      }),
    ).rejects.toThrow("must be empty before its first preparation");

    expect(query.mock.calls.flat().join(" ")).not.toContain("CREATE TABLE");
    expect(end).toHaveBeenCalledOnce();
  });

  it("refuses to mark a database before the application schema exists", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([[{ database_name: "escalas_test" }], []])
      .mockResolvedValueOnce([[], []]);
    const end = vi.fn();

    await expect(
      prepareStandardTestDatabase({
        env: SAFE_TEST_ENV,
        openConnection: vi.fn(async () => ({ query, end }) as never),
      }),
    ).rejects.toThrow("must contain the application schema");
    expect(end).toHaveBeenCalledOnce();
  });

  it("creates the marker only after proving every application table empty", async () => {
    const target = validateStandardTestDestructiveTarget(SAFE_TEST_ENV);
    const query = vi.fn(async (statement: string) => {
      if (statement.startsWith("SELECT DATABASE")) {
        return [[{ database_name: target.databaseName }], []];
      }
      if (statement.includes("INFORMATION_SCHEMA.TABLES")) {
        return [
          DISPOSABLE_TEST_TARGET_REQUIRED_TABLES.map((table_name) => ({
            table_name,
          })),
          [],
        ];
      }
      if (statement.startsWith("SELECT EXISTS")) {
        return [[{ has_rows: 0 }], []];
      }
      if (statement === DISPOSABLE_TEST_TARGET_MARKER_SELECT) {
        return [
          [
            {
              database_name: target.databaseName,
              marker_hash: target.markerHash,
            },
          ],
          [],
        ];
      }
      return [[], []];
    });
    const end = vi.fn();

    await expect(
      prepareStandardTestDatabase({
        env: SAFE_TEST_ENV,
        openConnection: vi.fn(async () => ({ query, end }) as never),
      }),
    ).resolves.toMatchObject({ databaseName: "escalas_test" });

    const statements = query.mock.calls.map(([statement]) => statement);
    expect(
      statements.filter((statement) => statement.startsWith("SELECT EXISTS")),
    ).toHaveLength(DISPOSABLE_TEST_TARGET_REQUIRED_TABLES.length);
    expect(
      statements.findIndex((statement) => statement.startsWith("CREATE TABLE")),
    ).toBeGreaterThan(
      statements.findLastIndex((statement) =>
        statement.startsWith("SELECT EXISTS"),
      ),
    );
    expect(end).toHaveBeenCalledOnce();
  });

  it("reuses only the exact marker without recreating it", async () => {
    const target = validateStandardTestDestructiveTarget(SAFE_TEST_ENV);
    const query = vi
      .fn()
      .mockResolvedValueOnce([[{ database_name: target.databaseName }], []])
      .mockResolvedValueOnce([
        [
          { table_name: DISPOSABLE_TEST_TARGET_MARKER_TABLE },
          ...DISPOSABLE_TEST_TARGET_REQUIRED_TABLES.map((table_name) => ({
            table_name,
          })),
        ],
        [],
      ])
      .mockResolvedValueOnce([
        [
          {
            database_name: target.databaseName,
            marker_hash: target.markerHash,
          },
        ],
        [],
      ]);
    const end = vi.fn();

    await expect(
      prepareStandardTestDatabase({
        env: SAFE_TEST_ENV,
        openConnection: vi.fn(async () => ({ query, end }) as never),
      }),
    ).resolves.toMatchObject({ markerHash: target.markerHash });
    expect(query.mock.calls.flat().join(" ")).not.toContain("CREATE TABLE");
    expect(end).toHaveBeenCalledOnce();
  });

  it("does not let package.json silently authorize the standard suite", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts.test).toBe("vitest run");
    expect(packageJson.scripts["test:prepare-database"]).toBe(
      "tsx scripts/prepare-standard-test-database.ts",
    );
    expect(packageJson.scripts["test:whatsapp-account-ownership-mysql"]).toBe(
      "vitest run --config vitest.whatsapp-account.config.ts",
    );

    const whatsappConfig = readFileSync(
      new URL("../vitest.whatsapp-account.config.ts", import.meta.url),
      "utf8",
    );
    expect(whatsappConfig).toMatch(
      /validateStandardTestDestructiveTarget\(\s*process\.env,?\s*\)/,
    );
    expect(whatsappConfig).toContain('DATABASE_URL: ""');

    const whatsappSuite = readFileSync(
      new URL(
        "../tests/whatsapp-account-ownership-mysql.test.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const disposableRunner = readFileSync(
      new URL(
        "../tests/helpers/disposable-mysql-child-runner.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(whatsappSuite).not.toContain('password: "root"');
    expect(whatsappSuite).not.toContain("DROP DATABASE");
    expect(whatsappSuite).not.toMatch(/pool\.query\([^)]*(?:DELETE|DROP)/s);
    expect(whatsappSuite).not.toContain("executeVerifiedStatement");
    expect(whatsappSuite.match(/deleteAllFrom\(tableName\)/g)).toHaveLength(1);
    expect(disposableRunner).not.toContain("DROP DATABASE IF EXISTS");
    expect(disposableRunner).not.toContain("executeVerifiedStatement");
    expect(disposableRunner).toContain("quoteUnqualifiedIdentifier");
    expect(disposableRunner).toContain("executeVerifiedMutation");
    expect(disposableRunner).toContain('statement.includes(";")');
    expect(disposableRunner).toContain("/\\bDROP\\s+DATABASE\\b/i");
    expect(disposableRunner).toContain("assertCreationReceipt()");
    expect(disposableRunner).toContain("qualifiedChildMarkerSelect");

    const workflow = readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    type WorkflowStep = {
      env?: Record<string, string>;
      name?: string;
      run?: string;
    };
    const parsedWorkflow = parseYaml(workflow) as {
      jobs?: Record<string, { steps?: WorkflowStep[] }>;
    };
    const steps = parsedWorkflow.jobs?.["ci-core"]?.steps;
    expect(Array.isArray(steps)).toBe(true);
    const expectedEnv = {
      NODE_ENV: "test",
      TEST_DATABASE_ALLOW_DESTRUCTIVE: "1",
      TEST_DATABASE_URL: "mysql://root:root@127.0.0.1:3306/escalas_test",
      TEST_DATABASE_EXPECTED_NAME: "escalas_test",
      TEST_DATABASE_DISPOSABLE_MARKER:
        "ci-${{ github.run_id }}-${{ github.run_attempt }}-${{ github.sha }}",
    };
    for (const stepName of [
      "Prepare disposable standard-test target",
      "Validate WhatsApp account ownership in a disposable child target",
      "Test",
    ]) {
      const matches = steps?.filter((step) => step.name === stepName) ?? [];
      expect(matches, `workflow step ${stepName}`).toHaveLength(1);
      expect(matches[0]?.env).toEqual(expectedEnv);
    }
    expect(
      steps?.find(
        (step) =>
          step.name ===
          "Validate WhatsApp account ownership in a disposable child target",
      )?.run,
    ).toBe("pnpm test:whatsapp-account-ownership-mysql");
  });
});

describe("shared destructive target policies", () => {
  it("keeps the development admin seed local and explicitly named", () => {
    expect(
      validateSeedAdminDestructiveTarget({
        NODE_ENV: "development",
        SEED_ADMIN_ALLOW_DESTRUCTIVE: "1",
        SEED_ADMIN_EXPECTED_DATABASE: "escalas_local",
        DATABASE_URL: "mysql://root:root@localhost:3306/escalas_local",
      }),
    ).toMatchObject({
      databaseName: "escalas_local",
      host: "127.0.0.1",
    });

    expect(() =>
      validateSeedAdminDestructiveTarget({
        NODE_ENV: "development",
        SEED_ADMIN_ALLOW_DESTRUCTIVE: "1",
        SEED_ADMIN_EXPECTED_DATABASE: "escalas_local",
        DATABASE_URL: "mysql://root:root@db.example.test:3306/escalas_local",
      }),
    ).toThrow("host must be an explicit loopback");
    expect(() =>
      validateSeedAdminDestructiveTarget({
        NODE_ENV: "development",
        SEED_ADMIN_EXPECTED_DATABASE: "escalas_local",
        DATABASE_URL: "mysql://root:root@localhost:3306/escalas_local",
      }),
    ).toThrow("SEED_ADMIN_ALLOW_DESTRUCTIVE=1");
  });

  it("requires staging opt-in, exact host, exact database and fingerprint", () => {
    const host = "staging-db.example.test";
    const port = "25060";
    const databaseName = "escalas_staging";
    const fingerprint = destructiveTargetFingerprint({
      host,
      port,
      databaseName,
    });
    const env = {
      SEED_STAGING_ALLOW_DESTRUCTIVE: "1",
      SEED_STAGING_EXPECTED_HOST: host,
      SEED_STAGING_EXPECTED_DATABASE: databaseName,
      SEED_STAGING_EXPECTED_FINGERPRINT_SHA256: fingerprint,
      DATABASE_URL: `mysql://operator:secret@${host}:${port}/${databaseName}`,
    };

    expect(validateSeedStagingDestructiveTarget(env)).toMatchObject({
      host,
      port,
      databaseName,
      fingerprint,
    });
    expect(() =>
      validateSeedStagingDestructiveTarget({
        ...env,
        SEED_STAGING_ALLOW_DESTRUCTIVE: undefined,
      }),
    ).toThrow("SEED_STAGING_ALLOW_DESTRUCTIVE=1");
    expect(() =>
      validateSeedStagingDestructiveTarget({
        ...env,
        SEED_STAGING_ALLOW_DESTRUCTIVE: "true",
      }),
    ).toThrow("SEED_STAGING_ALLOW_DESTRUCTIVE=1");
    expect(() =>
      validateSeedStagingDestructiveTarget({
        ...env,
        SEED_STAGING_EXPECTED_HOST: "other-db.example.test",
      }),
    ).toThrow("host does not match");
    expect(() =>
      validateSeedStagingDestructiveTarget({
        ...env,
        SEED_STAGING_EXPECTED_DATABASE: "other_staging",
      }),
    ).toThrow("database does not match");
    expect(() =>
      validateSeedStagingDestructiveTarget({
        ...env,
        SEED_STAGING_EXPECTED_FINGERPRINT_SHA256: "0".repeat(64),
      }),
    ).toThrow("fingerprint does not match");
  });

  it("rejects query parameters and fragments for staging targets", () => {
    const host = "staging-db.example.test";
    const databaseName = "escalas_staging";
    const env = {
      SEED_STAGING_ALLOW_DESTRUCTIVE: "1",
      SEED_STAGING_EXPECTED_HOST: host,
      SEED_STAGING_EXPECTED_DATABASE: databaseName,
      SEED_STAGING_EXPECTED_FINGERPRINT_SHA256: destructiveTargetFingerprint({
        host,
        port: "3306",
        databaseName,
      }),
    };

    for (const suffix of ["?ssl-mode=REQUIRED", "#verified"]) {
      expect(() =>
        validateSeedStagingDestructiveTarget({
          ...env,
          DATABASE_URL: `mysql://operator:secret@${host}/${databaseName}${suffix}`,
        }),
      ).toThrow("must not contain query parameters");
    }
  });

  it("compares the connected database by exact identity", () => {
    expect(() =>
      assertConnectedDatabaseName("escalas_test", "escalas_test"),
    ).not.toThrow();
    expect(() =>
      assertConnectedDatabaseName("escalas_test_copy", "escalas_test"),
    ).toThrow("does not match");
    expect(() =>
      assertConnectedDatabaseName(undefined, "escalas_test"),
    ).toThrow("does not match");
  });
});
