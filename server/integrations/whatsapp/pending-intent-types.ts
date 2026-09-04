export const WHATSAPP_PENDING_INTENT_TTL_MS = 15 * 60 * 1000;

export function pendingExpiresAtFrom(now: Date = new Date()): Date {
  return new Date(now.getTime() + WHATSAPP_PENDING_INTENT_TTL_MS);
}

export const WhatsAppPendingStatuses = {
  OPEN: "OPEN",
  CANCELLED: "CANCELLED",
  EXPIRED: "EXPIRED",
  CONSUMED: "CONSUMED",
} as const;
export type WhatsAppPendingStatus =
  (typeof WhatsAppPendingStatuses)[keyof typeof WhatsAppPendingStatuses];

export const WhatsAppPendingStages = {
  PARSE: "PARSE",
  CLARIFICATION: "CLARIFICATION",
  CONFIRMATION: "CONFIRMATION",
  EXECUTION: "EXECUTION",
} as const;
export type WhatsAppPendingStage =
  (typeof WhatsAppPendingStages)[keyof typeof WhatsAppPendingStages];

export const WhatsAppPendingIntentKinds = {
  SWAP: "SWAP",
  CESSAO: "CESSAO",
} as const;
export type WhatsAppPendingIntentKind =
  (typeof WhatsAppPendingIntentKinds)[keyof typeof WhatsAppPendingIntentKinds];

export const WHATSAPP_PENDING_TERMINAL_STATUSES = [
  WhatsAppPendingStatuses.CANCELLED,
  WhatsAppPendingStatuses.EXPIRED,
  WhatsAppPendingStatuses.CONSUMED,
] as const;

export function isWhatsAppPendingTerminalStatus(
  status: string,
): status is (typeof WHATSAPP_PENDING_TERMINAL_STATUSES)[number] {
  return (WHATSAPP_PENDING_TERMINAL_STATUSES as readonly string[]).includes(
    status,
  );
}

export type CreateWhatsAppPendingIntentInput = {
  sourceInboundMessageId: number;
};

export type WhatsAppPendingIntentRecord = {
  id: number;
  userId: number;
  sourceInboundMessageId: number;
  institutionId: number | null;
  status: string;
  stage: string;
  intentKind: string | null;
  parsedPayload: unknown;
  resolvedPayload: unknown;
  clarificationPayload: unknown;
  expiresAt: Date;
  consumedAt: Date | null;
  payloadClearedAt: Date | null;
};

export type WhatsAppPendingStoreResult =
  | { ok: true; outcome: "created"; row: WhatsAppPendingIntentRecord }
  | { ok: true; outcome: "replay"; row: WhatsAppPendingIntentRecord }
  | { ok: true; outcome: "already_open"; row: WhatsAppPendingIntentRecord }
  | { ok: true; outcome: "already_terminal"; row: WhatsAppPendingIntentRecord }
  | {
      ok: false;
      code:
        | "DB_UNAVAILABLE"
        | "SOURCE_INBOUND_NOT_FOUND"
        | "SOURCE_INBOUND_NOT_READY"
        | "SOURCE_INBOUND_IDENTITY_MISSING"
        | "PERSISTENCE_FAILED";
    };

export type WhatsAppPendingMutationResult =
  | { ok: true; outcome: "updated"; row: WhatsAppPendingIntentRecord }
  | { ok: true; outcome: "already_terminal"; row: WhatsAppPendingIntentRecord }
  | { ok: true; outcome: "not_due"; row: WhatsAppPendingIntentRecord }
  | {
      ok: false;
      code: "DB_UNAVAILABLE" | "NOT_FOUND" | "PERSISTENCE_FAILED";
    };

export type WhatsAppPendingReadResult =
  | { ok: true; row: WhatsAppPendingIntentRecord | null }
  | { ok: false; code: "DB_UNAVAILABLE" | "PERSISTENCE_FAILED" };

/** Distingue outage de ausência — callers B2+ não devem tratar `row === null`. */
export function isWhatsAppPendingReadFailure(
  result: WhatsAppPendingReadResult,
): result is { ok: false; code: "DB_UNAVAILABLE" | "PERSISTENCE_FAILED" } {
  return result.ok === false;
}

export type WhatsAppPendingCleanupResult = {
  expired: number;
  payloadsCleared: number;
};
