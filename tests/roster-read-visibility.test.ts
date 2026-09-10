import { describe, expect, it, vi } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import {
  canReadRosterMonth,
  loadRosterMonthStatuses,
  officialRosterExistsSql,
  rosterMonthKey,
} from "../server/roster-read-visibility";
import { shiftInstances } from "../drizzle/schema";
import { yearMonthBrt } from "../server/local-time";
import { resolveShiftScheduleContextReadGrant } from "../server/schedule-contexts";

describe("cerca de publicação mensal", () => {
  it.each(["DRAFT", null, undefined, "PUBLISHED", "LOCKED"] as const)(
    "estado %s exige publicação ou canManage canônico",
    (status) => {
      expect(canReadRosterMonth(false, status)).toBe(
        status === "PUBLISHED" || status === "LOCKED",
      );
      expect(canReadRosterMonth(true, status)).toBe(true);
    },
  );

  it("estado e canManage desconhecidos não fabricam autorização", () => {
    expect(canReadRosterMonth(false, "UNKNOWN" as never)).toBe(false);
    expect(canReadRosterMonth("true" as never, undefined)).toBe(false);
  });

  it("não consulta períodos vazios e agrupa hospital/mês em uma consulta tenant-scoped", async () => {
    const where = vi.fn().mockResolvedValue([
      { hospitalId: 10, yearMonth: "2026-09", status: "PUBLISHED" },
      { hospitalId: 20, yearMonth: "2026-10", status: "LOCKED" },
      { hospitalId: 20, yearMonth: "2026-09", status: "UNKNOWN" },
    ]);
    const select = vi.fn(() => ({ from: () => ({ where }) }));
    const db = { select } as unknown as Parameters<
      typeof loadRosterMonthStatuses
    >[0];
    expect((await loadRosterMonthStatuses(db, 7, [])).size).toBe(0);
    expect(select).not.toHaveBeenCalled();

    const statuses = await loadRosterMonthStatuses(db, 7, [
      { hospitalId: 10, yearMonth: "2026-09" },
      { hospitalId: 10, yearMonth: "2026-09" },
      { hospitalId: 20, yearMonth: "2026-10" },
      { hospitalId: 20, yearMonth: "2026-09" },
    ]);
    expect(select).toHaveBeenCalledTimes(1);
    expect(statuses.get(rosterMonthKey(10, "2026-09"))).toBe("PUBLISHED");
    expect(statuses.get(rosterMonthKey(20, "2026-10"))).toBe("LOCKED");
    expect(statuses.get(rosterMonthKey(20, "2026-09"))).toBe("DRAFT");
    expect(statuses.get(rosterMonthKey(10, "2026-10"))).toBeUndefined();
    const query = new MySqlDialect().sqlToQuery(where.mock.calls[0][0]);
    expect(query.sql).toContain("`monthly_rosters`.`institution_id` = ?");
    expect(query.params).toEqual([
      7,
      10,
      "2026-09",
      20,
      "2026-10",
      20,
      "2026-09",
    ]);
  });

  it("mês da última noite é o civil BRT, não o mês UTC", () => {
    expect(yearMonthBrt(new Date("2026-10-01T02:00:00Z"))).toBe("2026-09");
    expect(yearMonthBrt(new Date("2026-10-01T03:00:00Z"))).toBe("2026-10");
  });

  it("gera predicado oficial tenant/hospital/mês antes de ORDER/LIMIT", () => {
    const query = new MySqlDialect().sqlToQuery(
      officialRosterExistsSql({
        institutionId: shiftInstances.institutionId,
        hospitalId: shiftInstances.hospitalId,
        startAt: shiftInstances.startAt,
      }),
    );
    expect(query.sql).toContain(
      "roster_visibility.institution_id = `shift_instances`.`institution_id`",
    );
    expect(query.sql).toContain(
      "roster_visibility.hospital_id = `shift_instances`.`hospital_id`",
    );
    expect(query.sql).toContain("DATE_SUB(`shift_instances`.`start_at`");
    expect(query.sql).toContain("IN ('PUBLISHED', 'LOCKED')");
    expect(query.params).toEqual([]);
  });

  it("alocação própria não apaga canManage e fallback próprio não cria gestão", () => {
    const shift = {
      id: 1,
      institutionId: 7,
      hospitalId: 10,
      sectorId: 11,
      scheduleContextId: 12,
    };
    const context = {
      id: 12,
      institutionId: 7,
      hospitalId: 10,
      sectorId: 11,
      canManage: true,
    };
    const grant = resolveShiftScheduleContextReadGrant({
      shift,
      ownActiveAssignment: true,
      authorizedContexts: [context as never],
    });
    expect(grant).toEqual({ kind: "SCHEDULE_CONTEXT", context });
    expect(
      resolveShiftScheduleContextReadGrant({
        shift,
        ownActiveAssignment: true,
        authorizedContexts: [],
      }),
    ).toEqual({ kind: "OWN_ASSIGNMENT", context: null });
    expect(
      resolveShiftScheduleContextReadGrant({
        shift,
        ownActiveAssignment: false,
        authorizedContexts: [{ ...context, institutionId: 8 } as never],
      }),
    ).toBeNull();
  });
});
