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
const service = readFileSync(
  new URL("../server/whatsapp-verification.ts", import.meta.url),
  "utf8",
);
const provider = readFileSync(
  new URL("../server/whatsapp-verification-provider.ts", import.meta.url),
  "utf8",
);
const twilioAdapter = readFileSync(
  new URL(
    "../server/integrations/whatsapp/twilio-verify-provider.ts",
    import.meta.url,
  ),
  "utf8",
);
const env = readFileSync(
  new URL("../server/_core/env.ts", import.meta.url),
  "utf8",
);
const driver = readFileSync(
  new URL(
    "../server/integrations/whatsapp/ready-for-nl-driver.ts",
    import.meta.url,
  ),
  "utf8",
);
const inbound = readFileSync(
  new URL("../server/routes/twilio-whatsapp.ts", import.meta.url),
  "utf8",
);
const profileScreen = readFileSync(
  new URL("../app/(tabs)/profile.tsx", import.meta.url),
  "utf8",
);
const contactScreen = readFileSync(
  new URL("../app/whatsapp-contact.tsx", import.meta.url),
  "utf8",
);

describe("WhatsApp Verify — source contracts", () => {
  it("profile não aceita verifiedAt/verified do cliente", () => {
    expect(router).toContain("startWhatsAppVerification");
    expect(router).toContain("checkWhatsAppVerification");
    expect(router).not.toMatch(/verifiedAt\s*:/);
    expect(router).not.toMatch(/verified\s*:\s*z\./);
    expect(router).not.toContain("markWhatsAppContactVerified");
    expect(router).toContain("ctx.user.id");
  });

  it("check usa só code — sem telefone no input", () => {
    const marker = "checkWhatsAppVerification: protectedProcedure";
    expect(router).toContain(marker);
    const checkBlock = router.slice(router.indexOf(marker));
    const inputBlock = checkBlock.slice(
      checkBlock.indexOf(".input("),
      checkBlock.indexOf(".mutation("),
    );
    expect(inputBlock).toContain("code:");
    expect(inputBlock).not.toMatch(/phone:/);
  });

  it("único writer positivo de verifiedAt é markWhatsAppContactVerified", () => {
    expect(domain).toContain("export async function markWhatsAppContactVerified");
    expect(service).toContain("markWhatsAppContactVerified");
    expect(service).toContain("expectedE164: channel.e164");
    expect(router).not.toMatch(/verifiedAt\s*:/);
    expect(router).not.toContain("markWhatsAppContactVerified");
    expect(schema).toContain("verifiedAt");
  });

  it("adapter Twilio usa channel whatsapp e SID por env", () => {
    expect(twilioAdapter).toContain('TWILIO_VERIFY_CHANNEL = "whatsapp"');
    expect(twilioAdapter).toContain("TWILIO_ACCOUNT_SID");
    expect(twilioAdapter).toContain("TWILIO_AUTH_TOKEN");
    expect(twilioAdapter).toContain("TWILIO_VERIFY_SERVICE_SID");
    expect(twilioAdapter).toContain("channel: TWILIO_VERIFY_CHANNEL");
    expect(provider).toContain("isTwilioVerifyApprovedStatus");
    expect(provider).toContain('status === "approved"');
  });

  it("OTP não é logado; secrets não são logados", () => {
    expect(service).not.toMatch(/logSafe\([\s\S]{0,200}input\.code/);
    expect(service).not.toMatch(/logger\.[a-z]+\([^)]*code[^)]*OTP/i);
    expect(twilioAdapter).not.toMatch(/logger\.(info|warn|error)/);
    expect(service).not.toMatch(/TWILIO_AUTH_TOKEN|TWILIO_ACCOUNT_SID|TWILIO_VERIFY_SERVICE_SID/);
    expect(twilioAdapter).not.toContain("JSON.stringify(error");
    expect(twilioAdapter).not.toMatch(/diagnostics:[\s\S]{0,80}message/);
  });

  it("diagnóstico Twilio é numérico e só no log server-side", () => {
    expect(twilioAdapter).toContain("extractSafeTwilioVerifyDiagnostics");
    expect(twilioAdapter).toContain("Number.isFinite");
    expect(service).toContain("providerHttpStatus");
    expect(service).toContain("providerErrorCode");
    const failFn = service.slice(
      service.indexOf("function fail("),
      service.indexOf("function clientIp"),
    );
    expect(failFn).not.toContain("providerHttpStatus");
    expect(failFn).not.toContain("providerErrorCode");
    expect(failFn).not.toContain("diagnostics");
    expect(service).toContain("return fail(started.kind, started.code)");
    expect(service).toContain("return fail(checked.kind, checked.code)");
  });

  it("Verify não liga o driver nem chama createSwapOffer", () => {
    expect(service).not.toMatch(/startWhatsAppNlDriver|WHATSAPP_NL_DRIVER_ENABLED/);
    expect(service).not.toMatch(/createSwapOffer/);
    expect(twilioAdapter).not.toMatch(/createSwapOffer|startWhatsAppNlDriver/);
    expect(env).toContain(
      'getEnvOrDefault("WHATSAPP_NL_DRIVER_ENABLED", "false") === "true"',
    );
    expect(driver).toContain("if (!isWhatsAppNlDriverEnabled()) return");
  });

  it("domínio não persiste OTP local", () => {
    expect(domain).not.toMatch(/codeHash|otpCode|whatsapp_channel_verifications/);
    expect(service).not.toMatch(/whatsapp_channel_verifications/);
  });

  it("hook de provider só existe no ramo de teste", () => {
    expect(service).toContain('process.env.NODE_ENV === "test"');
    expect(service).toContain("whatsappVerificationRuntime.provider");
  });

  it("68008/60428 são canal Verify não configurado, sem fallback SMS", () => {
    expect(twilioAdapter).toContain("twilioCode === 68008 || twilioCode === 60428");
    expect(twilioAdapter).toContain("PROVIDER_CHANNEL_NOT_CONFIGURED");
    expect(provider).toContain("PROVIDER_CHANNEL_NOT_CONFIGURED");
    expect(service).toContain("PROVIDER_CHANNEL_NOT_CONFIGURED");
    expect(twilioAdapter).not.toMatch(/channel:\s*["']sms["']/);
    expect(twilioAdapter).toContain('TWILIO_VERIFY_CHANNEL = "whatsapp"');
  });

  it("inbound Twilio permanece com validação de assinatura e fora do Verify", () => {
    expect(inbound).toContain('req.headers["x-twilio-signature"]');
    expect(inbound).toContain("validateInboundRequest");
    expect(inbound).not.toContain("startWhatsAppVerification");
    expect(inbound).not.toContain("checkWhatsAppVerification");
    expect(inbound).not.toContain("TwilioWhatsAppVerificationProvider");
    expect(inbound).not.toContain("markWhatsAppContactVerified");
  });

  it("linha de WhatsApp no perfil não depende de gestor", () => {
    const contaStart = profileScreen.indexOf('title="Conta e app"');
    const contaEnd = profileScreen.indexOf("Sair da conta", contaStart);
    const conta = profileScreen.slice(contaStart, contaEnd);
    expect(conta).toContain('title="WhatsApp"');
    expect(conta).toContain('go("/whatsapp-contact")');
    expect(conta).toContain("Cadastrar e verificar o número da conta");
    expect(conta).not.toMatch(/\bisManager\b/);
    expect(conta).not.toMatch(/\bcan\(/);
    expect(contactScreen).toContain("trpc.profile.startWhatsAppVerification");
    expect(contactScreen).toContain("trpc.profile.checkWhatsAppVerification");
    expect(contactScreen).not.toMatch(/\bisManager\b/);
    expect(contactScreen).not.toContain("createSwapOffer");
  });
});
