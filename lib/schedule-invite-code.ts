import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";

/** Sem 0/O/1/I para o médico digitar no celular sem ambiguidade. */
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const INVITE_BODY_LENGTH = 8;
const HMAC_DOMAIN = "escala:schedule-invite-code:v2\0";
const OUTBOX_CODE_DOMAIN = "escala:schedule-invite-outbox-code:v1\0";
const RECIPIENT_BINDING_DOMAIN =
  "escala:schedule-invite-recipient-binding:v1\0";
const PEPPER_KEY_ID_DOMAIN = "escala:schedule-invite-pepper-key-id:v1\0";

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

export type ScheduleInviteCodeScope = {
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  invitedUserId: number;
};

function assertOpaqueHex(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} opaco inválido`);
  }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} inválido`);
  }
}

/** Material aleatório persistível; não contém nem permite recuperar o código sem o pepper. */
export function generateScheduleInviteOpaqueToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Deriva novamente o mesmo código para retries da mesma geração. O banco
 * persiste apenas `nonce` e `keyId`; sem o pepper não há ataque offline ao
 * espaço curto do código.
 */
export function deriveScheduleInviteCode(
  input: ScheduleInviteCodeScope & { generation: number; nonce: string },
  pepper: string,
): string {
  assertPositiveInteger(input.institutionId, "institutionId");
  assertPositiveInteger(input.hospitalId, "hospitalId");
  assertPositiveInteger(input.sectorId, "sectorId");
  assertPositiveInteger(input.invitedUserId, "invitedUserId");
  assertPositiveInteger(input.generation, "generation");
  assertOpaqueHex(input.nonce, "Nonce");
  if (!pepper) throw new Error("Pepper de convite ausente");

  const digest = createHmac("sha256", pepper)
    .update(OUTBOX_CODE_DOMAIN)
    .update(
      [
        input.institutionId,
        input.hospitalId,
        input.sectorId,
        input.invitedUserId,
        input.generation,
        input.nonce,
      ].join("\0"),
    )
    .digest();
  let normalized = "";
  for (let index = 0; index < INVITE_BODY_LENGTH; index += 1) {
    normalized += INVITE_ALPHABET[digest[index]! & 31];
  }
  return formatScheduleInviteCode(normalized);
}

export function scheduleInvitePepperKeyId(pepper: string): string {
  if (!pepper) throw new Error("Pepper de convite ausente");
  return createHmac("sha256", pepper)
    .update(PEPPER_KEY_ID_DOMAIN)
    .digest("hex");
}

export function hashScheduleInviteRecipientBinding(
  email: string,
  pepper: string,
): string {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail || !pepper) {
    throw new Error("Vínculo de destinatário inválido");
  }
  return createHmac("sha256", pepper)
    .update(RECIPIENT_BINDING_DOMAIN)
    .update(normalizedEmail)
    .digest("hex");
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
