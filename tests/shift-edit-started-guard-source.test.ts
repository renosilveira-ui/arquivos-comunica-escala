import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("server/shifts-crud.ts", "utf8");

describe("wiring da cerca temporal em shifts.update", () => {
  it("aplica a cerca depois do lock e antes da escrita/efeitos operacionais", () => {
    const updateStart = source.indexOf("update: protectedProcedure");
    const updateSource = source.slice(updateStart);
    const lock = updateSource.indexOf('.for("update")');
    const guard = updateSource.indexOf("assertMaterialShiftEditIsFuture({");
    const write = updateSource.indexOf(".update(shiftInstances)");
    const dutySync = updateSource.indexOf("await enqueueDutySyncIntervalRewrite");

    expect(updateStart).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(lock);
    expect(write).toBeGreaterThan(guard);
    expect(dutySync).toBeGreaterThan(write);
  });

  it("classifica apenas janela ou modalidade como mudança material", () => {
    expect(source).toContain(
      "windowChanged || nextDutyType !== previousDutyType",
    );
    expect(source).toContain(
      "materialChanged: confirmationCycleChanged",
    );
    expect(source).toContain("originalStartAt: locked.startAt");
    expect(source).toContain("effectiveStartAt,");
  });
});
