// tests/swap-intent-parser.test.ts — camada 1 da interpretação de trocas e
// cessões: texto → slots. Suíte PURA (sem banco), porque o parser não fala
// com o banco por contrato.
//
// O teste que não pode faltar: "trocar" nunca virar cessão. Antes desta
// frente, "trocar meu plantão de hoje à noite com o João" produzia uma
// CESSÃO — o médico entregava o plantão e não recebia contrapartida.

import { describe, expect, it } from "vitest";
import {
  DATE_HINT,
  findDateHits,
  parsePeriod,
  parseSectorText,
  parseSwapIntent,
} from "../server/natural-language/swap-intent-parser";
import {
  formatDayKeyHuman,
  periodOfStart,
  resolveDateExpression,
} from "../server/natural-language/swap-intent-date";
import {
  acronymOf,
  bestMatches,
  normalizeText,
  professionalMatchTier,
  sectorMatchTier,
  withinEditDistance,
} from "../server/natural-language/swap-intent-text";
import { formatSwapIntentSummary } from "../server/natural-language/swap-intent-summary";
import {
  toCreateSwapOfferInput,
  type ResolvedSwapIntent,
  type SwapIntentDraft,
  type SwapIntentError,
} from "../server/natural-language/swap-intent-types";

const draft = (text: string): SwapIntentDraft => {
  const result = parseSwapIntent(text);
  if ("ok" in result) {
    throw new Error(`esperava slots, veio ${result.code}: ${result.message}`);
  }
  return result;
};

const failure = (text: string): SwapIntentError => {
  const result = parseSwapIntent(text);
  if (!("ok" in result)) throw new Error("esperava erro, veio slots");
  return result;
};

describe("parseSwapIntent — SWAP nunca escorrega para CESSAO", () => {
  it('"troca meu plantão ... com o plantão do ..." é SWAP bidirecional', () => {
    const parsed = draft(
      "Troca meu plantão de amanhã à noite na SR com o plantão do Danilo depois de amanhã à noite.",
    );
    expect(parsed.kind).toBe("SWAP");
    expect(parsed.ownShift).toMatchObject({
      date: { kind: "OFFSET", days: 1 },
      period: "NIGHT",
      sectorText: "sr",
    });
    expect(parsed.targetProfessional.name).toBe("danilo");
    if (parsed.kind !== "SWAP") return;
    expect(parsed.targetShift).toMatchObject({
      date: { kind: "OFFSET", days: 2 },
      period: "NIGHT",
    });
  });

  // Regressão obrigatória: nenhuma forma de "trocar" pode resultar em CESSAO.
  it.each([
    "trocar meu plantão de hoje à noite com o João",
    "troca meu plantão de hoje com o João",
    "troco meu plantão de sexta com a Maria",
    "quero trocar meu plantão de amanhã com o Pedro",
    "permutar meu plantão de hoje com o João",
    "troca de plantão entre eu e Carlos Eduardo hoje",
    "TROCAR MEU PLANTÃO DE HOJE COM O JOÃO",
  ])('"%s" não vira CESSAO', (phrase) => {
    const parsed = draft(phrase);
    expect(parsed.kind).not.toBe("CESSAO");
    expect(parsed.kind).toBe("SWAP");
  });

  it("verbo de troca junto com verbo de cessão é ambíguo, não cessão", () => {
    const error = failure("quero trocar, passo meu plantão de hoje para o João");
    expect(error.code).toBe("AMBIGUOUS_INTENT");
  });

  // Mesma classe do bug original: pessoa pede contrapartida com verbo de
  // cessão e o sistema não pode materializar como cessão silenciosa.
  it.each([
    "passo meu plantão de hoje pro João e ele passa o dele de sexta",
    "passo meu plantão de hoje pro João e me passa o dele",
    "cedo meu plantão de hoje pro João em contrapartida do dele",
    "passo meu plantão de hoje pro João e recebo o de sexta",
    "passo meu plantão de hoje pro João pelo de sexta",
    "cedo meu plantão pro João e fico com o dele de sábado",
    "passo o meu de hoje pro João e pego o de amanhã",
  ])('verbo de cessão com expectativa de contrapartida não vira CESSAO: "%s"', (phrase) => {
    const error = failure(phrase);
    expect(error.code).toBe("AMBIGUOUS_INTENT");
  });

  it("SWAP sem contrapartida dita deixa targetShift.date nulo", () => {
    const parsed = draft("trocar meu plantão de hoje à noite com o João");
    if (parsed.kind !== "SWAP") throw new Error("esperava SWAP");
    // Informação ausente: quem resolve pergunta, não escolhe.
    expect(parsed.targetShift.date).toBeNull();
    expect(parsed.ownShift.period).toBe("NIGHT");
  });
});

