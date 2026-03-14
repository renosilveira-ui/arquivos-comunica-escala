import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
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

const LABEL_STYLE = {
  fontSize: 11,
  fontWeight: "600" as const,
  color: "rgba(242,246,255,0.60)",
  letterSpacing: 1.2,
  textTransform: "uppercase" as const,
};

const INPUT_STYLE = {
  backgroundColor: "rgba(0,0,0,0.30)",
  borderRadius: 12,
  borderWidth: 1,
  borderColor: "rgba(255,255,255,0.28)",
  paddingHorizontal: 16,
  paddingVertical: 14,
  fontSize: 16,
  color: "#FFFFFF",
};

const INPUT_FOCUSED_STYLE = {
  ...INPUT_STYLE,
  borderColor: "#3B82F6",
};

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [focusedField, setFocusedField] = useState<"email" | "password" | null>(null);

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
              paddingHorizontal: 16,
            }}
          >
            {/* Logo / título */}
            <View style={{ alignItems: "center", marginBottom: 40 }}>
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
                borderColor: "rgba(255,255,255,0.15)",
                padding: 24,
                gap: 16,
              }}
            >
              {/* Campo e-mail */}
              <View style={{ gap: 6 }}>
                <Text style={LABEL_STYLE}>E-mail</Text>
                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="email"
                  returnKeyType="next"
                  onFocus={() => setFocusedField("email")}
                  onBlur={() => setFocusedField(null)}
                  placeholderTextColor="rgba(242,246,255,0.35)"
                  placeholder="seu@email.com"
                  style={focusedField === "email" ? INPUT_FOCUSED_STYLE : INPUT_STYLE}
                />
              </View>

              {/* Campo senha */}
              <View style={{ gap: 6 }}>
                <Text style={LABEL_STYLE}>Senha</Text>
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  autoComplete="current-password"
                  returnKeyType="done"
                  onFocus={() => setFocusedField("password")}
                  onBlur={() => setFocusedField(null)}
                  onSubmitEditing={handleLogin}
                  placeholderTextColor="rgba(242,246,255,0.35)"
                  placeholder="••••••••"
                  style={focusedField === "password" ? INPUT_FOCUSED_STYLE : INPUT_STYLE}
                />
              </View>

              {/* Erro */}
              {errorMsg && (
                <View
                  style={{
                    backgroundColor: "rgba(239,68,68,0.15)",
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: "rgba(239,68,68,0.35)",
                    padding: 12,
                  }}
                >
                  <Text style={{ color: "#FCA5A5", fontSize: 14, textAlign: "center" }}>
                    {errorMsg}
                  </Text>
                </View>
              )}

              {/* Botão principal */}
              <PrimaryButton
                label="Entrar"
                loading={submitting}
                disabled={submitting}
                onPress={handleLogin}
                style={{
                  marginTop: 4,
                  backgroundColor: "#3B82F6",
                  borderRadius: 14,
                  height: 52,
                }}
              />

              {/* Modo Demo */}
              <TouchableOpacity
                onPress={() => router.replace("/(tabs)")}
                activeOpacity={0.7}
                style={{ alignItems: "center", paddingTop: 4 }}
              >
                <Text
                  style={{
                    fontSize: 13,
                    color: "rgba(242,246,255,0.45)",
                    textDecorationLine: "underline",
                  }}
                >
                  Explorar em Modo Demo
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableWithoutFeedback>
      </KeyboardAvoidingView>
    </ScreenGradient>
  );
}
