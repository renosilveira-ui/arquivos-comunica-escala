import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/mysql-core";
import {
  accountAuditEvents,
  whatsappVerificationChallenges,
} from "../drizzle/schema";

const migration = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-08-31-user-contact-channels.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("migration manual user_contact_channels", () => {
  it("Drizzle e migration account-wide usam FKs nomeadas dentro do limite MySQL", () => {
    const source = readFileSync(
      new URL(
        "../drizzle/migrations/manual/2026-09-09-whatsapp-account-ownership.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const keys = getTableConfig(whatsappVerificationChallenges).foreignKeys;
    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key.getName().length).toBeLessThanOrEqual(64);
      expect(key.onDelete).toBe("cascade");
      expect(source).toContain(`CONSTRAINT ${key.getName()} FOREIGN KEY`);
    }
    expect(getTableConfig(accountAuditEvents).foreignKeys).toHaveLength(0);
  });

  it("é aditiva, rerodável e sem DROP/DELETE", () => {
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS user_contact_channels",
    );
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it("impõe UNIQUE por usuário+canal e E.164 ativo global", () => {
    expect(migration).toContain("UNIQUE KEY uniq_user_contact_channel");
    expect(migration).toContain(
      "UNIQUE KEY uniq_contact_channel_active_address",
    );
    expect(migration).toContain("GENERATED ALWAYS AS");
    expect(migration).toContain("active_normalized_address");
    expect(migration).toContain("FOREIGN KEY (user_id) REFERENCES users(id)");
  });

  it("não cria tabela de OTP próprio", () => {
    expect(migration).not.toMatch(/\bcode_hash\b|\bverification_code\b/i);
    expect(migration).not.toContain("whatsapp_channel_verifications");
    expect(migration).not.toMatch(/CREATE TABLE.*otp/i);
  });
});
