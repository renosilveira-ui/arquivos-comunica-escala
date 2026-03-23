import { View, Text, TouchableOpacity } from "react-native";
import { Menu, User } from "lucide-react-native";
import { useRouter } from "expo-router";
import { theme } from "@/lib/theme";

interface TopBarProps {
  onMenuToggle: () => void;
  title?: string;
}

export function TopBar({ onMenuToggle, title }: TopBarProps) {
  const router = useRouter();

  return (
    <View
      className="h-16 border-b flex-row items-center px-4"
      style={{ backgroundColor: theme.colors.card, borderColor: theme.colors.border }}
    >
      {/* Hambúrguer (mobile/tablet) */}
      <TouchableOpacity
        onPress={onMenuToggle}
        className="mr-4 active:opacity-70 md:hidden"
      >
        <Menu size={24} color={theme.colors.primaryNavy} />
      </TouchableOpacity>

      {/* Título */}
      {title && (
        <Text className="font-bold text-lg flex-1" style={{ color: theme.colors.textPrimary }}>
          {title}
        </Text>
      )}

      {/* Perfil */}
      <TouchableOpacity
        onPress={() => router.push("/profile")}
        className="ml-auto active:opacity-70"
      >
        <View className="rounded-full p-2" style={{ backgroundColor: "rgba(11,31,58,0.08)" }}>
          <User size={20} color={theme.colors.primaryNavy} />
        </View>
      </TouchableOpacity>
    </View>
  );
}
