import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  institutions,
  users,
  whatsappInboundMessages,
  whatsappPendingIntents,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { logger } from "../server/_core/logger";
import {
  advanceWhatsAppPendingFromParse,
  cancelWhatsAppPendingIntent,
  cancelWhatsAppPendingOpenParse,
  createWhatsAppPendingIntent,
  expireWhatsAppPendingIntent,
  getWhatsAppPendingIntentByIdForUser,
} from "../server/integrations/whatsapp/pending-intent-store";
import {
  clarificationInvariantsHold,
  confirmationInvariantsHold,
  type AdvanceWhatsAppPendingFromParseInput,
} from "../server/integrations/whatsapp/pending-intent-payloads";
import { WHATSAPP_PENDING_INTENT_TTL_MS } from "../server/integrations/whatsapp/pending-intent-types";

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

const ownDate = { kind: "OFFSET" as const, days: 0, said: "hoje" };

const parsedSwap = {
  version: 1 as const,
  kind: "SWAP" as const,
  ownShift: {
    date: ownDate,
    period: "NIGHT" as const,
    sectorText: "SR-UNICO-B2A-LOG",
  },
  targetProfessional: { name: "Joao" },
  targetShift: {
    date: { kind: "WEEKDAY" as const, weekday: 5, forceNext: false, said: "sexta" },
    period: null,
    sectorText: null,
  },
};

const parsedCessao = {
  version: 1 as const,
  kind: "CESSAO" as const,
  ownShift: {
    date: ownDate,
    period: "MORNING" as const,
    sectorText: null,
  },
  targetProfessional: { name: "Maria" },
};

const resolvedSwap = {
  version: 1 as const,
  kind: "SWAP" as const,
  institutionId: 1,
  fromShiftInstanceId: 10,
  fromAssignmentId: 11,
  toProfessionalId: 20,
  toShiftInstanceId: 30,
  targetProfessionalName: "Joao Silva",
  ownShift: {
    label: "Plantao 1",
    sectorName: "SR",
    dayKey: "2026-09-04",
    timeRange: "19:00–07:00",
  },
  targetShift: {
    label: "Plantao 2",
    sectorName: "CC",
    dayKey: "2026-09-05",
    timeRange: "07:00–19:00",
  },
};

const shiftCandidate = {
  shiftInstanceId: 44,
  label: "Noite",
  dayKey: "2026-09-06",
  timeRange: "19:00–07:00",
  sectorName: "SR",
  institutionName: "Unimed",
};

const clarificationOwn = {
  version: 1 as const,
  code: "AMBIGUOUS_OWN_SHIFT" as const,
  candidates: [shiftCandidate],
};

const clarificationAmbiguousIntent = {
  version: 1 as const,
  code: "AMBIGUOUS_INTENT" as const,
};

