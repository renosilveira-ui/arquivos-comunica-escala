import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts/security/audit-dependencies.mjs");
const canonicalRegister = JSON.parse(
  readFileSync(path.join(root, "security/dependency-exceptions.json"), "utf8"),
);
const canonicalReport = {
  advisories: {
    "1138808": {
      severity: "high",
      github_advisory_id: "GHSA-5p2g-fcmc-qvqq",
      module_name: "image-size",
      findings: [{ version: "1.2.1" }],
    },
    "1138809": {
      severity: "high",
      github_advisory_id: "GHSA-w3rx-r6r6-pgpr",
      module_name: "image-size",
      findings: [{ version: "1.2.1" }],
    },
    "1147955": {
      severity: "moderate",
      github_advisory_id: "GHSA-vcc3-ghjq-m6fr",
      module_name: "decode-uri-component",
      findings: [{ version: "0.2.2" }],
    },
  },
  metadata: {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 1,
      high: 2,
      critical: 0,
    },
  },
};
const temporaryDirectories: string[] = [];

function cloneRegister() {
  return structuredClone(canonicalRegister);
}

function canonicalRelativePath(filePath: string) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function runWithRegister(
  register: unknown,
  ci = false,
  report: unknown = canonicalReport,
) {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "dependency-audit-policy-"),
  );
  temporaryDirectories.push(directory);
  const registerPath = path.join(directory, "register.json");
  const reportPath = path.join(directory, "report.json");
  writeFileSync(registerPath, JSON.stringify(register), "utf8");
  writeFileSync(reportPath, JSON.stringify(report), "utf8");

  return spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    timeout: 5_000,
    env: {
      ...process.env,
      CI: ci ? "true" : "",
      DEPENDENCY_AUDIT_REGISTER: registerPath,
      DEPENDENCY_AUDIT_REPORT: reportPath,
    },
  });
}

