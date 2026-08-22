// app/login.tsx — primeira impressão do produto.
//
// Antes: card ESCURO (neutral.900) sobre o gradiente claro — o único ponto
// escuro do app, com literais de tamanho/raio/cor. Agora: a mesma
// linguagem do resto (Surface raised, tokens de texto, AppButton), foco
// visível nos campos, erro em tom danger e alvos ≥ 44pt.

import { useState } from "react";
import { Image, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { Surface } from "@/components/ui/Surface";
import { AppButton } from "@/components/ui/AppButton";
import { theme } from "@/lib/theme";
import { useAuth } from "@/hooks/use-auth";

type Field = "email" | "password";

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [focused, setFocused] = useState<Field | null>(null);

  const { login } = useAuth();
  const router = useRouter();

  const handleLogin = async () => {
    if (!email.trim() || !password.trim()) {
      setErrorMsg("Informe e-mail e senha para entrar.");
      return;
    }
    setErrorMsg(null);
    setSubmitting(true);
    try {
      const result = await login(email.trim(), password);
      if (result.ok) {
        router.replace("/(tabs)");
      } else {
        setErrorMsg(result.error ?? "E-mail ou senha incorretos.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const inputStyle = (field: Field) => ({
    minHeight: theme.space[10] + theme.space[1],
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: focused === field ? 2 : 1,
    borderColor: focused === field ? theme.colors.primary : theme.colors.borderStrong,
    paddingHorizontal: theme.space[4],
    paddingVertical: theme.space[3],
    ...theme.text.bodyLg,
    color: theme.colors.textPrimary,
  });

  const labelStyle = {
    ...theme.text.eyebrow,
    fontWeight: theme.weight.bold,
    textTransform: "uppercase" as const,
    color: theme.colors.textSecondary,
    marginBottom: theme.space[2],
  };

  return (
    <ScreenGradient>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <View
          style={{
            flex: 1,
            justifyContent: "center",
            width: "100%",
            maxWidth: theme.spacing.contentMaxWidth / 3,
            alignSelf: "center",
            gap: theme.space[8],
          }}
        >
          <View style={{ alignItems: "center", gap: theme.space[2] }}>
            <Image
              source={require("@/assets/images/logo.png")}
              style={{ width: 240, height: 100 }}
              resizeMode="contain"
              accessibilityLabel="Escala+"
            />
            <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>Gestão de plantões hospitalares</Text>
          </View>

          <Surface level="raised" style={{ padding: theme.space[6] }}>
            <View style={{ gap: theme.space[5] }}>
              <View>
                <Text style={labelStyle}>E-mail</Text>
                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="email"
                  textContentType="emailAddress"
                  returnKeyType="next"
                  onFocus={() => setFocused("email")}
                  onBlur={() => setFocused(null)}
                  placeholder="seu@email.com"
                  placeholderTextColor={theme.colors.textDisabled}
                  accessibilityLabel="E-mail"
                  style={inputStyle("email")}
                />
              </View>

              <View>
                <Text style={labelStyle}>Senha</Text>
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry
                  autoComplete="current-password"
                  textContentType="password"
                  returnKeyType="done"
                  onFocus={() => setFocused("password")}
                  onBlur={() => setFocused(null)}
                  onSubmitEditing={handleLogin}
                  placeholder="••••••••"
                  placeholderTextColor={theme.colors.textDisabled}
                  accessibilityLabel="Senha"
                  style={inputStyle("password")}
                />
              </View>

              {errorMsg ? (
                <Surface level="card" tone="danger" padded="compact">
                  <Text
                    accessibilityLiveRegion="polite"
                    style={{ ...theme.text.body, color: theme.palette.danger[900], textAlign: "center" }}
                  >
                    {errorMsg}
                  </Text>
                </Surface>
              ) : null}

              <AppButton title={submitting ? "Entrando…" : "Entrar"} onPress={handleLogin} disabled={submitting} size="lg" />

              <View style={{ alignItems: "center", gap: theme.space[3] }}>
                <Pressable
                  onPress={() => router.push("/forgot-password" as any)}
                  accessibilityRole="link"
                  accessibilityLabel="Esqueci minha senha"
                  hitSlop={8}
                  style={{ minHeight: theme.space[10], justifyContent: "center" }}
                >
                  <Text style={{ ...theme.text.body, fontWeight: theme.weight.semibold, color: theme.colors.primary }}>
                    Esqueci minha senha
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => router.push("/signup" as any)}
                  accessibilityRole="link"
                  accessibilityLabel="Criar conta"
                  hitSlop={8}
                  style={{ minHeight: theme.space[10], justifyContent: "center" }}
                >
                  <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
                    Não tem conta?{" "}
                    <Text style={{ fontWeight: theme.weight.semibold, color: theme.colors.primary }}>Criar conta</Text>
                  </Text>
                </Pressable>
              </View>
            </View>
          </Surface>

          <Pressable
            onPress={() => router.replace("/(tabs)")}
            accessibilityRole="link"
            accessibilityLabel="Explorar em modo demonstração"
            hitSlop={8}
            style={{ alignSelf: "center", minHeight: theme.space[10], justifyContent: "center" }}
          >
            <Text style={{ ...theme.text.caption, color: theme.colors.textMuted, textDecorationLine: "underline" }}>
              Explorar em modo demonstração
            </Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </ScreenGradient>
  );
}
