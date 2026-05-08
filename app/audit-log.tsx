import { Text, View, TouchableOpacity, ActivityIndicator, ScrollView, TextInput } from "react-native";
import { useState, useMemo } from "react";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { theme } from "@/lib/theme";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/hooks/use-auth";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { ChevronLeft, History, AlertCircle, Search } from "lucide-react-native";

/**
 * Tela "Auditoria de movimentações" — consume `audit.listShiftMovements`
 * (PR #77). Lista cronologicamente reversa quem alterou o quê e quando.
 *
 * RBAC do conteúdo é feito no backend:
 *   - GESTOR_PLUS / admin: vê toda a instituição
 *   - GESTOR_MEDICO: filtrado por manager_scope
 *   - USER: vê apenas eventos onde participou (actor / from / to)
 *
 * Acesso: rota stack acessível via Perfil → "Auditoria de movimentações".
 */

type FilterCategory = "ALL" | "CREATION" | "ASSIGNMENT" | "CESSAO";

const CATEGORY_LABEL: Record<FilterCategory, string> = {
  ALL: "Tudo",
  CREATION: "Criação / Edição",
  ASSIGNMENT: "Alocações",
  CESSAO: "Cessões e trocas",
};

const CATEGORY_ACTIONS: Record<FilterCategory, string[]> = {
  ALL: [],
  CREATION: ["SHIFT_CREATED", "SHIFT_UPDATED", "SHIFT_DELETED"],
  ASSIGNMENT: [
    "ASSIGNMENT_CREATED",
    "ASSIGNMENT_REMOVED",
    "ASSIGNMENT_ASSUMED_VACANCY",
    "ASSIGNMENT_APPROVED",
    "ASSIGNMENT_REJECTED",
  ],
  CESSAO: [
    "SWAP_REQUESTED",
    "SWAP_ACCEPTED",
    "SWAP_REJECTED",
    "SWAP_APPROVED_BY_MANAGER",
    "SWAP_APPROVED_BY_OWNER",
    "SWAP_CANCELLED",
    "TRANSFER_OFFERED",
    "TRANSFER_ACCEPTED",
    "TRANSFER_REJECTED",
    "TRANSFER_APPROVED_BY_MANAGER",
    "TRANSFER_APPROVED_BY_OWNER",
    "TRANSFER_CANCELLED",
    "CESSAO_OFFERED",
    "CESSAO_ACCEPTED",
    "CESSAO_REJECTED",
    "CESSAO_APPROVED_BY_OWNER",
    "CESSAO_CANCELLED",
  ],
};

function formatRelative(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 1) return "agora";
  if (diffMin < 60) return `há ${diffMin} min`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `há ${diffHr}h`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `há ${diffDay}d`;
  return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
}