function expectRejected(
  register: unknown,
  expectedMessage: string,
  ci = false,
) {
  const result = runWithRegister(register, ci);
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(expectedMessage);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("dependency audit policy fails closed", () => {
  it("aceita somente o registro canônico contra os advisories esperados", () => {
    const result = runWithRegister(cloneRegister());
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("3 advisory exception(s) verified");
  });

  it("não permite reduzir o limiar abaixo de moderate", () => {
    const register = cloneRegister();
    register.minimumBlockedSeverity = "critical";
    expectRejected(register, "minimumBlockedSeverity must remain moderate");
  });

  it("vincula pacote e versão ao patchedDependency exato", () => {
    const register = cloneRegister();
    register.exceptions[0].patchedDependency = "decode-uri-component@0.2.2";
    expectRejected(
      register,
      "patchedDependency must exactly match image-size@1.2.1",
    );
  });

  it("não aceita arquivo arbitrário como teste compensatório", () => {
    const register = cloneRegister();
    register.exceptions[0].testFile = "package.json";
    expectRejected(register, "testFile must identify a test under tests/");
  });

  it("não aceita traversal lexical para teste excluído pelo Vitest", () => {
    const register = cloneRegister();
    register.exceptions[0].testFile =
      "tests/../node_modules/zod/src/v4/core/tests/index.test.ts";
    expectRejected(register, "testFile must be a canonical path under tests/");
  });

  it("não aceita symlink intermediário que sai da árvore real de testes", () => {
    const directory = mkdtempSync(
      path.join(root, "tests/dependency-audit-link-"),
    );
    try {
      const link = path.join(directory, "linked");
      symlinkSync(path.join(root, "node_modules"), link, "dir");
      const register = cloneRegister();
      register.exceptions[0].testFile = canonicalRelativePath(
        path.join(link, "zod/src/v4/core/tests/index.test.ts"),
      );
      expectRejected(
        register,
        "testFile must be a canonical path under tests/",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("não aceita teste que o runner compensatório não coleta", () => {
    const register = cloneRegister();
    register.exceptions[0].testFile = "tests/sso-handoff.test.ts";
    expectRejected(
      register,
      "testFile must be listed in vitest.pure.config.ts",
    );
  });

  it("detecta enfraquecimento do conteúdo do teste", () => {
    const register = cloneRegister();
    register.exceptions[0].testSha256 = "0".repeat(64);
    expectRejected(register, "test hash mismatch");
  });

  it("limita toda exceção a uma janela máxima de revisão", () => {
    const register = cloneRegister();
    register.exceptions[0].reviewBy = "2027-01-01";
    expectRejected(register, "exceeds the 92-day review window");
  });

  it("rejeita revisão datada no futuro", () => {
    const register = cloneRegister();
    register.lastReviewed = "2099-01-01";
    expectRejected(register, "lastReviewed cannot be in the future");
  });

  it("proíbe substituir o registro canônico no CI", () => {
    expectRejected(
      cloneRegister(),
      "dependency audit overrides are forbidden in CI",
      true,
    );
  });

  it("rejeita exceção stale quando o advisory desaparece", () => {
    const report = structuredClone(canonicalReport);
    delete report.advisories["1147955"];
    report.metadata.vulnerabilities.moderate = 0;
    const result = runWithRegister(cloneRegister(), false, report);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stale exceptions must be removed");
  });

  it("rejeita advisory inesperado", () => {
    const report = structuredClone(canonicalReport);
    report.advisories["9999999"] = {
      severity: "moderate",
      github_advisory_id: "GHSA-w5hq-g745-h8pq",
      module_name: "uuid",
      findings: [{ version: "11.1.1" }],
    };
    report.metadata.vulnerabilities.moderate = 2;
    const result = runWithRegister(cloneRegister(), false, report);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unapproved advisories");
  });

  it("rejeita formato de advisories ambíguo", () => {
    const report = structuredClone(canonicalReport);
    report.advisories = [];
    const result = runWithRegister(cloneRegister(), false, report);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "pnpm audit response does not contain advisories",
    );
  });

  it("rejeita divergência entre advisories e metadata", () => {
    const report = structuredClone(canonicalReport);
    report.metadata.vulnerabilities.high = 1;
    const result = runWithRegister(cloneRegister(), false, report);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "pnpm audit advisory data differs from high vulnerability metadata",
    );
  });

  it("rejeita metadata maior que os detalhes disponíveis", () => {
    const report = structuredClone(canonicalReport);
    report.metadata.vulnerabilities.moderate = 2;
    const result = runWithRegister(cloneRegister(), false, report);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "pnpm audit advisory data differs from moderate vulnerability metadata",
    );
  });

  it("rejeita severidade desconhecida declarada apenas na metadata", () => {
    const report = structuredClone(canonicalReport);
    (report.metadata.vulnerabilities as Record<string, number>).unknown = 1;
    const result = runWithRegister(cloneRegister(), false, report);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "pnpm audit returned an unexpected vulnerability severity set",
    );
  });
});

describe("dependency audit workflow remains supply-chain hardened", () => {
  const workflowPaths = [
    ".github/workflows/ci.yml",
    ".github/workflows/codeql.yml",
    ".github/workflows/dependency-audit.yml",
  ];

  it("fixa toda GitHub Action em um SHA completo", () => {
    for (const workflowPath of workflowPaths) {
      const source = readFileSync(path.join(root, workflowPath), "utf8");
      const usesLines = source
        .split("\n")
        .filter((line) => /^\s*uses:\s+/.test(line));

      expect(usesLines.length, workflowPath).toBeGreaterThan(0);
      for (const line of usesLines) {
        expect(line, workflowPath).toMatch(
          /uses:\s+[^\s@]+@[0-9a-f]{40}(?:\s+#.*)?$/,
        );
      }
    }
  });

  it("executa a auditoria de dependências diariamente", () => {
    const source = readFileSync(
      path.join(root, ".github/workflows/dependency-audit.yml"),
      "utf8",
    );

    expect(source).toContain('cron: "23 9 * * *"');
  });
});
