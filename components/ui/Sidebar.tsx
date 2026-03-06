import { View, Text } from "react-native";

interface SidebarProps {
  collapsed?: boolean;
  onToggle?: () => void;
  counts?: Record<string, number>;
}

/**
 * Sidebar web — stub (arquivo original truncado no export do Manus).
 * Restaurar quando o layout web for implementado.
 */
export function Sidebar({ collapsed }: SidebarProps) {
  if (collapsed) return null;
  return (
    <View>
      <Text>Sidebar placeholder</Text>
    </View>
  );
}
