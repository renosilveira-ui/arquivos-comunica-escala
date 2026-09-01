import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/mysql-core";
import {
  notificationDeliveries,
  operationalEmailVerificationTokens,
  operationalEventRecipients,
  operationalEventRelatedContexts,
  operationalEvents,
  userOperationalEmailTrust,
} from "../drizzle/schema";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-01-operational-events-foundation.sql",
    import.meta.url,
  ),
  "utf8",
);

const schemaSource = readFileSync(
  new URL("../drizzle/schema.ts", import.meta.url),
  "utf8",
);

const ciWorkflow = readFileSync(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);

type ForeignKeyContract = {
  name: string;
  columns: string[];
  foreignColumns: string[];
  onDelete?: "cascade";
};

const operationalEventForeignKeys: ForeignKeyContract[] = [
  {
    name: "fk_operational_events_actor_user",
    columns: ["actor_user_id"],
    foreignColumns: ["id"],
  },
  {
    name: "fk_operational_events_actor_user_institution",
    columns: ["actor_user_id", "institution_id"],
    foreignColumns: ["user_id", "institution_id"],
  },
  {
    name: "fk_operational_events_actor_professional",
    columns: ["actor_professional_id"],
    foreignColumns: ["id"],
  },
  {
    name: "fk_operational_events_institution",
    columns: ["institution_id"],
    foreignColumns: ["id"],
  },
  {
    name: "fk_operational_events_hospital",
    columns: ["hospital_id"],
    foreignColumns: ["id"],
  },
  {
    name: "fk_operational_events_sector",
    columns: ["sector_id"],
    foreignColumns: ["id"],
  },
  {
    name: "fk_operational_events_schedule_context",
    columns: ["schedule_context_id"],
    foreignColumns: ["id"],
  },
  {
    name: "fk_operational_events_shift",
    columns: ["shift_instance_id"],
    foreignColumns: ["id"],
  },
  {
    name: "fk_operational_events_assignment",
    columns: ["assignment_id"],
    foreignColumns: ["id"],
  },
  {
    name: "fk_operational_events_hospital_topology",
    columns: ["institution_id", "hospital_id"],
    foreignColumns: ["institution_id", "id"],
  },
  {
    name: "fk_operational_events_sector_topology",
    columns: ["institution_id", "hospital_id", "sector_id"],
    foreignColumns: ["institution_id", "hospital_id", "id"],
  },
  {
    name: "fk_operational_events_schedule_context_topology",
    columns: [
      "institution_id",
      "hospital_id",
      "sector_id",
      "schedule_context_id",
    ],
    foreignColumns: ["institution_id", "hospital_id", "sector_id", "id"],
  },
  {
    name: "fk_operational_events_shift_topology",
    columns: [
      "institution_id",
      "hospital_id",
      "sector_id",
      "shift_instance_id",
    ],
    foreignColumns: ["institution_id", "hospital_id", "sector_id", "id"],
  },
  {
    name: "fk_operational_events_assignment_topology",
    columns: ["institution_id", "hospital_id", "sector_id", "assignment_id"],
    foreignColumns: ["institution_id", "hospital_id", "sector_id", "id"],
  },
];

