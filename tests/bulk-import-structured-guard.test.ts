import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("scripts/bulk-import-professionals.ts", "utf8");

describe("bulk import estruturado", () => {
  it("bloqueia o importador legado antes de CSV, banco ou criação de usuários", () => {
    const guardCall = source.indexOf("blockLegacyUnstructuredImport();");
    const csvRead = source.indexOf("readFileSync(absoluteCsvPath");
    const poolCreation = source.indexOf("const pool = buildPool();");
    const userInsert = source.indexOf("await db.insert(users)");

    expect(guardCall).toBeGreaterThan(-1);
    expect(csvRead).toBeGreaterThan(guardCall);
    expect(poolCreation).toBeGreaterThan(guardCall);
    expect(userInsert).toBeGreaterThan(guardCall);
    expect(source).toContain(
      '"qualificação médica nem escalas autorizadas. Cadastre o piloto pelo Admin "',
    );
  });
});
