/**
 * Núcleo puro da checagem de drift schema ↔ banco real.
 *
 * Por que existe: a CI monta o banco de teste a partir de `drizzle/schema.ts`
 * (`drizzle-kit push`), então schema e banco real podem divergir por meses com
 * CI verde. Foi assim que `audit_trail.action` ficou sem sete valores que o
 * código grava (parecer de bancos, 12/09/2026). Esta comparação lê os dois
 * catálogos (`INFORMATION_SCHEMA`) e mostra a diferença.
 *
 * O que é normalizado (ruído que não muda comportamento):
 *   - `now()` × `CURRENT_TIMESTAMP` × `CURRENT_TIMESTAMP(6)` no DEFAULT;
 *   - `DEFAULT_GENERATED` no EXTRA;
 *   - collation: NADA. Ela é comparada por inteiro desde 12/09/2026.
 *
 *     Até então normalizava para apenas "binária ou não", de propósito, para
 *     acomodar 10 tabelas de migrações manuais que ficaram em
 *     `utf8mb4_unicode_ci` enquanto o resto usava `utf8mb4_0900_ai_ci`. O
 *     preço dessa acomodação: a divergência ficou invisível justamente para
 *     a ferramenta criada para enxergar divergência — e um JOIN entre as duas
 *     famílias devolve erro 1267. A migração
 *     2026-09-12-unify-table-collation.sql removeu a divergência; aqui a
 *     acomodação termina, para ela não poder voltar escondida;
 *   - crases e espaços em expressões geradas e cláusulas CHECK;
 *   - nomes de índice e de FK: compara-se a ESTRUTURA (colunas, unicidade,
 *     referência), não o nome — Drizzle e migrações manuais nomeiam
 *     diferente, e o MySQL não se importa.
 *
 * O que NÃO é normalizado: tipo, nulidade, valor de DEFAULT, enum, unicidade,
 * colunas de índice, alvo de FK, cláusula CHECK, engine. Isso é o que fere.
 */

export type RawCatalog = {
  tables: { name: string; engine: string | null }[];
  columns: {
    table: string;
    name: string;
    columnType: string;
    nullable: string;
    columnDefault: string | null;
    extra: string | null;
    collation: string | null;
    generation: string | null;
  }[];
  indexes: {
    table: string;
    name: string;
    unique: boolean;
    columns: string[];
  }[];
  checks: { table: string; name: string; clause: string }[];
  foreignKeys: {
    table: string;
    name: string;
    references: string[];
  }[];
  triggers: { table: string; name: string }[];
};

export type Catalog = Map<string, string>;

export type DriftEntry = {
  /** `only-in-reference` | `only-in-target` | `different` */
  kind: "only-in-reference" | "only-in-target" | "different";
  key: string;
  reference?: string;
  target?: string;
};

export type AllowlistEntry = {
  /** Regex sobre `${kind} ${key}`. */
  pattern: string;
  reason: string;
};

export function normalizeDefault(value: string | null): string {
  if (value == null) return "NULL";
  const trimmed = String(value).trim();
  if (/^(now\(\)|current_timestamp(\(\d*\))?)$/i.test(trimmed)) {
    return "CURRENT_TIMESTAMP";
  }
  return trimmed;
}

export function normalizeExtra(value: string | null): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/default_generated/g, "")
    .replace(/on update current_timestamp(\(\d*\))?/g, "on update current_timestamp")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Collation comparada por inteiro.
 *
 * Só normaliza caixa, que é ruído de catálogo entre servidores. Qualquer
 * diferença real — `utf8mb4_unicode_ci` × `utf8mb4_0900_ai_ci`, ou a perda
 * de um `_bin` deliberado — passa a aparecer como drift.
 */
export function normalizeCollation(value: string | null): string {
  if (!value) return "";
  return value.trim().toLowerCase();
}

