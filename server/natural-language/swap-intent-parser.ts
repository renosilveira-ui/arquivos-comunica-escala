// server/natural-language/swap-intent-parser.ts — texto → slots semânticos.
//
// Camada 1 de duas. Determinística, sem IA e SEM BANCO: o espaço de
// comandos da V1 são duas intenções (troca e cessão) e os padrões em PT-BR
// cobrem bem. O que não é entendido volta como UNSUPPORTED_INTENT ou
// AMBIGUOUS_INTENT — nunca se adivinha.
//
// Este módulo NÃO é autoridade. Ele nunca devolve userId, professionalId,
// institutionId, sectorId, shiftInstanceId ou assignmentId; só texto e
// estrutura. Quem transforma slot em entidade é o resolver, e quem
// materializa é `createSwapOffer`.

import {
  swapIntentError,
  type DateExpression,
  type ShiftPeriod,
  type ShiftSlot,
  type SwapIntentDraft,
  type SwapIntentError,
} from "./swap-intent-types";
import { normalizeText } from "./swap-intent-text";

const MONTHS: Record<string, number> = {
  janeiro: 1,
  fevereiro: 2,
  marco: 3,
  abril: 4,
  maio: 5,
  junho: 6,
  julho: 7,
  agosto: 8,
  setembro: 9,
  outubro: 10,
  novembro: 11,
  dezembro: 12,
};

const WEEKDAYS: Record<string, number> = {
  domingo: 0,
  segunda: 1,
  terca: 2,
  quarta: 3,
  quinta: 4,
  sexta: 5,
  sabado: 6,
};

// Números por extenso que o reconhecimento de fala costuma devolver.
const UNITS: Record<string, number> = {
  um: 1,
  uma: 1,
  primeiro: 1,
  dois: 2,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  onze: 11,
  doze: 12,
  treze: 13,
  catorze: 14,
  quatorze: 14,
  quinze: 15,
  dezesseis: 16,
  dezessete: 17,
  dezoito: 18,
  dezenove: 19,
  vinte: 20,
  trinta: 30,
};

const DAY_WORD =
  "(?:\\d{1,2}|(?:vinte|trinta)(?: e (?:um|dois|tres|quatro|cinco|seis|sete|oito|nove))?|um|uma|primeiro|dois|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|catorze|quatorze|quinze|dezesseis|dezessete|dezoito|dezenove)";
const MONTH_WORD =
  "(?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)";

export const DATE_HINT = 'Diga o dia: "hoje", "amanhã", "sexta" ou "dia 2".';

/** Verbos de TROCA bidirecional. Nunca podem cair em cessão (§9). */
const SWAP_VERB = /\b(?:troc\w*|permut\w*)\b/;

/** Verbos de CESSÃO unidirecional. */
const CESSAO_VERB =
  /\b(?:passar|passo|passa|ceder|cede|repassar|repasso|repassa|transferir|transfiro|transfere|dar|dou|oferecer|ofereco|oferece|entregar|entrego)\b/;

/**
 * "cedo" é ambíguo: verbo ceder ("cedo meu plantão") ou advérbio de manhã
 * ("hoje cedo"). Só conta como turno quando qualifica um dia/horário.
 */
function cedoIsPeriod(text: string): boolean {
  return /\b(?:hoje|amanha|ontem|bem|de|mais|segunda|terca|quarta|quinta|sexta|sabado|domingo)\s+cedo\b/.test(
    text,
  );
}

function hasCessaoVerb(text: string): boolean {
  if (CESSAO_VERB.test(text)) return true;
  return /\bcedo\b/.test(text) && !cedoIsPeriod(text);
}

// ── Datas ──────────────────────────────────────────────────────────────

type DateHit = { expr: DateExpression; start: number; end: number };

/** "vinte e um" → 21; "dois" → 2; "15" → 15. */
function parseDayNumber(token: string): number | null {
  if (/^\d{1,2}$/.test(token)) return Number(token);
  let total = 0;
  for (const part of token.split(" e ")) {
    const value = UNITS[part];
    if (value === undefined) return null;
    total += value;
  }
  return total || null;
}

