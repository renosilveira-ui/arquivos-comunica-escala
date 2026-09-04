/**
 * Transporte e classificação de `pnpm audit --json`.
 * Não decide policy de vulnerabilidades — só obtém JSON válido ou falha de infra.
 */

export const AUDIT_TIMEOUT_MS = 60_000;
export const AUDIT_MAX_ATTEMPTS = 2;
export const AUDIT_RETRY_BACKOFF_MS = 3_000;

export const AUDIT_KIND = Object.freeze({
  SUCCESS: "SUCCESS",
  TIMEOUT: "TIMEOUT",
  REGISTRY_FAILURE: "REGISTRY_FAILURE",
  EXECUTION_FAILURE: "EXECUTION_FAILURE",
  MALFORMED_RESULT: "MALFORMED_RESULT",
});

const RETRYABLE_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ECONNABORTED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const SECRET_PATTERNS = [
  /\b(authorization|token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi,
  /\b(Bearer|Basic)\s+\S+/gi,
  /\bgh[pousr]_[A-Za-z0-9_]{8,}/g,
  /\bnpm_[A-Za-z0-9]{8,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/g,
];

/**
 * @param {unknown} value
 * @returns {string}
 */
export function sanitizeAuditDiagnostic(value) {
  let text = String(value ?? "");
  if (text.length > 800) {
    text = text.slice(0, 800) + "…";
  }
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, "[redacted]");
  }
  return text;
}

/**
 * @param {string} text
 */
export function looksLikeRegistryFailure(text) {
  const blob = String(text ?? "");
  if (RETRYABLE_ERROR_CODES.has(blob.trim())) return true;
  return (
    /\b(ECONNRESET|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT)\b/i.test(
      blob,
    ) ||
    /\b429\b/.test(blob) ||
    /\b(500|502|503|504)\b/.test(blob) ||
    /too many requests/i.test(blob) ||
    /service unavailable/i.test(blob) ||
    /registry(?:\s+audit)?(?:\s+endpoint)?(?:\s+is)?\s*(?:unavailable|failed|error)/i.test(
      blob,
    )
  );
}

/**
 * @param {string} kind
 */
export function isRetryableAuditKind(kind) {
  return kind === AUDIT_KIND.TIMEOUT || kind === AUDIT_KIND.REGISTRY_FAILURE;
}

/**
 * @param {string} stdout
 * @returns {{ ok: true, report: object } | { ok: false, reason: string }}
 */
export function parseAuditStdout(stdout) {
  const raw = String(stdout ?? "");
  if (raw.trim() === "") {
    return { ok: false, reason: "empty stdout" };
  }
  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace < firstBrace) {
    return { ok: false, reason: "stdout is not JSON" };
  }
  try {
    const report = JSON.parse(raw.slice(firstBrace, lastBrace + 1));
    if (report === null || typeof report !== "object" || Array.isArray(report)) {
      return { ok: false, reason: "JSON is not an object" };
    }
    return { ok: true, report };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "invalid JSON: " + sanitizeAuditDiagnostic(detail) };
  }
}

/**
 * @param {object} spawnResult
 * @param {{ attempt: number, timeoutMs: number }} ctx
 */
export function classifySpawnAuditResult(spawnResult, ctx) {
  const attempt = ctx.attempt;
  const timeoutMs = ctx.timeoutMs;
  const error = spawnResult?.error;
  const errorCode = error && typeof error.code === "string" ? error.code : "";
  const stderr = String(spawnResult?.stderr ?? "");

  if (error) {
    if (errorCode === "ETIMEDOUT") {
      return {
        kind: AUDIT_KIND.TIMEOUT,
        attempt,
        timeoutMs,
        detail: sanitizeAuditDiagnostic(error.message || "ETIMEDOUT"),
      };
    }
    if (RETRYABLE_ERROR_CODES.has(errorCode) || looksLikeRegistryFailure(errorCode + " " + (error.message ?? "") + " " + stderr)) {
      return {
        kind: AUDIT_KIND.REGISTRY_FAILURE,
        attempt,
        timeoutMs,
        detail: sanitizeAuditDiagnostic(error.message || errorCode || "registry failure"),
      };
    }
    return {
      kind: AUDIT_KIND.EXECUTION_FAILURE,
      attempt,
      timeoutMs,
      detail: sanitizeAuditDiagnostic(error.message || errorCode || "cannot execute pnpm audit"),
    };
  }

  if (spawnResult?.signal) {
    if (spawnResult.signal === "SIGKILL") {
      return {
        kind: AUDIT_KIND.TIMEOUT,
        attempt,
        timeoutMs,
        detail: "terminated by SIGKILL",
      };
    }
    return {
      kind: AUDIT_KIND.EXECUTION_FAILURE,
      attempt,
      timeoutMs,
      detail: "terminated by " + spawnResult.signal,
    };
  }

  const status = spawnResult?.status;
  if (status !== 0 && status !== 1) {
    const diagnostic = stderr.trim() || "no diagnostic";
    if (looksLikeRegistryFailure(diagnostic)) {
      return {
        kind: AUDIT_KIND.REGISTRY_FAILURE,
        attempt,
        timeoutMs,
        detail: sanitizeAuditDiagnostic(diagnostic),
      };
    }
    return {
      kind: AUDIT_KIND.EXECUTION_FAILURE,
      attempt,
      timeoutMs,
      detail: sanitizeAuditDiagnostic(
        "exited with status " + status + ": " + diagnostic,
      ),
    };
  }

  const parsed = parseAuditStdout(spawnResult?.stdout);
  if (!parsed.ok) {
    return {
      kind: AUDIT_KIND.MALFORMED_RESULT,
      attempt,
      timeoutMs,
      detail: parsed.reason,
    };
  }

  if (parsed.report.error) {
    const registryDetail = [
      parsed.report.error.code,
      parsed.report.error.message,
    ]
      .filter(Boolean)
      .join(" ");
    if (looksLikeRegistryFailure(registryDetail) || looksLikeRegistryFailure(stderr)) {
      return {
        kind: AUDIT_KIND.REGISTRY_FAILURE,
        attempt,
        timeoutMs,
        detail: sanitizeAuditDiagnostic(registryDetail || "registry audit failed"),
      };
    }
    return {
      kind: AUDIT_KIND.EXECUTION_FAILURE,
      attempt,
      timeoutMs,
      detail: sanitizeAuditDiagnostic(registryDetail || "pnpm audit reported an error"),
    };
  }

  return {
    kind: AUDIT_KIND.SUCCESS,
    attempt,
    timeoutMs,
    report: parsed.report,
  };
}

