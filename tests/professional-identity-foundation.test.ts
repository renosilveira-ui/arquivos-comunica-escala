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
    expect(professionalsSchema).toContain(
      'varchar("profession_code", { length: 64 })',
    );
    expect(professionalsSchema).toContain(
      'varchar("custom_profession_name", { length: 120 })',
    );
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

  it("backfill histórico usa só professionals.role e labels inequívocos", () => {
    expect(executableMigration).not.toMatch(/\bJOIN\s+users\b/i);
    expect(executableMigration).not.toMatch(/user_account/);
    expect(executableMigration).not.toMatch(/users\.role/);
    expect(executableMigration).not.toMatch(
      /WHEN user_account\.role = 'doctor' THEN 'MEDIC'/,
    );
    expect(executableMigration).not.toMatch(
      /user_account\.role IN \('doctor', 'nurse', 'tech'\)/,
    );
    expect(migration).toContain("WHEN 'Médico' THEN 'MEDIC'");
    expect(migration).toContain("WHEN 'Enfermeiro' THEN 'NURSING'");
    expect(migration).toContain(
      "WHEN 'Técnico de Enfermagem' THEN 'NURSING_TECHNICIAN'",
    );
    expect(migration).toContain(
      "WHEN 'Técnico de enfermagem' THEN 'NURSING_TECHNICIAN'",
    );
    expect(migration).not.toContain("'Enfermeiro(a)'");
    expect(executableMigration).not.toMatch(/WHEN\s+'Técnico'\s+THEN/);
    expect(executableMigration).not.toMatch(/'Técnico'\s*[,)]/);
    expect(executableMigration).not.toMatch(/\bOTHER\b/);
    expect(migration).toContain("professional_identity_profession_code_contract_mismatch");
    expect(migration).toContain(
      "professional_identity_custom_profession_name_contract_mismatch",
    );
    expect(migration).toContain(
      "professional_identity_profession_code_index_contract_mismatch",
    );
  });

  it("não cria motor de verificação nem colunas de credencial", () => {
    expect(executableMigration).not.toMatch(/verif/i);
    expect(executableMigration).not.toMatch(
      /crm_number|coren_number|registration_number/i,
    );
    expect(executableMigration).not.toMatch(/CREATE TABLE/i);
    expect(executableMigration).not.toMatch(/INSERT\s+INTO\b/i);
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
