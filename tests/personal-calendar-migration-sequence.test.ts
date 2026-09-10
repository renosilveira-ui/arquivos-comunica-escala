import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const foundation = readFileSync(
  "drizzle/migrations/manual/2026-09-09-personal-calendar-foundation.sql",
  "utf8",
);
const hardening = readFileSync(
  "drizzle/migrations/manual/2026-09-09-personal-calendar-check-hardening.sql",
  "utf8",
);
const mysqlSequenceTest = readFileSync(
  "tests/personal-calendar-foundation-migration-mysql.test.ts",
  "utf8",
);

const successorChecks = [
  {
    table: "personal_calendar_items",
    name: "chk_pc_item_location",
    hash: "a239ce6e4c45bf09f114680b1613f896f4daa47c09d5d87ce699bc7cbff6e035",
    fragment: "(LATITUDEISNOTNULL)AND(LONGITUDEISNOTNULL)AND",
  },
  {
    table: "personal_calendar_items",
    name: "chk_pc_item_location_binding",
    hash: "14c5f5c368be2307644859a654b024051d277460fb74daed522d514a6b41e428",
    fragment:
      "(LOCATION_PROVIDERISNOTNULL)AND(LOCATION_EXTERNAL_IDISNOTNULL)AND",
  },
  {
    table: "personal_calendar_items",
    name: "chk_pc_item_shape",
    hash: "c18b09d3ece929f1ba6e2a49f87336f86d92117eea6a33a07226e8e17c4d39c6",
    fragment: "(BIRTHDAY_MONTHISNOTNULL)AND(BIRTHDAY_DAYISNOTNULL)AND",
  },
  {
    table: "personal_calendar_recurrences",
    name: "chk_pc_recurrence_termination",
    hash: "a1a1e7eb573714242ae54a0f3d7d1f2843f168a14b32c00b02bec8a5912d506a",
    fragment: "(OCCURRENCE_COUNTISNOTNULL)AND",
  },
  {
    table: "personal_calendar_recurrences",
    name: "chk_pc_recurrence_weekdays",
    hash: "ba05bc5c8081dec382148e370c1ae611a0f5edfc18fe152337ee3e53794e1487",
    fragment: "(WEEKDAYS_MASKISNOTNULL)AND",
  },
] as const;

function successorManifest() {
  const start = foundation.indexOf(
    "INSERT INTO _personal_calendar_successor_check_contract",
  );
  const end = foundation.indexOf(";", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return [...foundation.slice(start, end).matchAll(
    /\(\s*'([^']+)',\s*'([^']+)',\s*'([a-f0-9]{64})',\s*'([^']+)'\s*\)/g,
  )].map((match) => ({
    table: match[1],
    name: match[2],
    hash: match[3],
    fragment: match[4],
  }));
}

describe("sequência das migrations do calendário pessoal", () => {
  it("mantém allowlist exata dos cinco CHECKs sucessores", () => {
    expect(successorManifest()).toEqual(successorChecks);
    for (const contract of successorChecks) {
      expect(hardening).toContain(`'${contract.hash}'`);
    }
  });

  it("canonicaliza somente nome+tabela+hash exatos e CHECK ENFORCED", () => {
    expect(foundation).toContain(
      "LEFT JOIN _personal_calendar_successor_check_contract AS successor_check",
    );
    expect(foundation).toContain(
      "successor_check.table_name = table_constraints.TABLE_NAME",
    );
    expect(foundation).toContain(
      "successor_check.constraint_name = table_constraints.CONSTRAINT_NAME",
    );
    expect(foundation).toContain("table_constraints.ENFORCED = 'YES'");
    expect(foundation).toMatch(
      /SHA2\(check_constraints\.CHECK_CLAUSE, 256\)\s*=\s*successor_check\.successor_hash/,
    );
    expect(foundation).toContain(
      "successor_check.baseline_fragment_to_restore",
    );
    expect(foundation).toMatch(/CASE[\s\S]*THEN REPLACE[\s\S]*ELSE REPLACE/);

    // LEFT JOIN + ELSE preservam todo CHECK extra ou com hash desconhecido no
    // fingerprint integral; não existe filtro que o retire do GROUP_CONCAT.
    expect(foundation).not.toMatch(
      /WHERE[\s\S]{0,200}successor_check\.constraint_name IS NOT NULL/,
    );
    expect(foundation).toContain(
      "table_constraints.CONSTRAINT_TYPE = 'CHECK'",
    );
  });

  it("preserva os fingerprints baseline integrais", () => {
    expect(foundation).toContain(
      "9ed5c39b35e26d6cbd9253f481c8f85528dfd85fb720663360ec64774a31cd05",
    );
    expect(foundation).toContain(
      "378d2d203c9c37dd3c424fcad13d7bbabe063aeb5f1387a4a445b9a22dc11fa5",
    );
    expect(foundation).toContain(
      "actual_contract.contract_hash <> expected_contract.contract_hash",
    );
  });

  it("recusa qualquer CHECK desabilitado sem alterar os hashes históricos", () => {
    expect(foundation).toContain("SET @pc_contract_unenforced_checks := (");
    expect(foundation).toContain("AND ENFORCED <> 'YES'");
    expect(foundation).toContain(
      "AND @pc_contract_unenforced_checks = 0",
    );
    expect(foundation).toMatch(
      /TABLE_NAME IN \([\s\S]*personal_calendar_alert_rules[\s\S]*personal_calendar_items[\s\S]*personal_calendar_occurrence_exceptions[\s\S]*personal_calendar_occurrences[\s\S]*personal_calendar_recurrences[\s\S]*\)/,
    );
  });

  it("mantém um gate MySQL isolado na ordem foundation → hardening → reruns", () => {
    const start = mysqlSequenceTest.indexOf(
      "async function runFoundationHardeningRerunSequence",
    );
    const end = mysqlSequenceTest.indexOf("\n}\n", start);
    const sequence = mysqlSequenceTest.slice(start, end);
    const operations = [
      "connection.query(migration)",
      "afterFoundation()",
      "connection.query(checkHardeningMigration)",
      "connection.query(migration)",
      "connection.query(checkHardeningMigration)",
    ];
    let cursor = -1;
    for (const operation of operations) {
      const next = sequence.indexOf(operation, cursor + 1);
      expect(next, operation).toBeGreaterThan(cursor);
      cursor = next;
    }
    expect(mysqlSequenceTest).toContain("sequence-sentinel");
  });
});
