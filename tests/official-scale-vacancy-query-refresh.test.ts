import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  invalidateOfficialScaleAndVacancyQueries,
  officialScaleAndVacancyQueryInvalidations,
} from "../lib/official-scale-vacancy-query-refresh";

function invalidateSpy() {
  return { invalidate: vi.fn(async () => undefined) };
}

describe("invalidação conjunta da escala oficial e das vagas", () => {
  it("Agenda, Vagas e contadores saem da mesma geração", async () => {
    const utils = {
      shifts: { listAgenda: invalidateSpy() },
      shiftInstances: { listVacancies: invalidateSpy() },
      filters: {
        actionableVacancyCounts: invalidateSpy(),
        summaryCounts: invalidateSpy(),
      },
    };

    await invalidateOfficialScaleAndVacancyQueries(utils);

    expect(utils.shifts.listAgenda.invalidate).toHaveBeenCalledTimes(1);
    expect(utils.shiftInstances.listVacancies.invalidate).toHaveBeenCalledTimes(
      1,
    );
    expect(utils.filters.actionableVacancyCounts.invalidate).toHaveBeenCalledTimes(
      1,
    );
    expect(utils.filters.summaryCounts.invalidate).toHaveBeenCalledTimes(1);
    expect(officialScaleAndVacancyQueryInvalidations(utils)).toHaveLength(4);
  });

  it("não escolhe instituição, hospital ou setor por id fixo", () => {
    const source = readFileSync(
      "lib/official-scale-vacancy-query-refresh.ts",
      "utf8",
    );
    expect(source).not.toMatch(/institutionId:\s*[1-9]/);
    expect(source).not.toMatch(/LIMIT 1|MIN\(id\)/);
    expect(source).toContain("listAgenda");
    expect(source).toContain("listVacancies");
  });

  it("mutações que mudam ocupação invalidam as duas abas", () => {
    const refresh = readFileSync(
      "hooks/use-operational-query-refresh.ts",
      "utf8",
    );
    const details = readFileSync("app/shift-details.tsx", "utf8");
    const create = readFileSync("app/create-shift.tsx", "utf8");
    const manager = readFileSync(
      "components/agenda/ManagerActionsMenu.tsx",
      "utf8",
    );
    const openMonth = readFileSync(
      "components/agenda/OpenMonthShiftsButton.tsx",
      "utf8",
    );
    const createSectorScale = readFileSync(
      "components/agenda/CreateSectorScaleButton.tsx",
      "utf8",
    );
    const acceptedSwap = readFileSync(
      "components/swaps/AvailableSwapsList.tsx",
      "utf8",
    );
    const ownerApproval = readFileSync("app/my-offers.tsx", "utf8");
    const edit = readFileSync("app/edit-shift.tsx", "utf8");
    const nomination = readFileSync("app/confirm-duty.tsx", "utf8");
    const pending = readFileSync("app/(tabs)/pending.tsx", "utf8");

    expect(refresh).toContain("officialScaleAndVacancyQueryInvalidations(utils)");
    expect(refresh).toContain("refreshVacancyMutationQueries");

    for (const source of [
      details,
      create,
      manager,
      openMonth,
      createSectorScale,
      acceptedSwap,
      ownerApproval,
      edit,
      nomination,
    ]) {
      expect(source).toContain("invalidateOfficialScaleAndVacancyQueries(utils)");
    }

    expect(pending).toContain("utils.shiftInstances.listVacancies.invalidate()");
    expect(pending).toContain("utils.shifts.listAgenda.invalidate()");
  });

  it("A e B: helper não carrega tenant ativo nem allowlist ad hoc", () => {
    const source = readFileSync(
      "lib/official-scale-vacancy-query-refresh.ts",
      "utf8",
    );
    expect(source).not.toContain("activeInstitutionId");
    expect(source).not.toContain("ALLOWLIST");
    expect(source).not.toContain("x-tenant-id");
  });
});
