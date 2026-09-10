import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { profileRouter } from "../server/profile-router";
import { router, protectedProcedure } from "../server/_core/trpc";
import type { TrpcContext } from "../server/_core/context";
import { ExpectedUserConstraintError } from "../server/_core/expected-user";
import { SessionInstanceConstraintError } from "../server/_core/session-instance";
import {
  getVerifiedWhatsAppContactForUser,
  upsertUserWhatsAppContact,
} from "../server/user-contact-channels";
import { recordAccountAudit } from "../server/account-audit";
import * as contactDomain from "../server/user-contact-channels";
import { classifyTwilioVerifyCheckStatus } from "../server/whatsapp-verification-provider";
import {
  resetWhatsAppVerificationRuntime,
  whatsappVerificationRuntime,
} from "../server/whatsapp-verification";
import { resetWhatsAppVerifyRateLimits } from "../server/whatsapp-verification-rate-limit";
import type {
  WhatsAppVerificationProvider,
  WhatsAppVerificationStartResult,
  WhatsAppVerificationCheckResult,
} from "../server/whatsapp-verification-provider";
import { DisposableMysqlChildRunner } from "./helpers/disposable-mysql-child-runner";

const runtime = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../server/db", async (original) => ({
  ...(await original<typeof import("../server/db")>()),
  getDb: async () => runtime.db,
}));

const sqlFile = (name: string) =>
  readFileSync(`drizzle/migrations/manual/${name}`, "utf8");
const migration = sqlFile("2026-09-09-whatsapp-account-ownership.sql");
const DB_NAME = `escalas_test_wa_account_${process.pid}_${randomBytes(6).toString("hex")}`;
const A = "+5585988887777";
const B = "+5585977776666";
const SID = `VE${"1".repeat(32)}`;
const CHILD_TARGET_NAMESPACE = "whatsapp-account-ownership-v1";
let pool: Pool;
let childRunner: DisposableMysqlChildRunner;
let provider: WhatsAppVerificationProvider & {
  starts: string[];
  checks: { e164: string; code: string; sid: string }[];
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function rows(sql: string, values: unknown[] = []) {
  const [result] = await pool.query<RowDataPacket[]>(sql, values);
  return result;
}
async function account(id = 1) {
  await pool.query(
    "INSERT INTO users (id,name,approval_status,session_version,role) VALUES (?, 'Test', 'APPROVED', 1, 'doctor')",
    [id],
  );
}
function context(id = 1, extra: Partial<TrpcContext> = {}): TrpcContext {
  return {
    user: {
      id,
      sessionVersion: 1,
      approvalStatus: "APPROVED",
      deletedAt: null,
      role: "doctor",
    },
    institutionId: null,
    allowedInstitutionIds: [],
    tenantResolutionError: "NO_ACTIVE_MEMBERSHIP",
    req: { ip: "127.0.0.1", headers: {} },
    res: undefined,
    ...extra,
  } as TrpcContext;
}
function caller(id = 1, extra: Partial<TrpcContext> = {}) {
  return profileRouter.createCaller(context(id, extra));
}
function operations(c = caller()) {
  return [
    () => c.getWhatsAppContact(),
    () => c.setWhatsAppContact({ phone: A }),
    () => c.deactivateWhatsAppContact(),
    () => c.startWhatsAppVerification({ phone: A }),
    () => c.checkWhatsAppVerification({ code: "123456" }),
  ];
}
async function rejectAudit(condition = "TRUE") {
  await pool.query(
    `CREATE TRIGGER reject_account_audit BEFORE INSERT ON account_audit_events FOR EACH ROW BEGIN IF ${condition} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'test audit failure'; END IF; END`,
  );
}
async function dropAuditTrigger() {
  await childRunner.dropTrigger("reject_account_audit", true);
}

type SchemaTestOperation = () => Promise<unknown>;

function nonDestructiveSql(statement: string): SchemaTestOperation {
  if (
    statement.includes(";") ||
    /^(?:DELETE\s+FROM|DROP\s+|ALTER\s+TABLE\s+.+\s+DROP\s+)/is.test(
      statement.trim(),
    )
  ) {
    throw new Error("Schema setup operation must not contain destructive SQL.");
  }
  return () => pool.query(statement);
}

function sequence(...operations: SchemaTestOperation[]): SchemaTestOperation {
  return async () => {
    for (const operation of operations) await operation();
  };
}

beforeAll(async () => {
  expect(DB_NAME).toMatch(/^escalas_test_wa_account_[0-9]+_[a-f0-9]{12}$/);
  childRunner = await DisposableMysqlChildRunner.create({
    childDatabaseName: DB_NAME,
    namespace: CHILD_TARGET_NAMESPACE,
  });
  pool = childRunner.pool;
  try {
    await pool.query(`CREATE TABLE users (
      id INT NOT NULL PRIMARY KEY, name TEXT NULL,
      role ENUM('admin','manager','doctor','nurse','tech') NOT NULL,
      approval_status ENUM('PENDING','APPROVED') NOT NULL, session_version INT NOT NULL,
      deleted_at TIMESTAMP NULL
    ) ENGINE=InnoDB`);
    await pool.query(sqlFile("2026-08-31-user-contact-channels.sql"));
    await pool.query(migration);
    await pool.query(migration);
    runtime.db = drizzle(pool);
  } catch (setupError) {
    try {
      await childRunner.cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [setupError, cleanupError],
        "WhatsApp schema setup and cleanup both failed.",
      );
    }
    throw setupError;
  }
});
beforeEach(async () => {
  await dropAuditTrigger();
  for (const tableName of [
    "whatsapp_verification_challenges",
    "user_contact_channels",
    "account_audit_events",
    "users",
  ]) {
    await childRunner.deleteAllFrom(tableName);
  }
  resetWhatsAppVerifyRateLimits();
  provider = {
    starts: [],
    checks: [],
    async startVerification(e164) {
      this.starts.push(e164);
      return { ok: true, status: "pending", verificationSid: SID };
    },
    async checkVerification(e164, code, sid) {
      this.checks.push({ e164, code, sid });
      return { ok: true, approved: true };
    },
  };
  whatsappVerificationRuntime.provider = provider;
  await account();
});
afterAll(async () => {
  try {
    resetWhatsAppVerificationRuntime();
    resetWhatsAppVerifyRateLimits();
    runtime.db = null;
  } finally {
    await childRunner?.cleanup();
  }
});

