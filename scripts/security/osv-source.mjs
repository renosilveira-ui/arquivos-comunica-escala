/**
 * Fonte de advisories via OSV (api.osv.dev), independente da API npm audit.
 * Não decide policy — só devolve JSON no contrato do gate local ou falha de infra.
 */

export const OSV_KIND = Object.freeze({
  SUCCESS: "SUCCESS",
  TIMEOUT: "TIMEOUT",
  SOURCE_FAILURE: "SOURCE_FAILURE",
  MALFORMED_RESULT: "MALFORMED_RESULT",
});

export const OSV_TIMEOUT_MS = 20_000;
export const OSV_MAX_ATTEMPTS = 2;
export const OSV_RETRY_BACKOFF_MS = 3_000;
export const OSV_QUERY_CHUNK = 500;
export const DEFAULT_OSV_API_BASE = "https://api.osv.dev";

const PACKAGE_KEY_LINE = /^ {2}(?:'([^']+)'|"([^"]+)"|([^:]+)):$/;
const SEVERITY = Object.freeze({
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
});

/**
 * @param {string} raw
 * @returns {{ name: string, version: string } | null}
 */
export function parsePnpmLockPackageKey(raw) {
  const key = String(raw ?? "").trim();
  if (!key || key.includes("(") || key.includes("://")) return null;
  const at = key.startsWith("@") ? key.indexOf("@", 1) : key.indexOf("@");
  if (at <= 0 || at === key.length - 1) return null;
  const name = key.slice(0, at);
  const version = key.slice(at + 1);
  if (!name || !version || version.includes("/") || version.includes(" ")) {
    return null;
  }
  return { name, version };
}

/**
 * @param {string} lockfileText
 * @returns {{ name: string, version: string }[]}
 */
export function parsePnpmLockPackages(lockfileText) {
  const lines = String(lockfileText ?? "").split(/\r?\n/);
  const seen = new Set();
  const packages = [];
  let inPackages = false;

  for (const line of lines) {
    if (line === "packages:") {
      inPackages = true;
      continue;
    }
    if (inPackages && line && !line.startsWith(" ") && line.endsWith(":")) {
      break;
    }
    if (!inPackages) continue;
    const matched = line.match(PACKAGE_KEY_LINE);
    if (!matched) continue;
    const parsed = parsePnpmLockPackageKey(matched[1] ?? matched[2] ?? matched[3]);
    if (!parsed) continue;
    const identity = parsed.name + "@" + parsed.version;
    if (seen.has(identity)) continue;
    seen.add(identity);
    packages.push(parsed);
  }

  return packages;
}

/**
 * @param {unknown} value
 * @returns {"low" | "moderate" | "high" | "critical" | null}
 */
export function mapOsvSeverity(value) {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (raw === "medium") return "moderate";
  if (raw === "low" || raw === "moderate" || raw === "high" || raw === "critical") {
    return raw;
  }
  return null;
}

/**
 * @param {object} vuln
 * @returns {string | null}
 */
export function extractGhsaId(vuln) {
  const candidates = [vuln?.id, ...(Array.isArray(vuln?.aliases) ? vuln.aliases : [])];
  for (const candidate of candidates) {
    if (
      typeof candidate === "string" &&
      /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(candidate)
    ) {
      return candidate;
    }
  }
  return null;
}

/**
 * @param {Array<{ ghsaId: string, packageName: string, version: string, severity: string }>} findings
 */
