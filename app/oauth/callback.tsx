import { useEffect } from "react";
import { View, Text, ActivityIndicator } from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";

/**
 * OAuth callback route — handles redirect from Manus OAuth flow.
 * In standalone mode (outside Manus), this simply redirects to home.
 */
export default function OAuthCallback() {
  const router = useRouter();
  const params = useLocalSearchParams<{ code?: string; error?: string }>();

  useEffect(() => {
    // In standalone mode, just redirect to the main app
    const timer = setTimeout(() => {
      router.replace("/");
    }, 500);
    return () => clearTimeout(timer);
  }, [router, params]);

  return (
    <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
      <ActivityIndicator size="large" />
      <Text style={{ marginTop: 16, color: "#6B7280" }}>Autenticando...</Text>
    </View>
  );
}