function formatAbsolute(date: Date): string {
  return date.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AuditLogScreen() {
  const { user, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const [category, setCategory] = useState<FilterCategory>("ALL");
  const [searchTerm, setSearchTerm] = useState("");

  // Defensive cast — o tipo `trpc.audit` chega via PR #77 (ainda em
  // review nesse momento). O padrão de defensive cast é igual ao usado
  // em PRs #65/#67/#69/#70.
  const trpcAny = trpc as any;
  const auditQuery = trpcAny.audit?.listShiftMovements?.useQuery?.(
    {
      actions: category === "ALL" ? undefined : CATEGORY_ACTIONS[category],
      limit: 200,
    },
    { enabled: !!user?.id },
  ) ?? { data: undefined, isLoading: false, refetch: () => {} };

  const data = (auditQuery.data ?? []) as any[];
  const isLoading = auditQuery.isLoading as boolean;

  const filteredRows = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term) return data;
    return data.filter((r) => {
      const haystack = [
        r.actionLabel,
        r.description,
        r.actor?.name,
        r.from?.name,
        r.to?.name,
        r.shift?.label,
        r.location?.hospitalName,
        r.location?.sectorName,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [data, searchTerm]);

  const handleBack = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.back();
  };

  if (authLoading) {
    return (
      <ScreenGradient>
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </ScreenGradient>
    );
  }

  if (!user) {
    return (
      <ScreenGradient>
        <View className="flex-1 items-center justify-center">
          <AlertCircle size={48} color={theme.colors.textMuted} />
          <Text className="mt-4 text-lg" style={{ color: theme.colors.textMuted }}>
            Faça login para ver a auditoria
          </Text>
        </View>
      </ScreenGradient>
    );
  }

  return (
    <ScreenGradient>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: 40 }}>
        {/* Header */}
        <View className="flex-row items-center gap-3 mb-2">
          <TouchableOpacity
            onPress={handleBack}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Voltar"
          >
            <ChevronLeft size={28} color={theme.colors.textPrimary} />
          </TouchableOpacity>
          <Text className="text-3xl font-bold" style={{ color: theme.colors.textPrimary }}>
            Auditoria
          </Text>
        </View>
        <Text className="text-sm mb-5" style={{ color: theme.colors.textMuted }}>
          Movimentações de plantão dos últimos 30 dias
        </Text>

        {/* Search */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            borderWidth: 1,
            borderColor: theme.colors.border,
            borderRadius: 10,
            backgroundColor: theme.colors.surface,
            paddingHorizontal: 10,
            paddingVertical: 8,
            marginBottom: 12,
          }}
        >
          <Search size={16} color={theme.colors.textMuted} />
          <TextInput
            value={searchTerm}
            onChangeText={setSearchTerm}
            placeholder="Buscar por nome, plantão, ação..."
            placeholderTextColor={theme.colors.textMuted}
            style={{ flex: 1, color: theme.colors.textPrimary, fontSize: 14, paddingVertical: 0 }}
          />
        </View>

        {/* Category chips */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingBottom: 4 }}
          style={{ marginBottom: 16 }}
        >
          {(Object.keys(CATEGORY_LABEL) as FilterCategory[]).map((cat) => {
            const selected = category === cat;
            return (
              <TouchableOpacity
                key={cat}
                onPress={() => setCategory(cat)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`Filtrar por ${CATEGORY_LABEL[cat]}`}
                style={{
                  borderRadius: 999,
                  paddingHorizontal: 14,
                  paddingVertical: 7,
                  backgroundColor: selected ? theme.colors.primary : theme.colors.surfaceAlt,
                  borderWidth: 1,
                  borderColor: selected ? theme.colors.primary : theme.colors.border,
                }}
              >
                <Text
                  style={{
                    color: selected ? theme.colors.surface : theme.colors.textPrimary,
                    fontSize: 13,
                    fontWeight: "600",
                  }}
                >
                  {CATEGORY_LABEL[cat]}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        {isLoading ? (
          <View className="items-center py-20">
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text className="mt-4 text-base" style={{ color: theme.colors.textMuted }}>
              Carregando movimentações...
            </Text>
          </View>
        ) : filteredRows.length === 0 ? (
          <View className="items-center justify-center py-20">
            <History size={64} color={theme.colors.textMuted} />
            <Text
              className="mt-4 text-lg font-semibold text-center"
              style={{ color: theme.colors.textPrimary }}
            >
              {searchTerm ? "Nenhuma movimentação encontrada" : "Nenhuma movimentação no período"}
            </Text>
            <Text className="mt-2 text-sm text-center px-6" style={{ color: theme.colors.textMuted }}>
              {searchTerm
                ? "Ajuste o termo de busca ou troque o filtro de categoria."
                : "As movimentações aparecem aqui quando alguém criar, editar ou alocar plantões."}
            </Text>
          </View>
        ) : (
          <View className="gap-2">
            {filteredRows.map((row) => (
              <AuditCard key={row.id} row={row} />
            ))}
          </View>
        )}
      </ScrollView>
    </ScreenGradient>
  );
}

function AuditCard({ row }: { row: any }) {
  const createdAt = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
  const actionLabel = row.actionLabel ?? row.action ?? "Ação desconhecida";
  const actorName = row.actor?.name ?? row.actor?.email ?? "Usuário desconhecido";
  const fromName = row.from?.name as string | undefined;
  const toName = row.to?.name as string | undefined;
  const shiftLabel = row.shift?.label as string | undefined;
  const shiftStart = row.shift?.startAt
    ? new Date(row.shift.startAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })
    : null;
  const hospitalName = row.location?.hospitalName as string | undefined;
  const sectorName = row.location?.sectorName as string | undefined;

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 12,
        padding: 12,
        backgroundColor: theme.colors.surface,
        gap: 4,
      }}
    >
      {/* Linha 1: ação + tempo relativo */}
      <View className="flex-row items-center justify-between">
        <View
          style={{
            backgroundColor: theme.colors.primarySoft,
            paddingHorizontal: 8,
            paddingVertical: 2,
            borderRadius: 999,
          }}
        >
          <Text className="text-xs font-semibold" style={{ color: theme.colors.primary }}>
            {actionLabel}
          </Text>
        </View>
        <Text className="text-xs" style={{ color: theme.colors.textMuted }}>
          {formatRelative(createdAt)}
        </Text>
      </View>

      {/* Linha 2: ator faz coisa */}
      <Text className="text-sm" style={{ color: theme.colors.textPrimary }}>
        <Text style={{ fontWeight: "600" }}>{actorName}</Text>
        {fromName || toName ? (
          <>
            {fromName ? (
              <>
                {" — "}
                <Text style={{ color: theme.colors.textSecondary }}>{fromName}</Text>
              </>
            ) : null}
            {fromName && toName ? <Text style={{ color: theme.colors.textMuted }}> → </Text> : null}
            {toName && !fromName ? <Text style={{ color: theme.colors.textMuted }}> → </Text> : null}
            {toName ? <Text style={{ color: theme.colors.textSecondary }}>{toName}</Text> : null}
          </>
        ) : null}
      </Text>

      {/* Linha 3: contexto do plantão */}
      {(shiftLabel || hospitalName || sectorName) && (
        <Text className="text-xs" style={{ color: theme.colors.textMuted }}>
          {[shiftLabel, shiftStart, hospitalName, sectorName].filter(Boolean).join(" · ")}
        </Text>
      )}

      {/* Linha 4: timestamp absoluto */}
      <Text className="text-xs" style={{ color: theme.colors.textMuted, fontSize: 11 }}>
        {formatAbsolute(createdAt)}
      </Text>
    </View>
  );
}
