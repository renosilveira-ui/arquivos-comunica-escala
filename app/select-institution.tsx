import { trpc } from "@/lib/trpc";
import { useTenantState } from "@/lib/tenant-state";
import { router } from "expo-router";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

export default function SelectInstitutionScreen() {
  const { activeInstitutionId, setActiveInstitutionId } = useTenantState();
  const { data, isLoading } = trpc.professionals.listInstitutions.useQuery();

  const institutions = data ?? [];

  if (isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: "#0a1929", justifyContent: "center", alignItems: "center" }}>
        <ActivityIndicator color="#4DA3FF" size="large" />
      </View>
    );
  }

  if (institutions.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: "#0a1929", padding: 24, justifyContent: "center" }}>
        <Text style={{ color: "#F1F5F9", fontSize: 22, fontWeight: "700", marginBottom: 10 }}>
          Sem Vínculo Institucional
        </Text>
        <Text style={{ color: "#94A3B8", fontSize: 16 }}>
          Seu usuário não possui vínculo ativo com nenhuma instituição.
        </Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: "#0a1929", padding: 20, justifyContent: "center" }}>
      <Text style={{ color: "#F1F5F9", fontSize: 26, fontWeight: "700", marginBottom: 8 }}>
        Escolha seu Hospital
      </Text>
      <Text style={{ color: "#94A3B8", fontSize: 16, marginBottom: 24 }}>
        Selecione a instituição ativa para carregar Agenda e Escalas com isolamento de tenant.
      </Text>

      {institutions.map((institution) => {
        const isActive = institution.institutionId === activeInstitutionId;
        return (
          <Pressable
            key={institution.institutionId}
            onPress={async () => {
              await setActiveInstitutionId(institution.institutionId);
              router.replace("/(tabs)");
            }}
            style={{
              borderWidth: 1,
              borderColor: isActive ? "#3B82F6" : "#1F2A37",
              backgroundColor: isActive ? "#122A4A" : "#10213A",
              borderRadius: 14,
              padding: 16,
              marginBottom: 12,
            }}
          >
            <Text style={{ color: "#F1F5F9", fontSize: 18, fontWeight: "600" }}>
              {institution.name}
            </Text>
            <Text style={{ color: "#93C5FD", marginTop: 4 }}>
              {institution.roleInInstitution}
              {institution.isPrimary ? " • Principal" : ""}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
