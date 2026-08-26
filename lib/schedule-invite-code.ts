import { createHash, randomBytes } from "node:crypto";

/** Sem 0/O/1/I para o médico digitar no celular sem ambiguidade. */
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const INVITE_BODY_LENGTH = 8;

export function generateScheduleInviteCode(): string {
  const bytes = randomBytes(INVITE_BODY_LENGTH);
  let body = "";
  for (const byte of bytes) {
    body += INVITE_ALPHABET[byte % INVITE_ALPHABET.length];
  }
  return `${body.slice(0, 4)}-${body.slice(4)}`;
}

export function normalizeScheduleInviteCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z2-9]/g, "")
    .slice(0, INVITE_BODY_LENGTH);
}

export function hashScheduleInviteCode(normalized: string): string {
  if (normalized.length !== INVITE_BODY_LENGTH) {
    throw new Error("Convite com tamanho inválido");
  }
  return createHash("sha256").update(normalized).digest("hex");
}

export function formatScheduleInviteCode(normalized: string): string {
  if (normalized.length !== INVITE_BODY_LENGTH) return normalized;
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}
