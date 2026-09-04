import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-04-whatsapp-inbound-messages.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration manual whatsapp_inbound_messages", () => {
  it("é aditiva, rerodável e sem DROP/DELETE", () => {
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS whatsapp_inbound_messages",
    );
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it("impõe UNIQUE, estados retomáveis e payload operacional temporário", () => {
    const ddl = migration.slice(migration.indexOf("CREATE TABLE"));
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
});
