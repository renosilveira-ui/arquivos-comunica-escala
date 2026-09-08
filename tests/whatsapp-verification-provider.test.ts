import { describe, expect, it } from "vitest";
import {
  classifyTwilioVerifyCheckStatus,
  isTwilioVerifyApprovedStatus,
  UnimplementedWhatsAppVerificationProvider,
} from "../server/whatsapp-verification-provider";
import {
  extractSafeTwilioVerifyDiagnostics,
  mapTwilioVerifyError,
  readTwilioVerifyConfig,
  TwilioWhatsAppVerificationProvider,
  TWILIO_VERIFY_CHANNEL,
  type TwilioVerifyClient,
} from "../server/integrations/whatsapp/twilio-verify-provider";

describe("Twilio Verify provider contract", () => {
  it("somente status approved conta como verificado", () => {
    expect(isTwilioVerifyApprovedStatus("approved")).toBe(true);
    expect(isTwilioVerifyApprovedStatus("pending")).toBe(false);
    expect(isTwilioVerifyApprovedStatus("expired")).toBe(false);
    expect(isTwilioVerifyApprovedStatus("APPROVED")).toBe(false);
    expect(isTwilioVerifyApprovedStatus(true)).toBe(false);
    expect(classifyTwilioVerifyCheckStatus("pending")).toEqual({
      ok: true,
      approved: false,
      status: "pending",
    });
    expect(classifyTwilioVerifyCheckStatus("approved")).toEqual({
      ok: true,
      approved: true,
    });
  });

  it("config ausente é null — fail-closed", () => {
    expect(
      readTwilioVerifyConfig({
        TWILIO_ACCOUNT_SID: "ACxxx",
        TWILIO_AUTH_TOKEN: "token",
      }),
    ).toBeNull();
    expect(
      readTwilioVerifyConfig({
        TWILIO_ACCOUNT_SID: "ACxxx",
        TWILIO_AUTH_TOKEN: "token",
        TWILIO_VERIFY_SERVICE_SID: "VAxxx",
      }),
    ).toEqual({
      accountSid: "ACxxx",
      authToken: "token",
      serviceSid: "VAxxx",
    });
  });

  it("Unimplemented não marca sucesso", async () => {
    const provider = new UnimplementedWhatsAppVerificationProvider();
    const start = await provider.startVerification("+5585999990000");
    const check = await provider.checkVerification("+5585999990000", "123456");
    expect(start).toMatchObject({
      ok: false,
      code: "VERIFY_NOT_CONFIGURED",
    });
    expect(check).toMatchObject({
      ok: false,
      code: "VERIFY_NOT_CONFIGURED",
    });
  });

  it("start usa channel=whatsapp e o mesmo E.164 no check", async () => {
    const creates: unknown[] = [];
    const checks: unknown[] = [];
    const client: TwilioVerifyClient = {
      verify: {
        v2: {
          services: (sid) => {
            expect(sid).toBe("VAtest");
            return {
              verifications: {
                create: async (input) => {
                  creates.push(input);
                  return { status: "pending" };
                },
              },
              verificationChecks: {
                create: async (input) => {
                  checks.push(input);
                  return { status: "approved" };
                },
              },
            };
          },
        },
      },
    };
    const provider = new TwilioWhatsAppVerificationProvider({
      config: {
        accountSid: "ACtest",
        authToken: "token",
        serviceSid: "VAtest",
      },
      client,
    });
    const started = await provider.startVerification("+5585999990001");
    const checked = await provider.checkVerification(
      "+5585999990001",
      "123456",
    );
    expect(started).toEqual({ ok: true, status: "pending" });
    expect(checked).toEqual({ ok: true, approved: true });
    expect(creates).toEqual([
      { to: "+5585999990001", channel: TWILIO_VERIFY_CHANNEL },
    ]);
    expect(checks).toEqual([{ to: "+5585999990001", code: "123456" }]);
    expect(TWILIO_VERIFY_CHANNEL).toBe("whatsapp");
  });

  it("HTTP 2xx pending no check NÃO aprova", async () => {
    const client: TwilioVerifyClient = {
      verify: {
        v2: {
          services: () => ({
            verifications: {
              create: async () => ({ status: "pending" }),
            },
            verificationChecks: {
              create: async () => ({ status: "pending" }),
            },
          }),
        },
      },
    };
    const provider = new TwilioWhatsAppVerificationProvider({
      config: {
        accountSid: "ACtest",
        authToken: "token",
        serviceSid: "VAtest",
      },
      client,
    });
    const checked = await provider.checkVerification(
      "+5585999990002",
      "123456",
    );
    expect(checked).toEqual({
      ok: true,
      approved: false,
      status: "pending",
    });
  });

  it("mapeia erros Twilio sem vazar internals", () => {
    expect(mapTwilioVerifyError({ status: 401, code: 20003 })).toEqual({
      kind: "SERVER_CONFIGURATION_ERROR",
      code: "PROVIDER_AUTH_FAILURE",
      diagnostics: { providerHttpStatus: 401, providerErrorCode: 20003 },
    });
    expect(mapTwilioVerifyError({ status: 404, code: 20404 })).toEqual({
      kind: "USER_ERROR",
      code: "EXPIRED",
      diagnostics: { providerHttpStatus: 404, providerErrorCode: 20404 },
    });
    expect(mapTwilioVerifyError({ status: 429, code: 60003 })).toEqual({
      kind: "USER_ERROR",
      code: "RATE_LIMITED",
      diagnostics: { providerHttpStatus: 429, providerErrorCode: 60003 },
    });
    expect(mapTwilioVerifyError({ status: 500 })).toEqual({
      kind: "RETRYABLE_PROVIDER_ERROR",
      code: "TWILIO_UNAVAILABLE",
      diagnostics: { providerHttpStatus: 500 },
    });
    expect(mapTwilioVerifyError({ code: 60202 })).toEqual({
      kind: "USER_ERROR",
      code: "TOO_MANY_ATTEMPTS",
      diagnostics: { providerErrorCode: 60202 },
    });
    expect(mapTwilioVerifyError({ code: 60203 })).toEqual({
      kind: "USER_ERROR",
      code: "TOO_MANY_SENDS",
      diagnostics: { providerErrorCode: 60203 },
    });
    expect(mapTwilioVerifyError({ code: 60200 })).toEqual({
      kind: "USER_ERROR",
      code: "INVALID_PHONE",
      diagnostics: { providerErrorCode: 60200 },
    });
  });

  it("D1 400/68008 preserva diagnóstico e classifica como TWILIO_UNAVAILABLE", () => {
    const mapped = mapTwilioVerifyError({
      status: 400,
      code: 68008,
      message: "sensitive OTP 123456",
    });
    expect(mapped.kind).toBe("RETRYABLE_PROVIDER_ERROR");
    expect(mapped.code).toBe("TWILIO_UNAVAILABLE");
    expect(mapped.diagnostics).toEqual({
      providerHttpStatus: 400,
      providerErrorCode: 68008,
    });
    expect(JSON.stringify(mapped)).not.toContain("123456");
    expect(JSON.stringify(mapped)).not.toContain("sensitive");
  });

  it("D2 401/20003 permanece PROVIDER_AUTH_FAILURE com diagnóstico", () => {
    const mapped = mapTwilioVerifyError({ status: 401, code: 20003 });
    expect(mapped).toEqual({
      kind: "SERVER_CONFIGURATION_ERROR",
      code: "PROVIDER_AUTH_FAILURE",
      diagnostics: { providerHttpStatus: 401, providerErrorCode: 20003 },
    });
  });

  it("D3 503 preserva diagnóstico e permanece TWILIO_UNAVAILABLE", () => {
    const mapped = mapTwilioVerifyError({ status: 503, code: 20500 });
    expect(mapped).toEqual({
      kind: "RETRYABLE_PROVIDER_ERROR",
      code: "TWILIO_UNAVAILABLE",
      diagnostics: { providerHttpStatus: 503, providerErrorCode: 20500 },
    });
  });

  it("D4 strings não são diagnóstico numérico", () => {
    expect(
      extractSafeTwilioVerifyDiagnostics({ status: "400", code: "68008" }),
    ).toBeUndefined();
    const mapped = mapTwilioVerifyError({ status: "400", code: "68008" });
    expect(mapped.kind).toBe("RETRYABLE_PROVIDER_ERROR");
    expect(mapped.code).toBe("TWILIO_UNAVAILABLE");
    expect(mapped.diagnostics).toBeUndefined();
  });

  it("D4 NaN/Infinity não são diagnóstico", () => {
    expect(
      extractSafeTwilioVerifyDiagnostics({ status: Number.NaN, code: Number.POSITIVE_INFINITY }),
    ).toBeUndefined();
  });

  it("D5 adapter não devolve message/OTP/E.164/SID no resultado", async () => {
    const poison = {
      status: 400,
      code: 68008,
      message:
        "OTP 123456 for +5585988810099 token SKleak VA111 MG222 AC_FAKE_ACCOUNT",
      moreInfo: "https://verify.twilio.com/v2/Services/VAsecret",
    };
    const client: TwilioVerifyClient = {
      verify: {
        v2: {
          services: () => ({
            verifications: {
              create: async () => {
                throw poison;
              },
            },
            verificationChecks: {
              create: async () => {
                throw poison;
              },
            },
          }),
        },
      },
    };
    const provider = new TwilioWhatsAppVerificationProvider({
      config: {
        accountSid: "ACtest",
        authToken: "token",
        serviceSid: "VAtest",
      },
      client,
    });
    const started = await provider.startVerification("+5585988810099");
    const checked = await provider.checkVerification("+5585988810099", "123456");
    expect(started).toEqual({
      ok: false,
      kind: "RETRYABLE_PROVIDER_ERROR",
      code: "TWILIO_UNAVAILABLE",
      diagnostics: { providerHttpStatus: 400, providerErrorCode: 68008 },
    });
    expect(checked).toEqual(started);
    const dumped = JSON.stringify({ started, checked, poisonIgnored: true });
    expect(dumped).not.toContain("123456");
    expect(dumped).not.toContain("+5585988810099");
    expect(dumped).not.toContain("SKleak");
    expect(dumped).not.toContain("VAsecret");
    expect(dumped).not.toContain("MG222");
    expect(dumped).not.toContain("AC_FAKE_ACCOUNT");
  });
});
