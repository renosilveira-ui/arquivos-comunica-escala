import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  TouchableWithoutFeedback,
  Keyboard,
} from "react-native";
import { useRouter } from "expo-router";
import { Activity } from "lucide-react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { PrimaryButton } from "@/components/ui/PrimaryButton";
import { useAuth } from "@/hooks/use-auth";

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const { login } = useAuth();
  const router = useRouter();

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) {
      setErrorMsg("Preencha email e senha.");
      return;
    }
    setErrorMsg(null);
    setSubmitting(true);
    try {
      const result = await login(email.trim(), password);
      if (result.ok) {
        router.replace("/(tabs)");
      } else {
        setErrorMsg(result.error ?? "Credenciais inválidas.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScreenGradient>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
          <View
            style={{
              flex: 1,
              justifyContent: "center",
              paddingHorizontal: 4,
            }}
          >
            {/* Logo / título */}
            <View
              style={{ alignItems: "center", marginBottom: 40 }}
            >
              <Activity size={56} color="#4DA3FF" strokeWidth={1.5} />
              <Text
                style={{
                  fontSize: 28,
                  fontWeight: "800",
                  color: "#FFFFFF",
                  marginTop: 16,
                  letterSpacing: -0.5,
                }}
              >
                Comunica+ Escalas
              </Text>
              <Text
                style={{
                  fontSize: 15,
                  color: "rgba(242,246,255,0.60)",
                  marginTop: 6,
                }}
              >
                Gestão de plantões hospitalares
              </Text>
            </View>

            {/* Formulário */}
            <View
              style={{
                backgroundColor: "rgba(255,255,255,0.08)",
                borderRadius: 20,
                borderWidth: 1,
                borderColor: "rgba(255,255,255,0.12)",
                padding: 24,
                gap: 16,
              }}
            >
              <View style={{ gap: 8 }}>
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: "600",
                    color: "rgba(242,246,255,0.70)",
                    letterSpacing: 0.5,
                    textTransform: "uppercase",
                  }}
                >
                  Email
                </Text>
                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="email"
                  returnKeyType="next"
                  placeholderTextColor="rgba(242,246,255,0.30)"
                  placeholder="seu@email.com"
                  style={{
                    backgroundColor: "rgba(255,255,255,0.06)",
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: "rgba(255,255,255,0.15)",
                    paddingHorizontal: 16,
                    paddingVertical: 14,
                    fontSize: 16,
                    color: "#FFFFFF",
                  }}
                />
              </View>

              <View style={{ gap: 8 }}>
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: "600",
                    color: "rgba(242,246,255,0.70)",
                    letterSpacing: 0.5,
                    textTransform: "uppercase",
                  }}
                >
                  Senha
                </Text>
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  autoComplete="current-password"
                  returnKeyType="done"
                  onSubmitEditing={handleLogin}
                  placeholderTextColor="rgba(242,246,255,0.30)"
                  placeholder="••••••••"
                  style={{
                    backgroundColor: "rgba(255,255,255,0.06)",
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: "rgba(255,255,255,0.15)",
                    paddingHorizontal: 16,
                    paddingVertical: 14,
                    fontSize: 16,
                    color: "#FFFFFF",
                  }}
                />
              </View>

              {errorMsg && (
                <View
                  style={{
                    backgroundColor: "rgba(239,68,68,0.15)",
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: "rgba(239,68,68,0.30)",
                    padding: 12,
                  }}
                >
                  <Text
                    style={{ color: "#FCA5A5", fontSize: 14, textAlign: "center" }}
                  >
                    {errorMsg}
                  </Text>
                </View>
              )}

              <PrimaryButton
                label="Entrar"
                loading={submitting}
                disabled={submitting}
                onPress={handleLogin}
                style={{ marginTop: 4 }}
              />
            </View>
          </View>
        </TouchableWithoutFeedback>
      </KeyboardAvoidingView>
    </ScreenGradient>
  );
}
