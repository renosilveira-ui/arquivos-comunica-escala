import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  institutions,
  userContactChannels,
  users,
  whatsappInboundMessages,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { logger } from "../server/_core/logger";
import { processWhatsAppInbound } from "../server/integrations/whatsapp/inbound-store";
import {
  markWhatsAppContactVerified,
  upsertUserWhatsAppContact,
} from "../server/user-contact-channels";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

describe("WhatsApp inbound privacy", () => {
  let db: Db;
  let institutionId: number;
  let userId: number;
  const stamp = Date.now();
  const e164 = "+5585999200001";
  const sid = `SMpriv${stamp}`;
  const secretBody = "trocar meu plantão de hoje com a Débora";

  beforeAll(async () => {
    const maybe = await getDb();
    if (!maybe) throw new Error("DB unavailable");
    db = maybe;
    const [institution] = await db.select().from(institutions).limit(1);
    if (!institution) throw new Error("seed institution missing");
    institutionId = institution.id;
    const name = `wa-priv-${stamp}`;
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
    userId = user.id;
    await upsertUserWhatsAppContact({ userId, rawPhone: e164, institutionId });
    await markWhatsAppContactVerified({ userId, expectedE164: e164 });
  });

  afterAll(async () => {
    await db
      .delete(whatsappInboundMessages)
      .where(eq(whatsappInboundMessages.providerMessageId, sid));
    await db
      .delete(userContactChannels)
      .where(eq(userContactChannels.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
  });

  it("log e DB não guardam telefone, Body nem signature", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(logger, "info").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(" "));
      return logger;
    });
    await processWhatsAppInbound({
      provider: "TWILIO",
      providerMessageId: sid,
      fromE164: e164,
      content: { kind: "TEXT", text: secretBody, forwarded: false },
      receivedAt: new Date(),
    });
    spy.mockRestore();

    const joined = lines.join("\n");
    expect(joined).not.toContain(e164);
    expect(joined).not.toContain("5585999200001");
    expect(joined).not.toContain(secretBody);
    expect(joined).not.toMatch(/X-Twilio-Signature|TWILIO_AUTH_TOKEN/i);

    const [row] = await db
      .select()
      .from(whatsappInboundMessages)
      .where(eq(whatsappInboundMessages.providerMessageId, sid));
    expect(row).toBeTruthy();
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(e164);
    expect(serialized).not.toContain(secretBody);
    expect(serialized).not.toMatch(/signature/i);
    expect(row?.senderAddressHash).toMatch(/^[a-f0-9]{16}$/);
    expect(Object.keys(row ?? {})).not.toContain("body");
    expect(Object.keys(row ?? {})).not.toContain("fromE164");
  });
});
