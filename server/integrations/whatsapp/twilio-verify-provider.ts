/**
 * Adapter Twilio Verify (channel=whatsapp). Sem persistência, sem AuthZ.
 */
import twilio from "twilio";
import {
  classifyTwilioVerifyCheckStatus,
  type SafeProviderDiagnostics,
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

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function extractSafeTwilioVerifyDiagnostics(
  error: unknown,
): SafeProviderDiagnostics | undefined {
  const rest = asTwilioError(error);
  const providerHttpStatus = finiteNumber(rest?.status);
  const providerErrorCode = finiteNumber(rest?.code);
  if (providerHttpStatus === undefined && providerErrorCode === undefined) {
    return undefined;
  }
  return {
    ...(providerHttpStatus !== undefined ? { providerHttpStatus } : {}),
    ...(providerErrorCode !== undefined ? { providerErrorCode } : {}),
  };
}

export function mapTwilioVerifyError(
  error: unknown,
): {
  kind: WhatsAppVerificationFailureKind;
  code: WhatsAppVerificationFailureCode;
  diagnostics?: SafeProviderDiagnostics;
} {
  const rest = asTwilioError(error);
  const httpStatus = finiteNumber(rest?.status);
  const twilioCode = finiteNumber(rest?.code);

  let kind: WhatsAppVerificationFailureKind = "RETRYABLE_PROVIDER_ERROR";
  let code: WhatsAppVerificationFailureCode = "TWILIO_UNAVAILABLE";
  if (httpStatus === 401 || httpStatus === 403 || twilioCode === 20003) {
    kind = "SERVER_CONFIGURATION_ERROR";
    code = "PROVIDER_AUTH_FAILURE";
  } else if (twilioCode === 20404 || httpStatus === 404) {
    kind = "USER_ERROR";
    code = "EXPIRED";
  } else if (twilioCode === 60202) {
    kind = "USER_ERROR";
    code = "TOO_MANY_ATTEMPTS";
  } else if (twilioCode === 60203) {
    kind = "USER_ERROR";
    code = "TOO_MANY_SENDS";
  } else if (twilioCode === 60200 || twilioCode === 60205) {
    kind = "USER_ERROR";
    code = "INVALID_PHONE";
  } else if (twilioCode === 60003 || httpStatus === 429) {
    kind = "USER_ERROR";
    code = "RATE_LIMITED";
  } else if (
    twilioCode === 68008 ||
    twilioCode === 60428 ||
    twilioCode === 60242
  ) {
    // Docs Twilio: 68008 = Verify WhatsApp channel not configured;
    // 60428 = unsupported channel / sender WhatsApp ausente no Verify;
    // 60242 = template WhatsApp não encontrado/aprovado (conta + idioma).
    // Não é retry de transporte. Sem fallback SMS nesta frente.
    kind = "SERVER_CONFIGURATION_ERROR";
    code = "PROVIDER_CHANNEL_NOT_CONFIGURED";
  } else if (httpStatus !== undefined && httpStatus >= 500) {
    kind = "RETRYABLE_PROVIDER_ERROR";
    code = "TWILIO_UNAVAILABLE";
  }

  const diagnostics = extractSafeTwilioVerifyDiagnostics(error);
  return diagnostics ? { kind, code, diagnostics } : { kind, code };
}

function asProviderFailure(error: unknown): {
  ok: false;
  kind: WhatsAppVerificationFailureKind;
  code: WhatsAppVerificationFailureCode;
  diagnostics?: SafeProviderDiagnostics;
} {
  const mapped = mapTwilioVerifyError(error);
  return mapped.diagnostics
    ? {
        ok: false,
        kind: mapped.kind,
        code: mapped.code,
        diagnostics: mapped.diagnostics,
      }
    : { ok: false, kind: mapped.kind, code: mapped.code };
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
      return asProviderFailure(error);
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
      return asProviderFailure(error);
    }
  }
}
