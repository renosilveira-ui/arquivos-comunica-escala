// app/forgot-password.tsx — "Esqueci minha senha" (frente A3).
//
// Pede só o e-mail e mostra SEMPRE a mesma mensagem neutra — o servidor
// responde 200 exista ou não a conta (sem enumeração). O link de
// redefinição chega por e-mail (ou no log do servidor em dev/staging
// sem RESEND_API_KEY) e abre /reset-password?token=...

import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useRouter } from "expo-router";
import { ChevronLeft, MailCheck } from "lucide-react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { theme } from "@/lib/theme";
import { authApi } from "@/lib/_core/api";

const LABEL_STYLE = {
  ...theme.text.caption,
  fontWeight: theme.weight.semibold,
  color: theme.colors.textDisabled,
  textTransform: "uppercase" as const,
  marginBottom: theme.space[2],
};

const INPUT_STYLE = {
  backgroundColor: theme.palette.neutral[900],
  borderRadius: theme.radius.lg,
  borderWidth: 1.5,
  borderColor: theme.palette.neutral[400],
  paddingHorizontal: theme.space[4],
  paddingVertical: theme.space[3],
  ...theme.text.bodyLg,
  color: theme.palette.neutral[50],
};

const INPUT_FOCUSED_STYLE = { ...INPUT_STYLE, borderColor: theme.colors.primary };

export default function ForgotPasswordScreen() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [focused, setFocused] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handleSubmit = async () => {
    const value = email.trim();
    if (!value || !value.includes("@")) {
      setErrorMsg("Informe um e-mail válido.");
      return;
    }
    setErrorMsg(null);
    setSubmitting(true);
    try {
      const result = await authApi.forgotPassword(value.toLowerCase());
      if (!result.ok) {
        // Só falha de rede/servidor chega aqui — o servidor nunca revela
        // se a conta existe.
        setErrorMsg(result.error ?? "Não foi possível enviar o pedido. Tente novamente.");
        return;
      }
      setDone(true);
    } finally {
      setSubmitting(false);
    }
  };

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace("/login");
  };

  return (
    <ScreenGradient>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <View style={{ flex: 1, justifyContent: "center", paddingHorizontal: theme.space[4] }}>
          <View
            style={{
              backgroundColor: theme.palette.neutral[900],
              borderRadius: theme.radius.xl,
              borderWidth: 1,
              borderColor: theme.palette.neutral[400],
              padding: theme.space[6],
              gap: theme.space[4],
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[2] }}>
              <TouchableOpacity
                onPress={goBack}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel="Voltar para o login"
              >
                <ChevronLeft size={26} color={theme.colors.onDark.text} />
              </TouchableOpacity>
              <Text
                style={{
                  ...theme.text.titleLg,
                  fontWeight: theme.weight.bold,
                  color: theme.colors.onDark.text,
                }}
              >
                Esqueci minha senha
              </Text>
            </View>

            {done ? (
              <View style={{ alignItems: "center", gap: theme.space[3], paddingVertical: theme.space[2] }}>
                <MailCheck size={48} color={theme.colors.success} />
                <Text
                  style={{
                    ...theme.text.bodyLg,
                    color: theme.colors.onDark.text,
                    textAlign: "center",
                  }}
                >
                  Se existir uma conta com esse e-mail, enviamos as instruções.
                </Text>
                <Text
                  style={{
                    ...theme.text.body,
                    color: theme.colors.onDark.textMuted,
                    textAlign: "center",
                  }}
                >
                  O link vale por 30 minutos. Confira também a caixa de spam.
                </Text>
                <TouchableOpacity
                  onPress={() => router.replace("/login")}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  style={{
                    marginTop: theme.space[2],
                    backgroundColor: theme.colors.primary,
                    height: theme.space[14] - theme.space[1],
                    borderRadius: theme.radius.lg,
                    justifyContent: "center",
                    alignItems: "center",
                    width: "100%",
                  }}
                >
                  <Text
                    style={{
                      ...theme.text.bodyLg,
                      fontWeight: theme.weight.bold,
                      color: theme.colors.surface,
                    }}
                  >
                    Voltar ao login
                  </Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <Text style={{ ...theme.text.body, color: theme.colors.onDark.textMuted }}>
                  Informe o e-mail da sua conta. Enviaremos um link para você escolher uma nova senha.
                </Text>

                <View>
                  <Text style={LABEL_STYLE}>E-mail</Text>
                  <TextInput
                    value={email}
                    onChangeText={setEmail}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoComplete="email"
                    autoFocus
                    returnKeyType="send"
                    onSubmitEditing={handleSubmit}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                    placeholderTextColor={theme.colors.onDark.textMuted}
                    placeholder="seu@email.com"
                    style={focused ? INPUT_FOCUSED_STYLE : INPUT_STYLE}
                  />
                </View>

                {errorMsg ? (
                  <View
                    style={{
                      backgroundColor: theme.colors.dangerSoft,
                      borderRadius: theme.radius.lg,
                      borderWidth: 1,
                      borderColor: theme.colors.danger,
                      padding: theme.space[3],
                    }}
                  >
                    <Text
                      style={{
                        ...theme.text.body,
                        color: theme.palette.danger[600],
                        textAlign: "center",
                      }}
                    >
                      {errorMsg}
                    </Text>
                  </View>
                ) : null}

                <TouchableOpacity
                  onPress={handleSubmit}
                  activeOpacity={0.85}
                  disabled={submitting}
                  accessibilityRole="button"
                  accessibilityLabel="Enviar link de redefinição"
                  style={{
                    marginTop: theme.space[2],
                    backgroundColor: theme.colors.primary,
                    height: theme.space[14] - theme.space[1],
                    borderRadius: theme.radius.lg,
                    justifyContent: "center",
                    alignItems: "center",
                    width: "100%",
                    opacity: submitting ? 0.8 : 1,
                  }}
                >
                  {submitting ? (
                    <ActivityIndicator color={theme.colors.surface} />
                  ) : (
                    <Text
                      style={{
                        ...theme.text.bodyLg,
                        fontWeight: theme.weight.bold,
                        color: theme.colors.surface,
                      }}
                    >
                      Enviar link
                    </Text>
                  )}
                </TouchableOpacity>
              </>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </ScreenGradient>
  );
}