function collect(
  text: string,
  pattern: RegExp,
  build: (match: RegExpExecArray) => DateExpression | { invalid: string } | null,
  hits: DateHit[],
  invalid: { message: string | null },
): void {
  const regex = new RegExp(pattern.source, "g");
  let match = regex.exec(text);
  while (match !== null) {
    const built = build(match);
    if (built && "invalid" in built) {
      invalid.message ??= built.invalid;
    } else if (built) {
      hits.push({ expr: built, start: match.index, end: match.index + match[0].length });
    }
    match = regex.exec(text);
  }
}

/**
 * Todas as datas ditas no trecho, em ordem e sem sobreposição.
 * Empate resolve pela que começa antes e, aí sim, pela mais longa —
 * é o que faz "depois de amanhã" ganhar de "amanhã".
 */
export function findDateHits(
  text: string,
): { hits: DateHit[] } | { invalid: string } {
  const hits: DateHit[] = [];
  const invalid: { message: string | null } = { message: null };

  collect(text, /\bdepois de amanha\b/, () => ({ kind: "OFFSET", days: 2, said: "depois de amanhã" }), hits, invalid);
  collect(text, /\bamanha\b/, () => ({ kind: "OFFSET", days: 1, said: "amanhã" }), hits, invalid);
  collect(text, /\bhoje\b/, () => ({ kind: "OFFSET", days: 0, said: "hoje" }), hits, invalid);
  collect(text, /\bontem\b/, () => ({ kind: "OFFSET", days: -1, said: "ontem" }), hits, invalid);
  collect(
    text,
    /\bproximo plantao\b/,
    () => ({ kind: "NEXT_SHIFT", said: "seu próximo plantão" }),
    hits,
    invalid,
  );

  const absolute = (match: RegExpExecArray): DateExpression | { invalid: string } => {
    const day = parseDayNumber(match[1]);
    if (!day || day < 1 || day > 31) {
      return { invalid: `Dia inválido: "${match[1]}". ${DATE_HINT}` };
    }
    let month: number | null = null;
    if (match[2]) {
      month = /^\d+$/.test(match[2]) ? Number(match[2]) : (MONTHS[match[2]] ?? null);
      if (!month || month < 1 || month > 12) {
        return { invalid: `Não reconheci o mês "${match[2]}".` };
      }
    }
    return { kind: "ABSOLUTE", day, month, said: match[0] };
  };

  collect(text, new RegExp(`\\bdia (${DAY_WORD})\\b(?: de (${MONTH_WORD}))?`), absolute, hits, invalid);
  collect(text, new RegExp(`\\b(${DAY_WORD}) de (${MONTH_WORD})\\b`), absolute, hits, invalid);
  collect(text, /\b(\d{1,2})\/(\d{1,2})\b/, absolute, hits, invalid);

  collect(
    text,
    /\b(?:(proxima|proximo)\s+)?(segunda|terca|quarta|quinta|sexta|sabado|domingo)(?:-feira)?\b(?:\s+(que vem))?/,
    (match) => ({
      kind: "WEEKDAY",
      weekday: WEEKDAYS[match[2]],
      forceNext: Boolean(match[1] || match[3]),
      said: match[0],
    }),
    hits,
    invalid,
  );

  if (invalid.message) return { invalid: invalid.message };

  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const accepted: DateHit[] = [];
  let consumedUntil = -1;
  for (const hit of hits) {
    if (hit.start < consumedUntil) continue;
    accepted.push(hit);
    consumedUntil = hit.end;
  }
  return { hits: accepted };
}

// ── Turno ──────────────────────────────────────────────────────────────

export function parsePeriod(text: string): ShiftPeriod | null {
  // "amanha" contém "manha"; o \b impede o falso positivo.
  if (/\bmanha\b|\bcedinho\b/.test(text) || cedoIsPeriod(text)) return "MORNING";
  if (/\btarde\b/.test(text)) return "AFTERNOON";
  if (/\bnoite\b|\bmadrugada\b/.test(text)) return "NIGHT";
  return null;
}

// ── Setor ──────────────────────────────────────────────────────────────

