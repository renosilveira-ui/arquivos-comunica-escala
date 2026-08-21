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

export interface ParsedCommand {
  kind: "TROCA";
  targetName: string;
  day: number;
  month: number | null; // 1-12
  period: "manha" | "tarde" | "noite" | null;
}

export interface ParseFailure {
  kind: "FALHA";
  reason: string;
}

const MONTHS: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseVoiceCommand(raw: string): ParsedCommand | ParseFailure {
  const text = normalize(raw);

  if (!/\b(troc\w*|passar|ceder|repassar|transferir)\b/.test(text)) {
    return {
      kind: "FALHA",
      reason:
        'Não entendi o comando. Exemplo: "trocar meu plantão do dia 2 à noite com o João".',
    };
  }

  // Dia (obrigatório) e mês (opcional)
  const dayMatch = text.match(/\bdia\s+(\d{1,2})\b(?:\s+de\s+([a-z]+))?/);
  if (!dayMatch) {
    return { kind: "FALHA", reason: "Não identifiquei o dia do plantão (ex.: \"dia 2\")." };
  }
  const day = Number(dayMatch[1]);
  if (day < 1 || day > 31) {
    return { kind: "FALHA", reason: `Dia inválido: ${day}.` };
  }
  const month = dayMatch[2] ? MONTHS[dayMatch[2]] ?? null : null;
  if (dayMatch[2] && month === null) {
    return { kind: "FALHA", reason: `Não reconheci o mês "${dayMatch[2]}".` };
  }

  // Turno (opcional — se o dia tiver 1 plantão só, resolvemos sem ele)
  let period: ParsedCommand["period"] = null;
  if (/\bmanha\b/.test(text)) period = "manha";
  else if (/\btarde\b/.test(text)) period = "tarde";
  else if (/\bnoite\b/.test(text)) period = "noite";

  // Colega: "com o João", "para a Maria", "entre eu e João Silva"
  // Captura após com/para/pro/pra/entre eu e, parando em palavras de
  // contexto (dia, no, do, da, plantao...).
  const targetMatch = text.match(
    /\b(?:com|para|pro|pra|entre eu e)\s+(?:o |a )?((?:(?!\b(?:dia|no|na|do|da|de|plantao|turno|manha|tarde|noite)\b)[a-z]+\s*){1,4})/,
  );
  const targetName = targetMatch?.[1]?.trim() ?? "";
  if (!targetName) {
    return { kind: "FALHA", reason: "Não identifiquei com quem é a troca (ex.: \"com o João\")." };
  }

  return { kind: "TROCA", targetName, day, month, period };
}

// ── Resolução ──────────────────────────────────────────────────────────

// Início do turno em UTC (convenção do banco: BRT+3)
const PERIOD_START_UTC: Record<NonNullable<ParsedCommand["period"]>, number> = {
  manha: 10,
  tarde: 16,
  noite: 22,
};

const PERIOD_LABEL: Record<NonNullable<ParsedCommand["period"]>, string> = {
  manha: "Manhã",
  tarde: "Tarde",
  noite: "Noite",
};

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

