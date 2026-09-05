/**
 * Ocupação durável do driver B2-D sobre `whatsapp_inbound_messages.error_code`.
 *
 * Sem coluna nova: READY_FOR_NL continua o status Twilio-terminal. O driver
 * usa `error_code` só enquanto `processing_status = READY_FOR_NL`:
 *
 * - NULL — elegível
 * - WA_NL_DRV_CLAIMED:<attempt>:<token> — em processamento; stale → recover
 * - WA_NL_DRV_RETRY:<attempt> — backoff de infra / STATE_CHANGED
 * - WA_NL_DRV_WAIT:<attempt> — espera conversa alheia (ALREADY_OPEN); reentra
 * - WA_NL_DRV_PARK:<code> — não reprocessar este inbound (domínio / poison)
 *
 * Persistência inbound (webhook) não escreve error_code em READY_FOR_NL.
 * Prefixos `WA_NL_DRV_` não colidem com IDENTITY_NOT_FOUND / UNSUPPORTED_MEDIA.
 *
 * PARK é terminal operacional deste source: status permanece READY_FOR_NL;
 * occupancy exclui da discovery; payload segue o TTL inbound (24h) e o
 * sweep `clearExpiredWhatsAppInboundPayloads` (P3 inbound, job futuro).
 * PARK não estende retenção além do TTL B1.
 *
 * WHATSAPP_B2D_INDEX_REQUIRED: o poll a ≥10k rows usa filesort no
 * UNIQUE (provider, …) e o custo cresce linearmente. Índice composto é
 * schema inbound — prerequisite, não esta PR.
 */

import type { ProcessWhatsAppReadyForNlInboundResult } from "./ready-for-nl-types";
import { WHATSAPP_PENDING_INTENT_TTL_MS } from "./pending-intent-types";

/** Espelha o TTL conversacional B1 para justificar o backoff de WAIT. */
export const WHATSAPP_NL_DRIVER_WAIT_PENDING_TTL_MS =
  WHATSAPP_PENDING_INTENT_TTL_MS;

export const WHATSAPP_NL_DRIVER_CLAIMED_PREFIX = "WA_NL_DRV_CLAIMED";
export const WHATSAPP_NL_DRIVER_RETRY_PREFIX = "WA_NL_DRV_RETRY";
export const WHATSAPP_NL_DRIVER_WAIT_PREFIX = "WA_NL_DRV_WAIT";
export const WHATSAPP_NL_DRIVER_PARK_PREFIX = "WA_NL_DRV_PARK";

/** LIKE `WA_NL_DRV_CLAIMED:%` */
export const WHATSAPP_NL_DRIVER_CLAIMED_LIKE = `${WHATSAPP_NL_DRIVER_CLAIMED_PREFIX}:%`;
/** LIKE `WA_NL_DRV_RETRY:%` */
export const WHATSAPP_NL_DRIVER_RETRY_LIKE = `${WHATSAPP_NL_DRIVER_RETRY_PREFIX}:%`;
/** LIKE `WA_NL_DRV_WAIT:%` */
export const WHATSAPP_NL_DRIVER_WAIT_LIKE = `${WHATSAPP_NL_DRIVER_WAIT_PREFIX}:%`;

/**
 * REGEXP âncora o attempt. LIKE sozinho aceita `WAIT:abc` / `RETRY:1e21`
 * e o CAST UNSIGNED vira 0 — HOL no tick LIMIT 1 se o JS só skipa.
 */
export const WHATSAPP_NL_DRIVER_CLAIMED_REGEXP =
  `^${WHATSAPP_NL_DRIVER_CLAIMED_PREFIX}:[1-9][0-9]*:[^:]+$`;
export const WHATSAPP_NL_DRIVER_RETRY_REGEXP =
  `^${WHATSAPP_NL_DRIVER_RETRY_PREFIX}:[1-9][0-9]*$`;
export const WHATSAPP_NL_DRIVER_WAIT_REGEXP =
  `^${WHATSAPP_NL_DRIVER_WAIT_PREFIX}:[1-9][0-9]*$`;