const relatedContextForeignKeys: ForeignKeyContract[] = [
  {
    name: "fk_operational_event_related_context_event_institution",
    columns: ["operational_event_id", "institution_id"],
    foreignColumns: ["id", "institution_id"],
    onDelete: "cascade",
  },
  {
    name: "fk_operational_event_related_context_institution",
    columns: ["institution_id"],
    foreignColumns: ["id"],
  },
  {
    name: "fk_operational_event_related_context_hospital",
    columns: ["hospital_id"],
    foreignColumns: ["id"],
  },
  {
    name: "fk_operational_event_related_context_sector",
    columns: ["sector_id"],
    foreignColumns: ["id"],
  },
  {
    name: "fk_operational_event_related_context_schedule_context",
    columns: ["schedule_context_id"],
    foreignColumns: ["id"],
  },
  {
    name: "fk_operational_event_related_context_shift",
    columns: ["shift_instance_id"],
    foreignColumns: ["id"],
  },
  {
    name: "fk_operational_event_related_context_assignment",
    columns: ["assignment_id"],
    foreignColumns: ["id"],
  },
  {
    name: "fk_operational_event_related_context_hospital_topology",
    columns: ["institution_id", "hospital_id"],
    foreignColumns: ["institution_id", "id"],
  },
  {
    name: "fk_operational_event_related_context_sector_topology",
    columns: ["institution_id", "hospital_id", "sector_id"],
    foreignColumns: ["institution_id", "hospital_id", "id"],
  },
  {
    name: "fk_operational_event_related_context_schedule_context_topology",
    columns: [
      "institution_id",
      "hospital_id",
      "sector_id",
      "schedule_context_id",
    ],
    foreignColumns: ["institution_id", "hospital_id", "sector_id", "id"],
  },
  {
    name: "fk_operational_event_related_context_shift_topology",
    columns: [
      "institution_id",
      "hospital_id",
      "sector_id",
      "shift_instance_id",
    ],
    foreignColumns: ["institution_id", "hospital_id", "sector_id", "id"],
  },
  {
    name: "fk_operational_event_related_context_assignment_topology",
    columns: ["institution_id", "hospital_id", "sector_id", "assignment_id"],
    foreignColumns: ["institution_id", "hospital_id", "sector_id", "id"],
  },
];

const recipientForeignKeys: ForeignKeyContract[] = [
  {
    name: "fk_operational_event_recipients_event",
    columns: ["operational_event_id"],
    foreignColumns: ["id"],
    onDelete: "cascade",
  },
  {
    name: "fk_operational_event_recipient_event_institution",
    columns: ["operational_event_id", "institution_id"],
    foreignColumns: ["id", "institution_id"],
    onDelete: "cascade",
  },
  {
    name: "fk_operational_event_recipient_institution",
    columns: ["institution_id"],
    foreignColumns: ["id"],
  },
  {
    name: "fk_operational_event_recipients_user",
    columns: ["user_id"],
    foreignColumns: ["id"],
  },
  {
    name: "fk_operational_event_recipient_user_institution",
    columns: ["user_id", "institution_id"],
    foreignColumns: ["user_id", "institution_id"],
  },
  {
    name: "fk_operational_event_recipients_schedule_invite",
    columns: ["schedule_invite_id"],
    foreignColumns: ["id"],
  },
  {
    name: "fk_operational_event_recipient_schedule_invite_institution",
    columns: ["schedule_invite_id", "institution_id"],
    foreignColumns: ["id", "institution_id"],
  },
];

const deliveryForeignKeys: ForeignKeyContract[] = [
  {
    name: "fk_notification_deliveries_recipient",
    columns: ["operational_event_recipient_id"],
    foreignColumns: ["id"],
    onDelete: "cascade",
  },
];

const emailTrustForeignKeys: ForeignKeyContract[] = [
  {
    name: "fk_operational_email_trust_user",
    columns: ["user_id"],
    foreignColumns: ["id"],
    onDelete: "cascade",
  },
];

const emailVerificationForeignKeys: ForeignKeyContract[] = [
  {
    name: "fk_operational_email_verification_user",
    columns: ["user_id"],
    foreignColumns: ["id"],
    onDelete: "cascade",
  },
];

const allForeignKeys = [
  ...operationalEventForeignKeys,
  ...relatedContextForeignKeys,
  ...recipientForeignKeys,
  ...deliveryForeignKeys,
  ...emailTrustForeignKeys,
  ...emailVerificationForeignKeys,
];

