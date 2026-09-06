import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";

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
const alterSql = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-06-whatsapp-continuation-link.sql",
    import.meta.url,
  ),
  "utf8",
);

const DB_NAME = `escalas_test_wa_cont_${process.pid}`;

const OLD_INBOUND = `
CREATE TABLE whatsapp_inbound_messages (
  id INT NOT NULL AUTO_INCREMENT,
  provider ENUM('TWILIO') NOT NULL,
  provider_message_id VARCHAR(64) NOT NULL,
  user_id INT NULL DEFAULT NULL,
  content_kind ENUM('TEXT', 'AUDIO', 'UNSUPPORTED_MEDIA') NOT NULL,
  forwarded TINYINT(1) NOT NULL DEFAULT 0,
  processing_status ENUM(
    'RECEIVED','IDENTIFIED','RETRYABLE','IDENTITY_NOT_FOUND',
    'IDENTITY_CONFLICT','UNSUPPORTED','READY_FOR_NL','READY_FOR_TRANSCRIPTION'
  ) NOT NULL,
  error_code VARCHAR(64) NULL DEFAULT NULL,
  sender_address_hash CHAR(16) NULL DEFAULT NULL,
  operational_text TEXT NULL DEFAULT NULL,
  media_url VARCHAR(768) NULL DEFAULT NULL,
  media_mime VARCHAR(64) NULL DEFAULT NULL,
  payload_expires_at TIMESTAMP NULL DEFAULT NULL,
  payload_cleared_at TIMESTAMP NULL DEFAULT NULL,
  received_at TIMESTAMP NOT NULL,
  processed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_whatsapp_inbound_provider_message (provider, provider_message_id),
  CONSTRAINT fk_whatsapp_inbound_user FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE SET NULL
) ENGINE=InnoDB;
`;

const OLD_PENDING = `
CREATE TABLE whatsapp_pending_intents (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  source_inbound_message_id INT NOT NULL,
  institution_id INT NULL DEFAULT NULL,
  status ENUM('OPEN', 'CANCELLED', 'EXPIRED', 'CONSUMED') NOT NULL,
  stage ENUM('PARSE', 'CLARIFICATION', 'CONFIRMATION', 'EXECUTION') NOT NULL,
  intent_kind ENUM('SWAP', 'CESSAO') NULL DEFAULT NULL,
  parsed_payload JSON NULL DEFAULT NULL,
  resolved_payload JSON NULL DEFAULT NULL,
  clarification_payload JSON NULL DEFAULT NULL,
  expires_at TIMESTAMP NOT NULL,
  consumed_at TIMESTAMP NULL DEFAULT NULL,
  payload_cleared_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  open_slot TINYINT GENERATED ALWAYS AS (IF(\`status\` = 'OPEN', 1, NULL)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_whatsapp_pending_source (source_inbound_message_id),
  UNIQUE KEY uniq_whatsapp_pending_open_user (user_id, open_slot),
  CONSTRAINT fk_whatsapp_pending_user FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_whatsapp_pending_source FOREIGN KEY (source_inbound_message_id)
    REFERENCES whatsapp_inbound_messages(id) ON DELETE RESTRICT,
  CONSTRAINT fk_whatsapp_pending_institution FOREIGN KEY (institution_id)
    REFERENCES institutions(id) ON DELETE SET NULL
) ENGINE=InnoDB;
`;

async function columnType(
  connection: Connection,
  table: string,
  column: string,
): Promise<string | null> {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT COLUMN_TYPE, IS_NULLABLE
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [DB_NAME, table, column],
  );
  const row = rows[0];
  if (!row) return null;
  return `${row.COLUMN_TYPE}|${row.IS_NULLABLE}`;
}

describe("migration MySQL whatsapp continuation link", () => {
  let admin: Connection;
  let db: Connection;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL ?? "";
    if (url && !/127\.0\.0\.1|localhost/.test(url)) {
      throw new Error("LOCAL_TEST_DB_ONLY");
    }
    admin = await mysql.createConnection({
      host: "127.0.0.1",
      user: "root",
      password: "root",
      multipleStatements: true,
    });
    await admin.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
    await admin.query(`CREATE DATABASE \`${DB_NAME}\``);
    db = await mysql.createConnection({
      host: "127.0.0.1",
      user: "root",
      password: "root",
      database: DB_NAME,
      multipleStatements: true,
    });
  });

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
      await admin.end();
    }
  });

  it("existing DB: ADD columns → index → FK, rerodável, fail-closed em homônimo", async () => {
    await db.query(`
      CREATE TABLE users (id INT NOT NULL AUTO_INCREMENT, PRIMARY KEY (id)) ENGINE=InnoDB;
      CREATE TABLE institutions (
        id INT NOT NULL AUTO_INCREMENT,
        name VARCHAR(255) NOT NULL,
        cnpj VARCHAR(14) NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB;
    `);
    await db.query(OLD_INBOUND);
    await db.query(OLD_PENDING);
    await db.query(alterSql);
    await db.query(alterSql);
    expect(await columnType(db, "whatsapp_inbound_messages", "continuation_pending_id")).toBe(
      "int|YES",
    );
    expect(await columnType(db, "whatsapp_inbound_messages", "continuation_outcome")).toBe(
      "enum('APPLIED','NOOP')|YES",
    );
    expect(
      await columnType(db, "whatsapp_pending_intents", "confirmation_disposition"),
    ).toBe("enum('AFFIRMED')|YES");
    const [fks] = await db.query<RowDataPacket[]>(
      `SELECT DELETE_RULE, REFERENCED_TABLE_NAME
       FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA = ? AND CONSTRAINT_NAME = ?`,
      [DB_NAME, "fk_whatsapp_inbound_continuation_pending"],
    );
    expect(fks[0]?.DELETE_RULE).toBe("SET NULL");
    expect(fks[0]?.REFERENCED_TABLE_NAME).toBe("whatsapp_pending_intents");

    await db.query(
      `ALTER TABLE whatsapp_inbound_messages
       MODIFY COLUMN continuation_outcome ENUM('APPLIED','NOOP','OTHER') NULL`,
    );
    await expect(db.query(alterSql)).rejects.toThrow();
  });

  it("fresh CREATE + ALTER: colunas já existem, FK é adicionada", async () => {
    await db.query(`DROP DATABASE \`${DB_NAME}\``);
    await db.query(`CREATE DATABASE \`${DB_NAME}\``);
    await db.changeUser({ database: DB_NAME });
    await db.query(`
      CREATE TABLE users (id INT NOT NULL AUTO_INCREMENT, PRIMARY KEY (id)) ENGINE=InnoDB;
      CREATE TABLE institutions (
        id INT NOT NULL AUTO_INCREMENT,
        name VARCHAR(255) NOT NULL,
        cnpj VARCHAR(14) NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB;
    `);
    await db.query(inboundCreate);
    await db.query(pendingCreate);
    await db.query(alterSql);
    await db.query(alterSql);
    expect(await columnType(db, "whatsapp_inbound_messages", "continuation_pending_id")).toBe(
      "int|YES",
    );
    const [fks] = await db.query<RowDataPacket[]>(
      `SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA = ? AND CONSTRAINT_NAME = ?`,
      [DB_NAME, "fk_whatsapp_inbound_continuation_pending"],
    );
    expect(fks).toHaveLength(1);
  });
});
