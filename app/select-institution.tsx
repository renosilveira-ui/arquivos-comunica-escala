import { useMemo, useState } from "react";
import { ActivityIndicator, Text, TouchableOpacity, View } from "react-native";
import { useRouter } from "expo-router";
import { Building2, Check } from "lucide-react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { trpc } from "@/lib/trpc";
import { useTenantState } from "@/lib/tenant-state";
import { theme } from "@/lib/theme";

export default function SelectInstitutionScreen() {
  const router = useRouter();
  const utils = trpc.useUtils();
  const { activeInstitutionId, setActiveInstitutionId } = useTenantState();
  const [isSubmitting, setIsSubmitting] = useState<number | null>(null);

  const { data: institutions, isLoading } = trpc.professionals.listMyInstitutions.useQuery();

  const orderedInstitutions = useMemo(() => {
    return [...(institutions ?? [])].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  }, [institutions]);

  const handleSelect = async (institutionId: number) => {
    if (isSubmitting) return;
    setIsSubmitting(institutionId);
    try {
      await setActiveInstitutionId(institutionId);
      await utils.invalidate();
      router.replace("/(tabs)");
    } finally {
      setIsSubmitting(null);
    }
  };

  return (
    <ScreenGradient>
      <View className="flex-1 px-5 py-6">
        <View className="mb-8">
          <Text style={{ fontSize: 30, fontWeight: "800", color: theme.palette.neutral[900] }}>Selecionar Instituição</Text>
          <Text style={{ fontSize: 15, color: theme.colors.textSecondary, marginTop: 6 }}>
            Escolha a instituição ativa para carregar dados e permissões.
          </Text>
        </View>

        {isLoading ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="large" color={theme.colors.primary} />
            <Text style={{ color: theme.colors.textSecondary, marginTop: 12 }}>Carregando instituições...</Text>
          </View>
        ) : (
          <View className="gap-3">
            {orderedInstitutions.map((institution) => {
              const selected = activeInstitutionId === institution.id;
              const submitting = isSubmitting === institution.id;
              return (
                <TouchableOpacity
                  key={institution.id}
                  onPress={() => handleSelect(institution.id)}
                  activeOpacity={0.82}
                  disabled={Boolean(isSubmitting)}
                  style={{
                    borderWidth: 1.5,
                    borderColor: selected ? theme.palette.primary[700] : theme.colors.border,
                    borderRadius: 14,
                    backgroundColor: selected ? theme.colors.primarySoft : theme.colors.surface,
                    paddingHorizontal: 14,
                    paddingVertical: 14,
                    opacity: isSubmitting && !submitting ? 0.65 : 1,
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}>
                      <Building2 size={20} color={selected ? theme.palette.primary[700] : theme.palette.neutral[700]} />
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: theme.palette.neutral[900], fontSize: 17, fontWeight: "700" }}>
                          {institution.name}
                        </Text>
                        <Text style={{ color: theme.colors.textMuted, fontSize: 12, marginTop: 2 }}>
                          {institution.roleInInstitution}
                          {institution.isPrimary ? " • principal" : ""}
                        </Text>
                      </View>
                    </View>

                    {submitting ? (
                      <ActivityIndicator size="small" color={theme.palette.primary[700]} />
                    ) : selected ? (
                      <Check size={18} color={theme.palette.primary[700]} />
                    ) : null}
                  </View>
                </TouchableOpacity>
              );
            })}

            {(orderedInstitutions?.length ?? 0) === 0 && (
              <View className="rounded-xl border border-slate-200 bg-white p-4">
                <Text style={{ color: theme.palette.neutral[700], fontWeight: "600" }}>Nenhuma instituição ativa</Text>
                <Text style={{ color: theme.colors.textMuted, marginTop: 4 }}>
                  Solicite ao administrador o vínculo da sua conta a uma instituição.
                </Text>
              </View>
            )}
          </View>
        )}
      </View>
    </ScreenGradient>
  );
}