describe("ownership WhatsApp account-wide — MySQL descartável", () => {
  const schemaDriftCases: [string, SchemaTestOperation, SchemaTestOperation][] =
    [
      [
        "index invisível",
        nonDestructiveSql(
          "ALTER TABLE account_audit_events ALTER INDEX idx_account_audit_parent INVISIBLE",
        ),
        nonDestructiveSql(
          "ALTER TABLE account_audit_events ALTER INDEX idx_account_audit_parent VISIBLE",
        ),
      ],
      [
        "tipo unsigned divergente",
        nonDestructiveSql(
          "ALTER TABLE account_audit_events MODIFY actor_user_id INT UNSIGNED NULL",
        ),
        nonDestructiveSql(
          "ALTER TABLE account_audit_events MODIFY actor_user_id INT NULL",
        ),
      ],
      [
        "collation divergente",
        nonDestructiveSql(
          "ALTER TABLE account_audit_events MODIFY action VARCHAR(40) COLLATE utf8mb4_bin NOT NULL",
        ),
        nonDestructiveSql(
          "ALTER TABLE account_audit_events MODIFY action VARCHAR(40) COLLATE utf8mb4_0900_ai_ci NOT NULL",
        ),
      ],
      [
        "comentário extra",
        nonDestructiveSql(
          "ALTER TABLE account_audit_events MODIFY actor_user_id INT NULL COMMENT 'unexpected'",
        ),
        nonDestructiveSql(
          "ALTER TABLE account_audit_events MODIFY actor_user_id INT NULL",
        ),
      ],
      [
        "ordem de coluna divergente",
        nonDestructiveSql(
          "ALTER TABLE account_audit_events MODIFY actor_user_id INT NULL AFTER subject_user_id",
        ),
        nonDestructiveSql(
          "ALTER TABLE account_audit_events MODIFY actor_user_id INT NULL AFTER id",
        ),
      ],
      [
        "regra FK divergente",
        sequence(
          () =>
            childRunner.dropForeignKey(
              "whatsapp_verification_challenges",
              "fk_whatsapp_challenge_user",
            ),
          nonDestructiveSql(
            "ALTER TABLE whatsapp_verification_challenges ADD CONSTRAINT fk_whatsapp_challenge_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE RESTRICT",
          ),
        ),
        sequence(
          () =>
            childRunner.dropForeignKey(
              "whatsapp_verification_challenges",
              "fk_whatsapp_challenge_user",
            ),
          nonDestructiveSql(
            "ALTER TABLE whatsapp_verification_challenges ADD CONSTRAINT fk_whatsapp_challenge_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE",
          ),
        ),
      ],
      [
        "audit phone extra",
        nonDestructiveSql(
          "ALTER TABLE account_audit_events ADD phone VARCHAR(32) NULL",
        ),
        () => childRunner.dropColumn("account_audit_events", "phone"),
      ],
      [
        "challenge otp extra",
        nonDestructiveSql(
          "ALTER TABLE whatsapp_verification_challenges ADD otp VARCHAR(10) NULL",
        ),
        () => childRunner.dropColumn("whatsapp_verification_challenges", "otp"),
      ],
      [
        "audit payload extra",
        nonDestructiveSql(
          "ALTER TABLE account_audit_events ADD payload JSON NULL",
        ),
        () => childRunner.dropColumn("account_audit_events", "payload"),
      ],
      [
        "default divergente",
        nonDestructiveSql(
          "ALTER TABLE account_audit_events ALTER subject_user_id SET DEFAULT 1",
        ),
        () =>
          childRunner.dropDefault("account_audit_events", "subject_user_id"),
      ],
      [
        "default timestamp ausente",
        nonDestructiveSql(
          "ALTER TABLE account_audit_events MODIFY created_at TIMESTAMP NOT NULL",
        ),
        nonDestructiveSql(
          "ALTER TABLE account_audit_events MODIFY created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP",
        ),
      ],
      [
        "ON UPDATE ausente",
        nonDestructiveSql(
          "ALTER TABLE whatsapp_verification_challenges MODIFY updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP",
        ),
        nonDestructiveSql(
          "ALTER TABLE whatsapp_verification_challenges MODIFY updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP",
        ),
      ],
      [
        "ON UPDATE extra",
        nonDestructiveSql(
          "ALTER TABLE account_audit_events MODIFY created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP",
        ),
        nonDestructiveSql(
          "ALTER TABLE account_audit_events MODIFY created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP",
        ),
      ],
      [
        "unique extra",
        nonDestructiveSql(
          "ALTER TABLE account_audit_events ADD UNIQUE KEY unexpected_unique (actor_user_id)",
        ),
        () =>
          childRunner.dropIndex("account_audit_events", "unexpected_unique"),
      ],
      [
        "index extra",
        nonDestructiveSql(
          "ALTER TABLE account_audit_events ADD INDEX unexpected_index (actor_user_id)",
        ),
        () => childRunner.dropIndex("account_audit_events", "unexpected_index"),
      ],
      [
        "index muda para unique",
        sequence(
          () =>
            childRunner.dropIndex(
              "account_audit_events",
              "idx_account_audit_parent",
            ),
          nonDestructiveSql(
            "ALTER TABLE account_audit_events ADD UNIQUE KEY idx_account_audit_parent (parent_event_id)",
          ),
        ),
        sequence(
          () =>
            childRunner.dropIndex(
              "account_audit_events",
              "idx_account_audit_parent",
            ),
          nonDestructiveSql(
            "ALTER TABLE account_audit_events ADD KEY idx_account_audit_parent (parent_event_id)",
          ),
        ),
      ],
      [
        "FK extra sem novo indice",
        nonDestructiveSql(
          "ALTER TABLE whatsapp_verification_challenges ADD CONSTRAINT unexpected_user_fk FOREIGN KEY(user_id) REFERENCES users(id)",
        ),
        () =>
          childRunner.dropForeignKey(
            "whatsapp_verification_challenges",
            "unexpected_user_fk",
          ),
      ],
      [
        "check extra",
        nonDestructiveSql(
          "ALTER TABLE account_audit_events ADD CONSTRAINT unexpected_check CHECK(subject_user_id > 0)",
        ),
        () => childRunner.dropCheck("account_audit_events", "unexpected_check"),
      ],
      [
        "trigger extra",
        nonDestructiveSql(
          "CREATE TRIGGER unexpected_trigger BEFORE INSERT ON account_audit_events FOR EACH ROW SET NEW.subject_user_id = 1",
        ),
        () => childRunner.dropTrigger("unexpected_trigger"),
      ],
    ];

  it.each(schemaDriftCases)(
    "postflight recusa %s e aceita restauração exata",
    async (_label, change, restore) => {
      await change();
      try {
        await expect(pool.query(migration)).rejects.toBeDefined();
      } finally {
        await restore();
      }
      await pool.query(migration);
    },
  );

  it.each([
    [
      "configuração",
      {
        ok: false,
        kind: "SERVER_CONFIGURATION_ERROR",
        code: "PROVIDER_CHANNEL_NOT_CONFIGURED",
      },
      "FAILED",
      "READY",
      "PROVIDER_CHANNEL_NOT_CONFIGURED",
    ],
    [
      "transporte",
      {
        ok: false,
        kind: "RETRYABLE_PROVIDER_ERROR",
        code: "TWILIO_UNAVAILABLE",
      },
      "FAILED",
      "READY",
      "TWILIO_UNAVAILABLE",
    ],
    [
      "malformed",
      {
        ok: false,
        kind: "RETRYABLE_PROVIDER_ERROR",
        code: "PROVIDER_MALFORMED",
      },
      "FAILED",
      "READY",
      "PROVIDER_MALFORMED",
    ],
    [
      "pending",
      classifyTwilioVerifyCheckStatus("pending"),
      "REJECTED",
      "READY",
      "INVALID_CODE",
    ],
    [
      "canceled",
      classifyTwilioVerifyCheckStatus("canceled"),
      "REJECTED",
      "FAILED",
      "VERIFICATION_ENDED",
    ],
    [
      "deleted",
      classifyTwilioVerifyCheckStatus("deleted"),
      "REJECTED",
      "FAILED",
      "VERIFICATION_ENDED",
    ],
    [
      "failed",
      classifyTwilioVerifyCheckStatus("failed"),
      "REJECTED",
      "FAILED",
      "VERIFICATION_ENDED",
    ],
    [
      "expired",
      classifyTwilioVerifyCheckStatus("expired"),
      "REJECTED",
      "FAILED",
      "EXPIRED",
    ],
    [
      "max_attempts_reached",
      classifyTwilioVerifyCheckStatus("max_attempts_reached"),
      "REJECTED",
      "FAILED",
      "TOO_MANY_ATTEMPTS",
    ],
    [
      "unknown",
      classifyTwilioVerifyCheckStatus("unrecognized_status"),
      "FAILED",
      "READY",
      "PROVIDER_MALFORMED",
    ],
  ] as const)(
    "check %s classifica auditoria e terminalidade",
    async (_label, result, outcome, state, code) => {
      await caller().startWhatsAppVerification({ phone: A });
      provider.checkVerification = async () =>
        result as WhatsAppVerificationCheckResult;
      expect(
        await caller().checkWhatsAppVerification({ code: "123456" }),
      ).toMatchObject({ ok: false, code });
      const events = await rows(
        "SELECT outcome FROM account_audit_events WHERE action='WHATSAPP_VERIFY_CHECK' ORDER BY id",
      );
      expect(events.map((event) => event.outcome)).toEqual([
        "REQUESTED",
        outcome,
      ]);
      const [challenge] = await rows(
        "SELECT state,provider_verification_sid FROM whatsapp_verification_challenges",
      );
      expect(challenge.state).toBe(state);
      expect(challenge.provider_verification_sid).toBe(
        state === "FAILED" ? null : SID,
      );
      expect((await caller().getWhatsAppContact()).verified).toBe(false);
    },
  );

  it("readers account-wide exigem sessão também no domínio", async () => {
    await caller().setWhatsAppContact({ phone: A });
    for (const reader of [
      contactDomain.getWhatsAppContactForUser,
      contactDomain.getActiveWhatsAppChannelForUser,
    ]) {
      await expect(reader(1, undefined as never)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      await expect(reader(1, 2)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      expect(await reader(1, 1)).not.toBeNull();
    }
  });

  it("leitura pós-consumo revalida sessão antes de responder sucesso", async () => {
    await caller().startWhatsAppVerification({ phone: A });
    const original = contactDomain.getActiveWhatsAppChannelForUser;
    const spy = vi
      .spyOn(contactDomain, "getActiveWhatsAppChannelForUser")
      .mockImplementation(async (...args) => {
        await pool.query("UPDATE users SET session_version=2 WHERE id=1");
        return original(...args);
      });
    try {
      await expect(
        caller().checkWhatsAppVerification({ code: "123456" }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    } finally {
      spy.mockRestore();
    }
    expect(
      (await rows("SELECT state FROM whatsapp_verification_challenges"))[0]
        .state,
    ).toBe("CONSUMED");
  });

  it("leitura do titular limpa SID expirado sem apagar desafio válido", async () => {
    await caller().startWhatsAppVerification({ phone: A });
    await caller().getWhatsAppContact();
    expect(
      (
        await rows(
          "SELECT provider_verification_sid FROM whatsapp_verification_challenges",
        )
      )[0].provider_verification_sid,
    ).toBe(SID);
    await pool.query(
      "UPDATE whatsapp_verification_challenges SET expires_at=DATE_SUB(NOW(),INTERVAL 1 SECOND)",
    );
    await caller().getWhatsAppContact();
    expect(
      (
        await rows(
          "SELECT state,provider_verification_sid FROM whatsapp_verification_challenges",
        )
      )[0],
    ).toMatchObject({ state: "FAILED", provider_verification_sid: null });
  });

  it("nova sessão limpa SID do desafio da sessão revogada", async () => {
    await caller().startWhatsAppVerification({ phone: A });
    await pool.query("UPDATE users SET session_version=2 WHERE id=1");
    const fresh = caller(1, {
      user: { ...context().user!, sessionVersion: 2 },
    });
    await fresh.getWhatsAppContact();
    expect(
      (
        await rows(
          "SELECT state,provider_verification_sid FROM whatsapp_verification_challenges",
        )
      )[0],
    ).toMatchObject({ state: "INVALIDATED", provider_verification_sid: null });
  });

  it("SQL de retenção documentado é limitado, idempotente e preserva desafio válido", async () => {
    const doc = readFileSync("docs/WHATSAPP_ACCOUNT_OWNERSHIP_V1.md", "utf8");
    const cleanup = doc.match(
      /```sql\n(-- WHATSAPP_RETENTION_MAINTENANCE[\s\S]+?)```/,
    )?.[1];
    expect(cleanup).toBeDefined();
    const accounts = Array.from({ length: 102 }, (_, i) => [
      i + 2,
      "Retention test",
      "APPROVED",
      1,
      "doctor",
    ]);
    await pool.query(
      "INSERT INTO users(id,name,approval_status,session_version,role) VALUES ?",
      [accounts],
    );
    await pool.query(
      "INSERT INTO user_contact_channels(user_id,channel,address,normalized_address,active) SELECT id,'WHATSAPP',CONCAT('+55859',LPAD(id,8,'0')),CONCAT('+55859',LPAD(id,8,'0')),1 FROM users",
    );
    await pool.query(
      "INSERT INTO whatsapp_verification_challenges(user_id,challenge_id,contact_id,session_version,state,provider_verification_sid,request_audit_id,expires_at) SELECT u.id,UUID(),ch.id,1,'READY',?,1,IF(u.id>=99,DATE_ADD(NOW(),INTERVAL 5 MINUTE),DATE_SUB(NOW(),INTERVAL 1 SECOND)) FROM users u JOIN user_contact_channels ch ON ch.user_id=u.id",
      [SID],
    );
    await pool.query(
      "UPDATE users SET approval_status='PENDING' WHERE id=99; UPDATE user_contact_channels SET active=0 WHERE user_id=100; UPDATE users SET session_version=2 WHERE id=101; UPDATE users SET deleted_at=NOW() WHERE id=102",
    );
    const maintenance = await pool.getConnection();
    try {
      await maintenance.query("SET SESSION time_zone='+03:00'");
      for (const expected of [100, 2, 0]) {
        const [result] = await maintenance.query<mysql.ResultSetHeader>(
          cleanup!,
        );
        expect(result.affectedRows).toBe(expected);
      }
    } finally {
      await maintenance.query("SET SESSION time_zone='+00:00'");
      maintenance.release();
    }
    expect(
      (
        await rows(
          "SELECT state,provider_verification_sid FROM whatsapp_verification_challenges WHERE user_id=103",
        )
      )[0],
    ).toMatchObject({ state: "READY", provider_verification_sid: SID });
    expect(
      (
        await rows(
          "SELECT state,provider_verification_sid FROM whatsapp_verification_challenges WHERE user_id=102",
        )
      )[0],
    ).toMatchObject({ state: "INVALIDATED", provider_verification_sid: null });
    expect(await rows("SELECT * FROM account_audit_events")).toHaveLength(0);
    expect(
      (
        await rows(
          "SELECT COUNT(*) AS count FROM user_contact_channels WHERE verified_at IS NOT NULL",
        )
      )[0].count,
    ).toBe(0);
  });

  it("migration reroda sem perder dados e rejeita schema incompatível", async () => {
    await caller().setWhatsAppContact({ phone: A });
    await pool.query(migration);
    expect(await rows("SELECT * FROM account_audit_events")).toHaveLength(1);
    expect((await caller().getWhatsAppContact()).status).toBe("unverified");
    await childRunner.dropIndex(
      "account_audit_events",
      "idx_account_audit_parent",
    );
    await expect(pool.query(migration)).rejects.toBeDefined();
    await pool.query(
      "ALTER TABLE account_audit_events ADD INDEX idx_account_audit_parent (parent_event_id)",
    );
    await pool.query(migration);
    await pool.query(
      "ALTER TABLE account_audit_events ADD CONSTRAINT test_forbidden_audit_cascade FOREIGN KEY (subject_user_id) REFERENCES users(id) ON DELETE CASCADE",
    );
    await expect(pool.query(migration)).rejects.toBeDefined();
    await childRunner.dropForeignKey(
      "account_audit_events",
      "test_forbidden_audit_cascade",
    );
    await pool.query(migration);
  });

  it.each([0, 1, 3])(
    "os cinco endpoints pertencem à conta com %i vínculos",
    async (count) => {
      const ids = Array.from({ length: count }, (_, i) => i + 10);
      const c = caller(1, {
        institutionId: ids[0] ?? null,
        allowedInstitutionIds: ids,
        tenantResolutionError: count ? null : "NO_ACTIVE_MEMBERSHIP",
      });
      expect((await c.getWhatsAppContact()).status).toBe("missing");
      expect((await c.setWhatsAppContact({ phone: A })).status).toBe(
        "unverified",
      );
      expect((await c.startWhatsAppVerification({})).ok).toBe(true);
      expect(
        (await c.checkWhatsAppVerification({ code: "123456" })).verified,
      ).toBe(true);
      expect((await c.deactivateWhatsAppContact()).active).toBe(false);
      const audit = await rows("SELECT * FROM account_audit_events");
      expect(audit.length).toBeGreaterThanOrEqual(6);
      for (const entry of audit) {
        expect(entry.subject_user_id).toBe(1);
        expect(entry).not.toHaveProperty("institution_id");
      }
      expect(JSON.stringify(audit)).not.toMatch(
        /\+5585|123456|VE111|challenge_id|token|phone|payload/,
      );
    },
  );

  it("troca de tenant e vínculo revogado não revogam ownership nem concedem escala", async () => {
    const ctx = context(1, {
      institutionId: null,
      tenantResolutionError: "TENANT_NOT_ALLOWED",
    });
    await caller(1, {
      institutionId: 10,
      allowedInstitutionIds: [10, 20],
      tenantResolutionError: null,
    }).startWhatsAppVerification({ phone: A });
    expect(
      (
        await profileRouter
          .createCaller(ctx)
          .checkWhatsAppVerification({ code: "123456" })
      ).ok,
    ).toBe(true);
    const institutional = router({
      read: protectedProcedure.query(() => "SHOULD_NOT_RUN"),
    });
    await expect(institutional.createCaller(ctx).read()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await rows("SELECT role FROM users WHERE id=1"))[0].role).toBe(
      "doctor",
    );
  });

  it("input cliente não muda o titular, destino ou SID do check", async () => {
    await account(2);
    await caller().startWhatsAppVerification({ phone: A, userId: 2 } as never);
    await caller().checkWhatsAppVerification({
      code: "123456",
      phone: B,
      verificationSid: `VE${"2".repeat(32)}`,
      userId: 2,
    } as never);
    expect(provider.checks).toEqual([{ e164: A, code: "123456", sid: SID }]);
    expect((await caller(2).getWhatsAppContact()).status).toBe("missing");
  });

  it("pending/deleted/sessão revogada no DB bloqueiam todos os endpoints", async () => {
    for (const update of [
      "approval_status='PENDING'",
      "deleted_at=NOW()",
      "session_version=2",
    ]) {
      await pool.query(
        `UPDATE users SET approval_status='APPROVED',deleted_at=NULL,session_version=1, ${update} WHERE id=1`,
      );
      for (const operation of operations())
        await expect(operation()).rejects.toBeDefined();
    }
    expect(provider.starts).toHaveLength(0);
    expect(provider.checks).toHaveLength(0);
    expect(await rows("SELECT * FROM account_audit_events")).toHaveLength(0);
  });

  it("identidade e instância de sessão exatas continuam fail-closed", async () => {
    for (const extra of [
      { user: null },
      {
        expectedUserConstraintError: new ExpectedUserConstraintError(
          "EXPECTED_USER_MISMATCH",
          409,
        ),
      },
      {
        sessionInstanceConstraintError: new SessionInstanceConstraintError(
          "SESSION_INSTANCE_MISMATCH",
          409,
        ),
      },
    ])
      for (const operation of operations(caller(1, extra)))
        await expect(operation()).rejects.toBeDefined();
    expect(provider.starts).toHaveLength(0);
  });

  it("falha da auditoria reverte set/deactivate e impede start antes da rede", async () => {
    await caller().setWhatsAppContact({ phone: A });
    await rejectAudit();
    await expect(caller().setWhatsAppContact({ phone: B })).rejects.toThrow(
      "Operação WhatsApp indisponível no momento.",
    );
    await expect(caller().deactivateWhatsAppContact()).rejects.toThrow(
      "Operação WhatsApp indisponível no momento.",
    );
    await expect(caller().startWhatsAppVerification({})).rejects.toThrow(
      "Operação WhatsApp indisponível no momento.",
    );
    const contact = (await rows("SELECT * FROM user_contact_channels"))[0];
    expect(contact.normalized_address).toBe(A);
    expect(contact.active).toBe(1);
    expect(provider.starts).toHaveLength(0);
    expect(
      await rows("SELECT * FROM whatsapp_verification_challenges"),
    ).toHaveLength(0);
  });

  it("audit failure após approved reverte verifiedAt e consumo do desafio", async () => {
    await caller().startWhatsAppVerification({ phone: A });
    await rejectAudit(
      "NEW.action='WHATSAPP_VERIFY_CHECK' AND NEW.outcome='SUCCEEDED'",
    );
    await expect(
      caller().checkWhatsAppVerification({ code: "123456" }),
    ).rejects.toThrow("Operação WhatsApp indisponível no momento.");
    expect(
      (await rows("SELECT verified_at FROM user_contact_channels"))[0]
        .verified_at,
    ).toBeNull();
    expect(
      (await rows("SELECT state FROM whatsapp_verification_challenges"))[0]
        .state,
    ).toBe("READY");
    expect(await getVerifiedWhatsAppContactForUser(1)).toBeNull();
  });

  it("audit failure ao anexar SID deixa STARTING indisponível; expiração fecha o órfão", async () => {
    await caller().setWhatsAppContact({ phone: A });
    await rejectAudit(
      "NEW.action='WHATSAPP_VERIFY_START' AND NEW.outcome='SUCCEEDED'",
    );
    await expect(caller().startWhatsAppVerification({})).rejects.toThrow(
      "Operação WhatsApp indisponível no momento.",
    );
    expect(
      (
        await rows(
          "SELECT state,provider_verification_sid FROM whatsapp_verification_challenges",
        )
      )[0],
    ).toMatchObject({ state: "STARTING", provider_verification_sid: null });
    await dropAuditTrigger();
    expect(
      (await caller().checkWhatsAppVerification({ code: "123456" })).ok,
    ).toBe(false);
    expect(provider.checks).toHaveLength(0);
    await pool.query(
      "UPDATE whatsapp_verification_challenges SET expires_at=DATE_SUB(NOW(),INTERVAL 1 SECOND)",
    );
    expect(
      (await caller().checkWhatsAppVerification({ code: "123456" })).ok,
    ).toBe(false);
    expect(
      (await rows("SELECT state FROM whatsapp_verification_challenges"))[0]
        .state,
    ).toBe("FAILED");
  });

  it("provider rejeitado ou exceção deixa desafio FAILED sem verificação", async () => {
    provider.startVerification = async () => {
      throw new Error("secret provider payload");
    };
    const result = await caller().startWhatsAppVerification({ phone: A });
    expect(result).toMatchObject({ ok: false, code: "TWILIO_UNAVAILABLE" });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(
      (await rows("SELECT state FROM whatsapp_verification_challenges"))[0]
        .state,
    ).toBe("FAILED");
  });

  it("start pendente → A→B→A não anexa resposta antiga; controle sem mudança passa", async () => {
    for (const aba of [false, true]) {
      const reached = deferred<void>();
      const response = deferred<WhatsAppVerificationStartResult>();
      provider.startVerification = async () => {
        reached.resolve();
        return response.promise;
      };
      const pending = caller().startWhatsAppVerification({ phone: A });
      await reached.promise;
      if (aba) {
        await caller().setWhatsAppContact({ phone: B });
        await caller().setWhatsAppContact({ phone: A });
      }
      response.resolve({ ok: true, status: "pending", verificationSid: SID });
      const result = await pending;
      expect(result.ok).toBe(!aba);
      expect(
        (await rows("SELECT state FROM whatsapp_verification_challenges"))[0]
          .state,
      ).toBe(aba ? "INVALIDATED" : "READY");
    }
  });

  it("check pendente → A→B→A + novo start não valida o novo desafio mesmo com SID igual", async () => {
    await caller().startWhatsAppVerification({ phone: A });
    const oldId = (
      await rows("SELECT challenge_id FROM whatsapp_verification_challenges")
    )[0].challenge_id;
    const reached = deferred<void>();
    const response = deferred<WhatsAppVerificationCheckResult>();
    provider.checkVerification = async () => {
      reached.resolve();
      return response.promise;
    };
    const pending = caller().checkWhatsAppVerification({ code: "123456" });
    await reached.promise;
    await caller().setWhatsAppContact({ phone: B });
    await caller().setWhatsAppContact({ phone: A });
    await caller().startWhatsAppVerification({});
    expect(
      (
        await rows("SELECT challenge_id FROM whatsapp_verification_challenges")
      )[0].challenge_id,
    ).not.toBe(oldId);
    response.resolve({ ok: true, approved: true });
    expect(await pending).toMatchObject({ ok: false, code: "CHANNEL_CHANGED" });
    expect((await caller().getWhatsAppContact()).verified).toBe(false);
  });

  it("revogação da sessão durante Verify bloqueia conclusão", async () => {
    await caller().startWhatsAppVerification({ phone: A });
    const reached = deferred<void>();
    const response = deferred<WhatsAppVerificationCheckResult>();
    provider.checkVerification = async () => {
      reached.resolve();
      return response.promise;
    };
    const pending = caller().checkWhatsAppVerification({ code: "123456" });
    const assertion = expect(pending).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await reached.promise;
    await pool.query("UPDATE users SET session_version=2 WHERE id=1");
    response.resolve({ ok: true, approved: true });
    await assertion;
    expect(
      (await rows("SELECT verified_at FROM user_contact_channels"))[0]
        .verified_at,
    ).toBeNull();
  });

  it("dois starts com respostas invertidas mantêm só o UUID mais recente", async () => {
    const firstReached = deferred<void>();
    const secondReached = deferred<void>();
    const firstResponse = deferred<WhatsAppVerificationStartResult>();
    const secondResponse = deferred<WhatsAppVerificationStartResult>();
    let count = 0;
    provider.startVerification = async () => {
      if (++count === 1) {
        firstReached.resolve();
        return firstResponse.promise;
      }
      secondReached.resolve();
      return secondResponse.promise;
    };
    const first = caller().startWhatsAppVerification({ phone: A });
    await firstReached.promise;
    const firstId = (
      await rows("SELECT challenge_id FROM whatsapp_verification_challenges")
    )[0].challenge_id;
    const second = caller().startWhatsAppVerification({});
    await secondReached.promise;
    const secondId = (
      await rows("SELECT challenge_id FROM whatsapp_verification_challenges")
    )[0].challenge_id;
    expect(secondId).not.toBe(firstId);
    secondResponse.resolve({
      ok: true,
      status: "pending",
      verificationSid: `VE${"2".repeat(32)}`,
    });
    expect((await second).ok).toBe(true);
    firstResponse.resolve({
      ok: true,
      status: "pending",
      verificationSid: SID,
    });
    expect(await first).toMatchObject({ ok: false, code: "CHANNEL_CHANGED" });
    expect(
      (await rows("SELECT * FROM whatsapp_verification_challenges"))[0],
    ).toMatchObject({
      challenge_id: secondId,
      state: "READY",
      provider_verification_sid: `VE${"2".repeat(32)}`,
    });
  });

  it("falha SQL ao anexar SID não vaza causa nem parâmetros privados", async () => {
    await pool.query(
      "CREATE TRIGGER reject_challenge_update BEFORE UPDATE ON whatsapp_verification_challenges FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test private challenge'",
    );
    try {
      const failure = await caller()
        .startWhatsAppVerification({ phone: A })
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
        message: "Operação WhatsApp indisponível no momento.",
      });
      expect(failure).toHaveProperty("cause", undefined);
      expect(JSON.stringify(failure)).not.toMatch(
        /VE111|\+5585|challenge_id|test private challenge|params|Failed query/,
      );
      expect(
        (
          await rows(
            "SELECT state,provider_verification_sid FROM whatsapp_verification_challenges",
          )
        )[0],
      ).toMatchObject({ state: "STARTING", provider_verification_sid: null });
    } finally {
      await childRunner.dropTrigger("reject_challenge_update");
    }
  });

  it("domínio mutante sem sessionVersion falha antes de persistir", async () => {
    await expect(
      upsertUserWhatsAppContact({ userId: 1, rawPhone: A } as never),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await rows("SELECT * FROM user_contact_channels")).toHaveLength(0);
    expect(await rows("SELECT * FROM account_audit_events")).toHaveLength(0);
  });

  it("dois checks aprovados concorrentes consomem uma só vez", async () => {
    await caller().startWhatsAppVerification({ phone: A });
    const reached = deferred<void>();
    const response = deferred<WhatsAppVerificationCheckResult>();
    let count = 0;
    provider.checkVerification = async () => {
      if (++count === 2) reached.resolve();
      return response.promise;
    };
    const first = caller().checkWhatsAppVerification({ code: "123456" });
    const second = caller().checkWhatsAppVerification({ code: "123456" });
    await reached.promise;
    response.resolve({ ok: true, approved: true });
    const results = await Promise.all([first, second]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(
      await rows(
        "SELECT * FROM account_audit_events WHERE action='WHATSAPP_VERIFY_CHECK' AND outcome='SUCCEEDED'",
      ),
    ).toHaveLength(1);
    expect(
      (await rows("SELECT state FROM whatsapp_verification_challenges"))[0]
        .state,
    ).toBe("CONSUMED");
  });

  it("unicidade global e concorrência de cadastro não produzem duas identidades", async () => {
    await account(2);
    const attempts = await Promise.allSettled([
      caller().setWhatsAppContact({ phone: A }),
      caller(2).setWhatsAppContact({ phone: A }),
    ]);
    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(await rows("SELECT * FROM user_contact_channels")).toHaveLength(1);
    expect(await rows("SELECT * FROM account_audit_events")).toHaveLength(1);
  });

  it("rate limit preservado e sucesso não contorna elegibilidade do inbound", async () => {
    for (let i = 0; i < 5; i++)
      expect((await caller().startWhatsAppVerification({ phone: A })).ok).toBe(
        true,
      );
    expect(await caller().startWhatsAppVerification({})).toMatchObject({
      ok: false,
      code: "RATE_LIMITED",
    });
    expect(provider.starts).toHaveLength(5);
    expect(await getVerifiedWhatsAppContactForUser(1)).toBeNull();
    expect(
      (await caller().checkWhatsAppVerification({ code: "123456" })).ok,
    ).toBe(true);
    expect(await getVerifiedWhatsAppContactForUser(1)).not.toBeNull();
    await pool.query("UPDATE users SET approval_status='PENDING' WHERE id=1");
    expect(await getVerifiedWhatsAppContactForUser(1)).toBeNull();
  });

  it("writer account-wide rejeita payload arbitrário e auditoria sobrevive ao hard-delete", async () => {
    await expect(
      recordAccountAudit(drizzle(pool), {
        actorUserId: 1,
        subjectUserId: 1,
        sessionVersion: 1,
        action: "WHATSAPP_CONTACT_SET",
        outcome: "SUCCEEDED",
        phone: A,
      } as never),
    ).rejects.toBeDefined();
    await caller().setWhatsAppContact({ phone: A });
    await childRunner.deleteByIntegerId("users", 1);
    expect(await rows("SELECT * FROM user_contact_channels")).toHaveLength(0);
    expect(await rows("SELECT * FROM account_audit_events")).toHaveLength(1);
  });
});
