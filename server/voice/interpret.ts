// server/voice/interpret.ts — adapter do comando de voz sobre o núcleo
// compartilhado de linguagem natural.
//
// Toda a inteligência vive em `server/natural-language/`: parser (texto →
// slots), resolver (slots → entidades canônicas) e summary (resumo humano).
// Aqui só traduzimos para o contrato que o app já consome, para que voz e
// canais futuros interpretem SWAP e CESSAO exatamente igual — sem drift.
//
// NUNCA executa nada: a materialização é o app confirmando e chamando
// swaps.offer, que passa por `createSwapOffer` com todas as validações,
// locks e auditoria de sempre.

import { parseSwapIntent } from "../natural-language/swap-intent-parser";
import { resolveSwapIntent } from "../natural-language/swap-intent-resolver";
import { formatSwapIntentSummary } from "../natural-language/swap-intent-summary";
import type {
  ResolvedShiftRef,
  ResolvedSwapIntent,
  SwapIntentErrorCode,
  SwapIntentKind,
} from "../natural-language/swap-intent-types";
import { formatDayKeyShort } from "../natural-language/swap-intent-date";

/**
 * Ação canônica devolvida ao app. O `type` é AUTORIDADE DO SERVIDOR: o
 * cliente materializa o que vem aqui, nunca escolhe o tipo por conta.
 * Antes desta frente o app fixava "CESSAO", e por isso "trocar" criava
 * cessão.
 */
export type VoiceSwapAction = {
  type: SwapIntentKind;
  fromShiftInstanceId: number;
  fromAssignmentId: number;
  toProfessionalId: number;
  toProfessionalName: string;
  shiftLabel: string;
  sectorName: string;
  dateStr: string;
  timeRange: string;
  /** Presente só em SWAP: a contrapartida que o domínio exige. */
  toShiftInstanceId?: number;
  targetShiftLabel?: string;
  targetDateStr?: string;
  targetTimeRange?: string;
};

export type VoiceInterpretResult =
  | { ok: true; action: VoiceSwapAction; confirmationText: string }
  | {
      ok: false;
      error: string;
      code: SwapIntentErrorCode;
      /** Colegas homônimos, para o app desambiguar por toque. */
      candidates?: { id: number; name: string }[];
      /** Plantões candidatos, para o app desambiguar por toque. */
      shiftCandidates?: {
        shiftInstanceId: number;
        label: string;
        sectorName: string;
        dateStr: string;
        timeRange: string;
      }[];
    };

export type VoiceInterpretInput = {
  text: string;
  actor: { userId: number; professionalId: number; institutionId: number };
  /**
   * Tipos de oferta que ESTE cliente sabe materializar. Cliente antigo não
   * envia nada e é tratado como só-CESSAO: pedir uma troca devolve erro
   * explícito em vez de virar cessão silenciosa. Compatibilidade, não
   * segurança — o domínio segue sendo a autoridade de escrita.
   */
  supportedOfferTypes?: readonly SwapIntentKind[];
  targetProfessionalId?: number;
  ownShiftInstanceId?: number;
  targetShiftInstanceId?: number;
  now?: Date;
};

const DEFAULT_SUPPORTED_OFFER_TYPES: readonly SwapIntentKind[] = ["CESSAO"];

function describeCounterpart(shift: ResolvedShiftRef) {
  return {
    toShiftInstanceId: shift.shiftInstanceId,
    targetShiftLabel: shift.label,
    targetDateStr: formatDayKeyShort(shift.dayKey),
    targetTimeRange: shift.timeRange,
  };
}

function toAction(resolved: ResolvedSwapIntent): VoiceSwapAction {
  return {
    type: resolved.kind,
    fromShiftInstanceId: resolved.ownShift.shiftInstanceId,
    fromAssignmentId: resolved.ownShift.assignmentId,
    toProfessionalId: resolved.targetProfessional.professionalId,
    toProfessionalName: resolved.targetProfessional.name,
    shiftLabel: resolved.ownShift.label,
    sectorName: resolved.ownShift.sectorName,
    dateStr: formatDayKeyShort(resolved.ownShift.dayKey),
    timeRange: resolved.ownShift.timeRange,
    ...(resolved.kind === "SWAP" ? describeCounterpart(resolved.targetShift) : {}),
  };
}

export async function interpretVoiceSwapCommand(
  input: VoiceInterpretInput,
): Promise<VoiceInterpretResult> {
  const parsed = parseSwapIntent(input.text);
  if ("ok" in parsed) {
    return { ok: false, error: parsed.message, code: parsed.code };
  }

  const supported = input.supportedOfferTypes?.length
    ? input.supportedOfferTypes
    : DEFAULT_SUPPORTED_OFFER_TYPES;
  if (!supported.includes(parsed.kind)) {
    // Fail-closed: melhor um erro claro do que executar a operação errada.
    return {
      ok: false,
      code: "UNSUPPORTED_INTENT",
      error:
        parsed.kind === "SWAP"
          ? 'Trocar plantão por contrapartida precisa da versão mais nova do app. Atualize o app para trocar, ou diga "passar meu plantão de ... para ..." para ceder o plantão.'
          : "Esta versão do app não consegue concluir essa solicitação. Atualize o app.",
    };
  }

  const resolved = await resolveSwapIntent(
    parsed,
    {
      userId: input.actor.userId,
      professionalId: input.actor.professionalId,
      // A voz opera na instituição ativa da sessão. O resolver ainda
      // intersecta com os vínculos ativos reais.
      institutionIds: [input.actor.institutionId],
    },
    {
      now: input.now,
      chosenOwnShiftInstanceId: input.ownShiftInstanceId,
      chosenTargetProfessionalId: input.targetProfessionalId,
      chosenTargetShiftInstanceId: input.targetShiftInstanceId,
    },
  );

  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.message,
      code: resolved.code,
      candidates: resolved.professionalCandidates?.map((candidate) => ({
        id: candidate.professionalId,
        name: candidate.name,
      })),
      shiftCandidates: resolved.shiftCandidates?.map((candidate) => ({
        shiftInstanceId: candidate.shiftInstanceId,
        label: candidate.label,
        sectorName: candidate.sectorName,
        dateStr: formatDayKeyShort(candidate.dayKey),
        timeRange: candidate.timeRange,
      })),
    };
  }

  return {
    ok: true,
    action: toAction(resolved),
    confirmationText: formatSwapIntentSummary(resolved).confirmation,
  };
}
