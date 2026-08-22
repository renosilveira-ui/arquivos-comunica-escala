export function rowsFromExecute<T extends Record<string, unknown>>(result: unknown): T[] {
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown }).rows;
    return Array.isArray(rows) ? (rows as T[]) : [];
  }

  if (Array.isArray(result)) {
    const first = result[0];
    return Array.isArray(first) ? (first as T[]) : (result as T[]);
  }

  return [];
}

export function firstRowFromExecute<T extends Record<string, unknown>>(result: unknown): T | null {
  return rowsFromExecute<T>(result)[0] ?? null;
}

/**
 * DATETIME vindo de `db.execute` (SQL cru). O driver do Drizzle devolve a
 * string "YYYY-MM-DD HH:MM:SS" em UTC, sem sufixo — `new Date(str)` a
 * interpretaria no fuso do processo. Força UTC.
 */
export function dateFromExecute(value: Date | string | number): Date {
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value);
  const iso = value.includes("T") ? value : value.replace(" ", "T");
  return new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
}
