import { describe, expect, it } from "vitest";

import {
  DEFAULT_ARRIVAL_MARGIN_MINUTES,
  DEFAULT_FALLBACK_TRAVEL_MINUTES,
  LATE_SEND_TOLERANCE_MS,
  PLANNING_HORIZON_MS,
  ROUTE_ESTIMATE_TTL_MS,
  buildDepartureMessage,
  computeDeparture,
  departureDedupKey,
  desiredArrival,
  formatDurationLabel,
  isDepartureExpired,
  isWithinPlanningHorizon,
  nextRecomputeAt,
  normalizePreferences,
  originSignature,
  shiftSignature,
  shouldSendDeparture,
  type RouteSample,
} from "../server/departure-planning";
import { ROUTE_ESTIMATE_QUALITY } from "../server/integrations/providers/location-provider";

const TZ = "America/Sao_Paulo";
const NOW = new Date("2026-09-11T12:00:00Z");
const SHIFT_START = new Date("2026-09-11T22:00:00Z"); // 19h em São Paulo

function sample(overrides: Partial<RouteSample> = {}): RouteSample {
  return {
    durationSeconds: 1800,
    distanceMeters: 12_000,
    quality: ROUTE_ESTIMATE_QUALITY.liveTraffic,
    computedAtUtc: NOW,
    ...overrides,
  };
}

describe("preferências", () => {
  it("desligado é o padrão: nenhum aviso sem opt-in", () => {
    expect(normalizePreferences(null).enabled).toBe(false);
    expect(normalizePreferences({}).enabled).toBe(false);
    expect(normalizePreferences({ enabled: true }).enabled).toBe(true);
  });

  it("valores fora do intervalo são presos, não recusados", () => {
    const wild = normalizePreferences({
      arrivalMarginMinutes: 9999,
      fallbackTravelMinutes: 1,
    });
    expect(wild.arrivalMarginMinutes).toBe(240);
    expect(wild.fallbackTravelMinutes).toBe(5);
  });

  it("lixo cai no padrão em vez de quebrar o cálculo", () => {
    const broken = normalizePreferences({
      arrivalMarginMinutes: Number.NaN,
      fallbackTravelMinutes: "abc" as unknown as number,
      travelMode: "TELEPORTE" as never,
    });
    expect(broken.arrivalMarginMinutes).toBe(DEFAULT_ARRIVAL_MARGIN_MINUTES);
    expect(broken.fallbackTravelMinutes).toBe(DEFAULT_FALLBACK_TRAVEL_MINUTES);
    expect(broken.travelMode).toBe("DRIVING");
  });
});

describe("chegada desejada", () => {
  it("é o início do plantão menos a margem", () => {
    expect(desiredArrival(SHIFT_START, 15).toISOString()).toBe(
      "2026-09-11T21:45:00.000Z",
    );
  });

  it("margem zero significa chegar na hora", () => {
    expect(desiredArrival(SHIFT_START, 0).getTime()).toBe(
      SHIFT_START.getTime(),
    );
  });
});

