/**
 * Adapter Twilio Verify (channel=whatsapp). Sem persistência, sem AuthZ.
 */
import twilio from "twilio";
import {
  classifyTwilioVerifyCheckStatus,
  type WhatsAppVerificationCheckResult,
  type WhatsAppVerificationFailureCode,
  type WhatsAppVerificationFailureKind,
  type WhatsAppVerificationProvider,
  type WhatsAppVerificationStartResult,
} from "../../whatsapp-verification-provider";

export const TWILIO_VERIFY_CHANNEL = "whatsapp" as const;

export type TwilioVerifyConfig = {
  accountSid: string;
  authToken: string;
  serviceSid: string;
};

type VerificationCreateInput = { to: string; channel: string };
type VerificationCheckCreateInput = { to: string; code: string };

export type TwilioVerifyClient = {
  verify: {
    v2: {
      services: (sid: string) => {
        verifications: {
          create: (
            input: VerificationCreateInput,
          ) => Promise<{ status?: unknown }>;
        };
        verificationChecks: {
          create: (
            input: VerificationCheckCreateInput,
          ) => Promise<{ status?: unknown }>;
        };
      };
    };
  };
};

type TwilioLikeError = {
  status?: unknown;
  code?: unknown;
  message?: unknown;
};

function asTwilioError(error: unknown): TwilioLikeError | null {
  if (typeof error !== "object" || error === null) return null;
  return error as TwilioLikeError;
}

export function mapTwilioVerifyError(
  error: unknown,
): {
  kind: WhatsAppVerificationFailureKind;
  code: WhatsAppVerificationFailureCode;
} {
  const rest = asTwilioError(error);
  const httpStatus =
    typeof rest?.status === "number" ? rest.status : undefined;
  const twilioCode = typeof rest?.code === "number" ? rest.code : undefined;

  if (httpStatus === 401 || httpStatus === 403 || twilioCode === 20003) {
    return { kind: "SERVER_CONFIGURATION_ERROR", code: "PROVIDER_AUTH_FAILURE" };
  }
  if (twilioCode === 20404 || httpStatus === 404) {
    return { kind: "USER_ERROR", code: "EXPIRED" };
  }
  if (twilioCode === 60202) {
    return { kind: "USER_ERROR", code: "TOO_MANY_ATTEMPTS" };
  }
  if (twilioCode === 60203) {
    return { kind: "USER_ERROR", code: "TOO_MANY_SENDS" };
  }
  if (twilioCode === 60200 || twilioCode === 60205) {
    return { kind: "USER_ERROR", code: "INVALID_PHONE" };
  }
  if (twilioCode === 60003 || httpStatus === 429) {
    return { kind: "USER_ERROR", code: "RATE_LIMITED" };
  }
  if (httpStatus !== undefined && httpStatus >= 500) {
    return { kind: "RETRYABLE_PROVIDER_ERROR", code: "TWILIO_UNAVAILABLE" };
  }
  return { kind: "RETRYABLE_PROVIDER_ERROR", code: "TWILIO_UNAVAILABLE" };
}

export function readTwilioVerifyConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): TwilioVerifyConfig | null {
  const accountSid = (env.TWILIO_ACCOUNT_SID ?? "").trim();
  const authToken = (env.TWILIO_AUTH_TOKEN ?? "").trim();
  const serviceSid = (env.TWILIO_VERIFY_SERVICE_SID ?? "").trim();
  if (!accountSid || !authToken || !serviceSid) return null;
  return { accountSid, authToken, serviceSid };
}

export class TwilioWhatsAppVerificationProvider
  implements WhatsAppVerificationProvider
{
  private readonly serviceSid: string;
  private readonly client: TwilioVerifyClient;

  constructor(input: {
    config: TwilioVerifyConfig;
    client?: TwilioVerifyClient;
  }) {
    this.serviceSid = input.config.serviceSid;
    this.client =
      input.client ??
      (twilio(
        input.config.accountSid,
        input.config.authToken,
      ) as unknown as TwilioVerifyClient);
  }

  async startVerification(
    e164: string,
  ): Promise<WhatsAppVerificationStartResult> {
    try {
      const verification = await this.client.verify.v2
        .services(this.serviceSid)
        .verifications.create({
          to: e164,
          channel: TWILIO_VERIFY_CHANNEL,
        });
      const status = verification.status;
      if (typeof status !== "string" || status.trim() === "") {
        return {
          ok: false,
          kind: "RETRYABLE_PROVIDER_ERROR",
          code: "PROVIDER_MALFORMED",
        };
      }
      if (status === "pending" || status === "approved") {
        return { ok: true, status };
      }
      return {
        ok: false,
        kind: "USER_ERROR",
        code: "START_REJECTED",
      };
    } catch (error) {
      const mapped = mapTwilioVerifyError(error);
      return { ok: false, kind: mapped.kind, code: mapped.code };
    }
  }

  async checkVerification(
    e164: string,
    code: string,
  ): Promise<WhatsAppVerificationCheckResult> {
    try {
      const check = await this.client.verify.v2
        .services(this.serviceSid)
        .verificationChecks.create({
          to: e164,
          code,
        });
      return classifyTwilioVerifyCheckStatus(check.status);
    } catch (error) {
      const mapped = mapTwilioVerifyError(error);
      return { ok: false, kind: mapped.kind, code: mapped.code };
    }
  }
}
