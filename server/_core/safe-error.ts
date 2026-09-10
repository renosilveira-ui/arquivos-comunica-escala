/**
 * Projeção segura de falhas para logs.
 *
 * Erros de drivers e integrações frequentemente carregam query, params,
 * credenciais e PII em `message`, `stack`, `cause` ou propriedades próprias.
 * Esta fronteira nunca devolve esses campos: somente categorias e códigos de
 * vocabulário fechado podem atravessar para o logger.
 */

export type SafeErrorCategory =
  | "application"
  | "authentication"
  | "concurrency"
  | "configuration"
  | "database"
  | "network"
  | "programming"
  | "timeout"
  | "unknown";

const SAFE_ERROR_CODES = {
  DATABASE_NOT_INITIALIZED: "configuration",
  DB_PROBE_TIMEOUT: "timeout",
  EAI_AGAIN: "network",
  ECONNREFUSED: "network",
  ECONNRESET: "network",
  EHOSTUNREACH: "network",
  ENETUNREACH: "network",
  ENOTFOUND: "network",
  ETIMEDOUT: "timeout",
  ER_ACCESS_DENIED_ERROR: "authentication",
  ER_BAD_DB_ERROR: "database",
  ER_DBACCESS_DENIED_ERROR: "authentication",
  ER_DUP_ENTRY: "database",
  ER_LOCK_DEADLOCK: "concurrency",
  ER_LOCK_WAIT_TIMEOUT: "timeout",
  ER_NO_REFERENCED_ROW_2: "database",
  ER_ROW_IS_REFERENCED_2: "database",
  PROTOCOL_CONNECTION_LOST: "network",
  PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR: "network",
} as const satisfies Record<string, SafeErrorCategory>;

export type SafeErrorCode = keyof typeof SAFE_ERROR_CODES;

export interface SafeErrorDiagnostic {
  errorCategory: SafeErrorCategory;
  errorCode?: SafeErrorCode;
}

function readOwnDataProperty(
  value: object,
  property: "code" | "cause" | "name" | "params" | "query",
): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function asSafeErrorCode(value: unknown): SafeErrorCode | undefined {
  return typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(SAFE_ERROR_CODES, value)
    ? (value as SafeErrorCode)
    : undefined;
}

/** Lê apenas `code` allowlisted, inclusive em wrappers com `cause`. */
export function findSafeErrorCode(error: unknown): SafeErrorCode | undefined {
  let current = error;
  const seen = new Set<object>();

  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== "object" || seen.has(current)) break;
    seen.add(current);
    const code = asSafeErrorCode(readOwnDataProperty(current, "code"));
    if (code) return code;
    current = readOwnDataProperty(current, "cause");
  }

  return undefined;
}

function looksLikeDatabaseError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = readOwnDataProperty(error, "name");
  if (name === "DrizzleQueryError") return true;
  return (
    readOwnDataProperty(error, "query") !== undefined ||
    readOwnDataProperty(error, "params") !== undefined
  );
}

function isProgrammingError(error: unknown): boolean {
  try {
    return (
      error instanceof EvalError ||
      error instanceof RangeError ||
      error instanceof ReferenceError ||
      error instanceof SyntaxError ||
      error instanceof TypeError
    );
  } catch {
    return false;
  }
}

/**
 * Converte qualquer valor lançado em metadados seguros e estáveis.
 * Deliberadamente não gera fingerprint a partir do conteúdo sensível.
 */
export function safeErrorDiagnostic(
  error: unknown,
  fallbackCategory: SafeErrorCategory = "unknown",
): SafeErrorDiagnostic {
  const errorCode = findSafeErrorCode(error);
  if (errorCode) {
    return {
      errorCategory: SAFE_ERROR_CODES[errorCode],
      errorCode,
    };
  }
  if (looksLikeDatabaseError(error)) return { errorCategory: "database" };
  if (isProgrammingError(error)) {
    return { errorCategory: "programming" };
  }
  return { errorCategory: fallbackCategory };
}

export function safeDiagnosticForCode(
  errorCode: SafeErrorCode,
): SafeErrorDiagnostic {
  return {
    errorCategory: SAFE_ERROR_CODES[errorCode],
    errorCode,
  };
}
