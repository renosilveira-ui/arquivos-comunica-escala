import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/mysql-core";
import { professionals } from "../drizzle/schema";

const schema = readFileSync(
  new URL("../drizzle/schema.ts", import.meta.url),
  "utf8",
);
const professionalsSchema = schema.slice(
  schema.indexOf("export const professionals = mysqlTable"),
  schema.indexOf("export const professionalInstitutions = mysqlTable"),
);
const auth = readFileSync(
  new URL("../server/routes/auth.ts", import.meta.url),
  "utf8",
);
const catalog = readFileSync(
  new URL("../lib/profession-definitions.ts", import.meta.url),
  "utf8",
);
const occupancy = readFileSync(
  new URL("../server/schedule-contexts.ts", import.meta.url),
  "utf8",
);
const qualification = readFileSync(
  new URL("../server/medical-qualification.ts", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-06-professional-identity-foundation.sql",
    import.meta.url,
  ),
  "utf8",
);
const executableMigration = migration
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

const signupHandler = auth.slice(
  auth.indexOf('"/signup"'),
  auth.indexOf("recordAudit", auth.indexOf('"/signup"') + 1),
);

describe("schema de identidade profissional", () => {
  it("adiciona profession_code como VARCHAR nullable, sem UNIQUE(user_id)", () => {
    expect(professionals.professionCode.name).toBe("profession_code");
    expect(professionals.customProfessionName.name).toBe(
      "custom_profession_name",
    );
    expect(professionals.professionCode.notNull).toBe(false);
    expect(professionals.customProfessionName.notNull).toBe(false);

    const config = getTableConfig(professionals);
    const uniqueColumns = config.uniqueConstraints.flatMap((constraint) =>
      constraint.columns.map(({ name }) => name),
    );
    expect(uniqueColumns).not.toContain("user_id");
    expect(professionalsSchema).not.toMatch(/mysqlEnum\(\s*["']profession/);
    expect(professionalsSchema).toContain('varchar("profession_code"');
    expect(professionalsSchema).not.toMatch(
      /unique\(\)\.on\(\s*table\.userId/,
    );
    expect(professionalsSchema).not.toMatch(
      /unique\(["'][^"']*["']\)\.on\(\s*table\.userId/,
    );
    expect(config.indexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          config: expect.objectContaining({
            name: "idx_professionals_profession_code",
          }),
        }),
      ]),
    );
  });
});

describe("migração de identidade profissional", () => {
  it("é aditiva, rerodável e não cria UNIQUE(user_id)", () => {
    expect(migration).toContain("INFORMATION_SCHEMA.COLUMNS");
    expect(migration).toContain("INFORMATION_SCHEMA.STATISTICS");
    expect(migration).toContain("profession_code VARCHAR(64) NULL");
    expect(migration).toContain("custom_profession_name VARCHAR(120) NULL");
    expect(migration).toContain("idx_professionals_profession_code");
    expect(executableMigration).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(executableMigration).not.toMatch(/UNIQUE\s*\(\s*user_id\s*\)/i);
    expect(executableMigration).not.toMatch(/ADD UNIQUE[^\n]*user_id/i);
    expect(executableMigration).not.toMatch(/\bENUM\s*\(/i);
  });

  it("não classifica gestão como profissão no backfill", () => {
    expect(migration).toContain("AND user_account.role IN ('doctor', 'nurse', 'tech')");
    expect(migration).not.toMatch(/WHEN user_account\.role = 'admin' THEN 'MEDIC'/);
    expect(migration).not.toMatch(/WHEN user_account\.role = 'manager' THEN 'MEDIC'/);
    expect(migration).toContain("SET profession_code = 'MEDIC'");
    expect(migration).toContain("SET profession_code = 'NURSING'");
    expect(migration).toContain("SET profession_code = 'NURSING_TECHNICIAN'");
  });

  it("não cria motor de verificação nem colunas de credencial", () => {
    expect(executableMigration).not.toMatch(/verif/i);
    expect(executableMigration).not.toMatch(
      /crm_number|coren_number|registration_number/i,
    );
    expect(executableMigration).not.toMatch(/CREATE TABLE/i);
  });
});

describe("writers de identidade — source guards", () => {
  it("signup público persiste MEDIC pelo catálogo e ignora professionCode do body", () => {
    expect(signupHandler).toContain('professionalIdentityWriteFields("MEDIC")');
    expect(signupHandler).not.toMatch(/professionCode/);
    expect(signupHandler).toContain('role: "doctor"');
    expect(auth).toContain("from \"../../lib/profession-definitions\"");
  });

  it("register persiste a profissão pelo papel legado, sem redesenhar AuthZ", () => {
    expect(auth).toContain("professionalIdentityForLegacyRole");
    expect(auth).toContain("professionCodeFromLegacyProfessionalRole");
    expect(auth).toContain("requestedRoles.roleInInstitution");
  });

  it("o catálogo não importa ocupação, qualificação nem AuthZ", () => {
    expect(catalog).not.toMatch(/from ["'][^"']*schedule-contexts/);
    expect(catalog).not.toMatch(/from ["'][^"']*medical-qualification/);
    expect(catalog).not.toMatch(/from ["'][^"']*policy/);
    expect(catalog).not.toMatch(/GESTOR_PLUS|roleInInstitution|managerScope/);
    expect(occupancy).not.toContain("profession-definitions");
    expect(qualification).not.toContain("profession-definitions");
  });
});
