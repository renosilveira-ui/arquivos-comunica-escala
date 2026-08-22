import { View, Text, ActivityIndicator, TextInput, TouchableOpacity, FlatList, Platform } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState, useMemo } from "react";
import { UserPlus, Search, Check } from "lucide-react-native";
import * as Haptics from "expo-haptics";
import { useActionFeedback } from "@/hooks/use-action-feedback";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { PrimaryButton } from "@/components/ui/PrimaryButton";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/hooks/use-auth";
import { theme } from "@/lib/theme";

export default function NominateReplacementScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams<{ token: string }>();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Reuse the shift instance ID from the pending confirmation to get the
  // same professional list that shift-details uses for allocation.
  const { data: pending } = trpc.confirmations.getPending.useQuery(
    undefined,
    { enabled: !!user },
  );

  const { data: professionals, isLoading } =
    trpc.confirmations.listReplacementCandidates.useQuery(
      undefined,
      { enabled: !!user },
    );

  const feedback = useActionFeedback();
  const nominateMutation = trpc.confirmations.nominateReplacement.useMutation({
    onSuccess: (data) => {
      feedback.success(`${data.replacementName} foi notificado e tem 30 minutos para aceitar.`);
      router.replace("/(tabs)/agenda" as any);
    },
    onError: (err) => {
      feedback.error(err.message);
    },
  });

  const filtered = useMemo(() => {
    const list = professionals ?? [];
    const q = search.trim().toLocaleLowerCase("pt-BR");
    if (!q) return list;
    return list.filter((p) => p.name.toLocaleLowerCase("pt-BR").includes(q));
  }, [professionals, search]);

  const handleNominate = () => {
    if (!selectedId || !params.token) return;
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    nominateMutation.mutate({
      confirmationToken: params.token,
      replacementProfessionalId: selectedId,
    });
  };

  return (
    <ScreenGradient variant="light">
      <View style={{ flex: 1, paddingHorizontal: 20, paddingTop: 20 }}>
        <Text style={{ fontSize: 24, fontWeight: "800", color: theme.colors.textPrimary, marginBottom: 16 }}>
          Indicar Substituto
        </Text>

        <Text style={{ fontSize: 15, color: theme.colors.textSecondary, marginBottom: 16, lineHeight: 22 }}>
          Selecione o profissional que assumirá seu plantão. Ele receberá uma notificação para aceitar.
        </Text>

        <View style={{
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: theme.colors.surface,
          borderRadius: 12,
          paddingHorizontal: 12,
          marginBottom: 12,
          borderWidth: 1,
          borderColor: theme.colors.border,
        }}>
          <Search size={18} color={theme.colors.textSecondary} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Buscar profissional..."
            placeholderTextColor={theme.colors.textSecondary}
            style={{
              flex: 1,
              paddingVertical: 12,
              paddingHorizontal: 10,
              color: theme.colors.textPrimary,
              fontSize: 15,
            }}
          />
        </View>

        {isLoading ? (
          <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
          </View>
        ) : (
          <FlatList
            data={filtered}
            keyExtractor={(item) => String(item.id)}
            style={{ flex: 1, marginBottom: 16 }}
            renderItem={({ item }) => {
              const isSelected = selectedId === item.id;
              return (
                <TouchableOpacity
                  onPress={() => {
                    setSelectedId(isSelected ? null : item.id);
                    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }}
                  activeOpacity={0.7}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    padding: 14,
                    marginBottom: 8,
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: isSelected ? theme.colors.primary : theme.colors.border,
                    backgroundColor: isSelected ? `${theme.colors.primary}15` : theme.colors.surface,
                  }}
                >
                  <View style={{
                    width: 24,
                    height: 24,
                    borderRadius: 12,
                    borderWidth: 2,
                    borderColor: isSelected ? theme.colors.primary : theme.colors.textSecondary,
                    backgroundColor: isSelected ? theme.colors.primary : "transparent",
                    alignItems: "center",
                    justifyContent: "center",
                    marginRight: 12,
                  }}>
                    {isSelected && <Check size={14} color="#FFFFFF" />}
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 16, fontWeight: "600", color: theme.colors.textPrimary }}>
                      {item.name}
                    </Text>
                    <Text style={{ fontSize: 13, color: theme.colors.textSecondary }}>
                      {item.role}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            }}
            ListEmptyComponent={
              <Text style={{ color: theme.colors.textSecondary, textAlign: "center", paddingVertical: 24 }}>
                Nenhum profissional disponível para este plantão.
              </Text>
            }
          />
        )}

        <PrimaryButton
          label={nominateMutation.isPending ? "Enviando..." : "Indicar substituto"}
          icon={<UserPlus size={20} color="#FFFFFF" />}
          onPress={handleNominate}
          disabled={!selectedId || nominateMutation.isPending}
          loading={nominateMutation.isPending}
          style={{ marginBottom: 20 }}
        />
      </View>
    </ScreenGradient>
  );
}