describe("parseSwapIntent — CESSAO", () => {
  it('"passo meu plantão ... pro ..." é cessão sem contrapartida', () => {
    const parsed = draft("Passo meu plantão amanhã à noite na SR pro Danilo.");
    expect(parsed.kind).toBe("CESSAO");
    expect(parsed.ownShift).toMatchObject({
      date: { kind: "OFFSET", days: 1 },
      period: "NIGHT",
      sectorText: "sr",
    });
    expect(parsed.targetProfessional.name).toBe("danilo");
    expect("targetShift" in parsed).toBe(false);
  });

  it.each([
    "passo meu plantão de hoje pro João",
    "passar o plantão de amanhã para a Maria",
    "cedo meu plantão de hoje à noite para o João",
    "ceder meu plantão de sexta com o Pedro",
    "transfiro meu plantão de hoje para o João",
    "transferir o plantão de sexta pra Maria",
    "repassar o plantão de amanhã pro João",
    "dar meu plantão de hoje para o João",
    "oferecer meu plantão de hoje para o João",
  ])('"%s" é CESSAO', (phrase) => {
    expect(draft(phrase).kind).toBe("CESSAO");
  });

  it('"cedo" como advérbio de manhã não é o verbo ceder', () => {
    const parsed = draft("trocar hoje cedo com o João");
    expect(parsed.kind).toBe("SWAP");
    expect(parsed.ownShift.period).toBe("MORNING");
  });

  it('"cedo meu plantão de hoje à noite" é o verbo: turno da noite', () => {
    const parsed = draft("cedo meu plantão de hoje à noite para o João");
    expect(parsed.kind).toBe("CESSAO");
    expect(parsed.ownShift.period).toBe("NIGHT");
  });
});

describe("parseSwapIntent — datas", () => {
  it("hoje, amanhã e depois de amanhã", () => {
    expect(draft("passar o plantão de hoje para a Maria").ownShift.date).toMatchObject({ kind: "OFFSET", days: 0 });
    expect(draft("passar o plantão de amanhã para a Maria").ownShift.date).toMatchObject({ kind: "OFFSET", days: 1 });
    expect(draft("passar o plantão de depois de amanhã para a Maria").ownShift.date).toMatchObject({ kind: "OFFSET", days: 2 });
  });

  it('"amanhã" não é lido como turno da manhã', () => {
    expect(draft("passar o plantão de amanhã para a Maria").ownShift.period).toBeNull();
  });

  it("dia da semana, com e sem 'próxima' / 'que vem'", () => {
    expect(draft("ceder meu plantão de sexta com o Pedro").ownShift.date).toMatchObject({ kind: "WEEKDAY", weekday: 5, forceNext: false });
    expect(draft("ceder meu plantão da próxima sexta com o Pedro").ownShift.date).toMatchObject({ kind: "WEEKDAY", weekday: 5, forceNext: true });
    expect(draft("ceder meu plantão de terça-feira que vem com o Pedro").ownShift.date).toMatchObject({ kind: "WEEKDAY", weekday: 2, forceNext: true });
    expect(draft("ceder meu plantão de sábado com o Pedro").ownShift.date).toMatchObject({ kind: "WEEKDAY", weekday: 6 });
  });

  it("dia do mês por extenso, com mês e em barra", () => {
    expect(draft("trocar dia 2 à noite com o João").ownShift.date).toMatchObject({ kind: "ABSOLUTE", day: 2, month: null });
    expect(draft("trocar meu plantão de 2 de setembro com o João").ownShift.date).toMatchObject({ kind: "ABSOLUTE", day: 2, month: 9 });
    expect(draft("trocar meu plantão de 02/09 com o João").ownShift.date).toMatchObject({ kind: "ABSOLUTE", day: 2, month: 9 });
    expect(draft("trocar meu plantão do dia vinte e um com o João").ownShift.date).toMatchObject({ kind: "ABSOLUTE", day: 21, month: null });
    expect(draft("trocar meu plantão do dia primeiro de outubro com o João").ownShift.date).toMatchObject({ kind: "ABSOLUTE", day: 1, month: 10 });
  });

  it('"meu próximo plantão" é slot de data própria', () => {
    expect(draft("passar meu próximo plantão para o Carlos").ownShift.date).toMatchObject({ kind: "NEXT_SHIFT" });
  });

  it('"depois de amanhã" ganha de "amanhã" na mesma frase', () => {
    const hits = findDateHits("de depois de amanha a noite");
    if ("invalid" in hits) throw new Error(hits.invalid);
    expect(hits.hits).toHaveLength(1);
    expect(hits.hits[0].expr).toMatchObject({ kind: "OFFSET", days: 2 });
  });

  it("dia inexistente no mês e dia fora de faixa falham fechado", () => {
    expect(failure("trocar meu plantão do dia 45 com o João").code).toBe("INVALID_DATE");
    const resolved = resolveDateExpression(
      { kind: "ABSOLUTE", day: 31, month: 11, said: "" },
      new Date("2026-09-09T15:00:00Z"),
    );
    expect(resolved.ok).toBe(false);
  });
});

