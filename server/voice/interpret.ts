// server/voice/interpret.ts — motor do comando de voz (Fase 1: trocas).
//
// Entrada: texto transcrito no aparelho ("troca de plantão entre eu e
// João, dia 2 à noite"). Saída: intenção estruturada + entidades
// RESOLVIDAS (plantão real do usuário + colega real do serviço), pronta
// para a tela de confirmação. NUNCA executa nada — a execução é o
// fluxo normal de swaps.offer (direcionada) → aceite → aprovação,
// com todas as validações e auditoria de sempre.
//
// v1 determinística (sem IA): o espaço de comandos é estreito e os
// padrões em PT-BR cobrem bem. A função parseVoiceCommand é o ponto de
// troca para um interpretador por LLM no futuro (mesma assinatura).
//
// Datas aceitas (v1.1): "hoje", "amanhã", "depois de amanhã", dia da
// semana ("sexta", "próxima sexta", "sexta que vem"), "dia 2",
// "dia vinte e um", "2 de setembro", "02/09" e "meu próximo plantão".

import { and, eq, gte, lt } from "drizzle-orm";
import { getDb } from "../db";
import {
  professionals,
  professionalInstitutions,
  shiftAssignmentsV2,
  shiftInstances,
} from "../../drizzle/schema";
import { specialtiesConflict } from "../specialty";

// ── Parsing ────────────────────────────────────────────────────────────

export type VoiceDate =
  | { kind: "offset"; days: number; said: string }
  | { kind: "weekday"; weekday: number; forceNext: boolean; said: string }
  | { kind: "absolute"; day: number; month: number | null; said: string }
  | { kind: "next-shift"; said: string };

export type VoicePeriod = "manha" | "tarde" | "noite";

export interface ParsedCommand {
  kind: "TROCA";
  targetName: string;
  date: VoiceDate;
  period: VoicePeriod | null;
}

export interface ParseFailure {
  kind: "FALHA";
  reason: string;
}

const MONTHS: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

const WEEKDAYS: Record<string, number> = {
  domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6,
};

const WEEKDAY_LABEL = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

// Números por extenso que o reconhecimento de fala costuma devolver.
const UNITS: Record<string, number> = {
  um: 1, uma: 1, primeiro: 1, dois: 2, tres: 3, quatro: 4, cinco: 5, seis: 6,
  sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13,
  catorze: 14, quatorze: 14, quinze: 15, dezesseis: 16, dezessete: 17,
  dezoito: 18, dezenove: 19, vinte: 20, trinta: 30,
};

const DAY_WORD =
  "(?:\\d{1,2}|(?:vinte|trinta)(?: e (?:um|dois|tres|quatro|cinco|seis|sete|oito|nove))?|um|uma|primeiro|dois|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|catorze|quatorze|quinze|dezesseis|dezessete|dezoito|dezenove)";
const MONTH_WORD = "(?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)";

export const DATE_HINT = 'Diga o dia: "hoje", "amanhã", "sexta" ou "dia 2".';

// Palavras que encerram o nome do colega ("com o João dia 2" → "joao").
const NAME_STOP_WORDS = [
  "dia", "no", "na", "do", "da", "de", "o", "a", "os", "as", "e",
  "plantao", "turno", "manha", "tarde", "noite", "madrugada", "cedo",
  "hoje", "amanha", "ontem", "depois",
  "segunda", "terca", "quarta", "quinta", "sexta", "sabado", "domingo",
  "proxima", "proximo", "que", "vem", "meu", "minha", "por", "favor",
];

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "vinte e um" → 21; "dois" → 2; "15" → 15. */
function parseDayNumber(token: string): number | null {
  if (/^\d{1,2}$/.test(token)) return Number(token);
  let total = 0;
  for (const part of token.split(" e ")) {
    const v = UNITS[part];
    if (v === undefined) return null;
    total += v;
  }
  return total || null;
}

