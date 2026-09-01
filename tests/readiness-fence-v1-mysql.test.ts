import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import {
  captureInstitutionReadinessFenceV1HighWatermark,
  withReadinessFenceV1FinalDecisionTransaction,
} from "../server/readiness-fence-v1";
import { closeDb } from "../server/db";
import { applyReadinessFenceV1Migration } from "../scripts/apply-readiness-fence-v1-migration";
import { createReadinessFenceV1MinimalSourceSchema } from "../scripts/prove-readiness-fence-v1-migration";

const TEST_SERVER_URL = process.env.READINESS_FENCE_V1_MYSQL_TEST_SERVER_URL;
const TEMPORARY_DATABASE_PREFIX = "escalas_rdf_v1_lock_";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

type TestServer = Readonly<{
  serverUrl: string;
  databaseUrl: (databaseName: string) => string;
}>;

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
    throw new Error("READINESS_FENCE_V1_TEST_IDENTIFIER_INVALID");
  }
  return `\`${identifier}\``;
}

function parseTestServer(rawUrl: string | undefined): TestServer | null {
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("READINESS_FENCE_V1_MYSQL_TEST_SERVER_URL_INVALID");
  }
  if (
    url.protocol !== "mysql:" ||
    !LOCAL_HOSTS.has(url.hostname.toLowerCase()) ||
    (url.pathname !== "/" && url.pathname !== "/mysql") ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "READINESS_FENCE_V1_MYSQL_TEST_SERVER_URL deve apontar somente para MySQL local, sem query ou fragmento.",
    );
  }
  const normalized = new URL(url.toString());
  normalized.hostname =
    normalized.hostname.toLowerCase() === "localhost"
      ? "127.0.0.1"
      : normalized.hostname.toLowerCase();
  return Object.freeze({
    serverUrl: normalized.toString(),
    databaseUrl(databaseName: string): string {
      if (
        !databaseName.startsWith(TEMPORARY_DATABASE_PREFIX) ||
        databaseName.length > 64
      ) {
        throw new Error("READINESS_FENCE_V1_TEST_DATABASE_NAME_INVALID");
      }
      const databaseUrl = new URL(normalized.toString());
      databaseUrl.pathname = `/${databaseName}`;
      return databaseUrl.toString();
    },
  });
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deferred(): Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}> {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return Object.freeze({ promise, resolve });
}

const server = parseTestServer(TEST_SERVER_URL);
const describeWithIsolatedMysql = server ? describe.sequential : describe.skip;

