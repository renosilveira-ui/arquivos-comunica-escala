import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const schema = readFileSync(
  new URL("../drizzle/schema.ts", import.meta.url),
  "utf8",
);
const domain = readFileSync(
  new URL("../server/user-contact-channels.ts", import.meta.url),
  "utf8",
);
const router = readFileSync(
  new URL("../server/profile-router.ts", import.meta.url),
  "utf8",
);
const verify = readFileSync(
  new URL("../server/whatsapp-verification-provider.ts", import.meta.url),
  "utf8",
);

describe("WhatsApp contact identity — source contracts", () => {
  it("schema declara userContactChannels multi-canal com verifiedAt", () => {
    expect(schema).toContain("userContactChannels");
    expect(schema).toContain("normalizedAddress");
    expect(schema).toContain("verifiedAt");
    expect(schema).toContain("activeNormalizedAddress");
    expect(schema).toContain("WHATSAPP");
  });

  it("profile router não aceita verifiedAt do cliente", () => {
    expect(router).toContain("getWhatsAppContact");
    expect(router).toContain("setWhatsAppContact");
    expect(router).toContain("deactivateWhatsAppContact");
    expect(router).not.toMatch(/verifiedAt\s*:/);
    expect(router).toContain("ctx.user.id");
  });

  it("markWhatsAppContactVerified existe só no domínio", () => {
    expect(domain).toContain("export async function markWhatsAppContactVerified");
    expect(router).not.toContain("markWhatsAppContactVerified");
  });

  it("Twilio Verify é contrato sem adapter real", () => {
    expect(verify).toContain("WhatsAppVerificationProvider");
    expect(verify).toContain("UnimplementedWhatsAppVerificationProvider");
    expect(verify).not.toMatch(/twilio\.com|require\(["']twilio["']\)/i);
  });

  it("domínio não armazena OTP próprio", () => {
    expect(domain).not.toMatch(/codeHash|otpCode|whatsapp_channel_verifications/);
  });
});
