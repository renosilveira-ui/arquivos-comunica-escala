import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildAuditReport,
  DEFAULT_OSV_API_BASE,
  extractGhsaId,
  formatOsvInfraLog,
  loadOsvAuditReport,
  mapOsvSeverity,
  OSV_KIND,
  OSV_RETRY_BACKOFF_MS,
  parsePnpmLockPackageKey,
  parsePnpmLockPackages,
} from "../scripts/security/osv-source.mjs";

const root = path.resolve(import.meta.dirname, "..");
const lockfile = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
const script = path.join(root, "scripts/security/lockfile-osv-audit.mjs");

const knownFindings = [
  {
    ghsaId: "GHSA-5p2g-fcmc-qvqq",
    packageName: "image-size",
    version: "1.2.1",
    severity: "high",
  },
  {
    ghsaId: "GHSA-w3rx-r6r6-pgpr",
    packageName: "image-size",
    version: "1.2.1",
    severity: "high",
  },
  {
    ghsaId: "GHSA-vcc3-ghjq-m6fr",
    packageName: "decode-uri-component",
    version: "0.2.2",
    severity: "moderate",
  },
];

function jsonResponse(status: number, body: unknown) {
  return {
    status,
    text: async () => JSON.stringify(body),
  };
}

describe("lockfile OSV parser", () => {
  it("lê o lockfile real sem depender da API npm", () => {
    const packages = parsePnpmLockPackages(lockfile);
    expect(packages.length).toBeGreaterThan(1000);
    expect(packages).toContainEqual({ name: "image-size", version: "1.2.1" });
    expect(packages).toContainEqual({
      name: "decode-uri-component",
      version: "0.2.2",
    });
    expect(
      packages.some((pkg) => pkg.name.includes("(") || pkg.version.includes("(")),
    ).toBe(false);
  });

  it("ignora snapshots com peer suffix e chaves inválidas", () => {
    const parsed = parsePnpmLockPackages(`
lockfileVersion: '9.0'
packages:
  'left-pad@1.3.0':
    resolution: {integrity: sha512-aaa}
  unused@file:local:
    resolution: {integrity: sha512-bbb}
snapshots:
  left-pad@1.3.0(peer@1):
    dependencies: {}
`);
    expect(parsed).toEqual([{ name: "left-pad", version: "1.3.0" }]);
    expect(parsePnpmLockPackageKey("left-pad@1.3.0(peer@1)")).toBeNull();
  });
});

describe("OSV severity and GHSA mapping", () => {
  it("mapeia medium→moderate e rejeita severidade desconhecida", () => {
    expect(mapOsvSeverity("HIGH")).toBe("high");
    expect(mapOsvSeverity("medium")).toBe("moderate");
    expect(mapOsvSeverity("moderate")).toBe("moderate");
    expect(mapOsvSeverity("mystery")).toBeNull();
    expect(extractGhsaId({ id: "CVE-2024-1", aliases: ["GHSA-5p2g-fcmc-qvqq"] })).toBe(
      "GHSA-5p2g-fcmc-qvqq",
    );
    expect(extractGhsaId({ id: "CVE-2024-1", aliases: [] })).toBeNull();
  });

  it("monta o contrato de policy com metadata consistente", () => {
    const report = buildAuditReport(knownFindings);
    expect(report.metadata.vulnerabilities).toEqual({
      info: 0,
      low: 0,
      moderate: 1,
      high: 2,
      critical: 0,
    });
    expect(report.advisories["GHSA-5p2g-fcmc-qvqq|image-size"].findings).toEqual([
      { version: "1.2.1" },
    ]);
  });
});

