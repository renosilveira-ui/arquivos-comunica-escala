import { describe, expect, it } from "vitest";

import {
  LATE_SEND_TOLERANCE_MS,
  NOTICE_LEAD_MS,
  PLANNING_HORIZON_MS,
  ROUTE_ESTIMATE_TTL_MS,
  ROUTE_LOOKAHEAD_MS,
  buildShiftNoticeMessage,
  departureDedupKey,
  departureFor,
  formatDurationLabel,
  isEstimateUsable,
  isNoticeExpired,
  isWithinPlanningHorizon,
  noticeAt,
  normalizePreferences,
  originSignature,
  routeComputeAt,
  shiftSignature,
  shouldSendNotice,
  type RouteSample,
} from "../server/departure-planning";
import { ROUTE_ESTIMATE_QUALITY } from "../server/integrations/providers/location-provider";

const TZ = "America/Sao_Paulo";
const NOW = new Date("2026-09-11T12:00:00Z");
const SHIFT_START = new Date("2026-09-11T22:00:00Z"); // 19h em São Paulo
const NOTICE = new Date("2026-09-11T21:00:00Z"); // 18h em São Paulo

function sample(overrides: Partial<RouteSample> = {}): RouteSample {
  return {
    durationSeconds: 1500,
    distanceMeters: 9_000,
    quality: ROUTE_ESTIMATE_QUALITY.liveTraffic,
    computedAtUtc: NOW,
    ...overrides,
  };
}

describe("o sistema não pergunta nada ao médico", () => {
  /**
   * Perguntar "quanto tempo você quer de folga?" transfere para o médico uma
   * conta que o sistema tem os dados para fazer, e transforma um aviso
   * automático em mais um formulário.
   */
  it("a única preferência é ligado ou desligado", () => {
    expect(Object.keys(normalizePreferences(null)).sort()).toEqual([
      "enabled",
      "travelMode",
    ]);
  });

  it("nasce desligado", () => {
    expect(normalizePreferences(null).enabled).toBe(false);
    expect(normalizePreferences({}).enabled).toBe(false);
    expect(normalizePreferences({ enabled: true }).enabled).toBe(true);
  });

  it("carro é o padrão, e valor inválido não quebra o cálculo", () => {
    expect(normalizePreferences({ enabled: true }).travelMode).toBe("DRIVING");
    expect(
      normalizePreferences({ travelMode: "TELEPORTE" as never }).travelMode,
    ).toBe("DRIVING");
  });
});

describe("o horário do aviso é fixo", () => {
  /**
   * Uma hora antes, sempre. Não depende do trânsito, não depende de o Google
   * responder, não depende de configuração. Um aviso que só existe quando
   * tudo dá certo é um aviso em que não se pode confiar.
   */
  it("sai uma hora antes do início do plantão", () => {
    expect(NOTICE_LEAD_MS).toBe(60 * 60 * 1000);
    expect(noticeAt(SHIFT_START).toISOString()).toBe(NOTICE.toISOString());
  });

  it("o horário não muda com a duração do trajeto", () => {
    const curto = noticeAt(SHIFT_START);
    const longo = noticeAt(SHIFT_START);
    expect(curto.getTime()).toBe(longo.getTime());
    expect(curto.getTime()).toBe(SHIFT_START.getTime() - NOTICE_LEAD_MS);
  });

  /**
   * A pergunta feita ao Google é "quanto leva agora", e ela só tem resposta
   * útil agora. Calcular pouco antes do aviso é o que faz a estimativa
   * descrever o trânsito que o médico vai pegar — com uma consulta só.
   */
  it("a rota é calculada pouco antes do aviso, uma vez", () => {
    expect(ROUTE_LOOKAHEAD_MS).toBe(10 * 60 * 1000);
    expect(routeComputeAt(SHIFT_START).toISOString()).toBe(
      "2026-09-11T20:50:00.000Z",
    );
  });
});

describe("estimativa de trajeto", () => {
  it("hora de sair = início do plantão menos a duração", () => {
    expect(departureFor(SHIFT_START, 1500).toISOString()).toBe(
      "2026-09-11T21:35:00.000Z",
    );
  });

  it("estimativa recente vale; vencida é descartada", () => {
    expect(isEstimateUsable(sample(), NOW)).toBe(true);
    expect(
      isEstimateUsable(
        sample({
          computedAtUtc: new Date(NOW.getTime() - ROUTE_ESTIMATE_TTL_MS + 1000),
        }),
        NOW,
      ),
    ).toBe(true);
    expect(
      isEstimateUsable(
        sample({
          computedAtUtc: new Date(NOW.getTime() - ROUTE_ESTIMATE_TTL_MS - 1),
        }),
        NOW,
      ),
    ).toBe(false);
    expect(isEstimateUsable(null, NOW)).toBe(false);
  });

  /**
   * Não existe qualidade "chutada". A versão anterior assumia 40 minutos
   * quando a rota falhava; no aparelho do médico esse número tem a mesma
   * aparência de um calculado, e o custo de errar para tarde é um plantão
   * começando sem anestesista.
   */
  it("só existem duas qualidades, ambas vindas do provedor", () => {
    expect(Object.values(ROUTE_ESTIMATE_QUALITY).sort()).toEqual([
      "LIVE_TRAFFIC",
      "TYPICAL",
    ]);
  });
});

