import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildShiftTimestamps,
  formatHospitalDate,
  formatHospitalTime,
  formatHospitalTimeRange,
  hospitalDateTime,
  toHospitalISODate,
} from "../lib/hospital-time";

const HOSPITAL_TIME_UI = [
  "app/shift-details.tsx",
  "app/edit-shift.tsx",
  "app/(tabs)/dashboard.tsx",
  "app/(tabs)/vacancies.tsx",
  "app/confirm-duty.tsx",
  "app/report.tsx",
  "app/(tabs)/agenda.tsx",
  "components/agenda/ShiftRowCard.tsx",
] as const;

describe("hospital-time", () => {
  it("formata hora no relógio do hospital (-03:00), não no fuso do processo", () => {
    const start = new Date("2026-09-07T10:00:00.000Z");
    const end = new Date("2026-09-07T16:00:00.000Z");
    expect(formatHospitalTime(start)).toBe("07:00");
    expect(formatHospitalTime(end)).toBe("13:00");
    expect(formatHospitalTimeRange(start, end)).toBe("07:00–13:00");
    expect(formatHospitalDate(start)).toBe("07/09/2026");
    expect(formatHospitalDate(new Date("2026-09-02T10:00:00.000-03:00"))).toBe(
      "02/09/2026",
    );
  });

  it("buildShiftTimestamps grava instante UTC do horário de parede", () => {
    const [startAt, endAt] = buildShiftTimestamps(
      "2026-09-07",
      "07:00:00",
      "13:00:00",
    );
    expect(startAt.toISOString()).toBe("2026-09-07T10:00:00.000Z");
    expect(endAt.toISOString()).toBe("2026-09-07T16:00:00.000Z");
  });

  it("buildShiftTimestamps avança término do turno noturno", () => {
    const [startAt, endAt] = buildShiftTimestamps(
      "2026-09-07",
      "19:00:00",
      "07:00:00",
    );
    expect(startAt.toISOString()).toBe("2026-09-07T22:00:00.000Z");
    expect(endAt.toISOString()).toBe("2026-09-08T10:00:00.000Z");
    expect(formatHospitalTimeRange(startAt, endAt)).toBe("19:00–07:00");
  });

  it("toHospitalISODate devolve o dia do hospital, não o do processo", () => {
    // 01:00Z de 08/09 ainda é 07/09 às 22:00 no hospital.
    expect(toHospitalISODate(new Date("2026-09-08T01:00:00.000Z"))).toBe(
      "2026-09-07",
    );
    expect(toHospitalISODate(new Date("2026-09-07T10:00:00.000Z"))).toBe(
      "2026-09-07",
    );
  });

  it("hospitalDateTime ancora o campo do formulário em -03:00", () => {
    expect(hospitalDateTime("2026-09-07", "07:00").toISOString()).toBe(
      "2026-09-07T10:00:00.000Z",
    );
    expect(hospitalDateTime("2026-09-07", "19:00").toISOString()).toBe(
      "2026-09-07T22:00:00.000Z",
    );
  });

  it("editar plantão faz a volta completa sem passar pelo fuso do aparelho", () => {
    // O que o servidor devolve → o que o formulário mostra → o que é gravado.
    const doServidor = new Date("2026-09-07T22:00:00.000Z");
    const data = toHospitalISODate(doServidor);
    const hora = formatHospitalTime(doServidor);
    expect([data, hora]).toEqual(["2026-09-07", "19:00"]);
    expect(hospitalDateTime(data, hora).toISOString()).toBe(
      doServidor.toISOString(),
    );
  });

  it("telas de plantão usam o relógio do hospital, não o fuso do dispositivo", () => {
    for (const file of HOSPITAL_TIME_UI) {
      const source = readFileSync(file, "utf8");
      expect(source, file).toMatch(/formatHospitalTime(Range)?/);
      expect(source, file).not.toContain("toLocaleTimeString");
      expect(source, file).not.toMatch(/\.getHours\s*\(/);
    }
  });
});
