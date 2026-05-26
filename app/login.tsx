import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Image,
} from "react-native";
import { useRouter } from "expo-router";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { theme } from "@/lib/theme";
import { useAuth } from "@/hooks/use-auth";

const LABEL_STYLE = {
  fontSize: 11,
  fontWeight: "600" as const,
  color: theme.colors.textDisabled,
  letterSpacing: 1.5,
  textTransform: "uppercase" as const,
  marginBottom: 6,
};

const INPUT_STYLE = {
  backgroundColor: theme.palette.neutral[900],
  borderRadius: 10,
  borderWidth: 1.5,
  borderColor: theme.palette.neutral[400],
  paddingHorizontal: 16,
  paddingVertical: 14,
  fontSize: 16,
  color: theme.palette.neutral[50],
};

const INPUT_FOCUSED_STYLE = {
  ...INPUT_STYLE,
  borderColor: theme.colors.primary,
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
        <View style={{ flex: 1, justifyContent: "center", paddingHorizontal: 16 }}>

            {/* Logo / título */}
            <View style={{ alignItems: "center", marginBottom: 40 }}>
              <Image
                source={require("@/assets/images/logo.png")}
                style={{ width: 240, height: 100, marginBottom: 8 }}
                resizeMode="contain"
                accessibilityLabel="Escala+"
              />
              <Text
                style={{
                  fontSize: 15,
                  color: theme.colors.textMuted,
                  marginTop: 6,
                }}
              >
                Gestão de plantões hospitalares
              </Text>
            </View>

            {/* Card do formulário */}
            <View
              style={{
                backgroundColor: theme.palette.neutral[900],
                borderRadius: 20,
                borderWidth: 1,
                borderColor: theme.palette.neutral[400],
                padding: 28,
                gap: 16,
              }}
            >
              {/* Campo e-mail */}
              <View>
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
                  placeholderTextColor={theme.colors.textSecondary}
                  placeholder="seu@email.com"
                  style={focusedField === "email" ? INPUT_FOCUSED_STYLE : INPUT_STYLE}
                />
              </View>

              {/* Campo senha */}
              <View>
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
                  placeholderTextColor={theme.colors.textSecondary}
                  placeholder="••••••••"
                  style={focusedField === "password" ? INPUT_FOCUSED_STYLE : INPUT_STYLE}
                />
              </View>

              {/* Erro */}
              {errorMsg && (
                <View
                  style={{
                    backgroundColor: theme.colors.dangerSoft,
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: theme.colors.danger,
                    padding: 12,
                  }}
                >
                  <Text style={{ color: theme.palette.danger[100], fontSize: 14, textAlign: "center" }}>
                    {errorMsg}
                  </Text>
                </View>
              )}

              {/* Botão principal */}
              <TouchableOpacity
                onPress={handleLogin}
                activeOpacity={0.85}
                disabled={submitting}
                style={{
                  marginTop: 8,
                  backgroundColor: submitting ? theme.colors.primary : theme.colors.primary,
                  height: 52,
                  borderRadius: 12,
                  justifyContent: "center",
                  alignItems: "center",
                  width: "100%",
                  opacity: submitting ? 0.8 : 1,
                }}
              >
                {submitting ? (
                  <ActivityIndicator color={theme.colors.surface} />
                ) : (
                  <Text style={{ color: theme.colors.surface, fontSize: 17, fontWeight: "700", letterSpacing: 0.5 }}>
                    Entrar
                  </Text>
                )}
              </TouchableOpacity>

              {/* Modo Demo */}
              <TouchableOpacity
                onPress={() => router.replace("/(tabs)")}
                activeOpacity={0.7}
                style={{ alignSelf: "center", marginTop: 16 }}
              >
                <Text
                  style={{
                    fontSize: 13,
                    color: theme.colors.textMuted,
                    textDecorationLine: "underline",
                  }}
                >
                  Explorar em Modo Demo
                </Text>
              </TouchableOpacity>
            </View>

        </View>
      </KeyboardAvoidingView>
    </ScreenGradient>
  );
}

