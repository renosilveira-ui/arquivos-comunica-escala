import { describe, expect, it } from "vitest";
import {
  shiftCapacityLabel,
  shiftCapacitySummary,
  summarizeShiftCapacityStats,
} from "../lib/shift-capacity";
import {
  assertProjectedShiftCapacity,
  assertDistinctShiftSlots,
  hospitalClock,
  shiftSlotKey,
} from "../server/shift-capacity";
import { deriveVacancyDashboard } from "../lib/vacancy-dashboard";

describe("shift capacity contract", () => {
  it.each([
    [3, 0, 3],
    [3, 2, 1],
    [3, 3, 0],
    [3, 4, 0],
    [null, 3, 0],
    [null, 0, 1],
  ] as const)(
    "capacity %s, active %s gives %s available places",
    (capacity, active, remaining) => {
      expect(shiftCapacitySummary(capacity, active).remainingCapacity).toBe(
        remaining,
      );
    },
  );
  it.each([0, -1, 1.5, NaN, Infinity, 1001])(
    "rejects malformed capacity %s",
    (value) => {
      expect(() => shiftCapacitySummary(value, 0)).toThrow();
    },
  );
  it("does not alias names, institutions or schedules, and detects ambiguous historical sources", () => {
    const slot = {
      institutionId: 1,
      hospitalId: 1,
      sectorId: 1,
      scheduleContextId: 1,
      startAt: new Date("2027-01-01T22:00:00Z"),
      endAt: new Date("2027-01-02T10:00:00Z"),
      requiredCapacity: 2,
    };
    expect(hospitalClock(slot.startAt)).toBe("19:00:00");
    expect(() => assertDistinctShiftSlots([slot, { ...slot }])).toThrow(
      /duplicados/,
    );
    expect(() =>
      assertDistinctShiftSlots([slot, { ...slot, scheduleContextId: 2 }]),
    ).not.toThrow();
    expect(shiftSlotKey(slot)).not.toBe(
      shiftSlotKey({ ...slot, institutionId: 2 }),
    );
    const shorter = { ...slot, endAt: new Date("2027-01-02T02:00:00Z") };
    expect(() => assertDistinctShiftSlots([slot, shorter])).not.toThrow();
    expect(() =>
      assertDistinctShiftSlots([{ ...slot, requiredCapacity: null }, shorter]),
    ).toThrow(/legada/);
  });
  it("labels occupancy and counts remaining places, not extra turn records", () => {
    expect(shiftCapacitySummary(null, 0, "PENDENTE").remainingCapacity).toBe(0);
    expect(shiftCapacitySummary(3, 1, "OCUPADO").remainingCapacity).toBe(2);
    expect(shiftCapacityLabel(null, 2)).toBe("2 profissionais");
    expect(shiftCapacityLabel(3, 2)).toBe("2/3 preenchidos");
    const report = deriveVacancyDashboard(
      [
        { hospitalId: 1, sectorId: 2, remainingCapacity: 2 },
        { hospitalId: 1, sectorId: 3, remainingCapacity: 1 },
      ],
      {},
    );
    expect(report.visibleRows).toHaveLength(2);
    expect(report.counts).toEqual({
      total: 3,
      vacanciesByHospital: { 1: 3 },
      vacanciesBySector: { 2: 2, 3: 1 },
    });
    expect(
      summarizeShiftCapacityStats([
        { status: "OCUPADO", remainingCapacity: 2 },
        { status: "PENDENTE", remainingCapacity: 0 },
        { status: "VAGO" },
      ]),
    ).toEqual({ total: 3, vago: 3, pendente: 1, ocupado: 1 });
  });

  it("treats a legacy shift as one place only while it is truly vacant", () => {
    expect(
      assertProjectedShiftCapacity(
        { requiredCapacity: null, status: "VAGO" },
        0,
        1,
      ),
    ).toBe(1);
    expect(() =>
      assertProjectedShiftCapacity(
        { requiredCapacity: null, status: "OCUPADO" },
        0,
        1,
      ),
    ).toThrow(/não está mais vago/);
    expect(() =>
      assertProjectedShiftCapacity(
        { requiredCapacity: null, status: "VAGO" },
        1,
        1,
      ),
    ).toThrow(/não está mais vago/);
  });

  it("does not use a hidden fallback to expand legacy capacity", () => {
    expect(() =>
      assertProjectedShiftCapacity(
        { requiredCapacity: null, status: "OCUPADO" },
        19,
        1,
      ),
    ).toThrow(/não está mais vago/);
    expect(
      assertProjectedShiftCapacity(
        { requiredCapacity: null, status: "OCUPADO" },
        3,
        0,
      ),
    ).toBe(3);
    expect(
      assertProjectedShiftCapacity(
        { requiredCapacity: null, status: "OCUPADO" },
        3,
        -1,
      ),
    ).toBe(2);
  });

  it("enforces explicit capacity for every increasing writer", () => {
    expect(
      assertProjectedShiftCapacity(
        { requiredCapacity: 3, status: "OCUPADO" },
        2,
        1,
      ),
    ).toBe(3);
    expect(() =>
      assertProjectedShiftCapacity(
        { requiredCapacity: 3, status: "OCUPADO" },
        3,
        1,
      ),
    ).toThrow(/Limite de 3 profissionais/);
    expect(() =>
      assertProjectedShiftCapacity(
        { requiredCapacity: 3, status: "OCUPADO" },
        0,
        -1,
      ),
    ).toThrow(/total de profissionais/);
  });
});