describe("resolveDateExpression — relógio do hospital (−03:00)", () => {
  // Quarta 09/09/2026, 12:00 BRT = 15:00Z.
  const now = new Date("2026-09-09T15:00:00Z");
  const day = (expression: Parameters<typeof resolveDateExpression>[0], at = now) => {
    const resolved = resolveDateExpression(expression, at);
    if (!resolved.ok) throw new Error(resolved.message);
    return resolved.dayKey;
  };

  it("hoje / amanhã / depois de amanhã", () => {
    expect(day({ kind: "OFFSET", days: 0, said: "" })).toBe("2026-09-09");
    expect(day({ kind: "OFFSET", days: 1, said: "" })).toBe("2026-09-10");
    expect(day({ kind: "OFFSET", days: 2, said: "" })).toBe("2026-09-11");
  });

  it("dia da semana pega a próxima ocorrência; 'próxima' pula a de hoje", () => {
    expect(day({ kind: "WEEKDAY", weekday: 5, forceNext: false, said: "" })).toBe("2026-09-11");
    expect(day({ kind: "WEEKDAY", weekday: 3, forceNext: false, said: "" })).toBe("2026-09-09");
    expect(day({ kind: "WEEKDAY", weekday: 3, forceNext: true, said: "" })).toBe("2026-09-16");
    expect(day({ kind: "WEEKDAY", weekday: 1, forceNext: false, said: "" })).toBe("2026-09-14");
  });

  it("dia do mês: sem mês usa o próximo dia N; mês já passado vai para o ano seguinte", () => {
    expect(day({ kind: "ABSOLUTE", day: 20, month: null, said: "" })).toBe("2026-09-20");
    expect(day({ kind: "ABSOLUTE", day: 2, month: null, said: "" })).toBe("2026-10-02");
    expect(day({ kind: "ABSOLUTE", day: 2, month: 9, said: "" })).toBe("2027-09-02");
    expect(day({ kind: "ABSOLUTE", day: 15, month: 12, said: "" })).toBe("2026-12-15");
  });

  it("data passada falha fechado", () => {
    const resolved = resolveDateExpression({ kind: "OFFSET", days: -1, said: "ontem" }, now);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.message).toContain("já passou");
  });

  // O servidor roda em UTC: às 23h no Brasil já é o dia seguinte em UTC.
  it("perto da meia-noite BRT o dia é o do hospital, não o do UTC", () => {
    expect(day({ kind: "OFFSET", days: 0, said: "" }, new Date("2026-09-10T02:00:00Z"))).toBe("2026-09-09");
    expect(day({ kind: "OFFSET", days: 0, said: "" }, new Date("2026-09-10T02:59:59Z"))).toBe("2026-09-09");
    expect(day({ kind: "OFFSET", days: 0, said: "" }, new Date("2026-09-10T03:00:00Z"))).toBe("2026-09-10");
    expect(day({ kind: "OFFSET", days: 1, said: "" }, new Date("2026-09-10T02:00:00Z"))).toBe("2026-09-10");
  });

  it("NEXT_SHIFT não tem dia", () => {
    expect(resolveDateExpression({ kind: "NEXT_SHIFT", said: "" }, now).ok).toBe(false);
  });
});