/** Palavras que encerram a captura de um nome de setor. */
const SECTOR_STOP = new Set([
  "plantao",
  "plantoes",
  "turno",
  "escala",
  "com",
  "para",
  "pro",
  "pra",
  "entre",
  "eu",
  "meu",
  "minha",
  "seu",
  "sua",
  "dele",
  "dela",
  "dia",
  "hoje",
  "amanha",
  "ontem",
  "depois",
  "manha",
  "tarde",
  "noite",
  "madrugada",
  "cedo",
  "cedinho",
  "segunda",
  "terca",
  "quarta",
  "quinta",
  "sexta",
  "sabado",
  "domingo",
  "proxima",
  "proximo",
  "que",
  "vem",
  "por",
  "favor",
  "setor",
]);

function isSectorStop(token: string): boolean {
  if (SECTOR_STOP.has(token)) return true;
  if (/\d/.test(token)) return true;
  if (SWAP_VERB.test(token) || CESSAO_VERB.test(token)) return true;
  return Object.hasOwn(MONTHS, token) || Object.hasOwn(UNITS, token);
}

const SECTOR_CONNECTORS = new Set(["de", "da", "do", "das", "dos", "e"]);

/**
 * Setor dito depois de "na"/"no"/"em"/"setor": "na SR",
 * "na sala de recuperação", "no setor Centro Cirúrgico".
 *
 * Conectivos são aceitos NO MEIO (senão "sala de recuperação" viraria só
 * "sala") mas nunca no fim.
 */
export function parseSectorText(text: string): string | null {
  const regex = /\b(?:na|no|em)\s+(?:setor\s+(?:de\s+|da\s+|do\s+)?)?/g;
  let match = regex.exec(text);
  while (match !== null) {
    const rest = text.slice(match.index + match[0].length).split(" ").filter(Boolean);
    const taken: string[] = [];
    for (const token of rest) {
      if (taken.length >= 5) break;
      if (SECTOR_CONNECTORS.has(token)) {
        // Conectivo só entra se já há termo antes e vem termo depois.
        if (taken.length === 0) break;
        taken.push(token);
        continue;
      }
      if (isSectorStop(token)) break;
      taken.push(token);
    }
    while (taken.length > 0 && SECTOR_CONNECTORS.has(taken[taken.length - 1])) {
      taken.pop();
    }
    if (taken.length > 0) return taken.join(" ");
    match = regex.exec(text);
  }
  return null;
}

// ── Colega ─────────────────────────────────────────────────────────────

/** Palavras que encerram o nome do colega ("com o João dia 2" → "joao"). */
const NAME_STOP = new Set([
  "dia",
  "no",
  "na",
  "do",
  "da",
  "de",
  "o",
  "a",
  "os",
  "as",
  "e",
  "em",
  "plantao",
  "plantoes",
  "turno",
  "escala",
  "manha",
  "tarde",
  "noite",
  "madrugada",
  "cedo",
  "cedinho",
  "hoje",
  "amanha",
  "ontem",
  "depois",
  "segunda",
  "terca",
  "quarta",
  "quinta",
  "sexta",
  "sabado",
  "domingo",
  "proxima",
  "proximo",
  "que",
  "vem",
  "meu",
  "minha",
  "seu",
  "sua",
  "dele",
  "dela",
  "por",
  "favor",
  "com",
  "para",
  "pro",
  "pra",
  "entre",
]);

/**
 * Onde o colega é introduzido. `counterpart` distingue as duas formas:
 * "com o plantão do Danilo" (a data seguinte é a CONTRAPARTIDA) de
 * "com o Danilo" (a data seguinte ainda é sobre o plantão próprio).
 */
const TARGET_MARKER =
  /\b(?:com|para|pro|pra|entre eu e)\s+(?:(?:o|a|os|as)\s+)?(plantao\s+(?:do|da|de)\s+(?:(?:o|a)\s+)?)?/;

function takeName(segment: string): string {
  const taken: string[] = [];
  for (const token of segment.split(" ").filter(Boolean)) {
    if (taken.length >= 4) break;
    if (NAME_STOP.has(token) || /\d/.test(token)) break;
    if (SWAP_VERB.test(token) || CESSAO_VERB.test(token)) break;
    taken.push(token);
  }
  return taken.join(" ");
}