describe("loadOsvAuditReport", () => {
  it("PASS com lockfile limpo e source disponível", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { results: [{}] }));
    const result = await loadOsvAuditReport({
      packages: [{ name: "left-pad", version: "1.3.0" }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.kind).toBe(OSV_KIND.SUCCESS);
    expect(result.report.advisories).toEqual({});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(DEFAULT_OSV_API_BASE);
  });

  it("FAIL para vulnerabilidade nova bloqueante", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("/v1/querybatch")) {
        return jsonResponse(200, {
          results: [{ vulns: [{ id: "GHSA-w5hq-g745-h8pq" }] }],
        });
      }
      return jsonResponse(200, {
        id: "GHSA-w5hq-g745-h8pq",
        aliases: ["GHSA-w5hq-g745-h8pq"],
        database_specific: { severity: "HIGH" },
      });
    });
    const result = await loadOsvAuditReport({
      packages: [{ name: "uuid", version: "11.1.1" }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.kind).toBe(OSV_KIND.SUCCESS);
    expect(result.report.advisories["GHSA-w5hq-g745-h8pq|uuid"].severity).toBe(
      "high",
    );
  });

  it("retrya 503 e falha INFRA na segunda tentativa", async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => jsonResponse(503, { error: "unavailable" }));
    const result = await loadOsvAuditReport({
      packages: [{ name: "left-pad", version: "1.3.0" }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });
    expect(result.kind).toBe(OSV_KIND.SOURCE_FAILURE);
    expect(result.attempt).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(OSV_RETRY_BACKOFF_MS);
    expect(formatOsvInfraLog(result)).toContain("INFRA");
    expect(formatOsvInfraLog(result)).not.toContain("PASS");
  });

  it("timeout nunca vira PASS", async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });
    const result = await loadOsvAuditReport({
      packages: [{ name: "left-pad", version: "1.3.0" }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });
    expect(result.kind).toBe(OSV_KIND.TIMEOUT);
    expect(result.kind).not.toBe(OSV_KIND.SUCCESS);
    expect(formatOsvInfraLog(result)).toContain("timed out");
  });

  it("stdout/JSON malformado e advisory sem GHSA falham fechado", async () => {
    const invalidJson = await loadOsvAuditReport({
      packages: [{ name: "left-pad", version: "1.3.0" }],
      fetchImpl: (async () => ({
        status: 200,
        text: async () => "not-json",
      })) as unknown as typeof fetch,
    });
    expect(invalidJson.kind).toBe(OSV_KIND.MALFORMED_RESULT);

    const noGhsa = await loadOsvAuditReport({
      packages: [{ name: "left-pad", version: "1.3.0" }],
      fetchImpl: (async (url: string) => {
        if (String(url).includes("/v1/querybatch")) {
          return jsonResponse(200, { results: [{ vulns: [{ id: "CVE-2024-1" }] }] });
        }
        return jsonResponse(200, { id: "CVE-2024-1", aliases: [] });
      }) as unknown as typeof fetch,
    });
    expect(noGhsa.kind).toBe(OSV_KIND.MALFORMED_RESULT);
    expect(noGhsa.detail).toContain("no GHSA");
  });

  it("PASS na segunda tentativa após 429", async () => {
    const sleep = vi.fn(async () => {});
    let attempt = 0;
    const fetchImpl = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) return jsonResponse(429, { error: "slow down" });
      return jsonResponse(200, { results: [{}] });
    });
    const result = await loadOsvAuditReport({
      packages: [{ name: "left-pad", version: "1.3.0" }],
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });
    expect(result.kind).toBe(OSV_KIND.SUCCESS);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});

describe("lockfile OSV CLI and workflow", () => {
  it("fonte local indisponível falha INFRA e não imprime PASS", () => {
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
      timeout: 8_000,
      env: {
        ...process.env,
        CI: "",
        DEPENDENCY_OSV_API: "http://127.0.0.1:9",
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dependency-audit: INFRA:");
    expect(result.stderr + result.stdout).not.toContain("dependency-audit: PASS");
  });

  it("proíbe override da fonte OSV no CI", () => {
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        CI: "true",
        DEPENDENCY_OSV_API: "http://127.0.0.1:9",
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dependency audit overrides are forbidden in CI");
  });

  it("separa ci-core de dependency-security e mantém o required check ci", () => {
    const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
    const daily = readFileSync(
      path.join(root, ".github/workflows/dependency-audit.yml"),
      "utf8",
    );

    expect(ci).toContain("name: ci-core");
    expect(ci).toContain("name: dependency-security");
    expect(ci).toContain("name: ci");
    expect(ci).toContain("needs: [ci-core, dependency-security]");
    expect(ci).not.toMatch(/ci-core:[\s\S]*?needs:\s*\[dependency-security\]/);
    expect(ci).toContain("pnpm security:lockfile");
    expect(ci).not.toContain("pnpm security:audit");
    expect(ci).not.toMatch(/continue-on-error:\s*true/);
    expect(ci).not.toContain("|| true");

    const coreIndex = ci.indexOf("name: ci-core");
    const securityIndex = ci.indexOf("name: dependency-security");
    const aggregatorIndex = ci.lastIndexOf("\n  ci:");
    expect(coreIndex).toBeGreaterThan(-1);
    expect(securityIndex).toBeGreaterThan(coreIndex);
    expect(aggregatorIndex).toBeGreaterThan(securityIndex);

    expect(daily).toContain("pnpm security:audit");
    expect(daily).toContain("branches: [main]");
    expect(daily).toContain('cron: "23 9 * * *"');
  });

  it("policy malformed continua fail-closed no register compartilhado", () => {
    const policyScript = path.join(root, "scripts/security/audit-dependencies.mjs");
    const result = spawnSync(process.execPath, [policyScript], {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        CI: "",
        DEPENDENCY_AUDIT_REGISTER: path.join(root, "package.json"),
        DEPENDENCY_AUDIT_REPORT: path.join(root, "package.json"),
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unsupported exception register schema");
  });
});