export function buildAuditReport(findings) {
  const advisories = {};
  const metadata = {
    vulnerabilities: {
      info: 0,
      low: 0,
      moderate: 0,
      high: 0,
      critical: 0,
    },
  };

  const grouped = new Map();
  for (const finding of findings) {
    const key = finding.ghsaId + "|" + finding.packageName;
    if (!grouped.has(key)) {
      grouped.set(key, {
        severity: finding.severity,
        github_advisory_id: finding.ghsaId,
        module_name: finding.packageName,
        versions: new Set(),
      });
    }
    const group = grouped.get(key);
    if (group.severity !== finding.severity) {
      throw new Error(
        "conflicting severity for " + key + ": " + group.severity + " vs " + finding.severity,
      );
    }
    group.versions.add(finding.version);
  }

  for (const [key, group] of grouped.entries()) {
    advisories[key] = {
      severity: group.severity,
      github_advisory_id: group.github_advisory_id,
      module_name: group.module_name,
      findings: [...group.versions].sort().map((version) => ({ version })),
    };
    metadata.vulnerabilities[group.severity] += 1;
  }

  return { advisories, metadata };
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

function sleepMs(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * @param {{
 *   url: string,
 *   method?: string,
 *   body?: string,
 *   timeoutMs: number,
 *   fetchImpl: typeof fetch,
 * }} options
 */
async function fetchJson(options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.fetchImpl(options.url, {
      method: options.method ?? "GET",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: options.body,
      signal: controller.signal,
    });
    const text = await response.text();
    return { status: response.status, text };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const code = typeof error?.code === "string" ? error.code : "";
    if (name === "AbortError" || code === "ETIMEDOUT" || /timeout/i.test(String(error))) {
      const timeoutError = new Error("OSV request timed out after " + options.timeoutMs + "ms");
      timeoutError.code = "ETIMEDOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {{
 *   packages: { name: string, version: string }[],
 *   apiBase?: string,
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   timeoutMs?: number,
 *   maxAttempts?: number,
 *   backoffMs?: number,
 * }} options
 */
export async function loadOsvAuditReport(options) {
  const apiBase = (options.apiBase ?? DEFAULT_OSV_API_BASE).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? sleepMs;
  const timeoutMs = options.timeoutMs ?? OSV_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? OSV_MAX_ATTEMPTS;
  const backoffMs = options.backoffMs ?? OSV_RETRY_BACKOFF_MS;
  const packages = options.packages;

  if (!Array.isArray(packages)) {
    return { kind: OSV_KIND.MALFORMED_RESULT, detail: "lockfile package list is missing" };
  }

  let lastFailure = {
    kind: OSV_KIND.SOURCE_FAILURE,
    detail: "OSV source was not queried",
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const hits = [];
      for (let index = 0; index < packages.length; index += OSV_QUERY_CHUNK) {
        const chunk = packages.slice(index, index + OSV_QUERY_CHUNK);
        const body = JSON.stringify({
          queries: chunk.map((pkg) => ({
            package: { name: pkg.name, ecosystem: "npm" },
            version: pkg.version,
          })),
        });
        const queried = await fetchJson({
          url: apiBase + "/v1/querybatch",
          method: "POST",
          body,
          timeoutMs,
          fetchImpl,
        });
        if (queried.status === 404 || queried.status === 400) {
          return {
            kind: OSV_KIND.MALFORMED_RESULT,
            attempt,
            detail: "OSV querybatch rejected the lockfile query (" + queried.status + ")",
          };
        }
        if (isRetryableStatus(queried.status)) {
          lastFailure = {
            kind: OSV_KIND.SOURCE_FAILURE,
            attempt,
            detail: "OSV querybatch returned HTTP " + queried.status,
          };
          throw Object.assign(new Error(lastFailure.detail), { retryable: true });
        }
        if (queried.status !== 200) {
          return {
            kind: OSV_KIND.SOURCE_FAILURE,
            attempt,
            detail: "OSV querybatch returned HTTP " + queried.status,
          };
        }
        let parsed;
        try {
          parsed = JSON.parse(queried.text);
        } catch {
          return {
            kind: OSV_KIND.MALFORMED_RESULT,
            attempt,
            detail: "OSV querybatch returned invalid JSON",
          };
        }
        const results = parsed?.results;
        if (!Array.isArray(results) || results.length !== chunk.length) {
          return {
            kind: OSV_KIND.MALFORMED_RESULT,
            attempt,
            detail: "OSV querybatch result count does not match the query",
          };
        }
        for (let i = 0; i < chunk.length; i += 1) {
          const vulns = results[i]?.vulns;
          if (vulns == null) continue;
          if (!Array.isArray(vulns)) {
            return {
              kind: OSV_KIND.MALFORMED_RESULT,
              attempt,
              detail: "OSV querybatch vuln list is not an array",
            };
          }
          for (const vuln of vulns) {
            if (vuln && typeof vuln.id === "string" && vuln.id.trim() !== "") {
              hits.push({ packageName: chunk[i].name, version: chunk[i].version, id: vuln.id });
            }
          }
        }
      }

      const uniqueIds = [...new Set(hits.map((hit) => hit.id))];
      const details = new Map();
      for (const id of uniqueIds) {
        const fetched = await fetchJson({
          url: apiBase + "/v1/vulns/" + encodeURIComponent(id),
          timeoutMs,
          fetchImpl,
        });
        if (isRetryableStatus(fetched.status)) {
          lastFailure = {
            kind: OSV_KIND.SOURCE_FAILURE,
            attempt,
            detail: "OSV vulns returned HTTP " + fetched.status,
          };
          throw Object.assign(new Error(lastFailure.detail), { retryable: true });
        }
        if (fetched.status !== 200) {
          return {
            kind: OSV_KIND.SOURCE_FAILURE,
            attempt,
            detail: "OSV vulns returned HTTP " + fetched.status + " for " + id,
          };
        }
        let vuln;
        try {
          vuln = JSON.parse(fetched.text);
        } catch {
          return {
            kind: OSV_KIND.MALFORMED_RESULT,
            attempt,
            detail: "OSV vuln " + id + " is not JSON",
          };
        }
        details.set(id, vuln);
      }

      const findings = [];
      for (const hit of hits) {
        const vuln = details.get(hit.id);
        const ghsaId = extractGhsaId(vuln);
        if (!ghsaId) {
          return {
            kind: OSV_KIND.MALFORMED_RESULT,
            attempt,
            detail: "OSV advisory " + hit.id + " has no GHSA id",
          };
        }
        const severity = mapOsvSeverity(vuln?.database_specific?.severity);
        if (!severity || !Object.hasOwn(SEVERITY, severity) || severity === "info") {
          if (severity === "info") {
            continue;
          }
          return {
            kind: OSV_KIND.MALFORMED_RESULT,
            attempt,
            detail: "OSV advisory " + ghsaId + " has unmappable severity",
          };
        }
        findings.push({
          ghsaId,
          packageName: hit.packageName,
          version: hit.version,
          severity,
        });
      }

      try {
        return {
          kind: OSV_KIND.SUCCESS,
          attempt,
          report: buildAuditReport(findings),
        };
      } catch (error) {
        return {
          kind: OSV_KIND.MALFORMED_RESULT,
          attempt,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "";
      if (code === "ETIMEDOUT") {
        lastFailure = {
          kind: OSV_KIND.TIMEOUT,
          attempt,
          timeoutMs,
          detail: error instanceof Error ? error.message : String(error),
        };
      } else if (error?.retryable) {
        lastFailure = {
          kind: OSV_KIND.SOURCE_FAILURE,
          attempt,
          detail: error instanceof Error ? error.message : String(error),
        };
      } else {
        return {
          kind: OSV_KIND.SOURCE_FAILURE,
          attempt,
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      if (attempt >= maxAttempts) {
        return lastFailure;
      }
      await sleep(backoffMs);
    }
  }

  return lastFailure;
}

export function formatOsvInfraLog(result) {
  const attempt = result.attempt ? ` (attempt ${result.attempt}/${OSV_MAX_ATTEMPTS})` : "";
  if (result.kind === OSV_KIND.TIMEOUT) {
    return `dependency-audit: INFRA: OSV advisory source timed out after ${result.timeoutMs}ms${attempt}`;
  }
  if (result.kind === OSV_KIND.SOURCE_FAILURE) {
    return `dependency-audit: INFRA: OSV advisory source unavailable${attempt}`;
  }
  if (result.kind === OSV_KIND.MALFORMED_RESULT) {
    const detail = result.detail ? ` — ${result.detail}` : "";
    return `dependency-audit: INFRA: malformed OSV advisory result${attempt}${detail}`;
  }
  return `dependency-audit: INFRA: unexpected OSV classification ${result.kind}${attempt}`;
}