const expectedFoundationContractHashes = [
  "5b6a9aa1e1c0b9f6c7c802e1426dc5a127a89a6a51a32a08df274a45bc831696",
  "2c4e53e3bde09ac0988783e3ededd7d0df8c09afcace4b9b10f5975f0c81a3d0",
  "e31345f78c453327f914db495583ddfd3ec1854ff8fca2980748a13f61a00a28",
  "c60097a40c96471bbb11b7b1fb00b0fddf3d22a94040801f1615037ab3d5a7ff",
  "4e555009bf9ff1d7c7ecdd31ca515da0786201e34d8c685ff2a34c9647104568",
  "60e2426c4e90c52a7a4cc169e7519040dfed86365fc53a31537b4ee14c97f10c",
];

function expectForeignKeys(
  table: Parameters<typeof getTableConfig>[0],
  expected: ForeignKeyContract[],
) {
  const actual = new Map(
    getTableConfig(table).foreignKeys.map((foreignKey) => [
      foreignKey.getName(),
      foreignKey,
    ]),
  );

  expect([...actual.keys()].sort()).toEqual(
    expected.map(({ name }) => name).sort(),
  );

  for (const contract of expected) {
    const foreignKey = actual.get(contract.name);
    expect(foreignKey, contract.name).toBeDefined();
    const reference = foreignKey!.reference();
    expect(reference.columns.map(({ name }) => name)).toEqual(contract.columns);
    expect(reference.foreignColumns.map(({ name }) => name)).toEqual(
      contract.foreignColumns,
    );
    expect(foreignKey!.onDelete).toBe(contract.onDelete);
    expect(contract.name.length).toBeLessThanOrEqual(64);
  }
}

function migrationForeignKeyNames() {
  return [...migration.matchAll(/CONSTRAINT\s+(fk_[a-z0-9_]+)/g)].map(
    ([, name]) => name!,
  );
}

