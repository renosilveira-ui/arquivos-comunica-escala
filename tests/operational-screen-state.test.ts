import { describe, expect, it } from "vitest";
import {
  canDisplayOperationalListCount,
  resolveMyApplicationsContentState,
  resolveOperationalListState,
  resolveVacanciesGateState,
} from "../lib/operational-screen-state";

describe("estados operacionais de lista", () => {
  it("não transforma erro sem dados em estado vazio", () => {
    expect(
      resolveOperationalListState({
        isLoading: false,
        isPending: false,
        isError: true,
        hasResolvedData: false,
        itemCount: 0,
      }),
    ).toBe("ERROR");
  });

  it("preserva itens já confirmados após refresh falho", () => {
    expect(
      resolveOperationalListState({
        isLoading: false,
        isPending: false,
        isError: true,
        hasResolvedData: true,
        itemCount: 2,
        error: { data: { code: "INTERNAL_SERVER_ERROR" } },
      }),
    ).toBe("READY");
    expect(
      resolveOperationalListState({
        isLoading: false,
        isPending: false,
        isError: false,
        hasResolvedData: true,
        itemCount: 0,
      }),
    ).toBe("EMPTY");
  });

  it("esconde cards e ações em cache quando o acesso foi revogado", () => {
    expect(
      resolveOperationalListState({
        isLoading: false,
        isPending: false,
        isError: true,
        hasResolvedData: true,
        itemCount: 2,
        error: { data: { code: "FORBIDDEN" } },
      }),
    ).toBe("ERROR");
  });

  it("não chama uma lista pausada ou ainda não resolvida de vazia", () => {
    expect(
      resolveOperationalListState({
        isLoading: false,
        isPending: true,
        isError: false,
        hasResolvedData: false,
        itemCount: 0,
      }),
    ).toBe("UNRESOLVED");
    expect(
      resolveOperationalListState({
        isLoading: false,
        isPending: false,
        isError: false,
        hasResolvedData: false,
        itemCount: 0,
      }),
    ).toBe("UNRESOLVED");
  });

  it("só libera a contagem para resultado confirmado", () => {
    expect(canDisplayOperationalListCount("READY")).toBe(true);
    expect(canDisplayOperationalListCount("EMPTY")).toBe(true);
    expect(canDisplayOperationalListCount("LOADING")).toBe(false);
    expect(canDisplayOperationalListCount("UNRESOLVED")).toBe(false);
    expect(canDisplayOperationalListCount("ERROR")).toBe(false);
  });
});

describe("portão de Vagas", () => {
  const readyInput = {
    authLoading: false,
    permissionsLoading: false,
    professionalLoading: false,
    filtersLoading: false,
    hasUser: true,
    hasProfessional: true,
    professionalUnavailable: false,
    filtersUnavailable: false,
  };

  it("não afirma que profissional não existe quando sua consulta falha", () => {
    expect(
      resolveVacanciesGateState({
        ...readyInput,
        hasProfessional: false,
        professionalUnavailable: true,
      }),
    ).toBe("PROFESSIONAL_UNAVAILABLE");
    expect(
      resolveVacanciesGateState({
        ...readyInput,
        hasProfessional: false,
      }),
    ).toBe("MISSING_PROFESSIONAL");
  });

  it("bloqueia filtros desconhecidos, inclusive manager_scope, sem ampliar escopo", () => {
    expect(
      resolveVacanciesGateState({
        ...readyInput,
        filtersUnavailable: true,
      }),
    ).toBe("FILTERS_UNAVAILABLE");
    expect(
      resolveVacanciesGateState({
        ...readyInput,
        filtersLoading: true,
      }),
    ).toBe("LOADING");
  });
});

describe("candidaturas", () => {
  it("não afirma lista completa quando uma fonte falha, mesmo com cache parcial", () => {
    expect(
      resolveMyApplicationsContentState({
        isLoading: false,
        isPending: false,
        hasError: true,
        hasResolvedApplications: true,
        hasResolvedVacancyRequests: true,
        applicationCount: 1,
        vacancyRequestCount: 0,
      }),
    ).toBe("ERROR");
    expect(
      resolveMyApplicationsContentState({
        isLoading: false,
        isPending: false,
        hasError: false,
        hasResolvedApplications: true,
        hasResolvedVacancyRequests: true,
        applicationCount: 0,
        vacancyRequestCount: 0,
      }),
    ).toBe("EMPTY");
  });

  it("não chama fontes pausadas ou ainda sem resposta de lista vazia", () => {
    expect(
      resolveMyApplicationsContentState({
        isLoading: false,
        isPending: true,
        hasError: false,
        hasResolvedApplications: false,
        hasResolvedVacancyRequests: false,
        applicationCount: 0,
        vacancyRequestCount: 0,
      }),
    ).toBe("UNRESOLVED");
  });
});
