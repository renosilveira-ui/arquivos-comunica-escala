import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  MAX_LIST_PERIOD_DAYS,
  MAX_LIST_PERIOD_MS,
  assertListPeriodWindow,
  isValidCivilDateKey,
  isValidIsoInstant,
  resolveListPeriodBound,
} from "../server/shifts-crud";
import { addDaysToKey } from "../server/local-time";

function expectBadRequest(run: () => void, message?: string) {
  try {
    run();
    throw new Error("esperava BAD_REQUEST");
  } catch (error) {
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe("BAD_REQUEST");
    if (message) expect((error as TRPCError).message).toContain(message);
  }
}

describe("listByPeriod — contrato de formato e teto (93 * 24h)", () => {
  it("aceita date-only civil e rejeita calendário impossível", () => {
    expect(isValidCivilDateKey("2026-09-01")).toBe(true);
    expect(isValidCivilDateKey("2028-02-29")).toBe(true);
    expect(isValidCivilDateKey("2026-02-29")).toBe(false);
    expect(isValidCivilDateKey("2026-13-01")).toBe(false);
    expect(isValidCivilDateKey("09/03/2026")).toBe(false);
  });

  it("aceita ISO com Z ou offset e rejeita instante sem fuso", () => {
    expect(isValidIsoInstant("2026-09-01T10:00:00.000Z")).toBe(true);
    expect(isValidIsoInstant("2026-09-01T10:00:00-03:00")).toBe(true);
    expect(isValidIsoInstant("2026-09-01T10:00:00")).toBe(false);
    expect(isValidIsoInstant("2026-09-03 12:00")).toBe(false);
    expect(isValidIsoInstant("2026-02-29T10:00:00.000Z")).toBe(false);
  });

  it("date-only: mesmo dia é um dia civil inteiro; ISO start=end é vazio", () => {
    const start = resolveListPeriodBound("2026-09-01", "start");
    const end = resolveListPeriodBound("2026-09-01", "end");
    expect(start.toISOString()).toBe("2026-09-01T03:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-02T03:00:00.000Z");
    expect(() => assertListPeriodWindow(start, end)).not.toThrow();

    const instant = "2026-09-01T10:00:00.000-03:00";
    expectBadRequest(() =>
      assertListPeriodWindow(
        resolveListPeriodBound(instant, "start"),
        resolveListPeriodBound(instant, "end"),
      ),
    );
  });

  it("teto: exatamente 93 * 24h passa; +1 ms e 94 dias civis falham", () => {
    const isoStart = new Date("2026-01-01T00:00:00.000Z");
    const isoEndExact = new Date(isoStart.getTime() + MAX_LIST_PERIOD_MS);
    const isoEndOver = new Date(isoEndExact.getTime() + 1);
    expect(() => assertListPeriodWindow(isoStart, isoEndExact)).not.toThrow();
    expectBadRequest(
      () => assertListPeriodWindow(isoStart, isoEndOver),
      "93 dias",
    );

    const dayStart = "2026-01-01";
    const dayEnd93 = addDaysToKey(dayStart, MAX_LIST_PERIOD_DAYS - 1);
    const dayEnd94 = addDaysToKey(dayStart, MAX_LIST_PERIOD_DAYS);
    expect(() =>
      assertListPeriodWindow(
        resolveListPeriodBound(dayStart, "start"),
        resolveListPeriodBound(dayEnd93, "end"),
      ),
    ).not.toThrow();
    expectBadRequest(
      () =>
        assertListPeriodWindow(
          resolveListPeriodBound(dayStart, "start"),
          resolveListPeriodBound(dayEnd94, "end"),
        ),
      "93 dias",
    );
  });

  it("janela de anos e start > end falham; lixo não vira Invalid Date", () => {
    expectBadRequest(() =>
      assertListPeriodWindow(
        resolveListPeriodBound("1900-01-01", "start"),
        resolveListPeriodBound("2200-01-01", "end"),
      ),
    );
    expectBadRequest(() =>
      assertListPeriodWindow(
        resolveListPeriodBound("2026-09-10", "start"),
        resolveListPeriodBound("2026-09-01", "end"),
      ),
    );
    expectBadRequest(() => resolveListPeriodBound("lixo", "start"));
    expectBadRequest(() => resolveListPeriodBound("2026-09-01T10:00:00", "start"));
    const trimmed = resolveListPeriodBound("  2026-09-01  ", "start");
    expect(trimmed.toISOString()).toBe("2026-09-01T03:00:00.000Z");
    expect(resolveListPeriodBound("2028-02-29", "start").toISOString()).toBe(
      "2028-02-29T03:00:00.000Z",
    );
  });
});

describe("listByPeriod — callers e fail-fast (source)", () => {
  it("pending.tsx pede D−1…D+7 e os chips continuam D…D+6", () => {
    const pending = readFileSync("app/(tabs)/pending.tsx", "utf8");
    expect(pending).toContain("getDate() - 1");
    expect(pending).toContain("getDate() + 7");
    expect(pending).not.toContain("getDate() - 30");
    expect(pending).not.toContain("getDate() + 90");
    expect(pending).toContain("length: 7");
    expect(pending).toContain("now.getDate() + i");

    const windowStart = pending.indexOf("const myShiftsStart");
    const windowEnd = pending.indexOf("trpc.shifts.listByPeriod.useQuery");
    const window = pending.slice(windowStart, windowEnd);
    expect(window).toContain("getDate() - 1");
    expect(window).toContain("getDate() + 7");
  });

  it("gestor não renderiza myShifts; a largura da query não é requisito da visão", () => {
    const pending = readFileSync("app/(tabs)/pending.tsx", "utf8");
    const managerJsx = pending.slice(pending.indexOf("Solicitações"));
    expect(managerJsx).toContain("pendingAssignments");
    expect(managerJsx).not.toContain("myShifts.map");
    expect(managerJsx).not.toContain("Nenhum plantão seu neste dia");
    expect(pending).toContain("if (!isManagerView)");
  });

  it("o teto é aplicado no handler antes do SELECT de shift_instances", () => {
    const source = readFileSync("server/shifts-crud.ts", "utf8");
    const handler = source.slice(source.indexOf("listByPeriod: protectedProcedure"));
    const assertAt = handler.indexOf("assertListPeriodWindow(start, end)");
    const selectAt = handler.indexOf("instance: shiftInstances");
    expect(assertAt).toBeGreaterThan(-1);
    expect(selectAt).toBeGreaterThan(assertAt);
  });
});
