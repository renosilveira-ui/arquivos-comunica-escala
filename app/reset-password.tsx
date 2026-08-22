// app/reset-password.tsx — nova senha a partir do link do e-mail (frente A3).
//
// Lê ?token= da URL (web) ou do deep link (escalas://reset-password?token=).
// Sem token, explica e oferece pedir um novo link. Sucesso → login.

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
import { useLocalSearchParams, useRouter } from "expo-router";
import { CheckCircle2, KeyRound } from "lucide-react-native";
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

const BUTTON_STYLE = {
  marginTop: theme.space[2],
  backgroundColor: theme.colors.primary,
  height: theme.space[14] - theme.space[1],
  borderRadius: theme.radius.lg,
  justifyContent: "center" as const,
  alignItems: "center" as const,
  width: "100%" as const,
};

const BUTTON_TEXT_STYLE = {
  ...theme.text.bodyLg,
  fontWeight: theme.weight.bold,
  color: theme.colors.surface,
};

export default function ResetPasswordScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const rawToken = Array.isArray(params.token) ? params.token[0] : params.token;
  const token = (rawToken ?? "").trim();

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [focused, setFocused] = useState<"password" | "confirm" | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const handleSubmit = async () => {
    if (!password || !confirm) {
      setErrorMsg("Preencha os dois campos.");
      return;
    }
    if (password.length < 8) {
      setErrorMsg("A nova senha precisa ter ao menos 8 caracteres.");
      return;
    }
    if (password !== confirm) {
      setErrorMsg("A confirmação não bate com a nova senha.");
      return;
    }
    setErrorMsg(null);
    setSubmitting(true);
    try {
      const result = await authApi.resetPassword(token, password);
      if (!result.ok) {
        setErrorMsg(result.error ?? "Erro ao redefinir senha.");
        return;
      }
      setDone(true);
    } finally {
      setSubmitting(false);
    }
  };

  const renderBody = () => {
    if (!token) {
      return (
        <>
          <Text style={{ ...theme.text.bodyLg, color: theme.colors.onDark.text }}>
            Este link não tem um código de redefinição.
          </Text>
          <Text style={{ ...theme.text.body, color: theme.colors.onDark.textMuted }}>
            Abra o link exatamente como veio no e-mail ou peça um novo.
          </Text>
          <TouchableOpacity
            onPress={() => router.replace("/forgot-password" as any)}
            activeOpacity={0.85}
            accessibilityRole="button"
            style={BUTTON_STYLE}
          >
            <Text style={BUTTON_TEXT_STYLE}>Pedir novo link</Text>
          </TouchableOpacity>
        </>
      );
    }

    if (done) {
      return (
        <View style={{ alignItems: "center", gap: theme.space[3], paddingVertical: theme.space[2] }}>
          <CheckCircle2 size={48} color={theme.colors.success} />
          <Text
            style={{ ...theme.text.bodyLg, color: theme.colors.onDark.text, textAlign: "center" }}
          >
            Senha redefinida com sucesso.
          </Text>
          <Text
            style={{ ...theme.text.body, color: theme.colors.onDark.textMuted, textAlign: "center" }}
          >
            Entre com a nova senha para continuar.
          </Text>
          <TouchableOpacity
            onPress={() => router.replace("/login")}
            activeOpacity={0.85}
            accessibilityRole="button"
            style={BUTTON_STYLE}
          >
            <Text style={BUTTON_TEXT_STYLE}>Ir para o login</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return (
      <>
        <Text style={{ ...theme.text.body, color: theme.colors.onDark.textMuted }}>
          Escolha uma nova senha com pelo menos 8 caracteres.
        </Text>

        <View>
          <Text style={LABEL_STYLE}>Nova senha</Text>
          <TextInput
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="new-password"
            autoFocus
            returnKeyType="next"
            onFocus={() => setFocused("password")}
            onBlur={() => setFocused(null)}
            placeholderTextColor={theme.colors.onDark.textMuted}
            placeholder="Mínimo 8 caracteres"
            style={focused === "password" ? INPUT_FOCUSED_STYLE : INPUT_STYLE}
          />
        </View>

        <View>
          <Text style={LABEL_STYLE}>Confirmar nova senha</Text>
          <TextInput
            value={confirm}
            onChangeText={setConfirm}
            secureTextEntry
            autoComplete="new-password"
            returnKeyType="done"
            onSubmitEditing={handleSubmit}
            onFocus={() => setFocused("confirm")}
            onBlur={() => setFocused(null)}
            placeholderTextColor={theme.colors.onDark.textMuted}
            placeholder="Repita a nova senha"
            style={focused === "confirm" ? INPUT_FOCUSED_STYLE : INPUT_STYLE}
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
              style={{ ...theme.text.body, color: theme.palette.danger[600], textAlign: "center" }}
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
          accessibilityLabel="Salvar nova senha"
          style={{ ...BUTTON_STYLE, opacity: submitting ? 0.8 : 1 }}
        >
          {submitting ? (
            <ActivityIndicator color={theme.colors.surface} />
          ) : (
            <Text style={BUTTON_TEXT_STYLE}>Salvar nova senha</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => router.replace("/forgot-password" as any)}
          activeOpacity={0.7}
          accessibilityRole="button"
          style={{ alignSelf: "center", marginTop: theme.space[1] }}
        >
          <Text
            style={{
              ...theme.text.body,
              color: theme.colors.onDark.textMuted,
              textDecorationLine: "underline",
            }}
          >
            Link expirou? Pedir outro
          </Text>
        </TouchableOpacity>
      </>
    );
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
              <KeyRound size={24} color={theme.colors.onDark.text} />
              <Text
                style={{
                  ...theme.text.titleLg,
                  fontWeight: theme.weight.bold,
                  color: theme.colors.onDark.text,
                }}
              >
                Nova senha
              </Text>
            </View>
            {renderBody()}
          </View>
        </View>
      </KeyboardAvoidingView>
    </ScreenGradient>
  );
}
