import { View, Text } from "react-native";
import { useTestUserId } from "@/hooks/use-test-user-id";
import { trpc } from "@/lib/trpc";
import Constants from "expo-constants";

/**
 * Badge visual que aparece apenas em dev/test quando testUserId está ativo
 * 
 * Mostra: "🧪 TEST USER: [Nome do Profissional]"
 */
export function TestUserBadge() {
  const testUserId = useTestUserId();
  
  // Bloquear totalmente em produção
  const nodeEnv = Constants.expoConfig?.extra?.NODE_ENV || process.env.NODE_ENV;
  if (nodeEnv === "production" || testUserId === null) {
    return null;
  }

  return <TestUserBadgeInner testUserId={testUserId} />;
}

function TestUserBadgeInner({ testUserId }: { testUserId: number }) {
  const { data: professional, isLoading } = trpc.professionals.getByUserId.useQuery(
    { userId: testUserId },
    { enabled: testUserId !== null }
  );

  if (isLoading || !professional) {
    return (
      <View className="bg-warning/20 border border-warning px-3 py-1.5 rounded-full">
        <Text className="text-warning text-sm font-semibold">
          🧪 TEST USER: Carregando...
        </Text>
      </View>
    );
  }

  const roleLabel = {
    USER: "Usuário",
    GESTOR_MEDICO: "Gestor Médico",
    GESTOR_PLUS: "Gestor Plus",
  }[professional.userRole] || professional.userRole;

  return (
    <View className="bg-warning/20 border border-warning px-3 py-1.5 rounded-full">
      <Text className="text-warning text-sm font-semibold">
        🧪 TEST: {professional.name} ({roleLabel})
      </Text>
    </View>
  );
}
