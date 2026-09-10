import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nextRosterPublicationRecheckAt } from "../server/roster-publication-push-wakeup";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function sliceBetween(source: string, start: string, end: string): string {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  expect(startAt).toBeGreaterThanOrEqual(0);
  expect(endAt).toBeGreaterThan(startAt);
  return source.slice(startAt, endAt);
}

describe("rework da cerca de rascunho e notificações", () => {
  it("auditoria pessoal aceita só account-level sem turno ou movimento em roster oficial", () => {
    const source = read("server/audit-router.ts");
    const query = sliceBetween(
      source,
      "const participantWhere",
      "const fromIso",
    );

    expect(source).toContain("SELF_VISIBLE_ACCOUNT_ACTIONS");
    expect(source).toContain('"USER_UPDATED"');
    expect(source).toContain('"SSO_JIT_LINK_CREATED"');
    expect(query).toContain("at.action IN (${accountActionsSql})");
    expect(query).toContain("const operationalShapeWhere");
    expect(query).toContain(
      "at.shift_instance_id IS NOT NULL\n        OR at.action IN (${accountActionsSql})",
    );
    expect(query).toContain("at.shift_instance_id IS NULL");
    expect(query).toContain("at.action IN (${shiftMovementActionsSql})");
    expect(query).toContain("at.shift_instance_id IS NOT NULL");
    expect(query).toContain(
      "audit_roster_visibility.status IN ('PUBLISHED', 'LOCKED')",
    );
    expect(query).toContain("${managerScopeVisibility}");
    expect(query).toContain(
      "${participantWhere} AND ${ownOfficialVisibilityWhere}",
    );
    expect(query).not.toContain("return []");
  });

  it("status mensal exige gestão e jurisdição hospital-wide", () => {
    const source = read("server/shifts-crud.ts");
    const endpoint = sliceBetween(
      source,
      "rosterStatus: protectedProcedure",
      "hasMonthShifts: protectedProcedure",
    );

    expect(endpoint).toContain("getTenantActorFromContext(ctx)");
    expect(endpoint).toContain("assertCanManageInstitutionSchedule(actor)");
    expect(endpoint).toContain(
      "assertManagerScopeAccess(actor, input.hospitalId)",
    );
  });

  it("autoridade e apresentação final exigem scheduleContext exato e ativo", () => {
    const access = read("server/confirmation-canonical-access.ts");
    const assignment = read("server/assignment-push-authority.ts");
    const vacancy = read("server/vacancy-request-push-authority.ts");
    const delivery = read("server/push-delivery.ts");
    const finalContext = sliceBetween(
      delivery,
      "async function requireCanonicalShiftPushContext",
      "async function claimSubmission",
    );

    for (const source of [access, assignment, vacancy, finalContext]) {
      expect(source).toContain("scheduleContexts.active");
      expect(source).toContain("scheduleContexts.institutionId");
      expect(source).toContain("scheduleContexts.hospitalId");
      expect(source).toContain("scheduleContexts.sectorId");
    }
    expect(vacancy).toContain('authority.purpose === "REQUEST_APPROVED"');
    expect(vacancy).toContain("findCanonicalConfirmationAccessId");
  });

  it("publicação acorda só QUEUED deferido e nunca ticket/receipt histórico", () => {
    const wakeup = read("server/roster-publication-push-wakeup.ts");
    const update = sliceBetween(
      wakeup,
      "export async function wakeDeferredPushesAfterRosterPublication",
      "return Number",
    );
    const publication = read("server/month-guards.ts");

    expect(update).toContain("'$.phase')) = 'QUEUED'");
    expect(update).toContain("PUSH_PUBLICATION_DEFERRED_MESSAGE");
    expect(update).toContain("'$.revision'");
    expect(update).not.toContain("TICKET_ACCEPTED");
    expect(update).not.toContain("RECEIPT_CHECKING");
    expect(publication).toContain("wakeDeferredPushesAfterRosterPublication");
  });

  it("wake de publicação ocorre somente depois do commit nos dois caminhos", () => {
    const source = read("server/month-guards.ts");
    const complete = sliceBetween(
      source,
      "async function completeRosterPublication",
      "async function wakeDeferredPushesAfterCommittedPublication",
    );
    const readiness = sliceBetween(
      source,
      "async function publishMonthWithReadinessAcknowledgement",
      "/**\n * Publica um mês DRAFT",
    );
    const ordinary = sliceBetween(
      source,
      "export async function publishMonth(",
      "/**\n * Tranca um mês PUBLISHED",
    );

    expect(complete).not.toContain(
      "wakeDeferredPushesAfterRosterPublication",
    );
    expect(readiness.indexOf("await withReadinessFenceV1FinalDecisionTransaction")).toBeLessThan(
      readiness.indexOf("await wakeDeferredPushesAfterCommittedPublication"),
    );
    expect(ordinary.indexOf("await db.transaction(async (tx)")).toBeLessThan(
      ordinary.lastIndexOf("await wakeDeferredPushesAfterCommittedPublication"),
    );
  });

  it("recheck periódico nunca dorme além do startAt", () => {
    const now = new Date("2026-09-10T10:00:00.000Z");
    expect(nextRosterPublicationRecheckAt(now).toISOString()).toBe(
      "2026-09-10T10:05:00.000Z",
    );
    expect(
      nextRosterPublicationRecheckAt(
        now,
        new Date("2026-09-10T10:02:00.000Z"),
      ).toISOString(),
    ).toBe("2026-09-10T10:02:00.000Z");
    expect(
      nextRosterPublicationRecheckAt(
        now,
        new Date("2026-09-10T09:59:00.000Z"),
      ).toISOString(),
    ).toBe(now.toISOString());
  });

  it("calendário e contadores usam entitlement legível sem conceder gestão", () => {
    const calendar = read("server/calendar.ts");
    const filters = read("server/aux-routers.ts");
    const summary = sliceBetween(
      filters,
      "summaryCounts: protectedProcedure",
      "actionableVacancyCounts: protectedProcedure",
    );

    expect(calendar).toContain("listReadableScheduleContexts(actor, db)");
    expect(summary).toContain("listReadableScheduleContexts(actor, db)");
    expect(calendar).toContain(
      "canReadRosterMonth(context.canManage, monthStatus)",
    );
    expect(summary).toContain("authorizedContext.canManage");
  });
});
