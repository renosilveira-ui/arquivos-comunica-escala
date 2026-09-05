import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";

const createTableSql = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-04-whatsapp-inbound-messages.sql",
    import.meta.url,
  ),
  "utf8",
);
const alterSql = readFileSync(
  new URL(
    "../drizzle/migrations/manual/2026-09-05-whatsapp-inbound-nl-poll-index.sql",
    import.meta.url,
  ),
  "utf8",
);

const DB_NAME = `escalas_test_wa_nl_poll_idx_${process.pid}`;

async function columnNames(
  connection: Connection,
  indexName: string,
): Promise<string[]> {
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME = 'whatsapp_inbound_messages'
       AND INDEX_NAME = ?
     ORDER BY SEQ_IN_INDEX`,
    [DB_NAME, indexName],
  );
  return rows.map((row) => String(row.COLUMN_NAME));
}

describe("migration MySQL idx_whatsapp_inbound_nl_poll", () => {
  let admin: Connection;
  let db: Connection;

  beforeAll(async () => {
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
    await db.query(`
      CREATE TABLE users (
        id INT NOT NULL AUTO_INCREMENT,
        PRIMARY KEY (id)
      ) ENGINE=InnoDB
    `);
    await db.query(createTableSql);
  });

  afterAll(async () => {
    await db?.end();
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS \`${DB_NAME}\``);
      await admin.end();
    }
  });

  it("aplica, reaplicar é idempotente, EXPLAIN usa o composto", async () => {
    await db.query(alterSql);
    await db.query(alterSql);
    expect(await columnNames(db, "idx_whatsapp_inbound_nl_poll")).toEqual([
      "provider",
      "processing_status",
      "content_kind",
      "payload_cleared_at",
      "received_at",
      "id",
    ]);

    await db.query(`INSERT INTO users VALUES (1)`);
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    await db.query(
      `INSERT INTO whatsapp_inbound_messages (
        provider, provider_message_id, user_id, content_kind, forwarded,
        processing_status, error_code, operational_text, payload_expires_at,
        payload_cleared_at, received_at, processed_at
      ) VALUES
      ('TWILIO', 'SMidxterm', 1, 'TEXT', 0, 'IDENTITY_NOT_FOUND', 'IDENTITY_NOT_FOUND', 'x', ?, ?, ?, ?),
      ('TWILIO', 'SMidxpark', 1, 'TEXT', 0, 'READY_FOR_NL', 'WA_NL_DRV_PARK:NEEDS_REFORMULATION', 'x', ?, NULL, ?, ?),
      ('TWILIO', 'SMidxok', 1, 'TEXT', 0, 'READY_FOR_NL', NULL, 'x', ?, NULL, ?, ?)`,
      [now, now, now, now, now, now, now, now, now, now],
    );

    const [plan] = await db.query<RowDataPacket[]>(
      `EXPLAIN SELECT id FROM whatsapp_inbound_messages
       WHERE provider = 'TWILIO'
         AND processing_status = 'READY_FOR_NL'
         AND content_kind = 'TEXT'
         AND user_id IS NOT NULL
         AND payload_cleared_at IS NULL
         AND error_code IS NULL
       ORDER BY received_at ASC, id ASC
       LIMIT 20`,
    );
    const chosen = String(plan[0]?.key ?? "");
    expect(chosen).toBe("idx_whatsapp_inbound_nl_poll");
    expect(String(plan[0]?.Extra ?? "")).not.toMatch(/filesort/i);
  });
});
