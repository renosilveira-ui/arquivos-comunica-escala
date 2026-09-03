// server/natural-language/swap-intent-types.ts — vocabulário compartilhado
// da interpretação de trocas e cessões em linguagem natural.
//
// Duas camadas, uma fronteira só: o PARSER produz slots semânticos (o que
// a pessoa disse) e o RESOLVER produz entidades canônicas (o que existe no
// tenant). O parser nunca é autoridade: não devolve userId, professionalId,
// institutionId, sectorId, shiftInstanceId nem assignmentId — só texto e
// estrutura. Quem materializa continua sendo `createSwapOffer`.

import type { CreateSwapOfferInput } from "../swap-offer-create";

/**
 * Intenções da V1. SWAP é a troca bidirecional (meu plantão A ↔ plantão B
 * do colega); CESSAO é o repasse unidirecional (meu plantão A → colega).
 * "TRANSFER" existe no domínio como valor legado e NÃO é produzido aqui.
 */
export type SwapIntentKind = "SWAP" | "CESSAO";

/**
 * Turno pelo horário de INÍCIO no relógio do hospital (−03:00):
 * MORNING 05h–12h, AFTERNOON 12h–18h, NIGHT 18h–05h.
 *
 * Faixas idênticas ao contrato que o comando de voz já praticava
 * (`periodOfStart`), para que plantão de 19h–07h continue resolvível como
 * noite. Não inventar faixas novas sem mudar os dois lados.
 */
export type ShiftPeriod = "MORNING" | "AFTERNOON" | "NIGHT";

/** Data dita, ainda não resolvida: precisa de um "agora" para virar dia. */
export type DateExpression =
  | { kind: "OFFSET"; days: number; said: string }
  | { kind: "WEEKDAY"; weekday: number; forceNext: boolean; said: string }
  | { kind: "ABSOLUTE"; day: number; month: number | null; said: string }
  | { kind: "NEXT_SHIFT"; said: string };

/** Slots de um plantão como a pessoa o descreveu — sem nenhum ID. */
export type ShiftSlot = {
  date: DateExpression | null;
  period: ShiftPeriod | null;
  /** Texto cru do setor ("SR", "sala de recuperação"), já normalizado. */
  sectorText: string | null;
};

export type OwnShiftSlot = ShiftSlot & { date: DateExpression };

export type SwapIntentDraft =
  | {
      kind: "SWAP";
      ownShift: OwnShiftSlot;
      targetProfessional: { name: string };
      /**
       * Contrapartida. `date: null` significa que a pessoa NÃO nomeou o
       * plantão do colega — informação ausente, não alvo inexistente.
       */
      targetShift: ShiftSlot;
    }
  | {
      kind: "CESSAO";
      ownShift: OwnShiftSlot;
      targetProfessional: { name: string };
    };

export type SwapIntentErrorCode =
  | "UNSUPPORTED_INTENT"
  | "AMBIGUOUS_INTENT"
  | "INVALID_DATE"
  | "SECTOR_NOT_FOUND"
  | "AMBIGUOUS_SECTOR"
  | "OWN_SHIFT_NOT_FOUND"
  | "AMBIGUOUS_OWN_SHIFT"
  | "TARGET_PROFESSIONAL_NOT_FOUND"
  | "AMBIGUOUS_TARGET_PROFESSIONAL"
  /**
   * SWAP sem contrapartida dita. Distinto de TARGET_SHIFT_NOT_FOUND de
   * propósito: geram perguntas humanas diferentes — "qual plantão do
   * colega você quer em troca?" versus "esse plantão não existe".
   */
  | "SWAP_TARGET_SHIFT_REQUIRED"
  | "TARGET_SHIFT_NOT_FOUND"
  | "AMBIGUOUS_TARGET_SHIFT"
  | "NOT_ELIGIBLE"
  | "CONFLICT";

/** Plantão oferecido ao canal para desambiguar. Sem PII além do necessário. */
export type ShiftCandidate = {
  shiftInstanceId: number;
  assignmentId: number;
  institutionId: number;
  institutionName: string;
  sectorId: number;
  sectorName: string;
  label: string;
  /** "YYYY-MM-DD" no relógio do hospital. */
  dayKey: string;
  /** "HH:MM–HH:MM" no relógio do hospital. */
  timeRange: string;
};

export type ProfessionalCandidate = { professionalId: number; name: string };

export type SectorCandidate = { sectorId: number; name: string };

export type SwapIntentError = {
  ok: false;
  code: SwapIntentErrorCode;
  /** Mensagem pronta para a pessoa, em português. */
  message: string;
  shiftCandidates?: ShiftCandidate[];
  professionalCandidates?: ProfessionalCandidate[];
  sectorCandidates?: SectorCandidate[];
};

export function swapIntentError(
  code: SwapIntentErrorCode,
  message: string,
  extra?: Omit<SwapIntentError, "ok" | "code" | "message">,
): SwapIntentError {
  return { ok: false, code, message, ...extra };
}

/** Plantão já resolvido contra o banco — daqui saem os IDs canônicos. */
export type ResolvedShiftRef = {
  shiftInstanceId: number;
  assignmentId: number;
  sectorId: number;
  sectorName: string;
  label: string;
  dayKey: string;
  timeRange: string;
  startAt: Date;
};

type ResolvedBase = {
  ok: true;
  actorUserId: number;
  actorProfessionalId: number;
  institutionId: number;
  institutionName: string;
  ownShift: ResolvedShiftRef;
  targetProfessional: {
    professionalId: number;
    userId: number;
    name: string;
  };
};

export type ResolvedSwapIntent =
  | (ResolvedBase & { kind: "SWAP"; targetShift: ResolvedShiftRef })
  /** CESSAO não tem contrapartida — explícito, para ninguém inferir. */
  | (ResolvedBase & { kind: "CESSAO"; targetShift: null });

/**
 * Ponte única para o domínio canônico. É de propósito a ÚNICA tradução
 * entre intenção resolvida e `createSwapOffer`: nenhum canal monta esse
 * payload à mão, e o tipo de retorno garante que SWAP leva contrapartida e
 * CESSAO não. O domínio segue revalidando tudo — ownership, qualificação,
 * professional_access, allowlist #317, mês publicado e estado stale.
 */
export function toCreateSwapOfferInput(
  resolved: ResolvedSwapIntent,
  options?: { reason?: string; expiresInHours?: number },
): CreateSwapOfferInput {
  return {
    type: resolved.kind,
    fromShiftInstanceId: resolved.ownShift.shiftInstanceId,
    fromAssignmentId: resolved.ownShift.assignmentId,
    toShiftInstanceId:
      resolved.kind === "SWAP" ? resolved.targetShift.shiftInstanceId : undefined,
    toProfessionalId: resolved.targetProfessional.professionalId,
    reason: options?.reason,
    expiresInHours: options?.expiresInHours,
  };
}
