import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AUDIT_KIND,
  AUDIT_MAX_ATTEMPTS,
  AUDIT_RETRY_BACKOFF_MS,
  AUDIT_TIMEOUT_MS,
  classifySpawnAuditResult,
  formatInfraLog,
  isRetryableAuditKind,
  parseAuditStdout,
  runAuditAttempts,
  sanitizeAuditDiagnostic,
} from "../scripts/security/audit-execution.mjs";

const root = path.resolve(import.meta.dirname, "..");

const cleanReport = {
  advisories: {},
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
    },
  },
};

const blockingReport = {
  advisories: {
    "999": {
      severity: "high",
      github_advisory_id: "GHSA-w5hq-g745-h8pq",
      module_name: "uuid",
      findings: [{ version: "11.1.1" }],
    },
  },
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 0,
      high: 1,
      critical: 0,
    },
  },
};

function timedOut(attempt = 1) {
  const error = new Error("spawnSync pnpm ETIMEDOUT");
  error.code = "ETIMEDOUT";
  return classifySpawnAuditResult(
    { error, status: null, signal: "SIGKILL", stdout: "", stderr: "" },
    { attempt, timeoutMs: AUDIT_TIMEOUT_MS },
  );
}

describe("dependency audit execution constants", () => {
  it("usa 60s por tentativa, 2 attempts e backoff de 3s", () => {
    expect(AUDIT_TIMEOUT_MS).toBe(60_000);
    expect(AUDIT_MAX_ATTEMPTS).toBe(2);
    expect(AUDIT_RETRY_BACKOFF_MS).toBe(3_000);
  });

  it("não altera o comando do workflow nem adiciona continue-on-error", () => {
    for (const relative of [
      ".github/workflows/ci.yml",
      ".github/workflows/dependency-audit.yml",
    ]) {
      const source = readFileSync(path.join(root, relative), "utf8");
      expect(source).toContain("pnpm security:audit");
      expect(source).not.toMatch(/continue-on-error:\s*true/);
      expect(source).not.toContain("|| true");
    }
  });
});

