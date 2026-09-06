import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  institutions,
  professionalAccess,
  professionalInstitutions,
  professionals,
  userContactChannels,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { logger } from "../server/_core/logger";
import { appRouter } from "../server/routers";
import {
  markWhatsAppContactVerified,
  upsertUserWhatsAppContact,
} from "../server/user-contact-channels";
import {
  checkWhatsAppVerification,
  resetWhatsAppVerificationRuntime,
  startWhatsAppVerification,
  whatsappVerificationRuntime,
} from "../server/whatsapp-verification";
import { resetWhatsAppVerifyRateLimits, WHATSAPP_VERIFY_START_USER_LIMIT } from "../server/whatsapp-verification-rate-limit";
import {
  classifyTwilioVerifyCheckStatus,
  type WhatsAppVerificationCheckResult,
  type WhatsAppVerificationProvider,
  type WhatsAppVerificationStartResult,
} from "../server/whatsapp-verification-provider";

class FakeWhatsAppVerificationProvider implements WhatsAppVerificationProvider {
  starts: string[] = [];
  checks: { e164: string; code: string }[] = [];
  startResult: WhatsAppVerificationStartResult = { ok: true, status: "pending" };
  approvePair: { e164: string; code: string } | null = {
    e164: "",
    code: "123456",
  };
  checkOverride: WhatsAppVerificationCheckResult | null = null;

  async startVerification(e164: string): Promise<WhatsAppVerificationStartResult> {
    this.starts.push(e164);
    if (this.approvePair && !this.approvePair.e164) {
      this.approvePair = { ...this.approvePair, e164 };
    }
    return this.startResult;
  }

  async checkVerification(
    e164: string,
    code: string,
  ): Promise<WhatsAppVerificationCheckResult> {
    this.checks.push({ e164, code });
    if (this.checkOverride) return this.checkOverride;
    if (
      this.approvePair &&
      e164 === this.approvePair.e164 &&
      code === this.approvePair.code
    ) {
      return classifyTwilioVerifyCheckStatus("approved");
    }
    return classifyTwilioVerifyCheckStatus("pending");
  }
}

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