/** Occupancy driver que não parseia: estaciona fail-closed, não skipa o LIMIT. */
export const WHATSAPP_NL_DRIVER_MALFORMED_PARK_CODE = "MALFORMED_OCCUPANCY";

/**
 * Offset 1-based do dígito de attempt em `WA_NL_DRV_RETRY:<n>` para SQL
 * SUBSTRING. Prefixo + ':'.
 */
export const WHATSAPP_NL_DRIVER_RETRY_ATTEMPT_SQL_OFFSET =
  WHATSAPP_NL_DRIVER_RETRY_PREFIX.length + 2;

export const WHATSAPP_NL_DRIVER_WAIT_ATTEMPT_SQL_OFFSET =
  WHATSAPP_NL_DRIVER_WAIT_PREFIX.length + 2;

export const WHATSAPP_NL_DRIVER_BATCH_SIZE = 20;
export const WHATSAPP_NL_DRIVER_INTERVAL_MS = 8_000;
export const WHATSAPP_NL_DRIVER_JITTER_MS = 1_000;
export const WHATSAPP_NL_DRIVER_LEASE_MS = 90_000;
export const WHATSAPP_NL_DRIVER_STATE_CHANGED_RETRY_LIMIT = 5;

/** attempt 1 → 30s, 2 → 2m, 3 → 10m, 4 → 30m, 5+ → 60m */
export const WHATSAPP_NL_DRIVER_RETRY_DELAY_MS = [
  30_000, 120_000, 600_000, 1_800_000, 3_600_000,
] as const;

/**
 * Espera por conversa alheia (ALREADY_OPEN). Alinhado ao TTL pending 15 min
 * (`WHATSAPP_PENDING_INTENT_TTL_MS`): 30s pega OPEN que está acabando;
 * 2m/5m ainda dentro da janela; cap 10m evita hot-loop e reentra após o
 * pending expirar (~15 min) sem exigir terceira mensagem do usuário.
 * Limitado pelo TTL do payload inbound (24h), não pelo pending.
 */
export const WHATSAPP_NL_DRIVER_WAIT_DELAY_MS = [
  30_000, 120_000, 300_000, 600_000,
] as const;

export type WhatsAppNlDriverOccupancy =
  | { kind: "idle" }
  | { kind: "claimed"; attempt: number; token: string }
  | { kind: "retry"; attempt: number }
  | { kind: "wait"; attempt: number }
  | { kind: "park"; code: string }
  | { kind: "foreign" };

export type WhatsAppNlDriverDisposition =
  | "COMPLETE"
  | "RETRY_INFRA"
  | "RETRY_STATE_CHANGED"
  | "WAITING_FOR_OTHER_CONVERSATION"
  | "TERMINAL_MANUAL"
  | "INSUFFICIENT_MATERIAL"
  | "POISON";

export type WhatsAppNlDriverDecision =
  | { action: "complete"; disposition: "COMPLETE" }
  | {
      action: "retry";
      disposition: "RETRY_INFRA" | "RETRY_STATE_CHANGED";
      nextAttempt: number;
      delayMs: number;
    }
  | {
      action: "wait";
      disposition: "WAITING_FOR_OTHER_CONVERSATION";
      nextAttempt: number;
      delayMs: number;
    }
  | {
      action: "park";
      disposition: "TERMINAL_MANUAL" | "INSUFFICIENT_MATERIAL" | "POISON";
      code: string;
    };

export type ClassifyWhatsAppNlDriverOutcomeInput = {
  result: ProcessWhatsAppReadyForNlInboundResult;
  attempt: number;
  now?: Date;
  payloadExpiresAt?: Date | null;
  hasReconcileablePending?: boolean;
};

export function whatsAppNlDriverRetryDelayMs(attempt: number): number {
  const safe = Number.isInteger(attempt) && attempt > 0 ? attempt : 1;
  const index = Math.min(safe, WHATSAPP_NL_DRIVER_RETRY_DELAY_MS.length) - 1;
  return WHATSAPP_NL_DRIVER_RETRY_DELAY_MS[index]!;
}