describe("cálculo do instante de saída", () => {
  it("estimativa fresca manda e preserva a qualidade do provedor", () => {
    const result = computeDeparture({
      desiredArrivalAtUtc: new Date("2026-09-11T21:45:00Z"),
      fresh: sample({ durationSeconds: 1800 }),
      lastKnown: null,
      fallbackTravelMinutes: 40,
      now: NOW,
    });
    expect(result.departAt.toISOString()).toBe("2026-09-11T21:15:00.000Z");
    expect(result.quality).toBe(ROUTE_ESTIMATE_QUALITY.liveTraffic);
    expect(result.stale).toBe(false);
  });

  /**
   * O ponto do desenho: a ausência do Google não pode virar ausência de
   * aviso. Mas o número precisa vir marcado como fallback — um aviso que
   * esconde a origem do dado convida a confiar no que não é trânsito atual.
   */
  it("sem estimativa nenhuma, usa fallback declarado como tal", () => {
    const result = computeDeparture({
      desiredArrivalAtUtc: new Date("2026-09-11T21:45:00Z"),
      fresh: null,
      lastKnown: null,
      fallbackTravelMinutes: 40,
      now: NOW,
    });
    expect(result.departAt.toISOString()).toBe("2026-09-11T21:05:00.000Z");
    expect(result.quality).toBe(ROUTE_ESTIMATE_QUALITY.fallback);
    expect(result.stale).toBe(true);
  });

  it("estimativa anterior dentro do TTL é preferida ao fallback", () => {
    const result = computeDeparture({
      desiredArrivalAtUtc: new Date("2026-09-11T21:45:00Z"),
      fresh: null,
      lastKnown: sample({
        durationSeconds: 2400,
        computedAtUtc: new Date(NOW.getTime() - ROUTE_ESTIMATE_TTL_MS + 60_000),
      }),
      fallbackTravelMinutes: 40,
      now: NOW,
    });
    expect(result.durationSeconds).toBe(2400);
    expect(result.quality).toBe(ROUTE_ESTIMATE_QUALITY.liveTraffic);
    // Marcada como não-atual: a tela precisa distinguir.
    expect(result.stale).toBe(true);
  });

  it("estimativa vencida é descartada em favor do fallback", () => {
    const result = computeDeparture({
      desiredArrivalAtUtc: new Date("2026-09-11T21:45:00Z"),
      fresh: null,
      lastKnown: sample({
        durationSeconds: 2400,
        computedAtUtc: new Date(NOW.getTime() - ROUTE_ESTIMATE_TTL_MS - 1),
      }),
      fallbackTravelMinutes: 40,
      now: NOW,
    });
    expect(result.quality).toBe(ROUTE_ESTIMATE_QUALITY.fallback);
    expect(result.durationSeconds).toBe(40 * 60);
  });

  /**
   * Assimetria que manda no desenho: errar para cedo custa espera; errar para
   * tarde custa um plantão começando sem anestesista. O fallback padrão é
   * maior que a maioria dos trajetos urbanos de propósito.
   */
  it("o fallback padrão erra para o lado seguro", () => {
    expect(DEFAULT_FALLBACK_TRAVEL_MINUTES).toBeGreaterThanOrEqual(30);
  });
});

describe("agenda de recálculo", () => {
  it("escolhe o maior offset ainda no futuro", () => {
    const departAt = new Date("2026-09-11T21:15:00Z");
    const next = nextRecomputeAt(departAt, new Date("2026-09-10T00:00:00Z"));
    expect(next?.toISOString()).toBe("2026-09-10T21:15:00.000Z");
  });

  it("vai apertando conforme a saída se aproxima", () => {
    const departAt = new Date("2026-09-11T21:15:00Z");
    const threeHoursBefore = nextRecomputeAt(
      departAt,
      new Date("2026-09-11T10:00:00Z"),
    );
    expect(threeHoursBefore?.toISOString()).toBe("2026-09-11T18:15:00.000Z");

    const oneHourBefore = nextRecomputeAt(
      departAt,
      new Date("2026-09-11T19:00:00Z"),
    );
    expect(oneHourBefore?.toISOString()).toBe("2026-09-11T20:15:00.000Z");
  });

  it("sem recálculo restante, é hora de enviar", () => {
    const departAt = new Date("2026-09-11T21:15:00Z");
    expect(
      nextRecomputeAt(departAt, new Date("2026-09-11T21:00:00Z")),
    ).toBeNull();
  });
});

describe("horizonte de planejamento", () => {
  it("plantão no passado não entra", () => {
    expect(isWithinPlanningHorizon(new Date(NOW.getTime() - 1000), NOW)).toBe(
      false,
    );
  });

  it("plantão distante demais não ocupa fila", () => {
    expect(
      isWithinPlanningHorizon(
        new Date(NOW.getTime() + PLANNING_HORIZON_MS + 1000),
        NOW,
      ),
    ).toBe(false);
  });

  it("plantão dentro do horizonte entra", () => {
    expect(isWithinPlanningHorizon(SHIFT_START, NOW)).toBe(true);
  });
});