describe("WhatsApp L2 Twilio Verify", () => {
  let db: Db;
  let institutionId: number;
  const stamp = Date.now();
  const userIds: number[] = [];
  let fake: FakeWhatsAppVerificationProvider;
  const infoSpy = vi.spyOn(logger, "info");

  async function createUser(
    label: string,
    approvalStatus: "APPROVED" | "PENDING" = "APPROVED",
  ): Promise<{ userId: number; professionalId: number }> {
    const name = `wa-verify-${stamp}-${label}`;
    const [user] = await db
      .insert(users)
      .values({
        name,
        email: `${name}@example.test`,
        passwordHash: "not-used",
        role: "doctor",
        approvalStatus,
        sessionVersion: 1,
      })
      .$returningId();
    userIds.push(user.id);
    const [professional] = await db
      .insert(professionals)
      .values({
        userId: user.id,
        name,
        role: "Médico",
        specialty: "Anestesiologia",
        userRole: "USER",
      })
      .$returningId();
    if (approvalStatus === "APPROVED") {
      await db.insert(professionalInstitutions).values({
        professionalId: professional.id,
        userId: user.id,
        institutionId,
        roleInInstitution: "USER",
        isPrimary: true,
        active: true,
      });
    }
    return { userId: user.id, professionalId: professional.id };
  }

  function callerFor(userId: number) {
    return appRouter.createCaller({
      user: {
        id: userId,
        openId: null,
        name: "tester",
        email: `u${userId}@example.test`,
        passwordHash: null,
        loginMethod: "email",
        role: "doctor",
        approvalStatus: "APPROVED",
        mustChangePassword: false,
        sessionVersion: 1,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastSignedIn: new Date(),
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
      req: { ip: "127.0.0.1" },
      res: undefined,
    } as any);
  }

  async function channelRow(userId: number) {
    const [row] = await db
      .select()
      .from(userContactChannels)
      .where(
        and(
          eq(userContactChannels.userId, userId),
          eq(userContactChannels.channel, "WHATSAPP"),
        ),
      );
    return row;
  }

  beforeEach(async () => {
    const maybe = await getDb();
    if (!maybe) throw new Error("DB unavailable");
    db = maybe;
    const [institution] = await db.select().from(institutions).limit(1);
    if (!institution) throw new Error("seed institution missing");
    institutionId = institution.id;
    fake = new FakeWhatsAppVerificationProvider();
    whatsappVerificationRuntime.provider = fake;
    resetWhatsAppVerifyRateLimits();
    infoSpy.mockClear();
  });

  afterEach(() => {
    resetWhatsAppVerificationRuntime();
    resetWhatsAppVerifyRateLimits();
  });

  afterAll(async () => {
    infoSpy.mockRestore();
    for (const id of userIds) {
      await db
        .delete(userContactChannels)
        .where(eq(userContactChannels.userId, id));
      await db
        .delete(professionalInstitutions)
        .where(eq(professionalInstitutions.userId, id));
      await db.delete(professionals).where(eq(professionals.userId, id));
      await db.delete(users).where(eq(users.id, id));
    }
  });

  it("V1 informa número válido → E.164 canônico, verifiedAt NULL", async () => {
    const a = await createUser("v1");
    const saved = await callerFor(a.userId).profile.setWhatsAppContact({
      phone: "(85) 98881-0001",
    });
    expect(saved.status).toBe("unverified");
    expect(saved.verified).toBe(false);
    const row = await channelRow(a.userId);
    expect(row?.normalizedAddress).toBe("+5585988810001");
    expect(row?.verifiedAt).toBeNull();
    const started = await callerFor(a.userId).profile.startWhatsAppVerification({
      phone: "(85) 98881-0001",
    });
    expect(started.ok).toBe(true);
    if (started.ok) expect(started.verified).toBe(false);
    expect((await channelRow(a.userId))?.verifiedAt).toBeNull();
  });

  it("V2 start chama provider com To persistido", async () => {
    const a = await createUser("v2");
    const started = await callerFor(a.userId).profile.startWhatsAppVerification({
      phone: "(85) 98881-0002",
    });
    expect(started.ok).toBe(true);
    if (started.ok) {
      expect(started.verificationStarted).toBe(true);
      expect(started.verified).toBe(false);
    }
    expect(fake.starts).toEqual(["+5585988810002"]);
    const row = await channelRow(a.userId);
    expect(row?.verifiedAt).toBeNull();
  });

  it("V3 OTP válido → verifiedAt", async () => {
    const a = await createUser("v3");
    await callerFor(a.userId).profile.startWhatsAppVerification({
      phone: "+5585988810003",
    });
    const checked = await callerFor(a.userId).profile.checkWhatsAppVerification({
      code: "123456",
    });
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.verified).toBe(true);
    const row = await channelRow(a.userId);
    expect(row?.verifiedAt).not.toBeNull();
  });

  it("V4 OTP inválido permanece NULL", async () => {
    const a = await createUser("v4");
    await callerFor(a.userId).profile.startWhatsAppVerification({
      phone: "+5585988810004",
    });
    const checked = await callerFor(a.userId).profile.checkWhatsAppVerification({
      code: "000000",
    });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.code).toBe("INVALID_CODE");
    expect((await channelRow(a.userId))?.verifiedAt).toBeNull();
  });

  it("V5 OTP expirado permanece NULL", async () => {
    const a = await createUser("v5");
    await callerFor(a.userId).profile.startWhatsAppVerification({
      phone: "+5585988810005",
    });
    fake.checkOverride = { ok: true, approved: false, status: "expired" };
    const checked = await callerFor(a.userId).profile.checkWhatsAppVerification({
      code: "123456",
    });
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.code).toBe("EXPIRED");
    expect((await channelRow(a.userId))?.verifiedAt).toBeNull();
  });

  it("V6 falha Twilio permanece NULL", async () => {
    const a = await createUser("v6");
    fake.startResult = {
      ok: false,
      kind: "RETRYABLE_PROVIDER_ERROR",
      code: "TWILIO_UNAVAILABLE",
    };
    const started = await callerFor(a.userId).profile.startWhatsAppVerification({
      phone: "+5585988810006",
    });
    expect(started.ok).toBe(false);
    expect((await channelRow(a.userId))?.verifiedAt).toBeNull();
    fake.startResult = { ok: true, status: "pending" };
    await callerFor(a.userId).profile.startWhatsAppVerification({
      phone: "+5585988810006",
    });
    fake.checkOverride = {
      ok: false,
      kind: "RETRYABLE_PROVIDER_ERROR",
      code: "TWILIO_UNAVAILABLE",
    };
    const checked = await callerFor(a.userId).profile.checkWhatsAppVerification({
      code: "123456",
    });
    expect(checked.ok).toBe(false);
    expect((await channelRow(a.userId))?.verifiedAt).toBeNull();
  });

  it("V7 OTP de A não verifica B após troca de número", async () => {
    const a = await createUser("v7");
    await callerFor(a.userId).profile.startWhatsAppVerification({
      phone: "+5585988810007",
    });
    expect(fake.approvePair?.e164).toBe("+5585988810007");
    await upsertUserWhatsAppContact({
      userId: a.userId,
      rawPhone: "+5585988810097",
      institutionId,
    });
    const checked = await callerFor(a.userId).profile.checkWhatsAppVerification({
      code: "123456",
    });
    expect(checked.ok).toBe(false);
    const row = await channelRow(a.userId);
    expect(row?.normalizedAddress).toBe("+5585988810097");
    expect(row?.verifiedAt).toBeNull();
    expect(fake.checks.at(-1)?.e164).toBe("+5585988810097");
    await expect(
      markWhatsAppContactVerified({
        userId: a.userId,
        expectedE164: "+5585988810007",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const sneaky = await checkWhatsAppVerification({
      userId: a.userId,
      code: "123456",
      phone: "+5585988810007",
    } as never);
    expect(sneaky.ok).toBe(false);
    expect(fake.checks.at(-1)?.e164).toBe("+5585988810097");
    expect((await channelRow(a.userId))?.verifiedAt).toBeNull();
  });

  it("V8 user B não verifica número de A", async () => {
    const a = await createUser("v8a");
    const b = await createUser("v8b");
    await callerFor(a.userId).profile.startWhatsAppVerification({
      phone: "+5585988810008",
    });
    const stolen = await callerFor(b.userId).profile.startWhatsAppVerification({
      phone: "+5585988810008",
    });
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) expect(stolen.code).toBe("NUMBER_IN_USE");
    const bCheck = await callerFor(b.userId).profile.checkWhatsAppVerification({
      code: "123456",
    });
    expect(bCheck.ok).toBe(false);
    expect((await channelRow(a.userId))?.verifiedAt).toBeNull();
    expect(await channelRow(b.userId)).toBeUndefined();
  });

  it("V9 check duplicado após sucesso converge", async () => {
    const a = await createUser("v9");
    await callerFor(a.userId).profile.startWhatsAppVerification({
      phone: "+5585988810009",
    });
    const first = await callerFor(a.userId).profile.checkWhatsAppVerification({
      code: "123456",
    });
    const second = await callerFor(a.userId).profile.checkWhatsAppVerification({
      code: "123456",
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const rows = await db
      .select()
      .from(userContactChannels)
      .where(eq(userContactChannels.userId, a.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.verifiedAt).not.toBeNull();
  });

  it("V10 alterar número após verificado zera verifiedAt", async () => {
    const a = await createUser("v10");
    await callerFor(a.userId).profile.startWhatsAppVerification({
      phone: "+5585988810010",
    });
    await callerFor(a.userId).profile.checkWhatsAppVerification({
      code: "123456",
    });
    expect((await channelRow(a.userId))?.verifiedAt).not.toBeNull();
    await callerFor(a.userId).profile.setWhatsAppContact({
      phone: "+5585988810110",
    });
    expect((await channelRow(a.userId))?.verifiedAt).toBeNull();
  });

  it("V11 sem provider configurado falha fechado", async () => {
    const a = await createUser("v11");
    resetWhatsAppVerificationRuntime();
    const started = await callerFor(a.userId).profile.startWhatsAppVerification({
      phone: "+5585988810011",
    });
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.code).toBe("VERIFY_NOT_CONFIGURED");
    expect((await channelRow(a.userId))?.verifiedAt).toBeNull();
  });

  it("V12 OTP e E.164 completo não entram no log", async () => {
    const a = await createUser("v12");
    await callerFor(a.userId).profile.startWhatsAppVerification({
      phone: "+5585988810012",
    });
    await callerFor(a.userId).profile.checkWhatsAppVerification({
      code: "654321",
    });
    const dumped = infoSpy.mock.calls.map((call) => JSON.stringify(call));
    expect(dumped.join("\n")).not.toContain("654321");
    expect(dumped.join("\n")).not.toContain("+5585988810012");
    expect(dumped.join("\n")).not.toMatch(/AC[0-9a-f]{32}/i);
  });

  it("V13 start/check sem autenticação negados", async () => {
    const guest = appRouter.createCaller({
      user: null,
      institutionId: null,
      allowedInstitutionIds: [],
    } as any);
    await expect(
      guest.profile.startWhatsAppVerification({ phone: "+5585988810013" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      guest.profile.checkWhatsAppVerification({ code: "123456" }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("V14 PENDING/deleted negados", async () => {
    const pending = await createUser("v14p", "PENDING");
    await expect(
      startWhatsAppVerification({
        userId: pending.userId,
        institutionId,
        phone: "+5585988810014",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const deleted = await createUser("v14d");
    await db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(eq(users.id, deleted.userId));
    await expect(
      startWhatsAppVerification({
        userId: deleted.userId,
        institutionId,
        phone: "+5585988810114",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("V15 sucesso Verify não cria membership/access/manager", async () => {
    const a = await createUser("v15");
    const beforeMemberships = await db
      .select()
      .from(professionalInstitutions)
      .where(eq(professionalInstitutions.userId, a.userId));
    const beforeAccess = await db
      .select()
      .from(professionalAccess)
      .where(eq(professionalAccess.professionalId, a.professionalId));
    await callerFor(a.userId).profile.startWhatsAppVerification({
      phone: "+5585988810015",
    });
    await callerFor(a.userId).profile.checkWhatsAppVerification({
      code: "123456",
    });
    const afterMemberships = await db
      .select()
      .from(professionalInstitutions)
      .where(eq(professionalInstitutions.userId, a.userId));
    const afterAccess = await db
      .select()
      .from(professionalAccess)
      .where(eq(professionalAccess.professionalId, a.professionalId));
    expect(afterMemberships).toHaveLength(beforeMemberships.length);
    expect(afterAccess).toHaveLength(beforeAccess.length);
    const [user] = await db.select().from(users).where(eq(users.id, a.userId));
    expect(user?.role).toBe("doctor");
    expect(process.env.WHATSAPP_NL_DRIVER_ENABLED).not.toBe("true");
  });

  it("check não aceita telefone do cliente como autoridade", async () => {
    const a = await createUser("no-phone");
    await callerFor(a.userId).profile.startWhatsAppVerification({
      phone: "+5585988810016",
    });
    const checked = await checkWhatsAppVerification({
      userId: a.userId,
      code: "123456",
    });
    expect(checked.ok).toBe(true);
    expect(fake.checks[0]?.e164).toBe("+5585988810016");
  });

  it("canal desativado não é reativado pelo OTP", async () => {
    const a = await createUser("deact");
    await callerFor(a.userId).profile.startWhatsAppVerification({
      phone: "+5585988810017",
    });
    await callerFor(a.userId).profile.deactivateWhatsAppContact();
    const checked = await callerFor(a.userId).profile.checkWhatsAppVerification({
      code: "123456",
    });
    expect(checked.ok).toBe(false);
    const row = await channelRow(a.userId);
    expect(row?.active).toBe(false);
    expect(row?.verifiedAt).toBeNull();
  });

  it("HTTP 2xx pending do provider não marca verificado", async () => {
    const a = await createUser("pending-status");
    await callerFor(a.userId).profile.startWhatsAppVerification({
      phone: "+5585988810018",
    });
    fake.checkOverride = { ok: true, approved: false, status: "pending" };
    const checked = await callerFor(a.userId).profile.checkWhatsAppVerification({
      code: "123456",
    });
    expect(checked.ok).toBe(false);
    expect((await channelRow(a.userId))?.verifiedAt).toBeNull();
  });

  it("start repetido pelo mesmo user estoura rate limit", async () => {
    const a = await createUser("rl-start");
    for (let i = 0; i < WHATSAPP_VERIFY_START_USER_LIMIT; i++) {
      const started = await startWhatsAppVerification({
        userId: a.userId,
        institutionId,
        phone: "+5585988810019",
      });
      expect(started.ok).toBe(true);
    }
    const blocked = await startWhatsAppVerification({
      userId: a.userId,
      institutionId,
      phone: "+5585988810019",
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe("RATE_LIMITED");
    expect((await channelRow(a.userId))?.verifiedAt).toBeNull();
  });
});
