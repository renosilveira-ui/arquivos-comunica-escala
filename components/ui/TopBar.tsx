import { View, Text, TouchableOpacity } from "react-native";
import { Menu, User } from "lucide-react-native";
import { useRouter } from "expo-router";
import { theme } from "@/lib/theme";

interface TopBarProps {
  onMenuToggle: () => void;
  title?: string;
}

/**
 * TopBar — header dark mobile/tablet com hambúrguer e atalho pro perfil.
 * Cor de fundo segue `theme.colors.sidebarBg` (mesma identidade da
 * sidebar desktop). O gradiente original azul-noite foi substituído
 * por sólido — diferença visual mínima e consistência cross-component.
 */
export function TopBar({ onMenuToggle, title }: TopBarProps) {
  const router = useRouter();

  return (
    <View
      className="h-16 flex-row items-center px-4"
      style={{
        backgroundColor: theme.colors.sidebarBg,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.onDark.divider,
      }}
    >
      {/* Hambúrguer (mobile/tablet) */}
      <TouchableOpacity
        onPress={onMenuToggle}
        className="mr-4 active:opacity-70 md:hidden"
      >
        <Menu size={24} color={theme.colors.onDark.text} />
      </TouchableOpacity>

      {/* Título */}
      {title && (
        <Text
          className="font-bold text-lg flex-1"
          style={{ color: theme.colors.onDark.text }}
        >
          {title}
        </Text>
      )}

      {/* Perfil */}
      <TouchableOpacity
        onPress={() => router.push("/profile")}
        className="ml-auto active:opacity-70"
      >
        <View
          className="rounded-full p-2"
          style={{ backgroundColor: theme.colors.onDark.surface }}
        >
          <User size={20} color={theme.colors.onDark.text} />
        </View>
      </TouchableOpacity>
    </View>
  );
}
