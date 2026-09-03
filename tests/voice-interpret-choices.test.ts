// tests/voice-interpret-choices.test.ts — merge e payload das escolhas
// de desambiguação do comando de voz. Puro: sem banco e sem React Native.
//
// A tese: cada toque acrescenta UM campo e a chamada seguinte leva os três
// tipos possíveis. Sem o merge, AMBIGUOUS_OWN_SHIFT seguido de
// SWAP_TARGET_SHIFT_REQUIRED esqueceria o plantão próprio.

import { describe, expect, it } from "vitest";
import {
  emptyVoiceInterpretChoices,
  mergeVoiceInterpretChoices,
  voiceCandidateKindFromCode,
  voiceChoiceFromCandidate,
  voiceInterpretInput,
} from "../lib/voice-interpret-choices";

const TYPES = ["SWAP", "CESSAO"] as const;

describe("voiceCandidateKindFromCode", () => {
  it("mapeia os três tipos de pergunta para o campo certo", () => {
    expect(voiceCandidateKindFromCode("AMBIGUOUS_OWN_SHIFT")).toBe("own");
    expect(voiceCandidateKindFromCode("AMBIGUOUS_TARGET_PROFESSIONAL")).toBe("professional");
    expect(voiceCandidateKindFromCode("SWAP_TARGET_SHIFT_REQUIRED")).toBe("target");
    expect(voiceCandidateKindFromCode("AMBIGUOUS_TARGET_SHIFT")).toBe("target");
  });

  it("não inventa escolha para erro sem candidatos tocáveis", () => {
    expect(voiceCandidateKindFromCode("OWN_SHIFT_NOT_FOUND")).toBeNull();
    expect(voiceCandidateKindFromCode("SECTOR_NOT_FOUND")).toBeNull();
  });
});

describe("voiceChoiceFromCandidate + merge", () => {
  it("own, colega e contrapartida preenchem campos distintos e se acumulam", () => {
    const afterOwn = mergeVoiceInterpretChoices({}, voiceChoiceFromCandidate("own", 11));
    expect(afterOwn).toEqual({ ownShiftInstanceId: 11 });

    const afterPeer = mergeVoiceInterpretChoices(
      afterOwn,
      voiceChoiceFromCandidate("professional", 22),
    );
    expect(afterPeer).toEqual({ ownShiftInstanceId: 11, targetProfessionalId: 22 });

    const afterTarget = mergeVoiceInterpretChoices(
      afterPeer,
      voiceChoiceFromCandidate("target", 33),
    );
    expect(afterTarget).toEqual({
      ownShiftInstanceId: 11,
      targetProfessionalId: 22,
      targetShiftInstanceId: 33,
    });
  });

  it("a escolha nova do mesmo tipo substitui, sem apagar as outras", () => {
    const previous = {
      ownShiftInstanceId: 11,
      targetProfessionalId: 22,
    };
    expect(
      mergeVoiceInterpretChoices(previous, voiceChoiceFromCandidate("own", 99)),
    ).toEqual({ ownShiftInstanceId: 99, targetProfessionalId: 22 });
  });
});

describe("sessão de desambiguação — os 8 casos de choicesRef", () => {
  it("1 e 2: sessão nova zera os três IDs (escuta e fechar/cancelar)", () => {
    const leftover = {
      ownShiftInstanceId: 11,
      targetProfessionalId: 22,
      targetShiftInstanceId: 33,
    };
    expect(emptyVoiceInterpretChoices()).toEqual({});
    expect(
      voiceInterpretInput("passar meu plantão de hoje pro João", emptyVoiceInterpretChoices(), TYPES),
    ).toEqual({
      text: "passar meu plantão de hoje pro João",
      supportedOfferTypes: ["SWAP", "CESSAO"],
      ownShiftInstanceId: undefined,
      targetProfessionalId: undefined,
      targetShiftInstanceId: undefined,
    });
    // merge com sessão vazia não reaproveita leftover — o chamador substitui o ref.
    expect(mergeVoiceInterpretChoices(emptyVoiceInterpretChoices(), {})).not.toEqual(leftover);
    expect(mergeVoiceInterpretChoices(emptyVoiceInterpretChoices(), {})).toEqual({});
  });

  it("3: escolher colega e depois contrapartida preserva targetProfessionalId", () => {
    const afterPeer = mergeVoiceInterpretChoices({}, voiceChoiceFromCandidate("professional", 22));
    const afterTarget = mergeVoiceInterpretChoices(afterPeer, voiceChoiceFromCandidate("target", 33));
    expect(afterTarget.targetProfessionalId).toBe(22);
    expect(afterTarget.targetShiftInstanceId).toBe(33);
  });

  it("4: escolher plantão próprio e depois colega preserva ownShiftInstanceId", () => {
    const afterOwn = mergeVoiceInterpretChoices({}, voiceChoiceFromCandidate("own", 11));
    const afterPeer = mergeVoiceInterpretChoices(afterOwn, voiceChoiceFromCandidate("professional", 22));
    expect(afterPeer.ownShiftInstanceId).toBe(11);
    expect(afterPeer.targetProfessionalId).toBe(22);
  });

  it("5: CESSAO após SWAP incompleto não herda targetShiftInstanceId", () => {
    const incompleteSwap = mergeVoiceInterpretChoices(
      mergeVoiceInterpretChoices({}, voiceChoiceFromCandidate("own", 11)),
      voiceChoiceFromCandidate("professional", 22),
    );
    // Nova escuta / fechar substitui o ref por vazio antes do próximo texto.
    const next = emptyVoiceInterpretChoices();
    const payload = voiceInterpretInput("passo meu plantão de hoje pro João", next, TYPES);
    expect(payload.targetShiftInstanceId).toBeUndefined();
    expect(payload.ownShiftInstanceId).toBeUndefined();
    expect(payload.targetProfessionalId).toBeUndefined();
    expect(incompleteSwap.targetProfessionalId).toBe(22);
  });
});

describe("voiceInterpretInput", () => {
  it("envia os três IDs juntos em voice.interpret", () => {
    const payload = voiceInterpretInput(
      "trocar meu plantão de hoje com o João",
      {
        ownShiftInstanceId: 11,
        targetProfessionalId: 22,
        targetShiftInstanceId: 33,
      },
      TYPES,
    );
    expect(payload).toEqual({
      text: "trocar meu plantão de hoje com o João",
      supportedOfferTypes: ["SWAP", "CESSAO"],
      ownShiftInstanceId: 11,
      targetProfessionalId: 22,
      targetShiftInstanceId: 33,
    });
  });
});
