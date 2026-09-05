import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/mysql-core";
import { describe, expect, it } from "vitest";
import { whatsappInboundMessages } from "../drizzle/schema";

const createTable = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-04-whatsapp-inbound-messages.sql",
    import.meta.url,
  ),
  "utf8",
);
const alter = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-05-whatsapp-inbound-nl-poll-index.sql",
    import.meta.url,
  ),
  "utf8",
);

const COLUMNS = [
  "provider",
  "processing_status",
  "content_kind",
  "payload_cleared_at",
  "received_at",
  "id",
] as const;

describe("índice composto do poll READY_FOR_NL", () => {
  it("é aditivo, rerodável e sem DROP/DELETE de dados", () => {
    expect(alter).toContain("idx_whatsapp_inbound_nl_poll");
    expect(alter).toContain("ADD INDEX idx_whatsapp_inbound_nl_poll");
    expect(alter).toContain("INFORMATION_SCHEMA.STATISTICS");
    expect(alter).toMatch(/@index_exists = 0/);
    expect(alter).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(alter).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(alter).not.toMatch(/\bUPDATE\s+whatsapp_inbound_messages\b/i);
  });

  it("mantém schema, CREATE TABLE e ALTER no mesmo contrato", () => {
    const schemaIndexes = Object.fromEntries(
      getTableConfig(whatsappInboundMessages).indexes.map((index) => [
        index.config.name,
        index.config.columns.map((column) =>
          "name" in column ? column.name : null,
        ),
      ]),
    );
    expect(schemaIndexes.idx_whatsapp_inbound_nl_poll).toEqual([...COLUMNS]);

    expect(createTable).toContain("KEY idx_whatsapp_inbound_nl_poll");
    for (const column of COLUMNS) {
      expect(createTable).toContain(column);
    }

    const add = alter.match(
      /ADD INDEX idx_whatsapp_inbound_nl_poll \(([^)]+)\)/,
    );
    expect(
      add?.[1]?.split(",").map((column) => column.trim()),
    ).toEqual([...COLUMNS]);
  });
});
