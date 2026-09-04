import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateAuditReport,
  fail,
  forbidCiOverrides,
  loadValidatedExceptions,
} from "./dependency-policy.mjs";
import {
  DEFAULT_OSV_API_BASE,
  formatOsvInfraLog,
  loadOsvAuditReport,
  OSV_KIND,
  parsePnpmLockPackages,
} from "./osv-source.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LOCKFILE_PATH = path.join(ROOT, "pnpm-lock.yaml");
const OSV_API_OVERRIDE = process.env.DEPENDENCY_OSV_API;

forbidCiOverrides();

function failInfra(result) {
  process.stderr.write(formatOsvInfraLog(result) + "\n");
  process.exit(1);
}

const policy = loadValidatedExceptions({ root: ROOT });

let lockfileText;
try {
  lockfileText = readFileSync(LOCKFILE_PATH, "utf8");
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  fail("cannot read pnpm-lock.yaml: " + detail);
}

const packages = parsePnpmLockPackages(lockfileText);
if (packages.length === 0) {
  fail("pnpm-lock.yaml does not contain a packages table");
}

const executed = await loadOsvAuditReport({
  packages,
  apiBase: OSV_API_OVERRIDE || DEFAULT_OSV_API_BASE,
});

if (executed.kind !== OSV_KIND.SUCCESS) {
  failInfra(executed);
}

process.stdout.write(
  "dependency-audit: OSV source PASS: " +
    packages.length +
    " lockfile package(s) on attempt " +
    executed.attempt +
    "\n",
);

evaluateAuditReport(executed.report, {
  ...policy,
  skipCompensatingTests: false,
});
