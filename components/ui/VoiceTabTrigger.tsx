// Microfone navy sobreposto no centro da barra. Não é aba — é comando.
// Sem rótulo visível: a barra já tem 4 destinos; o nome vai no leitor de tela.

import { Pressable } from "react-native";
import { Mic } from "lucide-react-native";
import { theme } from "@/lib/theme";

const TAB_TRIGGER_SIZE = theme.space[10] + theme.space[1];

export function VoiceTabTrigger({
  onPress,
  listening = false,
}: {
  onPress: () => void;
  listening?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Comando de voz"
      accessibilityState={{ busy: listening }}
      style={({ pressed }) => ({
        width: TAB_TRIGGER_SIZE,
        height: TAB_TRIGGER_SIZE,
        borderRadius: theme.radius.full,
        backgroundColor: listening ? theme.colors.danger : theme.colors.brand,
        borderWidth: theme.space[1],
        borderColor: theme.colors.surface,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.9 : 1,
        ...theme.shadow.lg,
      })}
    >
      <Mic size={20} color={theme.colors.onDark.text} />
    </Pressable>
  );
}