/**
 * @param {{ kind: string, attempt: number, timeoutMs: number, detail?: string }} result
 * @param {{ maxAttempts?: number }} [opts]
 */
export function formatInfraLog(result, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? AUDIT_MAX_ATTEMPTS;
  const attemptLabel = `(attempt ${result.attempt}/${maxAttempts})`;
  if (result.kind === AUDIT_KIND.TIMEOUT) {
    return `dependency-audit: INFRA: pnpm audit timed out after ${result.timeoutMs}ms ${attemptLabel}`;
  }
  if (result.kind === AUDIT_KIND.REGISTRY_FAILURE) {
    return `dependency-audit: INFRA: registry audit endpoint unavailable ${attemptLabel}`;
  }
  if (result.kind === AUDIT_KIND.MALFORMED_RESULT) {
    const detail = result.detail ? ` — ${sanitizeAuditDiagnostic(result.detail)}` : "";
    return `dependency-audit: INFRA: malformed audit result ${attemptLabel}${detail}`;
  }
  if (result.kind === AUDIT_KIND.EXECUTION_FAILURE) {
    const detail = result.detail ? ` — ${sanitizeAuditDiagnostic(result.detail)}` : "";
    return `dependency-audit: INFRA: pnpm audit execution failed ${attemptLabel}${detail}`;
  }
  return `dependency-audit: INFRA: unexpected audit classification ${result.kind} ${attemptLabel}`;
}

/**
 * @param {number} ms
 */
export function sleepMs(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * @param {{
 *   runAttempt: (attempt: number) => object | Promise<object>,
 *   sleep?: (ms: number) => Promise<void>,
 *   onAttempt?: (result: object) => void,
 *   maxAttempts?: number,
 *   backoffMs?: number,
 *   timeoutMs?: number,
 * }} options
 */
export async function runAuditAttempts(options) {
  const maxAttempts = options.maxAttempts ?? AUDIT_MAX_ATTEMPTS;
  const backoffMs = options.backoffMs ?? AUDIT_RETRY_BACKOFF_MS;
  const timeoutMs = options.timeoutMs ?? AUDIT_TIMEOUT_MS;
  const sleep = options.sleep ?? sleepMs;
  const onAttempt = options.onAttempt ?? (() => {});

  let lastResult = {
    kind: AUDIT_KIND.EXECUTION_FAILURE,
    attempt: 0,
    timeoutMs,
    detail: "no audit attempt ran",
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let spawnResult;
    try {
      spawnResult = await options.runAttempt(attempt);
    } catch (error) {
      const thrown = error instanceof Error ? error : new Error(String(error));
      spawnResult = {
        error: Object.assign(thrown, {
          code: typeof thrown.code === "string" ? thrown.code : "ERR_AUDIT_RUNNER",
        }),
        status: null,
        signal: null,
        stdout: "",
        stderr: "",
      };
    }
    const classified = classifySpawnAuditResult(spawnResult, {
      attempt,
      timeoutMs,
    });
    lastResult = classified;
    onAttempt(classified);

    if (classified.kind === AUDIT_KIND.SUCCESS) {
      return classified;
    }
    if (!isRetryableAuditKind(classified.kind) || attempt >= maxAttempts) {
      return classified;
    }
    await sleep(backoffMs);
  }

  return lastResult;
}
