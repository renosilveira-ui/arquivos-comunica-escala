import { describe, expect, it } from "vitest";
import { scheduleContextReadinessFailures } from "../scripts/check-schedule-context-readiness";

const green = {
  futureUnclassifiedShifts: 0,
  invalidShiftTopology: 0,
  invalidScheduleContextTopology: 0,
  duplicateActiveSectorContexts: 0,
  doubleQualifiedProfessionals: 0,
  unclassifiedLegacyProfessionals: 0,
  ambiguousBroadAccesses: 0,
} as const;

describe("gate de readiness multissetorial", () => {
  it("aprova somente quando todos os contadores são zero", () => {
    expect(scheduleContextReadinessFailures(green)).toEqual([]);
  });

  it.each(Object.keys(green) as (keyof typeof green)[])(
    "bloqueia quando %s não foi reconciliado",
    (field) => {
      expect(
        scheduleContextReadinessFailures({ ...green, [field]: 1 }),
      ).toEqual([`${field}=1`]);
    },
  );
});