export function whatsAppNlDriverWaitDelayMs(attempt: number): number {
  const safe = Number.isInteger(attempt) && attempt > 0 ? attempt : 1;
  const index = Math.min(safe, WHATSAPP_NL_DRIVER_WAIT_DELAY_MS.length) - 1;
  return WHATSAPP_NL_DRIVER_WAIT_DELAY_MS[index]!;
}

export function whatsAppNlDriverRetryDueAt(
  lastAttemptAt: Date,
  attempt: number,
): Date {
  return new Date(
    lastAttemptAt.getTime() + whatsAppNlDriverRetryDelayMs(attempt),
  );
}

export function whatsAppNlDriverWaitDueAt(
  lastAttemptAt: Date,
  attempt: number,
): Date {
  return new Date(
    lastAttemptAt.getTime() + whatsAppNlDriverWaitDelayMs(attempt),
  );
}

export function formatWhatsAppNlDriverClaimed(
  attempt: number,
  token: string,
): string {
  return `${WHATSAPP_NL_DRIVER_CLAIMED_PREFIX}:${attempt}:${token}`;
}

export function formatWhatsAppNlDriverRetry(attempt: number): string {
  return `${WHATSAPP_NL_DRIVER_RETRY_PREFIX}:${attempt}`;
}

export function formatWhatsAppNlDriverWait(attempt: number): string {
  return `${WHATSAPP_NL_DRIVER_WAIT_PREFIX}:${attempt}`;
}

export function formatWhatsAppNlDriverPark(code: string): string {
  return `${WHATSAPP_NL_DRIVER_PARK_PREFIX}:${code}`;
}

function parseAttempt(raw: string): number | null {
  if (!/^[0-9]+$/.test(raw)) return null;
  const attempt = Number(raw);
  if (!Number.isSafeInteger(attempt) || attempt < 1) return null;
  return attempt;
}

export function parseWhatsAppNlDriverOccupancy(
  errorCode: string | null | undefined,
): WhatsAppNlDriverOccupancy {
  if (errorCode == null || errorCode === "") return { kind: "idle" };
  if (errorCode.startsWith(`${WHATSAPP_NL_DRIVER_CLAIMED_PREFIX}:`)) {
    const rest = errorCode.slice(WHATSAPP_NL_DRIVER_CLAIMED_PREFIX.length + 1);
    const sep = rest.indexOf(":");
    if (sep <= 0) return { kind: "foreign" };
    const attempt = parseAttempt(rest.slice(0, sep));
    const token = rest.slice(sep + 1);
    if (attempt == null || token.length === 0) return { kind: "foreign" };
    return { kind: "claimed", attempt, token };
  }
  if (errorCode.startsWith(`${WHATSAPP_NL_DRIVER_RETRY_PREFIX}:`)) {
    const attempt = parseAttempt(
      errorCode.slice(WHATSAPP_NL_DRIVER_RETRY_PREFIX.length + 1),
    );
    if (attempt == null) return { kind: "foreign" };
    return { kind: "retry", attempt };
  }
  if (errorCode.startsWith(`${WHATSAPP_NL_DRIVER_WAIT_PREFIX}:`)) {
    const attempt = parseAttempt(
      errorCode.slice(WHATSAPP_NL_DRIVER_WAIT_PREFIX.length + 1),
    );
    if (attempt == null) return { kind: "foreign" };
    return { kind: "wait", attempt };
  }
  if (errorCode.startsWith(`${WHATSAPP_NL_DRIVER_PARK_PREFIX}:`)) {
    const code = errorCode.slice(WHATSAPP_NL_DRIVER_PARK_PREFIX.length + 1);
    if (!code) return { kind: "foreign" };
    return { kind: "park", code };
  }
  return { kind: "foreign" };
}

export function nextWhatsAppNlDriverAttempt(
  occupancy: WhatsAppNlDriverOccupancy,
): number {
  if (occupancy.kind === "wait") {
    return occupancy.attempt + 1;
  }
  if (occupancy.kind === "claimed" || occupancy.kind === "retry") {
    return occupancy.attempt;
  }
  return 1;
}

function payloadStillRetryable(input: ClassifyWhatsAppNlDriverOutcomeInput): boolean {
  const expires = input.payloadExpiresAt;
  if (!expires) return true;
  const now = input.now ?? new Date();
  if (expires.getTime() > now.getTime()) return true;
  return input.hasReconcileablePending === true;
}

