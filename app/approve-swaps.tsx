import { useState, useEffect, useCallback } from "react";
import {
  Text,
  View,
  TouchableOpacity,
  ScrollView,
  TextInput,
  Alert,
  ActivityIndicator,
  Platform,
  Modal,
} from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { useAuth } from "@/hooks/use-auth";
import * as Auth from "@/lib/_core/auth";
import { useRouter } from "expo-router";
import { ChevronLeft, Shield, Check, X } from "lucide-react-native";
import { useFocusEffect } from "expo-router";

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

const uiAlert = (title: string, message: string) => {
  if (Platform.OS === "web") window.alert(`${title}\n\n${message}`);
  else Alert.alert(title, message);
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SwapItem {
  id: number;
  type: "SWAP" | "TRANSFER";
  status: string;
  reason: string | null;
  reviewNote: string | null;
  expiresAt: string | null;
  createdAt: string;
  reviewedAt: string | null;
  fromProfessional: { id: number; name: string; role: string };
  toProfessional: { id: number; name: string; role: string } | null;
  fromShift: { id: number; label: string; startAt: string; endAt: string; hospitalName: string; sectorName: string };
  toShift: { id: number; label: string; startAt: string; endAt: string; hospitalName: string; sectorName: string } | null;
  reviewerName: string | null;
}

type TabFilter = "ACCEPTED" | "ALL";

const STATUS_BADGE: Record<string, BadgeVariant> = {
  PENDING: "warning",
  ACCEPTED: "info",
  APPROVED: "success",
  REJECTED_BY_PEER: "critical",
  REJECTED_BY_MANAGER: "critical",
  CANCELLED: "neutral",
  EXPIRED: "neutral",
};

const STATUS_LABEL: Record<string, string> = {
  PENDING: "Pendente",
  ACCEPTED: "Aceito",
  APPROVED: "Aprovado",
  REJECTED_BY_PEER: "Recusado",
  REJECTED_BY_MANAGER: "Rejeitado",
  CANCELLED: "Cancelado",
  EXPIRED: "Expirado",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ApproveSwapsScreen() {
  const { user } = useAuth();
  const router = useRouter();

  const [tab, setTab] = useState<TabFilter>("ACCEPTED");
  const [items, setItems] = useState<SwapItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  // Modal state
  const [modalVisible, setModalVisible] = useState(false);
  const [modalAction, setModalAction] = useState<"approve" | "reject">("approve");
  const [modalSwapId, setModalSwapId] = useState<number>(0);
  const [modalNote, setModalNote] = useState("");

  const fetchItems = useCallback(async () => {
    setLoading(true);
    const params: Record<string, any> = { limit: 100, offset: 0 };
    if (tab === "ACCEPTED") params.status = "ACCEPTED";

    const res = await apiFetch<any>(
      `/api/trpc/swaps.list?batch=1&input=${encodeURIComponent(JSON.stringify({ "0": { json: params } }))}`,
    );
    const data: SwapItem[] = (res.data as any)?.[0]?.result?.data?.json ?? [];
    setItems(data);
    setLoading(false);
  }, [tab]);

  useFocusEffect(
    useCallback(() => {
      if (user?.id) fetchItems();
    }, [user?.id, fetchItems]),
  );

  // Re-fetch when tab changes
  useEffect(() => {
    if (user?.id) fetchItems();
  }, [tab, fetchItems, user?.id]);

  const openModal = (action: "approve" | "reject", swapId: number) => {
    setModalAction(action);
    setModalSwapId(swapId);
    setModalNote("");
    setModalVisible(true);
  };

  const handleModalSubmit = async () => {
    if (modalAction === "reject" && !modalNote.trim()) {
      uiAlert("Atenção", "Informe o motivo da rejeição.");
      return;
    }

    setModalVisible(false);
    setActionLoading(modalSwapId);

    const endpoint = modalAction === "approve" ? "swaps.approve" : "swaps.rejectByManager";
    const body: Record<string, any> = { swapRequestId: modalSwapId };
    if (modalNote.trim()) body.note = modalNote.trim();

    const res = await apiFetch<any>(`/api/trpc/${endpoint}?batch=1`, {
      method: "POST",
      body: JSON.stringify({ "0": { json: body } }),
    });

    setActionLoading(null);

    const result = (res.data as any)?.[0];
    if (result?.error) {
      uiAlert("Erro", result.error.json?.message ?? "Erro ao processar");
      return;
    }

    uiAlert("Sucesso", modalAction === "approve" ? "Troca aprovada!" : "Troca rejeitada!");
    fetchItems();
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  };

  const formatShiftTime = (startIso: string, endIso: string) => {
    const s = new Date(startIso);
    const e = new Date(endIso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(s.getHours())}:${pad(s.getMinutes())} – ${pad(e.getHours())}:${pad(e.getMinutes())}`;
  };

  const acceptedCount = items.filter((i) => i.status === "ACCEPTED").length;

  // Redirect non-admin/manager
  const isManager = user?.role === "admin" || user?.role === "manager";

  if (!isManager) {
    return (
      <ScreenGradient scrollable={false}>
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
          <Shield size={64} color="#64748B" />
          <Text style={{ color: "#F1F5F9", fontSize: 20, fontWeight: "600", marginTop: 16 }}>Acesso Restrito</Text>
          <Text style={{ color: "#94A3B8", fontSize: 14, marginTop: 8 }}>Apenas gestores podem gerenciar trocas.</Text>
        </View>
      </ScreenGradient>
    );
  }

  return (
    <ScreenGradient scrollable>
      <View style={{ gap: 20, paddingBottom: 40 }}>
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
            <Shield size={28} color="#3B82F6" />
            <Text style={{ color: "#F1F5F9", fontSize: 28, fontWeight: "700" }}>Gerenciar Trocas</Text>
          </View>
        </View>

        {/* Tabs */}
        <View style={{ flexDirection: "row", gap: 12 }}>
          {(["ACCEPTED", "ALL"] as TabFilter[]).map((t) => (
            <TouchableOpacity
              key={t}
              onPress={() => setTab(t)}
              style={{
                flex: 1,
                paddingVertical: 12,
                borderRadius: 12,
                alignItems: "center",
                backgroundColor: tab === t ? "#3B82F6" : "#1E293B",
                borderWidth: 1,
                borderColor: tab === t ? "#3B82F6" : "rgba(148,163,184,0.15)",
                flexDirection: "row",
                justifyContent: "center",
                gap: 8,
              }}
            >
              <Text style={{ color: "#F1F5F9", fontSize: 15, fontWeight: "600" }}>
                {t === "ACCEPTED" ? "Pendentes" : "Todos"}
              </Text>
              {t === "ACCEPTED" && acceptedCount > 0 && (
                <View style={{
                  backgroundColor: "#EF4444",
                  borderRadius: 10,
                  minWidth: 20,
                  height: 20,
                  alignItems: "center",
                  justifyContent: "center",
                  paddingHorizontal: 6,
                }}>
                  <Text style={{ color: "#FFFFFF", fontSize: 11, fontWeight: "700" }}>{acceptedCount}</Text>
                </View>
              )}
            </TouchableOpacity>
          ))}
        </View>

        {/* List */}
        {loading ? (
          <View style={{ paddingVertical: 60, alignItems: "center" }}>
            <ActivityIndicator size="large" color="#3B82F6" />
          </View>
        ) : items.length === 0 ? (
          <View style={{ paddingVertical: 60, alignItems: "center" }}>
            <Shield size={48} color="rgba(148,163,184,0.3)" />
            <Text style={{ color: "#64748B", fontSize: 16, marginTop: 12 }}>
              {tab === "ACCEPTED" ? "Nenhuma troca aguardando aprovação" : "Nenhuma troca encontrada"}
            </Text>
          </View>
        ) : (
          <View style={{ gap: 14 }}>
            {items.map((item) => (
              <View
                key={item.id}
                style={{
                  backgroundColor: "#141B2D",
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: "rgba(148,163,184,0.15)",
                  padding: 16,
                }}
              >
                {/* Top row: type + status badges */}
                <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
                  <Badge variant={item.type === "SWAP" ? "info" : "warning"}>
                    {item.type === "SWAP" ? "TROCA" : "REPASSE"}
                  </Badge>
                  <Badge variant={STATUS_BADGE[item.status] ?? "neutral"}>
                    {STATUS_LABEL[item.status] ?? item.status}
                  </Badge>
                </View>

                {/* From professional */}
                <Text style={{ color: "#F1F5F9", fontSize: 15, fontWeight: "600" }}>
                  {item.fromProfessional.name}
                  <Text style={{ color: "#94A3B8", fontWeight: "400" }}> • {item.fromProfessional.role}</Text>
                </Text>

                {/* From shift */}
                <View style={{ marginTop: 8, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: "#3B82F6" }}>
                  <Text style={{ color: "#94A3B8", fontSize: 13 }}>Plantão oferecido</Text>
                  <Text style={{ color: "#F1F5F9", fontSize: 14 }}>
                    {item.fromShift.label} — {formatDate(item.fromShift.startAt)}
                  </Text>
                  <Text style={{ color: "#94A3B8", fontSize: 12 }}>
                    {formatShiftTime(item.fromShift.startAt, item.fromShift.endAt)} • {item.fromShift.hospitalName} / {item.fromShift.sectorName}
                  </Text>
                </View>

                {/* Accepted by */}
                {item.toProfessional && (
                  <View style={{ marginTop: 10 }}>
                    <Text style={{ color: "#94A3B8", fontSize: 13 }}>Aceito por</Text>
                    <Text style={{ color: "#F1F5F9", fontSize: 14, fontWeight: "600" }}>
                      {item.toProfessional.name}
                      <Text style={{ color: "#94A3B8", fontWeight: "400" }}> • {item.toProfessional.role}</Text>
                    </Text>
                  </View>
                )}

                {/* To shift (SWAP) */}
                {item.toShift && (
                  <View style={{ marginTop: 8, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: "#F59E0B" }}>
                    <Text style={{ color: "#94A3B8", fontSize: 13 }}>Plantão em troca</Text>
                    <Text style={{ color: "#F1F5F9", fontSize: 14 }}>
                      {item.toShift.label} — {formatDate(item.toShift.startAt)}
                    </Text>
                    <Text style={{ color: "#94A3B8", fontSize: 12 }}>
                      {formatShiftTime(item.toShift.startAt, item.toShift.endAt)} • {item.toShift.hospitalName} / {item.toShift.sectorName}
                    </Text>
                  </View>
                )}

                {/* Reason */}
                {item.reason && (
                  <Text style={{ color: "#94A3B8", fontSize: 13, fontStyle: "italic", marginTop: 8 }}>
                    "{item.reason}"
                  </Text>
                )}

                {/* Date */}
                <Text style={{ color: "#64748B", fontSize: 11, marginTop: 8 }}>
                  Solicitado em {formatDate(item.createdAt)}
                </Text>

                {/* Action buttons — only for ACCEPTED */}
                {item.status === "ACCEPTED" && (
                  <View style={{ flexDirection: "row", gap: 10, marginTop: 14 }}>
                    <TouchableOpacity
                      onPress={() => openModal("approve", item.id)}
                      disabled={actionLoading === item.id}
                      style={{
                        flex: 1,
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 6,
                        paddingVertical: 12,
                        borderRadius: 10,
                        backgroundColor: "#22C55E",
                        opacity: actionLoading === item.id ? 0.6 : 1,
                      }}
                    >
                      {actionLoading === item.id ? (
                        <ActivityIndicator color="#FFFFFF" size="small" />
                      ) : (
                        <>
                          <Check size={18} color="#FFFFFF" />
                          <Text style={{ color: "#FFFFFF", fontSize: 15, fontWeight: "600" }}>Aprovar</Text>
                        </>
                      )}
                    </TouchableOpacity>

                    <TouchableOpacity
                      onPress={() => openModal("reject", item.id)}
                      disabled={actionLoading === item.id}
                      style={{
                        flex: 1,
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 6,
                        paddingVertical: 12,
                        borderRadius: 10,
                        backgroundColor: "#EF4444",
                        opacity: actionLoading === item.id ? 0.6 : 1,
                      }}
                    >
                      <X size={18} color="#FFFFFF" />
                      <Text style={{ color: "#FFFFFF", fontSize: 15, fontWeight: "600" }}>Rejeitar</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            ))}
          </View>
        )}

        {/* Modal for approve/reject note */}
        <Modal
          visible={modalVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setModalVisible(false)}
        >
          <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", alignItems: "center", padding: 24 }}>
            <View style={{
              backgroundColor: "#141B2D",
              borderRadius: 16,
              padding: 24,
              width: "100%",
              maxWidth: 400,
              borderWidth: 1,
              borderColor: "rgba(148,163,184,0.15)",
            }}>
              <Text style={{ color: "#F1F5F9", fontSize: 20, fontWeight: "700", marginBottom: 16 }}>
                {modalAction === "approve" ? "Aprovar Troca" : "Rejeitar Troca"}
              </Text>

              <Text style={{ color: "#94A3B8", fontSize: 14, marginBottom: 12 }}>
                {modalAction === "approve"
                  ? "Nota opcional para registro:"
                  : "Informe o motivo da rejeição (obrigatório):"}
              </Text>

              <TextInput
                placeholder={modalAction === "approve" ? "Nota (opcional)..." : "Motivo da rejeição..."}
                placeholderTextColor="#64748B"
                value={modalNote}
                onChangeText={setModalNote}
                multiline
                numberOfLines={3}
                style={{
                  color: "#F1F5F9",
                  fontSize: 15,
                  backgroundColor: "#0B1120",
                  borderRadius: 10,
                  padding: 12,
                  minHeight: 80,
                  textAlignVertical: "top",
                  borderWidth: 1,
                  borderColor: "rgba(148,163,184,0.15)",
                  marginBottom: 20,
                }}
              />

              <View style={{ flexDirection: "row", gap: 12 }}>
                <TouchableOpacity
                  onPress={() => setModalVisible(false)}
                  style={{
                    flex: 1,
                    paddingVertical: 12,
                    borderRadius: 10,
                    alignItems: "center",
                    backgroundColor: "#1E293B",
                    borderWidth: 1,
                    borderColor: "rgba(148,163,184,0.15)",
                  }}
                >
                  <Text style={{ color: "#94A3B8", fontSize: 15, fontWeight: "600" }}>Cancelar</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={handleModalSubmit}
                  style={{
                    flex: 1,
                    paddingVertical: 12,
                    borderRadius: 10,
                    alignItems: "center",
                    backgroundColor: modalAction === "approve" ? "#22C55E" : "#EF4444",
                  }}
                >
                  <Text style={{ color: "#FFFFFF", fontSize: 15, fontWeight: "600" }}>
                    {modalAction === "approve" ? "Confirmar" : "Rejeitar"}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    </ScreenGradient>
  );
}