function parseDate(text: string): VoiceDate | ParseFailure | null {
  if (/\bdepois de amanha\b/.test(text)) return { kind: "offset", days: 2, said: "depois de amanhã" };
  if (/\bamanha\b/.test(text)) return { kind: "offset", days: 1, said: "amanhã" };
  if (/\bhoje\b/.test(text)) return { kind: "offset", days: 0, said: "hoje" };
  if (/\bontem\b/.test(text)) return { kind: "offset", days: -1, said: "ontem" };
  if (/\bproximo plantao\b/.test(text)) return { kind: "next-shift", said: "seu próximo plantão" };

  // "dia 2", "dia 2 de setembro", "dia vinte e um"
  const byDia = text.match(new RegExp(`\\bdia (${DAY_WORD})\\b(?: de (${MONTH_WORD}))?`));
  // "2 de setembro"
  const byMonth = byDia ? null : text.match(new RegExp(`\\b(${DAY_WORD}) de (${MONTH_WORD})\\b`));
  // "02/09"
  const bySlash = byDia || byMonth ? null : text.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  const abs = byDia ?? byMonth ?? bySlash;
  if (abs) {
    const day = parseDayNumber(abs[1]);
    if (!day || day < 1 || day > 31) {
      return { kind: "FALHA", reason: `Dia inválido: "${abs[1]}". ${DATE_HINT}` };
    }
    let month: number | null = null;
    if (abs[2]) {
      month = /^\d+$/.test(abs[2]) ? Number(abs[2]) : MONTHS[abs[2]] ?? null;
      if (!month || month < 1 || month > 12) {
        return { kind: "FALHA", reason: `Não reconheci o mês "${abs[2]}".` };
      }
    }
    return { kind: "absolute", day, month, said: abs[0] };
  }

  // "sexta", "sexta-feira", "próxima sexta", "sexta que vem", "na sexta"
  const wd = text.match(
    /\b(?:(proxima|proximo)\s+)?(segunda|terca|quarta|quinta|sexta|sabado|domingo)(?:-feira)?\b(?:\s+(que vem))?/,
  );
  if (wd) {
    return {
      kind: "weekday",
      weekday: WEEKDAYS[wd[2]],
      forceNext: !!(wd[1] || wd[3]),
      said: wd[0],
    };
  }
  return null;
}

function parsePeriod(text: string): VoicePeriod | null {
  // "amanha" contém "manha" mas \b impede o falso positivo.
  if (/\bmanha\b|\bcedo\b/.test(text)) return "manha";
  if (/\btarde\b/.test(text)) return "tarde";
  if (/\bnoite\b|\bmadrugada\b/.test(text)) return "noite";
  return null;
}

export function parseVoiceCommand(raw: string): ParsedCommand | ParseFailure {
  const text = normalize(raw);

  if (!/\b(troc\w*|passar|passo|passa|ceder|cedo|cede|repassar|repasso|transferir|transfiro|dar|dou|oferecer|ofereco|oferece)\b/.test(text)) {
    return {
      kind: "FALHA",
      reason:
        'Não entendi o comando. Exemplo: "trocar meu plantão de hoje à noite com o João".',
    };
  }

  const date = parseDate(text);
  if (date && "kind" in date && date.kind === "FALHA") return date;
  if (!date) {
    return { kind: "FALHA", reason: `Não identifiquei o dia do plantão. ${DATE_HINT}` };
  }

  const period = parsePeriod(text);

  // Colega: "com o João", "para a Maria", "pro Pedro", "entre eu e João
  // Silva", "com o Dr. João". Títulos saem; a captura para na primeira
  // palavra de contexto (dia, plantão, hoje, sexta...).
  const noTitles = text.replace(/\b(?:dr|dra|doutor|doutora)\.?\s+/g, "");
  const stop = NAME_STOP_WORDS.join("|");
  const targetMatch = noTitles.match(
    new RegExp(`\\b(?:com|para|pro|pra|entre eu e)\\s+(?:o |a )?((?:(?!\\b(?:${stop})\\b)[a-z]+\\s*){1,4})`),
  );
  const targetName = targetMatch?.[1]?.trim() ?? "";
  if (!targetName) {
    return { kind: "FALHA", reason: 'Não identifiquei com quem é a troca. Diga, por exemplo, "com o João".' };
  }

  return { kind: "TROCA", targetName, date, period };
}

