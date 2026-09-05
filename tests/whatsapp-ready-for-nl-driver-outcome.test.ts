import { describe, expect, it } from "vitest";
import {
  classifyWhatsAppNlDriverOutcome,
  formatWhatsAppNlDriverClaimed,
  formatWhatsAppNlDriverPark,
  formatWhatsAppNlDriverRetry,
  nextWhatsAppNlDriverAttempt,
  parseWhatsAppNlDriverOccupancy,
  whatsAppNlDriverRetryDelayMs,
  whatsAppNlDriverRetryDueAt,
  WHATSAPP_NL_DRIVER_RETRY_ATTEMPT_SQL_OFFSET,
  WHATSAPP_NL_DRIVER_RETRY_DELAY_MS,
  WHATSAPP_NL_DRIVER_RETRY_PREFIX,
  WHATSAPP_NL_DRIVER_STATE_CHANGED_RETRY_LIMIT,
} from "../server/integrations/whatsapp/ready-for-nl-driver-occupancy";
import type { ProcessWhatsAppReadyForNlInboundResult } from "../server/integrations/whatsapp/ready-for-nl-types";

function success(
  kind: "ADVANCED" | "REPLAY",
  stage: "CLARIFICATION" | "CONFIRMATION",
): ProcessWhatsAppReadyForNlInboundResult {
  return { ok: true, kind, stage, pendingId: 9 };
}

function infra(
  code: "DB_UNAVAILABLE" | "PERSISTENCE_FAILED" | "INTERNAL_FAILURE",
): ProcessWhatsAppReadyForNlInboundResult {
  return { ok: false, kind: "RETRYABLE_INFRA", code };
}

function blocked(
  code: Extract<
    ProcessWhatsAppReadyForNlInboundResult,
    { ok: false; kind: "BLOCKED" }
  >["code"],
): ProcessWhatsAppReadyForNlInboundResult {
  return { ok: false, kind: "BLOCKED", code };
}

