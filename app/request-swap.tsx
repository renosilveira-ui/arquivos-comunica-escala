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
import { Badge } from "@/components/ui/Badge";
import { useAuth } from "@/hooks/use-auth";
import * as Auth from "@/lib/_core/auth";
import { useRouter, useLocalSearchParams } from "expo-router";
import { ChevronLeft, Send, RefreshCw, ArrowRightLeft } from "lucide-react-native";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getBaseUrl(): string {
  const envUrl = process.env.EXPO_PUBLIC_API_URL;
  if (envUrl) return envUrl;
  if (Platform.OS === "android") return "http://10.0.2.2:3000";
  return "http://localhost:3000";
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<{ ok: boolean; data: T | null }> {
  const url = getBaseUrl() + path;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string>),
  };
  if (Platform.OS !== "web") {
    const token = await Auth.getSessionToken();
    if (token) headers["Authorization"] = "Bearer " + token;
  }
  const res = await fetch(url, { ...options, headers, credentials: Platform.OS === "web" ? "include" : undefined });
  let data: T | null = null;
  try { data = await res.json(); } catch {}
  return { ok: res.ok, data };
}

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
  startAt: string;
  endAt: string;
  hospitalId: number;
  sectorId: number;
  assignments: {
    id: number;
    professionalId: number;
    shiftInstanceId: number;
    isActive: boolean;
  }[];
}

interface ProfessionalInfo {
  id: number;
  name: string;
  role: string;
  userId: number;
}

