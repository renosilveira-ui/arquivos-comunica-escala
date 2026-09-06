/**
 * Aplicação L2: informar número ≠ verificar número.
 *
 * start: upsert (se phone) + Twilio Verify channel=whatsapp.
 * check: E.164 persistido do próprio user → Verify check → markWhatsAppContactVerified.
 *
 * verifiedAt só nasce de status approved. Sem tenant authority.
 */
import { TRPCError } from "@trpc/server";
import { logger } from "./_core/logger";
import { maskE164 } from "../lib/phone-e164";
import {
  assertOperableWhatsAppUser,
  e164AuditHash,
  getActiveWhatsAppChannelForUser,
  markWhatsAppContactVerified,
  upsertUserWhatsAppContact,
} from "./user-contact-channels";
import {
  unimplementedWhatsAppVerificationProvider,
  type WhatsAppVerificationFailureCode,
  type WhatsAppVerificationFailureKind,
  type WhatsAppVerificationProvider,
} from "./whatsapp-verification-provider";
import {
  consumeWhatsAppVerifyRateLimit,
  WHATSAPP_VERIFY_CHECK_IP_LIMIT,
  WHATSAPP_VERIFY_CHECK_USER_LIMIT,
  WHATSAPP_VERIFY_START_IP_LIMIT,
  WHATSAPP_VERIFY_START_USER_LIMIT,
  whatsappVerifyCheckIpKey,
  whatsappVerifyCheckUserKey,
  whatsappVerifyStartIpKey,
  whatsappVerifyStartUserKey,
} from "./whatsapp-verification-rate-limit";
import {
  readTwilioVerifyConfig,
  TwilioWhatsAppVerificationProvider,
} from "./integrations/whatsapp/twilio-verify-provider";

const OTP_PATTERN = /^\d{4,10}$/;

export const whatsappVerificationRuntime: {
  provider: WhatsAppVerificationProvider | null;
} = {
  provider: null,
};

export function resetWhatsAppVerificationRuntime(): void {
  whatsappVerificationRuntime.provider = null;
}

function resolveProvider(): WhatsAppVerificationProvider {
  // Hook só em testes. Fora de test nunca há mock silencioso.
  if (process.env.NODE_ENV === "test") {
    return (
      whatsappVerificationRuntime.provider ??
      unimplementedWhatsAppVerificationProvider
    );
  }
  const config = readTwilioVerifyConfig();
  if (!config) return unimplementedWhatsAppVerificationProvider;
  return new TwilioWhatsAppVerificationProvider({ config });
}

function userMessage(code: WhatsAppVerificationFailureCode): string {
  switch (code) {
    case "INVALID_PHONE":
      return "Número de WhatsApp inválido.";
    case "INVALID_CODE":
      return "Código inválido. Tente novamente.";
    case "EXPIRED":
      return "Código expirado. Solicite um novo.";
    case "TOO_MANY_ATTEMPTS":
      return "Muitas tentativas. Solicite um novo código.";
    case "TOO_MANY_SENDS":
      return "Muitos envios. Aguarde antes de pedir outro código.";
    case "RATE_LIMITED":
      return "Muitas solicitações. Aguarde um pouco e tente de novo.";
    case "VERIFY_NOT_CONFIGURED":
    case "PROVIDER_AUTH_FAILURE":
      return "Verificação WhatsApp indisponível no momento.";
    case "TWILIO_UNAVAILABLE":
    case "PROVIDER_MALFORMED":
      return "Não foi possível falar com o verificador. Tente de novo em instantes.";
    case "START_REJECTED":
      return "Não foi possível enviar o código. Confira o número e tente de novo.";
    default:
      return "Não foi possível verificar o WhatsApp.";
  }
}

function logSafe(payload: Record<string, unknown>): void {
  logger.info(payload);
}

export type WhatsAppVerificationAppFailure = {
  ok: false;
  kind: WhatsAppVerificationFailureKind | "USER_ERROR";
  code:
    | WhatsAppVerificationFailureCode
    | "NUMBER_IN_USE"
    | "NO_NUMBER"
    | "CHANNEL_CHANGED"
    | "CHANNEL_INACTIVE";
  message: string;
  verified: false;
  status: "unverified" | "missing";
  retryAfterSeconds?: number;
};

