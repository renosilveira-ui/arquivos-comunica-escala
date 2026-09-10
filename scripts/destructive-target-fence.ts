import { createHash } from "node:crypto";

export type DestructiveTargetEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type ValidatedDestructiveTarget = {
  databaseUrl: string;
  databaseName: string;
  host: string;
  port: string;
  fingerprint: string;
};

export type ValidatedStandardTestDestructiveTarget =
  ValidatedDestructiveTarget & {
    markerHash: string;
  };

export const DISPOSABLE_TEST_TARGET_MARKER_TABLE =
  "__escalas_disposable_test_target_v1";
export const DISPOSABLE_TEST_TARGET_MARKER_SELECT = `SELECT database_name, marker_hash FROM \`${DISPOSABLE_TEST_TARGET_MARKER_TABLE}\` WHERE id = 1 LIMIT 2`;
export const DISPOSABLE_TEST_TARGET_REQUIRED_TABLES = Object.freeze([
  "hospitals",
  "institutions",
  "institution_config",
  "manager_scope",
  "medical_specialties",
  "professional_access",
  "professional_institutions",
  "professionals",
  "sectors",
  "users",
  "schedule_contexts",
  "shift_audit_log",
  "shift_instances",
  "shift_assignments_v2",
]);
export const DISPOSABLE_TEST_TARGET_SCHEMA_SELECT =
  "SELECT TABLE_NAME AS table_name FROM INFORMATION_SCHEMA.TABLES " +
  "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' " +
  `AND TABLE_NAME IN (${DISPOSABLE_TEST_TARGET_REQUIRED_TABLES.map((name) => `'${name}'`).join(", ")}) ` +
  "ORDER BY TABLE_NAME";

const LOCAL_DATABASE_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
]);
const DISPOSABLE_TEST_DATABASE_PATTERN =
  /^escalas(?:_test(?:_[a-z0-9_]+)?|_[a-z0-9_]+_test)$/;

function decodeUrlComponent(value: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`${label} must use valid percent encoding.`);
  }
}

function assertExpectedDatabaseName(
  value: string | undefined,
  label: string,
): string {
  if (!value || value.length > 64 || !/^[A-Za-z0-9_]+$/.test(value)) {
    throw new Error(`${label} must be an explicit MySQL database name.`);
  }
  return value;
}