type OfferType = "SWAP" | "TRANSFER";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RequestSwapScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams<{ type?: string; fromShiftId?: string }>();

  const [type, setType] = useState<OfferType>("SWAP");
  const [myShifts, setMyShifts] = useState<ShiftInstance[]>([]);
  const [otherShifts, setOtherShifts] = useState<ShiftInstance[]>([]);
  const [professional, setProfessional] = useState<ProfessionalInfo | null>(null);
  const [selectedFrom, setSelectedFrom] = useState<ShiftInstance | null>(null);
  const [selectedFromAssignmentId, setSelectedFromAssignmentId] = useState<number | null>(null);
  const [selectedTo, setSelectedTo] = useState<ShiftInstance | null>(null);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (params.type === "SWAP" || params.type === "TRANSFER") {
      setType(params.type);
    }
  }, [params.type]);

  // Fetch user's professional record + shifts
  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      setLoading(true);
      try {
        // Get professional
        const proRes = await apiFetch<any>(
          `/api/trpc/professionals.getByUserId?batch=1&input=${encodeURIComponent(JSON.stringify({ "0": { json: { userId: user.id } } }))}`,
        );
        const proData = (proRes.data as any)?.[0]?.result?.data?.json;
        if (proData) setProfessional(proData);

        // Get shifts for next 60 days
        const now = new Date();
        const future = new Date();
        future.setDate(future.getDate() + 60);
        const startDate = now.toISOString().slice(0, 10);
        const endDate = future.toISOString().slice(0, 10);

        const shiftRes = await apiFetch<any>(
          `/api/trpc/shifts.listByPeriod?batch=1&input=${encodeURIComponent(JSON.stringify({ "0": { json: { startDate, endDate } } }))}`,
        );
        const allShifts: ShiftInstance[] = (shiftRes.data as any)?.[0]?.result?.data?.json ?? [];

        // Filter future shifts only
        const futureShifts = allShifts.filter((s: ShiftInstance) => new Date(s.startAt) > now);

        // My shifts = those where I have an active assignment
        if (proData) {
          const mine = futureShifts.filter((s: ShiftInstance) =>
            s.assignments.some((a) => a.professionalId === proData.id && a.isActive),
          );
          setMyShifts(mine);

          if (params.fromShiftId) {
            const preselected = mine.find((s) => String(s.id) === String(params.fromShiftId));
            if (preselected) {
              setSelectedFrom(preselected);
              const assignment = preselected.assignments.find(
                (a) => a.professionalId === proData.id && a.isActive,
              );
              setSelectedFromAssignmentId(assignment?.id ?? null);
            }
          }

          // Other shifts = those where someone else is assigned (not me)
          const others = futureShifts.filter((s: ShiftInstance) =>
            s.assignments.some((a) => a.professionalId !== proData.id && a.isActive) &&
            !s.assignments.some((a) => a.professionalId === proData.id && a.isActive),
          );
          setOtherShifts(others);
        }
      } catch (e: any) {
        setError(e.message ?? "Erro ao carregar dados");
      } finally {
        setLoading(false);
      }
    })();
  }, [params.fromShiftId, user?.id]);

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
    if (!selectedFrom || !selectedFromAssignmentId) {
      uiAlert("Atenção", "Selecione seu plantão para oferecer.");
      return;
    }
    if (type === "SWAP" && !selectedTo) {
      uiAlert("Atenção", "Selecione o plantão desejado para a troca.");
      return;
    }

    setSubmitting(true);
    setError(null);

    const body: Record<string, any> = {
      type,
      fromShiftInstanceId: selectedFrom.id,
      fromAssignmentId: selectedFromAssignmentId,
      reason: reason.trim() || undefined,
    };
    if (type === "SWAP" && selectedTo) {
      body.toShiftInstanceId = selectedTo.id;
    }

    const res = await apiFetch<any>("/api/trpc/swaps.offer?batch=1", {
      method: "POST",
      body: JSON.stringify({ "0": { json: body } }),
    });

    setSubmitting(false);

    const result = (res.data as any)?.[0];
    if (result?.error) {
      const msg = result.error.json?.message ?? result.error.message ?? "Erro desconhecido";
      setError(msg);
      return;
    }

    uiAlert("Sucesso", type === "SWAP" ? "Troca oferecida com sucesso!" : "Repasse oferecido com sucesso!", () => {
      router.back();
    });
  };

  const formatShiftDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "short" });
  };

  const formatShiftTime = (startIso: string, endIso: string) => {
    const s = new Date(startIso);
    const e = new Date(endIso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(s.getHours())}:${pad(s.getMinutes())} – ${pad(e.getHours())}:${pad(e.getMinutes())}`;
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <ScreenGradient scrollable={false}>
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
          <ActivityIndicator size="large" color="#3B82F6" />
          <Text style={{ color: "#94A3B8", marginTop: 12, fontSize: 16 }}>Carregando turnos...</Text>
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
            <ChevronLeft size={24} color="#F1F5F9" />
            <Text style={{ color: "#F1F5F9", fontSize: 16 }}>Voltar</Text>
          </TouchableOpacity>

          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <ArrowRightLeft size={28} color="#3B82F6" />
            <Text style={{ color: "#F1F5F9", fontSize: 28, fontWeight: "700" }}>Oferecer Troca ou Repasse</Text>
          </View>
        </View>

        {/* S1 — Tipo de operação */}
        <View>
          <Text style={{ color: "#F1F5F9", fontSize: 18, fontWeight: "600", marginBottom: 12 }}>Tipo de operação</Text>
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
                  backgroundColor: type === t ? "#3B82F6" : "#1E293B",
                  borderWidth: 1,
                  borderColor: type === t ? "#3B82F6" : "rgba(148,163,184,0.15)",
                }}
              >
                <Text style={{ color: "#F1F5F9", fontSize: 16, fontWeight: "600" }}>
                  {t === "SWAP" ? "TROCA" : "REPASSE"}
                </Text>
                <Text style={{ color: type === t ? "#E2E8F0" : "#64748B", fontSize: 12, marginTop: 4 }}>
                  {t === "SWAP" ? "Meu turno ↔ outro turno" : "Entrego meu turno"}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* S2 — Meu plantão */}
        <View>
          <Text style={{ color: "#F1F5F9", fontSize: 18, fontWeight: "600", marginBottom: 12 }}>
            Meu plantão {selectedFrom ? "✓" : "(selecione)"}
          </Text>
          {myShifts.length === 0 ? (
            <Text style={{ color: "#64748B", fontSize: 14 }}>Nenhum turno futuro encontrado.</Text>
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
                    backgroundColor: selectedFrom?.id === s.id ? "rgba(59,130,246,0.2)" : "#141B2D",
                    borderWidth: 1.5,
                    borderColor: selectedFrom?.id === s.id ? "#3B82F6" : "rgba(148,163,184,0.15)",
                  }}
                >
                  <Text style={{ color: "#F1F5F9", fontSize: 15, fontWeight: "600" }}>{s.label}</Text>
                  <Text style={{ color: "#94A3B8", fontSize: 13, marginTop: 4 }}>{formatShiftDate(s.startAt)}</Text>
                  <Text style={{ color: "#94A3B8", fontSize: 13, marginTop: 2 }}>{formatShiftTime(s.startAt, s.endAt)}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}
        </View>

        {/* S3 — Plantão desejado (só SWAP) */}
        {type === "SWAP" && (
          <View>
            <Text style={{ color: "#F1F5F9", fontSize: 18, fontWeight: "600", marginBottom: 12 }}>
              Plantão desejado {selectedTo ? "✓" : "(selecione)"}
            </Text>
            {otherShifts.length === 0 ? (
              <Text style={{ color: "#64748B", fontSize: 14 }}>Nenhum turno de outro profissional encontrado.</Text>
            ) : (
              <View style={{ gap: 10 }}>
                {otherShifts.map((s) => (
                  <TouchableOpacity
                    key={s.id}
                    onPress={() => setSelectedTo(s)}
                    style={{
                      padding: 14,
                      borderRadius: 12,
                      backgroundColor: selectedTo?.id === s.id ? "rgba(59,130,246,0.2)" : "#141B2D",
                      borderWidth: 1.5,
                      borderColor: selectedTo?.id === s.id ? "#3B82F6" : "rgba(148,163,184,0.15)",
                    }}
                  >
                    <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                      <Text style={{ color: "#F1F5F9", fontSize: 15, fontWeight: "600" }}>{s.label}</Text>
                      <Text style={{ color: "#94A3B8", fontSize: 12 }}>{formatShiftDate(s.startAt)}</Text>
                    </View>
                    <Text style={{ color: "#94A3B8", fontSize: 13, marginTop: 4 }}>{formatShiftTime(s.startAt, s.endAt)}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>
        )}

        {/* S4 — Motivo */}
        <View>
          <Text style={{ color: "#F1F5F9", fontSize: 18, fontWeight: "600", marginBottom: 12 }}>Motivo (opcional)</Text>
          <View style={{
            backgroundColor: "#141B2D",
            borderRadius: 12,
            borderWidth: 1,
            borderColor: "rgba(148,163,184,0.15)",
            padding: 14,
          }}>
            <TextInput
              placeholder="Motivo da troca/repasse..."
              placeholderTextColor="#64748B"
              value={reason}
              onChangeText={setReason}
              multiline
              numberOfLines={3}
              style={{ color: "#F1F5F9", fontSize: 15, minHeight: 80, textAlignVertical: "top" }}
            />
          </View>
        </View>

        {/* Error */}
        {error && (
          <View style={{ backgroundColor: "rgba(239,68,68,0.15)", borderRadius: 12, padding: 14, borderWidth: 1, borderColor: "rgba(239,68,68,0.3)" }}>
            <Text style={{ color: "#EF4444", fontSize: 14 }}>{error}</Text>
          </View>
        )}

        {/* Submit button */}
        <TouchableOpacity
          onPress={handleSubmit}
          disabled={submitting}
          style={{
            backgroundColor: submitting ? "#1E3A5F" : "#3B82F6",
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
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <>
              <Send size={20} color="#FFFFFF" />
              <Text style={{ color: "#FFFFFF", fontSize: 18, fontWeight: "700" }}>Enviar Oferta</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </ScreenGradient>
  );
}
