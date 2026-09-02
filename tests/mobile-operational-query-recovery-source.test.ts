import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const trocas = readFileSync("app/(tabs)/trocas.tsx", "utf8");
const vacancies = readFileSync("app/(tabs)/vacancies.tsx", "utf8");
const tabs = readFileSync("app/(tabs)/_layout.tsx", "utf8");
const recovery = readFileSync(
  "hooks/use-native-operational-query-recovery.ts",
  "utf8",
);
const refresh = readFileSync("hooks/use-operational-query-refresh.ts", "utf8");
const applications = readFileSync("app/my-applications.tsx", "utf8");
const swaps = readFileSync("components/swaps/AvailableSwapsList.tsx", "utf8");
const filterDefaults = readFileSync("hooks/use-filter-defaults.ts", "utf8");
const pending = readFileSync("app/(tabs)/pending.tsx", "utf8");
const shiftFilters = readFileSync("components/shift-filters.tsx", "utf8");
const vacancyPushRoute = readFileSync("lib/vacancy-push-route.ts", "utf8");
const tenantScopedFilters = readFileSync(
  "hooks/use-tenant-scoped-shift-filters.ts",
  "utf8",
);
const notificationListener = readFileSync(
  "components/NotificationListener.tsx",
  "utf8",
);

describe("contrato de recuperação somente nas telas operacionais", () => {
  it("limita foco e reconnect nativos a Trocas e Vagas", () => {
    expect(trocas).toContain("useNativeOperationalQueryRecovery");
    expect(vacancies).toContain("useNativeOperationalQueryRecovery");
    expect(tabs).not.toContain("useNativeOperationalQueryRecovery");
    expect(tabs).not.toContain("NetInfo.addEventListener");
    expect(recovery).toContain("useFocusEffect");
    expect(recovery).toContain("NetInfo.addEventListener");
    expect(recovery).toContain("isOperationalNetworkOnline(state)");
    expect(recovery).not.toContain("isNetInfoOnline");
    expect(recovery).toContain("captureLease()");
    expect(recovery).toContain("refresh(lease)");
  });

  it("vincula invalidações a lease e inclui candidaturas e contadores após assumir", () => {
    expect(refresh).toContain("OperationalQueryRefreshLease");
    expect(refresh).toContain("isLeaseCurrent(lease)");
    expect(refresh).toContain(
      "utils.shiftAssignments.listMyVacancyRequests.invalidate()",
    );
    expect(refresh).toContain(
      "utils.shiftAssignments.listPending.invalidate()",
    );
    expect(refresh).toContain("utils.filters.summaryCounts.invalidate()");
    expect(refresh).toContain(
      "utils.filters.actionableVacancyCounts.invalidate()",
    );
    expect(vacancies).toContain("const refreshLease = captureLease()");
    expect(vacancies).toContain(
      "const refreshPromise = refreshVacancyQueries(refreshLease)",
    );
    expect(vacancies).toContain("assumeVacancyLockRef");
    expect(vacancies).toContain("mutateAsync");
    expect(vacancies).toContain("await refreshPromise");
    const successIndex = vacancies.indexOf("feedback.success");
    const refreshAwaitIndex = vacancies.indexOf("await refreshPromise");
    const unlockAfterRefreshIndex = vacancies.indexOf(
      "assumeVacancyLockRef.current = false",
      refreshAwaitIndex,
    );
    expect(successIndex).toBeGreaterThan(-1);
    expect(successIndex).toBeLessThan(refreshAwaitIndex);
    expect(unlockAfterRefreshIndex).toBeGreaterThan(refreshAwaitIndex);
  });

  it("não mostra candidatura vazia quando uma das fontes falha", () => {
    expect(applications).toContain(
      "applicationsHasError || vacancyRequestsHasError",
    );
    expect(applications).toContain('contentState === "ERROR"');
    expect(applications).toContain('contentState === "UNRESOLVED"');
    expect(applications).toContain("<QueryErrorState");
  });

  it("não converte falha de escopo profissional em filtros padrão", () => {
    expect(vacancies).toContain("managerScopeHasError ||");
    expect(vacancies).toContain("refetchManagerScope()");
    expect(vacancies).toContain(
      'title="Não foi possível carregar os filtros de vagas"',
    );
  });

  it("revalida e persiste filtros por tenant nas duas telas que os compartilham", () => {
    expect(vacancies).toContain("const EMPTY_HOSPITALS");
    expect(vacancies).toContain("hospitalsData ?? EMPTY_HOSPITALS");
    expect(vacancies).toContain("sectorsData ?? EMPTY_SECTORS");
    expect(pending).toContain("const EMPTY_HOSPITALS");
    expect(pending).toContain("hospitalsData ?? EMPTY_HOSPITALS");
    expect(pending).toContain("sectorsData ?? EMPTY_SECTORS");
    expect(filterDefaults).toContain("tenantFilterStorageKey");
    expect(filterDefaults).toContain("sanitizeTenantFilterSelection");
    expect(vacancies).toContain("institutionId: activeInstitutionId");
    expect(pending).toContain("institutionId: activeInstitutionId");
    expect(vacancies).toContain(
      "persistenceInstitutionId={activeInstitutionId}",
    );
    expect(pending).toContain("persistenceInstitutionId={activeInstitutionId}");
    expect(shiftFilters).toContain("persistenceInstitutionId");
    expect(shiftFilters).not.toContain('localStorage.setItem("lastHospitalId"');
    expect(shiftFilters).not.toContain('localStorage.setItem("lastSectorId"');
  });

  it("reduz o filtro efetivo para neutro na revisão de tenant, sem remount", () => {
    expect(vacancies).toContain("useTenantScopedShiftFilters");
    expect(pending).toContain("useTenantScopedShiftFilters");
    expect(vacancies).toContain("tenantKey: activeTenantKey");
    expect(vacancies).toContain("value={filters}");
    expect(pending).toContain("value={filters}");
    expect(shiftFilters).toContain("value?: ShiftFilterValues");
    expect(shiftFilters).toContain(
      "const currentValues = value ?? uncontrolledValues",
    );
    expect(shiftFilters).toContain("if (isControlled) {");
    expect(tenantScopedFilters).toContain("resolveTenantScopedShiftFilters");
    expect(tenantScopedFilters).toContain(
      "state.tenantKey === activeTenantKey ? state.value : neutralValue",
    );
    expect(tenantScopedFilters).toContain('initialization: "PENDING"');
  });

  it("não exibe lista ou botões stale sem resposta resolvida ou após revogação", () => {
    expect(vacancies).toContain('vacanciesContentState === "UNRESOLVED"');
    expect(swaps).toContain('contentState === "UNRESOLVED"');
    expect(vacancies).toContain("hasResolvedData: vacanciesData !== undefined");
    expect(swaps).toContain("hasResolvedData: data !== undefined");
    expect(vacancies).toContain(
      'presentQueryError(professionalError).kind === "ACCESS"',
    );
    expect(vacancies).toContain(
      'presentQueryError(hospitalsError).kind === "ACCESS"',
    );
    expect(vacancies).toContain(
      'presentQueryError(sectorsError).kind === "ACCESS"',
    );
  });

  it("não afirma contagem ou métricas cacheadas durante erro ou resposta pendente", () => {
    expect(vacancies).toMatch(
      /!actionableCountsHasError\s*&&\s*canDisplayOperationalListCount\(vacanciesContentState\)/,
    );
    expect(vacancies).toContain("counts={safeFilterCounts}");
    expect(vacancies).toContain(
      "canDisplayOperationalListCount(vacanciesContentState)",
    );
    expect(vacancies).toContain(
      "A quantidade de plantões ainda não pôde ser confirmada.",
    );
    expect(vacancies).toContain(
      "Aguardando a confirmação dos plantões em aberto…",
    );
  });

  it("consome a intenção de push reativamente sem remontar a aba", () => {
    expect(vacancies).toContain("useLocalSearchParams<{");
    expect(vacancies).toContain("resolveVacancyIntent.useQuery");
    expect(vacancies).toContain("vacancyIntentShiftInstanceId,");
    expect(vacancies).toContain("handledVacancyIntentRef");
    expect(vacancies).toContain("vacancyIntentConsumptionFenceRef.current");
    expect(vacancies).toContain("isVacancyPushIntentConsumptionFenceCurrent");
    expect(vacancies).toContain("isVacancyPushIntentPublicationCurrent");
    expect(vacancies).toContain("vacancyPushIntentNotificationFence.current()");
    expect(vacancies).toContain(
      "sessionGeneration: vacancyIntentSessionGeneration",
    );
    expect(vacancies).toContain("isSessionAuthorizationCurrent()");
    expect(vacancies).toContain(
      "router.setParams(clearVacancyPushRouteParams())",
    );
    expect(vacancyPushRoute).toContain(
      "input.data.shiftInstanceId !== input.intentShiftInstanceId",
    );
    expect(vacancyPushRoute).toContain("clearIfSessionCurrent");
    expect(vacancyPushRoute).toContain(
      "expected.sessionGeneration === currentSessionGeneration",
    );
    expect(notificationListener).toContain("vacancyPushSessionGeneration");
    expect(notificationListener).toContain(
      "vacancyPushIntentNotificationFence.clearIfSessionCurrent",
    );
    expect(vacancyPushRoute).toContain('return { kind: "LOADING" }');

    const consumptionEffectStart = vacancies.indexOf(
      "const capturedConsumptionFence = {",
    );
    const markHandled = vacancies.indexOf(
      "handledVacancyIntentRef.current = intentKey",
      consumptionEffectStart,
    );
    const clearRoute = vacancies.indexOf(
      "router.setParams(clearVacancyPushRouteParams())",
      consumptionEffectStart,
    );
    const liveTenantRead = vacancies.indexOf(
      "const liveTenant = getActiveTenantSnapshot();",
      consumptionEffectStart,
    );
    const publicationFenceRead = vacancies.indexOf(
      "vacancyPushIntentNotificationFence.current()",
      consumptionEffectStart,
    );
    const guardBeforeMarkHandled = vacancies.lastIndexOf(
      "if (!isConsumptionFenceCurrent()) return;",
      markHandled,
    );
    const guardBeforeClearRoute = vacancies.lastIndexOf(
      "if (!isConsumptionFenceCurrent()) return;",
      clearRoute,
    );

    expect(consumptionEffectStart).toBeGreaterThan(-1);
    expect(liveTenantRead).toBeGreaterThan(consumptionEffectStart);
    expect(liveTenantRead).toBeLessThan(guardBeforeMarkHandled);
    expect(publicationFenceRead).toBeGreaterThan(liveTenantRead);
    expect(publicationFenceRead).toBeLessThan(guardBeforeMarkHandled);
    expect(guardBeforeMarkHandled).toBeGreaterThan(consumptionEffectStart);
    expect(guardBeforeMarkHandled).toBeLessThan(markHandled);
    expect(guardBeforeClearRoute).toBeGreaterThan(markHandled);
    expect(guardBeforeClearRoute).toBeLessThan(clearRoute);
  });
});