export type StartWhatsAppVerificationResult =
  | {
      ok: true;
      verificationStarted: boolean;
      alreadyVerified?: boolean;
      maskedDestination: string;
      verified: boolean;
      status: "unverified" | "verified";
      retryAfterSeconds?: number;
    }
  | WhatsAppVerificationAppFailure;

export type CheckWhatsAppVerificationResult =
  | {
      ok: true;
      verified: true;
      status: "verified";
      maskedAddress: string;
    }
  | WhatsAppVerificationAppFailure;

function fail(
  kind: WhatsAppVerificationAppFailure["kind"],
  code: WhatsAppVerificationAppFailure["code"],
  extra?: { retryAfterSeconds?: number; status?: "unverified" | "missing" },
): WhatsAppVerificationAppFailure {
  const message =
    code === "NUMBER_IN_USE"
      ? "Este WhatsApp já está vinculado a outra conta. Use outro número ou fale com o suporte."
      : code === "NO_NUMBER"
        ? "Informe um WhatsApp antes de verificar."
        : code === "CHANNEL_CHANGED" || code === "CHANNEL_INACTIVE"
          ? "O número mudou. Solicite um novo código."
          : userMessage(code as WhatsAppVerificationFailureCode);
  return {
    ok: false,
    kind,
    code,
    message,
    verified: false,
    status: extra?.status ?? "unverified",
    retryAfterSeconds: extra?.retryAfterSeconds,
  };
}

function clientIp(req: { ip?: string } | undefined): string | null {
  const ip = req?.ip?.trim();
  return ip ? ip : null;
}

export async function startWhatsAppVerification(input: {
  userId: number;
  institutionId: number;
  phone?: string;
  req?: { ip?: string };
}): Promise<StartWhatsAppVerificationResult> {
  await assertOperableWhatsAppUser(input.userId);
  const startLimit = consumeWhatsAppVerifyRateLimit({
    key: whatsappVerifyStartUserKey(input.userId),
    limit: WHATSAPP_VERIFY_START_USER_LIMIT,
  });
  if (startLimit.limited) {
    return fail("USER_ERROR", "RATE_LIMITED", {
      retryAfterSeconds: startLimit.retryAfterSeconds,
    });
  }
  const ip = clientIp(input.req);
  if (ip) {
    const ipLimit = consumeWhatsAppVerifyRateLimit({
      key: whatsappVerifyStartIpKey(ip),
      limit: WHATSAPP_VERIFY_START_IP_LIMIT,
    });
    if (ipLimit.limited) {
      return fail("USER_ERROR", "RATE_LIMITED", {
        retryAfterSeconds: ipLimit.retryAfterSeconds,
      });
    }
  }

  let channel: { e164: string; verified: boolean } | null = null;
  const rawPhone = input.phone?.trim();
  if (rawPhone) {
    try {
      const saved = await upsertUserWhatsAppContact({
        userId: input.userId,
        rawPhone,
        institutionId: input.institutionId,
      });
      channel = await getActiveWhatsAppChannelForUser(input.userId);
      if (!channel) {
        return fail("USER_ERROR", "NO_NUMBER", { status: "missing" });
      }
      if (saved.verified && channel.verified) {
        logSafe({
          event: "whatsapp_verify_start_already_verified",
          userId: input.userId,
          channel: "WHATSAPP",
          addressHash: e164AuditHash(channel.e164),
        });
        return {
          ok: true,
          verificationStarted: false,
          alreadyVerified: true,
          maskedDestination: maskE164(channel.e164),
          verified: true,
          status: "verified",
        };
      }
    } catch (error) {
      if (error instanceof TRPCError && error.code === "CONFLICT") {
        return fail("USER_ERROR", "NUMBER_IN_USE");
      }
      if (error instanceof TRPCError && error.code === "BAD_REQUEST") {
        return fail("USER_ERROR", "INVALID_PHONE");
      }
      throw error;
    }
  } else {
    channel = await getActiveWhatsAppChannelForUser(input.userId);
    if (!channel) {
      return fail("USER_ERROR", "NO_NUMBER", { status: "missing" });
    }
    if (channel.verified) {
      return {
        ok: true,
        verificationStarted: false,
        alreadyVerified: true,
        maskedDestination: maskE164(channel.e164),
        verified: true,
        status: "verified",
      };
    }
  }

  if (!channel) {
    return fail("USER_ERROR", "NO_NUMBER", { status: "missing" });
  }

  const provider = resolveProvider();
  const started = await provider.startVerification(channel.e164);
  if (!started.ok) {
    logSafe({
      event: "whatsapp_verify_start_failed",
      userId: input.userId,
      channel: "WHATSAPP",
      addressHash: e164AuditHash(channel.e164),
      kind: started.kind,
      code: started.code,
    });
    return fail(started.kind, started.code);
  }

  logSafe({
    event: "whatsapp_verify_start_ok",
    userId: input.userId,
    channel: "WHATSAPP",
    addressHash: e164AuditHash(channel.e164),
    providerStatus: started.status,
  });

  return {
    ok: true,
    verificationStarted: true,
    maskedDestination: maskE164(channel.e164),
    verified: false,
    status: "unverified",
    retryAfterSeconds: 30,
  };
}

