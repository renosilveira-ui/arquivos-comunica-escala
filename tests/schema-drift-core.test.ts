import { describe, expect, it } from "vitest";

import {
  buildCatalog,
  diffCatalogs,
  formatDrift,
  normalizeCollation,
  normalizeDefault,
  normalizeExpression,
  normalizeExtra,
  type RawCatalog,
} from "../scripts/schema-drift-core";

function raw(overrides: Partial<RawCatalog> = {}): RawCatalog {
  return {
    tables: [{ name: "audit_trail", engine: "InnoDB" }],
    columns: [
      {
        table: "audit_trail",
        name: "action",
        columnType: "enum('A','B')",
        nullable: "NO",
        columnDefault: null,
        extra: "",
        collation: "utf8mb4_0900_ai_ci",
        generation: "",
      },
      {
        table: "audit_trail",
        name: "created_at",
        columnType: "timestamp",
        nullable: "NO",
        columnDefault: "now()",
        extra: "DEFAULT_GENERATED",
        collation: null,
        generation: "",
      },
    ],
    indexes: [
      { table: "audit_trail", name: "PRIMARY", unique: true, columns: ["id"] },
    ],
    checks: [],
    foreignKeys: [],
    triggers: [],
    ...overrides,
  };
}

/**
 * O que a checagem precisa ignorar (ruído entre servidores) e o que precisa
 * apontar (drift real). Cada caso aqui é um que apareceu no staging em
 * 12/09/2026.
 */
describe("drift schema ↔ banco: normalização", () => {
  it("now(), CURRENT_TIMESTAMP e CURRENT_TIMESTAMP(6) são o mesmo default", () => {
    expect(normalizeDefault("now()")).toBe("CURRENT_TIMESTAMP");
    expect(normalizeDefault("CURRENT_TIMESTAMP")).toBe("CURRENT_TIMESTAMP");
    expect(normalizeDefault("CURRENT_TIMESTAMP(6)")).toBe("CURRENT_TIMESTAMP");
    expect(normalizeDefault(null)).toBe("NULL");
    expect(normalizeDefault("PENDING")).toBe("PENDING");
  });

  it("DEFAULT_GENERATED some do EXTRA; 'on update' sobrevive", () => {
    expect(normalizeExtra("DEFAULT_GENERATED")).toBe("");
    expect(
      normalizeExtra("DEFAULT_GENERATED on update CURRENT_TIMESTAMP"),
    ).toBe("on update current_timestamp");
    expect(normalizeExtra("STORED GENERATED")).toBe("stored generated");
  });

  it("collation: só importa binária ou não", () => {
    expect(normalizeCollation("utf8mb4_0900_ai_ci")).toBe("ci");
    expect(normalizeCollation("utf8mb4_unicode_ci")).toBe("ci");
    expect(normalizeCollation("utf8mb4_bin")).toBe("bin");
    expect(normalizeCollation(null)).toBe("");
  });

  it("expressões: crases, escapes e espaços não contam", () => {
    expect(
      normalizeExpression("(not(regexp_like(`token`,_utf8mb4\\'[[:space:]]\\')))"),
    ).toBe("(not(regexp_like(token,'[[:space:]]')))");
  });
});

describe("drift schema ↔ banco: diferença", () => {
  it("catálogos iguais após normalização → zero drift", () => {
    const a = buildCatalog(raw());
    const b = buildCatalog(
      raw({
        columns: raw().columns.map((c) =>
          c.name === "created_at"
            ? { ...c, columnDefault: "CURRENT_TIMESTAMP", extra: "" }
            : { ...c, collation: "utf8mb4_unicode_ci" },
        ),
      }),
    );
    expect(diffCatalogs(a, b).unexpected).toEqual([]);
  });

  it("enum sem valores no banco é drift real", () => {
    const schema = buildCatalog(raw());
    const bank = buildCatalog(
      raw({
        columns: raw().columns.map((c) =>
          c.name === "action" ? { ...c, columnType: "enum('A')" } : c,
        ),
      }),
    );
    const result = diffCatalogs(schema, bank);
    expect(result.unexpected).toHaveLength(1);
    expect(result.unexpected[0]).toMatchObject({
      kind: "different",
      key: "col audit_trail.action",
    });
  });

  it("nulidade e collation binária são drift real; nome de índice não é", () => {
    const schema = buildCatalog(
      raw({
        columns: [
          {
            table: "push_tokens",
            name: "token",
            columnType: "varchar(512)",
            nullable: "NO",
            columnDefault: null,
            extra: "",
            collation: "utf8mb4_bin",
            generation: "",
          },
        ],
        tables: [{ name: "push_tokens", engine: "InnoDB" }],
        indexes: [
          { table: "push_tokens", name: "uniq_push_token", unique: true, columns: ["token"] },
        ],
      }),
    );
    const bank = buildCatalog(
      raw({
        columns: [
          {
            table: "push_tokens",
            name: "token",
            columnType: "varchar(512)",
            nullable: "NO",
            columnDefault: null,
            extra: "",
            collation: "utf8mb4_0900_ai_ci",
            generation: "",
          },
        ],
        tables: [{ name: "push_tokens", engine: "InnoDB" }],
        indexes: [
          { table: "push_tokens", name: "push_tokens_token_unique", unique: true, columns: ["token"] },
        ],
      }),
    );
    const result = diffCatalogs(schema, bank);
    expect(result.unexpected.map((e) => e.key)).toEqual(["col push_tokens.token"]);
  });

  it("índice único que falta no banco é apontado pela estrutura", () => {
    const schema = buildCatalog(
      raw({
        indexes: [
          { table: "audit_trail", name: "PRIMARY", unique: true, columns: ["id"] },
          { table: "audit_trail", name: "uniq_x", unique: true, columns: ["action"] },
        ],
      }),
    );
    const bank = buildCatalog(raw());
    const result = diffCatalogs(schema, bank);
    expect(result.unexpected).toEqual([
      { kind: "only-in-reference", key: "idx audit_trail [action] unique=true", reference: "" },
    ]);
  });

  it("allowlist retira o conhecido e guarda o motivo; o resto continua inesperado", () => {
    const schema = buildCatalog(raw());
    const bank = buildCatalog(
      raw({
        triggers: [
          { table: "audit_trail", name: "trg_rdf_at_ai" },
          { table: "audit_trail", name: "trg_alguem_esqueceu" },
        ],
      }),
    );
    const result = diffCatalogs(schema, bank, [
      { pattern: "^only-in-target trg .* trg_rdf_[a-z0-9_]+$", reason: "cerca" },
    ]);
    expect(result.allowed.map((e) => [e.key, e.reason])).toEqual([
      ["trg audit_trail trg_rdf_at_ai", "cerca"],
    ]);
    expect(result.unexpected.map((e) => e.key)).toEqual([
      "trg audit_trail trg_alguem_esqueceu",
    ]);
    expect(formatDrift(result)).toContain("1 diferença(s) inesperada(s)");
  });
});