describe("periodOfStart — faixas do contrato vigente", () => {
  it("classifica pelo horário de início no relógio do hospital", () => {
    expect(periodOfStart(new Date("2026-09-10T10:00:00Z"))).toBe("MORNING"); // 07:00 BRT
    expect(periodOfStart(new Date("2026-09-10T11:30:00Z"))).toBe("MORNING"); // 08:30 BRT
    expect(periodOfStart(new Date("2026-09-10T16:00:00Z"))).toBe("AFTERNOON"); // 13:00 BRT
    expect(periodOfStart(new Date("2026-09-10T20:00:00Z"))).toBe("AFTERNOON"); // 17:00 BRT
    expect(periodOfStart(new Date("2026-09-10T22:00:00Z"))).toBe("NIGHT"); // 19:00 BRT
    expect(periodOfStart(new Date("2026-09-11T01:00:00Z"))).toBe("NIGHT"); // 22:00 BRT
    expect(periodOfStart(new Date("2026-09-11T06:00:00Z"))).toBe("NIGHT"); // 03:00 BRT
  });
});

describe("parsePeriod — manhã, tarde e noite", () => {
  it("reconhece os três turnos e a madrugada", () => {
    expect(parsePeriod("trocar hoje de manha com o joao")).toBe("MORNING");
    expect(parsePeriod("trocar hoje a tarde com o joao")).toBe("AFTERNOON");
    expect(parsePeriod("trocar hoje a noite com o joao")).toBe("NIGHT");
    expect(parsePeriod("trocar hoje de madrugada com o joao")).toBe("NIGHT");
    expect(parsePeriod("trocar hoje cedinho com o joao")).toBe("MORNING");
    expect(parsePeriod("trocar hoje com o joao")).toBeNull();
  });

  it("turno vem dos slots já parseados, com acento e maiúscula", () => {
    expect(draft("trocar hoje DE MANHÃ com o plantão do João de sexta").ownShift.period).toBe("MORNING");
    expect(draft("trocar hoje à TARDE com o plantão do João de sexta").ownShift.period).toBe("AFTERNOON");
  });
});

describe("setor — sigla calculável sem coluna de apelido no schema", () => {
  it("captura o texto do setor depois de na/no/em", () => {
    expect(parseSectorText("de amanha a noite na sr")).toBe("sr");
    expect(parseSectorText("de amanha a noite na sala de recuperacao")).toBe("sala de recuperacao");
    expect(parseSectorText("de amanha no setor centro cirurgico")).toBe("centro cirurgico");
    expect(parseSectorText("de amanha na uti")).toBe("uti");
  });

  it("não confunde dia, turno nem plantão com setor", () => {
    expect(parseSectorText("passar o plantao de sexta")).toBeNull();
    expect(parseSectorText("trocar no dia 2")).toBeNull();
    expect(parseSectorText("trocar amanha na noite")).toBeNull();
  });

  it("aceita SR e o nome completo, com acento e maiúscula", () => {
    expect(draft("passo meu plantão de amanhã na SR pro Danilo").ownShift.sectorText).toBe("sr");
    expect(draft("passo meu plantão de amanhã na Sala de Recuperação pro Danilo").ownShift.sectorText).toBe("sala de recuperacao");
    expect(draft("PASSO MEU PLANTÃO DE AMANHÃ NA SALA DE RECUPERAÇÃO PRO DANILO").ownShift.sectorText).toBe("sala de recuperacao");
  });

  it("sigla é derivada do nome; termo único não gera sigla", () => {
    expect(acronymOf("Sala de Recuperação")).toBe("sr");
    expect(acronymOf("Centro Cirúrgico")).toBe("cc");
    expect(acronymOf("Centro de Terapia Intensiva")).toBe("cti");
    expect(acronymOf("UTI")).toBeNull();
  });

  it("casamento de setor respeita as camadas", () => {
    expect(sectorMatchTier("Sala de Recuperação", "Sala de Recuperação")).toBe(1);
    expect(sectorMatchTier("SR", "Sala de Recuperação")).toBe(2);
    expect(sectorMatchTier("sala recup", "Sala de Recuperação")).toBe(3);
    expect(sectorMatchTier("recuperacaoo", "Sala de Recuperação")).toBe(4);
    expect(sectorMatchTier("UTI", "Sala de Recuperação")).toBeNull();
  });

  it("dois setores SR-like casam na mesma camada — cabe ao resolver perguntar", () => {
    const found = bestMatches(
      [{ name: "Sala de Recuperação" }, { name: "Sala Rosa" }, { name: "UTI" }],
      (sector) => sectorMatchTier("SR", sector.name),
    );
    expect(found.tier).toBe(2);
    expect(found.matches).toHaveLength(2);
  });
});

