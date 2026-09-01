/**
 * Contrato futuro para verificação WhatsApp via Twilio Verify.
 * Adapter real: Incremento 2B — NÃO implementar aqui.
 *
 * O Escala+ NÃO gera/armazena OTP próprio.
 */
export type WhatsAppVerificationStartResult =
  | { ok: true; provider: "twilio_verify"; status: string }
  | { ok: false; reason: string };

export type WhatsAppVerificationCheckResult =
  | { ok: true; approved: true }
  | { ok: true; approved: false; status: string }
  | { ok: false; reason: string };

export interface WhatsAppVerificationProvider {
  startVerification(e164: string): Promise<WhatsAppVerificationStartResult>;
  checkVerification(
    e164: string,
    code: string,
  ): Promise<WhatsAppVerificationCheckResult>;
}

/**
 * Placeholder documentado — implementação futura:
 * `TwilioVerifyWhatsAppProvider` usando Twilio Verify Service.
 */
export class UnimplementedWhatsAppVerificationProvider
  implements WhatsAppVerificationProvider
{
  async startVerification(
    _e164: string,
  ): Promise<WhatsAppVerificationStartResult> {
    return {
      ok: false,
      reason: "Verificação WhatsApp ainda não está disponível.",
    };
  }

  async checkVerification(
    _e164: string,
    _code: string,
  ): Promise<WhatsAppVerificationCheckResult> {
    return {
      ok: false,
      reason: "Verificação WhatsApp ainda não está disponível.",
    };
  }
}