describe("assinaturas — invalidação do cálculo", () => {
  const base = {
    shiftInstanceId: 10,
    startsAtUtc: SHIFT_START,
    endsAtUtc: new Date("2026-09-12T10:00:00Z"),
    sectorId: 3,
    hospitalId: 2,
  };

  it("o mesmo plantão produz a mesma assinatura", () => {
    expect(shiftSignature(base)).toBe(shiftSignature({ ...base }));
  });

  /**
   * Sem isto o médico receberia "saia às 18h07" para um plantão que mudou de
   * hora — um aviso pior do que nenhum, porque ele confia.
   */
  it("mudar horário, setor ou hospital invalida o cálculo", () => {
    const reference = shiftSignature(base);
    expect(
      shiftSignature({
        ...base,
        startsAtUtc: new Date("2026-09-11T23:00:00Z"),
      }),
    ).not.toBe(reference);
    expect(shiftSignature({ ...base, sectorId: 4 })).not.toBe(reference);
    expect(shiftSignature({ ...base, hospitalId: 9 })).not.toBe(reference);
  });

  it("mudar origem, margem ou modo de transporte invalida o cálculo", () => {
    const preferences = normalizePreferences({ enabled: true });
    const origin = {
      travelOriginId: 7,
      originFingerprint: "abc",
      destination: { latitude: -3.7327, longitude: -38.5267 },
      preferences,
    };
    const reference = originSignature(origin);
    expect(originSignature({ ...origin, travelOriginId: 8 })).not.toBe(
      reference,
    );
    expect(originSignature({ ...origin, originFingerprint: "xyz" })).not.toBe(
      reference,
    );
    expect(
      originSignature({
        ...origin,
        preferences: { ...preferences, arrivalMarginMinutes: 30 },
      }),
    ).not.toBe(reference);
    expect(
      originSignature({
        ...origin,
        preferences: { ...preferences, travelMode: "TRANSIT" },
      }),
    ).not.toBe(reference);
    expect(
      originSignature({
        ...origin,
        destination: { latitude: -23.55, longitude: -46.63 },
      }),
    ).not.toBe(reference);
  });

  it("sem origem configurada a assinatura ainda é estável", () => {
    const preferences = normalizePreferences({ enabled: true });
    const first = originSignature({
      travelOriginId: null,
      originFingerprint: null,
      destination: null,
      preferences,
    });
    const second = originSignature({
      travelOriginId: null,
      originFingerprint: null,
      destination: null,
      preferences,
    });
    expect(first).toBe(second);
  });
});

describe("chave de deduplicação", () => {
  it("duas execuções para o mesmo horário produzem a mesma chave", () => {
    const input = {
      userId: 1,
      assignmentId: 2,
      departAtUtc: new Date("2026-09-11T21:15:30Z"),
    };
    expect(departureDedupKey(input)).toBe(
      departureDedupKey({
        ...input,
        // Mesmo minuto: é o mesmo aviso.
        departAtUtc: new Date("2026-09-11T21:15:59Z"),
      }),
    );
  });

  it("horário recalculado é aviso novo e pode sair", () => {
    const first = departureDedupKey({
      userId: 1,
      assignmentId: 2,
      departAtUtc: new Date("2026-09-11T21:15:00Z"),
    });
    const second = departureDedupKey({
      userId: 1,
      assignmentId: 2,
      departAtUtc: new Date("2026-09-11T21:30:00Z"),
    });
    expect(first).not.toBe(second);
  });

  it("usuários e plantões diferentes nunca colidem", () => {
    const at = new Date("2026-09-11T21:15:00Z");
    expect(
      departureDedupKey({ userId: 1, assignmentId: 2, departAtUtc: at }),
    ).not.toBe(
      departureDedupKey({ userId: 2, assignmentId: 2, departAtUtc: at }),
    );
    expect(
      departureDedupKey({ userId: 1, assignmentId: 2, departAtUtc: at }),
    ).not.toBe(
      departureDedupKey({ userId: 1, assignmentId: 3, departAtUtc: at }),
    );
  });
});

