import { describe, expect, it } from "vitest";

import { listBrazilCearaHolidays } from "../server/calendar-holidays";

describe("Agenda — feriados nacionais e estaduais do Ceará", () => {
  it("lista o calendário legal de 2026 sem promover ponto facultativo", () => {
    const holidays = listBrazilCearaHolidays(2026);

    expect(holidays).toContainEqual(
      expect.objectContaining({
        date: "2026-04-03",
        name: "Paixão de Cristo",
        scope: "NATIONAL",
      }),
    );
    expect(holidays).toContainEqual({
      date: "2026-03-25",
      name: "Data Magna do Ceará",
      scope: "STATE",
      countryCode: "BR",
      stateCode: "CE",
      source: "STATUTORY_CALENDAR",
    });
    expect(holidays).toContainEqual(
      expect.objectContaining({
        date: "2026-11-20",
        scope: "NATIONAL",
      }),
    );
    expect(holidays.some((holiday) => /carnaval/i.test(holiday.name))).toBe(
      false,
    );
    expect(
      holidays.some((holiday) => /corpus christi/i.test(holiday.name)),
    ).toBe(false);
  });

  it("calcula a Paixão de Cristo em anos distintos e mantém ordem estável", () => {
    const holidays2027 = listBrazilCearaHolidays(2027);
    const holidays2028 = listBrazilCearaHolidays(2028);

    expect(holidays2027).toContainEqual(
      expect.objectContaining({ date: "2027-03-26", name: "Paixão de Cristo" }),
    );
    expect(holidays2028).toContainEqual(
      expect.objectContaining({ date: "2028-04-14", name: "Paixão de Cristo" }),
    );
    expect(holidays2028.map((holiday) => holiday.date)).toEqual(
      [...holidays2028].map((holiday) => holiday.date).sort(),
    );
  });

  it("respeita a vigência do feriado nacional de 20 de novembro", () => {
    expect(
      listBrazilCearaHolidays(2023).some(
        (holiday) => holiday.date === "2023-11-20",
      ),
    ).toBe(false);
    expect(
      listBrazilCearaHolidays(2024).some(
        (holiday) => holiday.date === "2024-11-20",
      ),
    ).toBe(true);
  });

  it("recusa anos fora do contrato", () => {
    expect(() => listBrazilCearaHolidays(1999)).toThrow(RangeError);
    expect(() => listBrazilCearaHolidays(2101)).toThrow(RangeError);
    expect(() => listBrazilCearaHolidays(2026.5)).toThrow(RangeError);
  });
});
