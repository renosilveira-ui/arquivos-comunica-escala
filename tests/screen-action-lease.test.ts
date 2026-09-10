import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isScreenActionLeaseCurrent,
  type ScreenActionLease,
} from "../lib/screen-action-lease";

const lease: ScreenActionLease = {
  userId: 53,
  contextKey: "4:15",
  sequence: 7,
  sessionEpoch: { generation: 3 },
};

const current = {
  mounted: true,
  userId: 53,
  contextKey: "4:15",
  sequence: 7,
  sessionEpochCurrent: true,
};

describe("lease de conclusão assíncrona da tela", () => {
  it("autoriza somente a mesma tela, conta, contexto, sessão e sequência", () => {
    expect(isScreenActionLeaseCurrent(lease, current)).toBe(true);

    for (const stale of [
      { ...current, mounted: false },
      { ...current, userId: 56 },
      { ...current, contextKey: "4:16" },
      { ...current, sequence: 8 },
      { ...current, sessionEpochCurrent: false },
    ]) {
      expect(isScreenActionLeaseCurrent(lease, stale)).toBe(false);
    }
  });

  it("create, troca e indicação cercam sucesso e erro antes de atuar na UI", () => {
    for (const path of [
      "app/create-shift.tsx",
      "app/edit-shift.tsx",
      "app/request-swap.tsx",
      "app/nominate-replacement.tsx",
      "components/agenda/OpenMonthShiftsButton.tsx",
    ]) {
      const screen = readFileSync(path, "utf8");
      expect(screen).toContain("useScreenActionLease");
      expect(screen).toContain("actionLease.capture()");
      expect(screen).toContain("actionLease.isCurrent(");
      expect(screen).toContain("isPending ||");
      expect(screen).toMatch(/LeaseRef\.current !== lease/g);
    }
  });

  it("inclui o contexto operacional que originou cada escrita", () => {
    const create = readFileSync("app/create-shift.tsx", "utf8");
    const swap = readFileSync("app/request-swap.tsx", "utf8");
    const edit = readFileSync("app/edit-shift.tsx", "utf8");
    const nomination = readFileSync("app/nominate-replacement.tsx", "utf8");
    const openMonth = readFileSync(
      "components/agenda/OpenMonthShiftsButton.tsx",
      "utf8",
    );

    expect(create).toContain("selectedScheduleContext.id");
    expect(edit).toContain("shiftData.hospitalId");
    expect(edit).toContain("shiftData.sectorId");
    expect(swap).toContain("selectedFrom.hospitalId");
    expect(swap).toContain("selectedFrom.sectorId");
    expect(nomination).toContain("params.token");
    expect(nomination).toContain("activeInstitutionId != null && params.token");
    expect(nomination).not.toContain('activeInstitutionId ?? "none"');
    expect(openMonth).toContain("selectedContext.hospitalId");
    expect(openMonth).toContain("selectedContext.sectorId");
    expect(openMonth).toContain("selectedContext.scheduleContextId");
    expect(openMonth).toContain("monthKey");
  });

  it("troca usa a operação enviada, não estado mutável, no retorno", () => {
    const screen = readFileSync("app/request-swap.tsx", "utf8");
    expect(screen).toContain('variables.type === "SWAP"');
    expect(screen).not.toContain('type === "SWAP" ? "Troca oferecida');
  });

  it("só publica identidade e contexto na ref depois do commit React", () => {
    const hook = readFileSync("hooks/use-screen-action-lease.ts", "utf8");
    expect(hook).toContain("useCommittedLayoutEffect");
    expect(hook).toContain("mountedRef = useRef(false)");
    expect(hook).toContain("contaminaria a tela ainda vigente");
  });
});