describe("mensagem do aviso", () => {
  const base = {
    departAtUtc: new Date("2026-09-11T21:15:00Z"),
    shiftStartsAtUtc: SHIFT_START,
    durationSeconds: 1800,
    sectorName: "UTI",
    hospitalName: "São Carlos",
    timeZone: TZ,
  };

  it("diz a hora de sair no relógio local", () => {
    const message = buildDepartureMessage({
      ...base,
      quality: ROUTE_ESTIMATE_QUALITY.liveTraffic,
      stale: false,
    });
    expect(message.title).toBe("Saia às 18:15");
    expect(message.body).toContain("plantão às 19:00");
    expect(message.body).toContain("UTI · São Carlos");
    expect(message.body).toContain("30 min");
  });

  /**
   * A origem do número precisa aparecer. Um aviso que esconde ser fallback
   * convida o médico a confiar em algo que não é trânsito atual.
   */
  it("distingue trânsito atual, tempo típico, estimativa velha e fallback", () => {
    expect(
      buildDepartureMessage({
        ...base,
        quality: ROUTE_ESTIMATE_QUALITY.liveTraffic,
        stale: false,
      }).body,
    ).toContain("com trânsito agora");

    expect(
      buildDepartureMessage({
        ...base,
        quality: ROUTE_ESTIMATE_QUALITY.typical,
        stale: false,
      }).body,
    ).toContain("tempo típico");

    expect(
      buildDepartureMessage({
        ...base,
        quality: ROUTE_ESTIMATE_QUALITY.liveTraffic,
        stale: true,
      }).body,
    ).toContain("última estimativa");

    expect(
      buildDepartureMessage({
        ...base,
        quality: ROUTE_ESTIMATE_QUALITY.fallback,
        stale: true,
      }).body,
    ).toContain("não foi possível consultar o trânsito");
  });

  it("o clima enriquece, mas não é obrigatório", () => {
    const withWeather = buildDepartureMessage({
      ...base,
      quality: ROUTE_ESTIMATE_QUALITY.typical,
      stale: false,
      weatherSummary: "Chuva forte na saída.",
    });
    expect(withWeather.body).toContain("Chuva forte na saída.");

    const without = buildDepartureMessage({
      ...base,
      quality: ROUTE_ESTIMATE_QUALITY.typical,
      stale: false,
      weatherSummary: null,
    });
    expect(without.body).not.toContain("Chuva");
    expect(without.title).toBe("Saia às 18:15");
  });

  it("formata duração em português", () => {
    expect(formatDurationLabel(60)).toBe("1 min");
    expect(formatDurationLabel(1800)).toBe("30 min");
    expect(formatDurationLabel(3600)).toBe("1 h");
    expect(formatDurationLabel(5400)).toBe("1 h 30 min");
    expect(formatDurationLabel(10)).toBe("1 min");
  });
});

describe("janela de envio", () => {
  const departAt = new Date("2026-09-11T21:15:00Z");

  it("envia a partir do instante calculado", () => {
    expect(shouldSendDeparture({ departAtUtc: departAt, now: departAt })).toBe(
      true,
    );
  });

  it("não envia antes da hora", () => {
    expect(
      shouldSendDeparture({
        departAtUtc: departAt,
        now: new Date(departAt.getTime() - 1000),
      }),
    ).toBe(false);
  });

  /**
   * "Saia às 18h07" entregue às 18h40 não ajuda: o médico confere o relógio e
   * conclui que o app está errado. Passada a tolerância, encerra sem enviar.
   */
  it("não envia aviso atrasado demais", () => {
    const late = new Date(departAt.getTime() + LATE_SEND_TOLERANCE_MS + 1000);
    expect(shouldSendDeparture({ departAtUtc: departAt, now: late })).toBe(
      false,
    );
    expect(isDepartureExpired({ departAtUtc: departAt, now: late })).toBe(true);
  });

  it("dentro da tolerância ainda vale", () => {
    const slightlyLate = new Date(
      departAt.getTime() + LATE_SEND_TOLERANCE_MS - 1000,
    );
    expect(
      shouldSendDeparture({ departAtUtc: departAt, now: slightlyLate }),
    ).toBe(true);
    expect(
      isDepartureExpired({ departAtUtc: departAt, now: slightlyLate }),
    ).toBe(false);
  });
});