function assertExpectedHost(value: string | undefined, label: string): string {
  const host = value?.trim().toLowerCase();
  if (!host || host !== value || host.includes("://") || /[/?#@]/.test(host)) {
    throw new Error(
      `${label} must be an explicit hostname without a URL or port.`,
    );
  }
  return host === "localhost" ? "127.0.0.1" : host;
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

export function destructiveTargetFingerprint(parts: {
  host: string;
  port: string;
  databaseName: string;
}): string {
  return createHash("sha256")
    .update(
      [
        "escalas-destructive-target-v1",
        parts.host.toLowerCase(),
        parts.port,
        parts.databaseName,
      ].join("\0"),
    )
    .digest("hex");
}

export function disposableTestTargetMarkerHash(parts: {
  host: string;
  port: string;
  databaseName: string;
  marker: string;
}): string {
  return createHash("sha256")
    .update(
      [
        "escalas-disposable-test-target-v1",
        parts.host.toLowerCase(),
        parts.port,
        parts.databaseName,
        parts.marker,
      ].join("\0"),
    )
    .digest("hex");
}

function validateMysqlTarget(
  rawDatabaseUrl: string | undefined,
  options: {
    label: string;
    expectedDatabase: string;
    expectedHost?: string;
    localOnly: boolean;
  },
): ValidatedDestructiveTarget {
  if (!rawDatabaseUrl || rawDatabaseUrl.trim() !== rawDatabaseUrl) {
    throw new Error(`${options.label} must be an explicit valid URL.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(rawDatabaseUrl);
  } catch {
    throw new Error(`${options.label} must be an explicit valid URL.`);
  }

  if (parsed.protocol !== "mysql:") {
    throw new Error(`${options.label} must use the mysql protocol.`);
  }
  if (
    rawDatabaseUrl.includes("?") ||
    rawDatabaseUrl.includes("#") ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      `${options.label} must not contain query parameters, driver options, or a fragment.`,
    );
  }

  const parsedHost = parsed.hostname.toLowerCase();
  if (!parsedHost) {
    throw new Error(`${options.label} must include a hostname.`);
  }
  const host = parsedHost === "localhost" ? "127.0.0.1" : parsedHost;
  if (options.localOnly && !LOCAL_DATABASE_HOSTS.has(parsedHost)) {
    throw new Error(
      `${options.label} host must be an explicit loopback address.`,
    );
  }
  if (options.expectedHost && host !== options.expectedHost) {
    throw new Error(
      `${options.label} host does not match the expected target.`,
    );
  }

  const portNumber = Number(parsed.port || "3306");
  if (
    !Number.isSafeInteger(portNumber) ||
    portNumber <= 0 ||
    portNumber > 65_535
  ) {
    throw new Error(`${options.label} port must be between 1 and 65535.`);
  }
  const port = String(portNumber);

  const encodedDatabaseName = parsed.pathname.replace(/^\/+/, "");
  const databaseName = decodeUrlComponent(
    encodedDatabaseName,
    `${options.label} database name`,
  );
  if (!databaseName || databaseName.includes("/")) {
    throw new Error(`${options.label} must select exactly one database.`);
  }
  if (databaseName !== options.expectedDatabase) {
    throw new Error(
      `${options.label} database does not match the expected target.`,
    );
  }

  const username = decodeUrlComponent(
    parsed.username,
    `${options.label} username`,
  );
  const password = decodeUrlComponent(
    parsed.password,
    `${options.label} password`,
  );
  const databaseUrl = canonicalDatabaseUrl({
    host,
    port,
    username,
    password,
    databaseName,
  });
  const fingerprint = destructiveTargetFingerprint({
    host,
    port,
    databaseName,
  });

  return { databaseUrl, databaseName, host, port, fingerprint };
}

export function validateStandardTestDestructiveTarget(
  env: DestructiveTargetEnvironment = process.env,
): ValidatedStandardTestDestructiveTarget {
  if (env.NODE_ENV !== "test") {
    throw new Error("Standard test seed requires NODE_ENV=test.");
  }
  if (env.TEST_DATABASE_ALLOW_DESTRUCTIVE !== "1") {
    throw new Error(
      "Standard test seed requires TEST_DATABASE_ALLOW_DESTRUCTIVE=1.",
    );
  }
  const expectedDatabase = assertExpectedDatabaseName(
    env.TEST_DATABASE_EXPECTED_NAME,
    "TEST_DATABASE_EXPECTED_NAME",
  );
  if (!DISPOSABLE_TEST_DATABASE_PATTERN.test(expectedDatabase)) {
    throw new Error(
      "TEST_DATABASE_EXPECTED_NAME must use an explicit disposable test database name.",
    );
  }

  const marker = env.TEST_DATABASE_DISPOSABLE_MARKER;
  if (
    !marker ||
    marker !== marker.trim() ||
    marker.length < 32 ||
    marker.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(marker)
  ) {
    throw new Error(
      "TEST_DATABASE_DISPOSABLE_MARKER must be an explicit 32-128 character marker.",
    );
  }

  const target = validateMysqlTarget(env.TEST_DATABASE_URL, {
    label: "TEST_DATABASE_URL",
    expectedDatabase,
    localOnly: true,
  });
  return {
    ...target,
    markerHash: disposableTestTargetMarkerHash({
      host: target.host,
      port: target.port,
      databaseName: target.databaseName,
      marker,
    }),
  };
}

export function deriveDisposableChildTestTarget(
  parent: ValidatedStandardTestDestructiveTarget,
  childDatabaseName: string,
  namespace: string,
): ValidatedStandardTestDestructiveTarget {
  const databaseName = assertExpectedDatabaseName(
    childDatabaseName,
    "Disposable child database name",
  );
  if (
    databaseName === parent.databaseName ||
    !DISPOSABLE_TEST_DATABASE_PATTERN.test(databaseName)
  ) {
    throw new Error(
      "Disposable child database must use a distinct explicit test database name.",
    );
  }
  if (
    namespace !== namespace.trim() ||
    namespace.length < 8 ||
    namespace.length > 64 ||
    !/^[a-z0-9._:-]+$/.test(namespace)
  ) {
    throw new Error(
      "Disposable child namespace must be an explicit 8-64 character identifier.",
    );
  }

  const parsed = new URL(parent.databaseUrl);
  parsed.pathname = `/${encodeURIComponent(databaseName)}`;
  const fingerprint = destructiveTargetFingerprint({
    host: parent.host,
    port: parent.port,
    databaseName,
  });
  return {
    databaseUrl: parsed.toString(),
    databaseName,
    host: parent.host,
    port: parent.port,
    fingerprint,
    markerHash: disposableTestTargetMarkerHash({
      host: parent.host,
      port: parent.port,
      databaseName,
      marker: `${namespace}:${parent.markerHash}`,
    }),
  };
}

export function assertDisposableTestTargetMarker(
  result: unknown,
  target: ValidatedStandardTestDestructiveTarget,
): void {
  const rows =
    Array.isArray(result) && Array.isArray(result[0])
      ? (result[0] as Record<string, unknown>[])
      : [];
  const [row] = rows;
  if (
    rows.length !== 1 ||
    row?.database_name !== target.databaseName ||
    row?.marker_hash !== target.markerHash
  ) {
    throw new Error(
      "Connected test database is not the explicitly prepared disposable target.",
    );
  }
}

export function assertDisposableTestTargetSchema(result: unknown): void {
  const rows =
    Array.isArray(result) && Array.isArray(result[0])
      ? (result[0] as Record<string, unknown>[])
      : [];
  const actual = new Set(rows.map((row) => row.table_name));
  if (
    DISPOSABLE_TEST_TARGET_REQUIRED_TABLES.some(
      (tableName) => !actual.has(tableName),
    )
  ) {
    throw new Error(
      "Connected test database is missing required pre-seed tables.",
    );
  }
}

export function validateSeedAdminDestructiveTarget(
  env: DestructiveTargetEnvironment = process.env,
): ValidatedDestructiveTarget {
  if (env.NODE_ENV !== "development") {
    throw new Error("Admin seed requires NODE_ENV=development.");
  }
  if (env.SEED_ADMIN_ALLOW_DESTRUCTIVE !== "1") {
    throw new Error("Admin seed requires SEED_ADMIN_ALLOW_DESTRUCTIVE=1.");
  }
  const expectedDatabase = assertExpectedDatabaseName(
    env.SEED_ADMIN_EXPECTED_DATABASE,
    "SEED_ADMIN_EXPECTED_DATABASE",
  );

  return validateMysqlTarget(env.DATABASE_URL, {
    label: "DATABASE_URL",
    expectedDatabase,
    localOnly: true,
  });
}

export function validateSeedStagingDestructiveTarget(
  env: DestructiveTargetEnvironment = process.env,
): ValidatedDestructiveTarget {
  if (env.SEED_STAGING_ALLOW_DESTRUCTIVE !== "1") {
    throw new Error("Staging seed requires SEED_STAGING_ALLOW_DESTRUCTIVE=1.");
  }
  const expectedHost = assertExpectedHost(
    env.SEED_STAGING_EXPECTED_HOST,
    "SEED_STAGING_EXPECTED_HOST",
  );
  const expectedDatabase = assertExpectedDatabaseName(
    env.SEED_STAGING_EXPECTED_DATABASE,
    "SEED_STAGING_EXPECTED_DATABASE",
  );
  const expectedFingerprint = env.SEED_STAGING_EXPECTED_FINGERPRINT_SHA256;
  if (!expectedFingerprint || !/^[a-f0-9]{64}$/.test(expectedFingerprint)) {
    throw new Error(
      "SEED_STAGING_EXPECTED_FINGERPRINT_SHA256 must be an explicit lowercase SHA-256 fingerprint.",
    );
  }

  const target = validateMysqlTarget(env.DATABASE_URL, {
    label: "DATABASE_URL",
    expectedDatabase,
    expectedHost,
    localOnly: false,
  });
  if (target.fingerprint !== expectedFingerprint) {
    throw new Error(
      "DATABASE_URL fingerprint does not match the expected staging target.",
    );
  }
  return target;
}

export function assertConnectedDatabaseName(
  actualDatabase: unknown,
  expectedDatabase: string,
  label = "Connected database",
): void {
  if (actualDatabase !== expectedDatabase) {
    throw new Error(`${label} does not match the validated target.`);
  }
}
