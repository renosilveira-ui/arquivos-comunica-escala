/**
 * Escolhas de desambiguação do comando de voz.
 *
 * O servidor devolve uma pergunta por vez (colega, plantão próprio ou
 * contrapartida). O cliente precisa MERGIR as respostas entre rodadas e
 * reenviar todas — senão a segunda pergunta esquece a primeira.
 */

export type VoiceInterpretChoices = {
  ownShiftInstanceId?: number;
  targetProfessionalId?: number;
  targetShiftInstanceId?: number;
};

export type VoiceCandidateKind = "own" | "target" | "professional";

/** Qual campo a escolha atual preenche, a partir do código do servidor. */
export function voiceCandidateKindFromCode(
  code: string,
): VoiceCandidateKind | null {
  if (code === "AMBIGUOUS_OWN_SHIFT") return "own";
  if (code === "AMBIGUOUS_TARGET_PROFESSIONAL") return "professional";
  if (code === "SWAP_TARGET_SHIFT_REQUIRED" || code === "AMBIGUOUS_TARGET_SHIFT") {
    return "target";
  }
  return null;
}

/** Sessão nova: nenhum dos três IDs sobrevive. */
export function emptyVoiceInterpretChoices(): VoiceInterpretChoices {
  return {};
}

export function mergeVoiceInterpretChoices(
  previous: VoiceInterpretChoices,
  next: VoiceInterpretChoices,
): VoiceInterpretChoices {
  return { ...previous, ...next };
}

export function voiceChoiceFromCandidate(
  kind: VoiceCandidateKind,
  id: number,
): VoiceInterpretChoices {
  if (kind === "own") return { ownShiftInstanceId: id };
  if (kind === "target") return { targetShiftInstanceId: id };
  return { targetProfessionalId: id };
}

/** Payload canônico de voice.interpret — os três IDs viajam juntos. */
export function voiceInterpretInput(
  text: string,
  choices: VoiceInterpretChoices,
  supportedOfferTypes: readonly ("SWAP" | "CESSAO")[],
) {
  return {
    text,
    supportedOfferTypes: [...supportedOfferTypes],
    ownShiftInstanceId: choices.ownShiftInstanceId,
    targetProfessionalId: choices.targetProfessionalId,
    targetShiftInstanceId: choices.targetShiftInstanceId,
  };
}