function retryDecision(
  disposition: "RETRY_INFRA" | "RETRY_STATE_CHANGED",
  attempt: number,
): Extract<WhatsAppNlDriverDecision, { action: "retry" }> {
  const nextAttempt = attempt + 1;
  return {
    action: "retry",
    disposition,
    nextAttempt,
    delayMs: whatsAppNlDriverRetryDelayMs(nextAttempt),
  };
}

function waitDecision(
  attempt: number,
): Extract<WhatsAppNlDriverDecision, { action: "wait" }> {
  return {
    action: "wait",
    disposition: "WAITING_FOR_OTHER_CONVERSATION",
    nextAttempt: attempt,
    delayMs: whatsAppNlDriverWaitDelayMs(attempt),
  };
}

function park(
  disposition: Extract<WhatsAppNlDriverDecision, { action: "park" }>["disposition"],
  code: string,
): Extract<WhatsAppNlDriverDecision, { action: "park" }> {
  return { action: "park", disposition, code };
}

/**
 * Classifica o union B2-C em ação do driver. Não interpreta texto, actor
 * nem pending — só o resultado discriminado + TTL do material.
 */
export function classifyWhatsAppNlDriverOutcome(
  input: ClassifyWhatsAppNlDriverOutcomeInput,
): WhatsAppNlDriverDecision {
  const { result, attempt } = input;
  if (result.ok) {
    return { action: "complete", disposition: "COMPLETE" };
  }

  if (result.kind === "RETRYABLE_INFRA") {
    if (!payloadStillRetryable(input)) {
      return park("TERMINAL_MANUAL", result.code);
    }
    return retryDecision("RETRY_INFRA", attempt);
  }

  return classifyBlocked(result.code, attempt, input);
}

const POISON_CODES = new Set<string>(["INVALID_PAYLOAD"]);

const TERMINAL_CODES = new Set<string>([
  "SOURCE_NOT_FOUND",
  "SOURCE_NOT_READY",
  "SOURCE_NOT_TEXT",
  "SOURCE_TERMINAL",
  "SOURCE_IDENTITY_MISSING",
  "SOURCE_OPERATIONAL_PAYLOAD_UNAVAILABLE",
  "PENDING_EXPIRED",
  "PENDING_TERMINAL",
  "OWNERSHIP_MISMATCH",
  "TERMINAL_DOMAIN_CONFLICT",
  "ACTOR_NOT_FOUND",
  "ACTOR_PROFESSIONAL_NOT_FOUND",
  "ACTOR_PROFESSIONAL_AMBIGUOUS",
  "ACTOR_INSTITUTION_MEMBERSHIP_NOT_FOUND",
]);

function classifyBlocked(
  code: string,
  attempt: number,
  input: ClassifyWhatsAppNlDriverOutcomeInput,
): WhatsAppNlDriverDecision {
  if (code === "STATE_CHANGED") {
    if (!payloadStillRetryable(input)) {
      return park("TERMINAL_MANUAL", code);
    }
    if (attempt >= WHATSAPP_NL_DRIVER_STATE_CHANGED_RETRY_LIMIT) {
      return park("TERMINAL_MANUAL", code);
    }
    return retryDecision("RETRY_STATE_CHANGED", attempt);
  }
  if (code === "ALREADY_OPEN") {
    if (!payloadStillRetryable(input)) {
      return park("TERMINAL_MANUAL", code);
    }
    return waitDecision(attempt);
  }
  if (code === "NEEDS_REFORMULATION") {
    // A) reprocessar o mesmo texto não ajuda. B) só mensagem nova ajuda.
    // Este inbound estaciona. B2-C já terminalizou OPEN/PARSE (#416);
    // o source seguinte cria novo pending — não cai em ALREADY_OPEN/WAIT.
    return park("INSUFFICIENT_MATERIAL", code);
  }
  if (POISON_CODES.has(code)) {
    return park("POISON", code);
  }
  if (TERMINAL_CODES.has(code)) {
    return park("TERMINAL_MANUAL", code);
  }
  return park("TERMINAL_MANUAL", code);
}
