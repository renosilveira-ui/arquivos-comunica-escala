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
