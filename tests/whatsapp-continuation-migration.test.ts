import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const alter = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-06-whatsapp-continuation-link.sql",
    import.meta.url,
  ),
  "utf8",
);
const inboundCreate = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-04-whatsapp-inbound-messages.sql",
    import.meta.url,
  ),
  "utf8",
);
const pendingCreate = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-04-whatsapp-pending-intents.sql",
    import.meta.url,
  ),
  "utf8",
);
const schema = readFileSync(
  new URL("../drizzle/schema.ts", import.meta.url),
  "utf8",
);

describe("migration manual whatsapp continuation link", () => {
  it("é aditiva, nullable, rerodável e sem backfill", () => {
    expect(alter).toContain("ADD COLUMN continuation_pending_id");
    expect(alter).toContain("ADD COLUMN continuation_outcome");
    expect(alter).toContain("ADD COLUMN confirmation_disposition");
    expect(alter).toContain("ADD INDEX idx_whatsapp_inbound_continuation_pending");
    expect(alter).toContain("fk_whatsapp_inbound_continuation_pending");
    expect(alter).toContain("INFORMATION_SCHEMA.COLUMNS");
    expect(alter).toContain("NÃO aplicar no staging nesta PR");
    expect(alter).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
    expect(alter).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(alter).not.toMatch(/\bUPDATE\s+whatsapp_/i);
    expect(alter).not.toMatch(/\bINSERT\s+INTO\b/i);
  });

  it("CREATE greenfield já nasce com as colunas; FK circular fica no ALTER", () => {
    expect(inboundCreate).toContain("continuation_pending_id");
    expect(inboundCreate).toContain("continuation_outcome");
    expect(inboundCreate).toContain("idx_whatsapp_inbound_continuation_pending");
    expect(inboundCreate).not.toContain("fk_whatsapp_inbound_continuation_pending");
    expect(pendingCreate).toContain("confirmation_disposition");
    expect(alter).toContain("REFERENCES whatsapp_pending_intents(id) ON DELETE SET NULL");
    expect(schema).toContain("continuationPendingId");
    expect(schema).toContain("confirmationDisposition");
  });

  it("fail-closed em homônimo incompatível", () => {
    expect(alter).toContain("WHATSAPP_CONTINUATION_PENDING_ID_CONTRACT_MISMATCH");
    expect(alter).toContain("WHATSAPP_CONTINUATION_OUTCOME_CONTRACT_MISMATCH");
    expect(alter).toContain("WHATSAPP_CONFIRMATION_DISPOSITION_CONTRACT_MISMATCH");
    expect(alter).toContain("WHATSAPP_CONTINUATION_INDEX_CONTRACT_MISMATCH");
    expect(alter).toContain("WHATSAPP_CONTINUATION_FK_CONTRACT_MISMATCH");
  });
});
