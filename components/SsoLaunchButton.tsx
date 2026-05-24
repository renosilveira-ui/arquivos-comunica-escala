// components/SsoLaunchButton.tsx — Botão "Abrir Comunica+" com validação de plantão
import { useState } from "react";
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
} from "react-native";
import { ExternalLink, AlertTriangle, X, Radio } from "lucide-react-native";
import * as Haptics from "expo-haptics";
import { useSsoHandoff } from "@/hooks/use-sso-handoff";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { PrimaryButton } from "@/components/ui/PrimaryButton";
import { useTenantState } from "@/lib/tenant-state";

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

export function SsoLaunchButton({
  activeShift,
  allActiveShifts,
  isLoading = false,
}: SsoLaunchButtonProps) {
  const { launch, loading, error, errorCode, clearError } = useSsoHandoff();
  const { activeInstitutionId } = useTenantState();
  const [showContextModal, setShowContextModal] = useState(false);

  const shifts = allActiveShifts ?? (activeShift ? [activeShift] : []);
  const hasMultiple = shifts.length > 1;
  const hasAny = shifts.length > 0;

  const handlePress = () => {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }

    if (!hasAny) {
      // No active duty — show inline message (don't call SSO)
      return;
    }

    if (hasMultiple) {
      setShowContextModal(true);
      return;
    }

    // Single active shift — launch directly
    launch(activeInstitutionId ?? undefined);
  };

  const handleSelectContext = () => {
    setShowContextModal(false);
    // For now, launch with current tenant (context selection for future)
    launch(activeInstitutionId ?? undefined);
  };

  // Don't render while loading shift data
  if (isLoading) return null;

  return (
    <>
      {/* Main button */}
      {hasAny ? (
        <TintedGlassCard
          onPress={handlePress}
          style={{
            backgroundColor: "rgba(99,102,241,0.12)",
            borderColor: "rgba(99,102,241,0.30)",
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <ExternalLink size={20} color="#818CF8" />
            <View style={{ flex: 1 }}>
              <Text
                style={{
                  fontSize: 15,
                  fontWeight: "700",
                  color: "#FFFFFF",
                }}
              >
                {loading ? "Conectando..." : "Abrir Comunica+"}
              </Text>
              <Text
                style={{
                  fontSize: 12,
                  color: "rgba(242,246,255,0.55)",
                  marginTop: 2,
                }}
              >
                Login automático no plantão ativo
              </Text>
            </View>
            {loading && <ActivityIndicator size="small" color="#818CF8" />}
          </View>
        </TintedGlassCard>
      ) : (
        <TintedGlassCard
          style={{
            backgroundColor: "rgba(107,114,128,0.08)",
            borderColor: "rgba(107,114,128,0.15)",
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <ExternalLink size={20} color="rgba(242,246,255,0.30)" />
            <View style={{ flex: 1 }}>
              <Text
                style={{
                  fontSize: 15,
                  fontWeight: "600",
                  color: "rgba(242,246,255,0.40)",
                }}
              >
                Comunica+
              </Text>
              <Text
                style={{
                  fontSize: 12,
                  color: "rgba(242,246,255,0.25)",
                  marginTop: 2,
                }}
              >
                Disponível apenas durante plantão/sobreaviso
              </Text>
            </View>
          </View>
        </TintedGlassCard>
      )}

      {/* Error feedback */}
      {error && (
        <TouchableOpacity
          onPress={clearError}
          activeOpacity={0.8}
          style={{
            backgroundColor: "rgba(239,68,68,0.15)",
            borderWidth: 1,
            borderColor: "rgba(239,68,68,0.30)",
            borderRadius: 16,
            padding: 14,
            flexDirection: "row",
            alignItems: "flex-start",
            gap: 10,
            marginTop: 8,
          }}
        >
          <AlertTriangle size={18} color="#F87171" style={{ marginTop: 1 }} />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 13, color: "#F87171", fontWeight: "600" }}>
              {errorCode === "no_active_duty"
                ? "Sem plantão ativo"
                : errorCode === "context_conflict"
                  ? "Múltiplos plantões"
                  : "Erro SSO"}
            </Text>
            <Text style={{ fontSize: 12, color: "rgba(248,113,113,0.75)", marginTop: 3 }}>
              {error}
            </Text>
          </View>
          <X size={16} color="rgba(248,113,113,0.50)" />
        </TouchableOpacity>
      )}

      {/* Context selection modal (multiple active shifts) */}
      <Modal
        visible={showContextModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowContextModal(false)}
      >
        <View
          style={{
            flex: 1,
            backgroundColor: "rgba(0,0,0,0.70)",
            justifyContent: "center",
            paddingHorizontal: 24,
          }}
        >
          <View
            style={{
              backgroundColor: "#1E293B",
              borderRadius: 24,
              padding: 24,
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.10)",
            }}
          >
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 20,
              }}
            >
              <Text style={{ fontSize: 20, fontWeight: "700", color: "#FFFFFF" }}>
                Selecione o contexto
              </Text>
              <TouchableOpacity
                onPress={() => setShowContextModal(false)}
                hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              >
                <X size={22} color="rgba(242,246,255,0.50)" />
              </TouchableOpacity>
            </View>

            <Text
              style={{
                fontSize: 14,
                color: "rgba(242,246,255,0.55)",
                marginBottom: 16,
              }}
            >
              Você tem {shifts.length} plantões ativos. Escolha em qual contexto
              deseja abrir o Comunica+.
            </Text>

            {shifts.map((shift) => (
              <TouchableOpacity
                key={shift.id}
                onPress={() => {
                  if (Platform.OS !== "web") {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }
                  handleSelectContext();
                }}
                activeOpacity={0.7}
                style={{
                  backgroundColor: "rgba(99,102,241,0.10)",
                  borderWidth: 1,
                  borderColor: "rgba(99,102,241,0.25)",
                  borderRadius: 16,
                  padding: 16,
                  marginBottom: 10,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <Radio size={18} color="#818CF8" />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 15, fontWeight: "600", color: "#FFFFFF" }}>
                    {shift.label}
                  </Text>
                  <Text
                    style={{
                      fontSize: 12,
                      color: "rgba(242,246,255,0.55)",
                      marginTop: 3,
                    }}
                  >
                    {new Date(shift.startAt).toLocaleTimeString("pt-BR", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}{" "}
                    -{" "}
                    {new Date(shift.endAt).toLocaleTimeString("pt-BR", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {shift.sectorName ? ` | ${shift.sectorName}` : ""}
                  </Text>
                </View>
                <ExternalLink size={16} color="rgba(242,246,255,0.35)" />
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </Modal>
    </>
  );
}
