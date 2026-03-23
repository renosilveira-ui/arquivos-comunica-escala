import { useMemo, type ComponentType } from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { CalendarDays, Clock3, ClipboardList, User, Briefcase, Home } from "lucide-react-native";
import { usePermissions } from "@/hooks/use-permissions";
import { theme } from "@/lib/theme";

interface SidebarProps {
  collapsed?: boolean;
  onToggle?: () => void;
  counts?: {
    totalVacancies?: number;
  } | null;
}

type NavItem = {
  key: string;
  label: string;
  href: string;
  icon: ComponentType<{ size?: number; color?: string }>;
  hidden?: boolean;
};

export function Sidebar({ collapsed = false, counts }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { isManager } = usePermissions();

  const items = useMemo<NavItem[]>(
    () => [
      { key: "home", label: "Início", href: "/", icon: Home },
      { key: "agenda", label: "Agenda", href: "/calendar", icon: CalendarDays },
      { key: "weekly", label: "Semanal", href: "/weekly", icon: Clock3 },
      { key: "pending", label: "Pendentes", href: "/pending", icon: ClipboardList, hidden: !isManager },
      { key: "vacancies", label: "Vagas", href: "/vacancies", icon: Briefcase },
      { key: "profile", label: "Perfil", href: "/profile", icon: User },
    ],
    [isManager],
  );

  const visibleItems = items.filter((item) => !item.hidden);

  return (
    <View
      style={{
        width: collapsed ? 88 : 260,
        backgroundColor: theme.colors.card,
        borderRightWidth: 1,
        borderColor: theme.colors.border,
        paddingTop: 20,
        paddingHorizontal: 12,
      }}
    >
      <Text
        style={{
          color: theme.colors.primaryNavy,
          fontWeight: "800",
          fontSize: 20,
          marginBottom: 18,
          paddingHorizontal: 10,
        }}
      >
        {collapsed ? "EH" : "Escalas"}
      </Text>

      <View style={{ gap: 8 }}>
        {visibleItems.map((item) => {
          const active = pathname === item.href;
          const Icon = item.icon;
          return (
            <TouchableOpacity
              key={item.key}
              onPress={() => router.push(item.href as never)}
              activeOpacity={0.86}
              style={{
                height: 44,
                borderRadius: 10,
                paddingHorizontal: 12,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: collapsed ? "center" : "flex-start",
                backgroundColor: active ? theme.colors.accent : theme.colors.primaryNavy,
              }}
            >
              <Icon size={18} color="#FFFFFF" />
              {!collapsed && (
                <Text style={{ color: "#FFFFFF", fontWeight: "600", marginLeft: 10 }}>
                  {item.label}
                </Text>
              )}
            </TouchableOpacity>
          );
        })}
      </View>

      {!collapsed && (
        <View
          style={{
            marginTop: 20,
            borderRadius: 12,
            backgroundColor: "rgba(11,31,58,0.06)",
            borderWidth: 1,
            borderColor: theme.colors.border,
            padding: 12,
          }}
        >
          <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>Vagas em aberto</Text>
          <Text style={{ color: theme.colors.primaryNavy, fontSize: 20, fontWeight: "700" }}>
            {counts?.totalVacancies ?? 0}
          </Text>
        </View>
      )}
    </View>
  );
}