export async function resolveSwapCommand(
  parsed: ParsedCommand,
  ctx: {
    userId: number;
    professionalId: number;
    institutionId: number;
    /** Escolha explícita do usuário após ambiguidade — pula o fuzzy. */
    targetProfessionalId?: number;
  },
): Promise<ResolvedSwapIntent | ResolutionFailure> {
  const db = await getDb();
  if (!db) return { ok: false, error: "Banco de dados indisponível" };

  // Data alvo: mês informado ou o próximo dia N (este mês; se já passou,
  // mês que vem).
  const now = new Date();
  const nowBrt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  let year = nowBrt.getUTCFullYear();
  let month = parsed.month ?? nowBrt.getUTCMonth() + 1;
  if (parsed.month === null && parsed.day < nowBrt.getUTCDate()) {
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }

  // Janela do dia em UTC (dia BRT começa 03:00Z e vai até 03:00Z do
  // dia seguinte; a Noite 22Z ainda pertence ao dia).
  const dayStartUtc = new Date(Date.UTC(year, month - 1, parsed.day, 3, 0, 0));
  const dayEndUtc = new Date(Date.UTC(year, month - 1, parsed.day + 1, 3, 0, 0));

  // Meus plantões ativos nesse dia
  const myShifts = await db
    .select({
      assignmentId: shiftAssignmentsV2.id,
      shiftInstanceId: shiftInstances.id,
      label: shiftInstances.label,
      startAt: shiftInstances.startAt,
      endAt: shiftInstances.endAt,
      specialty: shiftInstances.specialty,
    })
    .from(shiftAssignmentsV2)
    .innerJoin(shiftInstances, eq(shiftAssignmentsV2.shiftInstanceId, shiftInstances.id))
    .where(
      and(
        eq(shiftAssignmentsV2.professionalId, ctx.professionalId),
        eq(shiftAssignmentsV2.isActive, true),
        eq(shiftInstances.institutionId, ctx.institutionId),
        gte(shiftInstances.startAt, dayStartUtc),
        lt(shiftInstances.startAt, dayEndUtc),
      ),
    );

  if (myShifts.length === 0) {
    return {
      ok: false,
      error: `Você não tem plantão no dia ${String(parsed.day).padStart(2, "0")}/${String(month).padStart(2, "0")}.`,
    };
  }

  let shift = myShifts[0];
  if (parsed.period) {
    const wanted = PERIOD_START_UTC[parsed.period];
    const match = myShifts.find((s) => new Date(s.startAt).getUTCHours() === wanted);
    if (!match) {
      return {
        ok: false,
        error: `Você não tem plantão no turno da ${PERIOD_LABEL[parsed.period]} do dia ${String(parsed.day).padStart(2, "0")}/${String(month).padStart(2, "0")}.`,
      };
    }
    shift = match;
  } else if (myShifts.length > 1) {
    return {
      ok: false,
      error: `Você tem ${myShifts.length} plantões nesse dia — diga o turno (manhã, tarde ou noite).`,
    };
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
    return buildResolved(shift, chosen, parsed, month);
  }

  const queryTokens = normalize(parsed.targetName).split(" ").filter(Boolean);
  const matches = colleagues
    .filter((c) => c.userId !== ctx.userId)
    .filter((c) => !specialtiesConflict(shift.specialty, c.specialty))
    .filter((c) => {
      const name = normalize(c.name);
      const nameTokens = name.split(" ");
      // Todos os tokens ditos devem aparecer no nome (prefixo conta:
      // "germana" acha "Germana Medeiros Mendes"; "joao" acha "João").
      return queryTokens.every((qt) =>
        nameTokens.some((nt) => nt === qt || nt.startsWith(qt)),
      );
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
  const exact = matches.filter(
    (c) => normalize(c.name) === normalize(parsed.targetName),
  );
  const finalMatches = exact.length === 1 ? exact : matches;
  if (finalMatches.length > 1) {
    return {
      ok: false,
      error: `Encontrei ${finalMatches.length} profissionais com esse nome — qual deles?`,
      candidates: finalMatches.slice(0, 5).map((m) => ({ id: m.id, name: m.name })),
    };
  }

  return buildResolved(shift, finalMatches[0], parsed, month);
}

function buildResolved(
  shift: { shiftInstanceId: number; assignmentId: number; label: string; startAt: Date | string; endAt: Date | string },
  target: { id: number; name: string },
  parsed: ParsedCommand,
  month: number,
): ResolvedSwapIntent {
  const start = new Date(shift.startAt);
  const end = new Date(shift.endAt);
  const brt = (d: Date) => {
    const b = new Date(d.getTime() - 3 * 60 * 60 * 1000);
    return `${String(b.getUTCHours()).padStart(2, "0")}:${String(b.getUTCMinutes()).padStart(2, "0")}`;
  };
  const dateStr = `${String(parsed.day).padStart(2, "0")}/${String(month).padStart(2, "0")}`;
  const timeRange = `${brt(start)}–${brt(end)}`;

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
    confirmationText: `Passar seu plantão de ${dateStr} (${shift.label}, ${timeRange}) para ${target.name}. ${target.name.split(" ")[0]} receberá a oferta para aceitar. Confirmar?`,
  };
}