// ── Parser ─────────────────────────────────────────────────────────────

/**
 * Interpreta a frase. Devolve slots ou um erro com mensagem pronta.
 * `raw` é a transcrição de voz ou o corpo da mensagem inbound.
 */
export function parseSwapIntent(raw: string): SwapIntentDraft | SwapIntentError {
  // Pontuação de fim de frase sai; "/" fica, porque "02/09" é data.
  const text = normalizeText(raw)
    .replace(/\b(?:dr|dra|doutor|doutora)\.?\s+/g, "")
    .replace(/[.,;:!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const swap = SWAP_VERB.test(text);
  const cessao = hasCessaoVerb(text);

  if (!swap && !cessao) {
    return swapIntentError(
      "UNSUPPORTED_INTENT",
      'Não entendi o comando. Exemplo: "trocar meu plantão de hoje à noite com o plantão do João de sexta" ou "passar meu plantão de hoje à noite para o João".',
    );
  }
  if (swap && cessao) {
    // Fail-closed: "trocar" jamais escorrega para cessão silenciosamente.
    return swapIntentError(
      "AMBIGUOUS_INTENT",
      'Não ficou claro se você quer trocar (recebendo um plantão em troca) ou passar o plantão. Diga "trocar meu plantão ... com o plantão do ..." ou "passar meu plantão ... para ...".',
    );
  }
  const kind = swap ? "SWAP" : "CESSAO";

  const marker = text.match(TARGET_MARKER);
  if (!marker || marker.index === undefined) {
    return swapIntentError(
      "UNSUPPORTED_INTENT",
      'Não identifiquei com quem é a solicitação. Diga, por exemplo, "com o João".',
    );
  }
  const isCounterpartForm = Boolean(marker[1]);
  const ownSegment = text.slice(0, marker.index);
  const afterMarker = text.slice(marker.index + marker[0].length);

  const name = takeName(afterMarker);
  if (!name) {
    return swapIntentError(
      "UNSUPPORTED_INTENT",
      'Não identifiquei com quem é a solicitação. Diga, por exemplo, "com o João".',
    );
  }
  const targetRest = afterMarker.slice(name.length);

  const ownHits = findDateHits(ownSegment);
  if ("invalid" in ownHits) return swapIntentError("INVALID_DATE", ownHits.invalid);
  const targetHits = findDateHits(targetRest);
  if ("invalid" in targetHits) return swapIntentError("INVALID_DATE", targetHits.invalid);

  // "troca de plantão entre eu e Carlos hoje": a única data está depois do
  // nome e é do plantão PRÓPRIO — só quando a forma não é de contrapartida.
  const dateAfterNameIsOwn =
    !isCounterpartForm && ownHits.hits.length === 0 && targetHits.hits.length > 0;

  const ownDate = dateAfterNameIsOwn ? targetHits.hits[0].expr : ownHits.hits[0]?.expr;
  if (!ownDate) {
    return swapIntentError(
      "INVALID_DATE",
      `Não identifiquei o dia do seu plantão. ${DATE_HINT}`,
    );
  }

  const ownContext = dateAfterNameIsOwn ? `${ownSegment} ${targetRest}` : ownSegment;
  const ownShift = {
    date: ownDate,
    period: parsePeriod(ownContext),
    sectorText: parseSectorText(ownContext),
  };

  if (kind === "CESSAO") {
    return { kind, ownShift, targetProfessional: { name } };
  }

  const targetDate = dateAfterNameIsOwn
    ? (targetHits.hits[1]?.expr ?? null)
    : (targetHits.hits[0]?.expr ?? null);
  // NEXT_SHIFT descreve "meu próximo plantão": não serve de contrapartida.
  const targetShift: ShiftSlot = {
    date: targetDate && targetDate.kind !== "NEXT_SHIFT" ? targetDate : null,
    period: dateAfterNameIsOwn ? null : parsePeriod(targetRest),
    sectorText: dateAfterNameIsOwn ? null : parseSectorText(targetRest),
  };
  return { kind, ownShift, targetProfessional: { name }, targetShift };
}