describe("classifySpawnAuditResult", () => {
  it("classifica timeout do wrapper como TIMEOUT, não PASS", () => {
    const result = timedOut(1);
    expect(result.kind).toBe(AUDIT_KIND.TIMEOUT);
    expect(isRetryableAuditKind(result.kind)).toBe(true);
    expect(formatInfraLog(result)).toContain("INFRA");
    expect(formatInfraLog(result)).toContain("timed out after 60000ms");
    expect(formatInfraLog(result)).not.toContain("PASS");
    expect(formatInfraLog(result)).not.toContain("SECURITY");
  });

  it("classifica falha de rede como REGISTRY_FAILURE retryable", () => {
    const error = new Error("read ECONNRESET");
    error.code = "ECONNRESET";
    const result = classifySpawnAuditResult(
      { error, status: null, signal: null, stdout: "", stderr: "" },
      { attempt: 1, timeoutMs: AUDIT_TIMEOUT_MS },
    );
    expect(result.kind).toBe(AUDIT_KIND.REGISTRY_FAILURE);
    expect(isRetryableAuditKind(result.kind)).toBe(true);
    expect(formatInfraLog(result)).toContain("registry audit endpoint unavailable");
  });

  it("classifica 429/503 do registry como REGISTRY_FAILURE", () => {
    const tooMany = classifySpawnAuditResult(
      {
        error: undefined,
        status: 7,
        signal: null,
        stdout: "",
        stderr: "npm ERR! 429 Too Many Requests",
      },
      { attempt: 1, timeoutMs: AUDIT_TIMEOUT_MS },
    );
    expect(tooMany.kind).toBe(AUDIT_KIND.REGISTRY_FAILURE);

    const unavailable = classifySpawnAuditResult(
      {
        error: undefined,
        status: 1,
        signal: null,
        stdout: JSON.stringify({
          error: { code: "EAI_AGAIN", message: "503 Service Unavailable" },
        }),
        stderr: "",
      },
      { attempt: 2, timeoutMs: AUDIT_TIMEOUT_MS },
    );
    expect(unavailable.kind).toBe(AUDIT_KIND.REGISTRY_FAILURE);
  });

  it("classifica stdout vazio e JSON inválido como MALFORMED_RESULT", () => {
    const empty = classifySpawnAuditResult(
      { error: undefined, status: 0, signal: null, stdout: "   ", stderr: "" },
      { attempt: 1, timeoutMs: AUDIT_TIMEOUT_MS },
    );
    expect(empty.kind).toBe(AUDIT_KIND.MALFORMED_RESULT);
    expect(isRetryableAuditKind(empty.kind)).toBe(false);

    const invalid = classifySpawnAuditResult(
      { error: undefined, status: 0, signal: null, stdout: "{not-json", stderr: "" },
      { attempt: 1, timeoutMs: AUDIT_TIMEOUT_MS },
    );
    expect(invalid.kind).toBe(AUDIT_KIND.MALFORMED_RESULT);
    expect(parseAuditStdout("prefix {").ok).toBe(false);
  });

  it("classifica executável ausente como EXECUTION_FAILURE sem retry", () => {
    const error = new Error("spawn pnpm ENOENT");
    error.code = "ENOENT";
    const result = classifySpawnAuditResult(
      { error, status: null, signal: null, stdout: "", stderr: "" },
      { attempt: 1, timeoutMs: AUDIT_TIMEOUT_MS },
    );
    expect(result.kind).toBe(AUDIT_KIND.EXECUTION_FAILURE);
    expect(isRetryableAuditKind(result.kind)).toBe(false);
    expect(formatInfraLog(result)).toContain("execution failed");
  });

  it("trata SIGKILL do timeout como TIMEOUT e outro sinal como EXECUTION_FAILURE", () => {
    const killed = classifySpawnAuditResult(
      { error: undefined, status: null, signal: "SIGKILL", stdout: "", stderr: "" },
      { attempt: 1, timeoutMs: AUDIT_TIMEOUT_MS },
    );
    expect(killed.kind).toBe(AUDIT_KIND.TIMEOUT);

    const interrupted = classifySpawnAuditResult(
      { error: undefined, status: null, signal: "SIGINT", stdout: "", stderr: "" },
      { attempt: 1, timeoutMs: AUDIT_TIMEOUT_MS },
    );
    expect(interrupted.kind).toBe(AUDIT_KIND.EXECUTION_FAILURE);
    expect(isRetryableAuditKind(interrupted.kind)).toBe(false);
  });

  it("aceita JSON válido (status 0 ou 1) como SUCCESS para a policy", () => {
    const ok = classifySpawnAuditResult(
      {
        error: undefined,
        status: 1,
        signal: null,
        stdout: JSON.stringify(blockingReport),
        stderr: "",
      },
      { attempt: 1, timeoutMs: AUDIT_TIMEOUT_MS },
    );
    expect(ok.kind).toBe(AUDIT_KIND.SUCCESS);
    expect(ok.report.advisories["999"].severity).toBe("high");

    const clean = classifySpawnAuditResult(
      {
        error: undefined,
        status: 0,
        signal: null,
        stdout: "noise\n" + JSON.stringify(cleanReport),
        stderr: "",
      },
      { attempt: 1, timeoutMs: AUDIT_TIMEOUT_MS },
    );
    expect(clean.kind).toBe(AUDIT_KIND.SUCCESS);
  });

  it("não trata JSON parcial com exit != 0/1 como SUCCESS", () => {
    const result = classifySpawnAuditResult(
      {
        error: undefined,
        status: 2,
        signal: null,
        stdout: '{"advisories":{',
        stderr: "broken pipe",
      },
      { attempt: 1, timeoutMs: AUDIT_TIMEOUT_MS },
    );
    expect(result.kind).not.toBe(AUDIT_KIND.SUCCESS);
  });

  it("erro desconhecido e stderr enorme não vazam nem viram PASS", () => {
    const huge = "x".repeat(20_000) + " Authorization: Bearer secret-token-value";
    const result = classifySpawnAuditResult(
      {
        error: undefined,
        status: 3,
        signal: null,
        stdout: "",
        stderr: huge,
      },
      { attempt: 1, timeoutMs: AUDIT_TIMEOUT_MS },
    );
    expect(result.kind).toBe(AUDIT_KIND.EXECUTION_FAILURE);
    expect(isRetryableAuditKind(result.kind)).toBe(false);
    expect(result.detail.length).toBeLessThan(900);
    expect(result.detail).not.toContain("secret-token-value");
    expect(formatInfraLog(result)).toContain("INFRA");
    expect(formatInfraLog(result)).not.toContain("PASS");
    expect(formatInfraLog(result)).not.toContain("secret-token-value");
  });

  it("redige segredos em diagnósticos e nunca os coloca no log INFRA", () => {
    const leaked =
      "Authorization: Bearer ghp_leakedtokenvalue99 npm_secretvalue99";
    const sanitized = sanitizeAuditDiagnostic(leaked);
    expect(sanitized).not.toContain("ghp_leakedtokenvalue99");
    expect(sanitized).not.toContain("npm_secretvalue99");
    expect(sanitized).not.toContain("Bearer ");
    expect(sanitized).toContain("[redacted]");

    const error = new Error(leaked);
    error.code = "ECONNRESET";
    const result = classifySpawnAuditResult(
      { error, status: null, signal: null, stdout: leaked, stderr: leaked },
      { attempt: 1, timeoutMs: AUDIT_TIMEOUT_MS },
    );
    const log = formatInfraLog(result);
    expect(log).toContain("INFRA");
    expect(log).not.toContain("ghp_leakedtokenvalue99");
    expect(log).not.toContain("npm_secretvalue99");
    expect(log).not.toContain("Bearer ");
  });
});

