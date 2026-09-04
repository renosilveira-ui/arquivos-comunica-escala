import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateAuditReport,
  fail,
  forbidCiOverrides,
  loadValidatedExceptions,
} from "./dependency-policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REPORT_OVERRIDE = process.env.DEPENDENCY_AUDIT_REPORT;
const PNPM_COMMAND = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

forbidCiOverrides();

function parseAudit(stdout) {
  const firstBrace = stdout.indexOf("{");
  const lastBrace = stdout.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace < firstBrace) {
    fail("pnpm audit did not return JSON");
  }
  try {
    return JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail("pnpm audit returned invalid JSON: " + detail);
  }
}

function loadAuditReport() {
  if (REPORT_OVERRIDE) {
    try {
      return parseAudit(readFileSync(REPORT_OVERRIDE, "utf8"));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      fail("cannot read dependency audit report override: " + detail);
    }
  }

  let lastFailure = "unknown registry failure";

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const audit = spawnSync(PNPM_COMMAND, ["audit", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
      maxBuffer: 32 * 1024 * 1024,
    });

    if (audit.error) {
      lastFailure = "cannot execute pnpm audit: " + audit.error.message;
      continue;
    }
    if (audit.signal) {
      lastFailure = "pnpm audit was terminated by " + audit.signal;
      continue;
    }
    if (audit.status !== 0 && audit.status !== 1) {
      lastFailure =
        "pnpm audit exited with status " +
        audit.status +
        ": " +
        (audit.stderr.trim() || "no diagnostic");
      continue;
    }

    const report = parseAudit(audit.stdout);
    if (!report.error) {
      return report;
    }

    lastFailure = (
      "registry audit failed: " +
      (report.error.code ?? "unknown") +
      " " +
      (report.error.message ?? "")
    ).trim();
  }

  fail(lastFailure + " after 2 attempts");
}

const policy = loadValidatedExceptions({ root: ROOT });
const report = loadAuditReport();
evaluateAuditReport(report, {
  ...policy,
  skipCompensatingTests: Boolean(REPORT_OVERRIDE),
});