describe("nome do colega", () => {
  it("títulos saem e o nome para na palavra de contexto", () => {
    expect(draft("trocar meu plantão de hoje com o Dr. João Silva de sexta").targetProfessional.name).toBe("joao silva");
    expect(draft("passar para a doutora Maria o plantão de sexta").targetProfessional.name).toBe("maria");
    expect(draft("trocar com a Ana Paula dia 2").targetProfessional.name).toBe("ana paula");
    expect(draft("troca de plantão entre eu e Carlos Eduardo hoje").targetProfessional.name).toBe("carlos eduardo");
  });

  it("nome completo exato vence primeiro nome", () => {
    expect(professionalMatchTier("Bruno", "Bruno")).toBe(1);
    expect(professionalMatchTier("Bruno", "Bruno Silva")).toBe(2);
    const found = bestMatches(
      [{ name: "Bruno" }, { name: "Bruno Silva" }],
      (person) => professionalMatchTier("Bruno", person.name),
    );
    expect(found.matches).toEqual([{ name: "Bruno" }]);
  });

  it("primeiro nome, primeiro+último e prefixo", () => {
    expect(professionalMatchTier("germana", "Germana Medeiros Mendes")).toBe(2);
    expect(professionalMatchTier("joao silva", "João Pedro Silva")).toBe(2);
    expect(professionalMatchTier("germ", "Germana Medeiros Mendes")).toBe(3);
    expect(professionalMatchTier("carla", "Germana Medeiros Mendes")).toBeNull();
  });

  it("normalização remove acento e caixa", () => {
    expect(normalizeText("  João   SILVA ")).toBe("joao silva");
    expect(professionalMatchTier("joao", "João")).toBe(1);
  });

  it("fuzzy é controlado: uma edição e só em termos longos", () => {
    expect(withinEditDistance("recuperacao", "recuperacaa", 1)).toBe(true);
    expect(withinEditDistance("recuperacao", "recuperacaaa", 1)).toBe(false);
    // Termo curto não entra no fuzzy: "ana" não pode achar "ane".
    expect(professionalMatchTier("ana", "Ane")).toBeNull();
  });
});

describe("parseSwapIntent — o que não é suportado falha fechado", () => {
  it("sem verbo de troca nem de cessão", () => {
    const error = failure("meu plantão de hoje");
    expect(error.code).toBe("UNSUPPORTED_INTENT");
  });

  it("sem colega", () => {
    const error = failure("trocar meu plantão de hoje");
    expect(error.code).toBe("UNSUPPORTED_INTENT");
    expect(error.message).toContain("com quem");
  });

  it("sem dia", () => {
    const error = failure("trocar meu plantão com o João");
    expect(error.code).toBe("INVALID_DATE");
    expect(error.message).toContain("hoje");
    expect(DATE_HINT).toContain("hoje");
  });

  it("intenções fora da V1 não são interpretadas", () => {
    for (const phrase of [
      "aceitar a troca do João",
      "recusar a oferta",
      "confirmar meu plantão de hoje",
      "cancelar meu plantão de amanhã",
      "abrir vaga para o plantão de sexta",
    ]) {
      const result = parseSwapIntent(phrase);
      // Ou não entende, ou não consegue montar slots — nunca materializa.
      if (!("ok" in result)) {
        throw new Error(`"${phrase}" não deveria produzir slots`);
      }
    }
  });
});

describe("parser não é autoridade", () => {
  const collectKeys = (value: unknown, keys: string[] = []): string[] => {
    if (Array.isArray(value)) {
      for (const item of value) collectKeys(item, keys);
      return keys;
    }
    if (value && typeof value === "object") {
      for (const [key, nested] of Object.entries(value)) {
        keys.push(key);
        collectKeys(nested, keys);
      }
    }
    return keys;
  };

  it("nenhum slot devolvido carrega identificador canônico", () => {
    const drafts = [
      draft("Troca meu plantão de amanhã à noite na SR com o plantão do Danilo depois de amanhã à noite."),
      draft("Passo meu plantão amanhã à noite na SR pro Danilo."),
      draft("passar meu próximo plantão para o Carlos"),
    ];
    for (const parsed of drafts) {
      for (const key of collectKeys(parsed)) {
        expect(key).not.toMatch(/Id$/);
        expect([
          "userId",
          "professionalId",
          "institutionId",
          "hospitalId",
          "sectorId",
          "shiftInstanceId",
          "assignmentId",
        ]).not.toContain(key);
      }
    }
  });
});

