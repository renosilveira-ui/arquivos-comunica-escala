// app/signup.tsx — auto-cadastro público (feat/self-signup)
//
// Qualquer profissional cria a própria conta escolhendo a instituição.
// A conta nasce PENDING: só opera depois que um administrador aprovar
// na aba Admin → Cadastros pendentes.

import { useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from "react-native";
import { useRouter } from "expo-router";
import { CheckCircle2 } from "lucide-react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { theme } from "@/lib/theme";
import { authApi } from "@/lib/_core/api";

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

type Field = "name" | "email" | "password" | "confirm";

export default function SignupScreen() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [institutionId, setInstitutionId] = useState<number | null>(null);
  const [institutions, setInstitutions] = useState<{ id: number; name: string }[]>([]);
  const [loadingInstitutions, setLoadingInstitutions] = useState(true);
  const [focusedField, setFocusedField] = useState<Field | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    authApi
      .listSignupInstitutions()
      .then((list) => {
        if (cancelled) return;
        setInstitutions(list);
        if (list.length === 1) setInstitutionId(list[0].id);
      })
      .finally(() => {
        if (!cancelled) setLoadingInstitutions(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSignup = async () => {
    if (!name.trim() || !email.trim() || !password || !confirm) {
      setErrorMsg("Preencha todos os campos.");
      return;
    }
    if (password.length < 8) {
      setErrorMsg("A senha deve ter pelo menos 8 caracteres.");
      return;
    }
    if (password !== confirm) {
      setErrorMsg("As senhas não coincidem.");
      return;
    }
    if (!institutionId) {
      setErrorMsg("Selecione a instituição onde você atua.");
      return;
    }
    setErrorMsg(null);
    setSubmitting(true);
    try {
      const result = await authApi.signup({
        name: name.trim(),
        email: email.trim(),
        password,
        institutionId,
        specialty: specialty.trim() || undefined,
      });
      if (result.ok) {
        setDone(true);
      } else {
        setErrorMsg(result.error ?? "Erro ao criar cadastro.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <ScreenGradient>
        <View style={{ flex: 1, justifyContent: "center", paddingHorizontal: 16 }}>
          <View
            style={{
              backgroundColor: theme.palette.neutral[900],
              borderRadius: 20,
              borderWidth: 1,
              borderColor: theme.palette.neutral[400],
              padding: 28,
              alignItems: "center",
              gap: 16,
            }}
          >
            <CheckCircle2 size={56} color={theme.colors.success} />
            <Text
              style={{
                fontSize: 20,
                fontWeight: "700",
                color: theme.palette.neutral[50],
                textAlign: "center",
              }}
            >
              Cadastro enviado
            </Text>
            <Text
              style={{
                fontSize: 14,
                color: theme.colors.textMuted,
                textAlign: "center",
                lineHeight: 20,
              }}
            >
              Sua conta foi criada e aguarda aprovação do gestor da instituição.
              Você poderá entrar assim que for aprovado.
            </Text>
            <TouchableOpacity
              onPress={() => router.replace("/login")}
              activeOpacity={0.85}
              style={{
                marginTop: 8,
                backgroundColor: theme.colors.primary,
                height: 52,
                borderRadius: 12,
                justifyContent: "center",
                alignItems: "center",
                width: "100%",
              }}
            >
              <Text
                style={{
                  color: theme.colors.surface,
                  fontSize: 17,
                  fontWeight: "700",
                  letterSpacing: 0.5,
                }}
              >
                Voltar ao login
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScreenGradient>
    );
  }

  return (
    <ScreenGradient>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: "center",
            paddingHorizontal: 16,
            paddingVertical: 32,
          }}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ alignItems: "center", marginBottom: 28 }}>
            <Text
              style={{
                fontSize: 24,
                fontWeight: "700",
                color: theme.palette.neutral[50],
              }}
            >
              Criar conta
            </Text>
            <Text style={{ fontSize: 14, color: theme.colors.textMuted, marginTop: 6 }}>
              Seu acesso será liberado após aprovação do gestor
            </Text>
          </View>

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
            <View>
              <Text style={LABEL_STYLE}>Nome completo</Text>
              <TextInput
                value={name}
                onChangeText={setName}
                autoComplete="name"
                returnKeyType="next"
                onFocus={() => setFocusedField("name")}
                onBlur={() => setFocusedField(null)}
                placeholderTextColor={theme.colors.onDark.textMuted}
                placeholder="Dr(a). Nome Sobrenome"
                style={focusedField === "name" ? INPUT_FOCUSED_STYLE : INPUT_STYLE}
              />
            </View>

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
                placeholderTextColor={theme.colors.onDark.textMuted}
                placeholder="seu@email.com"
                style={focusedField === "email" ? INPUT_FOCUSED_STYLE : INPUT_STYLE}
              />
            </View>

            <View>
              <Text style={LABEL_STYLE}>Senha</Text>
              <TextInput
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoComplete="new-password"
                returnKeyType="next"
                onFocus={() => setFocusedField("password")}
                onBlur={() => setFocusedField(null)}
                placeholderTextColor={theme.colors.onDark.textMuted}
                placeholder="Mínimo 8 caracteres"
                style={focusedField === "password" ? INPUT_FOCUSED_STYLE : INPUT_STYLE}
              />
            </View>

            <View>
              <Text style={LABEL_STYLE}>Confirmar senha</Text>
              <TextInput
                value={confirm}
                onChangeText={setConfirm}
                secureTextEntry
                autoComplete="new-password"
                returnKeyType="done"
                onFocus={() => setFocusedField("confirm")}
                onBlur={() => setFocusedField(null)}
                onSubmitEditing={handleSignup}
                placeholderTextColor={theme.colors.onDark.textMuted}
                placeholder="••••••••"
                style={focusedField === "confirm" ? INPUT_FOCUSED_STYLE : INPUT_STYLE}
              />
            </View>

            <View>
              <Text style={LABEL_STYLE}>Especialidade (opcional)</Text>
              <TextInput
                value={specialty}
                onChangeText={setSpecialty}
                returnKeyType="next"
                onFocus={() => setFocusedField(null)}
                placeholderTextColor={theme.colors.onDark.textMuted}
                placeholder="Ex.: Anestesiologia"
                style={INPUT_STYLE}
              />
            </View>

            <View>
              <Text style={LABEL_STYLE}>Instituição</Text>
              {loadingInstitutions ? (
                <ActivityIndicator color={theme.colors.primary} style={{ paddingVertical: 12 }} />
              ) : institutions.length === 0 ? (
                <Text style={{ color: theme.colors.textMuted, fontSize: 13 }}>
                  Nenhuma instituição disponível. Tente novamente mais tarde.
                </Text>
              ) : (
                <View style={{ gap: 8 }}>
                  {institutions.map((inst) => {
                    const selected = institutionId === inst.id;
                    return (
                      <TouchableOpacity
                        key={inst.id}
                        onPress={() => setInstitutionId(inst.id)}
                        activeOpacity={0.8}
                        style={{
                          borderRadius: 10,
                          borderWidth: 1.5,
                          borderColor: selected ? theme.colors.primary : theme.palette.neutral[400],
                          backgroundColor: selected
                            ? theme.colors.primarySoft
                            : theme.palette.neutral[900],
                          paddingHorizontal: 16,
                          paddingVertical: 14,
                        }}
                      >
                        <Text
                          style={{
                            fontSize: 15,
                            fontWeight: selected ? "700" : "500",
                            color: selected ? theme.colors.primary : theme.palette.neutral[50],
                          }}
                        >
                          {inst.name}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              )}
            </View>

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
                <Text
                  style={{ color: theme.palette.danger[600], fontSize: 14, textAlign: "center" }}
                >
                  {errorMsg}
                </Text>
              </View>
            )}

            <TouchableOpacity
              onPress={handleSignup}
              activeOpacity={0.85}
              disabled={submitting}
              style={{
                marginTop: 8,
                backgroundColor: theme.colors.primary,
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
                <Text
                  style={{
                    color: theme.colors.surface,
                    fontSize: 17,
                    fontWeight: "700",
                    letterSpacing: 0.5,
                  }}
                >
                  Criar conta
                </Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => router.replace("/login")}
              activeOpacity={0.7}
              style={{ alignSelf: "center", marginTop: 8 }}
            >
              <Text
                style={{
                  fontSize: 13,
                  color: theme.colors.textMuted,
                  textDecorationLine: "underline",
                }}
              >
                Já tenho conta — entrar
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </ScreenGradient>
  );
}
