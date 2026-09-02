import { describe, expect, it } from "vitest";
import {
  VACANCY_PUSH_ROUTE_PARAM,
  clearVacancyPushRouteParams,
  createVacancyPushIntentNotificationFence,
  isVacancyPushIntentConsumptionFenceCurrent,
  isVacancyPushIntentPublicationCurrent,
  matchVacancyPushIntentPublicationForRoute,
  parseVacancyPushIntentId,
  resolveVacancyPushIntentRouteState,
  vacancyPushRouteParams,
} from "../lib/vacancy-push-route";

describe("intenção de rota para push de vagas", () => {
  const tenant = { institutionId: 12, revision: 7 } as const;

  it("aceita somente um ID positivo não ambíguo e produz parâmetros mínimos", () => {
    expect(parseVacancyPushIntentId("404")).toBe(404);
    expect(parseVacancyPushIntentId(404)).toBe(404);
    expect(parseVacancyPushIntentId(["404", "405"])).toBeNull();
    expect(parseVacancyPushIntentId("04")).toBeNull();
    expect(parseVacancyPushIntentId("404x")).toBeNull();
    expect(vacancyPushRouteParams(404)).toEqual({
      [VACANCY_PUSH_ROUTE_PARAM]: "404",
    });
    expect(clearVacancyPushRouteParams()).toEqual({
      [VACANCY_PUSH_ROUTE_PARAM]: undefined,
    });
  });

  it("seleciona a data futura somente a partir da resolução autorizada", () => {
    expect(
      resolveVacancyPushIntentRouteState({
        intentShiftInstanceId: 404,
        resolutionTenant: tenant,
        currentTenant: tenant,
        isFetching: false,
        isError: false,
        data: {
          available: true,
          shiftInstanceId: 404,
          hospitalId: 12,
          sectorId: 18,
          date: "2037-04-16",
        },
      }),
    ).toEqual({
      kind: "READY",
      selection: {
        hospitalId: 12,
        sectorId: 18,
        date: "2037-04-16",
      },
    });
  });

  it("falha de modo seguro para resposta antiga quando o parâmetro muda com a aba montada", () => {
    const responseForPreviousIntent = {
      available: true as const,
      shiftInstanceId: 404,
      hospitalId: 12,
      sectorId: 18,
      date: "2037-04-16",
    };

    expect(
      resolveVacancyPushIntentRouteState({
        intentShiftInstanceId: 405,
        resolutionTenant: tenant,
        currentTenant: tenant,
        isFetching: false,
        isError: false,
        data: responseForPreviousIntent,
      }),
    ).toEqual({ kind: "ERROR" });

    expect(
      resolveVacancyPushIntentRouteState({
        intentShiftInstanceId: 405,
        resolutionTenant: tenant,
        currentTenant: tenant,
        isFetching: false,
        isError: false,
        data: {
          ...responseForPreviousIntent,
          shiftInstanceId: 405,
          date: "2037-04-17",
        },
      }),
    ).toEqual({
      kind: "READY",
      selection: {
        hospitalId: 12,
        sectorId: 18,
        date: "2037-04-17",
      },
    });
  });

  it("mantém alvo indisponível genérico e sem metadados de turno", () => {
    expect(
      resolveVacancyPushIntentRouteState({
        intentShiftInstanceId: 404,
        resolutionTenant: tenant,
        currentTenant: tenant,
        isFetching: false,
        isError: false,
        data: { available: false },
      }),
    ).toEqual({ kind: "UNAVAILABLE" });
  });

  it("descarta uma resposta de revisão anterior mesmo após retorno ao mesmo tenant", () => {
    expect(
      resolveVacancyPushIntentRouteState({
        intentShiftInstanceId: 404,
        resolutionTenant: tenant,
        currentTenant: { institutionId: 12, revision: 8 },
        isFetching: false,
        isError: false,
        data: {
          available: true,
          shiftInstanceId: 404,
          hospitalId: 12,
          sectorId: 18,
          date: "2037-04-16",
        },
      }),
    ).toEqual({ kind: "ERROR" });
  });

  it("não consome A READY se B é publicado antes do rerender", () => {
    const notificationFence = createVacancyPushIntentNotificationFence();
    const userId = 77;
    const sessionGeneration = 7;
    const publicationA = notificationFence.publish(
      userId,
      sessionGeneration,
      404,
    )!;
    const effectA = {
      userId,
      sessionGeneration,
      tenantId: 12,
      tenantRevision: 7,
      intentShiftInstanceId: 404,
      intentGeneration: publicationA.generation,
    } as const;
    // B chega no mesmo tenant; o React ainda expõe A no render atual.
    const publicationB = notificationFence.publish(
      userId,
      sessionGeneration,
      405,
    )!;
    const mutations = {
      applyFilters: 0,
      markHandled: 0,
      clearRoute: 0,
    };

    const consumeReadyA = () => {
      if (
        !isVacancyPushIntentConsumptionFenceCurrent(effectA, effectA) ||
        !isVacancyPushIntentPublicationCurrent(
          publicationA,
          notificationFence.current(),
          userId,
          sessionGeneration,
        )
      ) {
        return;
      }
      mutations.markHandled += 1;
      mutations.applyFilters += 1;
      mutations.clearRoute += 1;
    };

    consumeReadyA();

    expect(mutations).toEqual({
      applyFilters: 0,
      markHandled: 0,
      clearRoute: 0,
    });
    expect(
      isVacancyPushIntentPublicationCurrent(
        publicationB,
        notificationFence.current(),
        userId,
        sessionGeneration,
      ),
    ).toBe(true);
    expect(notificationFence.clearIfCurrent(publicationA)).toBe(false);
    expect(notificationFence.current()).toEqual(publicationB);
  });

  it("permite deep link externo somente quando não há push pendente", () => {
    const notificationFence = createVacancyPushIntentNotificationFence();
    const userId = 77;
    const sessionGeneration = 7;

    expect(
      isVacancyPushIntentPublicationCurrent(
        null,
        notificationFence.current(),
        userId,
        sessionGeneration,
      ),
    ).toBe(true);

    notificationFence.publish(userId, sessionGeneration, 404);

    expect(
      isVacancyPushIntentPublicationCurrent(
        null,
        notificationFence.current(),
        userId,
        sessionGeneration,
      ),
    ).toBe(false);
  });

  it("trata publicação de outra conta como ausente para B e bloqueia A", () => {
    const notificationFence = createVacancyPushIntentNotificationFence();
    const publicationA = notificationFence.publish(77, 7, 404)!;

    expect(
      isVacancyPushIntentPublicationCurrent(
        null,
        notificationFence.current(),
        88,
        8,
      ),
    ).toBe(true);
    expect(
      isVacancyPushIntentPublicationCurrent(
        publicationA,
        notificationFence.current(),
        88,
        8,
      ),
    ).toBe(false);
  });

  it("invalida a publicação de A após rotação da mesma conta, sem bloquear deep link novo", () => {
    const notificationFence = createVacancyPushIntentNotificationFence();
    const publicationA = notificationFence.publish(77, 7, 404)!;

    expect(
      isVacancyPushIntentPublicationCurrent(
        publicationA,
        notificationFence.current(),
        77,
        8,
      ),
    ).toBe(false);
    expect(
      isVacancyPushIntentPublicationCurrent(
        null,
        notificationFence.current(),
        77,
        8,
      ),
    ).toBe(true);
  });

  it("trata fence da sessão antiga como ausente para deep link externo do mesmo plantão", () => {
    const notificationFence = createVacancyPushIntentNotificationFence();
    notificationFence.publish(77, 7, 404);

    const expectedPublication = matchVacancyPushIntentPublicationForRoute(
      notificationFence.current(),
      77,
      8,
      404,
    );

    expect(expectedPublication).toBeNull();
    expect(
      isVacancyPushIntentPublicationCurrent(
        expectedPublication,
        notificationFence.current(),
        77,
        8,
      ),
    ).toBe(true);
  });

  it("limpa somente a intenção do ticket encerrado e preserva a mais nova", () => {
    const notificationFence = createVacancyPushIntentNotificationFence();
    const publicationA = notificationFence.publish(77, 7, 404)!;

    expect(notificationFence.clearIfSessionCurrent(77, 7)).toBe(true);
    expect(notificationFence.current()).toBeNull();

    const publicationB = notificationFence.publish(77, 8, 405)!;
    expect(notificationFence.clearIfSessionCurrent(77, 7)).toBe(false);
    expect(notificationFence.current()).toEqual(publicationB);
    expect(notificationFence.clearIfCurrent(publicationA)).toBe(false);
  });
});