describe("foundation de eventos operacionais", () => {
  it("nomeia cada FK explicitamente, dentro do limite MySQL, com cascades previstos", () => {
    expectForeignKeys(operationalEvents, operationalEventForeignKeys);
    expectForeignKeys(
      operationalEventRelatedContexts,
      relatedContextForeignKeys,
    );
    expectForeignKeys(operationalEventRecipients, recipientForeignKeys);
    expectForeignKeys(notificationDeliveries, deliveryForeignKeys);
    expectForeignKeys(userOperationalEmailTrust, emailTrustForeignKeys);
    expectForeignKeys(
      operationalEmailVerificationTokens,
      emailVerificationForeignKeys,
    );
  });

  it("não deixa referências inline gerarem nomes automáticos longos", () => {
    const foundationSource = schemaSource.slice(
      schemaSource.indexOf("export const operationalEvents"),
      schemaSource.indexOf("export const ssoUsedTokens"),
    );

    expect(foundationSource).not.toContain(".references(");
    expect(foundationSource.match(/foreignKey\(/g) ?? []).toHaveLength(36);
  });

  it("mantém topo institucional e destinatários canônicos sem endereço em claro", () => {
    expect(operationalEvents.institutionId.notNull).toBe(true);
    expect(operationalEvents.scopeKind.enumValues).toEqual([
      "INSTITUTION",
      "HOSPITAL",
      "SECTOR",
    ]);
    expect(operationalEventRecipients.recipientKind.enumValues).toEqual([
      "USER",
      "SCHEDULE_INVITE",
    ]);
    expect("email" in operationalEventRecipients).toBe(false);
    expect("email" in notificationDeliveries).toBe(false);
    expect("idempotencyKey" in operationalEvents).toBe(false);
    expect("metadata" in operationalEvents).toBe(false);
    expect(userOperationalEmailTrust.emailHash.notNull).toBe(true);
    expect(operationalEmailVerificationTokens.tokenHash.notNull).toBe(true);
  });

  it("mantém a migration aditiva e em perfeita paridade nominal com o schema", () => {
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN|DATABASE)\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migration).not.toMatch(/^\s*UPDATE\s+/im);
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS operational_events",
    );
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS operational_event_related_contexts",
    );
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS operational_event_recipients",
    );
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS notification_deliveries",
    );
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS user_operational_email_trust",
    );
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS operational_email_verification_tokens",
    );
    expect(migration).toContain("HAVING MAX(NON_UNIQUE) = 0");
    expect(migration).not.toContain("HAVING NON_UNIQUE = 0");
    expect(migrationForeignKeyNames().sort()).toEqual(
      allForeignKeys.map(({ name }) => name).sort(),
    );
    expect(migrationForeignKeyNames().every((name) => name.length <= 64)).toBe(
      true,
    );
    for (const { name, onDelete } of allForeignKeys) {
      const constraint = migration.match(
        new RegExp(
          `CONSTRAINT\\s+${name}([\\s\\S]*?)(?:,\\n\\s*CONSTRAINT|\\n\\) ENGINE=InnoDB;)`,
        ),
      )?.[1];
      expect(constraint, name).toBeDefined();
      expect(constraint!.includes("ON DELETE CASCADE")).toBe(
        onDelete === "cascade",
      );
    }
  });

  it("falha fechada para uma fundação pré-existente incompatível, antes e depois do DDL", () => {
    expect(migration).toContain(
      "CREATE TEMPORARY TABLE _operational_events_contract_expected",
    );
    expect(migration).toContain(
      "PREPARE operational_events_contract_preflight_stmt",
    );
    expect(migration).toContain(
      "PREPARE operational_events_contract_postflight_stmt",
    );
    expect(migration).toContain(
      "PREPARE operational_events_contract_restore_session_stmt",
    );
    expect(migration).toContain(
      "DROP TEMPORARY TABLE _operational_events_contract_expected;",
    );
    expect(migration).not.toContain(
      "DROP TEMPORARY TABLE IF EXISTS _operational_events_contract_expected",
    );
    expect(migration).toContain(
      "__operational_events_contract_preflight_rejected__",
    );
    expect(migration).toContain(
      "__operational_events_contract_postflight_rejected__",
    );
    expect(migration).toContain("tables.ENGINE");
    expect(migration).toContain("tables.TABLE_COLLATION");
    expect(migration).toContain("INFORMATION_SCHEMA.SCHEMATA");
    expect(migration).toContain("<DATABASE_DEFAULT>");
    expect(migration).toContain("INFORMATION_SCHEMA.COLUMNS");
    expect(migration).toContain("INFORMATION_SCHEMA.STATISTICS");
    expect(migration).toContain("indexes.INDEX_TYPE");
    expect(migration).toContain("INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS");
    expect(migration).toContain("key_columns.REFERENCED_TABLE_SCHEMA");
    expect(migration).toContain("<CURRENT_SCHEMA>");
    expect(migration).toContain("INFORMATION_SCHEMA.CHECK_CONSTRAINTS");
    expect(migration).toContain("actual_contract.table_name IS NULL");
    expect(
      migration.indexOf("PREPARE operational_events_contract_preflight_stmt"),
    ).toBeLessThan(migration.indexOf("ALTER TABLE hospitals"));
    for (const hash of expectedFoundationContractHashes) {
      expect(migration).toContain(hash);
    }
  });

  it("executa a prova MySQL descartável no serviço local da CI", () => {
    expect(ciWorkflow).toContain(
      "- name: Test operational events migration contract",
    );
    expect(ciWorkflow).toContain(
      'OPERATIONAL_EVENTS_MIGRATION_MYSQL_TEST: "1"',
    );
    expect(ciWorkflow).toContain(
      "OPERATIONAL_EVENTS_MIGRATION_MYSQL_URL: mysql://root:root@127.0.0.1:3306",
    );
    expect(ciWorkflow).toContain(
      "pnpm exec vitest run --config vitest.operational-events-mysql.config.ts",
    );
  });
});
