/**
 * Contrato de verificação WhatsApp. Twilio Verify é a autoridade do OTP.
 * O Escala+ NÃO gera/armazena OTP próprio.
 *
 * Sucesso de check é somente status `approved` do provider — nunca HTTP 2xx.
 */
export type WhatsAppVerificationFailureKind =
  "USER_ERROR" | "RETRYABLE_PROVIDER_ERROR" | "SERVER_CONFIGURATION_ERROR";

export type WhatsAppVerificationFailureCode =
  | "VERIFY_NOT_CONFIGURED"
  | "PROVIDER_AUTH_FAILURE"
  | "PROVIDER_CHANNEL_NOT_CONFIGURED"
  | "PROVIDER_MALFORMED"
  | "TWILIO_UNAVAILABLE"
  | "INVALID_PHONE"
  | "INVALID_CODE"
  | "EXPIRED"
  | "TOO_MANY_ATTEMPTS"
  | "TOO_MANY_SENDS"
  | "RATE_LIMITED"
  | "START_REJECTED";

/** Números finitos do SDK Twilio — só para log server-side. Sem message/URL/SID. */
export type SafeProviderDiagnostics = {
  providerHttpStatus?: number;
  providerErrorCode?: number;
};

export type WhatsAppVerificationProviderFailure = {
  ok: false;
  kind: WhatsAppVerificationFailureKind;
  code: WhatsAppVerificationFailureCode;
  diagnostics?: SafeProviderDiagnostics;
};

export type WhatsAppVerificationStartResult =
  | { ok: true; status: string; verificationSid: string }
  | WhatsAppVerificationProviderFailure;

export type WhatsAppVerificationCheckResult =
  | { ok: true; approved: true }
  | { ok: true; approved: false; status: string }
  | WhatsAppVerificationProviderFailure;

export interface WhatsAppVerificationProvider {
  startVerification(e164: string): Promise<WhatsAppVerificationStartResult>;
  checkVerification(
    e164: string,
    code: string,
    verificationSid: string,
  ): Promise<WhatsAppVerificationCheckResult>;
}

const NOT_CONFIGURED: WhatsAppVerificationStartResult &
  WhatsAppVerificationCheckResult = {
  ok: false,
  kind: "SERVER_CONFIGURATION_ERROR",
  code: "VERIFY_NOT_CONFIGURED",
};

/**
 * Fail-closed quando o Verify Service não está configurado.
 * Nunca é um mock silencioso de sucesso.
 */
export class UnimplementedWhatsAppVerificationProvider
  implements WhatsAppVerificationProvider
{
  async startVerification(
    _e164: string,
  ): Promise<WhatsAppVerificationStartResult> {
    return NOT_CONFIGURED;
  }

  async checkVerification(
    _e164: string,
    _code: string,
    _verificationSid?: string,
  ): Promise<WhatsAppVerificationCheckResult> {
    return NOT_CONFIGURED;
  }
}

export const unimplementedWhatsAppVerificationProvider =
  new UnimplementedWhatsAppVerificationProvider();

/** Somente o literal `approved` autoriza verifiedAt. */
export function isTwilioVerifyApprovedStatus(status: unknown): boolean {
  return status === "approved";
}

export function classifyTwilioVerifyCheckStatus(
  status: unknown,
): WhatsAppVerificationCheckResult {
  if (isTwilioVerifyApprovedStatus(status)) {
    return { ok: true, approved: true };
  }
  if (typeof status !== "string" || status.trim() === "") {
    return {
      ok: false,
      kind: "RETRYABLE_PROVIDER_ERROR",
      code: "PROVIDER_MALFORMED",
    };
  }
  return { ok: true, approved: false, status };
}
