/**
 * Normalização canônica de telefone para WhatsApp (E.164).
 * Default country BR apenas quando a entrada NÃO traz DDI explícito.
 */
import {
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js";

export const WHATSAPP_DEFAULT_COUNTRY: CountryCode = "BR";

export type NormalizePhoneSuccess = {
  ok: true;
  /** E.164 canônico, ex.: +5585999999999 */
  e164: string;
  /** Entrada original aparada (para persistir em `address`). */
  displayInput: string;
};

export type NormalizePhoneFailure = {
  ok: false;
  reason: string;
};

export type NormalizePhoneResult = NormalizePhoneSuccess | NormalizePhoneFailure;

/**
 * Converte entrada humana em E.164.
 * - Sem DDI → assume BR.
 * - Com `+` / 00 → interpreta como internacional explícito (não força BR).
 */
export function normalizeToE164(
  raw: string,
  defaultCountry: CountryCode = WHATSAPP_DEFAULT_COUNTRY,
): NormalizePhoneResult {
  const displayInput = raw.trim();
  if (!displayInput) {
    return { ok: false, reason: "Informe um número de WhatsApp." };
  }

  const explicitInternational =
    displayInput.startsWith("+") || /^00\d/.test(displayInput.replace(/\s+/g, ""));

  const parsed = explicitInternational
    ? parsePhoneNumberFromString(displayInput)
    : parsePhoneNumberFromString(displayInput, defaultCountry);

  if (!parsed || !parsed.isValid()) {
    return {
      ok: false,
      reason:
        "Número de WhatsApp inválido. Use DDD + celular, ex.: (85) 99999-9999.",
    };
  }

  return {
    ok: true,
    e164: parsed.format("E.164"),
    displayInput,
  };
}

/** Mascara E.164 para UI/API: +55 85 *****-1234 */
export function maskE164(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  if (digits.length < 4) return "****";
  const last4 = digits.slice(-4);
  // BR móvel típico: 55 + DDD(2) + 9 dígitos
  if (digits.startsWith("55") && digits.length >= 12) {
    const ddd = digits.slice(2, 4);
    return `+55 ${ddd} *****-${last4}`;
  }
  const countryHint = e164.startsWith("+")
    ? e164.slice(0, Math.min(3, e164.length - 4))
    : "+";
  return `${countryHint} *****-${last4}`;
}

/** Hash curto para audit/log — nunca logar E.164 completo. */
export function hashE164ForAudit(e164: string): string {
  // SHA-256 seria ideal; crypto no client RN é pesado — server usa crypto.
  // Esta função pura só formata; o domínio server hasheia de verdade.
  return `e164:${e164.length}:${e164.slice(-4)}`;
}