// ── Resolução ──────────────────────────────────────────────────────────

// Início do turno em UTC (convenção do banco: BRT+3)
const PERIOD_START_UTC: Record<VoicePeriod, number> = { manha: 10, tarde: 16, noite: 22 };
const PERIOD_LABEL: Record<VoicePeriod, string> = { manha: "Manhã", tarde: "Tarde", noite: "Noite" };
const BRT_OFFSET_MS = 3 * 60 * 60 * 1000;

interface LocalDate { y: number; m: number; d: number }

function todayBrt(now: Date): LocalDate {
  const b = new Date(now.getTime() - BRT_OFFSET_MS);
  return { y: b.getUTCFullYear(), m: b.getUTCMonth() + 1, d: b.getUTCDate() };
}
function addDays(date: LocalDate, days: number): LocalDate {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay();
}
function compareDates(a: LocalDate, b: LocalDate): number {
  return Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d);
}
function fmtDate(date: LocalDate): string {
  return `${String(date.d).padStart(2, "0")}/${String(date.m).padStart(2, "0")}`;
}
function localDateOf(instant: Date): LocalDate {
  return todayBrt(instant);
}

/** Data-alvo do comando, ou falha com mensagem pronta para o usuário. */
export function resolveVoiceDate(
  date: VoiceDate,
  now = new Date(),
): { ok: true; target: LocalDate; said: string } | { ok: false; error: string } {
  const today = todayBrt(now);
  let target: LocalDate;
  switch (date.kind) {
    case "offset":
      target = addDays(today, date.days);
      break;
    case "weekday": {
      let delta = (date.weekday - weekdayOf(today) + 7) % 7;
      if (delta === 0 && date.forceNext) delta = 7;
      target = addDays(today, delta);
      break;
    }
    case "absolute": {
      let y = today.y;
      let m = date.month ?? today.m;
      if (date.month === null && date.day < today.d) {
        m += 1;
        if (m > 12) { m = 1; y += 1; }
      } else if (date.month !== null && (m < today.m || (m === today.m && date.day < today.d))) {
        y += 1; // mês já passou este ano → próximo ano
      }
      const probe = new Date(Date.UTC(y, m - 1, date.day));
      if (probe.getUTCMonth() + 1 !== m) {
        return { ok: false, error: `O dia ${date.day} não existe em ${fmtDate({ y, m, d: 1 }).slice(3)}/${y}.` };
      }
      target = { y, m, d: date.day };
      break;
    }
    case "next-shift":
      return { ok: false, error: "next-shift não usa data" };
  }
  if (compareDates(target, today) < 0) {
    return { ok: false, error: "Esse plantão já passou — só dá para trocar plantões futuros." };
  }
  return { ok: true, target, said: date.said };
}

export interface ResolvedSwapIntent {
  ok: true;
  action: {
    type: "CESSAO_DIRECIONADA";
    fromShiftInstanceId: number;
    fromAssignmentId: number;
    toProfessionalId: number;
    toProfessionalName: string;
    shiftLabel: string;
    dateStr: string; // DD/MM
    timeRange: string; // HH:MM–HH:MM (BRT)
  };
  confirmationText: string;
}

export interface ResolutionFailure {
  ok: false;
  error: string;
  /** Quando o nome do colega é ambíguo, candidatos para o app desambiguar. */
  candidates?: { id: number; name: string }[];
}

