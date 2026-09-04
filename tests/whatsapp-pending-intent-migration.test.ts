import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-04-whatsapp-pending-intents.sql",
    import.meta.url,
  ),
  "utf8",
);
const inboundMigration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-04-whatsapp-inbound-messages.sql",
    import.meta.url,
  ),
  "utf8",
);
const schema = readFileSync(
  new URL("../drizzle/schema.ts", import.meta.url),
  "utf8",
);

function pendingSchemaBlock(): string {
  const start = schema.indexOf("export const whatsappPendingIntents");
  const end = schema.indexOf("export type WhatsappPendingIntent");
  return schema.slice(start, end);
}

describe("migration manual whatsapp_pending_intents", () => {
  it("é aditiva, rerodável e sem DROP/DELETE", () => {
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS whatsapp_pending_intents",
    );
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(migration).toContain("NÃO aplicar no staging nesta PR");
  });

  it("não altera a migration inbound já aplicada", () => {
    expect(inboundMigration).not.toMatch(/CREATE TABLE.*whatsapp_pending/i);
    expect(inboundMigration).toContain(
      "CREATE TABLE IF NOT EXISTS whatsapp_inbound_messages",
    );
  });

  it("impõe UNIQUE de source, um OPEN por user e FKs conscientes", () => {
    const ddl = migration.slice(
      migration.indexOf("CREATE TABLE IF NOT EXISTS whatsapp_pending_intents"),
    );
    expect(ddl).toContain(
      "UNIQUE KEY uniq_whatsapp_pending_source (source_inbound_message_id)",
    );
    expect(ddl).toContain(
      "UNIQUE KEY uniq_whatsapp_pending_open_user (user_id, open_slot)",
    );
    expect(ddl).toContain("GENERATED ALWAYS AS");
    expect(ddl).toContain("IF(`status` = 'OPEN', 1, NULL)");
    expect(ddl).toContain("REFERENCES whatsapp_inbound_messages(id)");
    expect(ddl).toContain("ON DELETE RESTRICT");
    expect(ddl).toContain("REFERENCES users(id)");
    expect(ddl).toContain("ON DELETE CASCADE");
    expect(ddl).toContain("REFERENCES institutions(id)");
    expect(ddl).toContain("ON DELETE SET NULL");
    expect(ddl).not.toMatch(/\bbody\b/i);
    expect(ddl).not.toMatch(/signature|auth_token|phone|from_e164/i);
    expect(ddl).not.toContain("CONFIRMED");
  });

  it("mantém paridade com o bloco Drizzle whatsappPendingIntents", () => {
    const ddl = migration.slice(
      migration.indexOf("CREATE TABLE IF NOT EXISTS whatsapp_pending_intents"),
    );
    const block = pendingSchemaBlock();
    const sqlColumns = [
      "id",
      "user_id",
      "source_inbound_message_id",
      "institution_id",
      "status",
      "stage",
      "intent_kind",
      "parsed_payload",
      "resolved_payload",
      "clarification_payload",
      "expires_at",
      "consumed_at",
      "payload_cleared_at",
      "created_at",
      "updated_at",
      "open_slot",
    ];
    const drizzleColumns = [
      'int("id")',
      'int("user_id")',
      'int("source_inbound_message_id")',
      'int("institution_id")',
      'mysqlEnum("status"',
      'mysqlEnum("stage"',
      'mysqlEnum("intent_kind"',
      'json("parsed_payload")',
      'json("resolved_payload")',
      'json("clarification_payload")',
      'timestamp("expires_at")',
      'timestamp("consumed_at")',
      'timestamp("payload_cleared_at")',
      'timestamp("created_at")',
      'timestamp("updated_at")',
      'tinyint("open_slot")',
    ];
    for (const column of sqlColumns) {
      expect(ddl).toContain(column);
    }
    for (const column of drizzleColumns) {
      expect(block).toContain(column);
    }
    for (const status of ["OPEN", "CANCELLED", "EXPIRED", "CONSUMED"]) {
      expect(ddl).toContain(`'${status}'`);
      expect(block).toContain(`"${status}"`);
    }
    for (const stage of [
      "PARSE",
      "CLARIFICATION",
      "CONFIRMATION",
      "EXECUTION",
    ]) {
      expect(ddl).toContain(`'${stage}'`);
      expect(block).toContain(`"${stage}"`);
    }
    expect(block).toContain('.onDelete("restrict")');
    expect(block).toContain('.onDelete("cascade")');
    expect(block).toContain('.onDelete("set null")');
    expect(block).toContain("fk_whatsapp_pending_source");
    expect(block).toContain("fk_whatsapp_pending_user");
    expect(block).toContain("fk_whatsapp_pending_institution");
    expect(block).toContain("uniq_whatsapp_pending_source");
    expect(block).toContain("uniq_whatsapp_pending_open_user");
    expect(ddl).toContain("ENGINE=InnoDB");
    expect(ddl).toContain("utf8mb4_0900_ai_ci");
  });
});
