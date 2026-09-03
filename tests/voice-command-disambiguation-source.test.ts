// tests/voice-command-disambiguation-source.test.ts — a UI de voz realmente
// consome shiftCandidates e reenvia as três escolhas. Não basta o adapter.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const button = readFileSync("components/VoiceCommandButton.tsx", "utf8");
const choices = readFileSync("lib/voice-interpret-choices.ts", "utf8");

describe("VoiceCommandButton — desambiguação de plantão e colega", () => {
  it("usa o helper compartilhado de merge e payload, não monta o input à mão", () => {
    expect(button).toContain('from "@/lib/voice-interpret-choices"');
    expect(button).toContain("mergeVoiceInterpretChoices");
    expect(button).toContain("voiceInterpretInput");
    expect(button).toContain("voiceChoiceFromCandidate");
    expect(button).toContain("voiceCandidateKindFromCode");
    expect(button).toMatch(/choicesRef\.current/);
  });

  it("consome shiftCandidates — AMBIGUOUS_OWN_SHIFT não vira erro mudo", () => {
    expect(button).toContain("res.shiftCandidates");
    expect(button).toContain("setShiftCandidates");
    expect(choices).toContain("AMBIGUOUS_OWN_SHIFT");
    expect(choices).toContain("SWAP_TARGET_SHIFT_REQUIRED");
    expect(choices).toContain("AMBIGUOUS_TARGET_SHIFT");
    expect(button).toContain("voiceCandidateKindFromCode(res.code)");
    // O caminho antigo só olhava res.candidates (colegas).
    expect(button).not.toMatch(/if \(res\.candidates\?\.length\) \{\s*setCandidates/);
  });

  it("cada toque preenche um dos três campos e a chamada leva o merge", () => {
    expect(choices).toContain("ownShiftInstanceId: choices.ownShiftInstanceId");
    expect(choices).toContain("targetProfessionalId: choices.targetProfessionalId");
    expect(choices).toContain("targetShiftInstanceId: choices.targetShiftInstanceId");
    expect(choices).toContain("ownShiftInstanceId: id");
    expect(choices).toContain("targetShiftInstanceId: id");
    expect(choices).toContain("targetProfessionalId: id");
    expect(button).toContain('pickCandidate("professional"');
    expect(button).toContain("pickCandidate(candidateKind, shift.shiftInstanceId)");
    expect(button).toContain("voiceInterpretInput(text, choices, SUPPORTED_OFFER_TYPES)");
    expect(button).toContain("mergeVoiceInterpretChoices(choicesRef.current, extra)");
  });

  it("renderiza candidato de plantão com data, horário, setor e label", () => {
    expect(button).toContain("shift.dateStr");
    expect(button).toContain("shift.timeRange");
    expect(button).toContain("shift.sectorName");
    expect(button).toContain("shift.label");
  });

  it("nova escuta e fechar/cancelar zeram as escolhas — sessão anterior não vaza", () => {
    expect(button).toContain("emptyVoiceInterpretChoices");
    expect(button).toMatch(/function startListening[\s\S]*choicesRef\.current = emptyVoiceInterpretChoices\(\)/);
    expect(button).toMatch(/function close[\s\S]*choicesRef\.current = emptyVoiceInterpretChoices\(\)/);
  });
});