describe("formatSwapIntentSummary — resumo compartilhado", () => {
  const own = {
    shiftInstanceId: 11,
    assignmentId: 21,
    sectorId: 31,
    sectorName: "Sala de Recuperação",
    label: "Noite",
    dayKey: "2026-09-01",
    timeRange: "19:00–07:00",
    startAt: new Date("2026-09-01T22:00:00Z"),
  };
  const counterpart = { ...own, shiftInstanceId: 12, assignmentId: 22, dayKey: "2026-09-02" };
  const base = {
    ok: true as const,
    actorUserId: 1,
    actorProfessionalId: 2,
    institutionId: 3,
    institutionName: "Instituição Teste",
    ownShift: own,
    targetProfessional: { professionalId: 4, userId: 5, name: "Danilo Souza" },
  };

  it("SWAP mostra os dois plantões", () => {
    const summary = formatSwapIntentSummary({ ...base, kind: "SWAP", targetShift: counterpart });
    expect(summary.title).toBe("Troca solicitada");
    expect(summary.body).toContain("Seu plantão:");
    expect(summary.body).toContain("Plantão de Danilo Souza:");
    expect(summary.body).toContain("01/09");
    expect(summary.body).toContain("02/09");
    expect(summary.body).toContain("Sala de Recuperação");
    expect(summary.confirmation).toContain("Trocar seu plantão");
    expect(summary.confirmation).toContain("pelo plantão de Danilo Souza");
  });

  it("CESSAO mostra o plantão e o destinatário, sem contrapartida", () => {
    const summary = formatSwapIntentSummary({ ...base, kind: "CESSAO", targetShift: null });
    expect(summary.title).toBe("Cessão solicitada");
    expect(summary.body).toContain("Para:");
    expect(summary.body).toContain("Danilo Souza");
    expect(summary.body).not.toContain("Plantão de Danilo Souza:");
    expect(summary.confirmation).toContain("Passar seu plantão");
  });

  it("não expõe PII além do nome do colega", () => {
    const summary = formatSwapIntentSummary({ ...base, kind: "CESSAO", targetShift: null });
    const text = `${summary.title}${summary.body}${summary.confirmation}`;
    expect(text).not.toContain("@");
    expect(text).not.toMatch(/\+\d{6,}/);
    // Identificadores internos não vazam para a pessoa.
    expect(text).not.toContain("11");
    expect(text).not.toContain("21");
  });

  it("dia é formatado no relógio do hospital", () => {
    expect(formatDayKeyHuman("2026-09-01")).toBe("terça, 01/09");
  });
});

describe("toCreateSwapOfferInput — ponte única para o domínio", () => {
  const own = {
    shiftInstanceId: 101,
    assignmentId: 201,
    sectorId: 301,
    sectorName: "Sala de Recuperação",
    label: "Noite",
    dayKey: "2026-09-01",
    timeRange: "19:00–07:00",
    startAt: new Date("2026-09-01T22:00:00Z"),
  };
  const base = {
    ok: true as const,
    actorUserId: 1,
    actorProfessionalId: 2,
    institutionId: 3,
    institutionName: "Instituição Teste",
    ownShift: own,
    targetProfessional: { professionalId: 4, userId: 5, name: "Danilo" },
  };

  it("SWAP leva contrapartida", () => {
    const resolved: ResolvedSwapIntent = {
      ...base,
      kind: "SWAP",
      targetShift: { ...own, shiftInstanceId: 102, assignmentId: 202 },
    };
    expect(toCreateSwapOfferInput(resolved)).toEqual({
      type: "SWAP",
      fromShiftInstanceId: 101,
      fromAssignmentId: 201,
      toShiftInstanceId: 102,
      toProfessionalId: 4,
      reason: undefined,
      expiresInHours: undefined,
    });
  });

  it("CESSAO nunca leva contrapartida", () => {
    const resolved: ResolvedSwapIntent = { ...base, kind: "CESSAO", targetShift: null };
    const input = toCreateSwapOfferInput(resolved, { reason: "Comando de voz" });
    expect(input.type).toBe("CESSAO");
    expect(input.toShiftInstanceId).toBeUndefined();
    expect(input.reason).toBe("Comando de voz");
  });
});
