import { useState, useEffect, useMemo } from "react";
import {
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Alert,
  ActivityIndicator,
  Platform,
} from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { useAuth } from "@/hooks/use-auth";
import { useRouter, useLocalSearchParams } from "expo-router";
import { ChevronLeft, Send, ArrowRightLeft } from "lucide-react-native";
import { theme } from "@/lib/theme";
import { trpc } from "@/lib/trpc";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const uiAlert = (title: string, message: string, onOk?: () => void) => {
  if (Platform.OS === "web") {
    window.alert(`${title}\n\n${message}`);
    onOk?.();
  } else {
    Alert.alert(title, message, [{ text: "OK", onPress: onOk }]);
  }
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ShiftInstance {
  id: number;
  label: string;
  startAt: Date | string;
  endAt: Date | string;
  hospitalId: number;
  sectorId: number;
  assignments: {
    id: number;
    professionalId: number;
    shiftInstanceId: number;
    isActive: boolean;
  }[];
}

type OfferType = "SWAP" | "TRANSFER";
type OfferPayload = {
  type: "SWAP" | "TRANSFER" | "CESSAO";
  fromShiftInstanceId: number;
  fromAssignmentId: number;
  toShiftInstanceId?: number;
  reason?: string;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RequestSwapScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams<{ type?: string; fromShiftId?: string }>();
  const utils = trpc.useUtils();

  const [type, setType] = useState<OfferType>("SWAP");
  const [selectedFrom, setSelectedFrom] = useState<ShiftInstance | null>(null);
  const [selectedFromAssignmentId, setSelectedFromAssignmentId] = useState<number | null>(null);
  const [selectedTo, setSelectedTo] = useState<ShiftInstance | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (params.type === "SWAP" || params.type === "TRANSFER") {
      setType(params.type);
    }
  }, [params.type]);

  const period = useMemo(() => {
    const now = new Date();
    const future = new Date();
    future.setDate(future.getDate() + 60);
    return {
      startDate: now.toISOString().slice(0, 10),
      endDate: future.toISOString().slice(0, 10),
    };
  }, []);

  const {
    data: professional,
    isLoading: professionalLoading,
    error: professionalError,
  } = trpc.professionals.getByUserId.useQuery(
    { userId: user?.id ?? 0 },
    { enabled: !!user?.id },
  );
  const {
    data: shiftsData,
    isLoading: shiftsLoading,
    error: shiftsError,
  } = trpc.shifts.listByPeriod.useQuery(period, { enabled: !!user?.id });
  const offerMutation = trpc.swaps.offer.useMutation({
    onSuccess: async () => {
      await utils.swaps.list.invalidate();
      uiAlert(
        "Sucesso",
        type === "SWAP" ? "Troca oferecida com sucesso!" : "Repasse oferecido com sucesso!",
        () => router.back(),
      );
    },
    onError: (mutationError) => {
      setError(mutationError.message || "Erro ao enviar oferta");
    },
  });

  const { myShifts, otherShifts } = useMemo(() => {
    const proId = professional?.id;
    if (!proId) return { myShifts: [] as ShiftInstance[], otherShifts: [] as ShiftInstance[] };

    const now = new Date();
    const futureShifts = ((shiftsData ?? []) as ShiftInstance[]).filter(
      (shift) => new Date(shift.startAt) > now,
    );

    const mine = futureShifts.filter((shift) =>
      shift.assignments.some((assignment) => assignment.professionalId === proId && assignment.isActive),
    );
    const others = futureShifts.filter((shift) =>
      shift.assignments.some((assignment) => assignment.professionalId !== proId && assignment.isActive) &&
      !shift.assignments.some((assignment) => assignment.professionalId === proId && assignment.isActive),
    );

    return { myShifts: mine, otherShifts: others };
  }, [professional?.id, shiftsData]);

  useEffect(() => {
    if (!params.fromShiftId || !professional?.id || myShifts.length === 0 || selectedFrom) return;
    const preselected = myShifts.find((shift) => String(shift.id) === String(params.fromShiftId));
    if (!preselected) return;
    setSelectedFrom(preselected);
    const assignment = preselected.assignments.find(
      (row) => row.professionalId === professional.id && row.isActive,
    );
    setSelectedFromAssignmentId(assignment?.id ?? null);
  }, [myShifts, params.fromShiftId, professional?.id, selectedFrom]);

  const handleSelectFrom = (shift: ShiftInstance) => {
    setSelectedFrom(shift);
    if (professional) {
      const assignment = shift.assignments.find((a) => a.professionalId === professional.id && a.isActive);
      setSelectedFromAssignmentId(assignment?.id ?? null);
    }
    // Reset "to" selection when "from" changes
    setSelectedTo(null);
  };

  const handleSubmit = async () => {
    if (!professional?.id) {
      uiAlert("Atenção", "Profissional não encontrado para seu usuário.");
      return;
    }
    if (!selectedFrom || !selectedFromAssignmentId) {
      uiAlert("Atenção", "Selecione seu plantão para oferecer.");
      return;
    }
    if (type === "SWAP" && !selectedTo) {
      uiAlert("Atenção", "Selecione o plantão desejado para a troca.");
      return;
    }

    setError(null);

    const body: OfferPayload = {
      type,
      fromShiftInstanceId: selectedFrom.id,
      fromAssignmentId: selectedFromAssignmentId,
      reason: reason.trim() || undefined,
    };
    if (type === "SWAP" && selectedTo) {
      body.toShiftInstanceId = selectedTo.id;
    }

    offerMutation.mutate(body);
  };

  const formatShiftDate = (value: Date | string) => {
    const d = new Date(value);
    return d.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "short" });
  };

  const formatShiftTime = (startValue: Date | string, endValue: Date | string) => {
    const s = new Date(startValue);
    const e = new Date(endValue);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(s.getHours())}:${pad(s.getMinutes())} – ${pad(e.getHours())}:${pad(e.getMinutes())}`;
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const loading = professionalLoading || shiftsLoading;
  const queryError = professionalError?.message ?? shiftsError?.message ?? null;
  const submitting = offerMutation.isPending;

  if (loading) {
    return (
      <ScreenGradient scrollable={false}>
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text style={{ color: theme.colors.textDisabled, marginTop: 12, fontSize: 16 }}>Carregando turnos...</Text>
        </View>
      </ScreenGradient>
    );
  }

  if (!user) {
    return (
      <ScreenGradient scrollable={false}>
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
          <Text style={{ color: theme.colors.textMuted, fontSize: 16 }}>
            Faça login para oferecer troca ou repasse.
          </Text>
        </View>
      </ScreenGradient>
    );
  }

  if (queryError) {
    return (
      <ScreenGradient scrollable={false}>
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
          <Text style={{ color: theme.colors.danger, fontSize: 16 }}>{queryError}</Text>
        </View>
      </ScreenGradient>
    );
  }

  return (
    <ScreenGradient scrollable>
      <View style={{ gap: 24, paddingBottom: 40 }}>
        {/* Header */}
        <View>
          <TouchableOpacity
            onPress={() => router.back()}
            style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 16 }}
          >
            <ChevronLeft size={24} color={theme.colors.textPrimary} />
            <Text style={{ color: theme.colors.textPrimary, fontSize: 16 }}>Voltar</Text>
          </TouchableOpacity>

          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <ArrowRightLeft size={28} color={theme.colors.primary} />
            <Text style={{ color: theme.colors.textPrimary, fontSize: 28, fontWeight: "700" }}>Oferecer Troca ou Repasse</Text>
          </View>
        </View>

        {/* S1 — Tipo de operação */}
        <View>
          <Text style={{ color: theme.colors.textPrimary, fontSize: 18, fontWeight: "600", marginBottom: 12 }}>Tipo de operação</Text>
          <View style={{ flexDirection: "row", gap: 12 }}>
            {(["SWAP", "TRANSFER"] as OfferType[]).map((t) => (
              <TouchableOpacity
                key={t}
                onPress={() => { setType(t); setSelectedTo(null); }}
                style={{
                  flex: 1,
                  paddingVertical: 16,
                  borderRadius: 12,
                  alignItems: "center",
                  backgroundColor: type === t ? theme.colors.primarySoft : theme.colors.surface,
                  borderWidth: 1,
                  borderColor: type === t ? theme.colors.primary : theme.colors.border,
                }}
              >
                <Text style={{ color: type === t ? theme.palette.primary[700] : theme.colors.textPrimary, fontSize: 16, fontWeight: "600" }}>
                  {t === "SWAP" ? "TROCA" : "REPASSE"}
                </Text>
                <Text style={{ color: type === t ? theme.palette.primary[700] : theme.colors.textMuted, fontSize: 12, marginTop: 4 }}>
                  {t === "SWAP" ? "Meu turno ↔ outro turno" : "Entrego meu turno"}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* S2 — Meu plantão */}
        <View>
          <Text style={{ color: theme.colors.textPrimary, fontSize: 18, fontWeight: "600", marginBottom: 12 }}>
            Meu plantão {selectedFrom ? "✓" : "(selecione)"}
          </Text>
          {myShifts.length === 0 ? (
            <Text style={{ color: theme.colors.textMuted, fontSize: 14 }}>Nenhum turno futuro encontrado.</Text>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12 }}>
              {myShifts.map((s) => (
                <TouchableOpacity
                  key={s.id}
                  onPress={() => handleSelectFrom(s)}
                  style={{
                    width: 200,
                    padding: 14,
                    borderRadius: 12,
                    backgroundColor: selectedFrom?.id === s.id ? theme.colors.primarySoft : theme.colors.surface,
                    borderWidth: 1.5,
                    borderColor: selectedFrom?.id === s.id ? theme.colors.primary : theme.colors.border,
                  }}
                >
                  <Text style={{ color: theme.colors.textPrimary, fontSize: 15, fontWeight: "600" }}>{s.label}</Text>
                  <Text style={{ color: theme.colors.textDisabled, fontSize: 13, marginTop: 4 }}>{formatShiftDate(s.startAt)}</Text>
                  <Text style={{ color: theme.colors.textDisabled, fontSize: 13, marginTop: 2 }}>{formatShiftTime(s.startAt, s.endAt)}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
        </View>

        {/* S3 — Plantão desejado (só SWAP) */}
        {type === "SWAP" && (
          <View>
            <Text style={{ color: theme.colors.textPrimary, fontSize: 18, fontWeight: "600", marginBottom: 12 }}>
              Plantão desejado {selectedTo ? "✓" : "(selecione)"}
            </Text>
            {otherShifts.length === 0 ? (
              <Text style={{ color: theme.colors.textMuted, fontSize: 14 }}>Nenhum turno de outro profissional encontrado.</Text>
            ) : (
              <View style={{ gap: 10 }}>
                {otherShifts.map((s) => (
                  <TouchableOpacity
                    key={s.id}
                    onPress={() => setSelectedTo(s)}
                    style={{
                      padding: 14,
                      borderRadius: 12,
                      backgroundColor: selectedTo?.id === s.id ? theme.colors.primarySoft : theme.colors.surface,
                      borderWidth: 1.5,
                      borderColor: selectedTo?.id === s.id ? theme.colors.primary : theme.colors.border,
                    }}
                  >
                    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                      <Text style={{ color: theme.colors.textPrimary, fontSize: 15, fontWeight: "600" }}>{s.label}</Text>
                      <Text style={{ color: theme.colors.textDisabled, fontSize: 12 }}>{formatShiftDate(s.startAt)}</Text>
                    </View>
                    <Text style={{ color: theme.colors.textDisabled, fontSize: 13, marginTop: 4 }}>{formatShiftTime(s.startAt, s.endAt)}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>
        )}

        {/* S4 — Motivo */}
        <View>
          <Text style={{ color: theme.colors.textPrimary, fontSize: 18, fontWeight: "600", marginBottom: 12 }}>Motivo (opcional)</Text>
          <View style={{
            backgroundColor: theme.colors.surface,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: theme.colors.border,
            padding: 14,
          }}>
            <TextInput
              placeholder="Motivo da troca/repasse..."
              placeholderTextColor={theme.colors.textMuted}
              value={reason}
              onChangeText={setReason}
              multiline
              numberOfLines={3}
              style={{ color: theme.colors.textPrimary, fontSize: 15, minHeight: 80, textAlignVertical: "top" }}
            />
          </View>
        </View>

        {/* Error */}
        {error && (
          <View style={{ backgroundColor: theme.colors.dangerSoft, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: theme.colors.danger }}>
            <Text style={{ color: theme.colors.danger, fontSize: 14 }}>{error}</Text>
          </View>
        )}

        {/* Submit button */}
        <TouchableOpacity
          onPress={handleSubmit}
          disabled={submitting}
          style={{
            backgroundColor: submitting ? theme.palette.primary[900] : theme.colors.primary,
            borderRadius: 12,
            height: 56,
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "row",
            gap: 10,
            opacity: submitting ? 0.7 : 1,
          }}
          activeOpacity={0.8}
        >
          {submitting ? (
            <ActivityIndicator color={theme.colors.surface} />
          ) : (
            <>
              <Send size={20} color={theme.colors.surface} />
              <Text style={{ color: theme.colors.surface, fontSize: 18, fontWeight: "700" }}>Enviar Oferta</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </ScreenGradient>
  );
}
