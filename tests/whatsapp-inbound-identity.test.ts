import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  institutions,
  userContactChannels,
  users,
  whatsappInboundMessages,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { processWhatsAppInbound } from "../server/integrations/whatsapp/inbound-store";
import {
  decideVerifiedWhatsAppIdentity,
  resolveVerifiedWhatsAppUser,
} from "../server/integrations/whatsapp/resolve-identity";
import {
  markWhatsAppContactVerified,
  upsertUserWhatsAppContact,
} from "../server/user-contact-channels";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

describe("WhatsApp inbound identity", () => {
  let db: Db;
  let institutionId: number;
  const stamp = Date.now();
  const userIds: number[] = [];

  async function createUser(
    label: string,
    approval: "APPROVED" | "PENDING" = "APPROVED",
  ): Promise<number> {
    const name = `wa-inb-${stamp}-${label}`;
    const [user] = await db
      .insert(users)
      .values({
        name,
        email: `${name}@example.test`,
        passwordHash: "not-used",
        role: "doctor",
        approvalStatus: approval,
        sessionVersion: 1,
      })
      .$returningId();
    userIds.push(user.id);
    return user.id;
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
    await db
      .delete(whatsappInboundMessages)
      .where(
        inArray(whatsappInboundMessages.providerMessageId, [
          `SMunk-text-${stamp}`,
          `SMunk-audio-${stamp}`,
          `SMaudio${stamp}`,
          `SMimg${stamp}`,
        ]),
      );
    if (userIds.length > 0) {
      await db
        .delete(whatsappInboundMessages)
        .where(inArray(whatsappInboundMessages.userId, userIds));
    }
    for (const id of userIds) {
      await db
        .delete(userContactChannels)
        .where(eq(userContactChannels.userId, id));
      await db.delete(users).where(eq(users.id, id));
    }
  });

  it("E.164 verificado resolve o usuário", async () => {
    const userId = await createUser("ok");
    const e164 = "+5585999000001";
    await upsertUserWhatsAppContact({
      userId,
      rawPhone: e164,
      institutionId,
    });
    await markWhatsAppContactVerified({ userId, expectedE164: e164 });
    await expect(resolveVerifiedWhatsAppUser(e164)).resolves.toEqual({
      ok: true,
      userId,
    });
  });

  it("número não cadastrado falha fechado sem distinguir existência", async () => {
    await expect(
      resolveVerifiedWhatsAppUser("+5585999000099"),
    ).resolves.toEqual({ ok: false, code: "IDENTITY_NOT_FOUND" });
  });

  it("texto ou áudio sem identidade nunca avançam para NL/transcrição", async () => {
    const unknown = "+5585999000088";
    const text = await processWhatsAppInbound({
      provider: "TWILIO",
      providerMessageId: `SMunk-text-${stamp}`,
      fromE164: unknown,
      content: { kind: "TEXT", text: "trocar", forwarded: false },
      receivedAt: new Date(),
    });
    const audio = await processWhatsAppInbound({
      provider: "TWILIO",
      providerMessageId: `SMunk-audio-${stamp}`,
      fromE164: unknown,
      content: {
        kind: "AUDIO",
        mediaUrl: "https://api.twilio.com/media/secret",
        mimeType: "audio/ogg",
      },
      receivedAt: new Date(),
    });
    expect(text).toMatchObject({
      status: "IDENTITY_NOT_FOUND",
      userId: null,
    });
    expect(audio).toMatchObject({
      status: "IDENTITY_NOT_FOUND",
      userId: null,
    });
    const [textRow] = await db
      .select()
      .from(whatsappInboundMessages)
      .where(eq(whatsappInboundMessages.providerMessageId, `SMunk-text-${stamp}`));
    const [audioRow] = await db
      .select()
      .from(whatsappInboundMessages)
      .where(eq(whatsappInboundMessages.providerMessageId, `SMunk-audio-${stamp}`));
    expect(textRow?.operationalText).toBeNull();
    expect(textRow?.payloadClearedAt).toBeTruthy();
    expect(audioRow?.mediaUrl).toBeNull();
    expect(audioRow?.payloadClearedAt).toBeTruthy();
  });

  it("cadastrado e não verificado falha fechado", async () => {
    const userId = await createUser("unverified");
    const e164 = "+5585999000002";
    await upsertUserWhatsAppContact({
      userId,
      rawPhone: e164,
      institutionId,
    });
    await expect(resolveVerifiedWhatsAppUser(e164)).resolves.toEqual({
      ok: false,
      code: "IDENTITY_NOT_FOUND",
    });
  });

  it("canal inativo falha fechado", async () => {
    const userId = await createUser("inactive");
    const e164 = "+5585999000003";
    await upsertUserWhatsAppContact({
      userId,
      rawPhone: e164,
      institutionId,
    });
    await markWhatsAppContactVerified({ userId, expectedE164: e164 });
    await db
      .update(userContactChannels)
      .set({ active: false })
      .where(eq(userContactChannels.userId, userId));
    await expect(resolveVerifiedWhatsAppUser(e164)).resolves.toEqual({
      ok: false,
      code: "IDENTITY_NOT_FOUND",
    });
  });

  it("usuário deletado falha fechado", async () => {
    const userId = await createUser("deleted");
    const e164 = "+5585999000004";
    await upsertUserWhatsAppContact({
      userId,
      rawPhone: e164,
      institutionId,
    });
    await markWhatsAppContactVerified({ userId, expectedE164: e164 });
    await db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(eq(users.id, userId));
    await expect(resolveVerifiedWhatsAppUser(e164)).resolves.toEqual({
      ok: false,
      code: "IDENTITY_NOT_FOUND",
    });
  });

  it("conta PENDING falha fechado", async () => {
    const userId = await createUser("pending", "PENDING");
    await db.insert(userContactChannels).values({
      userId,
      channel: "WHATSAPP",
      address: "+5585999000005",
      normalizedAddress: "+5585999000005",
      active: true,
      verifiedAt: new Date(),
    });
    await expect(
      resolveVerifiedWhatsAppUser("+5585999000005"),
    ).resolves.toEqual({ ok: false, code: "IDENTITY_NOT_FOUND" });
  });

  it("áudio identificado termina READY_FOR_TRANSCRIPTION sem baixar mídia", async () => {
    const userId = await createUser("audio");
    const e164 = "+5585999000006";
    await upsertUserWhatsAppContact({ userId, rawPhone: e164, institutionId });
    await markWhatsAppContactVerified({ userId, expectedE164: e164 });
    const result = await processWhatsAppInbound({
      provider: "TWILIO",
      providerMessageId: `SMaudio${stamp}`,
      fromE164: e164,
      content: {
        kind: "AUDIO",
        mediaUrl: "https://api.twilio.com/media/secret",
        mimeType: "audio/ogg",
      },
      receivedAt: new Date(),
    });
    expect(result).toMatchObject({
      status: "READY_FOR_TRANSCRIPTION",
      userId,
    });
    const [row] = await db
      .select()
      .from(whatsappInboundMessages)
      .where(eq(whatsappInboundMessages.providerMessageId, `SMaudio${stamp}`));
    expect(row?.mediaUrl).toBe("https://api.twilio.com/media/secret");
    expect(row?.mediaMime).toBe("audio/ogg");
    expect(row?.operationalText).toBeNull();
    expect(row?.payloadExpiresAt).toBeTruthy();
    expect(row?.senderAddressHash).toBeNull();
  });

  it("mídia não suportada identificada termina UNSUPPORTED", async () => {
    const userId = await createUser("img");
    const e164 = "+5585999000007";
    await upsertUserWhatsAppContact({ userId, rawPhone: e164, institutionId });
    await markWhatsAppContactVerified({ userId, expectedE164: e164 });
    const result = await processWhatsAppInbound({
      provider: "TWILIO",
      providerMessageId: `SMimg${stamp}`,
      fromE164: e164,
      content: { kind: "UNSUPPORTED_MEDIA", mimeType: "application/pdf" },
      receivedAt: new Date(),
    });
    expect(result).toMatchObject({ status: "UNSUPPORTED", userId });
  });

  it("query exige channel=WHATSAPP (não resolve outro canal)", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL(
          "../server/integrations/whatsapp/resolve-identity.ts",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(src).toContain("WHATSAPP_CHANNEL");
    expect(src).toContain("eq(userContactChannels.channel, WHATSAPP_CHANNEL)");
  });

  it("empate impossível é CONFLICT, nunca o primeiro", () => {
    expect(
      decideVerifiedWhatsAppIdentity([{ userId: 1 }, { userId: 2 }]),
    ).toEqual({ ok: false, code: "IDENTITY_CONFLICT" });
    expect(decideVerifiedWhatsAppIdentity([])).toEqual({
      ok: false,
      code: "IDENTITY_NOT_FOUND",
    });
    expect(decideVerifiedWhatsAppIdentity([{ userId: 9 }])).toEqual({
      ok: true,
      userId: 9,
    });
  });
});
