import { View, Text, Platform } from "react-native";
import { useTestUserId } from "@/hooks/use-test-user-id";
import { useAuth } from "@/hooks/use-auth";
import { trpc } from "@/lib/trpc";

/**
 * Badge de diagnóstico para modo de teste
 * Mostra todas as variáveis relevantes para debug
 * Apenas visível em preview/manus (.manus.computer)
 */
export function DiagnosticBadge() {
  const testUserId = useTestUserId();
  const { user } = useAuth();
  
  // Buscar profissional se testUserId presente
  const { data: professional } = trpc.professionals.getByUserId.useQuery(
    { userId: testUserId || 0 },
    { enabled: testUserId !== null }
  );

  // Apenas mostrar em web
  if (Platform.OS !== "web") {
    return null;
  }

  // Verificar variáveis de ambiente
  const nextPublicEnabled = process.env.NEXT_PUBLIC_ENABLE_TEST_MODE;
  const expoPublicEnabled = process.env.EXPO_PUBLIC_ENABLE_TEST_MODE;
  const nodeEnv = process.env.NODE_ENV;
  
  // Verificar hostname
  const hostname = typeof window !== "undefined" ? window.location.hostname : "unknown";
  const isManusPreview = hostname.endsWith(".manus.computer");

  // Calcular se modo de teste está ativo
  const enableTestMode = 
    nextPublicEnabled === "true" || 
    expoPublicEnabled === "true" ||
    isManusPreview;

  return (
    <View className="bg-yellow-500 p-3 mb-2 rounded-lg">
      <Text className="text-xs font-bold text-black mb-2">🩺 DIAGNÓSTICO DO MODO DE TESTE</Text>
      
      <View className="gap-1">
        <Text className="text-xs text-black">
          <Text className="font-bold">enableTestMode:</Text> {enableTestMode ? "✅ true" : "❌ false"}
        </Text>
        
        <Text className="text-xs text-black">
          <Text className="font-bold">testUserId:</Text> {testUserId !== null ? `✅ ${testUserId}` : "❌ none"}
        </Text>
        
        <Text className="text-xs text-black">
          <Text className="font-bold">user.id:</Text> {user?.id || "❌ none"}
        </Text>
        
        <Text className="text-xs text-black">
          <Text className="font-bold">professional:</Text> {professional ? `✅ ${professional.name} (${professional.userRole})` : "❌ none"}
        </Text>
        
        <Text className="text-xs text-black">
          <Text className="font-bold">hostname:</Text> {hostname}
        </Text>
        
        <Text className="text-xs text-black">
          <Text className="font-bold">isManusPreview:</Text> {isManusPreview ? "✅ true" : "❌ false"}
        </Text>
        
        <Text className="text-xs text-black">
          <Text className="font-bold">NODE_ENV:</Text> {nodeEnv || "undefined"}
        </Text>
        
        <Text className="text-xs text-black">
          <Text className="font-bold">NEXT_PUBLIC_ENABLE_TEST_MODE:</Text> {nextPublicEnabled || "undefined"}
        </Text>
        
        <Text className="text-xs text-black">
          <Text className="font-bold">EXPO_PUBLIC_ENABLE_TEST_MODE:</Text> {expoPublicEnabled || "undefined"}
        </Text>
      </View>
    </View>
  );
}
