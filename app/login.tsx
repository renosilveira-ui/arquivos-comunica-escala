// app/login.tsx — primeira impressão do produto.
//
// Antes: card ESCURO (neutral.900) sobre o gradiente claro — o único ponto
// escuro do app, com literais de tamanho/raio/cor. Agora: a mesma
// linguagem do resto (Surface raised, tokens de texto, AppButton), foco
// visível nos campos, erro em tom danger e alvos ≥ 44pt.

import { useState } from "react";
import { Image, KeyboardAvoidingView, Platform, Pressable, View } from "react-native";
import { Text, TextInput } from "@/components/ui/Text";
import { useRouter } from "expo-router";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { Surface, tonedText } from "@/components/ui/Surface";
import { AppButton } from "@/components/ui/AppButton";
import type { Href } from "expo-router";
import {
  pendingDestinationNotice,
  peekIntendedRoute,
  takeIntendedRoute,
} from "@/lib/post-login-redirect";
import { theme } from "@/lib/theme";
import { useAuth } from "@/hooks/use-auth";

type Field = "email" | "password";

export default function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Lido uma vez: o destino é armado pelo guard ANTES desta tela montar e
  // não muda enquanto ela está aberta. Ler no render chamaria o módulo a
  // cada tecla digitada no formulário.
  const [notice] = useState(() => pendingDestinationNotice(peekIntendedRoute()));
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
      const result = await login(email.trim(), password.trim());
      if (result.ok || result.admissionPending) {
        // Rota calculada em runtime não tem como satisfazer typedRoutes. O
        // que a torna segura é isSafeInternalRoute, não o tipo; `Href` diz o
        // que a string é, em vez de fingir que é uma rota específica.
        const intended = takeIntendedRoute();
        router.replace((intended ?? "/(tabs)") as Href);
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
              // Wordmark 1435×865 (≈1.66:1) com fundo transparente — sem caixa
              // branca sobre o gradiente.
              style={{ width: 256, height: 154 }}
              resizeMode="contain"
              accessibilityLabel="Escala+"
            />
            <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>Gestão de plantões hospitalares</Text>
          </View>

          {/* Quem chegou por um link de convite tocou no link certo. Sem este
              aviso, a tela de login é idêntica a qualquer outra e parece que o
              link não funcionou. */}
          {notice ? (
            <Surface level="card" tone="primary" padded="compact">
              <Text
                accessibilityRole="header"
                style={{
                  ...theme.text.titleSm,
                  color: tonedText("primary").strong,
                }}
              >
                {notice.title}
              </Text>
              <Text
                style={{
                  ...theme.text.body,
                  color: tonedText("primary").soft,
                  marginTop: theme.space[1],
                }}
              >
                {notice.body}
              </Text>
            </Surface>
          ) : null}

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
        </View>
      </KeyboardAvoidingView>
    </ScreenGradient>
  );
}
