import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
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

function inboundSchemaBlock(): string {
  const start = schema.indexOf("export const whatsappInboundMessages");
  const end = schema.indexOf("export type WhatsappInboundMessage");
  return schema.slice(start, end);
}

describe("migration manual whatsapp_inbound_messages", () => {
  it("é aditiva, rerodável e sem DROP/DELETE", () => {
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS whatsapp_inbound_messages",
    );
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it("impõe UNIQUE, estados retomáveis e payload operacional temporário", () => {
    const ddl = migration.slice(
      migration.indexOf("CREATE TABLE IF NOT EXISTS whatsapp_inbound_messages"),
    );
    expect(ddl).toContain(
      "UNIQUE KEY uniq_whatsapp_inbound_provider_message",
    );
    expect(ddl).toContain("provider_message_id");
    expect(ddl).toContain("sender_address_hash");
    expect(ddl).toContain("RETRYABLE");
    expect(ddl).toContain("operational_text");
    expect(ddl).toContain("media_url");
    expect(ddl).toContain("payload_expires_at");
    expect(ddl).toContain("payload_cleared_at");
    expect(ddl).toContain("idx_whatsapp_inbound_payload_expires");
    expect(ddl).not.toMatch(/\bFAILED\b/);
    expect(ddl).not.toMatch(/\bbody\b/i);
    expect(ddl).not.toMatch(/signature/i);
    expect(ddl).not.toMatch(/normalized_address|from_e164|phone/i);
    expect(ddl).not.toMatch(/CREATE TABLE.*whatsapp_pending/i);
  });

  it("mantém paridade com o bloco Drizzle whatsappInboundMessages", () => {
    const ddl = migration.slice(
      migration.indexOf("CREATE TABLE IF NOT EXISTS whatsapp_inbound_messages"),
    );
    const block = inboundSchemaBlock();
    const sqlColumns = [
      "id",
      "provider",
      "provider_message_id",
      "user_id",
      "content_kind",
      "forwarded",
      "processing_status",
      "error_code",
      "sender_address_hash",
      "operational_text",
      "media_url",
      "media_mime",
      "payload_expires_at",
      "payload_cleared_at",
      "received_at",
      "processed_at",
      "created_at",
      "updated_at",
    ];
    const drizzleColumns = [
      'int("id")',
      'mysqlEnum("provider"',
      'varchar("provider_message_id"',
      'int("user_id")',
      'mysqlEnum("content_kind"',
      'boolean("forwarded")',
      'mysqlEnum("processing_status"',
      'varchar("error_code"',
      'char("sender_address_hash"',
      'text("operational_text")',
      'varchar("media_url", { length: 768 })',
      'varchar("media_mime", { length: 64 })',
      'timestamp("payload_expires_at")',
      'timestamp("payload_cleared_at")',
      'timestamp("received_at")',
      'timestamp("processed_at")',
      'timestamp("created_at")',
      'timestamp("updated_at")',
    ];
    for (const column of sqlColumns) {
      expect(ddl).toContain(column);
    }
    for (const column of drizzleColumns) {
      expect(block).toContain(column);
    }
    expect(ddl).toContain("ENUM('TWILIO')");
    expect(ddl).toContain("ENUM('TEXT', 'AUDIO', 'UNSUPPORTED_MEDIA')");
    expect(block).toContain('"TWILIO"');
    expect(block).toContain('"TEXT"');
    expect(block).toContain('"AUDIO"');
    expect(block).toContain('"UNSUPPORTED_MEDIA"');
    for (const status of [
      "RECEIVED",
      "IDENTIFIED",
      "RETRYABLE",
      "IDENTITY_NOT_FOUND",
      "IDENTITY_CONFLICT",
      "UNSUPPORTED",
      "READY_FOR_NL",
      "READY_FOR_TRANSCRIPTION",
    ]) {
      expect(ddl).toContain(`'${status}'`);
      expect(block).toContain(`"${status}"`);
    }
    expect(ddl).toContain(
      "UNIQUE KEY uniq_whatsapp_inbound_provider_message (provider, provider_message_id)",
    );
    expect(ddl).toContain(
      "FOREIGN KEY (user_id) REFERENCES users(id)",
    );
    expect(ddl).toContain("ON DELETE SET NULL");
    expect(block).toContain('{ onDelete: "set null" }');
    expect(block).toContain("uniq_whatsapp_inbound_provider_message");
    expect(ddl).toContain("KEY idx_whatsapp_inbound_payload_expires");
    expect(block).toContain("idx_whatsapp_inbound_payload_expires");
    expect(block).not.toContain("FAILED");
  });
});
