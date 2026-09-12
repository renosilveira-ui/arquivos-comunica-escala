import { ProfessionPicker } from "@/components/ProfessionPicker";
import {
  getProfessionDefinition,
  type ProfessionCode,
} from "@/lib/profession-definitions";
// app/signup.tsx — auto-cadastro público.
//
// O profissional cria a conta sem escala; profissão não concede gestão.
// O gestor escolhe quem entra e o sistema envia um convite nominal de 24 h.

import { useState } from "react";
import { Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from "react-native";
import { Text, TextInput } from "@/components/ui/Text";
import { useRouter } from "expo-router";
import { CheckCircle2 } from "lucide-react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { Surface } from "@/components/ui/Surface";
import { AppButton } from "@/components/ui/AppButton";
import {
  ProfessionalQualificationPicker,
  qualificationPayload,
  type ProfessionalQualificationSelection,
} from "@/components/ProfessionalQualificationPicker";
import { theme } from "@/lib/theme";
import { authApi } from "@/lib/_core/api";

type Field = "name" | "email" | "password" | "confirm" | "customProfession";

export default function SignupScreen() {
  const [professionCode, setProfessionCode] = useState<ProfessionCode | null>(
    null,
  );
  const [customProfessionName, setCustomProfessionName] = useState("");
  const profession = professionCode
    ? getProfessionDefinition(professionCode)
    : null;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [qualification, setQualification] =
    useState<ProfessionalQualificationSelection | null>(null);
  const [focusedField, setFocusedField] = useState<Field | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<"awaiting" | "pending" | null>(null);

  const router = useRouter();

  const inputStyle = (field: Field) => ({
    minHeight: theme.space[10] + theme.space[1],
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: focusedField === field ? 2 : 1,
    borderColor:
      focusedField === field ? theme.colors.primary : theme.colors.borderStrong,
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
    if (!profession) {
      setErrorMsg("Selecione sua profissão.");
      return;
    }
    if (
      profession.customProfessionNameRequired &&
      (!customProfessionName.trim() ||
        Array.from(customProfessionName.trim()).length > 100)
    ) {
      setErrorMsg("Informe o nome da profissão com até 100 caracteres.");
      return;
    }
    if (profession.specialtyRequired && !qualification) {
      setErrorMsg(
        "Selecione sua especialidade ou o perfil operacional aceito.",
      );
      return;
    }
    setErrorMsg(null);
    setSubmitting(true);
    try {
      const result = await authApi.signup({
        name: name.trim(),
        email: email.trim(),
        password,
        professionCode: profession.code,
        ...(profession.customProfessionNameRequired
          ? { customProfessionName: customProfessionName.trim() }
          : {}),
        ...qualificationPayload(
          profession.specialtyRequired ? qualification : null,
        ),
      });
      if (result.ok) {
        setDone(result.pending ? "pending" : "awaiting");
      } else {
        setErrorMsg(result.error ?? "Erro ao criar cadastro.");
      }
    } catch {
      setErrorMsg(
        "Não foi possível criar a conta. Verifique sua conexão e tente novamente.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <ScreenGradient>
        <View
          style={{
            flex: 1,
            justifyContent: "center",
            paddingHorizontal: theme.space[4],
          }}
        >
          <Surface
            level="raised"
            style={{ padding: theme.space[7], gap: theme.space[4] }}
          >
            <View style={{ alignItems: "center", gap: theme.space[4] }}>
              <CheckCircle2 size={56} color={theme.colors.success} />
              <Text
                style={{
                  ...theme.text.title,
                  fontWeight: theme.weight.bold,
                  color: theme.colors.textPrimary,
                  textAlign: "center",
                }}
              >
                {done === "pending" ? "Cadastro enviado" : "Conta criada"}
              </Text>
              <Text
                style={{
                  ...theme.text.body,
                  color: theme.colors.textSecondary,
                  textAlign: "center",
                  lineHeight: 20,
                }}
              >
                {done === "pending"
                  ? "Sua conta foi criada e aguarda aprovação do gestor da instituição."
                  : "Entre com seu e-mail e senha para escolher como começar: gerenciar uma escala ou entrar com um convite."}
              </Text>
              <AppButton
                title="Voltar ao login"
                onPress={() => router.replace("/login")}
                size="lg"
                fullWidth
              />
            </View>
          </Surface>
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
            paddingHorizontal: theme.space[4],
            paddingVertical: theme.space[8],
          }}
          keyboardShouldPersistTaps="handled"
        >
          <View
            style={{
              width: "100%",
              maxWidth: theme.spacing.contentMaxWidth / 3,
              alignSelf: "center",
              gap: theme.space[8],
            }}
          >
            <View style={{ alignItems: "center", gap: theme.space[2] }}>
              <Image
                source={require("@/assets/images/logo.png")}
                style={{ width: 220, height: 132 }}
                resizeMode="contain"
                accessibilityLabel="Escala+"
              />
              <Text
                style={{
                  ...theme.text.title,
                  fontWeight: theme.weight.bold,
                  color: theme.colors.textPrimary,
                }}
              >
                Criar conta
              </Text>
              <Text
                style={{
                  ...theme.text.body,
                  color: theme.colors.textSecondary,
                  textAlign: "center",
                }}
              >
                Primeiro, conte quem você é. Depois de entrar, escolha como
                participar de uma escala.
              </Text>
            </View>

            <Surface level="raised" style={{ padding: theme.space[6] }}>
              <View style={{ gap: theme.space[5] }}>
                <View>
                  <Text style={labelStyle}>Nome completo</Text>
                  <TextInput
                    value={name}
                    onChangeText={setName}
                    autoComplete="name"
                    returnKeyType="next"
                    onFocus={() => setFocusedField("name")}
                    onBlur={() => setFocusedField(null)}
                    placeholder="Nome Sobrenome"
                    placeholderTextColor={theme.colors.textDisabled}
                    accessibilityLabel="Nome completo"
                    style={inputStyle("name")}
                  />
                </View>

                <View>
                  <Text style={labelStyle}>E-mail</Text>
                  <TextInput
                    value={email}
                    onChangeText={setEmail}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoComplete="email"
                    returnKeyType="next"
                    onFocus={() => setFocusedField("email")}
                    onBlur={() => setFocusedField(null)}
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
                    autoComplete="new-password"
                    returnKeyType="next"
                    onFocus={() => setFocusedField("password")}
                    onBlur={() => setFocusedField(null)}
                    placeholder="Mínimo 8 caracteres"
                    placeholderTextColor={theme.colors.textDisabled}
                    accessibilityLabel="Senha"
                    style={inputStyle("password")}
                  />
                </View>

                <View>
                  <Text style={labelStyle}>Confirmar senha</Text>
                  <TextInput
                    value={confirm}
                    onChangeText={setConfirm}
                    secureTextEntry
                    autoComplete="new-password"
                    returnKeyType="done"
                    onFocus={() => setFocusedField("confirm")}
                    onBlur={() => setFocusedField(null)}
                    onSubmitEditing={handleSignup}
                    placeholder="••••••••"
                    placeholderTextColor={theme.colors.textDisabled}
                    accessibilityLabel="Confirmar senha"
                    style={inputStyle("confirm")}
                  />
                </View>

                <ProfessionPicker
                  value={professionCode}
                  disabled={submitting}
                  onChange={(value) => {
                    setProfessionCode(value);
                    setQualification(null);
                    setCustomProfessionName("");
                    setErrorMsg(null);
                  }}
                />
                {profession?.customProfessionNameRequired ? (
                  <View>
                    <Text style={labelStyle}>Nome da profissão</Text>
                    <TextInput
                      value={customProfessionName}
                      onChangeText={setCustomProfessionName}
                      editable={!submitting}
                      accessibilityLabel="Nome da profissão"
                      placeholder="Informe sua profissão"
                      placeholderTextColor={theme.colors.textDisabled}
                      onFocus={() => setFocusedField("customProfession")}
                      onBlur={() => setFocusedField(null)}
                      style={inputStyle("customProfession")}
                    />
                  </View>
                ) : null}
                {profession?.specialtyRequired ? (
                  <ProfessionalQualificationPicker
                    value={qualification}
                    onChange={setQualification}
                    disabled={submitting}
                    required
                    tone="light"
                  />
                ) : null}

                {errorMsg ? (
                  <Surface level="card" tone="danger" padded="compact">
                    <Text
                      accessibilityLiveRegion="polite"
                      style={{
                        ...theme.text.body,
                        color: theme.palette.danger[900],
                        textAlign: "center",
                      }}
                    >
                      {errorMsg}
                    </Text>
                  </Surface>
                ) : null}

                <AppButton
                  title={submitting ? "Criando conta…" : "Criar conta"}
                  onPress={handleSignup}
                  disabled={submitting}
                  size="lg"
                  fullWidth
                />

                <Pressable
                  onPress={() => router.replace("/login")}
                  accessibilityRole="link"
                  accessibilityLabel="Já tenho conta — entrar"
                  hitSlop={8}
                  style={{
                    alignSelf: "center",
                    minHeight: theme.space[10],
                    justifyContent: "center",
                  }}
                >
                  <Text
                    style={{
                      ...theme.text.body,
                      color: theme.colors.textSecondary,
                    }}
                  >
                    Já tenho conta?{" "}
                    <Text
                      style={{
                        fontWeight: theme.weight.semibold,
                        color: theme.colors.primary,
                      }}
                    >
                      Entrar
                    </Text>
                  </Text>
                </Pressable>
              </View>
            </Surface>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </ScreenGradient>
  );
}
