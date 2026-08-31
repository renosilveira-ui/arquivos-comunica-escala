import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { notificationQueryRefreshTargets } from "../lib/notification-query-refresh";

describe("push em primeiro plano — matriz de reconciliação", () => {
  it("mantém Trocas e Vagas nas fontes canônicas existentes", () => {
    expect(notificationQueryRefreshTargets("swap_offer")).toEqual(["SWAPS"]);
    expect(notificationQueryRefreshTargets("swap_taken")).toEqual([
      "SWAPS",
      "SCHEDULES",
    ]);
    expect(notificationQueryRefreshTargets("vacancy_available")).toEqual([
      "VACANCIES",
      "SUMMARY_COUNTS",
    ]);
  });

  it("reconcilia agenda, vagas e aprovações após mudança de alocação", () => {
    const expected = [
      "SCHEDULES",
      "VACANCIES",
      "PENDING_ASSIGNMENTS",
      "SUMMARY_COUNTS",
      "SWAPS",
    ];
    expect(notificationQueryRefreshTargets("shift_assigned")).toEqual(expected);
    expect(notificationQueryRefreshTargets("shift_unassigned")).toEqual(
      expected,
    );
  });

  it("reconcilia confirmações, substituições e convites sem refetch global", () => {
    expect(notificationQueryRefreshTargets("duty_confirmation")).toEqual([
      "SCHEDULES",
    ]);
    expect(notificationQueryRefreshTargets("replacement_accepted")).toEqual([
      "SCHEDULES",
      "SWAPS",
    ]);
    expect(notificationQueryRefreshTargets("replacement_declined")).toEqual([
      "SCHEDULES",
    ]);
    expect(notificationQueryRefreshTargets("invite_declined")).toEqual([
      "SCHEDULE_INVITES",
    ]);
  });

  it("falha fechado para tipos desconhecidos e eventos sem cache local", () => {
    expect(notificationQueryRefreshTargets("sso_ready")).toEqual([]);
    expect(notificationQueryRefreshTargets("sync_error")).toEqual([]);
    expect(notificationQueryRefreshTargets("novo_tipo_nao_mapeado")).toEqual(
      [],
    );
    expect(notificationQueryRefreshTargets(null)).toEqual([]);
  });

  it("decisão local de alocação reconcilia contador e superfícies irmãs", () => {
    const pending = readFileSync("app/(tabs)/pending.tsx", "utf8");

    expect(pending).toContain("invalidateAssignmentDecisionCaches");
    expect(pending).toContain(
      "utils.shiftAssignments.listPending.invalidate()",
    );
    expect(pending).toContain("utils.filters.summaryCounts.invalidate()");
    expect(pending).toContain(
      "utils.shiftInstances.listVacancies.invalidate()",
    );
    expect(pending).toContain("utils.shifts.listAgenda.invalidate()");
    expect(pending).toContain("utils.swaps.countActionable.invalidate()");
    expect(
      pending.match(/void invalidateAssignmentDecisionCaches\(\)/g),
    ).toHaveLength(2);
  });
});
