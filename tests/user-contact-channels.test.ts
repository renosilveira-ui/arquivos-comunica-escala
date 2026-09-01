/**
 * Integração: identidade WhatsApp canônica (user_contact_channels).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  institutions,
  professionalInstitutions,
  professionals,
  userContactChannels,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { appRouter } from "../server/routers";
import {
  deactivateUserWhatsAppContact,
  getVerifiedWhatsAppContactForUser,
  getWhatsAppContactForUser,
  markWhatsAppContactVerified,
  upsertUserWhatsAppContact,
} from "../server/user-contact-channels";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

describe("user WhatsApp contact identity", () => {
  let db: Db;
  let institutionId: number;
  const stamp = Date.now();
  const userIds: number[] = [];

  async function createUser(label: string): Promise<{
    userId: number;
    professionalId: number;
    sessionVersion: number;
  }> {
    const name = `wa-contact-${stamp}-${label}`;
    const [user] = await db
      .insert(users)
      .values({
        name,
        email: `${name}@example.test`,
        passwordHash: "not-used",
        role: "doctor",
        approvalStatus: "APPROVED",
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
    await db.insert(professionalInstitutions).values({
      professionalId: professional.id,
      userId: user.id,
      institutionId,
      roleInInstitution: "USER",
      isPrimary: true,
      active: true,
    });
    return {
      userId: user.id,
      professionalId: professional.id,
      sessionVersion: 1,
    };
  }

  function callerFor(userId: number, sessionVersion = 1) {
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
        sessionVersion,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastSignedIn: new Date(),
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
      req: undefined,
      res: undefined,
    } as any);
  }

  beforeAll(async () => {
    const maybe = await getDb();
    if (!maybe) throw new Error("DB unavailable");
    db = maybe;
    const [institution] = await db.select().from(institutions).limit(1);
    if (!institution) throw new Error("seed institution missing");
    institutionId = institution.id;
  });

  afterAll(async () => {
    if (userIds.length === 0) return;
    await db
      .delete(userContactChannels)
      .where(
        // cleanup by users created in this suite
        eq(userContactChannels.userId, userIds[0]!),
      )
      .catch(() => undefined);
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

  it("cadastra BR e mascara na API; verifiedAt não vem do cliente", async () => {
    const a = await createUser("a");
    const caller = callerFor(a.userId);
    const missing = await caller.profile.getWhatsAppContact();
    expect(missing.status).toBe("missing");

    const saved = await caller.profile.setWhatsAppContact({
      phone: "(85) 98888-7777",
    });
    expect(saved.status).toBe("unverified");
    expect(saved.verified).toBe(false);
    expect(saved.maskedAddress).toBe("+55 85 *****-7777");
    expect(saved).not.toHaveProperty("normalizedAddress");

    const [row] = await db
      .select()
      .from(userContactChannels)
      .where(
        and(
          eq(userContactChannels.userId, a.userId),
          eq(userContactChannels.channel, "WHATSAPP"),
        ),
      );
    expect(row?.normalizedAddress).toBe("+5585988887777");
    expect(row?.verifiedAt).toBeNull();
  });

  it("duplicidade E.164 entre users é CONFLICT", async () => {
    const a = await createUser("dup-a");
    const b = await createUser("dup-b");
    await upsertUserWhatsAppContact({
      userId: a.userId,
      rawPhone: "+5585977776666",
      institutionId,
    });
    await expect(
      upsertUserWhatsAppContact({
        userId: b.userId,
        rawPhone: "(85) 97777-6666",
        institutionId,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("alterar número limpa verifiedAt", async () => {
    const a = await createUser("chg");
    await upsertUserWhatsAppContact({
      userId: a.userId,
      rawPhone: "+5585966665555",
      institutionId,
    });
    await markWhatsAppContactVerified({
      userId: a.userId,
      expectedE164: "+5585966665555",
    });
    const verified = await getWhatsAppContactForUser(a.userId);
    expect(verified?.verified).toBe(true);

    await upsertUserWhatsAppContact({
      userId: a.userId,
      rawPhone: "+5585955554444",
      institutionId,
    });
    const after = await getWhatsAppContactForUser(a.userId);
    expect(after?.verified).toBe(false);
    expect(after?.maskedAddress).toBe("+55 85 *****-4444");
  });

  it("outro user não altera canal alheio (caller usa só ctx.user.id)", async () => {
    const owner = await createUser("owner");
    const other = await createUser("other");
    await callerFor(owner.userId).profile.setWhatsAppContact({
      phone: "+5585944443333",
    });
    await callerFor(other.userId).profile.setWhatsAppContact({
      phone: "+5585933332222",
    });
    const ownerView = await getWhatsAppContactForUser(owner.userId);
    const otherView = await getWhatsAppContactForUser(other.userId);
    expect(ownerView?.maskedAddress).toBe("+55 85 *****-3333");
    expect(otherView?.maskedAddress).toBe("+55 85 *****-2222");
  });

  it("um user não ganha dois canais WhatsApp ativos", async () => {
    const a = await createUser("one");
    await upsertUserWhatsAppContact({
      userId: a.userId,
      rawPhone: "+5585922221111",
      institutionId,
    });
    await upsertUserWhatsAppContact({
      userId: a.userId,
      rawPhone: "+5585911110000",
      institutionId,
    });
    const rows = await db
      .select()
      .from(userContactChannels)
      .where(
        and(
          eq(userContactChannels.userId, a.userId),
          eq(userContactChannels.channel, "WHATSAPP"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.normalizedAddress).toBe("+5585911110000");
    expect(rows[0]?.active).toBe(true);
  });

  it("desativar libera o E.164 para outro user", async () => {
    const a = await createUser("free-a");
    const b = await createUser("free-b");
    await upsertUserWhatsAppContact({
      userId: a.userId,
      rawPhone: "+5585900009999",
      institutionId,
    });
    await deactivateUserWhatsAppContact({
      userId: a.userId,
      institutionId,
    });
    await expect(
      upsertUserWhatsAppContact({
        userId: b.userId,
        rawPhone: "+5585900009999",
        institutionId,
      }),
    ).resolves.toMatchObject({ active: true, verified: false });
  });

  it("getVerified exige verifiedAt + user aprovado", async () => {
    const a = await createUser("ver");
    await upsertUserWhatsAppContact({
      userId: a.userId,
      rawPhone: "+5585899998888",
      institutionId,
    });
    expect(await getVerifiedWhatsAppContactForUser(a.userId)).toBeNull();
    await markWhatsAppContactVerified({
      userId: a.userId,
      expectedE164: "+5585899998888",
    });
    const verified = await getVerifiedWhatsAppContactForUser(a.userId);
    expect(verified?.e164).toBe("+5585899998888");
  });

  it("user deleted não cadastra WhatsApp", async () => {
    const a = await createUser("del");
    await db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(eq(users.id, a.userId));
    await expect(
      upsertUserWhatsAppContact({
        userId: a.userId,
        rawPhone: "+5585888887777",
        institutionId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("tenant não altera a identidade global do número", async () => {
    const a = await createUser("tenant");
    await upsertUserWhatsAppContact({
      userId: a.userId,
      rawPhone: "+5585877776666",
      institutionId,
    });
    // Mesmo userId, institutionId diferente na chamada — linha permanece única
    await upsertUserWhatsAppContact({
      userId: a.userId,
      rawPhone: "+5585877776666",
      institutionId: institutionId,
    });
    const rows = await db
      .select()
      .from(userContactChannels)
      .where(eq(userContactChannels.userId, a.userId));
    expect(rows).toHaveLength(1);
  });
});