describe("WhatsApp B2-D — classificação de outcome", () => {
  it("SUCCESS ADVANCED/REPLAY × CLARIFICATION/CONFIRMATION encerra o work", () => {
    for (const kind of ["ADVANCED", "REPLAY"] as const) {
      for (const stage of ["CLARIFICATION", "CONFIRMATION"] as const) {
        expect(
          classifyWhatsAppNlDriverOutcome({
            result: success(kind, stage),
            attempt: 1,
          }),
        ).toEqual({ action: "complete", disposition: "COMPLETE" });
      }
    }
  });

  it("RETRYABLE_INFRA volta para retry com backoff, nunca terminal na 1ª falha", () => {
    for (const code of [
      "DB_UNAVAILABLE",
      "PERSISTENCE_FAILED",
      "INTERNAL_FAILURE",
    ] as const) {
      const decision = classifyWhatsAppNlDriverOutcome({
        result: infra(code),
        attempt: 1,
      });
      expect(decision).toMatchObject({
        action: "retry",
        disposition: "RETRY_INFRA",
        nextAttempt: 2,
        delayMs: WHATSAPP_NL_DRIVER_RETRY_DELAY_MS[1],
      });
    }
  });

  it("infra persistente usa backoff crescente e respeita TTL sem pending", () => {
    expect(whatsAppNlDriverRetryDelayMs(1)).toBe(30_000);
    expect(whatsAppNlDriverRetryDelayMs(2)).toBe(120_000);
    expect(whatsAppNlDriverRetryDelayMs(3)).toBe(600_000);
    expect(whatsAppNlDriverRetryDelayMs(4)).toBe(1_800_000);
    expect(whatsAppNlDriverRetryDelayMs(5)).toBe(3_600_000);
    expect(whatsAppNlDriverRetryDelayMs(99)).toBe(3_600_000);
    const now = new Date("2026-09-05T12:00:00.000Z");
    const expired = new Date("2026-09-05T11:00:00.000Z");
    expect(
      classifyWhatsAppNlDriverOutcome({
        result: infra("DB_UNAVAILABLE"),
        attempt: 8,
        now,
        payloadExpiresAt: expired,
        hasReconcileablePending: false,
      }),
    ).toEqual({
      action: "park",
      disposition: "TERMINAL_MANUAL",
      code: "DB_UNAVAILABLE",
    });
    expect(
      classifyWhatsAppNlDriverOutcome({
        result: infra("DB_UNAVAILABLE"),
        attempt: 8,
        now,
        payloadExpiresAt: expired,
        hasReconcileablePending: true,
      }).action,
    ).toBe("retry");
  });

  it("WAITING_FOR_DIFFERENT_INPUT não entra em hot loop", () => {
    expect(
      classifyWhatsAppNlDriverOutcome({
        result: blocked("ALREADY_OPEN"),
        attempt: 1,
      }),
    ).toEqual({
      action: "park",
      disposition: "WAITING_FOR_DIFFERENT_INPUT",
      code: "ALREADY_OPEN",
    });
    expect(
      classifyWhatsAppNlDriverOutcome({
        result: blocked("NEEDS_REFORMULATION"),
        attempt: 1,
      }),
    ).toEqual({
      action: "park",
      disposition: "WAITING_FOR_DIFFERENT_INPUT",
      code: "NEEDS_REFORMULATION",
    });
  });

  it("domínio terminal / actor inválido / poison são PARK, não retry quente", () => {
    const terminal = [
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
    ] as const;
    for (const code of terminal) {
      expect(
        classifyWhatsAppNlDriverOutcome({ result: blocked(code), attempt: 1 }),
      ).toEqual({
        action: "park",
        disposition: "TERMINAL_MANUAL",
        code,
      });
    }
    expect(
      classifyWhatsAppNlDriverOutcome({
        result: blocked("INVALID_PAYLOAD"),
        attempt: 1,
      }),
    ).toEqual({
      action: "park",
      disposition: "POISON",
      code: "INVALID_PAYLOAD",
    });
  });

  it("STATE_CHANGED retenta com limite e depois estaciona", () => {
    const retrying = classifyWhatsAppNlDriverOutcome({
      result: blocked("STATE_CHANGED"),
      attempt: 1,
    });
    expect(retrying).toMatchObject({
      action: "retry",
      disposition: "RETRY_STATE_CHANGED",
      nextAttempt: 2,
    });
    expect(
      classifyWhatsAppNlDriverOutcome({
        result: blocked("STATE_CHANGED"),
        attempt: WHATSAPP_NL_DRIVER_STATE_CHANGED_RETRY_LIMIT,
      }),
    ).toEqual({
      action: "park",
      disposition: "TERMINAL_MANUAL",
      code: "STATE_CHANGED",
    });
  });

  it("código BLOCKED desconhecido é fail-closed (PARK), não retry infinito", () => {
    const result = {
      ok: false,
      kind: "BLOCKED",
      code: "NOT_A_REAL_CODE",
    } as unknown as ProcessWhatsAppReadyForNlInboundResult;
    expect(
      classifyWhatsAppNlDriverOutcome({ result, attempt: 1 }),
    ).toEqual({
      action: "park",
      disposition: "TERMINAL_MANUAL",
      code: "NOT_A_REAL_CODE",
    });
  });

  it("ocupação CLAIMED/RETRY/PARK cabe em VARCHAR(64) e parseia", () => {
    const claimed = formatWhatsAppNlDriverClaimed(3, "deadbeef");
    expect(claimed.length).toBeLessThanOrEqual(64);
    expect(parseWhatsAppNlDriverOccupancy(claimed)).toEqual({
      kind: "claimed",
      attempt: 3,
      token: "deadbeef",
    });
    const retry = formatWhatsAppNlDriverRetry(4);
    expect(parseWhatsAppNlDriverOccupancy(retry)).toEqual({
      kind: "retry",
      attempt: 4,
    });
    const longPark = formatWhatsAppNlDriverPark(
      "ACTOR_INSTITUTION_MEMBERSHIP_NOT_FOUND",
    );
    expect(longPark.length).toBeLessThanOrEqual(64);
    expect(parseWhatsAppNlDriverOccupancy(longPark)).toEqual({
      kind: "park",
      code: "ACTOR_INSTITUTION_MEMBERSHIP_NOT_FOUND",
    });
    expect(parseWhatsAppNlDriverOccupancy(null)).toEqual({ kind: "idle" });
    expect(parseWhatsAppNlDriverOccupancy("IDENTITY_NOT_FOUND")).toEqual({
      kind: "foreign",
    });
    expect(nextWhatsAppNlDriverAttempt({ kind: "idle" })).toBe(1);
    expect(
      nextWhatsAppNlDriverAttempt({ kind: "claimed", attempt: 7, token: "x" }),
    ).toBe(7);
    expect(WHATSAPP_NL_DRIVER_RETRY_ATTEMPT_SQL_OFFSET).toBe(
      WHATSAPP_NL_DRIVER_RETRY_PREFIX.length + 2,
    );
    const last = new Date("2026-09-05T12:00:00.000Z");
    expect(whatsAppNlDriverRetryDueAt(last, 1).toISOString()).toBe(
      "2026-09-05T12:00:30.000Z",
    );
  });
});