describe("WhatsApp pending advance from PARSE", () => {
  let db: Db;
  let institutionId: number;
  let userA: number;
  let userB: number;
  const stamp = Date.now();
  const inboundIds: number[] = [];
  const userIds: number[] = [];

  async function insertUser(label: string): Promise<number> {
    const name = `wa-b2a-${label}-${stamp}`;
    const [user] = await db
      .insert(users)
      .values({
        name,
        email: `${name}@example.test`,
        passwordHash: "not-used",
        role: "doctor",
        approvalStatus: "APPROVED",
        sessionVersion: 1,
      })
      .$returningId();
    userIds.push(user.id);
    return user.id;
  }

  async function insertInbound(ownerId: number, suffix: string): Promise<number> {
    const [row] = await db
      .insert(whatsappInboundMessages)
      .values({
        provider: "TWILIO",
        providerMessageId: `SMb2a${stamp}${suffix}`,
        userId: ownerId,
        contentKind: "TEXT",
        forwarded: false,
        processingStatus: "READY_FOR_NL",
        operationalText: "slots semânticos futuros",
        receivedAt: new Date(),
        processedAt: new Date(),
      })
      .$returningId();
    inboundIds.push(row.id);
    return row.id;
  }

  async function openParse(ownerId: number, suffix: string, now = new Date()) {
    const sourceId = await insertInbound(ownerId, suffix);
    const created = await createWhatsAppPendingIntent(
      { sourceInboundMessageId: sourceId },
      now,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.code);
    return { sourceId, pendingId: created.row.id, createdAt: now };
  }

  beforeAll(async () => {
    const maybe = await getDb();
    if (!maybe) throw new Error("DB unavailable");
    db = maybe;
    const [institution] = await db.select().from(institutions).limit(1);
    if (!institution) throw new Error("seed institution missing");
    institutionId = institution.id;
    userA = await insertUser("a");
    userB = await insertUser("b");
  });

  afterEach(async () => {
    if (userIds.length === 0) return;
    await db
      .delete(whatsappPendingIntents)
      .where(inArray(whatsappPendingIntents.userId, userIds));
  });

  afterAll(async () => {
    if (userIds.length > 0) {
      await db
        .delete(whatsappPendingIntents)
        .where(inArray(whatsappPendingIntents.userId, userIds));
    }
    if (inboundIds.length > 0) {
      await db
        .delete(whatsappInboundMessages)
        .where(inArray(whatsappInboundMessages.id, inboundIds));
    }
    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
  });

  it("PARSE → CLARIFICATION após parser success persiste kind e não resolved", async () => {
    const { sourceId, pendingId } = await openParse(userA, "clar");
    const result = await advanceWhatsAppPendingFromParse({
      pendingId,
      userId: userA,
      expectedSourceInboundMessageId: sourceId,
      outcome: {
        type: "clarification",
        parsed: parsedSwap,
        clarification: clarificationOwn,
      },
    });
    expect(result).toMatchObject({ ok: true, outcome: "advanced" });
    if (!result.ok) throw new Error(result.code);
    expect(result.row.stage).toBe("CLARIFICATION");
    expect(result.row.intentKind).toBe("SWAP");
    expect(result.row.resolvedPayload).toBeNull();
    expect(result.row.institutionId).toBeNull();
    expect(clarificationInvariantsHold(result.row)).toBe(true);
  });

  it("PARSE → CONFIRMATION preenche invariantes completas", async () => {
    const { sourceId, pendingId } = await openParse(userA, "conf");
    const resolved = { ...resolvedSwap, institutionId };
    const result = await advanceWhatsAppPendingFromParse({
      pendingId,
      userId: userA,
      expectedSourceInboundMessageId: sourceId,
      outcome: {
        type: "resolved",
        parsed: parsedSwap,
        resolved,
      },
    });
    expect(result).toMatchObject({ ok: true, outcome: "advanced" });
    if (!result.ok) throw new Error(result.code);
    expect(result.row.stage).toBe("CONFIRMATION");
    expect(result.row.clarificationPayload).toBeNull();
    expect(result.row.institutionId).toBe(institutionId);
    expect(result.row.intentKind).toBe("SWAP");
    expect(confirmationInvariantsHold(result.row)).toBe(true);
  });

  it("AMBIGUOUS_INTENT não inventa kind", async () => {
    const { sourceId, pendingId } = await openParse(userA, "amb");
    const result = await advanceWhatsAppPendingFromParse({
      pendingId,
      userId: userA,
      expectedSourceInboundMessageId: sourceId,
      outcome: {
        type: "clarification",
        parsed: null,
        clarification: clarificationAmbiguousIntent,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(result.row.intentKind).toBeNull();
    expect(result.row.parsedPayload).toBeNull();
    expect(clarificationInvariantsHold(result.row)).toBe(true);
  });

  it("mesma transição duas vezes é idempotente", async () => {
    const { sourceId, pendingId } = await openParse(userA, "idem");
    const input: AdvanceWhatsAppPendingFromParseInput = {
      pendingId,
      userId: userA,
      expectedSourceInboundMessageId: sourceId,
      outcome: {
        type: "clarification",
        parsed: parsedCessao,
        clarification: clarificationOwn,
      },
    };
    const first = await advanceWhatsAppPendingFromParse(input);
    const [afterFirst] = await db
      .select({ updatedAt: whatsappPendingIntents.updatedAt })
      .from(whatsappPendingIntents)
      .where(eq(whatsappPendingIntents.id, pendingId));
    const second = await advanceWhatsAppPendingFromParse(input);
    const [afterSecond] = await db
      .select({ updatedAt: whatsappPendingIntents.updatedAt })
      .from(whatsappPendingIntents)
      .where(eq(whatsappPendingIntents.id, pendingId));
    expect(first).toMatchObject({ ok: true, outcome: "advanced" });
    expect(second).toMatchObject({ ok: true, outcome: "already_advanced" });
    if (!first.ok || !second.ok) throw new Error("idem");
    expect(afterSecond?.updatedAt.getTime()).toBe(afterFirst?.updatedAt.getTime());
    expect(second.row.stage).toBe(first.row.stage);
    expect(second.row.intentKind).toBe(first.row.intentKind);
  });

  it("segunda transição diferente é STATE_CHANGED", async () => {
    const { sourceId, pendingId } = await openParse(userA, "diff");
    const first = await advanceWhatsAppPendingFromParse({
      pendingId,
      userId: userA,
      expectedSourceInboundMessageId: sourceId,
      outcome: {
        type: "clarification",
        parsed: parsedSwap,
        clarification: clarificationOwn,
      },
    });
    expect(first.ok).toBe(true);
    const second = await advanceWhatsAppPendingFromParse({
      pendingId,
      userId: userA,
      expectedSourceInboundMessageId: sourceId,
      outcome: {
        type: "clarification",
        parsed: parsedCessao,
        clarification: clarificationOwn,
      },
    });
    expect(second).toMatchObject({ ok: false, code: "STATE_CHANGED" });
    if (second.ok) throw new Error("expected miss");
    expect(second.row?.intentKind).toBe("SWAP");
  });

  it("CANCELLED não avança", async () => {
    const { sourceId, pendingId } = await openParse(userA, "cancel");
    const cancelled = await cancelWhatsAppPendingIntent(pendingId, userA);
    expect(cancelled.ok).toBe(true);
    const result = await advanceWhatsAppPendingFromParse({
      pendingId,
      userId: userA,
      expectedSourceInboundMessageId: sourceId,
      outcome: {
        type: "clarification",
        parsed: null,
        clarification: clarificationAmbiguousIntent,
      },
    });
    expect(result).toMatchObject({ ok: false, code: "TERMINAL" });
    const [row] = await db
      .select()
      .from(whatsappPendingIntents)
      .where(eq(whatsappPendingIntents.id, pendingId));
    expect(row?.status).toBe("CANCELLED");
    expect(row?.stage).toBe("PARSE");
  });

  it("EXPIRED não avança", async () => {
    const now = new Date("2026-09-04T12:00:00.000Z");
    const { sourceId, pendingId } = await openParse(userA, "exp", now);
    const due = new Date(now.getTime() + WHATSAPP_PENDING_INTENT_TTL_MS);
    const expired = await expireWhatsAppPendingIntent(pendingId, userA, due);
    expect(expired.ok).toBe(true);
    const result = await advanceWhatsAppPendingFromParse(
      {
        pendingId,
        userId: userA,
        expectedSourceInboundMessageId: sourceId,
        outcome: {
          type: "clarification",
          parsed: null,
          clarification: clarificationAmbiguousIntent,
        },
      },
      due,
    );
    expect(result).toMatchObject({ ok: false, code: "EXPIRED" });
  });

  it("CONSUMED não avança", async () => {
    const { sourceId, pendingId } = await openParse(userA, "cons");
    await db
      .update(whatsappPendingIntents)
      .set({ status: "CONSUMED" })
      .where(eq(whatsappPendingIntents.id, pendingId));
    const result = await advanceWhatsAppPendingFromParse({
      pendingId,
      userId: userA,
      expectedSourceInboundMessageId: sourceId,
      outcome: {
        type: "clarification",
        parsed: null,
        clarification: clarificationAmbiguousIntent,
      },
    });
    expect(result).toMatchObject({ ok: false, code: "TERMINAL" });
    const [row] = await db
      .select()
      .from(whatsappPendingIntents)
      .where(eq(whatsappPendingIntents.id, pendingId));
    expect(row?.status).toBe("CONSUMED");
  });

  it("TTL vencido não avança e marca EXPIRED", async () => {
    const createdAt = new Date("2026-09-04T12:00:00.000Z");
    const { sourceId, pendingId } = await openParse(userA, "ttl", createdAt);
    const later = new Date(createdAt.getTime() + WHATSAPP_PENDING_INTENT_TTL_MS + 1000);
    const result = await advanceWhatsAppPendingFromParse(
      {
        pendingId,
        userId: userA,
        expectedSourceInboundMessageId: sourceId,
        outcome: {
          type: "clarification",
          parsed: null,
          clarification: clarificationAmbiguousIntent,
        },
      },
      later,
    );
    expect(result).toMatchObject({ ok: false, code: "EXPIRED" });
    const [row] = await db
      .select()
      .from(whatsappPendingIntents)
      .where(eq(whatsappPendingIntents.id, pendingId));
    expect(row?.status).toBe("EXPIRED");
  });

  it("outro user não avança", async () => {
    const { sourceId, pendingId } = await openParse(userA, "other");
    const result = await advanceWhatsAppPendingFromParse({
      pendingId,
      userId: userB,
      expectedSourceInboundMessageId: sourceId,
      outcome: {
        type: "clarification",
        parsed: null,
        clarification: clarificationAmbiguousIntent,
      },
    });
    expect(result).toMatchObject({ ok: false, code: "NOT_FOUND" });
    const [row] = await db
      .select()
      .from(whatsappPendingIntents)
      .where(eq(whatsappPendingIntents.id, pendingId));
    expect(row?.status).toBe("OPEN");
    expect(row?.stage).toBe("PARSE");
    expect(row?.userId).toBe(userA);
  });

  it("source errado não avança", async () => {
    const { pendingId } = await openParse(userA, "src1");
    const otherSource = await insertInbound(userA, "src2");
    const result = await advanceWhatsAppPendingFromParse({
      pendingId,
      userId: userA,
      expectedSourceInboundMessageId: otherSource,
      outcome: {
        type: "clarification",
        parsed: null,
        clarification: clarificationAmbiguousIntent,
      },
    });
    expect(result).toMatchObject({ ok: false, code: "STATE_CHANGED" });
    const [row] = await db
      .select()
      .from(whatsappPendingIntents)
      .where(eq(whatsappPendingIntents.id, pendingId));
    expect(row?.stage).toBe("PARSE");
  });

  it("concorrência: um advanced e o outro STATE_CHANGED, row coerente", async () => {
    const { sourceId, pendingId } = await openParse(userA, "race");
    const [first, second] = await Promise.all([
      advanceWhatsAppPendingFromParse({
        pendingId,
        userId: userA,
        expectedSourceInboundMessageId: sourceId,
        outcome: {
          type: "clarification",
          parsed: parsedSwap,
          clarification: clarificationOwn,
        },
      }),
      advanceWhatsAppPendingFromParse({
        pendingId,
        userId: userA,
        expectedSourceInboundMessageId: sourceId,
        outcome: {
          type: "clarification",
          parsed: parsedCessao,
          clarification: clarificationOwn,
        },
      }),
    ]);
    const outcomes = [first, second].map((item) =>
      item.ok ? item.outcome : item.code,
    );
    expect(outcomes.sort()).toEqual(["STATE_CHANGED", "advanced"].sort());
    const winner = first.ok && first.outcome === "advanced" ? first : second;
    expect(winner.ok).toBe(true);
    if (!winner.ok) throw new Error("winner");
    expect(clarificationInvariantsHold(winner.row)).toBe(true);
    expect(["SWAP", "CESSAO"]).toContain(winner.row.intentKind);
  });

  it("concorrência do mesmo payload: um advanced e o outro already_advanced", async () => {
    const { sourceId, pendingId } = await openParse(userA, "raceSame");
    const input: AdvanceWhatsAppPendingFromParseInput = {
      pendingId,
      userId: userA,
      expectedSourceInboundMessageId: sourceId,
      outcome: {
        type: "clarification",
        parsed: parsedSwap,
        clarification: clarificationOwn,
      },
    };
    const [first, second] = await Promise.all([
      advanceWhatsAppPendingFromParse(input),
      advanceWhatsAppPendingFromParse(input),
    ]);
    const outcomes = [first, second].map((item) =>
      item.ok ? item.outcome : item.code,
    );
    expect(outcomes.sort()).toEqual(["advanced", "already_advanced"].sort());
    const rows = [first, second].map((item) => {
      if (!item.ok) throw new Error(item.code);
      return item.row;
    });
    expect(rows[0].intentKind).toBe("SWAP");
    expect(rows[1].intentKind).toBe("SWAP");
    expect(clarificationInvariantsHold(rows[0])).toBe(true);
  });

  it("payload completo não aparece em logs", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(logger, "info").mockImplementation((...args: unknown[]) => {
      lines.push(args.map((item) => String(item)).join(" "));
      return logger;
    });
    const { sourceId, pendingId } = await openParse(userA, "logs");
    await advanceWhatsAppPendingFromParse({
      pendingId,
      userId: userA,
      expectedSourceInboundMessageId: sourceId,
      outcome: {
        type: "clarification",
        parsed: parsedSwap,
        clarification: clarificationOwn,
      },
    });
    spy.mockRestore();
    const joined = lines.join("\n");
    expect(joined).toContain("whatsapp_pending_advanced");
    expect(joined).toContain(String(pendingId));
    expect(joined).not.toContain("SR-UNICO-B2A-LOG");
    expect(joined).not.toContain("Joao");
    expect(joined).not.toMatch(/parsedPayload|resolvedPayload|clarificationPayload/);
  });

  it("cancel PARSE após CLARIFICATION devolve STATE_CHANGED e não destrói o estágio", async () => {
    const { sourceId, pendingId } = await openParse(userA, "c5clar");
    const advanced = await advanceWhatsAppPendingFromParse({
      pendingId,
      userId: userA,
      expectedSourceInboundMessageId: sourceId,
      outcome: {
        type: "clarification",
        parsed: parsedSwap,
        clarification: clarificationOwn,
      },
    });
    expect(advanced).toMatchObject({ ok: true, outcome: "advanced" });
    const cancelled = await cancelWhatsAppPendingOpenParse({
      pendingId,
      userId: userA,
      expectedSourceInboundMessageId: sourceId,
    });
    expect(cancelled).toMatchObject({ ok: false, code: "STATE_CHANGED" });
    const latest = await getWhatsAppPendingIntentByIdForUser(pendingId, userA);
    expect(latest).toMatchObject({
      ok: true,
      row: { status: "OPEN", stage: "CLARIFICATION" },
    });
    if (!latest.ok || !latest.row) throw new Error("missing row");
    expect(clarificationInvariantsHold(latest.row)).toBe(true);
  });

  it("cancel PARSE após CONFIRMATION devolve STATE_CHANGED e não destrói o estágio", async () => {
    const { sourceId, pendingId } = await openParse(userA, "c5conf");
    const resolved = { ...resolvedSwap, institutionId };
    const advanced = await advanceWhatsAppPendingFromParse({
      pendingId,
      userId: userA,
      expectedSourceInboundMessageId: sourceId,
      outcome: {
        type: "resolved",
        parsed: parsedSwap,
        resolved,
      },
    });
    expect(advanced).toMatchObject({ ok: true, outcome: "advanced" });
    const cancelled = await cancelWhatsAppPendingOpenParse({
      pendingId,
      userId: userA,
      expectedSourceInboundMessageId: sourceId,
    });
    expect(cancelled).toMatchObject({ ok: false, code: "STATE_CHANGED" });
    const latest = await getWhatsAppPendingIntentByIdForUser(pendingId, userA);
    expect(latest).toMatchObject({
      ok: true,
      row: { status: "OPEN", stage: "CONFIRMATION" },
    });
    if (!latest.ok || !latest.row) throw new Error("missing row");
    expect(confirmationInvariantsHold(latest.row)).toBe(true);
  });

  it("concorrência advance vs cancel PARSE: vencedor coerente, nunca CLARIFICATION cancelada", async () => {
    const { sourceId, pendingId } = await openParse(userA, "c5race");
    const [advanced, cancelled] = await Promise.all([
      advanceWhatsAppPendingFromParse({
        pendingId,
        userId: userA,
        expectedSourceInboundMessageId: sourceId,
        outcome: {
          type: "clarification",
          parsed: parsedSwap,
          clarification: clarificationOwn,
        },
      }),
      cancelWhatsAppPendingOpenParse({
        pendingId,
        userId: userA,
        expectedSourceInboundMessageId: sourceId,
      }),
    ]);
    const latest = await getWhatsAppPendingIntentByIdForUser(pendingId, userA);
    if (!latest.ok || !latest.row) throw new Error("missing row");
    if (latest.row.stage === "CLARIFICATION") {
      expect(latest.row.status).toBe("OPEN");
      expect(cancelled).toMatchObject({ ok: false, code: "STATE_CHANGED" });
      expect(advanced.ok).toBe(true);
      expect(clarificationInvariantsHold(latest.row)).toBe(true);
    } else {
      expect(latest.row.status).toBe("CANCELLED");
      expect(latest.row.stage).toBe("PARSE");
      expect(cancelled).toMatchObject({ ok: true, outcome: "cancelled" });
      expect(advanced.ok).toBe(false);
      if (!advanced.ok) {
        expect(advanced.code).toBe("TERMINAL");
      }
    }
  });
});
