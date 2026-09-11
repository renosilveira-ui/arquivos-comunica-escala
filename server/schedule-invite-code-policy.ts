import {
  deriveScheduleInviteCode,
  hashScheduleInviteRecipientBinding,
  hashLegacyScheduleInviteCode,
  hashScheduleInviteCodeV2,
  scheduleInvitePepperKeyId,
  SCHEDULE_INVITE_HASH_VERSION,
  type ScheduleInviteCodeScope,
  type ScheduleInviteHashVersion,
} from "../lib/schedule-invite-code";
import type { MailMessage } from "./mailer";
import { fingerprintScheduleInviteProviderRequest } from "./schedule-invite-provider-request";

const MIN_PEPPER_BYTES = 32;

type InviteHashEnvironment = {
  [key: string]: string | undefined;
  SCHEDULE_INVITE_CODE_PEPPER?: string;
  SCHEDULE_INVITE_CODE_PREVIOUS_PEPPER?: string;
  COOKIE_SECRET?: string;
  JWT_SECRET?: string;
  AUTH_TOKEN?: string;
  TWILIO_AUTH_TOKEN?: string;
  RESEND_API_KEY?: string;
};

export class ScheduleInviteCodeConfigurationError extends Error {
  constructor() {
    super("Hash seguro de convite indisponível");
    this.name = "ScheduleInviteCodeConfigurationError";
  }
}

function readValidPepper(raw: string | undefined): string | null {
  const pepper = raw?.trim() ?? "";
  if (!pepper) return null;
  if (
    Buffer.byteLength(pepper, "utf8") < MIN_PEPPER_BYTES ||
    /^changeme/i.test(pepper)
  ) {
    throw new ScheduleInviteCodeConfigurationError();
  }
  return pepper;
}

function assertDedicatedPepper(
  pepper: string,
  env: InviteHashEnvironment,
): void {
  const forbidden = [
    env.COOKIE_SECRET,
    env.JWT_SECRET,
    env.AUTH_TOKEN,
    env.TWILIO_AUTH_TOKEN,
    env.RESEND_API_KEY,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (forbidden.includes(pepper)) {
    throw new ScheduleInviteCodeConfigurationError();
  }
}

export type ScheduleInviteHashPolicy = {
  write: {
    version: typeof SCHEDULE_INVITE_HASH_VERSION.HMAC_SHA256;
    hash(normalized: string): string;
  };
  lookup(normalized: string): {
    version: ScheduleInviteHashVersion;
    hash: string;
  }[];
  outbox: {
    current: ScheduleInviteOutboxKey;
    resolve(keyId: string): ScheduleInviteOutboxKey | null;
  };
};

export type ScheduleInviteOutboxKey = {
  keyId: string;
  deriveCode(
    input: ScheduleInviteCodeScope & { generation: number; nonce: string },
  ): string;
  bindRecipient(email: string): string;
  fingerprintProviderRequest(message: MailMessage): string;
  hash(normalized: string): string;
};

function buildOutboxKey(pepper: string): ScheduleInviteOutboxKey {
  return Object.freeze({
    keyId: scheduleInvitePepperKeyId(pepper),
    deriveCode: (input) => deriveScheduleInviteCode(input, pepper),
    bindRecipient: (email) =>
      hashScheduleInviteRecipientBinding(email, pepper),
    fingerprintProviderRequest: (message) =>
      fingerprintScheduleInviteProviderRequest(message, pepper),
    hash: (normalized) => hashScheduleInviteCodeV2(normalized, pepper),
  });
}

/**
 * Carregamento tardio e fail-closed: segredo ausente/quebrado bloqueia somente
 * operações de convite. O app continua inicializando normalmente.
 *
 * Rotação: configure o novo valor em SCHEDULE_INVITE_CODE_PEPPER e mantenha o
 * anterior em SCHEDULE_INVITE_CODE_PREVIOUS_PEPPER por pelo menos 24 horas
 * (TTL máximo do convite). Nunca reutilize segredo de cookie/JWT/Twilio/e-mail.
 */
export function getScheduleInviteHashPolicy(
  env: InviteHashEnvironment = process.env,
): ScheduleInviteHashPolicy {
  const current = readValidPepper(env.SCHEDULE_INVITE_CODE_PEPPER);
  if (!current) throw new ScheduleInviteCodeConfigurationError();
  assertDedicatedPepper(current, env);

  const previous = readValidPepper(
    env.SCHEDULE_INVITE_CODE_PREVIOUS_PEPPER,
  );
  if (previous) {
    assertDedicatedPepper(previous, env);
    if (previous === current) {
      throw new ScheduleInviteCodeConfigurationError();
    }
  }

  const currentOutboxKey = buildOutboxKey(current);
  const previousOutboxKey = previous ? buildOutboxKey(previous) : null;

  return {
    write: {
      version: SCHEDULE_INVITE_HASH_VERSION.HMAC_SHA256,
      hash: (normalized) => hashScheduleInviteCodeV2(normalized, current),
    },
    lookup: (normalized) => {
      const candidates: {
        version: ScheduleInviteHashVersion;
        hash: string;
      }[] = [
        {
          version: SCHEDULE_INVITE_HASH_VERSION.HMAC_SHA256,
          hash: hashScheduleInviteCodeV2(normalized, current),
        },
      ];
      if (previous) {
        candidates.push({
          version: SCHEDULE_INVITE_HASH_VERSION.HMAC_SHA256,
          hash: hashScheduleInviteCodeV2(normalized, previous),
        });
      }
      candidates.push({
        version: SCHEDULE_INVITE_HASH_VERSION.LEGACY_SHA256,
        hash: hashLegacyScheduleInviteCode(normalized),
      });
      return candidates;
    },
    outbox: {
      current: currentOutboxKey,
      resolve: (keyId) => {
        if (keyId === currentOutboxKey.keyId) return currentOutboxKey;
        if (keyId === previousOutboxKey?.keyId) return previousOutboxKey;
        return null;
      },
    },
  };
}
