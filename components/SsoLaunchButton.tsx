// components/SsoLaunchButton.tsx — "Abrir Comunica+" contextual ao plantão.
//
// Visual 100% por tokens (antes: 17 literais de cor, paleta indigo fora
// do sistema e modal escuro ad hoc). Estados: ativo (tom primary),
// indisponível (tom muted), erro (tom danger) e seleção de contexto
// quando há mais de um plantão ativo (sheet flutuante).

import { useState } from "react";
import { ActivityIndicator, Modal, Platform, Pressable, Text, View } from "react-native";
import { AlertTriangle, ExternalLink, Radio, X } from "lucide-react-native";
import * as Haptics from "expo-haptics";
import { useSsoHandoff } from "@/hooks/use-sso-handoff";
import { useTenantState } from "@/lib/tenant-state";
import { theme } from "@/lib/theme";
import { Surface, tonedText } from "@/components/ui/Surface";

interface ActiveShift {
  id: number;
  label: string;
  startAt: string | Date;
  endAt: string | Date;
  sectorName?: string;
  assignmentType?: string;
}

interface SsoLaunchButtonProps {
  activeShift: ActiveShift | null | undefined;
  allActiveShifts?: ActiveShift[];
  isLoading?: boolean;
}

const fmtTime = (v: string | Date) =>
  new Date(v).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

export function SsoLaunchButton({ activeShift, allActiveShifts, isLoading = false }: SsoLaunchButtonProps) {
  const { launch, loading, error, errorCode, clearError } = useSsoHandoff();
  const { activeInstitutionId } = useTenantState();
  const [showContextModal, setShowContextModal] = useState(false);

  const shifts = allActiveShifts ?? (activeShift ? [activeShift] : []);
  const hasMultiple = shifts.length > 1;
  const hasAny = shifts.length > 0;

  const handlePress = () => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (!hasAny) return;
    if (hasMultiple) {
      setShowContextModal(true);
      return;
    }
    launch(activeInstitutionId ?? undefined);
  };

  const handleSelectContext = () => {
    setShowContextModal(false);
    launch(activeInstitutionId ?? undefined);
  };

  if (isLoading) return null;

  const tone = hasAny ? "primary" : "muted";
  const colors = tonedText(tone);

  return (
    <>
      <Surface
        level="card"
        tone={tone}
        onPress={hasAny ? handlePress : undefined}
        accessibilityLabel={hasAny ? "Abrir Comunica+ no plantão ativo" : "Comunica+ indisponível fora do plantão"}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[3], minHeight: theme.space[10] }}>
          <ExternalLink size={20} color={hasAny ? theme.colors.primary : theme.colors.textDisabled} />
          <View style={{ flex: 1 }}>
            <Text style={{ ...theme.text.titleSm, fontWeight: theme.weight.bold, color: hasAny ? colors.strong : theme.colors.textSecondary }}>
              {hasAny ? (loading ? "Conectando…" : "Abrir Comunica+") : "Comunica+"}
            </Text>
            <Text style={{ ...theme.text.caption, color: hasAny ? colors.soft : theme.colors.textMuted }}>
              {hasAny ? "Login automático no plantão ativo" : "Disponível durante plantão ou sobreaviso"}
            </Text>
          </View>
          {loading ? <ActivityIndicator size="small" color={theme.colors.primary} /> : null}
        </View>
      </Surface>

      {error ? (
        <Surface level="card" tone="danger" onPress={clearError} accessibilityLabel="Fechar aviso de erro" style={{ marginTop: theme.space[2] }}>
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: theme.space[3] }}>
            <AlertTriangle size={18} color={theme.palette.danger[600]} />
            <View style={{ flex: 1, gap: theme.space[1] }}>
              <Text style={{ ...theme.text.body, fontWeight: theme.weight.semibold, color: theme.palette.danger[900] }}>
                {errorCode === "no_active_duty"
                  ? "Sem plantão ativo"
                  : errorCode === "context_conflict"
                    ? "Mais de um plantão ativo"
                    : "Não foi possível abrir o Comunica+"}
              </Text>
              <Text style={{ ...theme.text.caption, color: theme.palette.danger[600] }}>{error}</Text>
            </View>
            <X size={16} color={theme.palette.danger[600]} />
          </View>
        </Surface>
      ) : null}

      <Modal visible={showContextModal} transparent animationType="fade" onRequestClose={() => setShowContextModal(false)}>
        <Pressable
          onPress={() => setShowContextModal(false)}
          accessibilityLabel="Fechar"
          style={{ flex: 1, backgroundColor: theme.colors.overlay, justifyContent: "center", paddingHorizontal: theme.space[6] }}
        >
          <Pressable onPress={() => {}}>
            <Surface level="floating" style={{ maxWidth: theme.spacing.contentMaxWidth / 2, width: "100%", alignSelf: "center", padding: theme.space[6] }}>
              <View style={{ gap: theme.space[4] }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <Text style={{ ...theme.text.title, fontWeight: theme.weight.bold, color: theme.colors.textPrimary }}>
                    Em qual plantão?
                  </Text>
                  <Pressable onPress={() => setShowContextModal(false)} hitSlop={12} accessibilityLabel="Fechar">
                    <X size={22} color={theme.colors.textSecondary} />
                  </Pressable>
                </View>
                <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
                  Você tem {shifts.length} plantões ativos agora. Escolha em qual contexto abrir o Comunica+.
                </Text>
                <View style={{ gap: theme.space[2] }}>
                  {shifts.map((shift) => (
                    <Surface
                      key={shift.id}
                      level="card"
                      tone="primary"
                      onPress={() => {
                        if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                        handleSelectContext();
                      }}
                      accessibilityLabel={`Abrir Comunica+ no plantão ${shift.label}`}
                    >
                      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[3] }}>
                        <Radio size={18} color={theme.colors.primary} />
                        <View style={{ flex: 1 }}>
                          <Text style={{ ...theme.text.titleSm, fontWeight: theme.weight.semibold, color: theme.palette.primary[900] }}>
                            {shift.label}
                          </Text>
                          <Text style={{ ...theme.text.caption, color: theme.palette.primary[700], fontVariant: ["tabular-nums"] }}>
                            {fmtTime(shift.startAt)} – {fmtTime(shift.endAt)}
                            {shift.sectorName ? ` · ${shift.sectorName}` : ""}
                          </Text>
                        </View>
                        <ExternalLink size={16} color={theme.palette.primary[700]} />
                      </View>
                    </Surface>
                  ))}
                </View>
              </View>
            </Surface>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
