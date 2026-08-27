import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-08-27-professional-institutions-role.sql",
    import.meta.url,
  ),
  "utf8",
);
const schema = readFileSync(
  new URL("../drizzle/schema.ts", import.meta.url),
  "utf8",
);

describe("migration manual de role_in_institution", () => {
  it("o schema Drizzle declara a coluna com o nome canônico, não o do enum user_role", () => {
    expect(schema).toContain('mysqlEnum("role_in_institution"');
    expect(schema).toContain(
      "roleInInstitution: roleInInstitutionEnum.notNull().default(\"USER\")",
    );
    expect(schema).not.toMatch(
      /roleInInstitution:\s*userRoleEnum/,
    );
  });

  it("é aditiva, rerodável e cobre professionals.user_role", () => {
    expect(migration).toContain("role_in_institution");
    expect(migration).toContain("user_role");
    expect(migration).toContain("INFORMATION_SCHEMA.COLUMNS");
    expect(migration).toContain("GESTOR_MEDICO");
    expect(migration).toContain("GESTOR_PLUS");
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it("backfill usa users.role legado e professionals.user_role", () => {
    expect(migration).toContain("user_account.role = 'admin'");
    expect(migration).toContain("user_account.role = 'manager'");
    expect(migration).toContain(
      "membership.role_in_institution = professional.user_role",
    );
  });
});