describe("a mensagem", () => {
  const base = {
    shiftStartsAtUtc: SHIFT_START,
    sectorName: "UTI",
    hospitalName: "São Carlos",
    timeZone: TZ,
  };

  /**
   * O título nunca muda: é por ele que o médico reconhece a notificação na
   * tela de bloqueio, sem ler o resto.
   */
  it("o título é sempre o mesmo, com ou sem trânsito", () => {
    expect(buildShiftNoticeMessage(base).title).toBe(
      "Horário do plantão se aproxima",
    );
    expect(
      buildShiftNoticeMessage({ ...base, durationSeconds: 1500 }).title,
    ).toBe("Horário do plantão se aproxima");
  });

  it("sempre diz onde e a que horas o plantão começa", () => {
    expect(buildShiftNoticeMessage(base).body).toContain(
      "UTI · São Carlos, às 19:00.",
    );
  });

  /**
   * A duração é o dado; o horário de saída é a decisão. Dar só a duração
   * obrigaria o médico a fazer a subtração de cabeça, às 18h, com o celular
   * na mão.
   */
  it("com trânsito, traz a duração e a hora de sair", () => {
    const body = buildShiftNoticeMessage({
      ...base,
      durationSeconds: 1500,
    }).body;
    expect(body).toContain("25 min");
    expect(body).toContain("saia até 18:35");
    expect(body).not.toContain("não disponíveis");
  });

  it("sem trânsito, diz com todas as letras que não sabe", () => {
    const body = buildShiftNoticeMessage(base).body;
    expect(body).toContain("Estimativas de trânsito não disponíveis.");
    expect(body).not.toMatch(/saia/i);
    expect(body).not.toMatch(/\d+\s*min/);
  });

  it("duração ausente, nula ou zero cai no mesmo caminho", () => {
    for (const durationSeconds of [null, undefined, 0]) {
      expect(
        buildShiftNoticeMessage({ ...base, durationSeconds }).body,
      ).toContain("Estimativas de trânsito não disponíveis.");
    }
  });

  it("o clima entra quando há, e não é obrigatório", () => {
    expect(
      buildShiftNoticeMessage({
        ...base,
        weatherSummary: "Noite com chuva.",
        durationSeconds: 1500,
      }).body,
    ).toContain("Noite com chuva.");
    expect(buildShiftNoticeMessage(base).body).not.toContain("chuva");
  });

  /**
   * O aviso do produto, na íntegra: plantão, clima, trânsito — nessa ordem.
   */
  it("monta o aviso completo na ordem do produto", () => {
    expect(
      buildShiftNoticeMessage({
        ...base,
        weatherSummary: "Noite com chuva.",
        durationSeconds: 1500,
      }).body,
    ).toBe(
      "UTI · São Carlos, às 19:00. Noite com chuva. Trânsito com tempo estimado de 25 min — saia até 18:35.",
    );
  });

  /**
   * Trajeto maior que a antecedência do aviso, ou aviso entregue com atraso:
   * "saia às 17:30" lido às 18h parece defeito do app. A informação
   * verdadeira é que já passou da hora.
   */
  it("quando a hora de sair já passou, diz para sair agora", () => {
    const body = buildShiftNoticeMessage({
      ...base,
      durationSeconds: 90 * 60,
    }).body;
    expect(body).toContain("1 h 30 min");
    expect(body).toContain("saia agora");
    expect(body).not.toMatch(/saia até/);
  });

  it("aviso entregue atrasado também vira saia agora", () => {
    const body = buildShiftNoticeMessage({
      ...base,
      durationSeconds: 1500,
      now: new Date(SHIFT_START.getTime() - 20 * 60_000),
    }).body;
    expect(body).toContain("saia agora");
  });

  it("no horário, o aviso ainda dá o limite de saída", () => {
    const body = buildShiftNoticeMessage({
      ...base,
      durationSeconds: 1500,
      now: NOTICE,
    }).body;
    expect(body).toContain("saia até 18:35");
  });

  it("fuso inválido não derruba o aviso", () => {
    expect(
      buildShiftNoticeMessage({ ...base, timeZone: "Marte/Olympus" }).body,
    ).toContain("--:--");
  });

  it("formata duração em português", () => {
    expect(formatDurationLabel(60)).toBe("1 min");
    expect(formatDurationLabel(1500)).toBe("25 min");
    expect(formatDurationLabel(3600)).toBe("1 h");
    expect(formatDurationLabel(5400)).toBe("1 h 30 min");
  });
});

