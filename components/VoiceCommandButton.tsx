// components/VoiceCommandButton.tsx — botão de microfone da Agenda.
//
// Fluxo: toque → escuta (reconhecimento de fala do aparelho, PT-BR) →
// texto vai ao voice.interpret → tela de confirmação → executar chama
// swaps.offer DIRECIONADA (o colega recebe push e aceita/recusa).
// Ambiguidade de nome vira lista de candidatos com escolha por toque.
//
// O áudio nunca sai do aparelho: só o TEXTO transcrito vai ao servidor.

import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from "expo-speech-recognition";
import { Mic, X, Check } from "lucide-react-native";
import * as Haptics from "expo-haptics";
import { trpc } from "@/lib/trpc";
import { theme } from "@/lib/theme";

type Phase =
  | "idle"
  | "listening"
  | "interpreting"
  | "confirm"
  | "candidates"
  | "executing"
  | "done"
  | "error";

interface ResolvedAction {
  type: string;
  fromShiftInstanceId: number;
  fromAssignmentId: number;
  toProfessionalId: number;
  toProfessionalName: string;
  shiftLabel: string;
  dateStr: string;
  timeRange: string;
}

export function VoiceCommandButton() {
  const [visible, setVisible] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [transcript, setTranscript] = useState("");
  const [message, setMessage] = useState("");
  const [action, setAction] = useState<ResolvedAction | null>(null);
  const [candidates, setCandidates] = useState<{ id: number; name: string }[]>([]);
  const finalTextRef = useRef("");

  const interpret = trpc.voice.interpret.useMutation();
  const offer = trpc.swaps.offer.useMutation();
  const utils = trpc.useUtils();

  useSpeechRecognitionEvent("result", (event) => {
    const text = event.results?.[0]?.transcript ?? "";
    setTranscript(text);
    if (event.isFinal) finalTextRef.current = text;
  });

  useSpeechRecognitionEvent("end", () => {
    // Escuta terminou (silêncio ou stop): interpreta o que veio.
    setPhase((p) => {
      if (p !== "listening") return p;
      const text = finalTextRef.current || transcript;
      if (text.trim().length >= 3) {
        runInterpret(text);
        return "interpreting";
      }
      setMessage("Não ouvi nada. Tente de novo.");
      return "error";
    });
  });

  useSpeechRecognitionEvent("error", (event) => {
    setPhase((p) => {
      if (p !== "listening") return p;
      setMessage(
        event.error === "not-allowed"
          ? "Permita o acesso ao microfone nos Ajustes para usar comandos de voz."
          : "Não consegui ouvir. Tente de novo.",
      );
      return "error";
    });
  });

  async function startListening() {
    setTranscript("");
    finalTextRef.current = "";
    setAction(null);
    setCandidates([]);
    setMessage("");
    try {
      const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!perm.granted) {
        setMessage("Permita o acesso ao microfone nos Ajustes para usar comandos de voz.");
        setPhase("error");
        return;
      }
      setPhase("listening");
      ExpoSpeechRecognitionModule.start({
        lang: "pt-BR",
        interimResults: true,
        continuous: false,
      });
    } catch {
      setMessage("Reconhecimento de fala indisponível neste aparelho.");
      setPhase("error");
    }
  }

  function stopListening() {
    try {
      ExpoSpeechRecognitionModule.stop();
    } catch {
      // end event cuida do resto
    }
  }

  async function runInterpret(text: string, targetProfessionalId?: number) {
    setPhase("interpreting");
    try {
      const res = await interpret.mutateAsync({ text, targetProfessionalId });
      if (res.ok) {
        setAction(res.action);
        setMessage(res.confirmationText);
        setPhase("confirm");
      } else {
        if (res.candidates?.length) {
          setCandidates(res.candidates);
          setMessage(res.error);
          setPhase("candidates");
        } else {
          setMessage(res.error);
          setPhase("error");
        }
      }
    } catch (err) {
      setMessage((err as Error).message || "Erro ao interpretar o comando.");
      setPhase("error");
    }
  }

  async function execute() {
    if (!action) return;
    setPhase("executing");
    try {
      await offer.mutateAsync({
        type: "CESSAO",
        fromShiftInstanceId: action.fromShiftInstanceId,
        fromAssignmentId: action.fromAssignmentId,
        toProfessionalId: action.toProfessionalId,
        reason: "Solicitado por comando de voz",
      });
      await utils.swaps.invalidate();
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      setMessage(
        `Oferta enviada para ${action.toProfessionalName}. Você será avisado quando responder.`,
      );
      setPhase("done");
    } catch (err) {
      setMessage((err as Error).message || "Erro ao criar a oferta.");
      setPhase("error");
    }
  }

  function open() {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setVisible(true);
    startListening();
  }

  function close() {
    stopListening();
    setVisible(false);
    setPhase("idle");
  }

  // Segurança: fechar o modal sempre para a escuta.
  useEffect(() => {
    if (!visible) stopListening();
  }, [visible]);

  return (
    <>
      <TouchableOpacity
        onPress={open}
        activeOpacity={0.85}
        accessibilityLabel="Comando de voz"
        style={{
          position: "absolute",
          bottom: 24,
          left: 20,
          width: 52,
          height: 52,
          borderRadius: 26,
          backgroundColor: theme.colors.primary,
          alignItems: "center",
          justifyContent: "center",
          shadowColor: "#000",
          shadowOpacity: 0.25,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 3 },
          elevation: 6,
        }}
      >
        <Mic size={24} color={theme.colors.onDark.text} />
      </TouchableOpacity>

      <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
        <View
          style={{
            flex: 1,
            backgroundColor: theme.colors.overlay,
            justifyContent: "flex-end",
          }}
        >
          <View
            style={{
              backgroundColor: theme.colors.surface,
              borderTopLeftRadius: 24,
              borderTopRightRadius: 24,
              padding: 24,
              paddingBottom: 40,
              gap: 16,
            }}
          >
            {/* Header */}
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <Text style={{ fontSize: 18, fontWeight: "800", color: theme.colors.textPrimary }}>
                Comando de voz
              </Text>
              <TouchableOpacity onPress={close} hitSlop={12}>
                <X size={22} color={theme.colors.textSecondary} />
              </TouchableOpacity>
            </View>

            {phase === "listening" && (
              <View style={{ alignItems: "center", gap: 12 }}>
                <View
                  style={{
                    width: 72,
                    height: 72,
                    borderRadius: 36,
                    backgroundColor: theme.colors.dangerSoft,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Mic size={32} color={theme.colors.danger} />
                </View>
                <Text style={{ fontSize: 15, color: theme.colors.textSecondary, textAlign: "center" }}>
                  {transcript || 'Fale agora — ex.: "trocar meu plantão de hoje à noite com o João" ou "passar o plantão de sexta para a Maria"'}
                </Text>
                <TouchableOpacity
                  onPress={stopListening}
                  activeOpacity={0.8}
                  style={{
                    paddingHorizontal: 20,
                    paddingVertical: 10,
                    borderRadius: theme.radius.md,
                    backgroundColor: theme.colors.primary,
                  }}
                >
                  <Text style={{ color: theme.colors.onDark.text, fontWeight: "700" }}>Concluir</Text>
                </TouchableOpacity>
              </View>
            )}

            {(phase === "interpreting" || phase === "executing") && (
              <View style={{ alignItems: "center", paddingVertical: 16 }}>
                <ActivityIndicator size="large" color={theme.colors.primary} />
                <Text style={{ marginTop: 10, color: theme.colors.textSecondary }}>
                  {phase === "interpreting" ? "Entendendo o comando…" : "Enviando a oferta…"}
                </Text>
              </View>
            )}

            {phase === "confirm" && action && (
              <View style={{ gap: 14 }}>
                <Text style={{ fontSize: 15, color: theme.colors.textPrimary, lineHeight: 22 }}>
                  {message}
                </Text>
                <View style={{ flexDirection: "row", gap: 10 }}>
                  <TouchableOpacity
                    onPress={execute}
                    activeOpacity={0.85}
                    style={{
                      flex: 1,
                      flexDirection: "row",
                      justifyContent: "center",
                      alignItems: "center",
                      gap: 6,
                      backgroundColor: theme.colors.success,
                      paddingVertical: 12,
                      borderRadius: theme.radius.md,
                    }}
                  >
                    <Check size={18} color={theme.colors.onDark.text} />
                    <Text style={{ color: theme.colors.onDark.text, fontWeight: "700" }}>Confirmar</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={close}
                    activeOpacity={0.8}
                    style={{
                      flex: 1,
                      justifyContent: "center",
                      alignItems: "center",
                      borderWidth: 1.5,
                      borderColor: theme.colors.border,
                      paddingVertical: 12,
                      borderRadius: theme.radius.md,
                    }}
                  >
                    <Text style={{ color: theme.colors.textSecondary, fontWeight: "700" }}>Cancelar</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {phase === "candidates" && (
              <View style={{ gap: 10 }}>
                <Text style={{ fontSize: 15, color: theme.colors.textPrimary }}>{message}</Text>
                {candidates.map((c) => (
                  <TouchableOpacity
                    key={c.id}
                    onPress={() => runInterpret(finalTextRef.current || transcript, c.id)}
                    activeOpacity={0.8}
                    style={{
                      padding: 14,
                      borderRadius: theme.radius.md,
                      borderWidth: 1,
                      borderColor: theme.colors.border,
                      backgroundColor: theme.colors.surfaceAlt,
                    }}
                  >
                    <Text style={{ fontSize: 15, fontWeight: "600", color: theme.colors.textPrimary }}>
                      {c.name}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}

            {(phase === "done" || phase === "error") && (
              <View style={{ gap: 14, alignItems: "center" }}>
                <Text
                  style={{
                    fontSize: 15,
                    color: phase === "done" ? theme.colors.textPrimary : theme.palette.danger[600],
                    textAlign: "center",
                    lineHeight: 22,
                  }}
                >
                  {message}
                </Text>
                <View style={{ flexDirection: "row", gap: 10 }}>
                  {phase === "error" && (
                    <TouchableOpacity
                      onPress={startListening}
                      activeOpacity={0.85}
                      style={{
                        paddingHorizontal: 20,
                        paddingVertical: 12,
                        borderRadius: theme.radius.md,
                        backgroundColor: theme.colors.primary,
                      }}
                    >
                      <Text style={{ color: theme.colors.onDark.text, fontWeight: "700" }}>Tentar de novo</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    onPress={close}
                    activeOpacity={0.8}
                    style={{
                      paddingHorizontal: 20,
                      paddingVertical: 12,
                      borderRadius: theme.radius.md,
                      borderWidth: 1.5,
                      borderColor: theme.colors.border,
                    }}
                  >
                    <Text style={{ color: theme.colors.textSecondary, fontWeight: "700" }}>Fechar</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>
        </View>
      </Modal>
    </>
  );
}