export async function checkWhatsAppVerification(input: {
  userId: number;
  code: string;
  req?: { ip?: string };
}): Promise<CheckWhatsAppVerificationResult> {
  await assertOperableWhatsAppUser(input.userId);
  const code = input.code.trim();
  if (!OTP_PATTERN.test(code)) {
    return fail("USER_ERROR", "INVALID_CODE");
  }

  const checkLimit = consumeWhatsAppVerifyRateLimit({
    key: whatsappVerifyCheckUserKey(input.userId),
    limit: WHATSAPP_VERIFY_CHECK_USER_LIMIT,
  });
  if (checkLimit.limited) {
    return fail("USER_ERROR", "RATE_LIMITED", {
      retryAfterSeconds: checkLimit.retryAfterSeconds,
    });
  }
  const ip = clientIp(input.req);
  if (ip) {
    const ipLimit = consumeWhatsAppVerifyRateLimit({
      key: whatsappVerifyCheckIpKey(ip),
      limit: WHATSAPP_VERIFY_CHECK_IP_LIMIT,
    });
    if (ipLimit.limited) {
      return fail("USER_ERROR", "RATE_LIMITED", {
        retryAfterSeconds: ipLimit.retryAfterSeconds,
      });
    }
  }

  const channel = await getActiveWhatsAppChannelForUser(input.userId);
  if (!channel) {
    return fail("USER_ERROR", "NO_NUMBER", { status: "missing" });
  }
  if (channel.verified) {
    return {
      ok: true,
      verified: true,
      status: "verified",
      maskedAddress: maskE164(channel.e164),
    };
  }

  const provider = resolveProvider();
  const checked = await provider.checkVerification(channel.e164, code);
  if (!checked.ok) {
    logSafe({
      event: "whatsapp_verify_check_failed",
      userId: input.userId,
      channel: "WHATSAPP",
      addressHash: e164AuditHash(channel.e164),
      kind: checked.kind,
      code: checked.code,
    });
    return fail(checked.kind, checked.code);
  }
  if (!checked.approved) {
    const mapped =
      checked.status === "expired"
        ? "EXPIRED"
        : checked.status === "max_attempts_reached"
          ? "TOO_MANY_ATTEMPTS"
          : "INVALID_CODE";
    logSafe({
      event: "whatsapp_verify_check_not_approved",
      userId: input.userId,
      channel: "WHATSAPP",
      addressHash: e164AuditHash(channel.e164),
      providerStatus: checked.status,
    });
    return fail("USER_ERROR", mapped);
  }

  try {
    await markWhatsAppContactVerified({
      userId: input.userId,
      expectedE164: channel.e164,
    });
  } catch (error) {
    if (error instanceof TRPCError && error.code === "CONFLICT") {
      return fail("USER_ERROR", "CHANNEL_CHANGED");
    }
    throw error;
  }

  const after = await getActiveWhatsAppChannelForUser(input.userId);
  if (!after?.verified) {
    return fail("USER_ERROR", "CHANNEL_CHANGED");
  }

  logSafe({
    event: "whatsapp_verify_check_approved",
    userId: input.userId,
    channel: "WHATSAPP",
    addressHash: e164AuditHash(after.e164),
  });

  return {
    ok: true,
    verified: true,
    status: "verified",
    maskedAddress: maskE164(after.e164),
  };
}