type MyShift = {
  assignmentId: number;
  shiftInstanceId: number;
  label: string;
  startAt: Date;
  endAt: Date;
  specialty: string | null;
};

export async function resolveSwapCommand(
  parsed: ParsedCommand,
  ctx: {
    userId: number;
    professionalId: number;
    institutionId: number;
    /** Escolha explícita do usuário após ambiguidade — pula o fuzzy. */
    targetProfessionalId?: number;
    /** Injetável em testes. */
    now?: Date;
  },
): Promise<ResolvedSwapIntent | ResolutionFailure> {
  const db = await getDb();
  if (!db) return { ok: false, error: "Banco de dados indisponível" };
  const now = ctx.now ?? new Date();

  const myShiftFields = {
    assignmentId: shiftAssignmentsV2.id,
    shiftInstanceId: shiftInstances.id,
    label: shiftInstances.label,
    startAt: shiftInstances.startAt,
    endAt: shiftInstances.endAt,
    specialty: shiftInstances.specialty,
  };
  const mine = and(
    eq(shiftAssignmentsV2.professionalId, ctx.professionalId),
    eq(shiftAssignmentsV2.isActive, true),
    eq(shiftInstances.institutionId, ctx.institutionId),
  );

  let shift: MyShift;
  let whenSaid: string;

  if (parsed.date.kind === "next-shift") {
    const upcoming = await db
      .select(myShiftFields)
      .from(shiftAssignmentsV2)
      .innerJoin(shiftInstances, eq(shiftAssignmentsV2.shiftInstanceId, shiftInstances.id))
      .where(and(mine, gte(shiftInstances.startAt, now)))
      .orderBy(shiftInstances.startAt)
      .limit(1);
    if (upcoming.length === 0) {
      return { ok: false, error: "Você não tem nenhum plantão futuro nesta instituição." };
    }
    shift = upcoming[0];
    whenSaid = "seu próximo plantão";
  } else {
    const resolved = resolveVoiceDate(parsed.date, now);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    const { target } = resolved;

    // Janela do dia em UTC (dia BRT começa 03:00Z e vai até 03:00Z do
    // dia seguinte; a Noite 22Z ainda pertence ao dia).
    const dayStartUtc = new Date(Date.UTC(target.y, target.m - 1, target.d, 3, 0, 0));
    const dayEndUtc = new Date(Date.UTC(target.y, target.m - 1, target.d + 1, 3, 0, 0));

    const myShifts = await db
      .select(myShiftFields)
      .from(shiftAssignmentsV2)
      .innerJoin(shiftInstances, eq(shiftAssignmentsV2.shiftInstanceId, shiftInstances.id))
      .where(and(mine, gte(shiftInstances.startAt, dayStartUtc), lt(shiftInstances.startAt, dayEndUtc)));

    whenSaid =
      parsed.date.kind === "offset"
        ? parsed.date.days === 0 ? "hoje" : parsed.date.days === 1 ? "amanhã" : `em ${fmtDate(target)}`
        : `na ${WEEKDAY_LABEL[weekdayOf(target)]}, ${fmtDate(target)}`;

    if (myShifts.length === 0) {
      return { ok: false, error: `Você não tem plantão ${whenSaid}.` };
    }

    if (parsed.period) {
      const wanted = PERIOD_START_UTC[parsed.period];
      const match = myShifts.find((s) => new Date(s.startAt).getUTCHours() === wanted);
      if (!match) {
        const available = myShifts.map((s) => s.label).join(", ");
        return {
          ok: false,
          error: `Você não tem plantão no turno da ${PERIOD_LABEL[parsed.period]} ${whenSaid} (seu plantão nesse dia: ${available}).`,
        };
      }
      shift = match;
    } else if (myShifts.length > 1) {
      return {
        ok: false,
        error: `Você tem ${myShifts.length} plantões ${whenSaid} — diga o turno (manhã, tarde ou noite).`,
      };
    } else {
      shift = myShifts[0];
    }
  }

  // Colega: vínculo ativo na instituição, nome compatível, serviço
  // compatível com o plantão, e que não seja o próprio usuário.
  const colleagues = await db
    .select({
      id: professionals.id,
      userId: professionals.userId,
      name: professionals.name,
      specialty: professionals.specialty,
    })
    .from(professionals)
    .innerJoin(
      professionalInstitutions,
      and(
        eq(professionalInstitutions.professionalId, professionals.id),
        eq(professionalInstitutions.institutionId, ctx.institutionId),
        eq(professionalInstitutions.active, true),
      ),
    );

  // Desambiguação explícita: o usuário tocou num candidato.
  if (ctx.targetProfessionalId) {
    const chosen = colleagues.find(
      (c) =>
        c.id === ctx.targetProfessionalId &&
        c.userId !== ctx.userId &&
        !specialtiesConflict(shift.specialty, c.specialty),
    );
    if (!chosen) {
      return { ok: false, error: "Profissional escolhido não está disponível para este plantão." };
    }
    return buildResolved(shift, chosen);
  }

  const queryTokens = normalize(parsed.targetName).split(" ").filter(Boolean);
  const matches = colleagues
    .filter((c) => c.userId !== ctx.userId)
    .filter((c) => !specialtiesConflict(shift.specialty, c.specialty))
    .filter((c) => {
      const nameTokens = normalize(c.name).split(" ");
      // Todos os tokens ditos devem aparecer no nome (prefixo conta:
      // "germana" acha "Germana Medeiros Mendes"; "joao" acha "João").
      return queryTokens.every((qt) => nameTokens.some((nt) => nt === qt || nt.startsWith(qt)));
    });

  if (matches.length === 0) {
    return {
      ok: false,
      error: `Não encontrei "${parsed.targetName}" entre os profissionais do seu serviço nesta instituição.`,
    };
  }
  // Preferência por nome EXATO: "Bruno" é ambíguo entre "Bruno" e
  // "Bruno Silva", mas quem diz o nome completo igual ao cadastro
  // resolve sem pergunta.
  const exact = matches.filter((c) => normalize(c.name) === normalize(parsed.targetName));
  const finalMatches = exact.length === 1 ? exact : matches;
  if (finalMatches.length > 1) {
    return {
      ok: false,
      error: `Encontrei ${finalMatches.length} profissionais com esse nome — qual deles?`,
      candidates: finalMatches.slice(0, 5).map((m) => ({ id: m.id, name: m.name })),
    };
  }

  return buildResolved(shift, finalMatches[0]);
}

function buildResolved(shift: MyShift, target: { id: number; name: string }): ResolvedSwapIntent {
  const start = new Date(shift.startAt);
  const end = new Date(shift.endAt);
  const brt = (d: Date) => {
    const b = new Date(d.getTime() - BRT_OFFSET_MS);
    return `${String(b.getUTCHours()).padStart(2, "0")}:${String(b.getUTCMinutes()).padStart(2, "0")}`;
  };
  const local = localDateOf(start);
  const dateStr = fmtDate(local);
  const timeRange = `${brt(start)}–${brt(end)}`;
  const when = `${WEEKDAY_LABEL[weekdayOf(local)]}, ${dateStr}`;
  const firstName = target.name.split(" ")[0];

  return {
    ok: true,
    action: {
      type: "CESSAO_DIRECIONADA",
      fromShiftInstanceId: shift.shiftInstanceId,
      fromAssignmentId: shift.assignmentId,
      toProfessionalId: target.id,
      toProfessionalName: target.name,
      shiftLabel: shift.label,
      dateStr,
      timeRange,
    },
    confirmationText: `Passar seu plantão de ${when} (${shift.label}, ${timeRange}) para ${target.name}. ${firstName} receberá a oferta para aceitar. Confirmar?`,
  };
}