describeWithIsolatedMysql("readiness fence V1 no MySQL 8 efêmero", () => {
  let serverConnection!: Connection;
  let connection!: Connection;
  let databaseName!: string;
  let databaseUrl!: string;
  let previousUrl: string | undefined;

  async function countEvents(institutionId: number): Promise<number> {
    const [rows] = await connection.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM institution_readiness_fence_events WHERE institution_id = ?",
      [institutionId],
    );
    return Number(rows[0]?.count);
  }

  async function insertHospital(
    target: Connection,
    id: number,
    institutionId: number,
  ): Promise<void> {
    await target.query(
      "INSERT INTO hospitals (id, institution_id) VALUES (?, ?)",
      [id, institutionId],
    );
  }

  beforeAll(async () => {
    if (!server) {
      throw new Error("READINESS_FENCE_V1_MYSQL_TEST_SERVER_URL_REQUIRED");
    }
    databaseName = `${TEMPORARY_DATABASE_PREFIX}${randomUUID()
      .replaceAll("-", "")
      .toLowerCase()}`;
    databaseUrl = server.databaseUrl(databaseName);
    serverConnection = await mysql.createConnection(server.serverUrl);
    await serverConnection.query(
      `CREATE DATABASE ${quoteIdentifier(databaseName)}`,
    );
    connection = await mysql.createConnection(databaseUrl);
    await createReadinessFenceV1MinimalSourceSchema(connection);
    expect(
      await applyReadinessFenceV1Migration({
        explicitApproval: true,
        databaseUrl,
        allowInsecureLoopbackForTest: true,
      }),
    ).toBe("COMPLETE");
    expect(
      await applyReadinessFenceV1Migration({
        explicitApproval: true,
        databaseUrl,
        allowInsecureLoopbackForTest: true,
      }),
    ).toBe("COMPLETE");
    previousUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseUrl;
    await closeDb();
    await connection.query(
      "INSERT INTO institutions (id, is_active) VALUES (1, 1), (2, 1)",
    );
  });

  afterAll(async () => {
    await closeDb();
    if (previousUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousUrl;
    }
    try {
      await connection?.end();
    } finally {
      try {
        await serverConnection?.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`,
        );
      } finally {
        await serverConnection?.end();
      }
    }
  });

  it("reaplica o instalador sem duplicar schema, trigger ou recibo", async () => {
    expect(
      await applyReadinessFenceV1Migration({
        explicitApproval: true,
        databaseUrl,
        allowInsecureLoopbackForTest: true,
      }),
    ).toBe("COMPLETE");
    const [triggerRows] = await connection.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() AND TRIGGER_NAME LIKE 'trg_rdf_%'",
    );
    const [markerRows] = await connection.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM institution_readiness_fence_installations",
    );
    const [foreignKeyRows] = await connection.query<RowDataPacket[]>(
      "SELECT COUNT(*) AS count FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'institution_readiness_fence_events' AND REFERENCED_TABLE_NAME IS NOT NULL",
    );
    expect(Number(triggerRows[0]?.count)).toBe(42);
    expect(Number(markerRows[0]?.count)).toBe(1);
    expect(Number(foreignKeyRows[0]?.count)).toBe(0);
  });

  it("recusa update ou delete direto do journal append-only", async () => {
    const [rows] = await connection.query<RowDataPacket[]>(
      "SELECT id FROM institution_readiness_fence_events ORDER BY id LIMIT 1",
    );
    const eventId = Number(rows[0]?.id);
    expect(eventId).toBeGreaterThan(0);

    await expect(
      connection.query(
        "UPDATE institution_readiness_fence_events SET institution_id = institution_id WHERE id = ?",
        [eventId],
      ),
    ).rejects.toMatchObject({
      code: "ER_SIGNAL_EXCEPTION",
      sqlMessage: "READINESS_FENCE_V1_EVENT_IMMUTABLE",
    });
    await expect(
      connection.query(
        "DELETE FROM institution_readiness_fence_events WHERE id = ?",
        [eventId],
      ),
    ).rejects.toMatchObject({
      code: "ER_SIGNAL_EXCEPTION",
      sqlMessage: "READINESS_FENCE_V1_EVENT_IMMUTABLE",
    });
  });

  it("permite duas mutações independentes da mesma instituição antes de qualquer commit", async () => {
    const first = await mysql.createConnection(databaseUrl);
    const second = await mysql.createConnection(databaseUrl);
    const initialCount = await countEvents(1);
    let firstOpen = false;
    let secondOpen = false;
    try {
      await first.beginTransaction();
      firstOpen = true;
      await second.beginTransaction();
      secondOpen = true;
      await insertHospital(first, 101, 1);
      const secondInsert = insertHospital(second, 102, 1);
      const completion = await Promise.race([
        secondInsert.then(() => "completed" as const),
        wait(750).then(() => "waiting" as const),
      ]);
      expect(completion).toBe("completed");
      await secondInsert;
      await first.commit();
      firstOpen = false;
      await second.commit();
      secondOpen = false;
      expect(await countEvents(1)).toBe(initialCount + 2);
    } finally {
      if (firstOpen) await first.rollback();
      if (secondOpen) await second.rollback();
      await first.end();
      await second.end();
    }
  });

  it("não bloqueia writer de instituição distinta pela faixa final", async () => {
    const highWatermark =
      await captureInstitutionReadinessFenceV1HighWatermark(1);
    const rangeLocked = deferred();
    const releaseDecision = deferred();
    const finalDecision = withReadinessFenceV1FinalDecisionTransaction(
      highWatermark,
      async (tx) => {
        await tx.execute(
          sql`SELECT id FROM institutions WHERE id = 1 FOR UPDATE`,
        );
      },
      async () => {
        rangeLocked.resolve();
        await releaseDecision.promise;
      },
    );
    await rangeLocked.promise;
    const distinctWriter = await mysql.createConnection(databaseUrl);
    try {
      const write = insertHospital(distinctWriter, 201, 2);
      const completion = await Promise.race([
        write.then(() => "completed" as const),
        wait(1500).then(() => "waiting" as const),
      ]);
      expect(completion).toBe("completed");
      await write;
    } finally {
      releaseDecision.resolve();
      await finalDecision;
      await distinctWriter.end();
    }
  });

  it("rejeita evento confirmado entre captura e decisão final", async () => {
    const highWatermark =
      await captureInstitutionReadinessFenceV1HighWatermark(1);
    await insertHospital(connection, 202, 1);
    let decided = false;
    await expect(
      withReadinessFenceV1FinalDecisionTransaction(
        highWatermark,
        async (tx) => {
          await tx.execute(
            sql`SELECT id FROM institutions WHERE id = 1 FOR UPDATE`,
          );
        },
        async () => {
          decided = true;
        },
      ),
    ).rejects.toThrow("READINESS_FENCE_V1_STALE");
    expect(decided).toBe(false);
  });

  it("faz writer da mesma instituição esperar após o range lock final", async () => {
    const highWatermark =
      await captureInstitutionReadinessFenceV1HighWatermark(1);
    const rangeLocked = deferred();
    const releaseDecision = deferred();
    const finalDecision = withReadinessFenceV1FinalDecisionTransaction(
      highWatermark,
      async (tx) => {
        await tx.execute(
          sql`SELECT id FROM institutions WHERE id = 1 FOR UPDATE`,
        );
      },
      async () => {
        rangeLocked.resolve();
        await releaseDecision.promise;
      },
    );
    await rangeLocked.promise;
    const writer = await mysql.createConnection(databaseUrl);
    try {
      const write = insertHospital(writer, 203, 1);
      const completion = await Promise.race([
        write.then(() => "completed" as const),
        wait(500).then(() => "waiting" as const),
      ]);
      expect(completion).toBe("waiting");
      releaseDecision.resolve();
      await finalDecision;
      await write;
    } finally {
      releaseDecision.resolve();
      await finalDecision;
      await writer.end();
    }
  });

  it("não deixa evento quando a transação de origem sofre rollback", async () => {
    const writer = await mysql.createConnection(databaseUrl);
    const initialCount = await countEvents(1);
    try {
      await writer.beginTransaction();
      await insertHospital(writer, 204, 1);
      await writer.rollback();
      expect(await countEvents(1)).toBe(initialCount);
    } finally {
      await writer.end();
    }
  });
});
