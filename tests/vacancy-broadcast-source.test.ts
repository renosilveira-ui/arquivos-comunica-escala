import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  VACANCY_AVAILABLE_DEEP_LINK,
  VACANCY_AVAILABLE_PUSH_TITLE,
  VACANCY_BROADCAST_COOLDOWN_MS,
  shouldInvalidateVacancyQueriesOnNotification,
  vacancyBroadcastDedupKey,
  vacancyBroadcastFeedbackMessage,
  vacancyBroadcastStillCoolingDown,
} from "../lib/vacancy-broadcast";

describe("aviso de plantão vago — contratos de fonte", () => {
  it("invalida Plantões em aberto só em vacancy_available", () => {
    expect(
      shouldInvalidateVacancyQueriesOnNotification("vacancy_available"),
    ).toBe(true);
    expect(shouldInvalidateVacancyQueriesOnNotification("swap_offer")).toBe(
      false,
    );
    expect(shouldInvalidateVacancyQueriesOnNotification("shift_assigned")).toBe(
      false,
    );
  });

  it("feedback afirma envio, não entrega no aparelho", () => {
    expect(vacancyBroadcastFeedbackMessage(0)).toBe(
      "Nenhum médico elegível encontrado para este plantão.",
    );
    expect(vacancyBroadcastFeedbackMessage(1)).toBe(
      "Aviso enviado para 1 médico elegível.",
    );
    expect(vacancyBroadcastFeedbackMessage(12)).toBe(
      "Aviso enviado para 12 médicos elegíveis.",
    );
    expect(vacancyBroadcastFeedbackMessage(12)).not.toMatch(/entreg/i);
  });

  it("cooldown de 15 min é elapsed real, não bucket de relógio", () => {
    expect(VACANCY_BROADCAST_COOLDOWN_MS).toBe(15 * 60 * 1000);
    const last = new Date("2026-08-31T15:14:59.000Z");
    const twoSecondsLater = new Date("2026-08-31T15:15:01.000Z");
    expect(vacancyBroadcastStillCoolingDown(last, twoSecondsLater)).toBe(true);
    expect(
      vacancyBroadcastStillCoolingDown(
        last,
        new Date(last.getTime() + VACANCY_BROADCAST_COOLDOWN_MS - 1),
      ),
    ).toBe(true);
    expect(
      vacancyBroadcastStillCoolingDown(
        last,
        new Date(last.getTime() + VACANCY_BROADCAST_COOLDOWN_MS),
      ),
    ).toBe(false);
    expect(vacancyBroadcastStillCoolingDown(null, twoSecondsLater)).toBe(false);

    const firstKey = vacancyBroadcastDedupKey({
      shiftInstanceId: 44,
      userId: 22,
      now: last,
    });
    const secondKey = vacancyBroadcastDedupKey({
      shiftInstanceId: 44,
      userId: 22,
      now: twoSecondsLater,
    });
    expect(firstKey).toBe(`vacancy-notify:44:22:${last.getTime()}`);
    expect(secondKey).not.toBe(firstKey);
    const source = readFileSync("lib/vacancy-broadcast.ts", "utf8");
    expect(source).not.toContain("vacancyBroadcastCooldownBucket");
    expect(source).toContain("vacancyBroadcastStillCoolingDown");
  });

  it("copy, deep link e título canônicos", () => {
    expect(VACANCY_AVAILABLE_PUSH_TITLE).toBe("Plantão vago disponível");
    expect(VACANCY_AVAILABLE_DEEP_LINK).toBe("/(tabs)/vacancies");
  });

  it("mutation só aceita shiftInstanceId e revalida gestor no backend", () => {
    const crud = readFileSync("server/shifts-crud.ts", "utf8");
    const notify = crud.slice(crud.indexOf("notifyVacancy:"));
    const input = notify.slice(
      notify.indexOf(".input("),
      notify.indexOf(".mutation("),
    );
    expect(input).toContain("shiftInstanceId");
    expect(input).not.toContain("institutionId");
    expect(input).not.toContain("hospitalId");
    expect(input).not.toContain("sectorId");
    expect(input).not.toContain("recipientUserIds");
    expect(notify).toContain("assertCanManageInstitutionSchedule");
    expect(notify).toContain("assertManagerScopeAccess");
    expect(notify).toContain("assertManagerScopeAccessForUpdate");
    expect(notify).toContain('locked.status !== "VAGO"');
    expect(notify).toContain("deriveShiftStatus");
    expect(notify).toContain("shiftAssignmentsV2.isActive");
    expect(notify).toContain("enqueueVacancyAvailableSignals");
    expect(notify).toContain("recentVacancyBroadcastExists");
    const signal = readFileSync("server/vacancy-broadcast-signal.ts", "utf8");
    expect(signal).toContain("vacancyBroadcastStillCoolingDown");
    expect(signal).toContain("orderBy(desc(notifications.createdAt))");
    expect(signal).not.toContain("vacancyBroadcastCooldownBucket");
  });

  it("markVacant e unassignDirect não disparam aviso de equipe", () => {
    const editor = readFileSync("server/editor.ts", "utf8");
    expect(editor).not.toContain("enqueueVacancyAvailableSignals");
    expect(editor).not.toContain("vacancy-broadcast");
    expect(editor).not.toContain("notifyVacancy");
  });

  it("destinatários reusam plantonista da #323 sem atalho gerencial", () => {
    const eligibility = readFileSync(
      "server/plantonista-shift-eligibility.ts",
      "utf8",
    );
    const swap = readFileSync("server/swap-offer-eligibility.ts", "utf8");
    const sql = eligibility.slice(eligibility.indexOf("SELECT DISTINCT au.id"));
    expect(eligibility).toContain(
      "export async function eligibleProfessionalUserIdsForShift",
    );
    expect(sql).not.toContain("GESTOR_PLUS");
    expect(sql).not.toContain("manager_scope");
    expect(sql).not.toContain("role_in_institution");
    expect(swap).toContain("plantonistaAccessCoversShiftSql");
    expect(swap).not.toContain("plantonistaXorQualificationSql");
    expect(swap).not.toContain("plantonistaQualificationMatchesSql");
    expect(eligibility).not.toContain("medical_specialty_id");
    expect(eligibility).not.toContain("operational_profile_code");
  });

  it("UI do gestor só mostra Avisar equipe em plantão vago", () => {
    const details = readFileSync("app/shift-details.tsx", "utf8");
    expect(details).toContain(
      'label={notifyVacancy.isPending ? "Enviando aviso..." : "Avisar equipe"}',
    );
    expect(details).toContain('shift.status === "VAGO"');
    expect(details).toContain("trpc.shifts.notifyVacancy");
    expect(details).toContain("vacancyBroadcastFeedbackMessage");
  });

  it("tap abre Plantões em aberto; recebido invalida lista e contadores", () => {
    const listener = readFileSync(
      "components/NotificationListener.tsx",
      "utf8",
    );
    const refreshMatrix = readFileSync(
      "lib/notification-query-refresh.ts",
      "utf8",
    );
    expect(listener).toContain('case "vacancy_available"');
    expect(listener).toContain("navigateToVacancies");
    expect(listener).toContain('pathname: "/(tabs)/vacancies"');
    expect(listener).toContain("vacancyPushRouteParams(shiftInstanceId)");
    expect(listener).toContain("vacancyPushIntentNotificationFence.publish");
    expect(listener).toContain("notificationQueryRefreshTargets");
    expect(refreshMatrix).toContain(
      "shouldInvalidateVacancyQueriesOnNotification",
    );
    expect(listener).toContain(
      "utils.shiftInstances.listVacancies.invalidate()",
    );
    expect(listener).toContain("utils.filters.summaryCounts.invalidate()");
    expect(listener).toContain(
      "utils.filters.actionableVacancyCounts.invalidate()",
    );
    const vacancyCase = listener.slice(
      listener.indexOf('case "vacancy_available"'),
      listener.indexOf('case "swap_taken"'),
    );
    expect(vacancyCase).toContain("alignNotificationTenant");
    expect(vacancyCase).toContain("parseNotificationShiftInstanceId");
    expect(vacancyCase).not.toContain("navigateToAgenda");
    expect(vacancyCase).toContain("return false");
    const received = listener.slice(
      listener.indexOf("addNotificationReceivedListener"),
    );
    const vacancyInvalidate = received.indexOf(
      "utils.shiftInstances.listVacancies.invalidate()",
    );
    expect(vacancyInvalidate).toBeGreaterThan(0);
    expect(received.slice(0, vacancyInvalidate)).not.toContain(
      "navigateToVacancies",
    );
    const vacancyNavigationStart = listener.indexOf(
      "navigateToVacancies: (shiftInstanceId)",
    );
    const vacancyNavigation = listener.slice(
      vacancyNavigationStart,
      listener.indexOf("navigateToMyOffers", vacancyNavigationStart),
    );
    const publishIntent = vacancyNavigation.indexOf(
      "vacancyPushIntentNotificationFence.publish",
    );
    const pushVacanciesRoute = vacancyNavigation.indexOf("router.push({");
    expect(publishIntent).toBeGreaterThan(-1);
    expect(pushVacanciesRoute).toBeGreaterThan(publishIntent);
  });

  it("rota canônica de Solicitar plantão existe no mobile", () => {
    const vacancies = readFileSync("app/(tabs)/vacancies.tsx", "utf8");
    const tabs = readFileSync("app/(tabs)/_layout.tsx", "utf8");
    expect(vacancies).toContain('"Solicitar plantão"');
    expect(vacancies).toContain('"Enviando…"');
    expect(vacancies).toContain(
      "assumeVacancyBusy && assumeVacancyId === vacancy.id",
    );
    expect(vacancies).toContain(
      "disabled={!vacancy.canAssume || assumeVacancyBusy}",
    );
    expect(tabs).toContain('name="vacancies"');
    expect(tabs).toContain('href: can("view:vacancies") ? undefined : null');
    expect(vacancies).toContain("useLocalSearchParams");
    expect(vacancies).toContain("resolveVacancyIntent.useQuery");
    expect(vacancies).toContain(
      "router.setParams(clearVacancyPushRouteParams())",
    );
  });
});
