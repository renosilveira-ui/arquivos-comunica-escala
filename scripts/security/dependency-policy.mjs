import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export const MINIMUM_BLOCKED_SEVERITY = "moderate";
export const MAX_REVIEW_WINDOW_DAYS = 92;
const DAY_MS = 24 * 60 * 60 * 1_000;
export const SEVERITY = Object.freeze({
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
});

export function fail(message) {
  process.stderr.write("dependency-audit: FAIL: " + message + "\n");
  process.exit(1);
}

export function forbidCiOverrides(env = process.env) {
  if (env.CI && (env.DEPENDENCY_AUDIT_REGISTER || env.DEPENDENCY_AUDIT_REPORT || env.DEPENDENCY_OSV_API)) {
    fail("dependency audit overrides are forbidden in CI");
  }
}

function readJson(filePath, label, root) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(
      "cannot read " + label + " at " + path.relative(root, filePath) + ": " + detail,
    );
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(label + " must be a non-empty string");
  }
  return value;
}

function parseDate(value, label, endOfDay = false) {
  requireString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(label + " must use YYYY-MM-DD");
  }
  const parsed = new Date(
    value + (endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z"),
  );
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(label + " is not a valid date");
  }
  return parsed;
}

function insideRoot(relativePath, label, root, realRoot) {
  requireString(relativePath, label);
  const absolutePath = path.resolve(root, relativePath);
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(label + " must remain inside the repository");
  }
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    fail(label + " does not identify a repository file: " + relativePath);
  }
  if (lstatSync(absolutePath).isSymbolicLink()) {
    fail(label + " must not be a symbolic link");
  }
  const realPath = realpathSync(absolutePath);
  const realRelative = path.relative(realRoot, realPath);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    fail(label + " resolves outside the repository");
  }
  return realPath;
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function canonicalRepositoryPath(filePath, realRoot) {
  return path.relative(realRoot, filePath).split(path.sep).join("/");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {{
 *   root?: string,
 *   env?: NodeJS.ProcessEnv,
 *   now?: Date,
 * }} [options]
 */
export function loadValidatedExceptions(options = {}) {
  const root = options.root ?? DEFAULT_ROOT;
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const realRoot = realpathSync(root);
  const registerPath =
    env.DEPENDENCY_AUDIT_REGISTER ?? path.join(root, "security/dependency-exceptions.json");
  const packagePath = path.join(root, "package.json");
  const pureConfigPath = path.join(root, "vitest.pure.config.ts");

  const register = readJson(registerPath, "exception register", root);
  const packageJson = readJson(packagePath, "package.json", root);

  if (register.schemaVersion !== 1 || !Array.isArray(register.exceptions)) {
    fail("unsupported exception register schema");
  }

  const minimumSeverity = requireString(
    register.minimumBlockedSeverity,
    "minimumBlockedSeverity",
  );
  if (minimumSeverity !== MINIMUM_BLOCKED_SEVERITY) {
    fail("minimumBlockedSeverity must remain " + MINIMUM_BLOCKED_SEVERITY);
  }

  const lastReviewed = parseDate(register.lastReviewed, "lastReviewed");
  const patchedDependencies = packageJson.pnpm?.patchedDependencies ?? {};
  const exceptions = new Map();
  const compensatingTests = new Set();
  const pureConfigSource = readFileSync(pureConfigPath, "utf8");
  if (lastReviewed > now) {
    fail("lastReviewed cannot be in the future");
  }

  for (const [index, exception] of register.exceptions.entries()) {
    const prefix = "exceptions[" + index + "]";
    const ghsaId = requireString(exception.ghsaId, prefix + ".ghsaId");
    const packageName = requireString(exception.packageName, prefix + ".packageName");
    const version = requireString(exception.version, prefix + ".version");
    const severity = requireString(exception.severity, prefix + ".severity");
    const patchedDependency = requireString(
      exception.patchedDependency,
      prefix + ".patchedDependency",
    );
    const patchFile = requireString(exception.patchFile, prefix + ".patchFile");
    const expectedHash = requireString(exception.patchSha256, prefix + ".patchSha256");
    const expectedTestHash = requireString(exception.testSha256, prefix + ".testSha256");
    const key = ghsaId + "|" + packageName + "|" + version;

    if (patchedDependency !== packageName + "@" + version) {
      fail(
        prefix + ".patchedDependency must exactly match " + packageName + "@" + version,
      );
    }
    if (!Object.hasOwn(SEVERITY, severity)) {
      fail(prefix + ".severity is unknown: " + severity);
    }
    if (exceptions.has(key)) {
      fail("duplicate exception: " + key);
    }
    if (patchedDependencies[patchedDependency] !== patchFile) {
      fail(key + " is not bound to " + patchFile + " in pnpm.patchedDependencies");
    }

    const reviewBy = parseDate(exception.reviewBy, prefix + ".reviewBy", true);
    if (reviewBy <= lastReviewed) {
      fail(prefix + ".reviewBy must be later than lastReviewed");
    }
    if (reviewBy.getTime() - lastReviewed.getTime() > MAX_REVIEW_WINDOW_DAYS * DAY_MS) {
      fail(prefix + ".reviewBy exceeds the " + MAX_REVIEW_WINDOW_DAYS + "-day review window");
    }
    if (now > reviewBy) {
      fail(key + " expired on " + exception.reviewBy);
    }

    if (!/^patches\/[^/]+\.patch$/.test(patchFile)) {
      fail(prefix + ".patchFile must identify a canonical patch under patches/");
    }
    const patchPath = insideRoot(patchFile, prefix + ".patchFile", root, realRoot);
    if (canonicalRepositoryPath(patchPath, realRoot) !== patchFile) {
      fail(prefix + ".patchFile must be a canonical path under patches/");
    }
    const testFile = requireString(exception.testFile, prefix + ".testFile");
    if (!/^tests\/.+\.test\.(?:[cm]?js|tsx?)$/.test(testFile)) {
      fail(prefix + ".testFile must identify a test under tests/");
    }
    const testPath = insideRoot(testFile, prefix + ".testFile", root, realRoot);
    if (canonicalRepositoryPath(testPath, realRoot) !== testFile) {
      fail(prefix + ".testFile must be a canonical path under tests/");
    }
    if (
      !new RegExp("^\\s*[\"\\']" + escapeRegExp(testFile) + "[\"\\'],?\\s*$", "m").test(
        pureConfigSource,
      )
    ) {
      fail(prefix + ".testFile must be listed in vitest.pure.config.ts");
    }
    const actualHash = sha256(patchPath);
    if (actualHash !== expectedHash) {
      fail(
        key + " patch hash mismatch: expected " + expectedHash + ", received " + actualHash,
      );
    }
    const actualTestHash = sha256(testPath);
    if (actualTestHash !== expectedTestHash) {
      fail(
        key +
          " test hash mismatch: expected " +
          expectedTestHash +
          ", received " +
          actualTestHash,
      );
    }

    const upstreamReference = requireString(
      exception.upstreamReference,
      prefix + ".upstreamReference",
    );
    try {
      const upstreamUrl = new URL(upstreamReference);
      if (upstreamUrl.protocol !== "https:" || upstreamUrl.hostname !== "github.com") {
        fail(prefix + ".upstreamReference must be an HTTPS GitHub URL");
      }
    } catch {
      fail(prefix + ".upstreamReference must be a valid URL");
    }
    const upstreamStatus = requireString(
      exception.upstreamStatus,
      prefix + ".upstreamStatus",
    );
    if (
      ![
        "no-published-fix",
        "unreleased-upstream-commit-no-patched-release",
        "published-fix-backported-for-commonjs-compatibility",
      ].includes(upstreamStatus)
    ) {
      fail(prefix + ".upstreamStatus is not an approved state");
    }
    const removalCondition = requireString(
      exception.removalCondition,
      prefix + ".removalCondition",
    );
    if (removalCondition.length < 80) {
      fail(prefix + ".removalCondition is not specific enough");
    }
    compensatingTests.add(testFile);
    exceptions.set(key, exception);
  }

  return {
    root,
    exceptions,
    compensatingTests,
    minimumSeverity,
  };
}

/**
 * @param {object} report
 * @param {{
 *   exceptions: Map<string, object>,
 *   compensatingTests: Set<string>,
 *   minimumSeverity: string,
 *   root: string,
 *   skipCompensatingTests?: boolean,
 * }} context
 */
export function evaluateAuditReport(report, context) {
  if (!report.advisories || typeof report.advisories !== "object" || Array.isArray(report.advisories)) {
    fail("pnpm audit response does not contain advisories");
  }
  if (
    !report.metadata?.vulnerabilities ||
    typeof report.metadata.vulnerabilities !== "object" ||
    Array.isArray(report.metadata.vulnerabilities)
  ) {
    fail("pnpm audit response does not contain vulnerability metadata");
  }

  const advisoryList = Object.values(report.advisories);
  const metadataSeverities = Object.keys(report.metadata.vulnerabilities).sort();
  const expectedSeverities = Object.keys(SEVERITY).sort();
  if (
    metadataSeverities.length !== expectedSeverities.length ||
    metadataSeverities.some((severity, index) => severity !== expectedSeverities[index])
  ) {
    fail(
      "pnpm audit returned an unexpected vulnerability severity set: " +
        metadataSeverities.join(", "),
    );
  }
  for (const severity of Object.keys(SEVERITY)) {
    const metadataCount = report.metadata.vulnerabilities[severity];
    if (!Number.isSafeInteger(metadataCount) || metadataCount < 0) {
      fail("pnpm audit returned invalid " + severity + " vulnerability metadata");
    }
    const advisoryCount = advisoryList.filter(
      (advisory) => String(advisory.severity ?? "").toLowerCase() === severity,
    ).length;
    if (metadataCount !== advisoryCount) {
      fail(
        "pnpm audit advisory data differs from " + severity + " vulnerability metadata",
      );
    }
  }

  const observedExceptions = new Set();
  const unapproved = [];
  const { exceptions, minimumSeverity } = context;

  for (const advisory of advisoryList) {
    const severity = String(advisory.severity ?? "").toLowerCase();
    if (!Object.hasOwn(SEVERITY, severity)) {
      fail(
        "advisory " +
          (advisory.github_advisory_id ?? advisory.id ?? "unknown") +
          " has unknown severity",
      );
    }
    if (SEVERITY[severity] < SEVERITY[minimumSeverity]) {
      continue;
    }

    const ghsaId = requireString(advisory.github_advisory_id, "advisory.github_advisory_id");
    if (!/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(ghsaId)) {
      fail("advisory.github_advisory_id is malformed: " + ghsaId);
    }
    const packageName = requireString(advisory.module_name, "advisory.module_name");
    const findings = Array.isArray(advisory.findings) ? advisory.findings : [];
    if (findings.length === 0) {
      fail(ghsaId + " does not contain findings");
    }

    for (const finding of findings) {
      const version = requireString(finding.version, ghsaId + ".finding.version");
      const key = ghsaId + "|" + packageName + "|" + version;
      const exception = exceptions.get(key);
      if (!exception || exception.severity !== severity) {
        unapproved.push(key + " (" + severity + ")");
        continue;
      }
      observedExceptions.add(key);
    }
  }

  if (unapproved.length > 0) {
    fail("unapproved advisories:\n- " + unapproved.join("\n- "));
  }

  const stale = [...exceptions.keys()].filter((key) => !observedExceptions.has(key));
  if (stale.length > 0) {
    fail("stale exceptions must be removed or re-evaluated:\n- " + stale.join("\n- "));
  }

  if (!context.skipCompensatingTests && context.compensatingTests.size > 0) {
    const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const testFiles = [...context.compensatingTests].sort();
    const testRun = spawnSync(
      pnpmCommand,
      ["exec", "vitest", "run", "--config", "vitest.pure.config.ts", ...testFiles],
      {
        cwd: context.root,
        encoding: "utf8",
        timeout: 60_000,
        killSignal: "SIGKILL",
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    if (testRun.error || testRun.signal || testRun.status !== 0) {
      const diagnostic = (testRun.stderr || testRun.stdout || "no diagnostic")
        .trim()
        .slice(-4_000);
      fail("compensating regression tests did not pass: " + diagnostic);
    }
    process.stdout.write(
      "dependency-audit: compensating tests PASS: " + testFiles.join(", ") + "\n",
    );
  }

  process.stdout.write(
    "dependency-audit: PASS: " +
      observedExceptions.size +
      " advisory exception(s) verified; no unexpected " +
      minimumSeverity +
      "+ advisory found.\n",
  );
}