export function normalizeExpression(value: string | null): string {
  return String(value ?? "")
    .replace(/`/g, "")
    .replace(/_utf8mb4\\?'/g, "'")
    .replace(/\\'/g, "'")
    .replace(/\s+/g, "")
    .toLowerCase();
}

export function buildCatalog(raw: RawCatalog): Catalog {
  const catalog: Catalog = new Map();
  for (const table of raw.tables) {
    catalog.set(`tab ${table.name}`, String(table.engine ?? "").toUpperCase());
  }
  for (const column of raw.columns) {
    catalog.set(
      `col ${column.table}.${column.name}`,
      [
        column.columnType.toLowerCase(),
        `null=${column.nullable.toUpperCase()}`,
        `def=${normalizeDefault(column.columnDefault)}`,
        `extra=${normalizeExtra(column.extra)}`,
        `coll=${normalizeCollation(column.collation)}`,
        `gen=${normalizeExpression(column.generation)}`,
      ].join(" "),
    );
  }
  for (const index of raw.indexes) {
    catalog.set(
      `idx ${index.table} [${index.columns.join(",")}] unique=${index.unique}`,
      "",
    );
  }
  for (const check of raw.checks) {
    catalog.set(
      `chk ${check.table} ${normalizeExpression(check.clause)}`,
      "",
    );
  }
  for (const fk of raw.foreignKeys) {
    catalog.set(`fk ${fk.table} ${fk.references.join(",")}`, "");
  }
  for (const trigger of raw.triggers) {
    catalog.set(`trg ${trigger.table} ${trigger.name}`, "");
  }
  return catalog;
}

export function diffCatalogs(
  reference: Catalog,
  target: Catalog,
  allowlist: readonly AllowlistEntry[] = [],
): { unexpected: DriftEntry[]; allowed: (DriftEntry & { reason: string })[] } {
  const entries: DriftEntry[] = [];
  for (const [key, value] of reference) {
    if (!target.has(key)) {
      entries.push({ kind: "only-in-reference", key, reference: value });
    } else if (target.get(key) !== value) {
      entries.push({
        kind: "different",
        key,
        reference: value,
        target: target.get(key),
      });
    }
  }
  for (const [key, value] of target) {
    if (!reference.has(key)) {
      entries.push({ kind: "only-in-target", key, target: value });
    }
  }
  entries.sort((a, b) => `${a.kind} ${a.key}`.localeCompare(`${b.kind} ${b.key}`));

  const compiled = allowlist.map((entry) => ({
    regex: new RegExp(entry.pattern),
    reason: entry.reason,
  }));
  const unexpected: DriftEntry[] = [];
  const allowed: (DriftEntry & { reason: string })[] = [];
  for (const entry of entries) {
    const line = `${entry.kind} ${entry.key}`;
    const match = compiled.find((c) => c.regex.test(line));
    if (match) allowed.push({ ...entry, reason: match.reason });
    else unexpected.push(entry);
  }
  return { unexpected, allowed };
}

export function formatDrift(result: ReturnType<typeof diffCatalogs>): string {
  const lines: string[] = [];
  lines.push(
    `${result.unexpected.length} diferença(s) inesperada(s); ${result.allowed.length} conhecida(s) (allowlist)`,
  );
  for (const entry of result.unexpected) {
    lines.push(`  ${label(entry.kind)}  ${entry.key}`);
    if (entry.kind === "different") {
      lines.push(`      schema: ${entry.reference}`);
      lines.push(`      banco:  ${entry.target}`);
    }
  }
  if (result.allowed.length) {
    lines.push("  conhecidas:");
    for (const entry of result.allowed) {
      lines.push(`    ${label(entry.kind)}  ${entry.key}  — ${entry.reason}`);
    }
  }
  return lines.join("\n");
}

function label(kind: DriftEntry["kind"]): string {
  switch (kind) {
    case "only-in-reference":
      return "SÓ NO SCHEMA ";
    case "only-in-target":
      return "SÓ NO BANCO  ";
    default:
      return "DIFERENTE    ";
  }
}