describe("runAuditAttempts", () => {
  it("retrya timeout da attempt 1 e falha INFRA na attempt 2", async () => {
    const sleep = vi.fn(async () => {});
    const seen: string[] = [];
    const timeoutError = Object.assign(new Error("spawnSync pnpm ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    const result = await runAuditAttempts({
      runAttempt: async () => ({
        error: timeoutError,
        status: null,
        signal: "SIGKILL",
        stdout: "",
        stderr: "",
      }),
      sleep,
      onAttempt: (classified) => {
        seen.push(classified.kind);
      },
    });
    expect(seen).toEqual([AUDIT_KIND.TIMEOUT, AUDIT_KIND.TIMEOUT]);
    expect(result.kind).toBe(AUDIT_KIND.TIMEOUT);
    expect(result.attempt).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(AUDIT_RETRY_BACKOFF_MS);
    expect(isRetryableAuditKind(result.kind)).toBe(true);
  });

  it("runner que lança vira EXECUTION_FAILURE sem retry", async () => {
    const sleep = vi.fn(async () => {});
    const result = await runAuditAttempts({
      runAttempt: () => {
        throw new Error("unexpected runner crash");
      },
      sleep,
      maxAttempts: 2,
    });
    expect(result.kind).toBe(AUDIT_KIND.EXECUTION_FAILURE);
    expect(result.attempt).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("PASS na segunda tentativa após timeout", async () => {
    const sleep = vi.fn(async () => {});
    let attempt = 0;
    const result = await runAuditAttempts({
      runAttempt: async () => {
        attempt += 1;
        if (attempt === 1) {
          return {
            error: Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }),
            status: null,
            signal: "SIGKILL",
            stdout: "",
            stderr: "",
          };
        }
        return {
          error: undefined,
          status: 0,
          signal: null,
          stdout: JSON.stringify(cleanReport),
          stderr: "",
        };
      },
      sleep,
    });
    expect(result.kind).toBe(AUDIT_KIND.SUCCESS);
    expect(result.attempt).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("retrya network e devolve finding da segunda tentativa sem novo retry", async () => {
    const sleep = vi.fn(async () => {});
    let attempt = 0;
    const result = await runAuditAttempts({
      runAttempt: async () => {
        attempt += 1;
        if (attempt === 1) {
          return {
            error: Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" }),
            status: null,
            signal: null,
            stdout: "",
            stderr: "",
          };
        }
        return {
          error: undefined,
          status: 1,
          signal: null,
          stdout: JSON.stringify(blockingReport),
          stderr: "",
        };
      },
      sleep,
    });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe(AUDIT_KIND.SUCCESS);
    expect(result.report.advisories["999"]).toBeTruthy();
  });

  it("não retrya finding real, JSON malformado nem executável ausente", async () => {
    const sleep = vi.fn(async () => {});

    const finding = await runAuditAttempts({
      runAttempt: async () => ({
        error: undefined,
        status: 1,
        signal: null,
        stdout: JSON.stringify(blockingReport),
        stderr: "",
      }),
      sleep,
    });
    expect(finding.kind).toBe(AUDIT_KIND.SUCCESS);
    expect(sleep).not.toHaveBeenCalled();

    const malformed = await runAuditAttempts({
      runAttempt: async () => ({
        error: undefined,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
      }),
      sleep,
    });
    expect(malformed.kind).toBe(AUDIT_KIND.MALFORMED_RESULT);
    expect(sleep).not.toHaveBeenCalled();

    const missing = await runAuditAttempts({
      runAttempt: async () => ({
        error: Object.assign(new Error("spawn pnpm ENOENT"), { code: "ENOENT" }),
        status: null,
        signal: null,
        stdout: "",
        stderr: "",
      }),
      sleep,
    });
    expect(missing.kind).toBe(AUDIT_KIND.EXECUTION_FAILURE);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("o wrapper deixa de usar timeout de 30s e spawnSync genérico", () => {
    const source = readFileSync(
      path.join(root, "scripts/security/audit-dependencies.mjs"),
      "utf8",
    );
    expect(source).toContain("AUDIT_TIMEOUT_MS");
    expect(source).not.toMatch(/timeout:\s*30_000/);
    expect(source).not.toContain("after 2 attempts");
    expect(source).toContain("runAuditAttempts");
  });

  it("sucesso limpo na primeira tentativa não dorme", async () => {
    const sleep = vi.fn(async () => {});
    const result = await runAuditAttempts({
      runAttempt: async () => ({
        error: undefined,
        status: 0,
        signal: null,
        stdout: JSON.stringify(cleanReport),
        stderr: "",
      }),
      sleep,
    });
    expect(result.kind).toBe(AUDIT_KIND.SUCCESS);
    expect(result.attempt).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
