import { describe, expect, it } from "vitest";

import { calendarRouter } from "../server/calendar";
import {
  addDaysToKey,
  addMonthsYearMonth,
  dayWindowBrt,
  isValidDayKeyBrt,
  isValidYearMonthBrt,
  weekdayOfKey,
} from "../server/local-time";
import { appRouter } from "../server/routers";
import { shiftsRouter } from "../server/shifts-crud";

const ctx = {
  user: {
    id: 1,
    role: "manager" as const,
    name: "Teste",
    email: "civil-date@test.local",
    sessionVersion: 1,
  },
  institutionId: 1,
  allowedInstitutionIds: [1],
} as any;

describe("contrato de datas civis", () => {
  it("preserva anos 0001-0099 e recusa overflow fora do contrato", () => {
    expect(isValidDayKeyBrt("0001-01-01")).toBe(true);
    expect(isValidYearMonthBrt("0001-01")).toBe(true);
    expect(isValidYearMonthBrt("0000-01")).toBe(false);
    expect(isValidYearMonthBrt("2026-13")).toBe(false);
    expect(dayWindowBrt("0001-01-01").start.toISOString()).toBe(
      "0001-01-01T03:00:00.000Z",
    );
    expect(addDaysToKey("0001-01-01", 1)).toBe("0001-01-02");
    expect(addDaysToKey("0099-12-31", 1)).toBe("0100-01-01");
    expect(weekdayOfKey("0001-01-01")).toBe(1);
    expect(addMonthsYearMonth("0001-01", 1)).toBe("0001-02");
    expect(() => addDaysToKey("0001-01-01", -1)).toThrow(RangeError);
    expect(() => addMonthsYearMonth("0001-01", -1)).toThrow(RangeError);
  });

  it("rejeita dias e meses impossíveis antes de entrar no resolver", async () => {
    const app = appRouter.createCaller(ctx);
    const calendar = calendarRouter.createCaller(ctx);
    const shifts = shiftsRouter.createCaller(ctx);
    const calls = [
      () => app.shiftInstances.listVacancies({ date: "2026-02-31" }),
      () => app.filters.summaryCounts({ date: "2026-02-31" }),
      () => app.filters.actionableVacancyCounts({ date: "2026-02-31" }),
      () => app.shiftAssignments.listPending({ date: "2026-02-31" }),
      () => app.audit.listShiftMovements({ fromDate: "2026-02-31" }),
      () =>
        calendar.getDay({
          institutionId: 1,
          hospitalId: 1,
          sectorId: 1,
          date: "2026-02-31",
        }),
      () =>
        calendar.getMonthGrid({
          institutionId: 1,
          hospitalId: 1,
          sectorId: 1,
          yearMonth: "2026-13",
        }),
      () => shifts.rosterStatus({ hospitalId: 1, yearMonth: "0000-01" }),
      () =>
        app.corporateReadiness.get({
          hospitalId: 1,
          yearMonth: "2026-13",
        }),
    ];

    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
  });
});