describe("horizonte de planejamento", () => {
  it("ignora plantão no passado e distante demais", () => {
    expect(isWithinPlanningHorizon(new Date(NOW.getTime() - 1000), NOW)).toBe(
      false,
    );
    expect(
      isWithinPlanningHorizon(
        new Date(NOW.getTime() + PLANNING_HORIZON_MS + 1000),
        NOW,
      ),
    ).toBe(false);
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

  it("mudar horário, setor ou hospital invalida o cálculo", () => {
    const reference = shiftSignature(base);
    expect(shiftSignature({ ...base })).toBe(reference);
    expect(
      shiftSignature({
        ...base,
        startsAtUtc: new Date("2026-09-11T23:00:00Z"),
      }),
    ).not.toBe(reference);
    expect(shiftSignature({ ...base, sectorId: 4 })).not.toBe(reference);
    expect(shiftSignature({ ...base, hospitalId: 9 })).not.toBe(reference);
  });

  it("mudar origem, destino ou modo invalida o cálculo", () => {
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
        destination: { latitude: -23.55, longitude: -46.63 },
      }),
    ).not.toBe(reference);
    expect(
      originSignature({
        ...origin,
        preferences: { ...preferences, travelMode: "TRANSIT" },
      }),
    ).not.toBe(reference);
  });
});

describe("chave de deduplicação", () => {
  /**
   * Um aviso por plantão, em horário fixo — então a chave é estável por
   * construção. Duas execuções do worker produzem a mesma e só uma envia.
   */
  it("o mesmo plantão gera sempre a mesma chave", () => {
    const key = (notice: Date) =>
      departureDedupKey({ userId: 1, assignmentId: 2, noticeAtUtc: notice });
    expect(key(NOTICE)).toBe(key(new Date(NOTICE.getTime() + 59_000)));
  });

  it("usuários e plantões diferentes nunca colidem", () => {
    const key = (userId: number, assignmentId: number) =>
      departureDedupKey({ userId, assignmentId, noticeAtUtc: NOTICE });
    expect(key(1, 2)).not.toBe(key(2, 2));
    expect(key(1, 2)).not.toBe(key(1, 3));
  });

  /**
   * Plantão remarcado é outro aviso: o horário muda, a chave muda, e o novo
   * aviso consegue sair mesmo que o antigo já tenha sido enviado.
   */
  it("plantão remarcado é aviso novo", () => {
    expect(
      departureDedupKey({ userId: 1, assignmentId: 2, noticeAtUtc: NOTICE }),
    ).not.toBe(
      departureDedupKey({
        userId: 1,
        assignmentId: 2,
        noticeAtUtc: new Date(NOTICE.getTime() + 60 * 60 * 1000),
      }),
    );
  });
});

describe("janela de envio", () => {
  it("envia a partir do instante do aviso", () => {
    expect(shouldSendNotice({ noticeAtUtc: NOTICE, now: NOTICE })).toBe(true);
  });

  it("não envia antes da hora", () => {
    expect(
      shouldSendNotice({
        noticeAtUtc: NOTICE,
        now: new Date(NOTICE.getTime() - 1000),
      }),
    ).toBe(false);
  });

  /**
   * Entregue muito depois, o aviso atrapalha: o médico confere o relógio e
   * conclui que o app está errado.
   */
  it("não envia aviso atrasado demais", () => {
    const late = new Date(NOTICE.getTime() + LATE_SEND_TOLERANCE_MS + 1000);
    expect(shouldSendNotice({ noticeAtUtc: NOTICE, now: late })).toBe(false);
    expect(isNoticeExpired({ noticeAtUtc: NOTICE, now: late })).toBe(true);
  });

  it("dentro da tolerância ainda vale", () => {
    const slightly = new Date(NOTICE.getTime() + LATE_SEND_TOLERANCE_MS - 1000);
    expect(shouldSendNotice({ noticeAtUtc: NOTICE, now: slightly })).toBe(true);
    expect(isNoticeExpired({ noticeAtUtc: NOTICE, now: slightly })).toBe(false);
  });
});
