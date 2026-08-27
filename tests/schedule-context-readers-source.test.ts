import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("wiring fail-closed dos leitores multi-contexto", () => {
  it("calendar é somente leitura e exige uma escala operacional exata", () => {
    const source = readFileSync("server/calendar.ts", "utf8");

    expect(source).toContain("resolveCalendarAccess");
    expect(source).toContain("requireSingleLegacyScheduleContext(candidates)");
    expect(source).toContain("si.schedule_context_id = ${context.id}");
    expect(source).toContain("sc.active = true");
    expect(source).not.toContain(".insert(shiftInstances)");
    expect(source).not.toContain("Criação automática ao abrir o dia");
  });

  it("get e listByPeriod usam a allowlist por contexto com exceção própria estreita", () => {
    const source = readFileSync("server/shifts-crud.ts", "utf8");

    expect(source).toContain("assertActorCanReadShiftScheduleContext");
    expect(source).toContain(
      "authorizedContextIds.has(activeScheduleContextId)",
    );
    expect(source).toContain(
      "assignment.professionalId === actor.professionalId",
    );
    expect(source).toContain("assignment.userId === actor.userId");
  });

  it("alocar o gestor médico usa o mesmo manager_scope da elegibilidade", () => {
    const source = readFileSync("server/schedule-contexts.ts", "utf8");
    const start = source.indexOf("export async function listAssumableScheduleContextIds");
    const assumable = source.slice(start, start + 1200);
    expect(assumable).toContain("managerScopeCoversContext");
    expect(assumable).toContain("accessCoversContext");
    expect(assumable).toContain("qualificationMatches");
  });

  it("catálogos, contadores e profissionais alocáveis usam a mesma fronteira", () => {
    const source = readFileSync("server/aux-routers.ts", "utf8");

    expect(
      source.match(/listAuthorizedScheduleContexts\(actor, db\)/g)?.length,
    ).toBeGreaterThanOrEqual(3);
    expect(source).toContain("pi.user_id = p.user_id");
    expect(source).toContain("pi.role_in_institution AS roleInInstitution");
    expect(source).not.toContain("pi.user_role");
    expect(source).toContain("u.approval_status = 'APPROVED'");
    expect(source).toContain("u.deleted_at IS NULL");
    expect(source).toContain("conflict_shift.start_at < target_shift.end_at");
    expect(source).toContain("sc.admission_policy = 'QUALIFICATION_ALLOWLIST'");
    expect(source).toContain("schedule_context_allowed_qualifications");
    expect(source).toContain("LEFT JOIN manager_scope mgr");
    expect(source).toContain("pa.id IS NOT NULL OR mgr.id IS NOT NULL");
  });

  it("replicação rejeita fonte sem contexto ativo e topologia composta", () => {
    const source = readFileSync("server/shifts-crud.ts", "utf8");
    const replicationStart = source.indexOf("async function replicateRange");
    const replicationEnd = source.indexOf("export const shiftsRouter");
    const replication = source.slice(replicationStart, replicationEnd);

    expect(replication).toContain('source.scheduleContextId ?? "legacy"');
    expect(
      replication.match(/assertActiveScheduleContextTopology/g)?.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("push troca o tenant antes de abrir o shiftInstanceId exato", () => {
    const source = readFileSync("components/NotificationListener.tsx", "utf8");
    const align = source.indexOf(
      "const alignedSnapshot = await alignNotificationTenant",
    );
    const exactNavigation = source.indexOf(
      "dependencies.navigateToShiftDetails(shiftInstanceId)",
    );

    expect(source).toContain("parseNotificationShiftInstanceId");
    expect(source).toContain('pathname: "/shift-details"');
    expect(align).toBeGreaterThan(-1);
    expect(exactNavigation).toBeGreaterThan(align);
  });
});
