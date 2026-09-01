import { createHash } from "node:crypto";
import mysql, {
  type ConnectionOptions,
  type RowDataPacket,
} from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { describe, expect, it, afterAll, beforeAll } from "vitest";
import {
  DrizzleOperationalDeliveryStore,
  processOperationalDeliveryBatch,
  type OperationalDeliveryClaim,
  type OperationalDeliveryTransport,
} from "../server/operational-delivery-worker";

const integrationUrl = process.env.OPERATIONAL_DELIVERY_DB_TEST_URL;
const describeDb = integrationUrl ? describe : describe.skip;
const now = new Date("2026-09-02T12:00:00.000Z");
const ephemeralDatabase = `escalas_operational_delivery_${process.pid}_${Date.now()}`;

let adminConnection: mysql.Connection | undefined;
let testConnection: mysql.Connection | undefined;
let store: DrizzleOperationalDeliveryStore;
let nextEventId = 100;
let nextRecipientId = 100;
let nextDeliveryId = 100;
let nextInviteId = 100;

type DatabaseRows<T extends object> = (T & RowDataPacket)[];

function hash(label: string): string {
  return createHash("sha256")
    .update(`${ephemeralDatabase}:${label}`)
    .digest("hex");
}

function localConnectionOptions(database?: string): ConnectionOptions {
  if (!integrationUrl) {
    throw new Error("OPERATIONAL_DELIVERY_DB_TEST_URL é obrigatório");
  }
  const parsed = new URL(integrationUrl);
  if (
    parsed.protocol !== "mysql:" ||
    (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost")
  ) {
    throw new Error("O teste DB aceita somente MySQL local explícito");
  }
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: database ?? parsed.pathname.replace(/^\//, ""),
    timezone: "Z",
  };
}

async function createSchema(connection: mysql.Connection): Promise<void> {
  const statements = [
    `CREATE TABLE institutions (
      id INT PRIMARY KEY,
      is_active BOOLEAN NOT NULL
    ) ENGINE=InnoDB`,
    `CREATE TABLE users (
      id INT PRIMARY KEY,
      email VARCHAR(320) NULL,
      role ENUM('admin', 'manager', 'doctor', 'nurse', 'tech') NOT NULL,
      approval_status ENUM('PENDING', 'APPROVED') NOT NULL,
      deleted_at DATETIME NULL
    ) ENGINE=InnoDB`,
    `CREATE TABLE professional_institutions (
      id INT PRIMARY KEY,
      professional_id INT NOT NULL,
      user_id INT NOT NULL,
      institution_id INT NOT NULL,
      role_in_institution ENUM('USER', 'GESTOR_MEDICO', 'GESTOR_PLUS') NOT NULL,
      active BOOLEAN NOT NULL
    ) ENGINE=InnoDB`,
    `CREATE TABLE professional_access (
      id INT PRIMARY KEY,
      institution_id INT NOT NULL,
      professional_id INT NOT NULL,
      hospital_id INT NOT NULL,
      sector_id INT NULL,
      can_access BOOLEAN NOT NULL
    ) ENGINE=InnoDB`,
    `CREATE TABLE manager_scope (
      id INT PRIMARY KEY,
      institution_id INT NOT NULL,
      manager_professional_id INT NOT NULL,
      hospital_id INT NOT NULL,
      sector_id INT NULL,
      active BOOLEAN NOT NULL
    ) ENGINE=InnoDB`,
    `CREATE TABLE schedule_invites (
      id INT PRIMARY KEY,
      institution_id INT NOT NULL,
      hospital_id INT NOT NULL,
      sector_id INT NOT NULL,
      code_hash VARCHAR(64) NOT NULL,
      created_by_user_id INT NOT NULL,
      invited_user_id INT NULL,
      invited_email VARCHAR(320) NULL,
      max_redemptions INT NOT NULL,
      redeemed_count INT NOT NULL,
      expires_at DATETIME NOT NULL,
      revoked_at DATETIME NULL,
      declined_at DATETIME NULL
    ) ENGINE=InnoDB`,
    `CREATE TABLE user_operational_email_trust (
      id INT PRIMARY KEY,
      user_id INT NOT NULL,
      email_hash VARCHAR(64) NOT NULL,
      state ENUM('PENDING', 'TRUSTED', 'REVOKED') NOT NULL
    ) ENGINE=InnoDB`,
    `CREATE TABLE operational_events (
      id INT PRIMARY KEY,
      institution_id INT NOT NULL,
      emission_mode ENUM('SHADOW', 'ACTIVE') NOT NULL,
      scope_kind ENUM('INSTITUTION', 'HOSPITAL', 'SECTOR') NOT NULL,
      hospital_id INT NULL,
      sector_id INT NULL
    ) ENGINE=InnoDB`,
    `CREATE TABLE operational_event_recipients (
      id INT PRIMARY KEY,
      operational_event_id INT NOT NULL,
      institution_id INT NOT NULL,
      recipient_kind ENUM('USER', 'SCHEDULE_INVITE') NOT NULL,
      user_id INT NULL,
      schedule_invite_id INT NULL
    ) ENGINE=InnoDB`,
    `CREATE TABLE notification_deliveries (
      id INT PRIMARY KEY,
      operational_event_recipient_id INT NOT NULL,
      channel ENUM('PUSH', 'EMAIL') NOT NULL,
      status ENUM('QUEUED', 'PROCESSING', 'PROVIDER_ACCEPTED', 'DELIVERED', 'FAILED', 'DEAD', 'SKIPPED') NOT NULL,
      dedup_key VARCHAR(64) NOT NULL,
      attempt_count INT NOT NULL,
      available_at DATETIME NOT NULL,
      lease_until DATETIME NULL,
      provider_accepted_at DATETIME NULL,
      delivered_at DATETIME NULL,
      last_error_code VARCHAR(80) NULL
    ) ENGINE=InnoDB`,
    `CREATE TABLE operational_delivery_requeue_audits (
      id INT AUTO_INCREMENT PRIMARY KEY,
      notification_delivery_id INT NOT NULL,
      operational_event_id INT NOT NULL,
      institution_id INT NOT NULL,
      actor_user_id INT NOT NULL,
      actor_role ENUM('GESTOR_MEDICO', 'GESTOR_PLUS', 'GLOBAL_ADMIN') NOT NULL,
      previous_attempt_count INT NOT NULL,
      created_at DATETIME NOT NULL
    ) ENGINE=InnoDB`,
  ];
  for (const statement of statements) {
    await connection.query(statement);
  }
}

async function insertUserDelivery(input: {
  emissionMode: "ACTIVE" | "SHADOW";
  status?: "QUEUED" | "DEAD";
  attemptCount?: number;
  availableAt?: Date;
}): Promise<number> {
  if (!testConnection) throw new Error("Banco de teste não iniciado");
  const eventId = nextEventId++;
  const recipientId = nextRecipientId++;
  const deliveryId = nextDeliveryId++;
  await testConnection.execute(
    "INSERT INTO operational_events (id, institution_id, emission_mode, scope_kind, hospital_id, sector_id) VALUES (?, 1, ?, 'SECTOR', 10, 20)",
    [eventId, input.emissionMode],
  );
  await testConnection.execute(
    "INSERT INTO operational_event_recipients (id, operational_event_id, institution_id, recipient_kind, user_id, schedule_invite_id) VALUES (?, ?, 1, 'USER', 20, NULL)",
    [recipientId, eventId],
  );
  await testConnection.execute(
    "INSERT INTO notification_deliveries (id, operational_event_recipient_id, channel, status, dedup_key, attempt_count, available_at, lease_until, provider_accepted_at, delivered_at, last_error_code) VALUES (?, ?, 'PUSH', ?, ?, ?, ?, NULL, NULL, NULL, NULL)",
    [
      deliveryId,
      recipientId,
      input.status ?? "QUEUED",
      hash(`delivery:${deliveryId}`),
      input.attemptCount ?? 0,
      input.availableAt ?? now,
    ],
  );
  return deliveryId;
}

async function insertInviteDelivery(input: {
  redeemedCount: number;
  hasDestination: boolean;
}): Promise<number> {
  if (!testConnection) throw new Error("Banco de teste não iniciado");
  const inviteId = nextInviteId++;
  const eventId = nextEventId++;
  const recipientId = nextRecipientId++;
  const deliveryId = nextDeliveryId++;
  await testConnection.execute(
    "INSERT INTO schedule_invites (id, institution_id, hospital_id, sector_id, code_hash, created_by_user_id, invited_user_id, invited_email, max_redemptions, redeemed_count, expires_at, revoked_at, declined_at) VALUES (?, 1, 10, 20, ?, 10, ?, ?, 1, ?, ?, NULL, NULL)",
    [
      inviteId,
      hash(`invite:${inviteId}`),
      input.hasDestination ? 20 : null,
      input.hasDestination ? "recipient@example.test" : null,
      input.redeemedCount,
      new Date("2099-01-01T00:00:00.000Z"),
    ],
  );
  await testConnection.execute(
    "INSERT INTO operational_events (id, institution_id, emission_mode, scope_kind, hospital_id, sector_id) VALUES (?, 1, 'ACTIVE', 'SECTOR', 10, 20)",
    [eventId],
  );
  await testConnection.execute(
    "INSERT INTO operational_event_recipients (id, operational_event_id, institution_id, recipient_kind, user_id, schedule_invite_id) VALUES (?, ?, 1, 'SCHEDULE_INVITE', NULL, ?)",
    [recipientId, eventId, inviteId],
  );
  await testConnection.execute(
    "INSERT INTO notification_deliveries (id, operational_event_recipient_id, channel, status, dedup_key, attempt_count, available_at, lease_until, provider_accepted_at, delivered_at, last_error_code) VALUES (?, ?, 'EMAIL', 'QUEUED', ?, 0, ?, NULL, NULL, NULL, NULL)",
    [deliveryId, recipientId, hash(`delivery:${deliveryId}`), now],
  );
  return deliveryId;
}

async function claimOne(): Promise<OperationalDeliveryClaim> {
  const claim = await store.claimNext({ now, leaseMs: 60_000 });
  if (!claim) throw new Error("Claim de teste não encontrado");
  return claim;
}

function deferred(): Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}> {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = () => done();
  });
  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describeDb("adapter Drizzle de entregas operacionais", () => {
  beforeAll(async () => {
    adminConnection = await mysql.createConnection(localConnectionOptions());
    await adminConnection.query(`CREATE DATABASE \`${ephemeralDatabase}\``);
    testConnection = await mysql.createConnection(
      localConnectionOptions(ephemeralDatabase),
    );
    await createSchema(testConnection);
    await testConnection.query(
      "INSERT INTO institutions (id, is_active) VALUES (1, true)",
    );
    await testConnection.query(
      "INSERT INTO users (id, email, role, approval_status, deleted_at) VALUES (10, NULL, 'doctor', 'APPROVED', NULL), (20, 'recipient@example.test', 'doctor', 'APPROVED', NULL)",
    );
    await testConnection.query(
      "INSERT INTO professional_institutions (id, professional_id, user_id, institution_id, role_in_institution, active) VALUES (1, 101, 10, 1, 'GESTOR_PLUS', true), (2, 102, 20, 1, 'USER', true)",
    );
    await testConnection.query(
      "INSERT INTO professional_access (id, institution_id, professional_id, hospital_id, sector_id, can_access) VALUES (1, 1, 102, 10, 20, true)",
    );
    store = new DrizzleOperationalDeliveryStore(drizzle(testConnection));
  });

  afterAll(async () => {
    try {
      await testConnection?.end();
    } finally {
      if (adminConnection) {
        await adminConnection.query(
          `DROP DATABASE IF EXISTS \`${ephemeralDatabase}\``,
        );
        await adminConnection.end();
      }
    }
  });

  it("faz claim concorrente único com CAS e nunca reivindica SHADOW", async () => {
    const activeDeliveryId = await insertUserDelivery({
      emissionMode: "ACTIVE",
    });
    const [workerConnectionA, workerConnectionB] = await Promise.all([
      mysql.createConnection(localConnectionOptions(ephemeralDatabase)),
      mysql.createConnection(localConnectionOptions(ephemeralDatabase)),
    ]);
    let first: OperationalDeliveryClaim | null = null;
    let second: OperationalDeliveryClaim | null = null;
    try {
      const storeA = new DrizzleOperationalDeliveryStore(
        drizzle(workerConnectionA),
      );
      const storeB = new DrizzleOperationalDeliveryStore(
        drizzle(workerConnectionB),
      );
      [first, second] = await Promise.all([
        storeA.claimNext({ now, leaseMs: 60_000 }),
        storeB.claimNext({ now, leaseMs: 60_000 }),
      ]);
    } finally {
      await Promise.all([workerConnectionA.end(), workerConnectionB.end()]);
    }
    const claims = [first, second].filter(
      (claim): claim is OperationalDeliveryClaim => claim !== null,
    );
    expect(claims).toHaveLength(1);
    expect(claims[0]?.delivery.id).toBe(activeDeliveryId);

    await expect(
      store.applyTransition(claims[0]!, { status: "DELIVERED", at: now }),
    ).resolves.toMatchObject({ applied: true });
    await expect(
      store.applyTransition(claims[0]!, { status: "DELIVERED", at: now }),
    ).resolves.toEqual({ applied: false, delivery: null });

    const shadowDeliveryId = await insertUserDelivery({
      emissionMode: "SHADOW",
    });
    await expect(store.claimNext({ now, leaseMs: 60_000 })).resolves.toBeNull();
    const [rows] = await testConnection!.execute<
      DatabaseRows<{ status: string }>
    >("SELECT status FROM notification_deliveries WHERE id = ?", [
      shadowDeliveryId,
    ]);
    expect(rows[0]?.status).toBe("QUEUED");
  });

  it("encerra lease expirado da sexta tentativa sem criar uma sétima", async () => {
    const deliveryId = await insertUserDelivery({
      emissionMode: "ACTIVE",
      status: "DEAD",
      attemptCount: 6,
    });
    await testConnection!.execute(
      "UPDATE notification_deliveries SET status = 'PROCESSING', lease_until = ? WHERE id = ?",
      [new Date(now.getTime() - 1_000), deliveryId],
    );

    await expect(store.claimNext({ now, leaseMs: 60_000 })).resolves.toBeNull();
    const [rows] = await testConnection!.execute<
      DatabaseRows<{
        status: string;
        attempt_count: number;
        last_error_code: string;
      }>
    >(
      "SELECT status, attempt_count, last_error_code FROM notification_deliveries WHERE id = ?",
      [deliveryId],
    );
    expect(rows[0]).toEqual({
      status: "DEAD",
      attempt_count: 6,
      last_error_code: "LEASE_EXPIRED",
    });
  });

  it("nega convite esgotado ou sem destino antes de qualquer transporte", async () => {
    const exhaustedId = await insertInviteDelivery({
      redeemedCount: 1,
      hasDestination: true,
    });
    const exhausted = await claimOne();
    expect(exhausted.delivery.id).toBe(exhaustedId);
    await expect(store.revalidateRecipientAccess(exhausted)).resolves.toEqual({
      state: "REVOKED",
      code: "RECIPIENT_ACCESS_REVOKED",
    });
    await store.applyTransition(exhausted, {
      status: "SKIPPED",
      at: now,
      errorCode: "RECIPIENT_ACCESS_REVOKED",
    });

    const unaddressedId = await insertInviteDelivery({
      redeemedCount: 0,
      hasDestination: false,
    });
    const unaddressed = await claimOne();
    expect(unaddressed.delivery.id).toBe(unaddressedId);
    await expect(store.revalidateRecipientAccess(unaddressed)).resolves.toEqual(
      {
        state: "REVOKED",
        code: "RECIPIENT_ACCESS_REVOKED",
      },
    );
  });

  it("mantém lease renovado durante transporte lento e impede chamada concorrente", async () => {
    const deliveryId = await insertUserDelivery({
      emissionMode: "ACTIVE",
      availableAt: new Date(),
    });
    const [workerConnectionA, workerConnectionB] = await Promise.all([
      mysql.createConnection(localConnectionOptions(ephemeralDatabase)),
      mysql.createConnection(localConnectionOptions(ephemeralDatabase)),
    ]);
    const entered = deferred();
    const release = deferred();
    let running: Promise<unknown> | undefined;
    let secondTransportCalls = 0;
    try {
      const storeA = new DrizzleOperationalDeliveryStore(
        drizzle(workerConnectionA),
      );
      const storeB = new DrizzleOperationalDeliveryStore(
        drizzle(workerConnectionB),
      );
      const firstTransport: OperationalDeliveryTransport = {
        deliver: async () => {
          entered.resolve();
          await release.promise;
          return { state: "DELIVERED" };
        },
      };
      const secondTransport: OperationalDeliveryTransport = {
        deliver: async () => {
          secondTransportCalls += 1;
          return { state: "DELIVERED" };
        },
      };

      running = processOperationalDeliveryBatch({
        store: storeA,
        transport: firstTransport,
        leaseMs: 2_000,
        limit: 1,
      });
      await entered.promise;
      // Passa tanto do lease original quanto da primeira renovação; os
      // heartbeats seguintes é que preservam exclusividade da chamada viva.
      await delay(4_500);

      await expect(
        processOperationalDeliveryBatch({
          store: storeB,
          transport: secondTransport,
          leaseMs: 2_000,
          limit: 1,
        }),
      ).resolves.toMatchObject({ claimed: 0, delivered: 0 });
      expect(secondTransportCalls).toBe(0);

      release.resolve();
      await expect(running).resolves.toMatchObject({
        claimed: 1,
        delivered: 1,
      });
      const [rows] = await testConnection!.execute<
        DatabaseRows<{ status: string }>
      >("SELECT status FROM notification_deliveries WHERE id = ?", [
        deliveryId,
      ]);
      expect(rows[0]?.status).toBe("DELIVERED");
    } finally {
      release.resolve();
      await running?.catch(() => undefined);
      await Promise.all([workerConnectionA.end(), workerConnectionB.end()]);
    }
  }, 12_000);

  it("mantém a chave idempotente opaca em retry e requeue", async () => {
    const deliveryId = await insertUserDelivery({
      emissionMode: "ACTIVE",
      status: "DEAD",
      attemptCount: 6,
    });
    const keys: string[] = [];
    const transport: OperationalDeliveryTransport = {
      deliver: async (request) => {
        keys.push(request.idempotencyKey);
        return {
          state: "FAILED",
          retryable: false,
          code: "TRANSPORT_REJECTED",
        };
      },
    };

    await expect(
      store.requeueDead({
        deliveryId,
        actor: { userId: 10, role: "GESTOR_PLUS" },
        now,
      }),
    ).resolves.toMatchObject({ state: "REQUEUED" });
    await processOperationalDeliveryBatch({
      store,
      transport,
      now,
      limit: 1,
    });
    await expect(
      store.requeueDead({
        deliveryId,
        actor: { userId: 10, role: "GESTOR_PLUS" },
        now: new Date(now.getTime() + 1_000),
      }),
    ).resolves.toMatchObject({ state: "REQUEUED" });
    await processOperationalDeliveryBatch({
      store,
      transport,
      now: new Date(now.getTime() + 1_000),
      limit: 1,
    });

    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(keys[1]).toBe(keys[0]);
  });

  it("requeue autorizado grava auditoria no mesmo commit", async () => {
    const deliveryId = await insertUserDelivery({
      emissionMode: "ACTIVE",
      status: "DEAD",
      attemptCount: 6,
    });
    await expect(
      store.requeueDead({
        deliveryId,
        actor: { userId: 10, role: "GESTOR_PLUS" },
        now,
      }),
    ).resolves.toMatchObject({ state: "REQUEUED" });

    const [deliveries] = await testConnection!.execute<
      DatabaseRows<{ status: string; attempt_count: number }>
    >(
      "SELECT status, attempt_count FROM notification_deliveries WHERE id = ?",
      [deliveryId],
    );
    expect(deliveries[0]).toEqual({ status: "QUEUED", attempt_count: 0 });
    const [audits] = await testConnection!.execute<
      DatabaseRows<{
        notification_delivery_id: number;
        actor_user_id: number;
        actor_role: string;
        previous_attempt_count: number;
      }>
    >(
      "SELECT notification_delivery_id, actor_user_id, actor_role, previous_attempt_count FROM operational_delivery_requeue_audits WHERE notification_delivery_id = ?",
      [deliveryId],
    );
    expect(audits[0]).toEqual({
      notification_delivery_id: deliveryId,
      actor_user_id: 10,
      actor_role: "GESTOR_PLUS",
      previous_attempt_count: 6,
    });
  });

  it("nega papel de requeue informado que não existe no vínculo canônico", async () => {
    const deliveryId = await insertUserDelivery({
      emissionMode: "ACTIVE",
      status: "DEAD",
      attemptCount: 6,
    });
    await expect(
      store.requeueDead({
        deliveryId,
        actor: { userId: 20, role: "GESTOR_PLUS" },
        now,
      }),
    ).resolves.toEqual({ state: "AUTHORIZATION_DENIED" });
    const [deliveries] = await testConnection!.execute<
      DatabaseRows<{ status: string; attempt_count: number }>
    >(
      "SELECT status, attempt_count FROM notification_deliveries WHERE id = ?",
      [deliveryId],
    );
    expect(deliveries[0]).toEqual({ status: "DEAD", attempt_count: 6 });
    const [audits] = await testConnection!.execute<
      DatabaseRows<{ count: number }>
    >(
      "SELECT COUNT(*) AS count FROM operational_delivery_requeue_audits WHERE notification_delivery_id = ?",
      [deliveryId],
    );
    expect(audits[0]?.count).toBe(0);
  });

  it("reverte o requeue quando a auditoria transacional falha", async () => {
    const deliveryId = await insertUserDelivery({
      emissionMode: "ACTIVE",
      status: "DEAD",
      attemptCount: 6,
    });
    await testConnection!.query(
      "CREATE TRIGGER reject_delivery_requeue_audit BEFORE INSERT ON operational_delivery_requeue_audits FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit test failure'",
    );
    try {
      await expect(
        store.requeueDead({
          deliveryId,
          actor: { userId: 10, role: "GESTOR_PLUS" },
          now,
        }),
      ).rejects.toThrow();
      const [deliveries] = await testConnection!.execute<
        DatabaseRows<{ status: string; attempt_count: number }>
      >(
        "SELECT status, attempt_count FROM notification_deliveries WHERE id = ?",
        [deliveryId],
      );
      expect(deliveries[0]).toEqual({ status: "DEAD", attempt_count: 6 });
    } finally {
      await testConnection!.query(
        "DROP TRIGGER IF EXISTS reject_delivery_requeue_audit",
      );
    }
  });
});
