import { describe, expect, it } from "vitest";
import {
  classifyTwilioVerifyCheckStatus,
  isTwilioVerifyApprovedStatus,
  UnimplementedWhatsAppVerificationProvider,
} from "../server/whatsapp-verification-provider";
import {
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
    });
    expect(mapTwilioVerifyError({ status: 404, code: 20404 })).toEqual({
      kind: "USER_ERROR",
      code: "EXPIRED",
    });
    expect(mapTwilioVerifyError({ status: 429, code: 60003 })).toEqual({
      kind: "USER_ERROR",
      code: "RATE_LIMITED",
    });
    expect(mapTwilioVerifyError({ status: 500 })).toEqual({
      kind: "RETRYABLE_PROVIDER_ERROR",
      code: "TWILIO_UNAVAILABLE",
    });
    expect(mapTwilioVerifyError({ code: 60202 })).toEqual({
      kind: "USER_ERROR",
      code: "TOO_MANY_ATTEMPTS",
    });
    expect(mapTwilioVerifyError({ code: 60203 })).toEqual({
      kind: "USER_ERROR",
      code: "TOO_MANY_SENDS",
    });
    expect(mapTwilioVerifyError({ code: 60200 })).toEqual({
      kind: "USER_ERROR",
      code: "INVALID_PHONE",
    });
  });
});
