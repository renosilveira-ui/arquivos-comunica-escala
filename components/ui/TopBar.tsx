import { View, Text, TouchableOpacity } from "react-native";
import { Menu, User } from "lucide-react-native";
import { useRouter } from "expo-router";

interface TopBarProps {
  onMenuToggle: () => void;
  title?: string;
}

export function TopBar({ onMenuToggle, title }: TopBarProps) {
  const router = useRouter();

  return (
    <View className="h-16 bg-gradient-to-r from-[#0A1220] to-[#1A2332] border-b border-white/10 flex-row items-center px-4">
      {/* Hambúrguer (mobile/tablet) */}
      <TouchableOpacity
        onPress={onMenuToggle}
        className="mr-4 active:opacity-70 md:hidden"
      >
        <Menu size={24} color="#fff" />
      </TouchableOpacity>

      {/* Título */}
      {title && (
        <Text className="text-white font-bold text-lg flex-1">{title}</Text>
      )}

      {/* Perfil */}
      <TouchableOpacity
        onPress={() => router.push("/profile")}
        className="ml-auto active:opacity-70"
      >
        <View className="bg-white/10 rounded-full p-2">
          <User size={20} color="#FFFFFF" />
        </View>
      </TouchableOpacity>
    </View>
  );
}
