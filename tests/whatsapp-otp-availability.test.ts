import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  hospitals,
  institutions,
  managerScope,
  professionalAccess,
  professionalInstitutions,
  professionals,
  sectors,
  userContactChannels,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { appRouter } from "../server/routers";
import { listActiveInstitutionIdsForUser } from "../server/_core/tenant";
import {
  resetWhatsAppVerificationRuntime,
  startWhatsAppVerification,
  whatsappVerificationRuntime,
} from "../server/whatsapp-verification";
import { resetWhatsAppVerifyRateLimits } from "../server/whatsapp-verification-rate-limit";
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
type UserRole = "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";

describe("WhatsApp OTP — disponibilidade na base", () => {
  let db!: Db;
  const stamp = Date.now();
  const userIds: number[] = [];
  const professionalIds: number[] = [];
  let fake!: FakeWhatsAppVerificationProvider;
  let phoneSeq = 0;
  let tenantA!: {
    institutionId: number;
    hospitalId: number;
    sectorId: number;
    sectorName: string;
  };
  let tenantB!: {
    institutionId: number;
    hospitalId: number;
    sectorId: number;
    sectorName: string;
  };

  function nextPhone(): string {
    phoneSeq += 1;
    return `+55859888${String(4000 + (stamp % 500) + phoneSeq).padStart(4, "0")}`;
  }

  async function seedSecondInstitution() {
    const cnpj = `${stamp}${Math.floor(Math.random() * 1e8)
      .toString()
      .padStart(8, "0")}`.slice(-14);
    const [institution] = await db
      .insert(institutions)
      .values({
        name: `Hospital Availability B ${stamp}`,
        cnpj,
        legalName: `Hospital Availability B ${stamp}`,
        tradeName: `HAB${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    const [hospital] = await db
      .insert(hospitals)
      .values({
        institutionId: institution.id,
        name: `Unidade B ${stamp}`,
      })
      .$returningId();
    const [sector] = await db
      .insert(sectors)
      .values({
        institutionId: institution.id,
        hospitalId: hospital.id,
        name: "Pronto Socorro",
        category: "internacao",
        color: "#0F766E",
      })
      .$returningId();
    return {
      institutionId: institution.id,
      hospitalId: hospital.id,
      sectorId: sector.id,
      sectorName: "Pronto Socorro",
    };
  }

  async function createUser(args: {
    label: string;
    institutionId: number;
    userRole?: UserRole;
    approvalStatus?: "APPROVED" | "PENDING";
    withMembership?: boolean;
  }): Promise<{ userId: number; professionalId: number }> {
    const name = `wa-otp-av-${stamp}-${args.label}`;
    const [user] = await db
      .insert(users)
      .values({
        name,
        email: `${name}@example.test`,
        passwordHash: "not-used",
        role: "doctor",
        approvalStatus: args.approvalStatus ?? "APPROVED",
        sessionVersion: 1,
      })
      .$returningId();
    userIds.push(user.id);
    const userRole = args.userRole ?? "USER";
    const [professional] = await db
      .insert(professionals)
      .values({
        userId: user.id,
        name,
        role: "Médico",
        specialty: "Anestesiologia",
        userRole,
      })
      .$returningId();
    professionalIds.push(professional.id);
    const withMembership =
      args.withMembership ?? args.approvalStatus !== "PENDING";
    if (withMembership) {
      await db.insert(professionalInstitutions).values({
        professionalId: professional.id,
        userId: user.id,
        institutionId: args.institutionId,
        roleInInstitution: userRole,
        isPrimary: true,
        active: true,
      });
    }
    return { userId: user.id, professionalId: professional.id };
  }

  function callerFor(args: {
    userId: number;
    institutionId: number | null;
    allowedInstitutionIds?: number[];
    approvalStatus?: "APPROVED" | "PENDING";
    tenantResolutionError?: "NO_ACTIVE_MEMBERSHIP" | null;
  }) {
    return appRouter.createCaller({
      user: {
        id: args.userId,
        openId: null,
        name: "tester",
        email: `u${args.userId}@example.test`,
        passwordHash: null,
        loginMethod: "email",
        role: "doctor",
        approvalStatus: args.approvalStatus ?? "APPROVED",
        mustChangePassword: false,
        sessionVersion: 1,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastSignedIn: new Date(),
      },
      institutionId: args.institutionId,
      allowedInstitutionIds: args.allowedInstitutionIds ??
        (args.institutionId ? [args.institutionId] : []),
      tenantResolutionError: args.tenantResolutionError ?? null,
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

  async function verifyOwnNumber(args: {
    userId: number;
    institutionId: number;
    phone: string;
    allowedInstitutionIds?: number[];
  }) {
    const caller = callerFor({
      userId: args.userId,
      institutionId: args.institutionId,
      allowedInstitutionIds: args.allowedInstitutionIds,
    });
    const saved = await caller.profile.setWhatsAppContact({ phone: args.phone });
    expect(saved.status).toBe("unverified");
    const started = await caller.profile.startWhatsAppVerification({});
    expect(started.ok).toBe(true);
    const checked = await caller.profile.checkWhatsAppVerification({
      code: "123456",
    });
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(checked.verified).toBe(true);
    const row = await channelRow(args.userId);
    expect(row?.normalizedAddress).toBe(args.phone);
    expect(row?.verifiedAt).not.toBeNull();
    return row;
  }

  beforeAll(async () => {
    const maybe = await getDb();
    if (!maybe) throw new Error("DB unavailable");
    db = maybe;

    const [institution] = await db.select().from(institutions).limit(1);
    if (!institution) throw new Error("seed institution missing");
    const [hospital] = await db
      .select()
      .from(hospitals)
      .where(eq(hospitals.institutionId, institution.id))
      .limit(1);
    if (!hospital) throw new Error("seed hospital missing");
    const [centro] = await db
      .select()
      .from(sectors)
      .where(
        and(
          eq(sectors.hospitalId, hospital.id),
          eq(sectors.name, "Centro Cirúrgico"),
        ),
      )
      .limit(1);
    if (!centro) throw new Error("seed sector Centro Cirúrgico missing");
    tenantA = {
      institutionId: institution.id,
      hospitalId: hospital.id,
      sectorId: centro.id,
      sectorName: centro.name,
    };
    tenantB = await seedSecondInstitution();
  });

  beforeEach(() => {
    fake = new FakeWhatsAppVerificationProvider();
    whatsappVerificationRuntime.provider = fake;
    resetWhatsAppVerifyRateLimits();
  });

  afterEach(() => {
    resetWhatsAppVerificationRuntime();
    resetWhatsAppVerifyRateLimits();
  });

  afterAll(async () => {
    for (const professionalId of professionalIds) {
      await db
        .delete(managerScope)
        .where(eq(managerScope.managerProfessionalId, professionalId));
      await db
        .delete(professionalAccess)
        .where(eq(professionalAccess.professionalId, professionalId));
    }
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

  it("USER em instituição A, sem manager_scope nem professional_access, verifica o próprio contato", async () => {
    expect(tenantA.sectorName).toBe("Centro Cirúrgico");
    const user = await createUser({
      label: "user-a",
      institutionId: tenantA.institutionId,
      userRole: "USER",
    });
    const accessBefore = await db
      .select()
      .from(professionalAccess)
      .where(eq(professionalAccess.professionalId, user.professionalId));
    const scopeBefore = await db
      .select()
      .from(managerScope)
      .where(eq(managerScope.managerProfessionalId, user.professionalId));
    expect(accessBefore).toHaveLength(0);
    expect(scopeBefore).toHaveLength(0);

    const phone = nextPhone();
    await verifyOwnNumber({
      userId: user.userId,
      institutionId: tenantA.institutionId,
      phone,
    });

    const accessAfter = await db
      .select()
      .from(professionalAccess)
      .where(eq(professionalAccess.professionalId, user.professionalId));
    const scopeAfter = await db
      .select()
      .from(managerScope)
      .where(eq(managerScope.managerProfessionalId, user.professionalId));
    expect(accessAfter).toHaveLength(0);
    expect(scopeAfter).toHaveLength(0);
  });

  it("GESTOR_MEDICO em instituição B e setor distinto verifica o mesmo tipo de canal de usuário", async () => {
    const manager = await createUser({
      label: "gestor-b",
      institutionId: tenantB.institutionId,
      userRole: "GESTOR_MEDICO",
    });
    await db.insert(managerScope).values({
      institutionId: tenantB.institutionId,
      managerProfessionalId: manager.professionalId,
      hospitalId: tenantB.hospitalId,
      sectorId: tenantB.sectorId,
      active: true,
    });
    expect(tenantB.sectorName).toBe("Pronto Socorro");
    expect(tenantB.institutionId).not.toBe(tenantA.institutionId);
    expect(tenantB.sectorId).not.toBe(tenantA.sectorId);

    const phone = nextPhone();
    const row = await verifyOwnNumber({
      userId: manager.userId,
      institutionId: tenantB.institutionId,
      phone,
    });
    expect(row?.userId).toBe(manager.userId);

    const channels = await db
      .select()
      .from(userContactChannels)
      .where(eq(userContactChannels.userId, manager.userId));
    expect(channels).toHaveLength(1);
    const access = await db
      .select()
      .from(professionalAccess)
      .where(eq(professionalAccess.professionalId, manager.professionalId));
    expect(access).toHaveLength(0);
    const memberships = await db
      .select()
      .from(professionalInstitutions)
      .where(eq(professionalInstitutions.userId, manager.userId));
    expect(memberships).toHaveLength(1);
  });

  it("vínculo duplo: trocar a instituição ativa não cria segundo WhatsApp", async () => {
    const user = await createUser({
      label: "dual",
      institutionId: tenantA.institutionId,
      userRole: "USER",
    });
    await db.insert(professionalInstitutions).values({
      professionalId: user.professionalId,
      userId: user.userId,
      institutionId: tenantB.institutionId,
      roleInInstitution: "USER",
      isPrimary: false,
      active: true,
    });
    const allowed = await listActiveInstitutionIdsForUser(user.userId);
    expect(allowed).toEqual(
      expect.arrayContaining([tenantA.institutionId, tenantB.institutionId]),
    );

    const phone = nextPhone();
    const first = await verifyOwnNumber({
      userId: user.userId,
      institutionId: tenantA.institutionId,
      phone,
      allowedInstitutionIds: allowed,
    });

    const callerB = callerFor({
      userId: user.userId,
      institutionId: tenantB.institutionId,
      allowedInstitutionIds: allowed,
    });
    const viewed = await callerB.profile.getWhatsAppContact();
    expect(viewed.status).toBe("verified");
    const startedOnB = await callerB.profile.startWhatsAppVerification({});
    expect(startedOnB.ok).toBe(true);
    if (startedOnB.ok) {
      expect(startedOnB.alreadyVerified).toBe(true);
      expect(startedOnB.verificationStarted).toBe(false);
    }

    const rows = await db
      .select()
      .from(userContactChannels)
      .where(eq(userContactChannels.userId, user.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first?.id);
    expect(rows[0]?.verifiedAt).not.toBeNull();
  });

  it("usuário de outra instituição não verifica o contato alheio", async () => {
    const a = await createUser({
      label: "owner-a",
      institutionId: tenantA.institutionId,
    });
    const b = await createUser({
      label: "other-b",
      institutionId: tenantB.institutionId,
    });
    const phone = nextPhone();
    await callerFor({
      userId: a.userId,
      institutionId: tenantA.institutionId,
    }).profile.startWhatsAppVerification({ phone });

    const stolen = await callerFor({
      userId: b.userId,
      institutionId: tenantB.institutionId,
    }).profile.startWhatsAppVerification({ phone });
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) expect(stolen.code).toBe("NUMBER_IN_USE");

    const bCheck = await callerFor({
      userId: b.userId,
      institutionId: tenantB.institutionId,
    }).profile.checkWhatsAppVerification({ code: "123456" });
    expect(bCheck.ok).toBe(false);
    expect((await channelRow(a.userId))?.verifiedAt).toBeNull();
    expect(await channelRow(b.userId)).toBeUndefined();
  });

  it("PENDING, deletado, sem vínculo e membership inativo permanecem inelegíveis", async () => {
    const pending = await createUser({
      label: "pending",
      institutionId: tenantA.institutionId,
      approvalStatus: "PENDING",
      withMembership: false,
    });
    await expect(
      callerFor({
        userId: pending.userId,
        institutionId: tenantA.institutionId,
        approvalStatus: "PENDING",
      }).profile.startWhatsAppVerification({ phone: nextPhone() }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const deleted = await createUser({
      label: "deleted",
      institutionId: tenantA.institutionId,
    });
    await db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(eq(users.id, deleted.userId));
    await expect(
      startWhatsAppVerification({
        userId: deleted.userId,
        institutionId: tenantA.institutionId,
        phone: nextPhone(),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const orphan = await createUser({
      label: "orphan",
      institutionId: tenantA.institutionId,
      withMembership: false,
    });
    await expect(
      callerFor({
        userId: orphan.userId,
        institutionId: null,
        tenantResolutionError: "NO_ACTIVE_MEMBERSHIP",
      }).profile.startWhatsAppVerification({ phone: nextPhone() }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      callerFor({
        userId: orphan.userId,
        institutionId: null,
      }).profile.getWhatsAppContact(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const inactive = await createUser({
      label: "inactive",
      institutionId: tenantA.institutionId,
    });
    await db
      .update(professionalInstitutions)
      .set({ active: false })
      .where(eq(professionalInstitutions.userId, inactive.userId));
    await expect(
      callerFor({
        userId: inactive.userId,
        institutionId: null,
      }).profile.startWhatsAppVerification({ phone: nextPhone() }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
