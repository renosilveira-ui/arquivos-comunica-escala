import { createHash, createHmac, randomInt } from "node:crypto";

/** Sem 0/O/1/I para o médico digitar no celular sem ambiguidade. */
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const INVITE_BODY_LENGTH = 8;
const HMAC_DOMAIN = "escala:schedule-invite-code:v2\0";

export const SCHEDULE_INVITE_HASH_VERSION = {
  LEGACY_SHA256: "SHA256_V1",
  HMAC_SHA256: "HMAC_SHA256_V2",
} as const;

export type ScheduleInviteHashVersion =
  (typeof SCHEDULE_INVITE_HASH_VERSION)[keyof typeof SCHEDULE_INVITE_HASH_VERSION];

export function generateScheduleInviteCode(): string {
  let body = "";
  for (let i = 0; i < INVITE_BODY_LENGTH; i++) {
    body += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  }
  return `${body.slice(0, 4)}-${body.slice(4)}`;
}

export function normalizeScheduleInviteCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z2-9]/g, "")
    .slice(0, INVITE_BODY_LENGTH);
}

function assertNormalizedInviteCode(normalized: string): void {
  if (normalized.length !== INVITE_BODY_LENGTH) {
    throw new Error("Convite com tamanho inválido");
  }
}

/** Compatibilidade transitória: somente para linhas explicitamente V1. */
export function hashLegacyScheduleInviteCode(normalized: string): string {
  assertNormalizedInviteCode(normalized);
  return createHash("sha256").update(normalized).digest("hex");
}

/** Hash corrente; o domínio impede reutilização acidental em outro protocolo. */
export function hashScheduleInviteCodeV2(
  normalized: string,
  pepper: string,
): string {
  assertNormalizedInviteCode(normalized);
  if (!pepper) throw new Error("Pepper de convite ausente");
  return createHmac("sha256", pepper)
    .update(HMAC_DOMAIN)
    .update(normalized)
    .digest("hex");
}

export function formatScheduleInviteCode(normalized: string): string {
  if (normalized.length !== INVITE_BODY_LENGTH) return normalized;
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}
