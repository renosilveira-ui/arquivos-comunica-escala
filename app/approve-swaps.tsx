import { useState, useEffect, useCallback } from "react";
import {
  Text,
  View,
  TouchableOpacity,
  ActivityIndicator,
 } from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { useAuth } from "@/hooks/use-auth";
import { usePermissions } from "@/hooks/use-permissions";
import { apiFetch } from "@/lib/_core/api";
import { useRouter, useFocusEffect } from "expo-router";
import { ChevronLeft, Shield } from "lucide-react-native";
import { theme } from "@/lib/theme";
import { QueryErrorState } from "@/components/ui/QueryErrorState";
import { formatHospitalTimeRange } from "@/lib/hospital-time";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Fetch com URL base, sessão e tenant do app (lib/_core/api.ts) — antes a
// cópia local não mandava x-tenant-id e caía em localhost na web.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SwapItem {
  id: number;
  type: "SWAP" | "TRANSFER" | "CESSAO";
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
  const { can, isLoading: permissionsLoading } = usePermissions();
  const router = useRouter();

  const [tab, setTab] = useState<TabFilter>("ACCEPTED");
  const [items, setItems] = useState<SwapItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    const params: Record<string, any> = { limit: 100, offset: 0 };
    if (tab === "ACCEPTED") params.status = "ACCEPTED";

    // try/finally: sem isso, uma rejeição de rede escapava do callback
    // (unhandled) e o spinner nunca saía da tela; e res.ok ignorado
    // fazia HTTP 4xx/5xx virar um histórico vazio enganoso.
    try {
      const res = await apiFetch<any>(
        `/api/trpc/swaps.list?batch=1&input=${encodeURIComponent(JSON.stringify({ "0": { json: params } }))}`,
      );
      if (!res.ok) {
        setLoadError(true);
        setItems([]);
        return;
      }
      const data: SwapItem[] = (res.data as any)?.[0]?.result?.data?.json ?? [];
      setItems(data);
    } catch {
      setLoadError(true);
      setItems([]);
    } finally {
      setLoading(false);
    }
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

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  };

  const formatShiftTime = (startIso: string, endIso: string) =>
    formatHospitalTimeRange(startIso, endIso);

  const acceptedCount = items.filter((i) => i.status === "ACCEPTED").length;

  const canViewHistory = can("view:swap-history");

  if (permissionsLoading) {
    return (
      <ScreenGradient scrollable={false}>
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </ScreenGradient>
    );
  }

  if (!canViewHistory) {
    return (
      <ScreenGradient scrollable={false}>
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
          <Shield size={64} color={theme.colors.textMuted} />
          <Text style={{ color: theme.colors.textPrimary, fontSize: 20, fontWeight: "600", marginTop: 16 }}>Acesso Restrito</Text>
          <Text style={{ color: theme.colors.textSecondary, fontSize: 14, marginTop: 8 }}>Apenas gestores podem consultar este histórico.</Text>
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
            <ChevronLeft size={24} color={theme.colors.textPrimary} />
            <Text style={{ color: theme.colors.textPrimary, fontSize: 16 }}>Voltar</Text>
          </TouchableOpacity>

          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <Shield size={28} color={theme.colors.primary} />
            <Text style={{ color: theme.colors.textPrimary, fontSize: 28, fontWeight: "700" }}>Histórico de Trocas</Text>
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
                backgroundColor: tab === t ? theme.colors.primarySoft : theme.colors.surface,
                borderWidth: 1,
                borderColor: tab === t ? theme.colors.primary : theme.colors.border,
                flexDirection: "row",
                justifyContent: "center",
                gap: 8,
              }}
            >
              <Text style={{ color: tab === t ? theme.palette.primary[700] : theme.colors.textPrimary, fontSize: 15, fontWeight: "600" }}>
                {t === "ACCEPTED" ? "Aguardando ofertante" : "Todos"}
              </Text>
              {t === "ACCEPTED" && acceptedCount > 0 && (
                <View style={{
                  backgroundColor: theme.colors.danger,
                  borderRadius: 10,
                  minWidth: 20,
                  height: 20,
                  alignItems: "center",
                  justifyContent: "center",
                  paddingHorizontal: 6,
                }}>
                  <Text style={{ color: theme.colors.surface, fontSize: 11, fontWeight: "700" }}>{acceptedCount}</Text>
                </View>
              )}
            </TouchableOpacity>
          ))}
        </View>

        {/* List */}
        {loading ? (
          <View style={{ paddingVertical: 60, alignItems: "center" }}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
          </View>
        ) : loadError ? (
          <QueryErrorState
            title="Não foi possível carregar as trocas"
            onRetry={() => fetchItems()}
          />
        ) : items.length === 0 ? (
          <View style={{ paddingVertical: 60, alignItems: "center" }}>
            <Shield size={48} color={theme.colors.borderStrong} />
            <Text style={{ color: theme.colors.textMuted, fontSize: 16, marginTop: 12 }}>
              {tab === "ACCEPTED" ? "Nenhuma troca aguardando decisão do ofertante" : "Nenhuma troca encontrada"}
            </Text>
          </View>
        ) : (
          <View style={{ gap: 14 }}>
            {items.map((item) => (
              <View
                key={item.id}
                style={{
                  backgroundColor: theme.colors.surface,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                  padding: 16,
                }}
              >
                {/* Top row: type + status badges */}
                <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
                  <Badge variant={item.type === "SWAP" ? "info" : "warning"}>
                    {item.type === "SWAP" ? "TROCA" : item.type === "CESSAO" ? "CESSÃO" : "REPASSE"}
                  </Badge>
                  <Badge variant={STATUS_BADGE[item.status] ?? "neutral"}>
                    {STATUS_LABEL[item.status] ?? item.status}
                  </Badge>
                </View>

                {/* From professional */}
                <Text style={{ color: theme.colors.textPrimary, fontSize: 15, fontWeight: "600" }}>
                  {item.fromProfessional.name}
                  <Text style={{ color: theme.colors.textSecondary, fontWeight: "400" }}> • {item.fromProfessional.role}</Text>
                </Text>

                {/* From shift */}
                <View style={{ marginTop: 8, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: theme.colors.primary }}>
                  <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>Plantão oferecido</Text>
                  <Text style={{ color: theme.colors.textPrimary, fontSize: 14 }}>
                    {item.fromShift.label} — {formatDate(item.fromShift.startAt)}
                  </Text>
                  <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>
                    {formatShiftTime(item.fromShift.startAt, item.fromShift.endAt)} • {item.fromShift.hospitalName} / {item.fromShift.sectorName}
                  </Text>
                </View>

                {/* Accepted by */}
                {item.toProfessional && (
                  <View style={{ marginTop: 10 }}>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>Aceito por</Text>
                    <Text style={{ color: theme.colors.textPrimary, fontSize: 14, fontWeight: "600" }}>
                      {item.toProfessional.name}
                      <Text style={{ color: theme.colors.textSecondary, fontWeight: "400" }}> • {item.toProfessional.role}</Text>
                    </Text>
                  </View>
                )}

                {/* To shift (SWAP) */}
                {item.toShift && (
                  <View style={{ marginTop: 8, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: theme.colors.warning }}>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>Plantão em troca</Text>
                    <Text style={{ color: theme.colors.textPrimary, fontSize: 14 }}>
                      {item.toShift.label} — {formatDate(item.toShift.startAt)}
                    </Text>
                    <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>
                      {formatShiftTime(item.toShift.startAt, item.toShift.endAt)} • {item.toShift.hospitalName} / {item.toShift.sectorName}
                    </Text>
                  </View>
                )}

                {/* Reason */}
                {item.reason && (
                  <Text style={{ color: theme.colors.textSecondary, fontSize: 13, fontStyle: "italic", marginTop: 8 }}>
                    {`"${item.reason}"`}
                  </Text>
                )}

                {/* Date */}
                <Text style={{ color: theme.colors.textMuted, fontSize: 11, marginTop: 8 }}>
                  Solicitado em {formatDate(item.createdAt)}
                </Text>

                {/* Gestor acompanha; a decisão é integralmente entre A e B. */}
                {item.status === "ACCEPTED" && (
                  <View style={{ marginTop: 14, padding: 12, borderRadius: 10, backgroundColor: theme.colors.primarySoft }}>
                    <Text style={{ color: theme.palette.primary[700], fontSize: 13 }}>
                      Aguardando decisão do profissional que ofertou o plantão. Gestores acompanham o histórico, sem aprovar ou bloquear.
                    </Text>
                  </View>
                )}
              </View>
            ))}
          </View>
        )}

      </View>
    </ScreenGradient>
  );
}
