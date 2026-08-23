// components/BootScreen.tsx — tela de abertura enquanto o app ainda não
// sabe quem é o usuário / qual instituição mostrar.
//
// Antes era um spinner sobre fundo quase preto (neutral[900]), sem texto:
// com o staging dormindo (Render free, 30–60 s para acordar) o médico via
// uma tela preta por um minuto e achava que o app tinha travado. Agora:
// fundo do app, wordmark, spinner e — só depois de alguns segundos — um
// aviso honesto de que o servidor está acordando.

import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Text, View } from "react-native";
import { theme } from "@/lib/theme";

const HINT_AFTER_MS = 2500;

export function BootScreen({
  hint = "Conectando ao servidor…",
  detail = "O primeiro acesso pode levar até um minuto.",
}: {
  hint?: string;
  detail?: string;
}) {
  const [showHint, setShowHint] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setShowHint(true), HINT_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel="Abrindo o Escala+"
      style={{
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: theme.colors.background,
        padding: theme.space[6],
        gap: theme.space[4],
      }}
    >
      <Image
        source={require("@/assets/images/logo.png")}
        resizeMode="contain"
        accessibilityIgnoresInvertColors
        style={{ width: 160, height: 96 }}
      />
      <ActivityIndicator size="large" color={theme.colors.primary} />
      {/* Reserva a altura para o texto não "pular" o layout ao aparecer. */}
      <View style={{ minHeight: 44, alignItems: "center", gap: theme.space[1] }}>
        {showHint ? (
          <>
            <Text style={{ ...theme.text.body, fontWeight: theme.weight.semibold, color: theme.colors.textPrimary, textAlign: "center" }}>
              {hint}
            </Text>
            <Text style={{ ...theme.text.caption, color: theme.colors.textSecondary, textAlign: "center" }}>
              {detail}
            </Text>
          </>
        ) : null}
      </View>
    </View>
  );
}
